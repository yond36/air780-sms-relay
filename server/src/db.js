import { deviceIdentifier, HttpError, identifier, isAutomaticDeviceId, isRecord, keys, text } from "./store.js";
import { cleanupExpiredHistory, eventReceipt } from "./retention.js";

const stores = new WeakMap();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const changes = (result) => Number(result?.meta?.changes || 0);

export function dataStore(env) {
  if (env?.DATA) return env.DATA;
  const db = env?.DB;
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new HttpError(503, "Worker 尚未绑定 D1 数据库");
  }
  let store = stores.get(db);
  if (!store) {
    store = new D1Store(db);
    stores.set(db, store);
  }
  return store;
}

export function d1Session(env) {
  const store = dataStore(env);
  if (typeof store.session === "function") return store.session();
  const db = store.db || env.DB;
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new HttpError(503, "短信存储需要 D1 数据库");
  }
  return typeof db.withSession === "function" ? db.withSession("first-primary") : db;
}

export function encodeCursor(value) {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, ...value }));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor, kind) {
  if (typeof cursor !== "string" || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new HttpError(400, "分页标识无效");
  }
  try {
    const bytes = Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value) || value.v !== 1 || value.kind !== kind) throw new Error("cursor kind");
    return value;
  } catch {
    throw new HttpError(400, "分页标识无效");
  }
}

export function pageLimit(value, fallback = 30, maximum = 100) {
  const limit = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw new HttpError(400, `每页数量须为 1–${maximum}`);
  return limit;
}

function expiry(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, "保留期限须为 Unix 秒");
  return value;
}

function prefixEnd(prefix) {
  const chars = Array.from(prefix);
  for (let index = chars.length - 1; index >= 0; index--) {
    const point = chars[index].codePointAt(0);
    if (point < 0x10ffff) return chars.slice(0, index).join("") + String.fromCodePoint(point + 1);
  }
  return null;
}

function deviceRecord(row) {
  if (!row) return null;
  return {
    device: JSON.parse(row.device_json),
    hash: row.token_hash || null,
    revokedHash: row.revoked_hash || null,
    deleted: row.deleted === 1,
    credentialVersion: row.credential_version,
    commandSession: row.command_session || null,
  };
}

function hashText(hash, nullable = false) {
  if (nullable && (hash === undefined || hash === null || hash === "")) return null;
  if (typeof hash !== "string" || hash.length === 0 || hash.length > 128) throw new HttpError(400, "设备凭据摘要无效");
  return hash;
}

function projection(session, id, guard) {
  const deviceKey = keys.device(id);
  const tokenKey = keys.deviceToken(id);
  const condition = guard ? ` AND (${guard.sql})` : "";
  const params = guard?.params || [];
  return [
    session.prepare(`
      INSERT INTO relay_records (key, value, expires_at)
      SELECT ?, CASE WHEN json_extract(device_json, '$.enrollment') = 'automatic'
        THEN json_set(device_json, '$.enrollment_pending', json(CASE WHEN token_hash IS NULL THEN 'true' ELSE 'false' END))
        ELSE device_json END, NULL
      FROM device_registry WHERE id = ? AND deleted = 0 ${condition}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = NULL
    `).bind(deviceKey, id, ...params),
    session.prepare(`DELETE FROM relay_records WHERE key = ? AND EXISTS (SELECT 1 FROM device_registry WHERE id = ? AND deleted = 1) ${condition}`).bind(deviceKey, id, ...params),
    session.prepare(`
      INSERT INTO relay_records (key, value, expires_at)
      SELECT ?, json_object('hash', token_hash), NULL FROM device_registry
      WHERE id = ? AND deleted = 0 AND token_hash IS NOT NULL ${condition}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = NULL
    `).bind(tokenKey, id, ...params),
    session.prepare(`DELETE FROM relay_records WHERE key = ? AND EXISTS (SELECT 1 FROM device_registry WHERE id = ? AND (deleted = 1 OR token_hash IS NULL)) ${condition}`).bind(tokenKey, id, ...params),
    session.prepare(`DELETE FROM relay_records WHERE key = ? AND EXISTS (SELECT 1 FROM device_registry WHERE id = ? AND deleted = 1) ${condition}`).bind(keys.latest(id), id, ...params),
  ];
}

