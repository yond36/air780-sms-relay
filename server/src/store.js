export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const keys = {
  device: (id) => `devices:${id}`,
  deviceToken: (id) => `device-tokens:${id}`,
  latest: (id) => `latest:${id}`,
  channel: (id) => `channels:${id}`,
  template: (id) => `templates:${id}`,
  eventTemplate: (type) => `event-templates:${type}`,
  rule: (id) => `rules:${id}`,
  job: (id) => `jobs:${id}`,
  event: (deviceId, eventId) => `events:${deviceId}:${eventId}`,
  pending: (deviceId, eventId) => `pending:${deviceId}:${eventId}`,
  delivery: (deviceId, eventId, channelId) => `deliveries:${deviceId}:${eventId}:${channelId}`,
  sent: (deviceId, eventId, channelId) => `sent:${deviceId}:${eventId}:${channelId}`,
};

export const retentionDays = (env) => {
  const days = Number(env.EVENT_RETENTION_DAYS);
  return Number.isInteger(days) && days >= 1 && days <= 90 ? days : 7;
};

export const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value);
export const isAutomaticDeviceId = (value) => typeof value === "string" && /^auto~[A-Za-z0-9_-]{43}$/.test(value);
export const validDeviceId = (value) => validId(value) || isAutomaticDeviceId(value);

export function object(value, label = "请求") {
  if (!isRecord(value)) throw new HttpError(400, `${label}须为 JSON 对象`);
  return value;
}

export function text(value, label, { max = 128, required = false, trim = true } = {}) {
  if (value == null && !required) return "";
  if (typeof value !== "string") throw new HttpError(400, `${label}须为文字`);
  const result = trim ? value.trim() : value;
  if (required && !result) throw new HttpError(400, `请填写${label}`);
  if (result.length > max) throw new HttpError(400, `${label}最多 ${max} 个字符`);
  return result;
}

export function enabled(value) {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new HttpError(400, "启用状态须为布尔值");
  return value;
}

export function identifier(value, label) {
  if (!validId(value)) throw new HttpError(400, `${label}须为 1–80 位字母、数字、点、短横线或下划线，并以字母或数字开头`);
  return value;
}

export function deviceIdentifier(value) {
  return isAutomaticDeviceId(value) ? value : identifier(value, "设备标识");
}

export function idList(value, label, { max = 24, required = false, validate = validId } = {}) {
  if (value === undefined) value = [];
  if (!Array.isArray(value) || value.length > max || value.some((id) => !validate(id))) {
    throw new HttpError(400, `${label}须为最多 ${max} 项的标识列表`);
  }
  if (required && value.length === 0) throw new HttpError(400, `请选择${label}`);
  return [...new Set(value)];
}

export async function readBody(request, maxBytes) {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].toLowerCase().trim();
  if (contentType !== "application/json") throw new HttpError(415, "请求须使用 application/json");
  if (Number(request.headers.get("Content-Length")) > maxBytes) throw new HttpError(413, "请求内容过长");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求缺少 JSON 内容");
  let size = 0;
  let json = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "请求内容过长");
      }
      json += decoder.decode(value, { stream: true });
    }
    return object(JSON.parse(json + decoder.decode()));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "请求包含无效的 UTF-8 或 JSON");
  } finally {
    reader.releaseLock();
  }
}

export function getJson(kv, key) {
  return kv.get(key, "json");
}

export function putJson(kv, key, value, expiresAt) {
  const options = expiresAt === undefined ? {} : { expiration: Math.max(expiresAt, Math.ceil(Date.now() / 1000) + 61) };
  return kv.put(key, JSON.stringify(value), options);
}

export async function getMany(kv, names) {
  const results = new Map();
  for (let start = 0; start < names.length; start += 100) {
    const values = await kv.get(names.slice(start, start + 100), "json");
    for (const [name, value] of values) results.set(name, value);
  }
  return results;
}

export async function listValues(kv, prefix, { cursor, limit = 30 } = {}) {
  const page = await kv.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
  const values = await getMany(kv, page.keys.map(({ name }) => name));
  return {
    items: page.keys.map(({ name }) => values.get(name)).filter(Boolean),
    cursor: page.list_complete ? null : page.cursor,
  };
}

export async function allValues(kv, prefix) {
  const items = [];
  let cursor;
  do {
    const page = await listValues(kv, prefix, { cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export function jsonResponse(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}
