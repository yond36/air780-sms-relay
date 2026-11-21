import { d1Session, decodeCursor, encodeCursor, pageLimit } from "./db.js";
import { digest } from "./security.js";
import { deviceIdentifier, HttpError, keys, object, text } from "./store.js";
import { cleanupExpiredHistory, eventReceipt, fallbackSmsDays } from "./retention.js";

const ACTIVE_LIMIT = 16;
const MAINTENANCE_LIMIT = 200;
const statuses = new Set(["received", "queued", "dispatched", "submitted", "failed", "unknown", "expired", "cancelled"]);
const resultStatuses = new Set(["submitted", "failed", "unknown"]);
const sessionIdPattern = /^[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const gsmBasic = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const gsmExtended = new Set(Array.from("\f^{}\\[~]|€"));

function numberOption(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export const smsRetentionDays = (env) => {
  const days = fallbackSmsDays(env.SMS_RETENTION_DAYS);
  return days === 0 ? null : days;
};

// Read policy inside the write transaction. NULL in an existing row is permanent;
// only an absent policy row may use the environment/default fallback.
const smsPolicyDaysSql = `CASE WHEN EXISTS (SELECT 1 FROM history_retention_policy WHERE id = 1)
  THEN (SELECT sms_days FROM history_retention_policy WHERE id = 1) ELSE ? END`;

function smsId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_~.-]{0,127}$/.test(value)) throw new HttpError(400, "短信标识无效");
  return value;
}

function phoneNumber(value) {
  const phone = text(value, "收件号码", { required: true, max: 21 });
  if (!/^\+?\d{3,20}$/.test(phone)) throw new HttpError(400, "收件号码须为 3–20 位数字，可保留开头的国际区号 +");
  return phone;
}

function smsContent(value) {
  const content = text(value, "短信正文", { required: true, max: 500, trim: false });
  if (!content.trim()) throw new HttpError(400, "请填写短信正文");
  if (/[\uD800-\uDFFF]/.test(content)) throw new HttpError(400, "当前设备固件仅支持 BMP 字符，短信不能包含 emoji 等非 BMP 字符");
  if (content.includes("\0")) throw new HttpError(400, "短信正文不能包含空字符");
  return content;
}

export function estimateSmsSegments(content) {
  let units = 0;
  for (const char of content) {
    if (gsmBasic.has(char)) units++;
    else if (gsmExtended.has(char)) units += 2;
    else return { encoding: "ucs2", segments: content.length <= 70 ? 1 : Math.ceil(content.length / 67) };
  }
  return { encoding: "gsm7", segments: units <= 160 ? 1 : Math.ceil(units / 153) };
}