// Changes to a credential or enabled state invalidate queued work in the same transaction.
// A command already handed to a device is unknown, never falsely reported as cancelled.
function invalidateCommands(session, id, now, guard) {
  const condition = guard ? ` AND (${guard.sql})` : "";
  const params = guard?.params || [];
  return [
    session.prepare(`
      UPDATE sms_commands SET
        status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'unknown' END,
        result_at = COALESCE(result_at, ?),
        error = '设备已停用、删除或凭据已变更'
      WHERE device_id = ? AND status IN ('queued', 'dispatched')
        AND NOT EXISTS (SELECT 1 FROM device_registry d WHERE d.id = sms_commands.device_id
          AND d.deleted = 0 AND d.enabled = 1 AND d.token_hash = sms_commands.credential_hash
          AND d.credential_version = sms_commands.credential_version) ${condition}
    `).bind(now, id, ...params),
    session.prepare(`
      UPDATE sms_messages SET send_status = (SELECT status FROM sms_commands WHERE id = sms_messages.command_id)
      WHERE send_status IN ('queued', 'dispatched') AND command_id IN
        (SELECT id FROM sms_commands WHERE device_id = ? AND status IN ('cancelled', 'unknown')) ${condition}
    `).bind(id, ...params),
  ];
}

export class D1Store {
  isD1 = true;

  constructor(db) {
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") throw new HttpError(503, "Worker 尚未绑定 D1 数据库");
    this.db = db;
  }

  // Sessions are per operation, not a long-lived read-replica session cached across requests.
  session() {
    return typeof this.db.withSession === "function" ? this.db.withSession("first-primary") : this.db;
  }

  async get(name, type) {
    const session = this.session();
    const now = nowSeconds();
    const decode = (value) => value === null || value === undefined ? null : type === "json" ? JSON.parse(value) : value;
    if (!Array.isArray(name)) {
      if (typeof name !== "string") throw new TypeError("Record key must be a string");
      const row = await session.prepare("SELECT value FROM relay_records WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)").bind(name, now).first();
      return decode(row?.value);
    }
    if (name.some((key) => typeof key !== "string")) throw new TypeError("Record keys must be strings");
    const values = new Map(name.map((key) => [key, null]));
    const names = [...values.keys()];
    // D1 accepts at most 100 parameters; keep room for the expiration parameter.
    for (let start = 0; start < names.length; start += 90) {
      const page = names.slice(start, start + 90);
      const result = await session.prepare(`SELECT key, value FROM relay_records WHERE key IN (${page.map(() => "?").join(",")}) AND (expires_at IS NULL OR expires_at > ?)`).bind(...page, now).all();
      for (const row of result.results) values.set(row.key, decode(row.value));
    }
    return values;
  }

  async put(key, value, { expiration } = {}) {
    if (typeof key !== "string" || typeof value !== "string") throw new TypeError("Record key and value must be strings");
    const expiresAt = expiry(expiration);
    if (key.startsWith("devices:") || key.startsWith("device-tokens:")) {
      return this.putDeviceMirror(key, value, expiresAt);
    }
    if (/^(timeline|pending|deliveries|sent|delivery-leases):/.test(key)) return this.putEventChild(key, value);
    await this.session().prepare(`
      INSERT INTO relay_records (key, value, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
    `).bind(key, value, expiresAt).run();
  }

  async putEventChild(key, value) {
    let item;
    try { item = JSON.parse(value); } catch { throw new HttpError(400, "事件子记录须为 JSON"); }
    const parts = key.split(":");
    const timeline = parts[0] === "timeline";
    const device = timeline ? parts[2] : parts[1];
    const event = timeline ? parts[3] : parts[2];
    deviceIdentifier(device);
    identifier(event, "事件标识");
    if ((timeline && parts.length !== 4) || (!timeline && parts.length !== (parts[0] === "pending" ? 3 : 4))) throw new HttpError(400, "事件子记录标识无效");
    const parent = keys.event(device, event);
    if (timeline && item.eventKey !== parent) throw new HttpError(400, "事件索引与父记录不匹配");
    // Never restore a child after cleanup, and never use a stale caller's TTL.
    // The parent check and write are a single authoritative SQL statement.
    await this.session().prepare(`
      INSERT INTO relay_records (key, value, expires_at)
      SELECT ?, ?, p.expires_at FROM relay_records p WHERE p.key = ?
        AND (p.expires_at IS NULL OR p.expires_at > ?)
        ${timeline && item.received_at ? "AND json_extract(p.value, '$.received_at') = ?" : ""}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
    `).bind(key, value, parent, nowSeconds(), ...(timeline && item.received_at ? [item.received_at] : [])).run();
  }

