import assert from "node:assert/strict";
import test from "node:test";
import { dataStore } from "../src/db.js";
import { dispatchEvent } from "../src/delivery.js";
import { updateDeviceStatus } from "../src/events.js";
import { acceptIncoming } from "../src/ingest.js";
import worker from "../src/index.js";
import { cleanupExpiredHistory, executeCleanup, expireCleanupPreviews, getRetentionPolicy, previewCleanup, reconcileRetention, saveRetentionPolicy } from "../src/retention.js";
import { RETRY_CRON } from "../src/scheduler.js";
import { digest, newToken } from "../src/security.js";
import { activateSmsSession, archiveSms, getSms, nextSmsCommand, queueSms, recordSmsResult } from "../src/sms.js";
import { keys, putJson } from "../src/store.js";
import { clock, d1Fixture, SQLiteD1 } from "./helpers/d1-sqlite.js";

const DAY = 86400;
const status = (expected) => (error) => error.status === expected;
const fixture = (t, overrides = {}) => d1Fixture(t, { APP_SECRET: "local-retention-test-secret-not-production", ...overrides });
const history = (db) => ({
  records: db.rows("SELECT * FROM relay_records ORDER BY key"),
  messages: db.rows("SELECT * FROM sms_messages ORDER BY id"),
  commands: db.rows("SELECT * FROM sms_commands ORDER BY id"),
  registry: db.rows("SELECT * FROM device_registry ORDER BY id"),
});
function event(time, id, overrides = {}) {
  return { version: 1, device_id: "manual", device_name: "本地设备", event_id: id, type: "sms.received",
    occurred_at: new Date(time.now()).toISOString(), received_at: new Date(time.now()).toISOString(),
    data: { sender: "10086", content: "只在内存 SQLite 内测试" }, status: {}, routes: [], fingerprint: `fingerprint-${id}`,
    expires_at: time.seconds() + 7 * DAY, ...overrides };
}
function seedEvent(db, item) {
  db.sqlite.prepare("INSERT INTO relay_records (key, value, expires_at) VALUES (?, ?, ?)")
    .run(keys.event(item.device_id, item.event_id), JSON.stringify(item), item.expires_at);
  return item;
}
async function manual(env) {
  const store = dataStore(env);
  const hash = await digest("local-only-retention-device-token");
  await putJson(store, keys.device("manual"), { id: "manual", name: "本地设备", enabled: true });
  await putJson(store, keys.deviceToken("manual"), { hash });
  return hash;
}
async function sms(env, content = "本地排队，不调用真实短信") {
  const input = { request_id: crypto.randomUUID(), device_id: "manual", to: "10086", content };
  return { input, ...await queueSms(env, input) };
}
async function clear(env, kind, extra = {}) {
  const preview = await previewCleanup(env, { kind, mode: "all", ...extra });
  return { preview, result: await executeCleanup(env, { preview_token: preview.preview_token, confirm: extra.mode && extra.mode !== "all" ? "清理" : "清空全部" }) };
}

test("0003 adds only retention metadata and leaves legacy data, credentials and command TTLs unchanged", (t) => {
  const time = clock(t);
  const db = new SQLiteD1({ through: "0002_ws_command_sessions.sql" });
  t.after(() => db.close());
  seedEvent(db, event(time, "legacy"));
  db.sqlite.prepare("INSERT INTO device_registry (id, device_json, token_hash, credential_version, command_session) VALUES (?, ?, ?, ?, ?)")
    .run("manual", '{"id":"manual","enabled":true}', "unchanged-hash", 9, "unchanged-session");
  const before = history(db);
  db.migrate("0003_history_retention.sql");
  const after = history(db);
  assert.deepEqual(after.registry, before.registry);
  assert.deepEqual(after.records.map(({ history_seq, retention_revision, ...row }) => {
    assert.equal(history_seq, 0); assert.equal(retention_revision, 0); return row;
  }), before.records);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_receipts").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_retention_policy").n, 0);
  db.migrate("0003_history_retention.sql");
  assert.deepEqual(history(db), after);
});

test("global policy uses environment fallback, persists checked integer days and supports optimistic revisions", async (t) => {
  clock(t);
  const { db, env } = fixture(t, { EVENT_RETENTION_DAYS: "12", SMS_RETENTION_DAYS: "45" });
  assert.deepEqual(await getRetentionPolicy(env), { event_days: 12, sms_days: 45, revision: 0, updated_at: null });
  const before = history(db);
  assert.deepEqual(await getRetentionPolicy({ ...env, SMS_RETENTION_DAYS: "0" }), { event_days: 12, sms_days: 0, revision: 0, updated_at: null });
  assert.deepEqual(history(db), before);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_retention_policy").n, 0);
  for (const event_days of [undefined, "", " ", -1, 0, 91, 1.2, "7", null, true]) {
    await assert.rejects(saveRetentionPolicy(env, { event_days, sms_days: 0 }), status(400));
  }
  const saved = await saveRetentionPolicy(env, { event_days: 1, sms_days: 90, revision: 0 });
  assert.equal(saved.revision, 1);
  assert.equal(saved.event_days, 1);
  assert.equal(saved.sms_days, 90);
  assert.deepEqual(await getRetentionPolicy({ ...env, EVENT_RETENTION_DAYS: "50" }), saved);
  assert.deepEqual(await saveRetentionPolicy(env, { event_days: 1, sms_days: 90, revision: 1 }), saved);
  await assert.rejects(saveRetentionPolicy(env, { event_days: 2, sms_days: 2, revision: 0 }), status(409));
  assert.deepEqual(await getRetentionPolicy(env), saved);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_retention_revisions").n, 1);
});

