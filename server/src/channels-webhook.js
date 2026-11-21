import { HttpError, isRecord } from "./store.js";
import { ChannelError, requireBusinessSuccess, requireHttpSuccess, requireLength, request, sent, utf8Size } from "./channels-http.js";

const MAX_URL_BYTES = 16 * 1024;
const placeholders = /\{\{(TITLE|BODY)\}\}|\{msg\}/g;
const forbiddenHeaders = new Set([
  "host", "content-length", "connection", "transfer-encoding", "upgrade", "expect",
  "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer",
]);
const mediaTypes = {
  json: "application/json; charset=utf-8",
  form: "application/x-www-form-urlencoded; charset=utf-8",
  text: "text/plain; charset=utf-8",
};

export function httpsUrl(value, label) {
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (authority && !/[@{}]/.test(authority) && !/[\s\u0000-\u001f\u007f\\#]/.test(value) && utf8Size(value) <= MAX_URL_BYTES) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return url;
    } catch {
      // URL parser diagnostics can contain the configured address.
    }
  }
  throw new HttpError(400, `${label}须为无登录信息或片段的有效 HTTPS 地址`);
}

function expand(value, message, encode = (part) => part) {
  return value.replace(placeholders, (_, field) => encode(field === "TITLE" ? message.title : message.body));
}

function hasPlaceholder(value) {
  return expand(value, { title: "", body: "" }) !== value;
}

function jsonValue(value, label) {
  try {
    if (typeof value === "string") return JSON.parse(value);
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new HttpError(400, `${label}须为有效 JSON`);
  }
}

function normalizeHeaders(value) {
  if (value === undefined) return {};
  const parsed = jsonValue(value, "Webhook 请求头");
  if (!isRecord(parsed)) throw new HttpError(400, "Webhook 请求头须为 JSON 对象");
  const headers = new Headers();
  try {
    for (const [name, header] of Object.entries(parsed)) {
      if (typeof header !== "string" || /[\r\n\0]/.test(header) || forbiddenHeaders.has(name.toLowerCase()) || headers.has(name)) {
        throw new Error();
      }
      headers.set(name, header);
    }
  } catch {
    throw new HttpError(400, "Webhook 请求头包含无效、重复或受限的字段");
  }
  return Object.fromEntries(headers);
}

function formEntries(body) {
  if (!body.trimStart().startsWith("{")) return new URLSearchParams(body);
  const parsed = jsonValue(body, "Webhook 表单");
  if (!isRecord(parsed) || Object.values(parsed).some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value))) {
    throw new HttpError(400, "Webhook 表单须为字段值为标量的 JSON 对象或 URL 编码表单");
  }
  return Object.entries(parsed).map(([name, value]) => [name, String(value ?? "")]);
}

function pathHasDotSegment(path) {
  return path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

export function normalizeWebhookConfig(config) {
  const method = config.method ?? "POST";
  const url = httpsUrl(config.url, "Webhook 地址");
  const normalized = {
    url: url.href,
    method,
    headers: normalizeHeaders(config.headers),
    responseCheck: config.responseCheck ?? "http",
  };
  if (method === "GET") {
    const authority = /^https:\/\/[^/?#]+/i.exec(config.url)[0];
    const suffix = config.url.slice(authority.length);
    const [path, ...query] = suffix.split("?");
    const queryFields = query.join("?").split("&");
    if (pathHasDotSegment(path) || queryFields.some((field) => hasPlaceholder(field.split("=", 1)[0]))) {
      throw new HttpError(400, "Webhook GET 只允许在路径段或查询参数值中使用占位符，路径不能包含点段");
    }
    // URL percent-encodes braces in paths. Preserve the template until delivery.
    normalized.url = url.origin + (suffix || "/");
    return normalized;
  }
  if (hasPlaceholder(config.url)) throw new HttpError(400, "只有 GET Webhook 的地址支持占位符");
  if (utf8Size(url.href) > MAX_URL_BYTES) throw new HttpError(400, "Webhook 地址编码后过长");

  normalized.bodyType = config.bodyType ?? "json";
  if (config.body === undefined) return normalized;
  if (normalized.bodyType === "text") {
    if (typeof config.body !== "string") throw new HttpError(400, "Webhook 文本正文须为文字");
    normalized.body = config.body;
  } else if (normalized.bodyType === "json") {
    try {
      normalized.body = JSON.stringify(jsonValue(config.body, "Webhook 正文"));
    } catch {
      throw new HttpError(400, "Webhook 正文须为有效 JSON");
    }
  } else {
    if (typeof config.body !== "string" && !isRecord(config.body)) {
      throw new HttpError(400, "Webhook 表单须为 JSON 对象或 URL 编码表单");
    }
    const body = typeof config.body === "string" ? config.body : JSON.stringify(jsonValue(config.body, "Webhook 表单"));
    formEntries(body);
    normalized.body = body;
  }
  return normalized;
}

function webhookUrl(config, message) {
  if (config.method !== "GET") return config.url;
  const target = expand(config.url, message, encodeURIComponent);
  const path = target.slice(new URL(config.url).origin.length).split("?", 1)[0];
  if (pathHasDotSegment(path)) throw new ChannelError("invalid_webhook_path", "Webhook 占位符生成了无效的路径段");
  const url = new URL(target).href;
  requireLength(utf8Size(url) <= MAX_URL_BYTES, "Webhook 地址", "16 KiB");
  return url;
}

function webhookBody(config, message) {
  switch (config.bodyType) {
    case "json":
      return JSON.stringify(JSON.parse(config.body), (_, value) => typeof value === "string" ? expand(value, message) : value);
    case "form": {
      const body = new URLSearchParams();
      for (const [name, value] of formEntries(config.body)) body.append(name, expand(value, message));
      return body.toString();
    }
    case "text":
      return expand(config.body, message);
  }
}

export async function sendWebhook(config, message, context) {
  const url = webhookUrl(config, message);
  const headers = new Headers(config.headers);
  const init = { method: config.method, headers };
  if (config.body !== undefined) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", mediaTypes[config.bodyType]);
    init.body = webhookBody(config, message);
  }
  const reply = await request(context, url, init, { json: config.responseCheck !== "http" });
  if (config.responseCheck === "json_code_0") {
    requireBusinessSuccess(reply, reply.data?.code, 0, { transient: [500, 502, 503, 504] });
  } else if (config.responseCheck === "json_status_1") {
    requireBusinessSuccess(reply, reply.data?.status, 1);
  } else {
    requireHttpSuccess(reply);
  }
  return sent(reply.status);
}