  async putDeviceMirror(key, value, expiresAt) {
    let input;
    try { input = JSON.parse(value); } catch { throw new HttpError(400, "设备记录须为 JSON"); }
    if (!isRecord(input)) throw new HttpError(400, "设备记录须为 JSON 对象");
    const token = key.startsWith("device-tokens:");
    const id = deviceIdentifier(key.slice(token ? "device-tokens:".length : "devices:".length));
    if (!token && input.id !== id) throw new HttpError(400, "设备记录标识不匹配");
    const session = this.session();
    const statements = [];
    if (!token && !isAutomaticDeviceId(id) && input.enrollment !== "automatic") {
      statements.push(session.prepare(`
        INSERT INTO device_registry (id, device_json, token_hash, revoked_hash, enabled, deleted, credential_version)
        SELECT ?, ?, (SELECT json_extract(value, '$.hash') FROM relay_records WHERE key = ? AND json_valid(value)),
          NULL, ?, 0, CASE WHEN EXISTS (SELECT 1 FROM relay_records WHERE key = ? AND json_valid(value) AND json_extract(value, '$.hash') IS NOT NULL) THEN 1 ELSE 0 END
        ON CONFLICT(id) DO UPDATE SET device_json = excluded.device_json, enabled = excluded.enabled,
          command_session = CASE WHEN excluded.enabled = 0 OR device_registry.deleted = 1 THEN NULL ELSE device_registry.command_session END,
          deleted = 0, credential_version = device_registry.credential_version + CASE WHEN device_registry.deleted = 1 THEN 1 ELSE 0 END
        WHERE COALESCE(json_extract(device_registry.device_json, '$.enrollment'), '') <> 'automatic'
      `).bind(id, value, keys.deviceToken(id), input.enabled === false ? 0 : 1, keys.deviceToken(id)));
    } else if (token && !isAutomaticDeviceId(id)) {
      const hash = hashText(input.hash, true);
      statements.push(session.prepare(`
        UPDATE device_registry SET
          revoked_hash = CASE WHEN token_hash IS NOT ? THEN COALESCE(token_hash, revoked_hash) ELSE revoked_hash END,
          credential_version = credential_version + CASE WHEN token_hash IS NOT ? THEN 1 ELSE 0 END,
          command_session = CASE WHEN token_hash IS NOT ? THEN NULL ELSE command_session END,
          token_hash = ?
        WHERE id = ? AND deleted = 0 AND COALESCE(json_extract(device_json, '$.enrollment'), '') <> 'automatic'
      `).bind(hash, hash, hash, hash, id));
    }
    // During a read-only legacy import, mirrors may arrive before their authority record.
    // Once authority exists, even an old automatic-device projection cannot overwrite it.
    statements.push(session.prepare(`
      INSERT INTO relay_records (key, value, expires_at)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM device_registry WHERE id = ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
    `).bind(key, value, expiresAt, id));
    statements.push(...projection(session, id), ...invalidateCommands(session, id, new Date().toISOString()));
    await session.batch(statements);
  }

  async delete(key) {
    if (typeof key !== "string") throw new TypeError("Record key must be a string");
    if (key.startsWith("devices:")) {
      const id = deviceIdentifier(key.slice("devices:".length));
      if (await this.getDeviceRecord(id)) {
        await this.deleteDeviceRecord(id);
        return;
      }
    } else if (key.startsWith("device-tokens:")) {
      const id = deviceIdentifier(key.slice("device-tokens:".length));
      const session = this.session();
      await session.batch([
        session.prepare(`
          UPDATE device_registry SET revoked_hash = COALESCE(token_hash, revoked_hash), token_hash = NULL,
            credential_version = credential_version + 1, command_session = NULL
          WHERE id = ? AND deleted = 0 AND token_hash IS NOT NULL
        `).bind(id),
        session.prepare("DELETE FROM relay_records WHERE key = ?").bind(key),
        ...projection(session, id),
        ...invalidateCommands(session, id, new Date().toISOString()),
      ]);
      return;
    }
    await this.session().prepare("DELETE FROM relay_records WHERE key = ?").bind(key).run();
  }