test("SMS fallback requires an explicit valid value, maps zero to permanent and never persists defaults", async (t) => {
  const { db, env } = fixture(t);
  for (const value of [undefined, null, "", " ", "\t", -1, 91, 1.5, "invalid", "1e-324", "-1e-324", "0x0", true, false, {}, []]) {
    assert.equal((await getRetentionPolicy({ ...env, SMS_RETENTION_DAYS: value })).sms_days, 30);
  }
  for (const value of [0, "0", " 0 "]) {
    assert.equal((await getRetentionPolicy({ ...env, SMS_RETENTION_DAYS: value })).sms_days, 0);
  }
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_retention_policy").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_retention_revisions").n, 0);
});

for (const initialDays of [0, null]) test(`SMS policy accepts ${initialDays} and its permanent equivalent, with revisions only for semantic changes`, async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t, { SMS_RETENTION_DAYS: 45 });
  for (const sms_days of [undefined, "", " ", -1, 91, 1.2, "0", "7", "null", "permanent", true, false, {}, []]) {
    await assert.rejects(saveRetentionPolicy(env, { event_days: 7, sms_days }), status(400));
  }
  const permanent = await saveRetentionPolicy(env, { event_days: 7, sms_days: initialDays, revision: 0 });
  assert.equal(permanent.sms_days, 0);
  assert.equal(permanent.revision, 1);
  assert.equal(db.row("SELECT sms_days FROM history_retention_policy").sms_days, null);
  assert.deepEqual(await getRetentionPolicy({ ...env, SMS_RETENTION_DAYS: 1 }), permanent);
  time.advance(1000);
  assert.deepEqual(await saveRetentionPolicy(env, { event_days: 7, sms_days: 0, revision: 1 }), permanent);
  assert.deepEqual(await saveRetentionPolicy(env, { event_days: 7, sms_days: null, revision: 1 }), permanent);
  const finite = await saveRetentionPolicy(env, { event_days: 7, sms_days: 45, revision: 1 });
  assert.equal(finite.sms_days, 45);
  assert.equal(finite.revision, 2);
  time.advance(1000);
  assert.deepEqual(await saveRetentionPolicy(env, { event_days: 7, sms_days: 45, revision: 2 }), finite);
  const again = await saveRetentionPolicy(env, { event_days: 7, sms_days: 0, revision: 2 });
  assert.equal(again.sms_days, 0);
  assert.equal(again.revision, 3);
  assert.equal(db.row("SELECT sms_days FROM history_retention_policy").sms_days, null);
  await assert.rejects(saveRetentionPolicy(env, { event_days: 7, sms_days: 30, revision: 2 }), status(409));
  assert.deepEqual(await getRetentionPolicy(env), again);
  assert.deepEqual(db.rows("SELECT revision, sms_days, cutover FROM history_retention_revisions ORDER BY revision"), [
    { revision: 1, sms_days: null, cutover: time.seconds() - 2 },
    { revision: 2, sms_days: 45, cutover: time.seconds() - 1 },
    { revision: 3, sms_days: null, cutover: time.seconds() },
  ]);
});

for (const smsDays of [4, 0]) test(`new ingest and outgoing queue use D1 SMS policy ${smsDays}, not stale fallback or command TTL`, async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t, { EVENT_RETENTION_DAYS: 89, SMS_RETENTION_DAYS: 88 });
  await manual(env);
  await saveRetentionPolicy(env, { event_days: 2, sms_days: smsDays });
  const accepted = await acceptIncoming(env, { version: 1, device_id: "manual", event_id: "runtime-policy", type: "sms.received",
    data: { sender: "10086", content: "运行时策略" }, status: {} }, { id: "manual", name: "本地设备" });
  assert.equal(accepted.item.expires_at, time.seconds() + 2 * DAY);
  const incoming = db.row("SELECT * FROM sms_messages WHERE direction = 'incoming'");
  const expectedExpiry = smsDays === 0 ? null : time.seconds() + smsDays * DAY;
  assert.equal(incoming.expires_at, expectedExpiry);
  assert.equal(incoming.retention_revision, 1);
  const queued = await sms(env);
  assert.equal(queued.item.expires_at, expectedExpiry);
  assert.equal(db.row("SELECT retention_expires_at FROM sms_commands WHERE id = ?", queued.command.id).retention_expires_at, expectedExpiry);
  assert.equal(queued.command.expires_at, time.seconds() + 600);
  assert.equal(db.row("SELECT retention_revision FROM sms_commands WHERE id = ?", queued.command.id).retention_revision, 1);
});

