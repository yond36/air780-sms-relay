local util_transport = {}
local util_ws = require "util_ws"
local util_command = require "util_command"

util_transport.WAKE, util_transport.CLIENT_READY = "DEVICE_TRANSPORT_WAKE", "DEVICE_CLIENT_READY"
util_transport.READY = "DEVICE_WS_READY"
local EVENT_ACK, ACK_MS = "DEVICE_WS_EVENT_ACK", 20000
local BACKOFF_MIN, BACKOFF_MAX = 5000, 300000
local Transport = {}
Transport.__index = Transport

local function encode(value)
    local ok, body = pcall(json.encode, value)
    if ok and type(body) == "string" then return body end
end

local function decode(body)
    local ok, value = pcall(json.decode, body)
    if ok and type(value) == "table" then return value end
end

local function validSession(value)
    return type(value) == "string" and #value == 43 and value:match("^[A-Za-z0-9_%-]+$") ~= nil
end

local function jitter(delay)
    local bytes = crypto and crypto.trng and crypto.trng(2)
    local fraction = type(bytes) == "string" and #bytes == 2 and (bytes:byte(1) * 256 + bytes:byte(2)) / 65535
        or (mcu.ticks() % 1000) / 1000
    return math.ceil(delay * (0.8 + 0.2 * fraction))
end

function Transport:disconnect()
    self.ready, self.session_id = false, nil
    self.commands:revoke()
    if self.ws then self.ws:close(); self.ws = nil end
    if self.event then self.event.failed = true; sys.publish(EVENT_ACK) end
    self.ws_result, self.ping_deadline = nil, nil
    sys.publish(util_command.WAKE)
    sys.publish(util_transport.READY, false)
end

function Transport:sendEvent(body, event_id)
    if not self.ready or not self.client.is_current() or self.event or type(body) ~= "string" or #body > 4095 then return false end
    local event = decode(body)
    if not event or event.event_id ~= event_id or event.device_id ~= self.client.device_id then return false end
    event._server_scope = nil -- 归属仅在本次开机 RAM 中，不进入事件正文。
    local wire = encode({ type = "event", event = event, recovered = false })
    if not wire then return false end
    local item = { id = event_id, wire = wire }
    self.event = item
    sys.publish(util_transport.WAKE)
    local deadline = util_ws.now() + ACK_MS
    while self.ready and self.client.is_current() and not item.failed and not item.acked do
        local remaining = deadline - util_ws.now()
        if remaining <= 0 then break end
        sys.waitUntil(EVENT_ACK, math.ceil(remaining))
    end
    if self.event == item then self.event = nil end
    return item.acked == true, item.rejected
end

function Transport:nextResult()
    local record, body = self.commands:nextResult()
    if record then return { record = record, body = body, id = record.id } end
    local transient = self.transients[1]
    if transient then return { body = transient, id = transient.command_id, transient = true } end
end

function Transport:ackResult(item, id)
    if item.id ~= id or not self.client.is_current() then return false end
    if item.transient then
        if self.transients[1] == item.body then table.remove(self.transients, 1) end
        return true
    end
    return self.commands:ack(item.record, id)
end

