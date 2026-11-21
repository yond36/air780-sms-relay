import { d1Session, pageLimit } from "./db.js";
import { digest, matchesDigest, newToken } from "./security.js";
import { deviceIdentifier, HttpError, isRecord } from "./store.js";

const DAY = 86400;
const BATCH_LIMIT = 200;
const PREVIEW_SECONDS = 15 * 60;
const seconds = () => Math.floor(Date.now() / 1000);
const changed = (result) => Number(result?.meta?.changes || 0);
const fallbackDays = (value, fallback) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 90 ? Number(value) : fallback;
export function fallbackSmsDays(value) {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return 30;
  const days = Number(value);
  if (days === 0) return value === 0 || typeof value === "string" && value.trim() === "0" ? 0 : 30;
  return Number.isInteger(days) && days >= 1 && days <= 90 ? days : 30;
}
const defaults = (env) => ({ event_days: fallbackDays(env.EVENT_RETENTION_DAYS, 7), sms_days: fallbackSmsDays(env.SMS_RETENTION_DAYS), revision: 0, updated_at: null });
const presentPolicy = (policy) => ({ ...policy, sms_days: policy.sms_days ?? 0 });

export const eventReceipt = (device, event) => digest(`event\0${device}\0${event}`);

export async function getRetentionPolicy(env) {
  if (env.DATA && !env.DATA.isD1) return defaults(env);
  return presentPolicy(await d1Session(env).prepare("SELECT event_days, sms_days, revision, updated_at FROM history_retention_policy WHERE id = 1").first() || defaults(env));
}

export async function saveRetentionPolicy(env, input) {
  if (!isRecord(input)) throw new HttpError(400, "保留策略须为对象");
  for (const name of ["event_days", "sms_days"]) {
    if (name === "sms_days" && input[name] === null) continue;
    if (!Number.isInteger(input[name]) || input[name] < (name === "sms_days" ? 0 : 1) || input[name] > 90) {
      throw new HttpError(400, name === "sms_days" ? "短信保留天数须为 0–90 的整数，0 表示永久保留" : "事件保留天数须为 1–90 的整数");
    }
  }
  const expected = input.revision ?? null;
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new HttpError(400, "策略版本无效");
  const session = d1Session(env);
  const now = seconds();
  const iso = new Date().toISOString();
  const results = await session.batch([
    session.prepare("SELECT revision FROM history_retention_policy WHERE id = 1"),
    session.prepare(`
      INSERT INTO history_retention_policy (id, event_days, sms_days, revision, updated_at)
      SELECT 1, ?, ?, 1, ? WHERE ? IS NULL OR ? = COALESCE((SELECT revision FROM history_retention_policy WHERE id = 1), 0)
      ON CONFLICT(id) DO UPDATE SET event_days = excluded.event_days, sms_days = excluded.sms_days,
        revision = history_retention_policy.revision + 1, updated_at = excluded.updated_at
      WHERE history_retention_policy.event_days <> excluded.event_days OR history_retention_policy.sms_days IS NOT excluded.sms_days
    `).bind(input.event_days, input.sms_days === 0 ? null : input.sms_days, iso, expected, expected),
    session.prepare(`
      INSERT INTO history_retention_revisions (revision, event_days, sms_days, cutover)
      SELECT revision, event_days, sms_days, ? FROM history_retention_policy WHERE id = 1
      ON CONFLICT(revision) DO NOTHING
    `).bind(now),
    session.prepare("SELECT event_days, sms_days, revision, updated_at FROM history_retention_policy WHERE id = 1"),
  ]);
  if (expected !== null && expected !== (results[0].results[0]?.revision || 0)) throw new HttpError(409, "保留策略已更新，请刷新后重试");
  return presentPolicy(results.at(-1).results[0]);
}

// Every policy cutover is retained, not just the latest one. A row which was
// already dead at any cutover must never be lengthened by a later revision,
// including when several policy edits race ahead of bounded reconciliation.
function revisedExpiry(row, revisions, kind) {
  let expiry = row.expires_at;
  const received = Math.floor(Date.parse(row.received_at) / 1000);
  if (!Number.isFinite(received)) return expiry;
  for (const revision of revisions) {
    if (revision.revision <= row.retention_revision) continue;
    if (expiry !== null && expiry <= revision.cutover) continue;
    const days = revision[kind === "events" ? "event_days" : "sms_days"];
    expiry = days === null ? null : received + days * DAY;
  }
  return expiry;
}