test("preview is history-read-only, validates filters, signs opaque scope and rejects tamper, confirmation or expiry", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  seedEvent(db, event(time, "preview"));
  const before = history(db);
  const preview = await previewCleanup(env, { kind: "events", mode: "all", device_id: "manual" });
  assert.deepEqual(history(db), before);
  assert.equal(preview.matched, 1);
  assert.equal(preview.eligible, 1);
  assert.equal(preview.skipped, 0);
  assert.match(preview.preview_token, /^[A-Za-z0-9_-]{43}\.0\.[A-Za-z0-9_-]{43}$/);
  assert.ok(!preview.preview_token.includes("manual"));
  await assert.rejects(executeCleanup(env, { preview_token: preview.preview_token, confirm: "清理" }), status(400));
  const tail = preview.preview_token.endsWith("A") ? "B" : "A";
  await assert.rejects(executeCleanup(env, { preview_token: preview.preview_token.slice(0, -1) + tail, confirm: "清空全部" }), status(400));
  await assert.rejects(executeCleanup({ ...env, APP_SECRET: "a-different-local-application-secret-12345" }, { preview_token: preview.preview_token, confirm: "清空全部" }), status(400));
  await assert.rejects(executeCleanup(env, { preview_token: preview.preview_token.replace(".0.", ".1."), confirm: "清空全部" }), status(400));
  for (const input of [{ kind: "all", mode: "all" }, { kind: "events", mode: "before", before: "2026-11-20" },
    { kind: "sms", mode: "before", before: "2026-11-20T08:00:00" }, { kind: "events", mode: "anything" }]) {
    await assert.rejects(previewCleanup(env, input), status(400));
  }
  assert.deepEqual(history(db), before);
  time.advance(15 * 60_000);
  await assert.rejects(executeCleanup(env, { preview_token: preview.preview_token, confirm: "清空全部" }), status(410));
  assert.deepEqual(history(db), before);
  assert.equal((await expireCleanupPreviews(env)).deleted, 1);
});

test("before is exclusive timezone-normalized received time and cleanup respects the exact device", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  seedEvent(db, event(time, "earlier", { received_at: "2026-11-20T07:59:59.999Z" }));
  seedEvent(db, event(time, "boundary"));
  seedEvent(db, event(time, "other-device", { device_id: "other", received_at: "2026-11-19T00:00:00.000Z" }));
  const preview = await previewCleanup(env, { kind: "events", mode: "before", device_id: "manual", before: "2026-11-20T16:00:00+08:00" });
  assert.equal(preview.cutoff, "2026-11-20T08:00:00.000Z");
  assert.equal(preview.matched, 1);
  assert.deepEqual(await executeCleanup(env, { preview_token: preview.preview_token, confirm: "清理" }), { deleted: 1, skipped: 0, remaining: 0, done: true });
  assert.deepEqual(db.rows("SELECT json_extract(value, '$.event_id') AS id FROM relay_records WHERE key GLOB 'events:*' ORDER BY key").map((row) => row.id), ["boundary", "other-device"]);
});

test("all is pinned by monotonic insertion sequence, is bounded to 200, and concurrent/replayed tokens are exact no-ops", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  for (let n = 0; n < 451; n++) seedEvent(db, event(time, `batch-${String(n).padStart(3, "0")}`));
  const preview = await previewCleanup(env, { kind: "events", mode: "all" });
  assert.equal(preview.matched, 451);
  // Deliberately do not advance the clock: equal timestamps must still be safe.
  seedEvent(db, event(time, "future-same-millisecond"));
  const inputs = { preview_token: preview.preview_token, confirm: "清空全部" };
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => executeCleanup(env, inputs)));
  for (const result of concurrent) assert.deepEqual(result, concurrent[0]);
  const first = concurrent[0];
  assert.equal(first.deleted, 200);
  assert.equal(first.remaining, 251);
  assert.equal(first.done, false);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*'").n, 252);
  assert.deepEqual(await executeCleanup(env, inputs), first);
  const second = await executeCleanup(env, { preview_token: first.preview_token, confirm: "清空全部" });
  assert.equal(second.deleted, 200);
  assert.equal(second.remaining, 51);
  const third = await executeCleanup(env, { preview_token: second.preview_token, confirm: "清空全部" });
  assert.deepEqual(third, { deleted: 51, skipped: 0, remaining: 0, done: true });
  assert.deepEqual(db.rows("SELECT key FROM relay_records WHERE key GLOB 'events:*'"), [{ key: "events:manual:future-same-millisecond" }]);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_receipts WHERE scope = 'events' AND cleared = 1").n, 451);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_cleanup_targets").n, 0);
});

test("event erasure skips live pending and leases and physically removes only the same parent's children", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const store = dataStore(env);
  await manual(env);
  await putJson(store, keys.latest("manual"), { status: { signal: -75 }, last_seen: new Date().toISOString() });
  await putJson(store, "channels:keep", { sealed_config: "local-sealed-config" });
  const one = seedEvent(db, event(time, "one"));
  const prefix = seedEvent(db, event(time, "one-more"));
  const pending = seedEvent(db, event(time, "pending"));
  const leased = seedEvent(db, event(time, "leased"));
  for (const item of [one, prefix]) {
    await putJson(store, `timeline:0000000000000:${item.device_id}:${item.event_id}`, { eventKey: keys.event(item.device_id, item.event_id), received_at: item.received_at });
    await putJson(store, keys.delivery(item.device_id, item.event_id, "channel"), { state: "failed", error: "清除的渲染记录" });
    await putJson(store, keys.sent(item.device_id, item.event_id, "other"), { state: "sent" });
  }
  await putJson(store, keys.pending("manual", pending.event_id), { device_id: "manual", event_id: pending.event_id });
  const lease = await store.claimDelivery("manual", leased.event_id, "channel", leased.expires_at, time.now());
  assert.ok(lease);
  const keep = db.rows("SELECT * FROM relay_records WHERE key GLOB 'devices:*' OR key GLOB 'device-tokens:*' OR key GLOB 'latest:*' OR key GLOB 'channels:*' ORDER BY key");
  const preview = await previewCleanup(env, { kind: "events", mode: "all" });
  assert.equal(preview.matched, 4);
  assert.equal(preview.eligible, 2);
  assert.equal(preview.skipped, 2);
  assert.deepEqual(await executeCleanup(env, { preview_token: preview.preview_token, confirm: "清空全部" }), { deleted: 2, skipped: 2, remaining: 0, done: true });
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'timeline:*' OR key GLOB 'deliveries:*' OR key GLOB 'sent:*'").n, 0);
  assert.deepEqual(db.rows("SELECT * FROM relay_records WHERE key GLOB 'devices:*' OR key GLOB 'device-tokens:*' OR key GLOB 'latest:*' OR key GLOB 'channels:*' ORDER BY key"), keep);
  assert.ok(await store.get(keys.event("manual", "pending")));
  assert.ok(await store.get(keys.event("manual", "leased")));
  assert.equal(db.row("SELECT COUNT(*) AS n FROM device_registry").n, 1);
});