  async list({ prefix = "", limit = 100, cursor } = {}) {
    if (typeof prefix !== "string") throw new HttpError(400, "记录前缀无效");
    limit = pageLimit(limit, 100, 1000);
    const where = ["(expires_at IS NULL OR expires_at > ?)"];
    const params = [nowSeconds()];
    if (prefix) {
      where.push("key >= ?");
      params.push(prefix);
      const end = prefixEnd(prefix);
      if (end !== null) { where.push("key < ?"); params.push(end); }
    }
    if (cursor) {
      const value = decodeCursor(cursor, "records");
      if (value.prefix !== prefix || typeof value.key !== "string" || !value.key.startsWith(prefix)) throw new HttpError(400, "分页标识与查询不匹配");
      where.push("key > ?");
      params.push(value.key);
    }
    const result = await this.session().prepare(`SELECT key FROM relay_records WHERE ${where.join(" AND ")} ORDER BY key ASC LIMIT ?`).bind(...params, limit + 1).all();
    const complete = result.results.length <= limit;
    const rows = result.results.slice(0, limit);
    return {
      keys: rows.map((row) => ({ name: row.key })),
      list_complete: complete,
      cursor: complete ? "" : encodeCursor({ kind: "records", prefix, key: rows.at(-1).key }),
    };
  }

  async createEvent(item, { eventDays } = {}) {
    if (!isRecord(item)) throw new HttpError(400, "事件记录须为对象");
    deviceIdentifier(item.device_id);
    identifier(item.event_id, "事件标识");
    const key = keys.event(item.device_id, item.event_id);
    const receipt = await eventReceipt(item.device_id, item.event_id);
    const expiresAt = expiry(item.expires_at);
    const session = this.session();
    const now = nowSeconds();
    const runtime = eventDays !== undefined;
    const effectiveExpiry = runtime ? "CAST(unixepoch(json_extract(?, '$.received_at')) AS INTEGER) + 86400 * COALESCE((SELECT event_days FROM history_retention_policy WHERE id = 1), ?)" : "?";
    const serialized = JSON.stringify(item);
    const results = await session.batch([
      // Seed legacy receipts even for an expired physical parent. An expired ID
      // cannot become a new event merely because TTL hid its old JSON.
      session.prepare(`INSERT INTO history_receipts (scope, receipt, fingerprint, cleared)
        SELECT 'events', ?, COALESCE(json_extract(value, '$.fingerprint'), ''), CASE WHEN expires_at <= ? THEN 1 ELSE 0 END
        FROM relay_records WHERE key = ? AND json_valid(value)
        ON CONFLICT(scope, receipt) DO NOTHING`).bind(receipt, now, key),
      session.prepare(`INSERT INTO relay_records (key, value, expires_at, retention_revision)
        SELECT ?, json_set(?, '$.expires_at', calculated.expires_at), calculated.expires_at,
          ${runtime ? "COALESCE((SELECT revision FROM history_retention_policy WHERE id = 1), 0)" : "0"}
        FROM (SELECT ${effectiveExpiry} AS expires_at) calculated
        WHERE NOT EXISTS (SELECT 1 FROM history_receipts WHERE scope = 'events' AND receipt = ?)
        ON CONFLICT(key) DO NOTHING RETURNING key`).bind(key, serialized, ...(runtime ? [serialized, eventDays] : [expiresAt]), receipt),
      session.prepare(`INSERT INTO history_receipts (scope, receipt, fingerprint, cleared)
        SELECT 'events', ?, COALESCE(json_extract(value, '$.fingerprint'), ''), CASE WHEN expires_at <= ? THEN 1 ELSE 0 END
        FROM relay_records WHERE key = ? AND json_valid(value)
        ON CONFLICT(scope, receipt) DO NOTHING`).bind(receipt, now, key),
      session.prepare(`SELECT r.value FROM relay_records r JOIN history_receipts h ON h.scope = 'events' AND h.receipt = ?
        WHERE r.key = ? AND h.cleared = 0 AND (r.expires_at IS NULL OR r.expires_at > ?)`).bind(receipt, key, now),
      session.prepare("SELECT fingerprint FROM history_receipts WHERE scope = 'events' AND receipt = ?").bind(receipt),
    ]);
    const value = results[3].results[0]?.value;
    const savedFingerprint = results[4].results[0]?.fingerprint;
    if (item.fingerprint && savedFingerprint && savedFingerprint !== item.fingerprint) throw new HttpError(409, "该事件标识已用于另一条记录");
    if (!value) return { item: { device_id: item.device_id, event_id: item.event_id, type: item.type, routes: [], cleared: true }, created: false, cleared: true };
    const winner = JSON.parse(value);
    if (item.fingerprint && winner.fingerprint !== item.fingerprint) throw new HttpError(409, "该事件标识已用于另一条记录");
    // Native D1 meta.changes can include trigger writes; RETURNING identifies
    // the actual parent INSERT rather than counting watermark side effects.
    return { item: winner, created: results[1].results.length === 1 };
  }

