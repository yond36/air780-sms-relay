PROJECT = "air780e_forwarder"
VERSION = "1.0.6"

log.setLevel("INFO")
local boot_reason = tostring(pm.lastReson() or "unknown")
log.info("main", PROJECT, VERSION)
log.info("main", "开机原因", boot_reason)

sys = require "sys"
sysplus = require "sysplus"

wdt.init(9000)
sys.timerLoopStart(wdt.feed, 3000)
sys.timerLoopStart(function() collectgarbage("collect") end, 3600000)

-- pm.ioVol(pm.IOVOL_ALL_GPIO, 3300)
socket.setDNS(nil, 1, "119.29.29.29")
socket.setDNS(nil, 2, "223.5.5.5")
mobile.setAuto(10000, 300000, 8, true, 120000)
-- mobile.ipv6(true)

log.info("main", "应用事件和命令状态仅保存在 RAM，重启丢弃")

-- POWERKEY
local rtos_bsp = rtos.bsp()
local pin_table = { EC618 = 35, EC718P = 46 }
local powerkey_pin = pin_table[rtos_bsp]

if powerkey_pin then
    local button_last_press_time, button_last_release_time = 0, 0
    gpio.setup(powerkey_pin, function()
        local current_time = mcu.ticks()
        if gpio.get(powerkey_pin) == 0 then
            button_last_press_time = current_time
            return
        end
        if button_last_press_time == 0 or current_time - button_last_release_time < 250 then return end
        local duration = current_time - button_last_press_time
        button_last_release_time = current_time
        if duration > 2000 then
            sys.publish("POWERKEY_LONG_PRESS", duration)
        elseif duration > 50 then
            sys.publish("POWERKEY_SHORT_PRESS", duration)
        end
    end, gpio.PULLUP)
end

config = require "config"
util_mobile = require "util_mobile"
local util_sms = require "util_sms"
util_sms.init()
util_location = require "util_location"
util_notify = require "util_notify"
util_notify.init()

local function eventTime()
    local now = os.time()
    if type(now) == "number" and now >= 1714500000 then return now end
end

local latest_traffic
local function emit(kind, data)
    local occurred_at = eventTime()
    local status
    if config.INCLUDE_STATUS then
        status = util_mobile.eventStatus()
        status.location = util_location.get()
        status.traffic = latest_traffic
        if next(status) == nil then status = nil end
    end
    return util_notify.add(kind, data, status, occurred_at)
end

local month_days = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
local function smsServiceTime(meta)
    if type(meta) ~= "table" then return end
    local year, month, day = math.tointeger(meta.year), math.tointeger(meta.mon), math.tointeger(meta.day)
    local hour, minute, second = math.tointeger(meta.hour), math.tointeger(meta.min), math.tointeger(meta.sec)
    if not (year and month and day and hour and minute and second) then return end
    if year >= 0 and year < 100 then year = year + 2000 end
    local days = month_days[month]
    if year < 2000 or year > 2099 or not days then return end
    if month == 2 and year % 4 == 0 then days = 29 end
    if day < 1 or day > days or hour < 0 or hour > 23 or minute < 0 or minute > 59 or second < 0 or second > 59 then return end
    -- 固件的短信时间元数据不保证提供时区，仅保留服务中心的当地时间。
    return string.format("%04d-%02d-%02dT%02d:%02d:%02d", year, month, day, hour, minute, second)
end

sms.setNewSmsCb(function(sender, content, meta)
    if type(content) ~= "string" then return end
    emit("sms.received", {
        sender = type(sender) == "string" and sender or "",
        content = content,
        sim_slot = util_mobile.simSlot(),
        sms_time = smsServiceTime(meta),
    })
end)

local is_calling, call_number = false, nil
local function lastCallNumber()
    local number = cc.lastNum and cc.lastNum()
    if type(number) == "string" and number ~= "" then return number end
end

sys.subscribe("CC_IND", function(status)
    if not cc then return end
    if status == "INCOMINGCALL" and not is_calling then
        is_calling = true
        call_number = lastCallNumber()
        emit("call.incoming", { number = call_number or "" })
    elseif status == "DISCONNECTED" then
        emit("call.disconnected", { number = call_number or lastCallNumber() or "" })
        is_calling, call_number = false, nil
    end
end)

if config.UART_ENABLED then
    uart.setup(1, 115200, 8, 1, uart.NONE)
    uart.on(1, "receive", function(id, len)
        local data = uart.read(id, len)
        if type(data) ~= "string" or data == "" then return end
        if config.ROLE == "MASTER" then
            emit("uart.received", { port = id, encoding = "hex", content = (data:toHex()) })
        else
            uart.write(id, data)
        end
    end)
end

if config.BOOT_NOTIFY then emit("device.boot", { reason = boot_reason }) end
sys.subscribe("POWERKEY_SHORT_PRESS", function() emit("device.test", { reason = "powerkey" }) end)
sys.subscribe("POWERKEY_LONG_PRESS", util_mobile.queryTraffic)

local function intervalEnabled(interval)
    return type(interval) == "number" and interval >= 60000
end

local function syncClock()
    if socket.adapter(socket.LWIP_GP) then socket.sntp() end
end

local function syncClockIfNeeded()
    if not eventTime() then syncClock() end
end

sys.subscribe("IP_READY", syncClockIfNeeded)
syncClockIfNeeded()
if intervalEnabled(config.SNTP_INTERVAL) then
    sys.timerLoopStart(syncClock, config.SNTP_INTERVAL)
end

if intervalEnabled(config.REPORT_INTERVAL) then
    sys.timerLoopStart(function() emit("device.heartbeat", { reason = "periodic" }) end, config.REPORT_INTERVAL)
end

if intervalEnabled(config.QUERY_TRAFFIC_INTERVAL) then
    sys.timerLoopStart(util_mobile.queryTraffic, config.QUERY_TRAFFIC_INTERVAL)
end

if intervalEnabled(config.TRAFFIC_INTERVAL) then
    sys.timerLoopStart(function()
        local traffic = util_mobile.getTraffic()
        if traffic then
            latest_traffic = traffic
            emit("device.traffic", traffic)
        end
    end, config.TRAFFIC_INTERVAL)
end

if intervalEnabled(config.LOCATION_INTERVAL) then
    local function refreshLocation()
        if socket.adapter(socket.LWIP_GP) then
            util_location.refresh(nil, function(location) emit("device.location", location) end)
        end
    end
    sys.taskInit(function()
        if not socket.adapter(socket.LWIP_GP) then sys.waitUntil("IP_READY") end
        refreshLocation()
        sys.timerLoopStart(refreshLocation, config.LOCATION_INTERVAL)
    end)
end

sys.taskInit(function()
    if type(config.PIN_CODE) ~= "string" or config.PIN_CODE == "" then return end
    if not socket.adapter(socket.LWIP_GP) and not sys.waitUntil("IP_READY", 5000) then
        util_mobile.pinVerify(config.PIN_CODE)
    end
end)

if intervalEnabled(config.FLYMODE_INTERVAL) then
    sys.timerLoopStart(function()
        mobile.flymode(0, true)
        mobile.flymode(0, false)
    end, config.FLYMODE_INTERVAL)
end

sys.run()