test("preview/execute activity race rechecks authoritative pending and leases inside the erasure transaction", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const item = seedEvent(db, event(time, "race-active"));
  const preview = await previewCleanup(env, { kind: "events", mode: "all" });
  db.beforeBatch = (statements) => {
    if (!statements.some(({ sql }) => sql.includes("INSERT INTO history_cleanup_batches"))) return;
    db.beforeBatch = undefined;
    db.sqlite.prepare("INSERT INTO relay_records (key, value, expires_at) VALUES (?, ?, ?)")
      .run(keys.pending("manual", item.event_id), '{"device_id":"manual","event_id":"race-active"}', item.expires_at);
  };
  assert.deepEqual(await executeCleanup(env, { preview_token: preview.preview_token, confirm: "清空全部" }), { deleted: 0, skipped: 1, remaining: 0, done: true });
  assert.ok(await dataStore(env).get(keys.event("manual", item.event_id)));
});

test("event and SMS cleanup are distinct, incoming cleared IDs ACK no-op and stale child writers cannot resurrect", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const store = dataStore(env);
  const device = { id: "manual", name: "本地设备" };
  const input = { version: 1, device_id: "manual", event_id: "separate-scopes", type: "sms.received", data: { sender: "10086", content: "敏感正文" }, status: {} };
  const accepted = await acceptIncoming(env, input, device);
  const archived = db.row("SELECT id FROM sms_messages");
  const clearedSms = await clear(env, "sms");
  assert.equal(clearedSms.result.deleted, 1);
  assert.ok(await store.get(keys.event("manual", input.event_id)));
  assert.equal(await archiveSms(env, accepted.item), null);
  assert.equal((await acceptIncoming(env, input, device)).created, false);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 0);
  await clear(env, "events");
  const latest = await store.get(keys.latest("manual"));
  const replay = await acceptIncoming(env, input, device);
  await assert.rejects(acceptIncoming(env, { ...input, data: { sender: "10010", content: "同 ID 不同正文仍为冲突" } }, device), status(409));
  assert.equal(replay.cleared, true);
  assert.equal(replay.created, false);
  assert.equal(replay.dispatch, false);
  assert.equal(replay.item.event_id, input.event_id);
  assert.equal(replay.item.data, undefined);
  await updateDeviceStatus(store, replay.item);
  assert.equal(await store.get(keys.latest("manual")), latest);
  await putJson(store, keys.pending("manual", input.event_id), { event_id: input.event_id });
  await putJson(store, keys.sent("manual", input.event_id, "channel"), { state: "sent" });
  assert.equal(await store.claimDelivery("manual", input.event_id, "channel", time.seconds() + DAY, time.now()), null);
  assert.equal(await dispatchEvent(env, replay.item), 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*' OR key GLOB 'pending:*' OR key GLOB 'sent:*'").n, 0);
  await assert.rejects(getSms(env, archived.id), status(404));
  const receipts = JSON.stringify(db.rows("SELECT * FROM history_receipts"));
  assert.ok(!receipts.includes("manual") && !receipts.includes("敏感正文") && !receipts.includes("10086"));
});

test("SMS cleanup skips queued/dispatched authority despite misleading history status, and purged UUIDs never resend", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const hash = await manual(env);
  const sessionId = newToken();
  await activateSmsSession(env, "manual", hash, sessionId);
  const first = await sms(env, "先提交");
  const dispatched = await nextSmsCommand(env, "manual", hash, sessionId);
  assert.equal(dispatched.id, first.command.id);
  await recordSmsResult(env, "manual", { command_id: dispatched.id, status: "submitted" });
  const second = await sms(env, "在途跳过");
  await nextSmsCommand(env, "manual", hash, sessionId);
  const third = await sms(env, "排队跳过");
  db.sqlite.prepare("UPDATE sms_messages SET send_status = 'failed' WHERE command_id IN (?, ?)").run(second.command.id, third.command.id);
  const beforeActive = db.rows("SELECT * FROM sms_commands WHERE id IN (?, ?) ORDER BY id", second.command.id, third.command.id);
  const { preview, result } = await clear(env, "sms");
  assert.equal(preview.eligible, 1);
  assert.equal(preview.skipped, 2);
  assert.deepEqual(result, { deleted: 1, skipped: 2, remaining: 0, done: true });
  assert.deepEqual(db.rows("SELECT * FROM sms_commands WHERE id IN (?, ?) ORDER BY id", second.command.id, third.command.id), beforeActive);
  const tombstone = db.row("SELECT * FROM sms_commands WHERE id = ?", first.command.id);
  assert.equal(tombstone.purged_at, time.seconds());
  assert.equal(tombstone.content, ""); assert.equal(tombstone.peer, ""); assert.equal(tombstone.credential_hash, "");
  assert.equal(tombstone.request_id, first.input.request_id);
  await assert.rejects(queueSms(env, first.input), status(410));
  await assert.rejects(queueSms(env, { ...first.input, content: "不同内容" }), status(409));
  assert.equal((await nextSmsCommand(env, "manual", hash, sessionId)).id, second.command.id);
});

