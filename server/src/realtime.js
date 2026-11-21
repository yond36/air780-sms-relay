import { dataStore, d1Session } from "./db.js";
import { dispatchEvent } from "./delivery.js";
import { enrollIdentity } from "./enrollment.js";
import { acceptIncoming } from "./ingest.js";
import { updateDeviceStatus } from "./events.js";
import { deviceBearer, matchesDigest, newToken } from "./security.js";
import { activateSmsSession, nextSmsCommand, recordSmsResult } from "./sms.js";
import { deviceIdentifier, getJson, HttpError, isRecord, jsonResponse, keys, putJson } from "./store.js";

export const PROTOCOL_VERSION = 2;
const MAX_MESSAGE_BYTES = 24 * 1024;
const PRESENCE_ALARM_INTERVAL_MS = 60_000;
const PRESENCE_HEARTBEAT_ACK_MS = 20_000;
const utf8 = new TextEncoder();
const statusUpdates = new WeakMap();

class SupersededSocketError extends HttpError {
  constructor() { super(409, "连接已被新的会话替代"); }
}

function requireRealtime(env) {
  if (!env.DEVICE_SESSION || !env.DB) throw new HttpError(503, "实时连接尚未配置");
}

function serverHeartbeatSeconds(env) {
  const value = Number(env.WS_HEARTBEAT_SECONDS);
  return Number.isInteger(value) && value >= 60 && value <= 300 ? value : 60;
}

async function checkCredential(env, deviceId, hash) {
  const record = await dataStore(env).getDeviceRecord(deviceId);
  if (!record || record.deleted || !record.device.enabled) throw new HttpError(403, "设备已停用或不存在");
  if (!matchesDigest(hash, record.hash)) throw new HttpError(401, "设备令牌无效");
  return record;
}

function peers(state) {
  return typeof state.getWebSockets === "function" ? state.getWebSockets() : [];
}

function attachment(socket) {
  try { return socket.deserializeAttachment(); } catch { return null; }
}

function currentSocket(state, socket, expected) {
  const current = attachment(socket);
  return Boolean(expected && current && !current.superseded && peers(state).includes(socket)
    && (socket.readyState === undefined || socket.readyState === 1)
    && current.protocol_version === PROTOCOL_VERSION
    && current.id === expected.id && current.device_id === expected.device_id
    && current.session_id === expected.session_id && current.hash === expected.hash
    && current.credential_version === expected.credential_version);
}

function assertCurrentSocket(state, socket, expected) {
  if (!currentSocket(state, socket, expected)) throw new SupersededSocketError();
  return attachment(socket);
}

async function authenticatedSocket(state, env, socket, expected) {
  assertCurrentSocket(state, socket, expected);
  const record = await checkCredential(env, expected.device_id, expected.hash);
  const current = assertCurrentSocket(state, socket, expected);
  if (record.credentialVersion !== expected.credential_version) throw new HttpError(401, "设备凭据已变更");
  if (record.commandSession !== expected.session_id) throw new SupersededSocketError();
  return { device: record.device, metadata: current };
}

function supersede(socket, reason = "connection replaced") {
  const metadata = attachment(socket);
  if (metadata) {
    try { socket.serializeAttachment({ ...metadata, superseded: true, ready: false, event_ready: false, command_ready: false }); } catch {}
  }
  try { socket.close(1008, reason); } catch {}
}

function send(socket, value) {
  socket.send(JSON.stringify(value));
}

// Status is a presentation projection, not session authority. Serialize all
// latest-record updates in this DO so a delayed close/read cannot erase a newer
// connection or its journal readiness, including after an event status update.
function statusUpdate(state, update) {
  const previous = statusUpdates.get(state) || Promise.resolve();
  const next = previous.catch(() => {}).then(update);
  statusUpdates.set(state, next);
  return next;
}