function historySource(kind) {
  if (kind === "events") return `
    SELECT r.key AS item_id, r.history_seq, r.retention_revision, r.expires_at,
      json_extract(r.value, '$.device_id') AS device_id, json_extract(r.value, '$.event_id') AS event_id,
      json_extract(r.value, '$.received_at') AS received_at, NULL AS command_id, r.value AS event_json,
      'event' AS row_type FROM relay_records r WHERE r.key GLOB 'events:*' AND json_valid(r.value)
      AND json_type(r.value, '$.received_at') = 'text'`;
  return `
    SELECT m.id AS item_id, m.history_seq, m.retention_revision, m.expires_at, m.device_id, m.event_id,
      m.received_at, m.command_id, NULL AS event_json, 'message' AS row_type FROM sms_messages m
    UNION ALL
    SELECT c.message_id AS item_id, c.history_seq, c.retention_revision, c.retention_expires_at AS expires_at,
      c.device_id, NULL AS event_id, c.created_at AS received_at, c.id AS command_id, NULL AS event_json,
      'command' AS row_type FROM sms_commands c WHERE c.purged_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sms_messages m WHERE m.command_id = c.id)`;
}

function activeSql(kind, alias = "h") {
  if (kind === "sms") return `EXISTS (SELECT 1 FROM sms_commands c WHERE c.id = ${alias}.command_id AND c.status IN ('queued', 'dispatched'))`;
  return `(EXISTS (SELECT 1 FROM relay_records p WHERE p.key = 'pending:' || ${alias}.device_id || ':' || ${alias}.event_id
      AND (p.expires_at IS NULL OR p.expires_at > ?))
    OR EXISTS (SELECT 1 FROM relay_records l WHERE substr(l.key, 1, length('delivery-leases:' || ${alias}.device_id || ':' || ${alias}.event_id || ':'))
      = 'delivery-leases:' || ${alias}.device_id || ':' || ${alias}.event_id || ':'
      AND json_valid(l.value) AND json_extract(l.value, '$.lease_until') > ?))`;
}
const activeParams = (kind, now) => kind === "events" ? [now, now * 1000] : [];

function selection(preview, alias = "h", after = "") {
  const where = [`${alias}.history_seq <= ?`, `${alias}.received_at <= ?`];
  const params = [preview.max_sequence, preview.max_received];
  if (preview.device_id) { where.push(`${alias}.device_id = ?`); params.push(preview.device_id); }
  if (preview.mode === "expired") {
    // A stale finite deadline may become permanent or be extended by pending
    // reconciliation. Recheck the current revision even inside the erasure batch.
    where.push(`${alias}.retention_revision = COALESCE((SELECT revision FROM history_retention_policy WHERE id = 1), 0)`,
      `${alias}.expires_at IS NOT NULL AND ${alias}.expires_at <= ?`);
    params.push(preview.cutoff_seconds);
  }
  if (preview.mode === "before") { where.push(`${alias}.received_at < ?`); params.push(preview.cutoff); }
  if (after) { where.push(`${alias}.item_id > ?`); params.push(after); }
  return { sql: where.join(" AND "), params };
}

function isoTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, "清理截止时间须为带时区的 ISO 时间");
  }
  return new Date(Date.parse(value)).toISOString();
}

async function signingKey(env) {
  if (typeof env.APP_SECRET !== "string" || env.APP_SECRET.length < 32) throw new HttpError(503, "请先配置应用密钥");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`history-cleanup\0${env.APP_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function tokenFor(env, preview, step) {
  const scope = JSON.stringify(["history-cleanup-v1", preview.id, step, preview.kind, preview.mode, preview.device_id,
    preview.cutoff, preview.cutoff_seconds, preview.max_received, preview.max_sequence, preview.expires_at]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(scope)));
  const signature = btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${preview.id}.${step}.${signature}`;
}

