local util_ws = {}
local GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
local MAX_HEADER, MAX_MESSAGE, READ_CHUNK, TIMEOUT = 4096, 8192, 2048, 20000
local last_tick, elapsed = nil, 0

-- 小型 RFC6455 text/control 适配：严格 TLS、随机 Key/mask、Accept 验证、有限分片。
-- 不用 native websocket：其 create 绑定未传 verify/CA，headers(table) 还会 %xx 改写 Bearer。
-- 官方依据（并非 V2056 实机握手证明）：openLuat/LuatOS commit 908247a62c9224c098afb54051ba6b7df4064ff0
-- components/network/adapter/luat_lib_socket.c：第 8 参数 CA -> network_init_tls(..., 2)。
-- luat_network_adapter.c：按连接域名 mbedtls_ssl_set_hostname + VERIFY_REQUIRED。
function util_ws.now()
    local tick = mcu.ticks()
    if tick < 0 then tick = tick + 4294967296.0 end
    if last_tick then
        local delta = tick - last_tick
        if delta < 0 then delta = delta + 4294967296.0 end
        elapsed = elapsed + delta
    else
        elapsed = tick
    end
    last_tick = tick
    return elapsed
end

local function random(length)
    local value = crypto and crypto.trng and crypto.trng(length)
    if type(value) == "string" and #value == length then return value end
end

local function base64(value)
    local result = crypto and crypto.base64_encode and crypto.base64_encode(value)
    if type(result) == "string" then return result end
end

local function accept(key)
    local hash = crypto and crypto.sha1 and crypto.sha1(key .. GUID)
    if type(hash) ~= "string" then return end
    if #hash == 40 and hash:match("^[A-Fa-f0-9]+$") then
        hash = hash:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end)
    elseif #hash ~= 20 then
        return
    end
    return base64(hash)
end

function util_ws.request(client)
    if not client.is_current() or type(client.device_id) ~= "string" or #client.device_id > 80
        or type(client.token) ~= "string" or #client.token ~= 43 or not client.token:match("^[A-Za-z0-9_%-]+$")
        or (client.identity_type ~= "imei" and client.identity_type ~= "sn")
        or type(client.identity_value) ~= "string" or #client.identity_value < 3 or #client.identity_value > 64
        or not client.identity_value:match("^[A-Za-z0-9][A-Za-z0-9_.%-]+$") then return end
    local authority, path = client.base:match("^https://([^/]+)(.*)$")
    if not authority then return end
    local host, port = authority:match("^([A-Za-z0-9.%-]+):([0-9]+)$")
    host = host or authority:match("^([A-Za-z0-9.%-]+)$")
    if not host or #host > 253 or not host:find("[A-Za-z]") then return end
    port = tonumber(port) or 443
    if port < 1 or port > 65535 or path:find("[%c%s?#\\]") then return end
    local bytes = random(16)
    local key = bytes and base64(bytes)
    local expected = key and accept(key)
    if not key or #key ~= 24 or not expected then return end
    local id = client.device_id:gsub("[^A-Za-z0-9_.~%-]", function(byte)
        return string.format("%%%02X", byte:byte())
    end)
    local uri = path:gsub("/+$", "") .. "/api/v1/device/ws?device_id=" .. id
    local request = "GET " .. uri .. " HTTP/1.1\r\nHost: " .. authority
        .. "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " .. key
        .. "\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer " .. client.token
        .. "\r\nX-Relay-Identity-Type: " .. client.identity_type
        .. "\r\nX-Relay-Identity-Value: " .. client.identity_value .. "\r\n\r\n"
    if #request > MAX_HEADER then return end
    return request, expected, host, port
end

