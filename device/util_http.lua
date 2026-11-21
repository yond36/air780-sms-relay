local util_http = {}

-- 用于生成 http 请求的 id
local http_count = 0

local luat_http_code_desc = {
    [0] = "HTTP_OK",
    [-1] = "HTTP_ERROR_STATE",
    [-2] = "HTTP_ERROR_HEADER",
    [-3] = "HTTP_ERROR_BODY",
    [-4] = "HTTP_ERROR_CONNECT",
    [-5] = "HTTP_ERROR_CLOSE",
    [-6] = "HTTP_ERROR_RX",
    [-7] = "HTTP_ERROR_DOWNLOAD",
    [-8] = "HTTP_ERROR_TIMEOUT",
    [-9] = "HTTP_ERROR_FOTA",
}

--- 对 http.request 的封装
-- @param timeout 超时时间(单位: 毫秒)
-- @param method 请求方法
-- @param url 请求地址
-- @param headers 请求头
-- @param body 请求体
-- @param server_ca 用于校验 HTTPS 服务端的 CA PEM 数据
function util_http.fetch(timeout, method, url, headers, body, server_ca)
    collectgarbage("collect")

    timeout = timeout or 1000 * 20
    local opts = { timeout = timeout, debug = false }

    http_count = http_count + 1
    local id = "http_" .. http_count

    log.debug("util_http.fetch", "开始请求", id)
    local ok, res_code, res_headers, res_body = pcall(function()
        return http.request(method, url, headers, body, opts, server_ca).wait()
    end)
    if not ok then
        res_code, res_headers, res_body = -99, nil, nil
    end
    log.debug("util_http.fetch", "请求结束", id, res_code, luat_http_code_desc[res_code])

    collectgarbage("collect")

    return res_code, res_headers, res_body
end

return util_http
