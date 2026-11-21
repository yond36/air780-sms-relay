local util_notify = {}
-- 每设备静态模块由离线部署工具提供；应用不生成、修改或恢复凭据。
local auth = require "device_auth"

local WAKE, WS_READY = "DEVICE_EVENTS_QUEUED", "DEVICE_WS_READY"
local IMPORTANT_PREFIX, NORMAL_PREFIX = "ev1h-", "ev1l-"
local MAX_RECORDS, PRIORITY_RESERVE, MAX_BODY_BYTES = 32, 24, 4095
local MAX_SEQUENCE, AUTO_ID_BYTES, TOKEN_BYTES, SCOPE_BYTES = 2147483647, 48, 43, 40
local BINDING_BYTES = AUTO_ID_BYTES + 2 - #"false"
local BACKOFF_MIN, BACKOFF_MAX = 5000, 300000
local KINDS = {
    ["sms.received"] = true,
    ["call.incoming"] = true,
    ["call.disconnected"] = true,
    ["device.boot"] = false,
    ["device.heartbeat"] = false,
    ["device.test"] = false,
    ["device.location"] = false,
    ["device.traffic"] = false,
    ["uart.received"] = false,
}

-- 正文、归属和回执均只在本次开机的有界 RAM 队列中；重启全部丢弃。
local pending = {}
local sequence = 0
local ready, boot_nonce, destination

local function validToken(value)
    return type(value) == "string" and #value == TOKEN_BYTES and value:match("^[A-Za-z0-9_%-]+$") ~= nil
end

local function sha256(value)
    local digest = crypto and crypto.sha256 and crypto.sha256(value)
    if type(digest) == "string" and #digest == 64 and digest:match("^[A-Fa-f0-9]+$") then
        return digest:lower()
    end
end

local function encodeJson(value)
    local ok, body = pcall(json.encode, value)
    if ok and type(body) == "string" and body ~= "" then return body end
end

local function getBootNonce()
    if boot_nonce then return boot_nonce end
    if not crypto or type(crypto.trng) ~= "function" then return end
    local ok, random = pcall(crypto.trng, 12)
    if ok and type(random) == "string" and #random == 12 then
        boot_nonce = (random:gsub(".", function(byte) return string.format("%02x", byte:byte()) end))
    end
    return boot_nonce -- 无 TRNG 时拒绝入队，不使用时钟或持久计数器代替。
end

function util_notify.status()
    return { queued = #pending, capacity = MAX_RECORDS, priority_reserve = PRIORITY_RESERVE,
        max_body_bytes = MAX_BODY_BYTES }
end

function util_notify.add(kind, data, status, occurred_at)
    local important = KINDS[kind]
    if important == nil or type(data) ~= "table" or (status ~= nil and type(status) ~= "table")
        or (occurred_at ~= nil and (type(occurred_at) ~= "number" or occurred_at % 1 ~= 0)) then return false end
    if not ready then
        log.warn("util_notify", "事件未入队，RAM 队列未初始化", kind)
        return false
    end
    local limit = important and MAX_RECORDS or MAX_RECORDS - PRIORITY_RESERVE
    if #pending >= limit or sequence >= MAX_SEQUENCE then
        log.warn("util_notify", "事件未入队，RAM 队列或本次开机 ID 已满", kind)
        return false
    end
    local nonce = getBootNonce()
    if not nonce then
        log.error("util_notify", "事件未入队，TRNG 不可用", kind)
        return false
    end
    local prefix = important and IMPORTANT_PREFIX or NORMAL_PREFIX
    local id = prefix .. string.format("%010d", sequence + 1) .. "-" .. nonce
    local body = encodeJson({ version = 1, device_id = false, event_id = id, type = kind,
        occurred_at = occurred_at, data = data, status = status })
    -- 为固定长度 autoID 预留空间；上限针对绑定后的完整事件 JSON 正文。
    if not body or #body + BINDING_BYTES > MAX_BODY_BYTES then
        log.warn("util_notify", "事件未入队，编码失败或正文超长", kind)
        return false
    end
    sequence = sequence + 1
    pending[#pending + 1] = { id = id, important = important, body = body, device_id = false }
    sys.publish(WAKE)
    return true
end

local function normalizeIdentity(kind, value)
    if type(value) ~= "string" then return end
    value = value:match("^%s*(.-)%s*$")
    if kind == "imei" then
        if #value == 15 and value ~= "000000000000000" and value:match("^[0-9]+$") then return value end
    elseif kind == "sn" then
        value = value:upper()
        if #value >= 3 and #value <= 64 and value:match("^[A-Z0-9][A-Z0-9_.%-]+$") then return value end
    end
end

local function automaticId(kind, value)
    local hex = sha256(kind .. ":" .. value)
    if not hex or not crypto.base64_encode then return end
    local raw = hex:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end)
    local token = crypto.base64_encode(raw)
    if type(token) ~= "string" then return end
    token = token:gsub("%+", "-"):gsub("/", "_"):gsub("=+$", "")
    if validToken(token) then return "auto~" .. token end
end