test("reconciliation updates prior-live history and children, preserves dead history across delayed policy edits and never changes command TTL", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const store = dataStore(env);
  await manual(env);
  const live = seedEvent(db, event(time, "live", { received_at: new Date(time.now() - 2 * DAY * 1000).toISOString(), expires_at: time.seconds() + 5 * DAY }));
  const dead = seedEvent(db, event(time, "dead", { received_at: new Date(time.now() - 8 * DAY * 1000).toISOString(), expires_at: time.seconds() - DAY }));
  await putJson(store, keys.pending("manual", live.event_id), { device_id: "manual", event_id: live.event_id });
  await putJson(store, keys.delivery("manual", live.event_id, "channel"), { state: "sent" });
  const queued = await sms(env);
  const oldTtl = queued.command.expires_at;
  await saveRetentionPolicy(env, { event_days: 30, sms_days: 60 });
  const result = await reconcileRetention(env);
  assert.equal(result.done, true);
  const extended = await store.get(keys.event("manual", "live"), "json");
  assert.equal(extended.expires_at, Math.floor(Date.parse(live.received_at) / 1000) + 30 * DAY);
  assert.equal(db.row("SELECT expires_at FROM relay_records WHERE key = ?", keys.pending("manual", "live")).expires_at, extended.expires_at);
  assert.equal(db.row("SELECT expires_at FROM relay_records WHERE key = ?", keys.delivery("manual", "live", "channel")).expires_at, extended.expires_at);
  assert.equal(db.row("SELECT expires_at FROM relay_records WHERE key = ?", keys.event("manual", dead.event_id)).expires_at, dead.expires_at);
  assert.equal(db.row("SELECT retention_expires_at FROM sms_commands WHERE id = ?", queued.command.id).retention_expires_at, time.seconds() + 60 * DAY);
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", queued.item.id).expires_at, time.seconds() + 60 * DAY);
  assert.equal(db.row("SELECT expires_at FROM sms_commands WHERE id = ?", queued.command.id).expires_at, oldTtl);
  // Revisions 2 and 3 are intentionally both saved before reconciliation.
  await saveRetentionPolicy(env, { event_days: 1, sms_days: 1 });
  time.advance(1000);
  await saveRetentionPolicy(env, { event_days: 90, sms_days: 90 });
  await reconcileRetention(env);
  assert.equal(await store.get(keys.event("manual", "live")), null);
  assert.equal(db.row("SELECT expires_at FROM relay_records WHERE key = ?", keys.event("manual", "live")).expires_at, Math.floor(Date.parse(live.received_at) / 1000) + DAY);
  const replay = await store.createEvent(event(time, "live"));
  assert.equal(replay.cleared, true);
});

test("permanent reconciliation handles messages and command-only history without reviving dead rows or changing TTLs", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  await manual(env);
  const live = await archiveSms(env, seedEvent(db, event(time, "live-to-permanent", {
    received_at: new Date(time.now() - 2 * DAY * 1000).toISOString(),
  })));
  const dead = await archiveSms(env, seedEvent(db, event(time, "dead-stays-finite")));
  db.sqlite.prepare("UPDATE sms_messages SET expires_at = ? WHERE id = ?").run(time.seconds(), dead.id);
  const queued = await sms(env);
  const orphan = await sms(env, "command-only history");
  db.sqlite.prepare("DELETE FROM sms_messages WHERE id = ?").run(orphan.item.id);
  const commandTtls = db.rows("SELECT id, expires_at FROM sms_commands ORDER BY id");
  async function reconcileAll() {
    while (!(await reconcileRetention(env, 1)).done) { /* exercise durable revision keysets */ }
  }
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 0 });
  await reconcileAll();
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", live.id).expires_at, null);
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", dead.id).expires_at, time.seconds());
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", queued.item.id).expires_at, null);
  assert.ok(db.rows("SELECT retention_expires_at FROM sms_commands").every((row) => row.retention_expires_at === null));

  // Save both revisions before bounded reconciliation. The shorter revision kills
  // the two-day-old SMS, and the following permanent revision must not revive it.
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 1 });
  time.advance(1000);
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 0 });
  await reconcileAll();
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", live.id).expires_at, Math.floor(Date.parse(live.received_at) / 1000) + DAY);
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", dead.id).expires_at, time.seconds() - 1);
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", queued.item.id).expires_at, null);
  assert.ok(db.rows("SELECT retention_expires_at FROM sms_commands").every((row) => row.retention_expires_at === null));

  await saveRetentionPolicy(env, { event_days: 7, sms_days: 4 });
  await reconcileAll();
  const finiteExpiry = Math.floor(Date.parse(queued.item.received_at) / 1000) + 4 * DAY;
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", queued.item.id).expires_at, finiteExpiry);
  assert.ok(db.rows("SELECT retention_expires_at FROM sms_commands").every((row) => row.retention_expires_at === finiteExpiry));
  time.advance(5 * DAY * 1000);
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 0 });
  await reconcileAll();
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", queued.item.id).expires_at, finiteExpiry);
  assert.ok(db.rows("SELECT retention_expires_at FROM sms_commands").every((row) => row.retention_expires_at === finiteExpiry));
  assert.ok(db.rows("SELECT retention_revision FROM sms_commands").every((row) => row.retention_revision === 5));
  assert.deepEqual(db.rows("SELECT id, expires_at FROM sms_commands ORDER BY id"), commandTtls);
});