function Transport:message(frame)
    if frame.opcode == 8 then
        self.ws:send(frame.data, 8)
        return false, "server_close"
    elseif frame.opcode == 9 then
        return self.ws:send(frame.data, 10), "pong_tx"
    elseif frame.opcode == 10 then
        return true
    end
    local body = frame.data
    if body == "q" then self.ping_deadline = nil; return true end
    if body == "p" then return self.ws:send("q"), "heartbeat_tx" end
    local message = decode(body)
    if not message then return false, "bad_message" end
    if message.type == "hello" then
        if self.ready or message.protocol_version ~= 2 or message.reconciled ~= true
            or message.device_id ~= self.client.device_id or not validSession(message.session_id)
            or type(message.heartbeat_seconds) ~= "number" or message.heartbeat_seconds % 1 ~= 0
            or message.heartbeat_seconds < 60 or message.heartbeat_seconds > 300
            or type(message.server_time) ~= "number" or message.server_time % 1 ~= 0
            or message.server_time < 1714500000 or message.server_time >= 4102444800.0 then
            return false, "bad_hello"
        end
        -- 服务器已持久切断旧会话下发权，才允许 RAM 槽接受本会话的新命令。
        self.session_id = message.session_id
        self.commands:authorize(message.session_id)
        local capabilities = self.commands.available and { "event.report", "sms.send" } or { "event.report" }
        local journal = self.commands:status()
        local heartbeat = tonumber(config.WSS_HEARTBEAT_SECONDS) or message.heartbeat_seconds
        self.heartbeat_ms = math.floor(math.max(60, math.min(heartbeat, 300))) * 1000
        self.server_epoch, self.server_tick = message.server_time, util_ws.now()
        local wire = encode({ type = "ready", session_id = message.session_id,
            capabilities = capabilities, journal = journal, heartbeat_seconds = self.heartbeat_ms // 1000 })
        if not wire or not self.ws:send(wire) then return false, "ready_tx" end
        self.ready, self.was_ready = true, true
        self.next_ping = util_ws.now() + self.heartbeat_ms
        log.info("util_transport", "WSS 已就绪", "sms_ready", self.commands.available,
            "usable_slots", journal.usable_slots, "quarantined_slots", journal.quarantined_slots)
        sys.publish(util_transport.CLIENT_READY)
        sys.publish(util_transport.READY, true)
        sys.publish(util_command.WAKE)
        return true
    end
    if not self.ready then return false, "before_hello" end
    if message.type == "command" then
        if type(message.command) ~= "table" or message.command.session_id ~= self.session_id then return true end
        local rejected = self.commands:receive(message.command)
        if rejected and #self.transients < 8 then
            self.transients[#self.transients + 1] = rejected
            sys.publish(util_command.WAKE)
        end
    elseif message.type == "event_ack" then
        local item = self.event
        if item and item.sent and message.ok == true and message.accepted == true and message.event_id == item.id then
            item.acked = true
            sys.publish(EVENT_ACK)
        end
    elseif message.type == "command_result_ack" then
        local item = self.ws_result
        if item and item.sent and message.ok == true and message.accepted == true and message.command_id == item.id then
            self:ackResult(item, message.command_id)
            self.ws_result = nil
            sys.publish(util_command.WAKE)
        end
    elseif message.type == "error" then
        local item = self.event
        local code = tonumber(message.code)
        if item and item.sent and message.event_id == item.id
            and (code == 400 or code == 413 or code == 415 or code == 422) then
            item.failed, item.rejected = true, code
            sys.publish(EVENT_ACK)
        end
    end
    return true
end

function Transport:session()
    local hello_deadline = util_ws.now() + 15000
    while self.client.is_current() and socket.adapter(socket.LWIP_GP) do
        for _ = 1, 8 do
            local chunk = self.ws.initial
            self.ws.initial = nil
            if not chunk or chunk == "" then chunk = self.ws:read() end
            if not chunk then return false, "socket_rx" end
            if chunk == "" then break end
            local frames, error_tag = self.ws.decoder:feed(chunk)
            if not frames then return false, error_tag end
            for _, frame in ipairs(frames) do
                local ok, err = self:message(frame)
                if not ok then return false, err end
            end
        end
        local now = util_ws.now()
        local deadline = hello_deadline
        if self.ready then
            local event = self.event
            if event and not event.sent and not event.failed then
                if not self.ws:send(event.wire) then return false, "event_tx" end
                event.sent, event.deadline = true, util_ws.now() + ACK_MS
            end
            if not self.ws_result then
                self.ws_result = self:nextResult()
                if self.ws_result then
                    local wire = encode(self.ws_result.body)
                    if not wire or not self.ws:send(wire) then return false, "result_tx" end
                    self.ws_result.sent, self.ws_result.deadline = true, util_ws.now() + ACK_MS
                end
            end
            now = util_ws.now()
            if now >= self.next_ping and not self.ping_deadline then
                if not self.ws:send("p") then return false, "heartbeat_tx" end
                self.next_ping, self.ping_deadline = util_ws.now() + self.heartbeat_ms, util_ws.now() + ACK_MS
            end
            deadline = self.ping_deadline or self.next_ping
            if event and event.sent and not event.acked and not event.failed then deadline = math.min(deadline, event.deadline) end
            if self.ws_result then deadline = math.min(deadline, self.ws_result.deadline) end
        end
        local remaining = deadline - util_ws.now()
        if remaining <= 0 then return false, self.ready and "ack_timeout" or "hello_timeout" end
        if not self.ws:wait(math.ceil(remaining)) then return false, "socket_closed" end
    end
    return false, "scope_or_network_changed"
end

local function connectionLoop(self)
    local delay = 0
    while true do
        if not self.client.is_current() then
            self:disconnect()
            sys.waitUntil(util_transport.WAKE, 60000)
        elseif not socket.adapter(socket.LWIP_GP) then
            self:disconnect()
            sys.waitUntil("IP_READY", 60000)
        else
            local prepared, preparation_error = true, nil
            if self.client.prepare then
                local ok, result, err = pcall(self.client.prepare)
                prepared, preparation_error = ok and result == true, ok and err or "prepare_exception"
            end
            if not prepared then
                delay = delay == 0 and BACKOFF_MIN or math.min(delay * 2, BACKOFF_MAX)
                log.warn("util_transport", "稍后准备 WSS 登记", preparation_error, delay)
                sys.wait(delay)
            else
                if not util_command.clock() and socket.sntp then
                    pcall(socket.sntp)
                    if not util_command.clock() then sys.waitUntil("NTP_UPDATE", 15000) end
                end
                local ok, ws, error_tag = true, nil, "clock_unavailable"
                if util_command.clock() then ok, ws, error_tag = pcall(util_ws.open, self.client, util_transport.WAKE) end
                self.was_ready = false
                if ok and ws then
                    self.ws = ws
                    local session_ok, _, err = pcall(self.session, self)
                    error_tag = session_ok and err or "ws_exception"
                elseif not ok then
                    error_tag = "ws_exception"
                end
                self:disconnect()
                if self.was_ready then delay = 0 end
                delay = delay == 0 and BACKOFF_MIN or math.min(delay * 2, BACKOFF_MAX)
                local wait_ms = jitter(delay)
                log.warn("util_transport", "WSS 稍后重连", error_tag, wait_ms)
                sys.wait(wait_ms)
            end
        end
    end
end

-- 只唤醒 WSS 收发任务。离线结果仅保留在 RAM，重启丢弃，不经 HTTP 补报。
local function resultLoop(self)
    while true do
        local item = self:nextResult()
        if self.ready then
            if item then sys.publish(util_transport.WAKE) end
            sys.waitUntil(util_command.WAKE, self.commands:hasPending() and BACKOFF_MIN or nil)
        else
            sys.waitUntil(util_transport.READY, self.commands:hasPending() and BACKOFF_MIN or nil)
        end
    end
end

function util_transport.start(client)
    local transport = setmetatable({ client = client, transients = {}, ready = false }, Transport)
    client.server_now = function()
        if client.is_current() and transport.server_epoch then
            return transport.server_epoch + math.floor((util_ws.now() - transport.server_tick) / 1000)
        end
    end
    transport.commands = util_command.new(client)
    sys.taskInit(connectionLoop, transport)
    sys.taskInit(resultLoop, transport)
    return transport
end

return util_transport