async function saveConnectionProjection(env, deviceId, metadata, connection, connected) {
  const serialized = JSON.stringify(connection);
  const owner = `EXISTS (SELECT 1 FROM device_registry d WHERE d.id = ? AND d.command_session = ?
    AND d.credential_version = ? AND d.enabled = 1 AND d.deleted = 0)`;
  const session = d1Session(env);
  if (connected) {
    const saved = await session.prepare(`
      INSERT INTO relay_records (key, value, expires_at)
      SELECT ?, json_object('connection', json(?)), NULL WHERE ${owner}
      ON CONFLICT(key) DO UPDATE SET value = json_set(relay_records.value, '$.connection', json(?)), expires_at = NULL
      WHERE ${owner}
      RETURNING key
    `).bind(keys.latest(deviceId), serialized, deviceId, metadata.session_id, metadata.credential_version,
      serialized, deviceId, metadata.session_id, metadata.credential_version).first();
    return Boolean(saved);
  }
  const saved = await session.prepare(`
    UPDATE relay_records SET value = json_set(value, '$.connection', json(?)), expires_at = NULL
    WHERE key = ? AND json_extract(value, '$.connection.id') = ?
      AND json_extract(value, '$.connection.session_id') = ?
      AND json_extract(value, '$.connection.state') = 'online'
    RETURNING key
  `).bind(serialized, keys.latest(deviceId), metadata.id, metadata.session_id).first();
  return Boolean(saved);
}

function connectionStatus(state, env, socket, metadata, connected) {
  return statusUpdate(state, async () => {
    if (connected && !currentSocket(state, socket, metadata)) return false;
    if (!connected) {
      const current = await getJson(dataStore(env), keys.latest(metadata.device_id));
      if (current?.connection?.session_id !== metadata.session_id) return false;
      if (peers(state).some((peer) => {
        const active = attachment(peer);
        return active && !active.superseded && active.device_id === metadata.device_id && active.id !== metadata.id;
      })) return false;
    }
    const latest = connected ? attachment(socket) : metadata;
    const saved = await saveConnectionProjection(env, metadata.device_id, latest, {
      id: latest.id,
      session_id: latest.session_id,
      state: connected ? "online" : "offline",
      ready: connected && latest.ready,
      event_ready: connected && latest.event_ready,
      command_ready: connected && latest.command_ready,
      heartbeat_seconds: latest.heartbeat_seconds,
      connected_at: latest.connected_at,
      journal: { usable_slots: latest.usable_slots, quarantined_slots: latest.quarantined_slots },
      usable_slots: latest.usable_slots,
      quarantined_slots: latest.quarantined_slots,
      updated_at: new Date().toISOString(),
    }, connected);
    if (!connected && saved && typeof state.storage?.deleteAlarm === "function"
      && !peers(state).some((peer) => {
        const active = attachment(peer);
        return active && !active.superseded && active.device_id === metadata.device_id;
      })) await state.storage.deleteAlarm();
    return saved;
  });
}

async function schedulePresenceAlarm(state) {
  if (typeof state.storage?.setAlarm === "function") {
    await state.storage.setAlarm(Date.now() + PRESENCE_ALARM_INTERVAL_MS);
  }
}

function autoResponseAt(state, socket) {
  if (typeof state.getWebSocketAutoResponseTimestamp !== "function") return null;
  try {
    const value = state.getWebSocketAutoResponseTimestamp(socket);
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
  } catch {
    return null;
  }
}

async function expireConnection(state, env, deviceId, connection, now) {
  const metadata = { id: connection.id, session_id: connection.session_id };
  const saved = await saveConnectionProjection(env, deviceId, metadata, {
    ...connection, state: "offline", ready: false, event_ready: false, command_ready: false,
    updated_at: new Date(now).toISOString(),
  }, false);
  if (saved) {
    const socket = peers(state).find((candidate) => {
      const current = attachment(candidate);
      return current && current.device_id === deviceId && current.session_id === connection.session_id;
    });
    if (socket) supersede(socket, "heartbeat timeout");
  }
  return (await getJson(dataStore(env), keys.latest(deviceId)))?.connection ?? null;
}