for (const mode of ["before", "all"]) test(`manual ${mode} cleanup can erase permanent SMS but not active command authority`, async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const hash = await manual(env);
  const sessionId = newToken();
  await activateSmsSession(env, "manual", hash, sessionId);
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 0 });
  const received = seedEvent(db, event(time, "permanent-manual-cleanup"));
  const incoming = await archiveSms(env, received);
  const submitted = await sms(env);
  await nextSmsCommand(env, "manual", hash, sessionId);
  await recordSmsResult(env, "manual", { command_id: submitted.command.id, status: "submitted" });
  const dispatched = await sms(env, "permanent dispatched");
  await nextSmsCommand(env, "manual", hash, sessionId);
  const queued = await sms(env, "permanent queued");
  const orphan = await sms(env, "permanent command-only history");
  db.sqlite.prepare("UPDATE sms_commands SET status = 'failed' WHERE id = ?").run(orphan.command.id);
  db.sqlite.prepare("DELETE FROM sms_messages WHERE id = ?").run(orphan.item.id);
  db.sqlite.prepare("UPDATE sms_messages SET send_status = 'failed' WHERE id IN (?, ?)").run(dispatched.item.id, queued.item.id);
  const beforeActive = db.rows("SELECT * FROM sms_commands WHERE status IN ('queued', 'dispatched') ORDER BY id");
  const expired = await previewCleanup(env, { kind: "sms", mode: "expired" });
  assert.equal(expired.matched, 0);
  assert.equal((await executeCleanup(env, { preview_token: expired.preview_token, confirm: "清理" })).deleted, 0);
  assert.equal((await cleanupExpiredHistory(env, "sms")).deleted, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 4);
  const { preview, result } = await clear(env, "sms", { mode, device_id: "manual", before: new Date(time.now() + 1000).toISOString() });
  assert.equal(preview.matched, 5);
  assert.equal(preview.eligible, 3);
  assert.deepEqual(result, { deleted: 3, skipped: 2, remaining: 0, done: true });
  assert.deepEqual(db.rows("SELECT * FROM sms_commands WHERE status IN ('queued', 'dispatched') ORDER BY id"), beforeActive);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 2);
  for (const item of [submitted, orphan]) {
    assert.equal(db.row("SELECT purged_at FROM sms_commands WHERE id = ?", item.command.id).purged_at, time.seconds());
    await assert.rejects(queueSms(env, item.input), status(410));
    await assert.rejects(recordSmsResult(env, "manual", { command_id: item.command.id, status: "submitted" }), status(404));
  }
  assert.equal(await archiveSms(env, received), null);
  await assert.rejects(getSms(env, incoming.id), status(404));
});

test("expired cleanup and manual expired previews wait for permanent reconciliation of stale finite SMS rows", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 30 });
  const received = seedEvent(db, event(time, "permanent-sms-backlog"));
  const item = await archiveSms(env, received);
  const oldExpiry = db.row("SELECT expires_at FROM sms_messages WHERE id = ?", item.id).expires_at;
  assert.equal(oldExpiry, time.seconds() + 30 * DAY);
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 0, revision: 1 });
  const stale = db.row("SELECT expires_at, retention_revision FROM sms_messages WHERE id = ?", item.id);
  assert.equal(stale.expires_at, oldExpiry);
  assert.equal(stale.retention_revision, 1);
  time.advance(31 * DAY * 1000);

  assert.equal((await cleanupExpiredHistory(env, "sms")).deleted, 0);
  const preview = await previewCleanup(env, { kind: "sms", mode: "expired" });
  assert.equal(preview.matched, 0);
  assert.equal(preview.eligible, 0);
  assert.equal((await executeCleanup(env, { preview_token: preview.preview_token, confirm: "清理" })).deleted, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages WHERE id = ?", item.id).n, 1);

  await reconcileRetention(env);
  assert.deepEqual(db.row("SELECT expires_at, retention_revision FROM sms_messages WHERE id = ?", item.id), {
    expires_at: null, retention_revision: 2,
  });
  assert.equal((await cleanupExpiredHistory(env, "sms")).deleted, 0);
  const after = await previewCleanup(env, { kind: "sms", mode: "expired" });
  assert.equal(after.matched, 0);
  assert.equal((await executeCleanup(env, { preview_token: after.preview_token, confirm: "清理" })).deleted, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages WHERE id = ?", item.id).n, 1);
});

