import { dataStore } from "./db.js";
import { closeDeviceConnection } from "./realtime.js";
import { deviceBearer, digest, matchesDigest } from "./security.js";
import { deviceIdentifier, HttpError, jsonResponse, readBody, text } from "./store.js";

export function hardwareIdentity(input) {
  const type = input.identity_type;
  if (type !== "imei" && type !== "sn") throw new HttpError(400, "设备标识类型须为 IMEI 或 SN");
  const raw = text(input.identity_value, "硬件标识", { max: 64, required: true });
  const value = type === "sn" ? raw.toUpperCase() : raw;
  const valid = type === "imei"
    ? /^\d{15}$/.test(value) && !/^0+$/.test(value)
    : /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(raw);
  if (!valid) throw new HttpError(400, `无效的 ${type.toUpperCase()}`);
  return { identity_type: type, identity_value: value };
}

function deviceView(record) {
  return { ...record.device, enrollment_pending: !record.hash, credential_version: record.credentialVersion };
}

export async function deviceRegistry(env, id, command) {
  const store = dataStore(env);
  if (command.action === "register") {
    const { created } = await store.registerDevice(id, command.identity, command.hash);
    return { created };
  }
  const current = await store.getDeviceRecord(id);
  if (command.action === "authenticate") {
    if (current?.deleted || current?.device.enabled === false) throw new HttpError(403, "设备已停用或已删除");
    if (!matchesDigest(command.hash, current?.hash)) throw new HttpError(401, "设备令牌无效");
    return { item: deviceView(current) };
  }
  if (command.action === "delete" && current?.deleted) return { ok: true };
  if (!current || current.deleted) throw new HttpError(404, "记录不存在");
  if (command.action === "get") return { item: deviceView(current) };
  if (command.action === "update") {
    const record = await store.updateDeviceRecord(id, { name: command.name, enabled: command.enabled });
    if (!record.device.enabled) await closeDeviceConnection(env, id);
    return { item: deviceView(record) };
  }
  if (command.action === "rebind") {
    const record = await store.rebindDeviceRecord(id);
    await closeDeviceConnection(env, id);
    return { item: deviceView(record) };
  }
  if (command.action === "delete") {
    await store.deleteDeviceRecord(id);
    await closeDeviceConnection(env, id);
    return { ok: true };
  }
  throw new HttpError(404, "操作不存在");
}

async function registrationLimit(request, env) {
  const limiter = env.RELAY_REGISTRATION_LIMIT;
  if (!limiter) throw new HttpError(503, "设备登记暂不可用");
  const source = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await limiter.limit({ key: source })).success) {
    return jsonResponse({ ok: false, error: "登记请求过于频繁，请稍后重试" }, 429, { "Retry-After": "60" });
  }
  return null;
}

// HTTP registration and the first WebSocket upgrade share the same D1 authority.
// Reconnects authenticate an existing binding without rewriting its projections.
export async function enrollIdentity(request, env, input, { token = deviceBearer(request), deviceId } = {}) {
  if (!token) throw new HttpError(401, "设备令牌无效");
  const identity = hardwareIdentity(input);
  const id = `auto~${await digest(`${identity.identity_type}:${identity.identity_value}`)}`;
  if (deviceId !== undefined && deviceIdentifier(deviceId) !== id) {
    throw new HttpError(403, "设备标识与硬件标识不匹配");
  }
  const hash = await digest(token);
  const store = dataStore(env);
  const current = await store.getDeviceRecord(id);
  if (current && !current.deleted && current.device.enabled && matchesDigest(hash, current.hash)) {
    return { id, hash, record: current, created: false };
  }
  const response = await registrationLimit(request, env);
  if (response) return { response };
  const { record, created } = await store.registerDevice(id, identity, hash);
  return { id, hash, record, created };
}

export async function registerDevice(request, env) {
  if (request.method !== "POST") throw new HttpError(405, "请使用 POST 登记设备");
  const token = deviceBearer(request);
  if (!token) throw new HttpError(401, "设备令牌无效");
  const input = await readBody(request, 1024);
  if (input.version !== 1) throw new HttpError(400, "仅支持版本 1 的设备登记协议");
  const result = await enrollIdentity(request, env, input, { token });
  if (result.response) return result.response;
  return jsonResponse({ ok: true, device_id: result.id }, result.created ? 201 : 200);
}

export async function authenticateAutomaticDevice(env, id, token) {
  const { item } = await deviceRegistry(env, id, { action: "authenticate", hash: await digest(token) });
  return item;
}