  async listEvents({ device, type, limit = 30, cursor } = {}) {
    if (device) deviceIdentifier(device);
    if (type && (typeof type !== "string" || type.length > 80)) throw new HttpError(400, "事件类型无效");
    limit = pageLimit(limit);
    const filters = { device: device || "", type: type || "" };
    const where = ["key GLOB 'events:*'", "json_valid(value)", "json_extract(value, '$.received_at') IS NOT NULL", "(expires_at IS NULL OR expires_at > ?)"];
    const params = [nowSeconds()];
    if (device) { where.push("json_extract(value, '$.device_id') = ?"); params.push(device); }
    if (type) { where.push("json_extract(value, '$.type') = ?"); params.push(type); }
    if (cursor) {
      const value = decodeCursor(cursor, "events");
      if (JSON.stringify(value.filters) !== JSON.stringify(filters) || typeof value.time !== "string" || typeof value.key !== "string" || !value.key.startsWith("events:")) {
        throw new HttpError(400, "分页标识与查询不匹配");
      }
      where.push("(json_extract(value, '$.received_at') < ? OR (json_extract(value, '$.received_at') = ? AND key < ?))");
      params.push(value.time, value.time, value.key);
    }
    const result = await this.session().prepare(`
      SELECT key, value, json_extract(value, '$.received_at') AS received_at FROM relay_records
      WHERE ${where.join(" AND ")} ORDER BY json_extract(value, '$.received_at') DESC, key DESC LIMIT ?
    `).bind(...params, limit + 1).all();
    const rows = result.results.slice(0, limit);
    return {
      items: rows.map((row) => JSON.parse(row.value)),
      cursor: result.results.length <= limit ? null : encodeCursor({ kind: "events", filters, time: rows.at(-1).received_at, key: rows.at(-1).key }),
    };
  }

  async cleanup(limit = 200) {
    limit = pageLimit(limit, 200, 200);
    const history = await cleanupExpiredHistory({ DATA: this }, "events", limit);
    if (history.deleted >= limit) return { deleted: history.deleted };
    // History parents and their result/lease children use the guarded eraser;
    // deleting terminal sent markers by generic TTL could re-send a live event.
    const result = await this.session().prepare(`
      DELETE FROM relay_records WHERE key IN (SELECT key FROM relay_records
        WHERE expires_at IS NOT NULL AND expires_at <= ?
          AND key NOT GLOB 'events:*' AND key NOT GLOB 'timeline:*' AND key NOT GLOB 'pending:*'
          AND key NOT GLOB 'deliveries:*' AND key NOT GLOB 'sent:*' AND key NOT GLOB 'delivery-leases:*'
          AND key NOT GLOB 'devices:*' AND key NOT GLOB 'device-tokens:*' AND key NOT GLOB 'latest:*'
          AND key NOT GLOB 'channels:*' AND key NOT GLOB 'templates:*' AND key NOT GLOB 'rules:*' AND key NOT GLOB 'jobs:*'
        ORDER BY expires_at, key LIMIT ?)
    `).bind(nowSeconds(), limit - history.deleted).run();
    return { deleted: history.deleted + changes(result) };
  }

  async getDeviceRecord(id) {
    deviceIdentifier(id);
    return deviceRecord(await this.session().prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first());
  }