async function refreshConnectionPresenceLocked(state, env, deviceId, now) {
  const latest = await getJson(dataStore(env), keys.latest(deviceId));
  const connection = latest?.connection;
  if (connection?.state !== "online" || !connection.session_id) return connection ?? null;
  if (typeof state.storage?.put === "function" && await state.storage.get("presence-device-id") !== deviceId) {
    await state.storage.put("presence-device-id", deviceId);
  }
  await schedulePresenceAlarm(state);

  const socket = peers(state).find((candidate) => {
    const current = attachment(candidate);
    return current && current.device_id === deviceId && current.session_id === connection.session_id
      && !current.superseded && currentSocket(state, candidate, current);
  });
  if (!socket) return expireConnection(state, env, deviceId, connection, now);

  const metadata = attachment(socket);
  let authorized = true;
  try { await authenticatedSocket(state, env, socket, metadata); }
  catch (error) {
    if (error instanceof SupersededSocketError || error instanceof HttpError && [401, 403].includes(error.status)) authorized = false;
    else throw error;
  }
  const autoAt = autoResponseAt(state, socket);
  const fallbackAt = Number.isFinite(metadata.lastHeartbeatAt) ? metadata.lastHeartbeatAt
    : Date.parse(metadata.connected_at || connection.connected_at || connection.updated_at);
  const lastActivity = Math.max(autoAt ?? -Infinity, fallbackAt);
  const heartbeat = Number.isInteger(metadata.heartbeat_seconds) && metadata.heartbeat_seconds >= 60 && metadata.heartbeat_seconds <= 300
    ? metadata.heartbeat_seconds : Number.isInteger(connection.heartbeat_seconds) ? connection.heartbeat_seconds : 60;
  const silenceLimit = heartbeat * 1000 + PRESENCE_HEARTBEAT_ACK_MS + 30_000;
  if (!authorized || !Number.isFinite(lastActivity) || now - lastActivity > silenceLimit) {
    return expireConnection(state, env, deviceId, connection, now);
  }
  return { ...connection, updated_at: new Date(lastActivity).toISOString() };
}

export async function refreshConnectionPresence(state, env, deviceId, now = Date.now()) {
  deviceIdentifier(deviceId);
  return statusUpdate(state, () => refreshConnectionPresenceLocked(state, env, deviceId, now));
}

export async function runPresenceAlarm(state, env, now = Date.now()) {
  const deviceId = await state.storage.get("presence-device-id")
    || peers(state).map((socket) => attachment(socket)?.device_id).find(Boolean);
  if (typeof deviceId === "string") await refreshConnectionPresence(state, env, deviceId, now);
  const active = peers(state).some((socket) => {
    const metadata = attachment(socket);
    return metadata && !metadata.superseded && currentSocket(state, socket, metadata);
  });
  if (active) await schedulePresenceAlarm(state);
  else if (typeof state.storage?.deleteAlarm === "function") await state.storage.deleteAlarm();
}

export async function openDeviceSocket(state, env, request) {
  requireRealtime(env);
  const deviceId = deviceIdentifier(request.headers.get("X-Relay-Device"));
  const hash = request.headers.get("X-Relay-Credential");
  await checkCredential(env, deviceId, hash);
  const sessionId = newToken();
  // Only a fresh upgrade activates a session. Hibernated socket callbacks use
  // their existing attachment and must never retire/activate commands again.
  const activated = await activateSmsSession(env, deviceId, hash, sessionId);
  if (activated.session_id !== sessionId || !Number.isSafeInteger(activated.credential_version)) {
    throw new HttpError(503, "连接会话尚未完整保存");
  }
  const record = await checkCredential(env, deviceId, hash);
  if (record.credentialVersion !== activated.credential_version) throw new HttpError(401, "设备凭据已变更");
  if (record.commandSession !== sessionId) throw new SupersededSocketError();
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  for (const socket of peers(state)) supersede(socket);
  state.acceptWebSocket(server, ["device"]);
  if (typeof WebSocketRequestResponsePair !== "undefined"
    && typeof state.getWebSocketAutoResponseTimestamp === "function") {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("p", "q"));
  }
  const metadata = {
    id: sessionId, protocol_version: PROTOCOL_VERSION, device_id: deviceId, hash,
    session_id: sessionId, credential_version: activated.credential_version,
    superseded: false, ready: false, event_ready: false, command_ready: false,
    // Older devices can override the advertised interval locally without reporting it.
    heartbeat_seconds: 300, connected_at: new Date().toISOString(),
    usable_slots: null, quarantined_slots: null,
  };
  server.serializeAttachment(metadata);
  try {
    await state.storage.put("presence-device-id", deviceId).catch(() => {});
    await connectionStatus(state, env, server, metadata, true).catch(() => {});
    await schedulePresenceAlarm(state).catch(() => {});
    await authenticatedSocket(state, env, server, metadata);
    send(server, {
      type: "hello", protocol_version: PROTOCOL_VERSION, device_id: deviceId,
      session_id: sessionId, reconciled: true,
      heartbeat_seconds: serverHeartbeatSeconds(env),
      server_time: Math.floor(Date.now() / 1000),
    });
    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    supersede(server, "authentication failed");
    throw error;
  }
}