test("Cron preserves SMS and command-only history behind an event reconciliation backlog", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  t.mock.method(globalThis, "fetch", async () => assert.fail("retention Cron must not send notifications"));
  await manual(env);
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 1 });
  for (let n = 0; n < 201; n++) seedEvent(db, event(time, `permanent-backlog-${String(n).padStart(3, "0")}`));
  db.sqlite.exec("UPDATE relay_records SET retention_revision = 1 WHERE key GLOB 'events:*'");
  const item = await archiveSms(env, event(time, "permanent-backlog-000"));
  const orphan = await sms(env, "command-only behind events");
  db.sqlite.prepare("UPDATE sms_commands SET status = 'failed' WHERE id = ?").run(orphan.command.id);
  db.sqlite.prepare("DELETE FROM sms_messages WHERE id = ?").run(orphan.item.id);
  await saveRetentionPolicy(env, { event_days: 90, sms_days: 0, revision: 1 });
  time.advance(8 * DAY * 1000);

  await worker.scheduled({ cron: RETRY_CRON }, env);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*'").n, 201);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*' AND retention_revision = 1").n, 1);
  assert.deepEqual(db.row("SELECT expires_at, retention_revision FROM sms_messages WHERE id = ?", item.id), {
    expires_at: time.seconds() - 7 * DAY, retention_revision: 1,
  });
  assert.deepEqual(db.row("SELECT purged_at, retention_revision, expires_at FROM sms_commands WHERE id = ?", orphan.command.id), {
    purged_at: null, retention_revision: 1, expires_at: orphan.command.expires_at,
  });
  for (const kind of ["events", "sms"]) assert.equal((await previewCleanup(env, { kind, mode: "expired" })).matched, 0);

  await worker.scheduled({ cron: RETRY_CRON }, env);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*' AND retention_revision = 2").n, 201);
  assert.deepEqual(db.row("SELECT expires_at, retention_revision FROM sms_messages WHERE id = ?", item.id), {
    expires_at: null, retention_revision: 2,
  });
  assert.deepEqual(db.row("SELECT retention_expires_at, retention_revision, expires_at, purged_at FROM sms_commands WHERE id = ?", orphan.command.id), {
    retention_expires_at: null, retention_revision: 2, expires_at: orphan.command.expires_at, purged_at: null,
  });
});

for (const kind of ["events", "sms"]) for (const path of ["manual", "automatic"]) {
  test(`${path} expired ${kind} cleanup rechecks the revision inside the erasure transaction`, async (t) => {
    const time = clock(t);
    const { db, env } = fixture(t);
    await saveRetentionPolicy(env, { event_days: 1, sms_days: 1 });
    const received = event(time, "revision-erasure-race", { expires_at: time.seconds() + DAY });
    if (kind === "events") {
      seedEvent(db, received);
      db.sqlite.exec("UPDATE relay_records SET retention_revision = 1 WHERE key GLOB 'events:*'");
    } else {
      await archiveSms(env, seedEvent(db, received));
    }
    time.advance(DAY * 1000);
    const preview = await previewCleanup(env, { kind, mode: "expired" });
    assert.equal(preview.matched, 1);
    let raced = false;
    db.beforeBatch = (statements) => {
      if (!statements.some(({ sql }) => sql.includes("INSERT INTO history_cleanup_batches"))) return;
      db.beforeBatch = undefined;
      db.sqlite.prepare("UPDATE history_retention_policy SET event_days = 90, sms_days = NULL, revision = revision + 1, updated_at = ?")
        .run(new Date(time.now()).toISOString());
      db.sqlite.prepare("INSERT INTO history_retention_revisions SELECT revision, event_days, sms_days, ? FROM history_retention_policy")
        .run(time.seconds());
      raced = true;
    };
    const result = path === "manual" ? await executeCleanup(env, { preview_token: preview.preview_token, confirm: "清理" })
      : await cleanupExpiredHistory(env, kind);
    assert.equal(raced, true);
    assert.equal(result.deleted, 0);
    assert.equal(result.skipped, 1);
    assert.equal((await previewCleanup(env, { kind, mode: "expired" })).matched, 0);
    assert.equal((await previewCleanup(env, { kind, mode: "all" })).matched, 1);
    assert.equal((await previewCleanup(env, { kind, mode: "before", before: new Date(time.now()).toISOString() })).matched, 1);
    await reconcileRetention(env);
    // The old deadline was already reached at cutover: reconciliation preserves
    // it, so the current-revision row becomes eligible rather than being revived.
    assert.equal((await cleanupExpiredHistory(env, kind)).deleted, 1);
  });
}

test("reconciliation and automatic expiry are bounded keyset work, tolerate cleanup races and preserve configuration/latest", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  for (let n = 0; n < 251; n++) seedEvent(db, event(time, `reconcile-${String(n).padStart(3, "0")}`));
  await saveRetentionPolicy(env, { event_days: 2, sms_days: 3 });
  assert.equal((await reconcileRetention(env)).reconciled, 200);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*' AND retention_revision = 1").n, 200);
  assert.equal((await reconcileRetention(env)).reconciled, 51);
  assert.equal((await reconcileRetention(env)).reconciled, 0);
  await assert.rejects(reconcileRetention(env, 201), status(400));
  time.advance(3 * DAY * 1000);
  const preview = await previewCleanup(env, { kind: "events", mode: "expired" });
  assert.equal((await cleanupExpiredHistory(env, "events")).deleted, 200);
  // The old preview can race Cron and counts only the remaining real parents.
  const result = await executeCleanup(env, { preview_token: preview.preview_token, confirm: "清理" });
  assert.equal(result.deleted, 51);
  assert.equal(result.done, true);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*'").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_receipts WHERE scope = 'events'").n, 251);
});