async function newPreview(env, input) {
  if (!isRecord(input) || !["events", "sms"].includes(input.kind) || !["expired", "before", "all"].includes(input.mode)) throw new HttpError(400, "清理范围或模式无效");
  const device = input.device_id === undefined || input.device_id === "" ? "" : deviceIdentifier(input.device_id);
  const now = seconds();
  const preview = { id: newToken(), kind: input.kind, mode: input.mode, device_id: device,
    cutoff: input.mode === "before" ? isoTime(input.before) : new Date().toISOString(), cutoff_seconds: now,
    max_received: new Date().toISOString(), max_sequence: 0, expires_at: now + PREVIEW_SECONDS, step: 0, cursor: "" };
  const session = d1Session(env);
  preview.max_sequence = (await session.prepare("SELECT value FROM history_sequence WHERE id = 1").first()).value;
  const scope = selection(preview);
  const counts = await session.prepare(`WITH history AS (${historySource(preview.kind)})
    SELECT COUNT(*) AS matched, COALESCE(SUM(CASE WHEN ${activeSql(preview.kind)} THEN 0 ELSE 1 END), 0) AS eligible,
      MAX(h.received_at) AS max_received FROM history h WHERE ${scope.sql}`)
    .bind(...activeParams(preview.kind, now), ...scope.params).first();
  preview.max_received = counts.max_received || preview.max_received;
  await session.prepare(`INSERT INTO history_cleanup_previews
    (id, kind, mode, device_id, cutoff, cutoff_seconds, max_received, max_sequence, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(preview.id, preview.kind, preview.mode, preview.device_id, preview.cutoff, preview.cutoff_seconds, preview.max_received, preview.max_sequence, preview.expires_at).run();
  return { preview, counts };
}

export async function previewCleanup(env, input) {
  await signingKey(env);
  const { preview, counts } = await newPreview(env, input);
  return { preview_token: await tokenFor(env, preview, 0), matched: counts.matched, eligible: counts.eligible,
    skipped: counts.matched - counts.eligible, cutoff: preview.cutoff, expires_at: new Date(preview.expires_at * 1000).toISOString() };
}

// All selected targets, current activity checks, receipts, child erasure and
// parent erasure share one D1 transaction. Every mutation is gated by the same
// per-step CAS owner, so concurrent requests using the same token cannot advance
// twice. Replays return the saved response, including the exact next token.
async function processBatch(env, preview, step, limit, nextToken, eligibleOnly = false) {
  const session = d1Session(env);
  const now = seconds();
  const scope = selection(preview, "h", preview.cursor);
  const candidates = (await session.prepare(`WITH history AS (${historySource(preview.kind)})
    SELECT h.* FROM history h WHERE ${scope.sql} ${eligibleOnly ? `AND NOT ${activeSql(preview.kind)}` : ""}
    ORDER BY h.item_id LIMIT ?`).bind(...scope.params, ...(eligibleOnly ? activeParams(preview.kind, now) : []), limit).all()).results;
  for (const row of candidates) row.receipt = preview.kind === "events" ? await eventReceipt(row.device_id, row.event_id)
    : row.event_id ? `in~${await digest(`${row.device_id}:${row.event_id}`)}` : null;
  const owner = newToken();
  const gate = "EXISTS (SELECT 1 FROM history_cleanup_batches b WHERE b.preview_id = ? AND b.step = ? AND b.owner = ? AND b.result IS NULL)";
  const gateParams = [preview.id, step, owner];
  const targetScope = "t.preview_id = ? AND t.step = ?";
  const targetParams = [preview.id, step];
  const statements = [session.prepare(`
    INSERT INTO history_cleanup_batches (preview_id, step, owner)
    SELECT id, ?, ? FROM history_cleanup_previews WHERE id = ? AND step = ? AND expires_at > ?
    ON CONFLICT(preview_id, step) DO NOTHING
  `).bind(step, owner, preview.id, step, now)];
  // Stay below D1's 100 parameters and avoid one query per history row.
  for (let start = 0; start < candidates.length; start += 28) {
    const page = candidates.slice(start, start + 28);
    statements.push(session.prepare(`INSERT INTO history_cleanup_targets (preview_id, step, item_id, history_seq, receipt)
      SELECT ?, ?, proposed.item_id, proposed.history_seq, proposed.receipt FROM
      (${page.map(() => "SELECT ? AS item_id, ? AS history_seq, ? AS receipt").join(" UNION ALL ")}) proposed WHERE ${gate}`)
      .bind(preview.id, step, ...page.flatMap((row) => [row.item_id, row.history_seq, row.receipt]), ...gateParams));
  }
  const eligibleScope = selection(preview);
  statements.push(session.prepare(`WITH history AS (${historySource(preview.kind)})
    UPDATE history_cleanup_targets AS t SET eligible = 1 WHERE ${targetScope} AND ${gate}
      AND EXISTS (SELECT 1 FROM history h WHERE h.item_id = t.item_id AND h.history_seq = t.history_seq
        AND ${eligibleScope.sql} AND NOT ${activeSql(preview.kind)})`)
    .bind(...targetParams, ...gateParams, ...eligibleScope.params, ...activeParams(preview.kind, now)));
  const liveTargets = `SELECT t.* FROM history_cleanup_targets t WHERE ${targetScope} AND t.eligible = 1 AND ${gate}`;
  const liveParams = [...targetParams, ...gateParams];
  if (preview.kind === "events") {
    statements.push(session.prepare(`INSERT INTO history_receipts (scope, receipt, fingerprint, cleared)
      SELECT 'events', t.receipt, COALESCE(json_extract(p.value, '$.fingerprint'), ''), 1
      FROM (${liveTargets}) t JOIN relay_records p ON p.key = t.item_id AND p.history_seq = t.history_seq
      WHERE 1 ON CONFLICT(scope, receipt) DO UPDATE SET cleared = 1`).bind(...liveParams));
    // Exact same-parent joins; identifiers are never interpolated into LIKE/GLOB.
    statements.push(session.prepare(`DELETE FROM relay_records AS child WHERE EXISTS (
      SELECT 1 FROM (${liveTargets}) t JOIN relay_records p ON p.key = t.item_id AND p.history_seq = t.history_seq
      WHERE ${eventChildSql("child", "p")})`).bind(...liveParams));
    statements.push(session.prepare(`DELETE FROM relay_records WHERE key IN (SELECT p.key FROM (${liveTargets}) t
      JOIN relay_records p ON p.key = t.item_id AND p.history_seq = t.history_seq)`).bind(...liveParams));
  } else {
    statements.push(session.prepare(`INSERT INTO history_receipts (scope, receipt, fingerprint, cleared)
      SELECT 'sms', t.receipt, '', 1 FROM (${liveTargets}) t JOIN sms_messages m
      ON m.id = t.item_id AND m.history_seq = t.history_seq WHERE t.receipt IS NOT NULL
      ON CONFLICT(scope, receipt) DO UPDATE SET cleared = 1`).bind(...liveParams));
    statements.push(session.prepare(`UPDATE sms_commands SET peer = '', content = '', device_name = '', device_id = '',
      credential_hash = '', command_digest = '', reply_to = NULL, dispatch_session = NULL, error = NULL, purged_at = ?
      WHERE purged_at IS NULL AND status NOT IN ('queued', 'dispatched') AND message_id IN (SELECT item_id FROM (${liveTargets}))`)
      .bind(now, ...liveParams));
    statements.push(session.prepare(`DELETE FROM sms_messages WHERE id IN (SELECT m.id FROM (${liveTargets}) t
      JOIN sms_messages m ON m.id = t.item_id AND m.history_seq = t.history_seq
      WHERE NOT EXISTS (SELECT 1 FROM sms_commands c WHERE c.id = m.command_id AND c.status IN ('queued', 'dispatched')))`)
      .bind(...liveParams));
  }
  const cursor = candidates.at(-1)?.item_id || preview.cursor;
  const rest = selection(preview, "h", cursor);
  const purgeStats = eligibleOnly && preview.kind === "sms";
  const purgeField = purgeStats ? ", 'purged', purged" : "";
  statements.push(session.prepare(`WITH history AS (${historySource(preview.kind)}), stats AS (
      SELECT (SELECT COUNT(*) FROM history_cleanup_targets t WHERE ${targetScope} AND t.eligible = 1) AS deleted,
        (SELECT COUNT(*) FROM history h WHERE ${rest.sql} ${eligibleOnly ? `AND NOT ${activeSql(preview.kind)}` : ""}) AS remaining
        ${purgeStats ? `, (SELECT COUNT(*) FROM sms_commands c JOIN history_cleanup_targets t ON c.message_id = t.item_id
          WHERE ${targetScope} AND t.eligible = 1 AND c.purged_at = ?) AS purged` : ""})
    UPDATE history_cleanup_batches SET result = (SELECT CASE WHEN remaining = 0 THEN
      json_object('deleted', deleted, 'skipped', ? - deleted, 'remaining', remaining, 'done', json('true') ${purgeField}) ELSE
      json_object('deleted', deleted, 'skipped', ? - deleted, 'remaining', remaining, 'done', json('false'), 'preview_token', ? ${purgeField}) END FROM stats)
    WHERE preview_id = ? AND step = ? AND owner = ? AND result IS NULL`)
    .bind(...targetParams, ...rest.params, ...(eligibleOnly ? activeParams(preview.kind, now) : []), ...(purgeStats ? [...targetParams, now] : []),
      candidates.length, candidates.length, nextToken, ...gateParams));
  statements.push(session.prepare(`UPDATE history_cleanup_previews SET step = step + 1, cursor = ?
    WHERE id = ? AND step = ? AND EXISTS (SELECT 1 FROM history_cleanup_batches WHERE preview_id = ? AND step = ? AND owner = ? AND result IS NOT NULL)`)
    .bind(cursor, preview.id, step, ...gateParams));
  statements.push(session.prepare("DELETE FROM history_cleanup_targets WHERE preview_id = ? AND step = ? AND EXISTS (SELECT 1 FROM history_cleanup_batches WHERE preview_id = ? AND step = ? AND result IS NOT NULL)")
    .bind(...targetParams, preview.id, step));
  statements.push(session.prepare("SELECT result FROM history_cleanup_batches WHERE preview_id = ? AND step = ?").bind(preview.id, step));
  const results = await session.batch(statements);
  const result = results.at(-1).results[0]?.result;
  if (!result) throw new HttpError(409, "清理预览已失效，请重新预览");
  return JSON.parse(result);
}

export async function executeCleanup(env, input) {
  if (!isRecord(input) || typeof input.preview_token !== "string") throw new HttpError(400, "请先预览清理范围");
  const match = input.preview_token.match(/^([A-Za-z0-9_-]{43})\.(0|[1-9]\d{0,8})\.([A-Za-z0-9_-]{43})$/);
  if (!match) throw new HttpError(400, "清理确认标识无效");
  const [, id, stepText] = match;
  const step = Number(stepText);
  const session = d1Session(env);
  const preview = await session.prepare("SELECT * FROM history_cleanup_previews WHERE id = ?").bind(id).first();
  if (!preview || !matchesDigest(input.preview_token, await tokenFor(env, preview, step))) throw new HttpError(400, "清理确认标识无效");
  if (preview.expires_at <= seconds()) throw new HttpError(410, "清理预览已过期，请重新预览");
  if (input.confirm !== (preview.mode === "all" ? "清空全部" : "清理")) throw new HttpError(400, preview.mode === "all" ? "请输入清空全部确认" : "请输入清理确认");
  const prior = await session.prepare("SELECT result FROM history_cleanup_batches WHERE preview_id = ? AND step = ?").bind(id, step).first();
  if (prior?.result) return JSON.parse(prior.result);
  if (step !== preview.step) throw new HttpError(409, "清理批次无效，请重新预览");
  return processBatch(env, preview, step, BATCH_LIMIT, await tokenFor(env, preview, step + 1));
}

export async function cleanupExpiredHistory(env, kind, limit = BATCH_LIMIT) {
  limit = pageLimit(limit, BATCH_LIMIT, BATCH_LIMIT);
  const { preview } = await newPreview(env, { kind, mode: "expired" });
  try { return await processBatch(env, preview, 0, limit, null, true); }
  finally { await d1Session(env).prepare("DELETE FROM history_cleanup_previews WHERE id = ?").bind(preview.id).run(); }
}

function eventChildSql(child, parent) {
  const base = `json_extract(${parent}.value, '$.device_id') || ':' || json_extract(${parent}.value, '$.event_id')`;
  return `(${child}.key = 'pending:' || ${base}
    OR substr(${child}.key, 1, length('deliveries:' || ${base} || ':')) = 'deliveries:' || ${base} || ':'
    OR substr(${child}.key, 1, length('sent:' || ${base} || ':')) = 'sent:' || ${base} || ':'
    OR substr(${child}.key, 1, length('delivery-leases:' || ${base} || ':')) = 'delivery-leases:' || ${base} || ':'
    OR (${child}.key GLOB 'timeline:*' AND json_valid(${child}.value) AND json_extract(${child}.value, '$.eventKey') = ${parent}.key))`;
}

export async function reconcileRetention(env, limit = BATCH_LIMIT) {
  limit = pageLimit(limit, BATCH_LIMIT, BATCH_LIMIT);
  const session = d1Session(env);
  const revisions = (await session.prepare("SELECT * FROM history_retention_revisions ORDER BY revision").all()).results;
  if (!revisions.length) return { reconciled: 0, revision: 0, done: true };
  const revision = revisions.at(-1).revision;
  // Applied revision is a durable keyset: successful rows leave this index range;
  // there is no OFFSET, full-record rewrite, or stale cursor that can skip rows.
  const rows = (await session.prepare(`WITH history AS (
      SELECT 'events' AS kind, * FROM (${historySource("events")})
      UNION ALL SELECT 'sms' AS kind, * FROM (${historySource("sms")}))
    SELECT * FROM history WHERE retention_revision < ? ORDER BY kind, item_id LIMIT ?`).bind(revision, limit).all()).results;
  let reconciled = 0;
  for (let start = 0; start < rows.length; start += 30) {
    const statements = [];
    for (const row of rows.slice(start, start + 30)) {
      const expiresAt = revisedExpiry(row, revisions, row.kind);
      if (row.kind === "events") {
        statements.push(session.prepare(`UPDATE relay_records SET value = json_set(value, '$.expires_at', ?), expires_at = ?, retention_revision = ?
          WHERE key = ? AND history_seq = ? AND retention_revision = ? AND value = ?`)
          .bind(expiresAt, expiresAt, revision, row.item_id, row.history_seq, row.retention_revision, row.event_json));
        statements.push(session.prepare(`UPDATE relay_records AS child SET expires_at = CASE
          WHEN child.key GLOB 'delivery-leases:*' THEN MIN(child.expires_at, ?)
          WHEN child.expires_at IS NOT NULL AND child.expires_at <= ? THEN child.expires_at ELSE ? END
          WHERE EXISTS (SELECT 1 FROM relay_records p WHERE p.key = ? AND p.history_seq = ? AND p.retention_revision = ? AND ${eventChildSql("child", "p")})`)
          .bind(expiresAt, revisions.find((change) => change.revision > row.retention_revision).cutover, expiresAt, row.item_id, row.history_seq, revision));
      } else if (row.row_type === "message") {
        // The command's execution TTL is deliberately not part of this update.
        statements.push(session.prepare(`UPDATE sms_commands SET retention_expires_at = ?, retention_revision = ?
          WHERE id = ? AND purged_at IS NULL AND EXISTS (SELECT 1 FROM sms_messages m WHERE m.id = ? AND m.history_seq = ? AND m.retention_revision = ?)`)
          .bind(expiresAt, revision, row.command_id, row.item_id, row.history_seq, row.retention_revision));
        statements.push(session.prepare("UPDATE sms_messages SET expires_at = ?, retention_revision = ? WHERE id = ? AND history_seq = ? AND retention_revision = ?")
          .bind(expiresAt, revision, row.item_id, row.history_seq, row.retention_revision));
      } else {
        statements.push(session.prepare("UPDATE sms_commands SET retention_expires_at = ?, retention_revision = ? WHERE id = ? AND history_seq = ? AND retention_revision = ? AND purged_at IS NULL")
          .bind(expiresAt, revision, row.command_id, row.history_seq, row.retention_revision));
      }
    }
    const results = await session.batch(statements);
    reconciled += results.filter((result) => changed(result)).length;
  }
  return { reconciled: rows.length ? Math.min(rows.length, reconciled) : 0, revision, done: rows.length < limit };
}

export async function expireCleanupPreviews(env, limit = BATCH_LIMIT) {
  const result = await d1Session(env).prepare(`DELETE FROM history_cleanup_previews WHERE id IN
    (SELECT id FROM history_cleanup_previews WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?) RETURNING id`)
    .bind(seconds(), pageLimit(limit, BATCH_LIMIT, BATCH_LIMIT)).all();
  return { deleted: result.results.length };
}