local function eventBody(item, client)
    if not client.is_current() then return end
    if item.device_id == false then
        local ok, event = pcall(json.decode, item.body)
        if not ok or type(event) ~= "table" then return end
        event.device_id = client.device_id
        local body = encodeJson(event)
        if not body or #body > MAX_BODY_BYTES then return end
        item.body, item.device_id, item.scope = body, client.device_id, client.scope
    end
    if item.device_id == client.device_id and item.scope == client.scope then return item.body end
end

local function deliver(item, client)
    local body = eventBody(item, client)
    if not body then return false, "事件归属或编码不可用" end
    if not client.transport then return false, "WSS 未就绪" end
    local accepted, rejected = client.transport:sendEvent(body, item.id)
    if accepted then return true end -- 匹配回执直接释放 RAM，不存在持久删除或清理重试。
    if rejected then
        log.warn("util_notify", "服务拒绝事件，丢弃 RAM 记录", rejected)
        return true
    end
    return false, "WSS 回执未确认"
end

local function nextIndex(client)
    local first
    for index, item in ipairs(pending) do
        if item.device_id == false or (item.device_id == client.device_id and item.scope == client.scope) then
            if item.important then return index end
            first = first or index
        end
    end
    return first
end

local function sendLoop(client)
    local delay = 0
    while true do
        local index = client.device_id and nextIndex(client)
        if not client.is_current() then
            sys.waitUntil(WAKE, 60000)
        elseif not client.transport or not client.transport.ready then
            sys.waitUntil(WS_READY)
        elseif not index then
            sys.waitUntil(WAKE)
        else
            local item = pending[index]
            local done, code = deliver(item, client)
            table.remove(pending, index)
            if done then
                delay = 0
            else
                pending[#pending + 1] = item
                delay = delay == 0 and BACKOFF_MIN or math.min(delay * 2, BACKOFF_MAX)
                log.warn("util_notify", "本次开机稍后重试 RAM 事件", code, delay)
                sys.waitUntil(WS_READY, delay)
            end
        end
    end
end

local function serverBase(url)
    if type(url) ~= "string" or url:find("[%c%s?#\\]") then return end
    local authority, path = url:match("^https://([^/]+)(.*)$")
    if not authority then return end
    local host, port = authority:match("^([A-Za-z0-9.%-]+):([0-9]+)$")
    host = host or authority:match("^([A-Za-z0-9.%-]+)$")
    -- 使用域名，使 LuatOS 校验服务端证书的主机名。
    if not host or #host > 253 or not host:find("[A-Za-z]") then return end
    port = tonumber(port)
    if port and (port < 1 or port > 65535) then return end
    local suffix = port and port ~= 443 and ":" .. port or ""
    return "https://" .. host:lower() .. suffix .. (path:gsub("/+$", ""))
end

local function getDestination()
    local base = serverBase(config.SERVER_URL)
    if not base then return nil, "请配置事件服务的 HTTPS 基础地址" end
    if type(auth) ~= "table" or auth.server_url ~= base or serverBase(auth.server_url) ~= auth.server_url
        or (auth.identity_type ~= "imei" and auth.identity_type ~= "sn")
        or normalizeIdentity(auth.identity_type, auth.identity_value) ~= auth.identity_value
        or auth.identity_value == nil or not validToken(auth.token) then
        return nil, "静态设备凭据无效或与服务地址不匹配"
    end
    local ca = config.SERVER_CA_PEM
    if ca == nil or ca == "" then ca = require "server_ca" end
    if type(ca) ~= "string" or not ca:find("-----BEGIN CERTIFICATE-----", 1, true) then
        return nil, "事件服务的 CA PEM 无效"
    end
    local digest = sha256(base)
    local kind, value, token = auth.identity_type, auth.identity_value, auth.token
    local id = automaticId(kind, value)
    if not digest or not id then return nil, "无法推导事件服务和设备标识" end
    local scope = digest:sub(1, SCOPE_BYTES)
    local client = { base = base, ca = ca, scope = scope }
    client.is_current = function()
        return destination == client and serverBase(config.SERVER_URL) == base
            and auth.server_url == base and auth.identity_type == kind and auth.identity_value == value and auth.token == token
            and client.base == base and client.scope == scope and client.ca == ca
            and (not client.prepared or (client.identity_type == kind and client.identity_value == value
                and client.device_id == id and client.token == token))
    end
    client.prepare = function()
        if not client.is_current() then return false, "服务或静态凭据已变更" end
        local read = mobile and mobile[kind]
        local ok, actual = false, nil
        if type(read) == "function" then ok, actual = pcall(read) end
        actual = ok and normalizeIdentity(kind, actual) or nil
        if not actual then return false, "等待预置身份对应的模组标识就绪" end
        if actual ~= value then return false, "模组身份与静态设备凭据不匹配" end
        client.identity_type, client.identity_value, client.device_id, client.token = kind, value, id, token
        client.prepared = true
        return true
    end
    return client
end

function util_notify.init()
    if ready then return end
    ready = true
    log.info("util_notify", "应用事件队列仅在 RAM，重启丢弃", "capacity", MAX_RECORDS)
    local err
    destination, err = getDestination()
    if destination then
        destination.transport = require("util_transport").start(destination)
        sys.taskInit(sendLoop, destination)
    else
        log.error("util_notify", err)
    end
end

return util_notify