async function commandDigest(to, content) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${to}\n${content}`)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function itemFromRow(row) {
  const item = {
    id: row.id,
    device_id: row.device_id,
    device_name: row.device_name,
    direction: row.direction,
    peer: row.peer,
    content: row.content,
    occurred_at: row.occurred_at,
    received_at: row.received_at,
    send_status: row.send_status,
    expires_at: row.expires_at,
  };
  for (const key of ["event_id", "command_id", "sim_slot", "sms_time", "reply_to", "command_expires_at"]) {
    if (row[key] !== null && row[key] !== undefined) item[key] = row[key];
  }
  return item;
}

function wireCommand(row) {
  const command = { id: row.id, op: "sms.send", device_id: row.device_id, to: row.peer, content: row.content, expires_at: row.expires_at, digest: row.command_digest };
  if (row.dispatch_session !== null && row.dispatch_session !== undefined) command.session_id = row.dispatch_session;
  return command;
}

function sessionOwnership(deviceId, hash, credentialVersion, sessionId) {
  return {
    sql: `EXISTS (SELECT 1 FROM device_registry d WHERE d.id = ? AND d.enabled = 1 AND d.deleted = 0
      AND d.token_hash = ? AND d.credential_version = ? AND d.command_session = ?)`,
    params: [deviceId, hash, credentialVersion, sessionId],
  };
}

function requireSessionCredential(registry, hash) {
  if (!registry || registry.deleted === 1 || registry.enabled !== 1) throw new HttpError(403, "设备已停用或不存在");
  if (!registry.token_hash || registry.token_hash !== hash) throw new HttpError(401, "设备令牌无效");
}

function queueResponse(command, message, now) {
  if (!message || (message.expires_at !== null && message.expires_at <= now) || command.purged_at !== null) throw new HttpError(410, "该短信已过保留期，请使用新的请求标识");
  return { item: { ...itemFromRow(message), command_expires_at: command.expires_at }, command: { ...wireCommand(command), segments: command.segments, encoding: command.encoding } };
}

function maintenance(session, now, deviceId, limit = MAINTENANCE_LIMIT, { messageId, owner } = {}) {
  const iso = new Date(now * 1000).toISOString();
  const scope = `${deviceId ? "AND device_id = ?" : ""} ${messageId ? "AND id IN (SELECT command_id FROM sms_messages WHERE id = ?)" : ""}`;
  const scopeParams = [...(deviceId ? [deviceId] : []), ...(messageId ? [messageId] : [])];
  const ownerSql = owner ? `AND ${owner.sql}` : "";
  const ownerParams = owner?.params || [];
  return [
    session.prepare(`
      UPDATE sms_commands SET
        status = CASE WHEN status = 'queued' THEN 'expired' ELSE 'unknown' END,
        result_at = COALESCE(result_at, ?),
        error = CASE WHEN status = 'queued' THEN '发送命令已过有效期' ELSE '发送命令已过有效期，提交状态未知' END
      WHERE id IN (SELECT id FROM sms_commands WHERE status IN ('queued', 'dispatched')
        AND expires_at <= ? ${scope} ${ownerSql} ORDER BY expires_at, id LIMIT ?)
    `).bind(iso, now, ...scopeParams, ...ownerParams, limit),
    session.prepare(`
      UPDATE sms_commands SET
        status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'unknown' END,
        result_at = COALESCE(result_at, ?), error = '设备已停用、删除或凭据已变更'
      WHERE id IN (SELECT id FROM sms_commands WHERE status IN ('queued', 'dispatched') ${scope} ${ownerSql}
        AND NOT EXISTS (SELECT 1 FROM device_registry d WHERE d.id = sms_commands.device_id
          AND d.enabled = 1 AND d.deleted = 0 AND d.token_hash = sms_commands.credential_hash
          AND d.credential_version = sms_commands.credential_version)
        ORDER BY created_at, id LIMIT ?)
    `).bind(iso, ...scopeParams, ...ownerParams, limit),
    syncMessages(session, deviceId, limit, { messageId, owner }),
  ];
}

function syncMessages(session, deviceId, limit = MAINTENANCE_LIMIT, { messageId, owner } = {}) {
  return session.prepare(`
    UPDATE sms_messages SET send_status = (SELECT status FROM sms_commands WHERE id = sms_messages.command_id)
    WHERE id IN (SELECT m.id FROM sms_messages m JOIN sms_commands c ON c.id = m.command_id
      WHERE m.send_status <> c.status ${deviceId ? "AND c.device_id = ?" : ""}
        ${messageId ? "AND m.id = ?" : ""} ${owner ? `AND ${owner.sql}` : ""} ORDER BY m.id LIMIT ?)
  `).bind(...(deviceId ? [deviceId] : []), ...(messageId ? [messageId] : []), ...(owner?.params || []), limit);
}

export async function archiveSms(env, event) {
  if (event?.type !== "sms.received" || event.cleared || event.suppressed) return null;
  deviceIdentifier(event.device_id);
  if (typeof event.event_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(event.event_id)) throw new HttpError(400, "事件标识无效");
  const session = d1Session(env);
  const now = Math.floor(Date.now() / 1000);
  const id = `in~${await digest(`${event.device_id}:${event.event_id}`)}`;
  const parentReceipt = await eventReceipt(event.device_id, event.event_id);
  const fallbackDays = smsRetentionDays(env);
  const historyExpiry = `CAST(unixepoch(json_extract(value, '$.received_at')) AS INTEGER) + 86400 * (${smsPolicyDaysSql})`;
  // Receipt and archive are committed together. The receipt is independent of
  // both the event TTL and the SMS TTL, and never stores sender/body/identity.
  const results = await session.batch([
    session.prepare(`INSERT INTO history_receipts (scope, receipt, fingerprint, cleared)
      SELECT 'sms', ?, '', CASE WHEN expires_at <= ? THEN 1 ELSE 0 END FROM sms_messages
      WHERE device_id = ? AND event_id = ? AND direction = 'incoming'
      ON CONFLICT(scope, receipt) DO NOTHING`).bind(id, now, event.device_id, event.event_id),
    session.prepare(`
      INSERT INTO sms_messages (id, device_id, device_name, event_id, command_id, direction,
        peer, content, occurred_at, received_at, sim_slot, sms_time, send_status, reply_to, expires_at, retention_revision)
      SELECT ?, json_extract(value, '$.device_id'), COALESCE(json_extract(value, '$.device_name'), json_extract(value, '$.device_id')),
        json_extract(value, '$.event_id'), NULL, 'incoming', COALESCE(json_extract(value, '$.data.sender'), ''),
        json_extract(value, '$.data.content'), COALESCE(json_extract(value, '$.occurred_at'), json_extract(value, '$.received_at')),
        json_extract(value, '$.received_at'), json_extract(value, '$.data.sim_slot'), json_extract(value, '$.data.sms_time'),
        'received', NULL, ${historyExpiry}, COALESCE((SELECT revision FROM history_retention_policy WHERE id = 1), 0)
      FROM relay_records WHERE key = ? AND json_valid(value) AND json_extract(value, '$.type') = 'sms.received'
        AND json_type(value, '$.data.content') = 'text' AND json_type(value, '$.received_at') = 'text'
        AND unixepoch(json_extract(value, '$.received_at')) IS NOT NULL
        AND (expires_at IS NULL OR expires_at > ?) AND (${historyExpiry} IS NULL OR ${historyExpiry} > ?)
        AND NOT EXISTS (SELECT 1 FROM history_receipts WHERE scope = 'sms' AND receipt = ?)
      ON CONFLICT DO NOTHING
    `).bind(id, fallbackDays, keys.event(event.device_id, event.event_id), now, fallbackDays, fallbackDays, now, id),
    session.prepare(`INSERT INTO history_receipts (scope, receipt, fingerprint, cleared)
      SELECT 'sms', ?, '', CASE WHEN expires_at <= ? THEN 1 ELSE 0 END FROM sms_messages WHERE id = ?
      ON CONFLICT(scope, receipt) DO NOTHING`).bind(id, now, id),
    session.prepare("SELECT * FROM sms_messages WHERE device_id = ? AND event_id = ? AND direction = 'incoming' AND (expires_at IS NULL OR expires_at > ?)")
      .bind(event.device_id, event.event_id, now),
    session.prepare("SELECT receipt FROM history_receipts WHERE (scope = 'sms' AND receipt = ?) OR (scope = 'events' AND receipt = ?)").bind(id, parentReceipt),
  ]);
  const row = results[3].results[0];
  if (row) return itemFromRow(row);
  if (results[4].results.length) return null; // Already cleared/expired: ACK, never recreate or 409.
  throw new HttpError(409, "短信事件尚未完整保存或已过保留期");
}

function filterTime(value, label) {
  if (!value) return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new HttpError(400, `${label}须为带时区的 ISO 时间`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new HttpError(400, `${label}无效`);
  return new Date(time).toISOString();
}

export async function listSms(env, searchParams) {
  if (!searchParams || typeof searchParams.get !== "function") throw new HttpError(400, "短信查询参数无效");
  const device = searchParams.get("device_id") || "";
  if (device) deviceIdentifier(device);
  const q = text(searchParams.get("q"), "搜索关键词", { max: 500, trim: false });
  const peer = text(searchParams.get("peer"), "对端号码", { max: 80, trim: false });
  const direction = searchParams.get("direction") || "";
  if (direction && direction !== "incoming" && direction !== "outgoing") throw new HttpError(400, "短信方向无效");
  const status = searchParams.get("status") || "";
  if (status && !statuses.has(status)) throw new HttpError(400, "短信状态无效");
  const from = filterTime(searchParams.get("from"), "开始时间");
  const to = filterTime(searchParams.get("to"), "结束时间");
  if (from && to && from >= to) throw new HttpError(400, "结束时间须晚于开始时间");
  const limit = pageLimit(searchParams.get("limit"));
  const filters = { device, q, peer, direction, status, from, to };
  const now = Math.floor(Date.now() / 1000);
  const where = ["(expires_at IS NULL OR expires_at > ?)"];
  const params = [now];
  if (device) { where.push("device_id = ?"); params.push(device); }
  if (q) { where.push("(instr(lower(content), lower(?)) > 0 OR instr(lower(peer), lower(?)) > 0)"); params.push(q, q); }
  if (peer) { where.push("instr(peer, ?) > 0"); params.push(peer); }
  if (direction) { where.push("direction = ?"); params.push(direction); }
  if (status) { where.push("send_status = ?"); params.push(status); }
  if (from) { where.push("occurred_at >= ?"); params.push(from); }
  if (to) { where.push("occurred_at < ?"); params.push(to); }
  const cursor = searchParams.get("cursor");
  if (cursor) {
    const value = decodeCursor(cursor, "sms");
    if (JSON.stringify(value.filters) !== JSON.stringify(filters) || typeof value.time !== "string" || typeof value.id !== "string") {
      throw new HttpError(400, "分页标识与查询不匹配");
    }
    smsId(value.id);
    where.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
    params.push(value.time, value.time, value.id);
  }
  const session = d1Session(env);
  // Bounded read-time maintenance keeps command TTL visible without relying on Cron.
  const results = await session.batch([
    ...maintenance(session, now, device || undefined),
    session.prepare(`SELECT sms_messages.*, (SELECT expires_at FROM sms_commands WHERE id = sms_messages.command_id) AS command_expires_at FROM sms_messages WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
      .bind(...params, limit + 1),
  ]);
  const result = results.at(-1);
  const rows = result.results.slice(0, limit);
  return {
    items: rows.map(itemFromRow),
    cursor: result.results.length <= limit ? null : encodeCursor({ kind: "sms", filters, time: rows.at(-1).occurred_at, id: rows.at(-1).id }),
  };
}