function util_ws.upgrade(header, expected)
    local status = header:match("^HTTP/1%.1 (%d%d%d)[ \r]")
    if status ~= "101" then return false, "upgrade_" .. (status or "invalid") end
    local headers, first = {}, true
    for line in header:gmatch("([^\r\n]+)\r\n") do
        if first then
            first = false
        else
            local name, value = line:match("^([%w!#$%%&'*+.^_`|~%-]+):[ \t]*(.-)[ \t]*$")
            if not name or value:find("[%c]") then return false, "bad_headers" end
            name = name:lower()
            if headers[name] then
                if name == "connection" then
                    value = headers[name] .. "," .. value
                elseif name == "upgrade" or name == "sec-websocket-accept"
                    or name == "sec-websocket-extensions" or name == "sec-websocket-protocol" then
                    return false, "duplicate_header"
                end
                -- Set-Cookie 等无关响应头可以重复；安全握手字段必须单一。
            end
            headers[name] = value
        end
    end
    local connection = false
    for token in (headers.connection or ""):gmatch("[^,]+") do
        if token:match("^%s*(.-)%s*$"):lower() == "upgrade" then connection = true end
    end
    if not connection or (headers.upgrade or ""):lower() ~= "websocket"
        or headers["sec-websocket-accept"] ~= expected or headers["sec-websocket-extensions"]
        or headers["sec-websocket-protocol"] then return false, "bad_upgrade" end
    return true
end