export async function connectDevice(request, env) {
  requireRealtime(env);
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "请使用 WebSocket 连接");
  }
  const token = deviceBearer(request);
  if (!token) throw new HttpError(401, "设备令牌无效");
  const url = new URL(request.url);
  const result = await enrollIdentity(request, env, {
    identity_type: request.headers.get("X-Relay-Identity-Type"),
    identity_value: request.headers.get("X-Relay-Identity-Value"),
  }, { token, deviceId: url.searchParams.has("device_id") ? url.searchParams.get("device_id") : undefined });
  if (result.response) return result.response;
  return env.DEVICE_SESSION.get(env.DEVICE_SESSION.idFromName(result.id)).fetch("https://session.internal/ws", {
    method: "GET",
    headers: { Upgrade: "websocket", "X-Relay-Device": result.id, "X-Relay-Credential": result.hash },
  });
}

export async function pushQueuedCommand(state, env, deviceId) {
  requireRealtime(env);
  for (const socket of peers(state)) {
    const metadata = attachment(socket);
    if (!metadata?.command_ready || metadata.superseded || metadata.device_id !== deviceId) continue;
    try {
      const before = await authenticatedSocket(state, env, socket, metadata);
      if (!before.metadata.command_ready) return { ok: true, connected: true };
      const command = await nextSmsCommand(env, deviceId, metadata.hash, metadata.session_id);
      // Both the attachment and D1 hash/version/session are checked after every
      // awaited claim, so replacement/rebind races cannot send on an old socket.
      const after = await authenticatedSocket(state, env, socket, metadata);
      if (!after.metadata.command_ready) return { ok: true, connected: true };
      if (command) {
        if (command.session_id !== metadata.session_id) throw new HttpError(503, "发送命令与连接会话不匹配");
        assertCurrentSocket(state, socket, metadata);
        send(socket, { type: "command", command });
      }
      return { ok: true, connected: true };
    } catch (error) {
      if (error instanceof SupersededSocketError || error instanceof HttpError && [401, 403].includes(error.status)) {
        supersede(socket, "authentication failed");
        await connectionStatus(state, env, socket, metadata, false).catch(() => {});
        continue;
      }
      throw error;
    }
  }
  return { ok: true, connected: false };
}

export async function refreshDevicePresence(env, devices) {
  if (!env.DEVICE_SESSION || !Array.isArray(devices)) return devices;
  return Promise.all(devices.map(async (device) => {
    if (device?.connection?.state !== "online" || typeof device.id !== "string") return device;
    try {
      const response = await env.DEVICE_SESSION.get(env.DEVICE_SESSION.idFromName(device.id)).fetch("https://session.internal/", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "presence", device_id: device.id }),
      });
      if (!response.ok) throw new Error("Device presence check failed");
      const result = await response.json();
      if (result?.ok !== true || !isRecord(result.connection)) throw new Error("Device presence response invalid");
      return { ...device, connection: result.connection };
    } catch {
      return { ...device, connection: { ...device.connection, state: "unknown", ready: false,
        event_ready: false, command_ready: false } };
    }
  }));
}

export async function notifyDeviceCommands(env, deviceId) {
  if (!env.DEVICE_SESSION || !env.DB) return;
  try {
    await env.DEVICE_SESSION.get(env.DEVICE_SESSION.idFromName(deviceId)).fetch("https://session.internal/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "nudge", device_id: deviceId }),
    });
  } catch {
    // D1 remains the durable source; reconnecting devices receive the command later.
  }
}

export async function closeDeviceConnection(env, deviceId) {
  // Registry mutations already invalidate work atomically. A delayed callback
  // must not cancel commands queued/claimed by a subsequently activated owner.
  if (!env.DEVICE_SESSION) return;
  try {
    await env.DEVICE_SESSION.get(env.DEVICE_SESSION.idFromName(deviceId)).fetch("https://session.internal/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disconnect", device_id: deviceId }),
    });
  } catch {}
}

export async function disconnectDeviceSockets(state, env) {
  for (const socket of peers(state)) {
    const metadata = attachment(socket);
    if (metadata) {
      try {
        // A late revocation nudge may arrive after re-enable/rebind and a fresh
        // activation. Preserve any socket still authenticated by current D1.
        await authenticatedSocket(state, env, socket, metadata);
        continue;
      } catch (error) {
        if (!(error instanceof SupersededSocketError) && !(error instanceof HttpError && [401, 403].includes(error.status))) throw error;
      }
    }
    supersede(socket, "device permissions changed");
    if (metadata) await connectionStatus(state, env, socket, metadata, false);
  }
  return jsonResponse({ ok: true });
}