export async function getSms(env, id) {
  smsId(id);
  const session = d1Session(env);
  const now = Math.floor(Date.now() / 1000);
  // Target this record so an unrelated maintenance backlog cannot hide its expiry.
  const results = await session.batch([
    ...maintenance(session, now, undefined, 1, { messageId: id }),
    session.prepare("SELECT sms_messages.*, (SELECT expires_at FROM sms_commands WHERE id = sms_messages.command_id) AS command_expires_at FROM sms_messages WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)")
      .bind(id, now),
  ]);
  const row = results.at(-1).results[0];
  if (!row) throw new HttpError(404, "短信不存在或已过保留期");
  return itemFromRow(row);
}

export async function queueSms(env, input, replyId) {
  object(input);
  if (typeof input.request_id !== "string" || !uuid.test(input.request_id)) throw new HttpError(400, "请求标识须为 UUID");
  const requestId = input.request_id.toLowerCase();
  const content = smsContent(input.content);
  const reply = replyId === undefined || replyId === null ? null : smsId(replyId);
  let deviceId = reply ? null : deviceIdentifier(input.device_id);
  let to = reply ? null : phoneNumber(input.to);
  // Reply routing is determined by its saved incoming record; spoofed device/to are ignored.
  const fingerprint = await digest(JSON.stringify(reply ? ["reply", reply, content] : ["send", deviceId, to, content]));
  const session = d1Session(env);
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const iso = new Date(nowMs).toISOString();
  const existing = await session.prepare("SELECT * FROM sms_commands WHERE request_id = ?").bind(requestId).first();
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) throw new HttpError(409, "该请求标识已用于不同的短信内容");
    if (existing.purged_at !== null) throw new HttpError(410, "该短信已过保留期，请使用新的请求标识");
    const statements = maintenance(session, now, existing.device_id);
    const results = await session.batch([
      ...statements,
      session.prepare("SELECT * FROM sms_commands WHERE request_id = ?").bind(requestId),
      session.prepare("SELECT * FROM sms_messages WHERE command_id = ?").bind(existing.id),
    ]);
    return queueResponse(results[statements.length].results[0], results[statements.length + 1].results[0], now);
  }
  if (reply) {
    const original = await getSms(env, reply);
    if (original.direction !== "incoming") throw new HttpError(400, "仅可回复收到的短信");
    deviceId = original.device_id;
    to = phoneNumber(original.peer);
  }
  const registry = await session.prepare("SELECT * FROM device_registry WHERE id = ?").bind(deviceId).first();
  if (!registry || registry.deleted === 1) throw new HttpError(404, "设备不存在或已删除");
  if (registry.enabled !== 1) throw new HttpError(403, "设备已停用，不能发送短信");
  if (!registry.token_hash) throw new HttpError(409, "设备凭据尚未绑定，不能发送短信");
  const minuteLimit = numberOption(env.SMS_RATE_LIMIT_PER_MINUTE, 10, 1, 30);
  const hourLimit = numberOption(env.SMS_RATE_LIMIT_PER_HOUR, 60, 1, 300);
  const minuteStart = new Date(nowMs - 60_000).toISOString();
  const hourStart = new Date(nowMs - 3_600_000).toISOString();
  const commandId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const estimate = estimateSmsSegments(content);
  const expiresAt = now + numberOption(env.SMS_COMMAND_TTL_SECONDS, 600, 60, 3600);
  const wireDigest = await commandDigest(to, content);
  const statements = maintenance(session, now, deviceId);
  const selectIndex = statements.length + 2;
  const results = await session.batch([
    ...statements,
    session.prepare(`
      INSERT INTO sms_commands (id, request_id, request_fingerprint, message_id, device_id, device_name,
        credential_hash, credential_version, peer, content, command_digest, reply_to, encoding, segments,
        status, created_at, expires_at, retention_expires_at, retention_revision)
      SELECT ?, ?, ?, ?, d.id, COALESCE(json_extract(d.device_json, '$.name'), d.id), d.token_hash, d.credential_version,
        ?, ?, ?, ?, ?, ?, 'queued', ?, ?,
        ? + 86400 * (${smsPolicyDaysSql}),
        COALESCE((SELECT revision FROM history_retention_policy WHERE id = 1), 0)
      FROM device_registry d WHERE d.id = ? AND d.deleted = 0 AND d.enabled = 1 AND d.token_hash IS NOT NULL
        AND d.token_hash = ? AND d.credential_version = ?
        AND (SELECT COUNT(*) FROM sms_commands WHERE device_id = d.id AND status IN ('queued', 'dispatched')) < ${ACTIVE_LIMIT}
        AND (SELECT COUNT(*) FROM sms_commands WHERE device_id = d.id AND created_at >= ?) < ?
        AND (SELECT COUNT(*) FROM sms_commands WHERE device_id = d.id AND created_at >= ?) < ?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM sms_messages WHERE id = ? AND direction = 'incoming' AND (expires_at IS NULL OR expires_at > ?)))
      ON CONFLICT(request_id) DO NOTHING
    `).bind(commandId, requestId, fingerprint, messageId, to, content, wireDigest, reply, estimate.encoding, estimate.segments,
      iso, expiresAt, now, smsRetentionDays(env), deviceId, registry.token_hash, registry.credential_version, minuteStart, minuteLimit,
      hourStart, hourLimit, reply, reply, now),
    session.prepare(`
      INSERT INTO sms_messages (id, device_id, device_name, event_id, command_id, direction,
        peer, content, occurred_at, received_at, sim_slot, sms_time, send_status, reply_to, expires_at, retention_revision)
      SELECT message_id, device_id, device_name, NULL, id, 'outgoing', peer, content, created_at, created_at,
        NULL, NULL, status, reply_to, retention_expires_at, retention_revision FROM sms_commands
      WHERE request_id = ? AND request_fingerprint = ? AND purged_at IS NULL AND (retention_expires_at IS NULL OR retention_expires_at > ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(requestId, fingerprint, now),
    session.prepare("SELECT * FROM sms_commands WHERE request_id = ?").bind(requestId),
    session.prepare("SELECT * FROM sms_messages WHERE command_id = (SELECT id FROM sms_commands WHERE request_id = ?)").bind(requestId),
    session.prepare("SELECT * FROM device_registry WHERE id = ?").bind(deviceId),
    session.prepare(`
      SELECT SUM(CASE WHEN status IN ('queued', 'dispatched') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS minute,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS hour
      FROM sms_commands WHERE device_id = ?
    `).bind(minuteStart, hourStart, deviceId),
    session.prepare("SELECT id FROM sms_messages WHERE id = ? AND direction = 'incoming' AND (expires_at IS NULL OR expires_at > ?)").bind(reply, now),
  ]);
  const command = results[selectIndex].results[0];
  if (command) {
    if (command.request_fingerprint !== fingerprint) throw new HttpError(409, "该请求标识已用于不同的短信内容");
    return queueResponse(command, results[selectIndex + 1].results[0], now);
  }
  const current = results[selectIndex + 2].results[0];
  if (!current || current.deleted === 1) throw new HttpError(404, "设备不存在或已删除");
  if (current.enabled !== 1) throw new HttpError(403, "设备已停用，不能发送短信");
  if (!current.token_hash) throw new HttpError(409, "设备凭据尚未绑定，不能发送短信");
  if (current.token_hash !== registry.token_hash || current.credential_version !== registry.credential_version) throw new HttpError(409, "设备凭据已变更，请重新确认发送");
  if (reply && !results[selectIndex + 4].results.length) throw new HttpError(404, "原短信不存在或已过保留期");
  const counts = results[selectIndex + 3].results[0];
  if (counts.active >= ACTIVE_LIMIT) throw new HttpError(429, "该设备已有 16 条在途短信，请等待结果");
  throw new HttpError(429, "短信发送过于频繁，请稍后重试");
}

// A fresh WSS ID must win this transaction before hello/101 is sent. Credentials
// and queued work are not rotated; only dispatches owned by an older session retire.
export async function activateSmsSession(env, deviceId, hash, sessionId) {
  deviceIdentifier(deviceId);
  if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) throw new HttpError(400, "连接会话标识无效");
  if (typeof hash !== "string" || !hash || hash.length > 128) throw new HttpError(401, "设备令牌无效");
  const session = d1Session(env);
  const registry = await session.prepare("SELECT * FROM device_registry WHERE id = ?").bind(deviceId).first();
  requireSessionCredential(registry, hash);
  const owner = sessionOwnership(deviceId, hash, registry.credential_version, sessionId);
  const iso = new Date().toISOString();
  const results = await session.batch([
    session.prepare(`
      UPDATE device_registry SET command_session = ?
      WHERE id = ? AND enabled = 1 AND deleted = 0 AND token_hash = ? AND credential_version = ?
        AND (command_session IS ? OR command_session = ?)
      RETURNING command_session, credential_version
    `).bind(sessionId, deviceId, hash, registry.credential_version, registry.command_session, sessionId),
    // Do not limit retirement: every previous dispatch, including a NULL legacy
    // owner, is unsafe to resend. The full guard implies the activation above won.
    session.prepare(`
      UPDATE sms_commands SET status = 'unknown', result_at = COALESCE(result_at, ?),
        error = '连接会话已更换，提交状态未知'
      WHERE device_id = ? AND status = 'dispatched' AND dispatch_session IS NOT ? AND ${owner.sql}
    `).bind(iso, deviceId, sessionId, ...owner.params),
    session.prepare(`
      UPDATE sms_messages SET send_status = 'unknown'
      WHERE send_status IN ('queued', 'dispatched') AND command_id IN
        (SELECT id FROM sms_commands WHERE device_id = ? AND status = 'unknown' AND dispatch_session IS NOT ?)
        AND ${owner.sql}
    `).bind(deviceId, sessionId, ...owner.params),
    session.prepare("SELECT * FROM device_registry WHERE id = ?").bind(deviceId),
  ]);
  const activated = results[0].results[0];
  if (!activated) {
    requireSessionCredential(results.at(-1).results[0], hash);
    throw new HttpError(409, "设备凭据或连接会话已变更，请重新连接");
  }
  return { session_id: activated.command_session, credential_version: activated.credential_version, retired: Number(results[1].meta?.changes || 0) };
}

export async function nextSmsCommand(env, deviceId, hash, sessionId) {
  deviceIdentifier(deviceId);
  // No three-argument fallback: an authenticated credential alone is not an owner.
  if (typeof hash !== "string" || !hash || hash.length > 128 || typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) return null;
  const session = d1Session(env);
  const registry = await session.prepare("SELECT * FROM device_registry WHERE id = ?").bind(deviceId).first();
  if (!registry || registry.enabled !== 1 || registry.deleted === 1 || registry.token_hash !== hash || registry.command_session !== sessionId) return null;
  const owner = sessionOwnership(deviceId, hash, registry.credential_version, sessionId);
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const iso = new Date(nowMs).toISOString();
  const results = await session.batch([
    ...maintenance(session, now, deviceId, MAINTENANCE_LIMIT, { owner }),
    session.prepare(`
      UPDATE sms_commands SET status = 'dispatched', dispatched_at = ?, dispatch_session = ?
      WHERE id = (SELECT c.id FROM sms_commands c JOIN device_registry d ON d.id = c.device_id
        WHERE c.device_id = ? AND c.status = 'queued' AND c.expires_at > ? AND c.purged_at IS NULL
          AND d.enabled = 1 AND d.deleted = 0 AND d.token_hash = ? AND d.credential_version = ? AND d.command_session = ?
          AND c.credential_hash = d.token_hash AND c.credential_version = d.credential_version
        ORDER BY c.created_at, c.id LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM sms_commands WHERE device_id = ? AND status = 'dispatched')
        AND ${owner.sql}
    `).bind(iso, sessionId, deviceId, now, hash, registry.credential_version, sessionId, deviceId, ...owner.params),
    syncMessages(session, deviceId, MAINTENANCE_LIMIT, { owner }),
    session.prepare(`
      SELECT c.* FROM sms_commands c JOIN device_registry d ON d.id = c.device_id
      WHERE c.device_id = ? AND c.status = 'dispatched' AND c.expires_at > ? AND c.purged_at IS NULL
        AND d.enabled = 1 AND d.deleted = 0 AND d.token_hash = ? AND d.credential_version = ? AND d.command_session = ?
        AND c.credential_hash = d.token_hash AND c.credential_version = d.credential_version AND c.dispatch_session = ?
      ORDER BY c.created_at, c.id LIMIT 1
    `).bind(deviceId, now, hash, registry.credential_version, sessionId, sessionId),
  ]);
  const command = results.at(-1).results[0];
  return command ? wireCommand(command) : null;
}

export async function recordSmsResult(env, deviceId, input) {
  deviceIdentifier(deviceId);
  object(input);
  if (typeof input.command_id !== "string" || !uuid.test(input.command_id)) throw new HttpError(400, "发送命令标识无效");
  if (!resultStatuses.has(input.status)) throw new HttpError(400, "短信结果须为 submitted、failed 或 unknown");
  const error = input.error === undefined || input.error === null ? null : text(input.error, "发送错误", { max: 512, trim: false });
  const session = d1Session(env);
  const now = Math.floor(Date.now() / 1000);
  const iso = new Date().toISOString();
  const id = input.command_id.toLowerCase();
  const results = await session.batch([
    session.prepare("SELECT * FROM sms_commands WHERE id = ? AND device_id = ? AND (retention_expires_at IS NULL OR retention_expires_at > ?) AND purged_at IS NULL").bind(id, deviceId, now),
    session.prepare(`
      UPDATE sms_commands SET
        status = CASE WHEN status = 'submitted' OR ? = 'submitted' THEN 'submitted'
          WHEN status = 'failed' AND ? = 'unknown' THEN 'failed' ELSE ? END,
        error = CASE WHEN status = 'submitted' OR ? = 'submitted' THEN NULL
          WHEN status = ? OR (status = 'failed' AND ? = 'unknown') THEN error ELSE ? END,
        result_at = CASE WHEN status = 'submitted' OR status = ? OR (status = 'failed' AND ? = 'unknown')
          THEN COALESCE(result_at, ?) ELSE ? END
      WHERE id = ? AND device_id = ? AND status IN ('dispatched', 'submitted', 'failed', 'unknown')
        AND (retention_expires_at IS NULL OR retention_expires_at > ?) AND purged_at IS NULL
    `).bind(input.status, input.status, input.status, input.status, input.status, input.status, error,
      input.status, input.status, iso, iso, id, deviceId, now),
    session.prepare(`
      UPDATE sms_messages SET send_status = (SELECT status FROM sms_commands WHERE id = ?)
      WHERE command_id = ? AND device_id = ?
    `).bind(id, id, deviceId),
  ]);
  const command = results[0].results[0];
  if (!command) throw new HttpError(404, "发送命令不存在或已过保留期");
  if (!["dispatched", "submitted", "failed", "unknown"].includes(command.status)) throw new HttpError(409, "该命令尚未下发或已取消、过期");
  return { ok: true };
}

export async function cancelDeviceSmsCommands(env, id) {
  deviceIdentifier(id);
  const session = d1Session(env);
  const iso = new Date().toISOString();
  const results = await session.batch([
    session.prepare("UPDATE sms_commands SET status = 'cancelled', result_at = COALESCE(result_at, ?), error = '设备已停用、删除或重新绑定' WHERE device_id = ? AND status = 'queued'").bind(iso, id),
    session.prepare("UPDATE sms_commands SET status = 'unknown', result_at = COALESCE(result_at, ?), error = '设备已停用、删除或重新绑定，提交状态未知' WHERE device_id = ? AND status = 'dispatched'").bind(iso, id),
    syncMessages(session, id),
  ]);
  return { cancelled: Number(results[0].meta?.changes || 0), unknown: Number(results[1].meta?.changes || 0) };
}

export async function expireSms(env) {
  const session = d1Session(env);
  const now = Math.floor(Date.now() / 1000);
  // Execution-TTL maintenance is unchanged. History cleanup itself never
  // cancels, expires, requeues, or purges an authoritative active command.
  const results = await session.batch(maintenance(session, now));
  const history = await cleanupExpiredHistory(env, "sms", MAINTENANCE_LIMIT);
  return {
    expired: Number(results[0].meta?.changes || 0),
    invalidated: Number(results[1].meta?.changes || 0),
    deleted: history.deleted,
    purged: history.purged || 0,
  };
}
