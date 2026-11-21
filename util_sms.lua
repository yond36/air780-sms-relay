local util_sms = {}

-- SMS_SENT 没有应用命令 ID；所有 sms.send（含运营商查询）必须经过此串行入口。
-- 官方 components/sms/binding/luat_lib_sms.c：sms.send true 仅表示初始 SDK 请求受理。
-- 等到 SMS_SENT true 也只叫 submitted，不是收件人送达；不请求/解释 SMS_REPORT。
local WAKE, SENT = "DEVICE_SMS_QUEUED", "DEVICE_SMS_COMPLETED"
local MAX_QUEUE, DEFAULT_TIMEOUT = 8, 180000
local queue, active, started, blocked = {}, nil, false, false

function util_sms.validate(to, content)
    if type(to) ~= "string" or #to > 29 or not to:match("^%+?[0-9]+$")
        or #(to:gsub("^%+", "")) < 3 then return false, "invalid_number" end
    if type(content) ~= "string" or content == "" or #content > 1500 then
        return false, "invalid_content"
    end
    -- 固件按 UCS2 编码。限制 BMP 500 字符，不截断、不改写国际 + 或正文。
    -- 500 BMP 字符可能分成多段；V2056/运营商组合的实机多段验证仍是验收项。
    local ok, count = pcall(utf8.len, content)
    if not ok or not count or count > 500 then return false, "invalid_content" end
    for _, cp in utf8.codes(content) do
        if cp > 0xFFFF or (cp >= 0xD800 and cp <= 0xDFFF) or cp == 0 then
            return false, "invalid_content"
        end
    end
    return true
end

local function complete(job, status, error_tag)
    if job.done then
        local ok = pcall(job.done, status, error_tag)
        if not ok then log.error("util_sms", "短信结果处理失败") end
    end
end

local function sent(result)
    if not active or active.completed then
        -- 无法证明一个无 ID 的额外结果属于哪个请求；不把它关联给下一条短信。
        blocked = true
        log.warn("util_sms", "未关联的短信结果，暂停本次开机发送")
        return
    end
    active.completed, active.result = true, result == true
    sys.publish(SENT)
end

local function worker()
    while true do
        if #queue == 0 then
            sys.waitUntil(WAKE)
        else
            local job = table.remove(queue, 1)
            if blocked then
                complete(job, "failed", "executor_blocked")
            else
                local allowed, error_tag = true, nil
                if job.before then
                    local ok, result, err = pcall(job.before)
                    allowed, error_tag = ok and result == true, ok and err or "precheck_error"
                end
                if not allowed then
                    complete(job, "failed", error_tag or "precheck_failed")
                elseif blocked then
                    complete(job, "failed", "executor_blocked")
                elseif not sms or type(sms.send) ~= "function" then
                    complete(job, "failed", "sms_unavailable")
                else
                    active = { completed = false }
                    -- 只此一处调用真正的发送 API。没有副作用自动重试。
                    local ok, accepted = pcall(sms.send, job.to, job.content)
                    if not ok or accepted ~= true then
                        blocked = true
                        complete(job, "unknown", ok and "send_rejected" or "send_exception")
                    else
                        local timeout = tonumber(config.SMS_SEND_TIMEOUT_MS) or DEFAULT_TIMEOUT
                        timeout = math.max(30000, math.min(timeout, 300000))
                        if not active.completed then sys.waitUntil(SENT, timeout) end
                        if active.completed and active.result then
                            complete(job, "submitted")
                        else
                            -- 错误/多段部分成功/晚到回执均无法安全区分。封锁到下次开机。
                            blocked = true
                            complete(job, "unknown", active.completed and "send_error" or "send_timeout")
                        end
                    end
                    active = nil
                    if not blocked then
                        -- 留一个无活动请求的排空窗口；窗口内的多余结果也会触发封锁。
                        sys.wait(1000)
                    end
                end
            end
        end
    end
end

function util_sms.init()
    if started then return end
    started = true
    sys.subscribe("SMS_SENT", sent)
    sys.taskInit(worker)
end

function util_sms.enqueue(to, content, before, done)
    local valid, err = util_sms.validate(to, content)
    if not valid then return false, err end
    util_sms.init()
    if blocked then return false, "executor_blocked" end
    if #queue >= MAX_QUEUE then return false, "sms_queue_full" end
    queue[#queue + 1] = { to = to, content = content, before = before, done = done }
    sys.publish(WAKE)
    return true
end

return util_sms
