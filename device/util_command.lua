local util_command = {}
local util_sms = require "util_sms"

util_command.WAKE = "DEVICE_COMMAND_RESULTS_QUEUED"
local SLOT_COUNT = 16
local DEFAULT_RETENTION = 60 * 60

-- 与 server 一致：UTF-8 原字节的 lowercase hex SHA256(to .. '\n' .. content)。
-- 不使用 server/security.js 的 base64url digest，不做 Unicode/号码规范化。
local function sha256(value)
    local hash = crypto and crypto.sha256 and crypto.sha256(value)
    if type(hash) == "string" and #hash == 64 and hash:match("^[A-Fa-f0-9]+$") then
        return hash:lower()
    end
end

local function validId(id)
    return type(id) == "string" and #id <= 80 and id:match("^[A-Za-z0-9][A-Za-z0-9_.%-]*$") ~= nil
end

local function unix(value)
    return type(value) == "number" and value % 1 == 0 and value >= 1714500000 and value < 4102444800.0
end

function util_command.clock()
    local now = os.time()
    if unix(now) then return now end
end

local Journal = {}
Journal.__index = Journal

function Journal:current()
    return self.client.is_current() and self.client.device_id ~= nil
end

function Journal:owned(record)
    return type(record) == "table" and record.state ~= "empty" and record.scope == self.client.scope
        and record.device_id == self.client.device_id
end

function Journal:status()
    return { usable_slots = SLOT_COUNT, quarantined_slots = 0 }
end

function Journal:revoke()
    self.session_id, self.available = nil, false
end

function Journal:authorize(session_id)
    self:revoke()
    if type(session_id) ~= "string" or #session_id ~= 43 or not session_id:match("^[A-Za-z0-9_%-]+$") then
        return false
    end
    self.session_id = session_id
    self.available = self:current()
    return self.available
end

function Journal:finish(record, status, error_tag)
    if record.state ~= "intent" then return end
    record.state, record.status, record.error, record.pending = "final", status, error_tag, true
    sys.publish(util_command.WAKE)
end

function Journal:prune()
    local now = util_command.clock()
    if not now then return end -- 无时钟时绝不提前忘记本次开机的去重记录。
    for _, record in ipairs(self.records) do
        if record.state == "final" and not record.pending and now >= record.keep_until then
            for name in pairs(record) do record[name] = nil end
            record.state = "empty"
        end
    end
end

local function rejection(id, error_tag)
    if validId(id) then
        return { type = "command_result", command_id = id, status = "failed", error = error_tag }
    end
end