test("a failed cleanup transaction rolls back receipts, children, parents and token progress, then retries safely", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const item = seedEvent(db, event(time, "rollback"));
  await putJson(dataStore(env), keys.delivery("manual", item.event_id, "channel"), { state: "failed" });
  const preview = await previewCleanup(env, { kind: "events", mode: "all" });
  const before = history(db);
  db.failSql = (sql) => sql.includes("DELETE FROM relay_records WHERE key IN");
  await assert.rejects(executeCleanup(env, { preview_token: preview.preview_token, confirm: "清空全部" }), /simulated D1/);
  db.failSql = undefined;
  assert.deepEqual(history(db), before);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_receipts").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_cleanup_batches").n, 0);
  assert.equal((await executeCleanup(env, { preview_token: preview.preview_token, confirm: "清空全部" })).deleted, 1);
});

test("existing retry Cron performs bounded reconciliation and receipt-aware erasure without new jobs or notifications", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  for (let n = 0; n < 251; n++) seedEvent(db, event(time, `cron-${String(n).padStart(3, "0")}`, { expires_at: time.seconds() - 1 }));
  const store = dataStore(env);
  await putJson(store, "channels:keep", { id: "keep", enabled: false, sealed_config: "preserve" });
  await putJson(store, keys.latest("manual"), { status: { signal: -75 } });
  await saveRetentionPolicy(env, { event_days: 90, sms_days: 90 });
  const kept = db.rows("SELECT * FROM relay_records WHERE key = 'channels:keep' OR key = 'latest:manual' ORDER BY key");
  await worker.scheduled({ cron: RETRY_CRON }, env);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*'").n, 51);
  assert.deepEqual(db.rows("SELECT * FROM relay_records WHERE key = 'channels:keep' OR key = 'latest:manual' ORDER BY key"), kept);
  await worker.scheduled({ cron: RETRY_CRON }, env);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*'").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_receipts WHERE cleared = 1").n, 251);
});

test("shortening history during a live delivery lease cannot erase the authoritative in-flight parent", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const store = dataStore(env);
  const item = seedEvent(db, event(time, "lease-cutover", { received_at: new Date(time.now() - 2 * DAY * 1000).toISOString() }));
  const lease = await store.claimDelivery("manual", item.event_id, "channel", item.expires_at, time.now());
  assert.ok(lease);
  await saveRetentionPolicy(env, { event_days: 1, sms_days: 30 });
  await reconcileRetention(env);
  assert.equal(db.row("SELECT expires_at FROM relay_records WHERE key = ?", keys.event("manual", item.event_id)).expires_at, time.seconds() - DAY);
  const preview = await previewCleanup(env, { kind: "events", mode: "expired" });
  assert.equal(preview.skipped, 1);
  assert.deepEqual(await executeCleanup(env, { preview_token: preview.preview_token, confirm: "清理" }), { deleted: 0, skipped: 1, remaining: 0, done: true });
  await store.releaseDelivery("manual", item.event_id, "channel", lease);
  assert.equal((await cleanupExpiredHistory(env, "events")).deleted, 1);
});

for (const smsDays of [90, 0]) test(`dead SMS cannot revive under SMS policy ${smsDays}, event replay, physical expiry or receipt age`, async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t, { SMS_RETENTION_DAYS: 1 });
  const device = { id: "manual", name: "本地设备" };
  const input = { version: 1, device_id: "manual", event_id: "dead-sms-live-event", type: "sms.received", data: { sender: "10086", content: "只保留一天" }, status: {} };
  const accepted = await acceptIncoming(env, input, device);
  const originalExpiry = db.row("SELECT expires_at FROM sms_messages").expires_at;
  time.advance(2 * DAY * 1000);
  await saveRetentionPolicy(env, { event_days: 90, sms_days: smsDays });
  await reconcileRetention(env);
  assert.equal(db.row("SELECT expires_at FROM sms_messages").expires_at, originalExpiry);
  assert.equal(await archiveSms(env, accepted.item), null);
  assert.equal((await cleanupExpiredHistory(env, "sms")).deleted, 1);
  assert.equal((await acceptIncoming(env, input, device)).created, false);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 0);
  await clear(env, "events");
  time.advance(120 * DAY * 1000);
  const replay = await acceptIncoming(env, input, device);
  assert.equal(replay.cleared, true);
  assert.equal(replay.created, false);
  assert.equal(await archiveSms(env, accepted.item), null);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_receipts").n, 2);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*'").n, 0);
});

test("expired event replay racing automatic cleanup is ACK-only and cannot create fresh history or children", async (t) => {
  const time = clock(t);
  const { db, env } = fixture(t);
  const store = dataStore(env);
  const item = event(time, "expire-race");
  await store.createEvent(item);
  time.advance(8 * DAY * 1000);
  const results = await Promise.all([
    store.cleanup(),
    store.createEvent({ ...item, received_at: new Date().toISOString(), expires_at: time.seconds() + 90 * DAY }),
    store.createEvent({ ...item, received_at: new Date().toISOString(), expires_at: time.seconds() + 90 * DAY }),
  ]);
  for (const replay of results.slice(1)) assert.equal(replay.cleared, true);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*'").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM history_receipts WHERE scope = 'events'").n, 1);
});
