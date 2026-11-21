const MAX_RESPONSE_BYTES = 512 * 1024;
const encoder = new TextEncoder();

export class ChannelError extends Error {
  constructor(code, message, { status, retryable = false, retryAfterMs } = {}) {
    super(message);
    this.result = { ok: false, retryable, code, error: message };
    if (status !== undefined) this.result.status = status;
    if (retryable && retryAfterMs !== undefined) this.result.retryAfterMs = retryAfterMs;
  }
}

export function sent(status, code) {
  return { ok: true, retryable: false, ...(status === undefined ? {} : { status }), ...(code ? { code } : {}) };
}

export function timeoutError() {
  return new ChannelError("timeout", "渠道发送超时", { retryable: true });
}

export const utf8Size = (value) => encoder.encode(value).byteLength;

export function requireLength(fits, label, limit) {
  if (!fits) throw new ChannelError("message_too_long", `${label}超过渠道限制（${limit}）`);
}

export function businessCode(value) {
  if (typeof value === "string" && /^-?\d{1,9}$/.test(value)) value = Number(value);
  if (Number.isInteger(value) && Math.abs(value) < 1_000_000_000) return value;
}

export function secondsToMs(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000)) return value * 1000;
}

function readRetryAfter(headers, now) {
  const value = headers.get("Retry-After")?.trim();
  if (!value) return;
  const delay = secondsToMs(value);
  if (delay !== undefined) return delay;
  if (!/^[A-Za-z]{3}/.test(value)) return;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now());
}

function discard(body) {
  void body?.cancel().catch(() => {});
}

async function readResponseJson(response, signal) {
  if (!response.body) return;
  if (Number(response.headers.get("Content-Length")) > MAX_RESPONSE_BYTES) {
    discard(response.body);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let json = "";
  const cancel = () => discard(reader);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancel();
        return;
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } catch {
    // A malformed response or stream failure is classified using the HTTP status.
    cancel();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function request(context, url, init, { json = true, feishu = false } = {}) {
  const { fetchImpl, signal, now } = context;
  if (signal.aborted) throw timeoutError();
  let response;
  try {
    response = await fetchImpl(url.toString(), { ...init, redirect: "manual", signal });
  } catch {
    if (signal.aborted) throw timeoutError();
    throw new ChannelError("network_error", "无法连接渠道服务", { retryable: true });
  }
  if (signal.aborted) {
    discard(response.body);
    throw timeoutError();
  }
  const { status, headers } = response;
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    discard(response.body);
    throw new ChannelError("redirect_blocked", "渠道服务返回了重定向", { status });
  }
  const retryAfterMs = readRetryAfter(headers, now) ?? (feishu ? secondsToMs(headers.get("x-ogw-ratelimit-reset")) : undefined);
  if (!json) {
    discard(response.body);
    return { status, retryAfterMs };
  }
  const data = await readResponseJson(response, signal);
  if (signal.aborted) throw timeoutError();
  return { status, retryAfterMs, data };
}

export function postJson(context, url, body, headers = {}, options) {
  return request(context, url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
  }, options);
}

function retryableStatus(status) {
  return [408, 409, 425, 429].includes(status) || (status >= 500 && status <= 599);
}

export function requireHttpSuccess({ status, retryAfterMs }) {
  if (status >= 200 && status < 300) return;
  const retryable = retryableStatus(status);
  const code = status === 429 ? "rate_limited" : "http_error";
  const error = status === 429 ? "渠道服务请求过于频繁" : "渠道服务返回 HTTP 错误";
  throw new ChannelError(code, error, { status, retryable, retryAfterMs });
}

export function invalidResponse(reply) {
  return new ChannelError("invalid_response", "渠道服务响应格式无效", { ...reply, retryable: true });
}

export function requireBusinessSuccess(reply, code, expected, { transient = [], rateLimits = {}, retryAfterMs } = {}) {
  const { status } = reply;
  const value = businessCode(code);
  if (value !== undefined && value !== expected) {
    const limited = value === 429 || status === 429 || Object.hasOwn(rateLimits, value);
    const retryable = limited || transient.includes(value) || retryableStatus(status);
    const delay = retryAfterMs ?? reply.retryAfterMs ?? rateLimits[value];
    const message = limited ? "渠道服务请求过于频繁" : "渠道服务拒绝了请求";
    throw new ChannelError(String(value), message, { status, retryable, retryAfterMs: delay });
  }
  requireHttpSuccess(reply);
  if (value !== expected) throw invalidResponse(reply);
}