function Journal:receive(command)
    if not self:current() then return end
    if type(command) ~= "table" or not validId(command.id) then return end
    -- 旧连接的命令不执行，也不伪造失败结果覆盖其 unknown 状态。
    if not self.session_id or command.session_id ~= self.session_id then return end
    if command.device_id ~= self.client.device_id then return rejection(command.id, "wrong_device") end
    if command.op ~= "sms.send" then return rejection(command.id, "unsupported_op") end
    if type(command.digest) ~= "string" or #command.digest ~= 64 or not command.digest:match("^[a-f0-9]+$") then
        return rejection(command.id, "invalid_digest")
    end
    local valid, error_tag = util_sms.validate(command.to, command.content)
    if not valid then return rejection(command.id, error_tag) end
    if sha256(command.to .. "\n" .. command.content) ~= command.digest then
        return rejection(command.id, "digest_mismatch")
    end

    for _, record in ipairs(self.records) do
        if self:owned(record) and record.id == command.id then
            if record.digest ~= command.digest then return rejection(command.id, "digest_conflict") end
            -- 未回执和已回执的 ID 均保留至到期+保留期；同次开机只补结果，从不重发短信。
            if record.state == "final" then
                record.pending = true
                sys.publish(util_command.WAKE)
            end
            return
        end
    end
    if not unix(command.expires_at) then return rejection(command.id, "invalid_expiry") end
    if not self.available then return rejection(command.id, "journal_unavailable") end
    self:prune()
    local slot
    for _, record in ipairs(self.records) do
        if record.state == "empty" then slot = record; break end
    end
    if not slot then return rejection(command.id, "journal_full") end

    local retention = tonumber(config.COMMAND_DEDUP_SECONDS) or DEFAULT_RETENTION
    if retention ~= retention then retention = DEFAULT_RETENTION end
    retention = math.floor(math.max(60 * 60, math.min(retention, 30 * 24 * 60 * 60)))
    slot.state, slot.id, slot.digest = "intent", command.id, command.digest
    slot.scope, slot.device_id = self.client.scope, self.client.device_id
    slot.expires_at = command.expires_at
    slot.keep_until = math.min(command.expires_at + retention, 4102444799.0)
    -- 仅 16 个 RAM 槽保存 ID/摘要/归属/intent/final；重启丢弃，不承诺跨重启去重。
    -- 号码、正文只交给已有的有界串行短信执行器，不复制到日志槽中。
    local admitted_session = self.session_id
    local id, digest, expires_at, keep_until = slot.id, slot.digest, slot.expires_at, slot.keep_until
    local scope, device_id = slot.scope, slot.device_id
    local function ownsIntent()
        return self:owned(slot) and slot.state == "intent" and slot.id == id and slot.digest == digest
            and slot.scope == scope and slot.device_id == device_id
            and slot.expires_at == expires_at and slot.keep_until == keep_until
    end
    local function before()
        if self.session_id ~= admitted_session or not self.available then return false, "session_changed" end
        if not self:current() or not self:owned(slot) then return false, "scope_changed" end
        if not ownsIntent() then return false, "intent_changed" end
        local now = util_command.clock()
        if not now then
            if not socket.adapter(socket.LWIP_GP) or not socket.sntp then return false, "clock_unavailable" end
            pcall(socket.sntp)
            if not util_command.clock() then sys.waitUntil("NTP_UPDATE", 15000) end
            now = util_command.clock()
        end
        if not now then return false, "clock_unavailable" end
        -- NTP 可能让出协程；必须再次校验捕获的会话、归属和原 intent。
        if self.session_id ~= admitted_session or not self.available then return false, "session_changed" end
        if not self:current() or not self:owned(slot) then return false, "scope_changed" end
        if not ownsIntent() then return false, "intent_changed" end
        local server_now = self.client.server_now and self.client.server_now()
        if type(server_now) == "number" then now = math.max(now, server_now) end
        if now >= expires_at then return false, "expired" end
        return true
    end
    local queued, err = util_sms.enqueue(command.to, command.content, before, function(status, tag)
        self:finish(slot, status, tag)
    end)
    if not queued then self:finish(slot, "failed", err) end
end

function Journal:nextResult()
    if not self:current() then return end
    self:prune()
    for _, record in ipairs(self.records) do
        if self:owned(record) and record.state == "final" and record.pending then
            return record, { type = "command_result", command_id = record.id,
                status = record.status, error = record.error }
        end
    end
end

function Journal:hasPending()
    for _, record in ipairs(self.records) do
        if self:owned(record) and record.state == "final" and record.pending then return true end
    end
    return false
end

function Journal:ack(record, command_id)
    if not self:current() or not self:owned(record) or record.id ~= command_id
        or record.state ~= "final" or not record.pending then return false end
    record.pending = false -- 只清 pending，保留 ID/摘要/结果到 keep_until，防止 ACK 后再次执行。
    sys.publish(util_command.WAKE)
    return true
end

function util_command.new(client)
    local journal = setmetatable({ client = client, records = {}, available = false }, Journal)
    for index = 1, SLOT_COUNT do journal.records[index] = { state = "empty" } end
    log.info("util_command", "RAM 命令日志待服务会话核对，重启丢弃", "slots", SLOT_COUNT, "quarantined", 0)
    util_sms.init()
    return journal
end

return util_command