function readyAnnouncement(input, metadata) {
  if (input.session_id !== metadata.session_id) throw new HttpError(409, "就绪消息与当前连接会话不匹配");
  if (input.heartbeat_seconds !== undefined && (!Number.isInteger(input.heartbeat_seconds)
    || input.heartbeat_seconds < 60 || input.heartbeat_seconds > 300)) throw new HttpError(400, "心跳周期须为 60–300 秒");
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 32
    || input.capabilities.some((value) => typeof value !== "string" || value.length === 0 || value.length > 80)) {
    throw new HttpError(400, "设备能力须为文字列表");
  }
  if (!isRecord(input.journal) || ![input.journal.usable_slots, input.journal.quarantined_slots]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new HttpError(400, "命令日志须提供可用与隔离槽位数");
  }
  return {
    capabilities: [...new Set(input.capabilities)], event_ready: true,
    heartbeat_seconds: input.heartbeat_seconds ?? metadata.heartbeat_seconds ?? 60,
    ready: input.capabilities.includes("sms.send") && input.journal.usable_slots > 0,
    command_ready: input.capabilities.includes("sms.send") && input.journal.usable_slots > 0,
    usable_slots: input.journal.usable_slots, quarantined_slots: input.journal.quarantined_slots,
  };
}

export async function handleDeviceMessage(state, env, socket, message) {
  if (message === "p") {
    const metadata = attachment(socket);
    if (currentSocket(state, socket, metadata)) {
      socket.serializeAttachment({ ...metadata, lastHeartbeatAt: Date.now() });
      socket.send("q");
    }
    return;
  }
  let input;
  let metadata;
  try {
    if (typeof message !== "string" || utf8.encode(message).byteLength > MAX_MESSAGE_BYTES) throw new HttpError(413, "连接消息过长");
    try { input = JSON.parse(message); } catch { throw new HttpError(400, "连接消息须为有效 JSON"); }
    if (!isRecord(input)) throw new HttpError(400, "连接消息须为 JSON 对象");
    metadata = attachment(socket);
    if (!metadata) throw new HttpError(401, "连接会话无效");
    const { device } = await authenticatedSocket(state, env, socket, metadata);
    if (input.type === "ready") {
      const ready = readyAnnouncement(input, metadata);
      const current = assertCurrentSocket(state, socket, metadata);
      socket.serializeAttachment({ ...current, ...ready, lastHeartbeatAt: Date.now() });
      await connectionStatus(state, env, socket, metadata, true);
      if (ready.command_ready) await pushQueuedCommand(state, env, device.id);
      return;
    }
    if (input.type === "event") {
      if (!isRecord(input.event)) throw new HttpError(400, "事件须为 JSON 对象");
      if (typeof input.recovered !== "boolean") throw new HttpError(400, "恢复标识须为布尔值");
      const accepted = await acceptIncoming(env, input.event, device, { recovered: input.recovered });
      await authenticatedSocket(state, env, socket, metadata);
      send(socket, { type: "event_ack", ok: true, accepted: true, event_id: accepted.item.event_id });
      const tasks = [statusUpdate(state, () => updateDeviceStatus(dataStore(env), accepted.item))];
      if (accepted.dispatch) tasks.push(dispatchEvent(env, accepted.item));
      state.waitUntil(Promise.allSettled(tasks));
      return;
    }
    if (input.type === "command_result") {
      // A known result can name a command from an older session. Authentication
      // belongs to this current socket, not the command's historical session_id.
      await recordSmsResult(env, device.id, input);
      await authenticatedSocket(state, env, socket, metadata);
      send(socket, { type: "command_result_ack", ok: true, accepted: true, command_id: input.command_id });
      await pushQueuedCommand(state, env, device.id);
      return;
    }
    throw new HttpError(400, "连接消息类型无效");
  } catch (error) {
    if (error instanceof SupersededSocketError || metadata && !currentSocket(state, socket, metadata)) {
      supersede(socket);
      return;
    }
    const status = error instanceof HttpError ? error.status : 503;
    try {
      send(socket, {
        type: "error", ok: false, code: status,
        error: error instanceof HttpError ? error.message : "服务暂不可用，请稍后重试",
        ...(typeof input?.event?.event_id === "string" ? { event_id: input.event.event_id } : {}),
        ...(typeof input?.command_id === "string" ? { command_id: input.command_id } : {}),
      });
    } catch {}
    if (status === 401 || status === 403) supersede(socket, "authentication failed");
  }
}

export async function handleDeviceClose(state, env, socket) {
  const metadata = attachment(socket);
  if (metadata) await connectionStatus(state, env, socket, metadata, false).catch(() => {});
}
