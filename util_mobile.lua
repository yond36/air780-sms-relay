local util_mobile = {}

function util_mobile.simSlot()
    local slot = mobile.simid and mobile.simid()
    if slot == 0 or slot == 1 then return slot end
end

--- 验证 SIM 卡 PIN
function util_mobile.pinVerify(pin_code)
    local sim_id = util_mobile.simSlot()
    if sim_id == nil then return end

    pin_code = tostring(pin_code or "")
    if #pin_code < 4 or #pin_code > 8 then
        log.warn("util_mobile.pinVerify", "PIN 码长度不正确")
        return
    end

    local cpin_is_ready = mobile.simPin(sim_id)
    if cpin_is_ready then
        log.info("util_mobile.pinVerify", "无需验证 PIN 码")
        return
    end

    cpin_is_ready = mobile.simPin(sim_id, mobile.PIN_VERIFY, pin_code)
    log.info("util_mobile.pinVerify", cpin_is_ready and "验证 PIN 码成功" or "验证 PIN 码失败")
end

local oper_data = {
    ["46000"] = { "CM", "中国移动", { "10086", "CXLL" } },
    ["46002"] = { "CM", "中国移动", { "10086", "CXLL" } },
    ["46007"] = { "CM", "中国移动", { "10086", "CXLL" } },
    ["46008"] = { "CM", "中国移动", { "10086", "CXLL" } },
    ["46001"] = { "CU", "中国联通", { "10010", "2082" } },
    ["46006"] = { "CU", "中国联通", { "10010", "2082" } },
    ["46009"] = { "CU", "中国联通", { "10010", "2082" } },
    ["46010"] = { "CU", "中国联通", { "10010", "2082" } },
    ["46003"] = { "CT", "中国电信", { "10001", "108" } },
    ["46005"] = { "CT", "中国电信", { "10001", "108" } },
    ["46011"] = { "CT", "中国电信", { "10001", "108" } },
    ["46012"] = { "CT", "中国电信", { "10001", "108" } },
    ["46015"] = { "CB", "中国广电" },
}

local function simImsi()
    local imsi = mobile.imsi and mobile.imsi(util_mobile.simSlot())
    return type(imsi) == "string" and imsi or ""
end

function util_mobile.getMccMnc()
    local imsi = simImsi()
    return imsi:sub(1, 3), imsi:sub(4, 5)
end

function util_mobile.getBand()
    local info = mobile.getCellInfo()[1] or {}
    return info.band or -1
end

function util_mobile.getOper(is_zh)
    local code = simImsi():match("^([0-9][0-9][0-9][0-9][0-9])")
    local oper = oper_data[code]
    if oper then return is_zh and oper[2] or oper[1] end
    return code or ""
end

--- 发送查询流量短信，回复走普通短信接收事件。
function util_mobile.queryTraffic()
    local oper = oper_data[simImsi():sub(1, 5)]
    if oper and oper[3] then
        local executor = require "util_sms"
        local queued, err = executor.enqueue(oper[3][1], oper[3][2])
        if not queued then log.warn("util_mobile.queryTraffic", "查询短信未排队", err) end
        return queued
    else
        log.warn("util_mobile.queryTraffic", "查询流量代码未配置")
    end
end

local network_states = {
    [0] = "网络未注册",
    [1] = "网络已注册",
    [2] = "网络搜索中",
    [3] = "网络注册被拒绝",
    [4] = "网络状态未知",
    [5] = "网络已注册,漫游",
    [6] = "网络已注册,仅SMS",
    [7] = "网络已注册,漫游,仅SMS",
    [8] = "网络已注册,紧急服务",
    [9] = "网络已注册,非主要服务",
    [10] = "网络已注册,非主要服务,漫游",
}

function util_mobile.status()
    return network_states[mobile.status and mobile.status()] or "未知网络状态"
end

local function uptimeSeconds()
    if mcu.ticks2 then
        local millions, seconds = mcu.ticks2(2)
        if type(millions) == "number" and type(seconds) == "number" then
            return millions * 1000000 + seconds
        end
    end
    local ms = mcu.ticks and mcu.ticks()
    if type(ms) == "number" then
        if ms < 0 then ms = ms + 4294967296.0 end
        return math.floor(ms / 1000)
    end
end

function util_mobile.eventStatus()
    local number = mobile.number and mobile.number(util_mobile.simSlot())
    if type(number) ~= "string" or number == "" then number = config.FALLBACK_LOCAL_NUMBER end
    local operator = util_mobile.getOper(true)
    local rsrp = mobile.rsrp and mobile.rsrp()
    return {
        number = type(number) == "string" and number:match("%S") and number or nil,
        operator = operator ~= "" and operator or nil,
        rsrp_dbm = type(rsrp) == "number" and rsrp >= -140 and rsrp <= -44 and rsrp or nil,
        uptime_seconds = uptimeSeconds(),
        network_state = network_states[mobile.status and mobile.status()],
    }
end

local function nonnegativeInteger(value)
    return type(value) == "number" and value >= 0 and value % 1 == 0
end

--- 读取开机后的实际蜂窝流量计数。
function util_mobile.getTraffic()
    if not mobile.dataTraffic then return end
    local up_gib, up_bytes, down_gib, down_bytes = mobile.dataTraffic()
    if not nonnegativeInteger(up_gib) or not nonnegativeInteger(up_bytes)
        or not nonnegativeInteger(down_gib) or not nonnegativeInteger(down_bytes) then return end
    -- 浮点乘法避免 32 位 Lua 整数溢出，能表示为整数时保留整数类型。
    local uplink = up_gib * 1073741824.0 + up_bytes
    local downlink = down_gib * 1073741824.0 + down_bytes
    return {
        uplink_bytes = math.tointeger(uplink) or uplink,
        downlink_bytes = math.tointeger(downlink) or downlink,
    }
end

return util_mobile