function util_ws.frame(payload, opcode)
    opcode = opcode or 1
    if type(payload) ~= "string" or #payload > MAX_MESSAGE
        or (opcode ~= 1 and opcode ~= 8 and opcode ~= 9 and opcode ~= 10)
        or (opcode >= 8 and #payload > 125) then return end
    local mask = random(4)
    if not mask then return end
    local length = #payload
    local header = string.char(0x80 | opcode)
    if length < 126 then
        header = header .. string.char(0x80 | length)
    else
        header = header .. string.char(0xFE, math.floor(length / 256), length % 256)
    end
    local encoded = {}
    for index = 1, length do
        encoded[index] = string.char(payload:byte(index) ~ mask:byte((index - 1) % 4 + 1))
    end
    return header .. mask .. table.concat(encoded)
end

local Decoder = {}
Decoder.__index = Decoder
local function validText(value)
    local ok, count = pcall(utf8.len, value)
    return ok and count ~= nil
end

function Decoder:feed(chunk)
    self.buffer = self.buffer .. chunk
    if #self.buffer > MAX_MESSAGE + READ_CHUNK + 14 then return nil, "buffer_limit" end
    local frames = {}
    while #self.buffer >= 2 do
        local a, b = self.buffer:byte(1, 2)
        local fin, opcode, length, offset = (a & 0x80) ~= 0, a & 0x0F, b & 0x7F, 2
        if (a & 0x70) ~= 0 or (b & 0x80) ~= 0 then return nil, "invalid_frame" end
        if length == 127 then return nil, "frame_limit" end
        if length == 126 then
            if #self.buffer < 4 then break end
            length = self.buffer:byte(3) * 256 + self.buffer:byte(4)
            offset = 4
            if length < 126 then return nil, "invalid_length" end
        end
        if length > MAX_MESSAGE or (opcode >= 8 and (not fin or length > 125)) then return nil, "frame_limit" end
        if #self.buffer < offset + length then break end
        local payload = self.buffer:sub(offset + 1, offset + length)
        self.buffer = self.buffer:sub(offset + length + 1)
        if opcode == 0 then
            if not self.fragment then return nil, "invalid_fragment" end
            payload = self.fragment .. payload
            if #payload > MAX_MESSAGE then return nil, "message_limit" end
            if fin then self.fragment = nil else self.fragment = payload end
            if fin then
                if not validText(payload) then return nil, "invalid_utf8" end
                frames[#frames + 1] = { opcode = 1, data = payload }
            end
        elseif opcode == 1 then
            if self.fragment then return nil, "invalid_fragment" end
            if fin then
                if not validText(payload) then return nil, "invalid_utf8" end
                frames[#frames + 1] = { opcode = 1, data = payload }
            else
                self.fragment = payload
            end
        elseif opcode == 8 or opcode == 9 or opcode == 10 then
            if opcode == 8 then
                if length == 1 or (length >= 2 and not validText(payload:sub(3))) then return nil, "invalid_close" end
            end
            frames[#frames + 1] = { opcode = opcode, data = payload }
        else
            return nil, "unsupported_frame"
        end
    end
    return frames
end

function util_ws.decoder()
    return setmetatable({ buffer = "" }, Decoder)
end

local Ws = {}
Ws.__index = Ws

function Ws:close()
    if self.closed then return end
    self.closed = true
    if self.ctrl then
        pcall(socket.close, self.ctrl)
        if socket.release then pcall(socket.release, self.ctrl) end
        self.ctrl = nil
    end
end

function Ws:await(field, timeout)
    local deadline = util_ws.now() + timeout
    while not self.closed and not self.failed do
        if self[field] ~= nil then return self[field] == 0 end
        local remaining = deadline - util_ws.now()
        if remaining <= 0 then break end
        sys.waitUntil(self.wake, math.ceil(remaining))
    end
    return false
end

function Ws:wait(timeout)
    if self.closed or self.failed then return false end
    local ok, immediate = socket.wait(self.ctrl)
    if not ok then self.failed = true; return false end
    if not immediate then sys.waitUntil(self.wake, timeout) end
    return not self.closed and not self.failed
end

function Ws:tx(data)
    if self.closed or self.failed or not self.client.is_current() then return false end
    self.tx_result = nil
    local ok, full, immediate = socket.tx(self.ctrl, data)
    -- full 可能意味着部分写入；不在同一流上重新发送整个帧。
    if not ok or full then self.failed = true; return false end
    if immediate then self.tx_result = 0 end
    if not self:await("tx_result", TIMEOUT) then self.failed = true; return false end
    local armed = socket.wait(self.ctrl)
    if not armed then self.failed = true; return false end
    return true
end

function Ws:send(payload, opcode)
    local frame = util_ws.frame(payload, opcode)
    return frame ~= nil and self:tx(frame)
end

function Ws:read()
    if self.closed or self.failed then return end
    self.buff:del()
    local ok, length = socket.rx(self.ctrl, self.buff, 0, READ_CHUNK)
    if not ok or type(length) ~= "number" or length < 0 or length > READ_CHUNK then
        self.failed = true
        return
    end
    local chunk = length > 0 and self.buff:query(0, length) or ""
    self.buff:del()
    return chunk
end

function util_ws.open(client, wake)
    local request, expected, host, port = util_ws.request(client)
    if not request then return nil, "ws_parameters" end
    if type(client.ca) ~= "string" or not client.ca:find("-----BEGIN CERTIFICATE-----", 1, true)
        or not socket.create or not socket.config or not zbuff then return nil, "tls_unavailable" end
    local ws = setmetatable({ client = client, wake = wake, decoder = util_ws.decoder() }, Ws)
    local ok, ctrl = pcall(socket.create, socket.LWIP_GP, function(_, event, code)
        if ws.closed then return end
        code = tonumber(code) or 0
        if event == socket.ON_LINE then ws.connect_result = code end
        if event == socket.TX_OK then ws.tx_result = code end
        if code ~= 0 or event == socket.CLOSED then ws.failed = true end
        sys.publish(wake)
    end)
    if not ok or not ctrl then return nil, "socket_create" end
    ws.ctrl, ws.buff = ctrl, zbuff.create(READ_CHUNK)
    if socket.debug then socket.debug(ctrl, false) end
    -- 绝不能删除 CA 参数、改用 verify=0，或为了连接成功改为 IP 地址。
    local configured, success = pcall(socket.config, ctrl, nil, false, true, nil, nil, nil, client.ca)
    if not configured or success ~= true then ws:close(); return nil, "tls_config" end
    local connected, immediate = socket.connect(ctrl, host, port, false)
    if not connected then ws:close(); return nil, "tls_connect" end
    if immediate then ws.connect_result = 0 end
    if not ws:await("connect_result", TIMEOUT) then ws:close(); return nil, "tls_connect" end
    if not ws:tx(request) then ws:close(); return nil, "upgrade_tx" end

    local buffer, deadline = "", util_ws.now() + TIMEOUT
    while util_ws.now() < deadline and client.is_current() do
        local chunk = ws:read()
        if not chunk then break end
        buffer = buffer .. chunk
        local ending = buffer:find("\r\n\r\n", 1, true)
        if ending then
            if ending + 3 > MAX_HEADER then ws:close(); return nil, "header_limit" end
            local valid, err = util_ws.upgrade(buffer:sub(1, ending + 3), expected)
            if not valid then ws:close(); return nil, err end
            -- Upgrade 与首个 hello 可能在同一 TCP 包内，绝不能丢掉头部后的字节。
            ws.initial = buffer:sub(ending + 4)
            return ws
        end
        if #buffer > MAX_HEADER then ws:close(); return nil, "header_limit" end
        if chunk == "" and not ws:wait(math.ceil(deadline - util_ws.now())) then break end
    end
    ws:close()
    return nil, "upgrade_timeout"
end

return util_ws