  async registerDevice(id, identity, hash) {
    deviceIdentifier(id);
    if (!isRecord(identity) || !["imei", "sn"].includes(identity.identity_type) || typeof identity.identity_value !== "string" || !identity.identity_value || identity.identity_value.length > 64) {
      throw new HttpError(400, "硬件标识无效");
    }
    hash = hashText(hash);
    const now = new Date().toISOString();
    const device = {
      id, name: `设备 ${identity.identity_value.slice(-4)}`, enabled: true, enrollment: "automatic",
      identity_type: identity.identity_type, identity_value: identity.identity_value, created_at: now, updated_at: now,
    };
    const session = this.session();
    const results = await session.batch([
      session.prepare("SELECT id FROM device_registry WHERE id = ?").bind(id),
      session.prepare(`
        INSERT INTO device_registry (id, device_json, token_hash, revoked_hash, enabled, deleted, credential_version)
        VALUES (?, ?, ?, NULL, 1, 0, 1)
        ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, revoked_hash = NULL,
          credential_version = device_registry.credential_version + 1, command_session = NULL,
          device_json = json_set(device_registry.device_json, '$.updated_at', ?)
        WHERE device_registry.deleted = 0 AND device_registry.enabled = 1 AND device_registry.token_hash IS NULL
          AND (device_registry.revoked_hash IS NULL OR device_registry.revoked_hash <> excluded.token_hash)
      `).bind(id, JSON.stringify(device), hash, now),
      ...projection(session, id),
      ...invalidateCommands(session, id, now),
      session.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id),
    ]);
    const record = deviceRecord(results.at(-1).results[0]);
    if (record.deleted) throw new HttpError(410, "该设备已删除");
    if (!record.device.enabled) throw new HttpError(403, "设备已停用");
    if (record.hash !== hash) {
      throw new HttpError(409, record.revokedHash === hash ? "该设备需要使用新的登记凭据" : "该硬件标识已绑定其他凭据");
    }
    return { record, created: results[0].results.length === 0 };
  }

  async updateDeviceRecord(id, patch) {
    deviceIdentifier(id);
    if (!isRecord(patch)) throw new HttpError(400, "设备更新须为对象");
    const jsonParts = [];
    const params = [];
    if (patch.name !== undefined) {
      jsonParts.push("'$.name', ?");
      params.push(text(patch.name, "名称", { required: true }));
    }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new HttpError(400, "启用状态须为布尔值");
      jsonParts.push("'$.enabled', json(?)");
      params.push(patch.enabled ? "true" : "false");
    }
    if (!jsonParts.length) {
      const record = await this.getDeviceRecord(id);
      if (!record || record.deleted) throw new HttpError(404, "记录不存在");
      return record;
    }
    const now = new Date().toISOString();
    jsonParts.push("'$.updated_at', ?");
    params.push(now);
    const session = this.session();
    return this.deviceMutation(session, id, [session.prepare(`
      UPDATE device_registry SET device_json = json_set(device_json, ${jsonParts.join(", ")})
      ${patch.enabled === undefined ? "" : ", enabled = ?"}${patch.enabled === false ? ", command_session = NULL" : ""} WHERE id = ? AND deleted = 0
    `).bind(...params, ...(patch.enabled === undefined ? [] : [patch.enabled ? 1 : 0]), id)], now);
  }

  async rebindDeviceRecord(id) {
    deviceIdentifier(id);
    const now = new Date().toISOString();
    const session = this.session();
    return this.deviceMutation(session, id, [session.prepare(`
      UPDATE device_registry SET revoked_hash = token_hash, token_hash = NULL, command_session = NULL,
        credential_version = credential_version + 1, device_json = json_set(device_json, '$.updated_at', ?)
      WHERE id = ? AND deleted = 0 AND token_hash IS NOT NULL
    `).bind(now, id)], now);
  }

  async provisionDeviceRecord(id, { expectedVersion, hash } = {}) {
    deviceIdentifier(id);
    hash = hashText(hash);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "设备凭据版本无效");
    const now = new Date().toISOString();
    const session = this.session();
    return this.deviceMutation(session, id, [session.prepare(`
      UPDATE device_registry SET revoked_hash = COALESCE(token_hash, revoked_hash), token_hash = ?,
        credential_version = credential_version + 1, command_session = NULL,
        device_json = json_set(device_json, '$.updated_at', ?)
      WHERE id = ? AND deleted = 0 AND enabled = 1 AND credential_version = ?
        AND token_hash IS NOT ? AND revoked_hash IS NOT ?
      RETURNING credential_version
    `).bind(hash, now, id, expectedVersion, hash, hash)], now, false, (record, results) => {
      if (record.device.enabled === false) throw new HttpError(403, "设备已停用");
      if (changes(results[0]) !== 1 || results[0].results[0]?.credential_version !== expectedVersion + 1
        || record.credentialVersion !== expectedVersion + 1 || record.hash !== hash || record.commandSession !== null) {
        throw new HttpError(409, "设备凭据版本已变更，或凭据已使用、撤销，请刷新后重试");
      }
    }, { sql: "EXISTS (SELECT 1 FROM device_registry WHERE id = ? AND credential_version = ? AND token_hash = ? AND enabled = 1 AND deleted = 0)",
      params: [id, expectedVersion + 1, hash] });
  }

  async deleteDeviceRecord(id) {
    deviceIdentifier(id);
    const now = new Date().toISOString();
    const session = this.session();
    return this.deviceMutation(session, id, [session.prepare(`
      UPDATE device_registry SET device_json = json_object('id', id), enabled = 0, deleted = 1,
        revoked_hash = COALESCE(token_hash, revoked_hash), token_hash = NULL, command_session = NULL,
        credential_version = credential_version + 1 WHERE id = ? AND deleted = 0
    `).bind(id)], now, true);
  }

  async deviceMutation(session, id, statements, now, allowDeleted = false, verify, guard) {
    const results = await session.batch([
      ...statements, ...projection(session, id, guard), ...invalidateCommands(session, id, now, guard),
      session.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id),
    ]);
    const record = deviceRecord(results.at(-1).results[0]);
    if (!record || (!allowDeleted && record.deleted)) throw new HttpError(404, "记录不存在");
    if (verify) verify(record, results);
    return record;
  }

  async claimDelivery(deviceId, eventId, channelId, expiresAt, now = Date.now()) {
    deviceIdentifier(deviceId);
    identifier(eventId, "事件标识");
    identifier(channelId, "渠道标识");
    if (!Number.isFinite(now)) throw new TypeError("Lease time must be milliseconds");
    const deadline = Math.min(expiry(expiresAt) ?? Math.ceil(now / 1000) + 45, Math.ceil(now / 1000) + 45);
    if (deadline <= Math.floor(now / 1000)) return null;
    const owner = crypto.randomUUID();
    const key = `delivery-leases:${deviceId}:${eventId}:${channelId}`;
    const result = await this.session().prepare(`
      INSERT INTO relay_records (key, value, expires_at)
      SELECT ?, ?, MIN(COALESCE(p.expires_at, ?), ?) FROM relay_records p
      WHERE p.key = ? AND (p.expires_at IS NULL OR p.expires_at > ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
      WHERE json_extract(relay_records.value, '$.lease_until') <= ?
      RETURNING key
    `).bind(key, JSON.stringify({ owner, lease_until: now + 45_000 }), deadline, deadline,
      keys.event(deviceId, eventId), Math.floor(now / 1000), now).all();
    return result.results.length ? owner : null;
  }

  async updateLatestStatus(deviceId, event) {
    deviceIdentifier(deviceId);
    const key = keys.latest(deviceId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const session = this.session();
      const row = await session.prepare("SELECT value FROM relay_records WHERE key = ?").bind(key).first();
      const latest = row ? JSON.parse(row.value) : {};
      if (latest.last_seen >= event.received_at) return false;
      const value = JSON.stringify({ ...latest, last_seen: event.received_at, last_event_type: event.type,
        status: { ...latest.status, ...event.status } });
      const saved = row
        ? await session.prepare("UPDATE relay_records SET value = ?, expires_at = NULL WHERE key = ? AND value = ? RETURNING key")
          .bind(value, key, row.value).first()
        : await session.prepare("INSERT INTO relay_records (key, value, expires_at) VALUES (?, ?, NULL) ON CONFLICT(key) DO NOTHING RETURNING key")
          .bind(key, value).first();
      if (saved) return true;
    }
    throw new HttpError(503, "设备状态并发更新，请稍后重试");
  }

  async releaseDelivery(deviceId, eventId, channelId, owner) {
    if (typeof owner !== "string" || !owner) return;
    await this.session().prepare("DELETE FROM relay_records WHERE key = ? AND json_extract(value, '$.owner') = ?")
      .bind(`delivery-leases:${deviceId}:${eventId}:${channelId}`, owner).run();
  }
}
