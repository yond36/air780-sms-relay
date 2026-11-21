import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { dataStore } from "../src/db.js";
import { digest } from "../src/security.js";
import { saveRetentionPolicy } from "../src/retention.js";
import { activateSmsSession, archiveSms, cancelDeviceSmsCommands, estimateSmsSegments, expireSms, getSms, listSms, nextSmsCommand, queueSms, recordSmsResult } from "../src/sms.js";
import { keys, putJson } from "../src/store.js";
import { clock, d1Fixture } from "./helpers/d1-sqlite.js";

const status = (expected) => (error) => error.status === expected;
const params = (values = {}) => new URLSearchParams(values);
const request = (overrides = {}) => ({ request_id: crypto.randomUUID(), device_id: "manual", to: "+8613800138000", content: "短信本地测试", ...overrides });
const session43 = () => randomBytes(32).toString("base64url");
const snapshot = (db) => ({
  registry: db.rows("SELECT * FROM device_registry ORDER BY id"),
  commands: db.rows("SELECT * FROM sms_commands ORDER BY id"),
  messages: db.rows("SELECT * FROM sms_messages ORDER BY id"),
  records: db.rows("SELECT * FROM relay_records ORDER BY key"),
});

async function activeSession(env, id, hash) {
  const sessionId = session43();
  await activateSmsSession(env, id, hash, sessionId);
  return sessionId;
}

// In-memory legacy/backlog fixtures intentionally bypass live queue limits.
function copyCommands(db, sourceId, count, overrides = {}) {
  const source = db.row("SELECT * FROM sms_commands WHERE id = ?", sourceId);
  const message = db.row("SELECT * FROM sms_messages WHERE command_id = ?", sourceId);
  const commandColumns = Object.keys(source);
  const messageColumns = Object.keys(message);
  const insertCommand = db.sqlite.prepare(`INSERT INTO sms_commands (${commandColumns.join(",")}) VALUES (${commandColumns.map(() => "?").join(",")})`);
  const insertMessage = db.sqlite.prepare(`INSERT INTO sms_messages (${messageColumns.join(",")}) VALUES (${messageColumns.map(() => "?").join(",")})`);
  const ids = [];
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index++) {
      const command = { ...source, ...overrides, id: crypto.randomUUID(), request_id: crypto.randomUUID(), message_id: crypto.randomUUID() };
      const item = { ...message, id: command.message_id, command_id: command.id, send_status: command.status };
      insertCommand.run(...commandColumns.map((key) => command[key]));
      insertMessage.run(...messageColumns.map((key) => item[key]));
      ids.push(command.id);
    }
    db.sqlite.exec("COMMIT");
  } catch (error) {
    db.sqlite.exec("ROLLBACK");
    throw error;
  }
  return ids;
}

async function manual(env, id = "manual", extra = {}) {
  const store = dataStore(env);
  const hash = await digest(`local-test-token:${id}`);
  await putJson(store, keys.device(id), { id, name: `本地设备 ${id}`, enabled: true, ...extra });
  await putJson(store, keys.deviceToken(id), { hash });
  return hash;
}

async function incoming(env, time, overrides = {}) {
  const item = {
    version: 1, device_id: "manual", device_name: "本地设备 manual", event_id: crypto.randomUUID(), type: "sms.received",
    data: { sender: "+8613800138000", content: "验证码%_中文测试 🙂", sim_slot: 0, sms_time: "2026-11-20 16:00:00" },
    status: {}, routes: [], fingerprint: "incoming-fingerprint", occurred_at: new Date(time.now()).toISOString(),
    received_at: new Date(time.now()).toISOString(), expires_at: time.seconds() + 7 * 86400, ...overrides,
  };
  const saved = (await dataStore(env).createEvent(item)).item;
  return { event: saved, item: await archiveSms(env, saved) };
}

test("incoming archive is idempotent, uses the durable event winner and outlives the event TTL", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const received = await incoming(env, time);
  const duplicates = await Promise.all(Array.from({ length: 24 }, () => archiveSms(env, { ...received.event, data: { sender: "spoofed", content: "not saved" } })));
  for (const item of duplicates) assert.deepEqual(item, received.item);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 1);
  assert.deepEqual(received.item, {
    id: received.item.id, device_id: "manual", device_name: "本地设备 manual", direction: "incoming", peer: "+8613800138000",
    content: "验证码%_中文测试 🙂", occurred_at: new Date(time.now()).toISOString(), received_at: new Date(time.now()).toISOString(),
    send_status: "received", expires_at: time.seconds() + 30 * 86400, event_id: received.event.event_id,
    sim_slot: 0, sms_time: "2026-11-20 16:00:00",
  });
  assert.equal(await archiveSms(env, { type: "call.started" }), null);
  await assert.rejects(archiveSms(env, { ...received.event, event_id: "not-durable" }), status(409));
  time.advance(8 * 86400_000);
  assert.equal(await dataStore(env).get(keys.event("manual", received.event.event_id), "json"), null);
  await dataStore(env).cleanup();
  assert.deepEqual(await archiveSms(env, received.event), received.item);
  assert.deepEqual(await getSms(env, received.item.id), received.item);
});

for (const permanent of [false, true]) test(`SMS SQL filters and stable pages treat search literally with permanent=${permanent}`, async (t) => {
  const time = clock(t);
  const { env } = d1Fixture(t);
  if (permanent) await saveRetentionPolicy(env, { event_days: 7, sms_days: 0 });
  const expected = [];
  for (let n = 0; n < 30; n++) {
    const match = n % 4 === 0;
    const saved = await incoming(env, time, {
      device_id: n % 2 === 0 ? "manual" : "other",
      event_id: `search-${n}`,
      occurred_at: new Date(time.now() - n * 1000).toISOString(),
      data: { sender: n % 2 === 0 ? "+8610000" : "10010", content: match ? `验证码%_ 第${n}条` : `普通通知 ${n}` },
    });
    if (match) expected.push(saved.item);
  }
  const collected = [];
  let cursor;
  do {
    const page = await listSms(env, params({ device_id: "manual", q: "验证码%_", direction: "incoming", status: "received", limit: "3", ...(cursor ? { cursor } : {}) }));
    assert.ok(page.items.length > 0);
    collected.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(collected.map(({ id }) => id), expected.map(({ id }) => id));
  assert.equal((await listSms(env, params({ q: "%" }))).items.length, expected.length);
  assert.equal((await listSms(env, params({ q: "_" }))).items.length, expected.length);
  assert.equal((await listSms(env, params({ q: "' OR 1=1 --" }))).items.length, 0);
  assert.equal((await listSms(env, params({ peer: "+861" }))).items.length, 15);
  assert.equal((await listSms(env, params({ peer: "%" }))).items.length, 0);
  const first = await listSms(env, params({ q: "验证码%_", limit: "2" }));
  await assert.rejects(listSms(env, params({ q: "different", cursor: first.cursor })), status(400));
  await assert.rejects(listSms(env, params({ cursor: "not!a-cursor" })), status(400));
  await assert.rejects(listSms(env, params({ direction: "sent" })), status(400));
  await assert.rejects(listSms(env, params({ status: "delivered" })), status(400));
});

test("date filters use timezone ISO, inclusive from and exclusive to", async (t) => {
  const time = clock(t);
  const { env } = d1Fixture(t);
  for (let n = 0; n < 10; n++) {
    await incoming(env, time, { event_id: `range-${n}`, occurred_at: new Date(time.now() + n * 1000).toISOString() });
  }
  const page = await listSms(env, params({ from: "2026-11-20T16:00:00+08:00", to: "2026-11-20T08:00:05Z" }));
  assert.equal(page.items.length, 5);
  assert.ok(page.items.every((item) => item.occurred_at < "2026-11-20T08:00:05.000Z"));
  await assert.rejects(listSms(env, params({ from: "2026-11-20" })), status(400));
  await assert.rejects(listSms(env, params({ from: "1795161600" })), status(400));
  await assert.rejects(listSms(env, params({ from: "2026-11-20T08:00:00" })), status(400));
  await assert.rejects(listSms(env, params({ from: "2026-11-20T08:00:05Z", to: "2026-11-20T08:00:05Z" })), status(400));
  await assert.rejects(getSms(env, "missing-local-message"), status(404));
});

test("queue accepts international numeric recipients, BMP Chinese and accurate segment estimates", async (t) => {
  const time = clock(t);
  const { env } = d1Fixture(t);
  await manual(env);
  const input = request({ content: "中".repeat(500) });
  const result = await queueSms(env, input);
  assert.equal(result.item.direction, "outgoing");
  assert.equal(result.item.send_status, "queued");
  assert.equal(result.item.peer, "+8613800138000");
  assert.equal(result.item.command_id, result.command.id);
  assert.equal(result.command.expires_at, time.seconds() + 600);
  assert.equal(result.item.expires_at, time.seconds() + 30 * 86400);
  assert.equal(result.command.encoding, "ucs2");
  assert.equal(result.command.segments, 8);
  assert.equal(result.command.digest, createHash("sha256").update(`${input.to}\n${input.content}`).digest("hex"));
  assert.match(result.command.digest, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(result.command, "session_id"), false);
  assert.deepEqual(estimateSmsSegments("a".repeat(160)), { encoding: "gsm7", segments: 1 });
  assert.deepEqual(estimateSmsSegments("a".repeat(161)), { encoding: "gsm7", segments: 2 });
  assert.deepEqual(estimateSmsSegments("^".repeat(81)), { encoding: "gsm7", segments: 2 });
  assert.deepEqual(estimateSmsSegments("中".repeat(70)), { encoding: "ucs2", segments: 1 });
  assert.deepEqual(estimateSmsSegments("中".repeat(71)), { encoding: "ucs2", segments: 2 });
  await assert.rejects(queueSms(env, request({ to: "not-a-number" })), status(400));
  await assert.rejects(queueSms(env, request({ content: "中".repeat(501) })), status(400));
  await assert.rejects(queueSms(env, request({ content: "emoji 🙂" })), status(400));
  await assert.rejects(queueSms(env, request({ content: "unpaired \ud800" })), status(400));
  await assert.rejects(queueSms(env, request({ content: "a\0b" })), status(400));
  await assert.rejects(queueSms(env, request({ content: "  \n" })), status(400));
  await assert.rejects(queueSms(env, request({ request_id: "not-a-uuid" })), status(400));
});

test("SMS API distinguishes command expiry from history retention", async (t) => {
  clock(t);
  const { env } = d1Fixture(t);
  await manual(env);
  const queued = await queueSms(env, request());
  assert.equal(queued.item.command_expires_at, queued.command.expires_at);
  assert.ok(queued.item.expires_at > queued.command.expires_at + 86400);
  const detail = await getSms(env, queued.item.id);
  assert.equal(detail.command_expires_at, queued.command.expires_at);
  const page = await listSms(env, params({ direction: "outgoing" }));
  assert.equal(page.items[0].command_expires_at, queued.command.expires_at);
});

test("permanent incoming, queue/replay, reply, list/detail and late results retain NULL history but finite command TTLs", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t, { SMS_RETENTION_DAYS: 1 });
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 0 });
  const received = await incoming(env, time);
  assert.equal(received.item.expires_at, null);
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", received.item.id).expires_at, null);
  time.advance(8 * 86400_000);
  await dataStore(env).cleanup();
  assert.equal(await dataStore(env).get(keys.event("manual", received.event.event_id)), null);
  assert.deepEqual(await archiveSms(env, received.event), received.item);
  assert.deepEqual(await getSms(env, received.item.id), received.item);

  const input = request();
  const attempts = await Promise.all(Array.from({ length: 16 }, () => queueSms(env, input)));
  const queued = attempts[0];
  for (const attempt of attempts) assert.deepEqual(attempt, queued);
  const replyInput = request({ device_id: "spoofed-device", to: "10010", content: "回复永久短信" });
  const reply = await queueSms(env, replyInput, received.item.id);
  assert.equal(reply.item.device_id, "manual");
  assert.equal(reply.item.peer, received.item.peer);
  assert.equal(reply.item.reply_to, received.item.id);
  assert.deepEqual(await queueSms(env, replyInput, received.item.id), reply);
  for (const saved of [queued, reply]) {
    assert.equal(saved.item.expires_at, null);
    assert.equal(saved.command.expires_at, time.seconds() + 600);
    assert.equal(saved.item.command_expires_at, saved.command.expires_at);
    assert.equal(db.row("SELECT retention_expires_at FROM sms_commands WHERE id = ?", saved.command.id).retention_expires_at, null);
  }
  assert.equal((await listSms(env, params())).items.length, 3);
  assert.equal((await listSms(env, params({ direction: "incoming" }))).items[0].id, received.item.id);
  const dispatched = await nextSmsCommand(env, "manual", hash, sessionId);
  assert.ok(dispatched);
  assert.equal(dispatched.expires_at, time.seconds() + 600);
  assert.deepEqual(await nextSmsCommand(env, "manual", hash, sessionId), dispatched);
  time.advance(600_000);
  assert.deepEqual(await expireSms(env), { expired: 2, invalidated: 0, deleted: 0, purged: 0 });
  assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
  for (const saved of [queued, reply]) {
    const detail = await getSms(env, saved.item.id);
    assert.equal(detail.send_status, saved.command.id === dispatched.id ? "unknown" : "expired");
    assert.equal(detail.expires_at, null);
  }
  time.advance(365 * 86400_000);
  await recordSmsResult(env, "manual", { command_id: dispatched.id, status: "submitted" });
  await recordSmsResult(env, "manual", { command_id: dispatched.id, status: "failed", error: "迟到失败" });
  const completed = [queued, reply].find(({ command }) => command.id === dispatched.id);
  assert.equal((await getSms(env, completed.item.id)).send_status, "submitted");
  assert.equal((await queueSms(env, input)).item.expires_at, null);
  assert.equal((await queueSms(env, replyInput, received.item.id)).item.expires_at, null);
  assert.deepEqual(await expireSms(env), { expired: 0, invalidated: 0, deleted: 0, purged: 0 });
  assert.equal((await listSms(env, params())).items.length, 3);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands").n, 2);
});

for (const [label, overrides, days] of [
  ["default", {}, 30], ["configured", { SMS_RETENTION_DAYS: "2" }, 2],
  ["null environment", { SMS_RETENTION_DAYS: null }, 30], ["zero means permanent", { SMS_RETENTION_DAYS: "0" }, null],
  ["numeric zero means permanent", { SMS_RETENTION_DAYS: 0 }, null],
  ["blank environment", { SMS_RETENTION_DAYS: " " }, 30], ["boolean is not explicit zero", { SMS_RETENTION_DAYS: false }, 30],
  ["invalid environment", { SMS_RETENTION_DAYS: "not-days" }, 30],
  ["underflow is not explicit zero", { SMS_RETENTION_DAYS: "1e-324" }, 30],
]) test(`absent policy uses ${label} SMS fallback`, async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t, overrides);
  await manual(env);
  const received = await incoming(env, time);
  const queued = await queueSms(env, request());
  const expiry = days === null ? null : time.seconds() + days * 86400;
  assert.equal(received.item.expires_at, expiry);
  assert.equal(queued.item.expires_at, expiry);
  assert.equal(queued.command.expires_at, time.seconds() + 600);
  assert.equal(db.row("SELECT retention_expires_at FROM sms_commands WHERE id = ?", queued.command.id).retention_expires_at, expiry);
});

for (const path of ["incoming", "outgoing"]) for (const [initialDays, smsDays] of [[undefined, null], [3, null], [0, 3]]) {
  test(`${path} write rereads SMS policy ${initialDays} to ${smsDays} inside its transaction instead of using stale/default days`, async (t) => {
    const time = clock(t);
    const { db, env } = d1Fixture(t, { SMS_RETENTION_DAYS: 1 });
    await manual(env);
    if (initialDays !== undefined) await saveRetentionPolicy(env, { event_days: 7, sms_days: initialDays });
    let changed = false;
    db.beforeBatch = (statements) => {
      if (!statements.some(({ sql }) => sql.includes(path === "incoming" ? "INSERT INTO sms_messages" : "INSERT INTO sms_commands"))) return;
      db.beforeBatch = undefined;
      db.sqlite.prepare(`INSERT INTO history_retention_policy VALUES (1, 7, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET sms_days = excluded.sms_days, revision = revision + 1`)
        .run(smsDays, new Date(time.now()).toISOString());
      db.sqlite.prepare("INSERT INTO history_retention_revisions SELECT revision, event_days, sms_days, ? FROM history_retention_policy")
        .run(time.seconds());
      changed = true;
    };
    const saved = path === "incoming" ? await incoming(env, time) : await queueSms(env, request());
    assert.equal(changed, true);
    assert.equal(saved.item.expires_at, smsDays === null ? null : time.seconds() + smsDays * 86400);
    assert.equal(db.row("SELECT retention_revision FROM sms_messages WHERE id = ?", saved.item.id).retention_revision, initialDays === undefined ? 1 : 2);
  });
}

test("permanent archives still reject an invalid durable received timestamp", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  await saveRetentionPolicy(env, { event_days: 7, sms_days: 0 });
  const item = { device_id: "manual", event_id: "invalid-received-time", type: "sms.received", received_at: "invalid", data: { content: "invalid time" } };
  db.sqlite.prepare("INSERT INTO relay_records (key, value, expires_at) VALUES (?, ?, ?)")
    .run(keys.event(item.device_id, item.event_id), JSON.stringify(item), time.seconds() + 86400);
  await assert.rejects(archiveSms(env, item), status(409));
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 0);
});

test("a concurrent request UUID atomically creates one message and command, and conflicting payloads return 409", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  await manual(env);
  const input = request();
  const results = await Promise.all(Array.from({ length: 32 }, () => queueSms(env, input)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands").n, 1);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages WHERE direction = 'outgoing'").n, 1);
  assert.deepEqual(await queueSms(env, { ...input, request_id: input.request_id.toUpperCase() }), results[0]);
  await assert.rejects(queueSms(env, { ...input, content: "不同请求正文" }), status(409));
  await assert.rejects(queueSms(env, { ...input, to: "10086" }), status(409));
  const collision = crypto.randomUUID();
  const mixed = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => queueSms(env, request({ request_id: collision, content: `并发冲突${n}` }))));
  assert.equal(mixed.filter(({ status }) => status === "fulfilled").length, 1);
  for (const result of mixed.filter(({ status }) => status === "rejected")) assert.equal(result.reason.status, 409);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands").n, 2);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages WHERE direction = 'outgoing'").n, 2);
});

test("replies use the incoming record's device and number rather than client routing", async (t) => {
  const time = clock(t);
  const { env } = d1Fixture(t);
  await manual(env);
  const first = await incoming(env, time, { data: { sender: "+442079460000", content: "原短信" } });
  const input = request({ device_id: "spoofed-device", to: "10010", content: "原号码回复" });
  const reply = await queueSms(env, input, first.item.id);
  assert.equal(reply.item.device_id, "manual");
  assert.equal(reply.item.peer, "+442079460000");
  assert.equal(reply.item.reply_to, first.item.id);
  assert.deepEqual(await queueSms(env, { ...input, device_id: "different-spoof", to: "99999" }, first.item.id), reply);
  const second = await incoming(env, time);
  await assert.rejects(queueSms(env, input, second.item.id), status(409));
  await assert.rejects(queueSms(env, request(), reply.item.id), status(400));
  const unreplyable = await incoming(env, time, { data: { sender: "ALPHANUMERIC", content: "发件地址不是号码" } });
  await assert.rejects(queueSms(env, request(), unreplyable.item.id), status(400));
});

test("disabled, unbound and deleted devices cannot queue SMS", async (t) => {
  clock(t);
  const { env } = d1Fixture(t);
  await manual(env);
  const store = dataStore(env);
  await store.updateDeviceRecord("manual", { enabled: false });
  await assert.rejects(queueSms(env, request()), status(403));
  await store.updateDeviceRecord("manual", { enabled: true });
  await store.rebindDeviceRecord("manual");
  await assert.rejects(queueSms(env, request()), status(409));
  await store.deleteDeviceRecord("manual");
  await assert.rejects(queueSms(env, request()), status(404));
  await assert.rejects(queueSms(env, request({ device_id: "missing-device" })), status(404));
});

test("SQL rate gates enforce a minute rate under concurrent queue attempts", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  await manual(env);
  const results = await Promise.allSettled(Array.from({ length: 24 }, (_, n) => queueSms(env, request({ content: `本地速率${n}` }))));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 10);
  for (const result of results.filter(({ status }) => status === "rejected")) assert.equal(result.reason.status, 429);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'queued'").n, 10);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 10);
});

test("SQL capacity gates never allow more than 16 in-flight commands", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t, { SMS_RATE_LIMIT_PER_MINUTE: 30, SMS_RATE_LIMIT_PER_HOUR: 300 });
  await manual(env);
  const results = await Promise.allSettled(Array.from({ length: 32 }, (_, n) => queueSms(env, request({ content: `容量测试${n}` }))));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 16);
  for (const result of results.filter(({ status }) => status === "rejected")) assert.equal(result.reason.status, 429);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status IN ('queued', 'dispatched')").n, 16);
});

test("fresh session cutover retires old dispatches without rotating credentials, requeueing unknown or changing queued TTL", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const firstSession = await activeSession(env, "manual", hash);
  const inputs = [request(), request({ content: "继续排队" })];
  const queued = await Promise.all(inputs.map((input) => queueSms(env, input)));
  const first = await nextSmsCommand(env, "manual", hash, firstSession);
  const dispatched = queued.find(({ command }) => command.id === first.id);
  const pending = queued.find(({ command }) => command.id !== first.id);
  const beforeRegistry = db.row("SELECT * FROM device_registry WHERE id = 'manual'");
  const beforeDispatched = db.row("SELECT * FROM sms_commands WHERE id = ?", first.id);
  const beforeQueued = db.row("SELECT * FROM sms_commands WHERE id = ?", pending.command.id);
  time.advance(1000);
  const secondSession = session43();
  assert.deepEqual(await activateSmsSession(env, "manual", hash, secondSession), {
    session_id: secondSession, credential_version: beforeRegistry.credential_version, retired: 1,
  });
  assert.deepEqual(db.row("SELECT * FROM device_registry WHERE id = 'manual'"), { ...beforeRegistry, command_session: secondSession });
  const retired = db.row("SELECT * FROM sms_commands WHERE id = ?", first.id);
  assert.equal(retired.status, "unknown");
  assert.equal(retired.dispatch_session, firstSession);
  for (const key of ["request_id", "request_fingerprint", "expires_at", "retention_expires_at", "dispatched_at", "command_digest", "peer", "content"]) {
    assert.equal(retired[key], beforeDispatched[key]);
  }
  assert.deepEqual(db.row("SELECT * FROM sms_commands WHERE id = ?", pending.command.id), beforeQueued);
  assert.equal((await getSms(env, dispatched.item.id)).send_status, "unknown");
  assert.equal((await getSms(env, pending.item.id)).send_status, "queued");
  assert.equal(await nextSmsCommand(env, "manual", hash, firstSession), null);
  const second = await nextSmsCommand(env, "manual", hash, secondSession);
  assert.equal(second.id, pending.command.id);
  assert.equal(second.session_id, secondSession);
  const originalInput = inputs[queued.findIndex(({ command }) => command.id === first.id)];
  assert.equal((await queueSms(env, originalInput)).item.send_status, "unknown");
  await assert.rejects(queueSms(env, { ...originalInput, content: "同 UUID 不同内容" }), status(409));
  await recordSmsResult(env, "manual", { command_id: first.id, status: "submitted" });
  await recordSmsResult(env, "manual", { command_id: first.id, status: "failed", error: "迟到失败" });
  await recordSmsResult(env, "manual", { command_id: second.id, status: "submitted" });
  assert.equal((await getSms(env, dispatched.item.id)).send_status, "submitted");
  assert.equal((await activateSmsSession(env, "manual", hash, session43())).retired, 0);
  assert.equal((await getSms(env, dispatched.item.id)).send_status, "submitted");
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands").n, 2);
});

test("idempotent activation preserves this session's dispatched command, credentials and all history", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  await Promise.all([queueSms(env, request()), queueSms(env, request({ content: "仍在队列" }))]);
  const command = await nextSmsCommand(env, "manual", hash, sessionId);
  const before = snapshot(db);
  time.advance(5000);
  const activations = await Promise.all(Array.from({ length: 16 }, () => activateSmsSession(env, "manual", hash, sessionId)));
  for (const activated of activations) assert.deepEqual(activated, { session_id: sessionId, credential_version: before.registry[0].credential_version, retired: 0 });
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(await nextSmsCommand(env, "manual", hash, sessionId), command);
  assert.deepEqual(snapshot(db), before);
  assert.ok(db.sessions.every((mode) => mode === "first-primary"));
});

test("winning activation retires all prior dispatches including over 200 NULL legacy owners, but not other devices", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const otherHash = await manual(env, "other");
  const otherSession = await activeSession(env, "other", otherHash);
  await queueSms(env, request({ device_id: "other" }));
  const other = await nextSmsCommand(env, "other", otherHash, otherSession);
  const legacy = await queueSms(env, request());
  const pending = await queueSms(env, request({ content: "保持原有效期" }));
  const iso = new Date(time.now()).toISOString();
  db.sqlite.prepare("UPDATE sms_commands SET status = 'dispatched', dispatched_at = ? WHERE id = ?").run(iso, legacy.command.id);
  db.sqlite.prepare("UPDATE sms_messages SET send_status = 'dispatched' WHERE command_id = ?").run(legacy.command.id);
  // Old/corrupt databases may contain more dispatches than today's unique index permits.
  db.sqlite.exec("DROP INDEX sms_commands_one_dispatched");
  copyCommands(db, legacy.command.id, 200);
  copyCommands(db, legacy.command.id, 50, { dispatch_session: session43() });
  const beforeQueued = db.row("SELECT * FROM sms_commands WHERE id = ?", pending.command.id);
  const beforeCommands = db.rows("SELECT * FROM sms_commands WHERE device_id = 'manual' AND status = 'dispatched' ORDER BY id");
  const beforeOther = db.row("SELECT * FROM sms_commands WHERE id = ?", other.id);
  const otherMessage = db.row("SELECT * FROM sms_messages WHERE command_id = ?", other.id);
  const beforeRegistry = db.row("SELECT * FROM device_registry WHERE id = 'manual'");
  const sessionId = session43();
  assert.deepEqual(await activateSmsSession(env, "manual", hash, sessionId), { session_id: sessionId, credential_version: beforeRegistry.credential_version, retired: 251 });
  assert.deepEqual(db.row("SELECT * FROM device_registry WHERE id = 'manual'"), { ...beforeRegistry, command_session: sessionId });
  assert.deepEqual(db.row("SELECT * FROM sms_commands WHERE id = ?", pending.command.id), beforeQueued);
  for (const before of beforeCommands) {
    const after = db.row("SELECT * FROM sms_commands WHERE id = ?", before.id);
    assert.deepEqual(after, { ...before, status: "unknown", result_at: iso, error: "连接会话已更换，提交状态未知" });
  }
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages WHERE device_id = 'manual' AND send_status = 'unknown'").n, 251);
  assert.deepEqual(db.row("SELECT * FROM sms_commands WHERE id = ?", other.id), beforeOther);
  assert.deepEqual(db.row("SELECT * FROM sms_messages WHERE command_id = ?", other.id), otherMessage);
  assert.equal((await nextSmsCommand(env, "manual", hash, sessionId)).id, pending.command.id);
});

test("invalid or unactivated session IDs and credentials cannot mutate or claim SMS", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  await queueSms(env, request());
  const before = snapshot(db);
  assert.equal(await nextSmsCommand(env, "manual", hash, session43()), null);
  assert.equal(await nextSmsCommand(env, "manual", hash), null);
  for (const invalid of [undefined, null, "", "A".repeat(42), "A".repeat(44), "/".repeat(43)]) {
    await assert.rejects(activateSmsSession(env, "manual", hash, invalid), status(400));
    assert.equal(await nextSmsCommand(env, "manual", hash, invalid), null);
  }
  await assert.rejects(activateSmsSession(env, "manual", await digest("wrong-token"), session43()), status(401));
  await assert.rejects(activateSmsSession(env, "missing-device", hash, session43()), status(403));
  assert.deepEqual(snapshot(db), before);
});

test("activation rechecks hash, enabled, deleted and version in every mutating statement", async (t) => {
  const scenarios = [
    { name: "hash", sql: "UPDATE device_registry SET command_session = ?, token_hash = ?, credential_version = credential_version + 1 WHERE id = 'manual'", expected: 401 },
    { name: "unbound", sql: "UPDATE device_registry SET command_session = ?, token_hash = NULL, credential_version = credential_version + 1 WHERE id = 'manual'", expected: 401 },
    { name: "disabled", sql: "UPDATE device_registry SET command_session = ?, enabled = 0 WHERE id = 'manual'", expected: 403 },
    { name: "deleted", sql: "UPDATE device_registry SET command_session = ?, deleted = 1 WHERE id = 'manual'", expected: 403 },
    { name: "same-hash version", sql: "UPDATE device_registry SET command_session = ?, credential_version = credential_version + 1 WHERE id = 'manual'", expected: 409 },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async (st) => {
    const time = clock(st);
    const { db, env } = d1Fixture(st);
    const hash = await manual(env);
    const oldSession = await activeSession(env, "manual", hash);
    await Promise.all([queueSms(env, request()), queueSms(env, request({ content: "失败激活不能维护此命令" }))]);
    await nextSmsCommand(env, "manual", hash, oldSession);
    time.advance(600_000);
    const proposed = session43();
    const newHash = await digest("racing-replacement-token");
    let afterRace;
    db.beforeBatch = (statements) => {
      if (!statements.some(({ sql }) => sql.includes("UPDATE device_registry SET command_session = ?"))) return;
      db.beforeBatch = undefined;
      db.sqlite.prepare(scenario.sql).run(proposed, ...(scenario.name === "hash" ? [newHash] : []));
      afterRace = snapshot(db);
    };
    await assert.rejects(activateSmsSession(env, "manual", hash, proposed), status(scenario.expected));
    assert.ok(afterRace);
    assert.deepEqual(snapshot(db), afterRace);
    assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'dispatched'").n, 1);
    assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'queued'").n, 1);
    assert.ok(db.sessions.every((mode) => mode === "first-primary"));
  });
});

test("competing activations have one CAS winner and a loser cannot retire the winner's new dispatch", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const oldSession = await activeSession(env, "manual", hash);
  const queued = await Promise.all([queueSms(env, request()), queueSms(env, request({ content: "赢得会话后的新下发" }))]);
  const oldCommand = await nextSmsCommand(env, "manual", hash, oldSession);
  const pending = queued.find(({ command }) => command.id !== oldCommand.id);
  const candidates = [session43(), session43()];
  let afterWinnerDispatch;
  db.beforeBatch = (statements) => {
    const activation = statements.find(({ sql }) => sql.includes("UPDATE device_registry SET command_session = ?"));
    if (activation?.params[0] !== candidates[1]) return;
    db.beforeBatch = undefined;
    assert.equal(db.row("SELECT command_session FROM device_registry WHERE id = 'manual'").command_session, candidates[0]);
    db.sqlite.prepare("UPDATE sms_commands SET status = 'dispatched', dispatched_at = ?, dispatch_session = ? WHERE id = ?")
      .run(new Date(time.now()).toISOString(), candidates[0], pending.command.id);
    db.sqlite.prepare("UPDATE sms_messages SET send_status = 'dispatched' WHERE command_id = ?").run(pending.command.id);
    afterWinnerDispatch = snapshot(db);
  };
  const results = await Promise.allSettled(candidates.map((id) => activateSmsSession(env, "manual", hash, id)));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.deepEqual(results[0].value, { session_id: candidates[0], credential_version: afterWinnerDispatch.registry[0].credential_version, retired: 1 });
  assert.equal(results[1].reason.status, 409);
  assert.deepEqual(snapshot(db), afterWinnerDispatch);
  assert.equal(await nextSmsCommand(env, "manual", hash, candidates[1]), null);
  assert.equal((await nextSmsCommand(env, "manual", hash, candidates[0])).id, pending.command.id);
});

test("activation registry ownership, retirement and message sync all roll back on batch failure", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const oldSession = await activeSession(env, "manual", hash);
  await Promise.all([queueSms(env, request()), queueSms(env, request({ content: "回滚后仍排队" }))]);
  await nextSmsCommand(env, "manual", hash, oldSession);
  const before = snapshot(db);
  const sessionId = session43();
  for (const part of ["UPDATE sms_commands SET status = 'unknown'", "UPDATE sms_messages SET send_status = 'unknown'"]) {
    db.failSql = (sql) => sql.includes(part);
    await assert.rejects(activateSmsSession(env, "manual", hash, sessionId), /simulated D1/);
    db.failSql = undefined;
    assert.deepEqual(snapshot(db), before);
  }
  assert.equal((await activateSmsSession(env, "manual", hash, sessionId)).retired, 1);
});

test("command claim is single-inflight, retries only the same session and excludes wrong credentials", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  const queued = await Promise.all([queueSms(env, request()), queueSms(env, request({ content: "第二条" }))]);
  await assert.rejects(recordSmsResult(env, "manual", { command_id: queued[0].command.id, status: "submitted" }), status(409));
  assert.equal(await nextSmsCommand(env, "manual", await digest("wrong-local-token"), sessionId), null);
  assert.equal(await nextSmsCommand(env, "manual", hash), null);
  assert.equal(await nextSmsCommand(env, "manual", hash, session43()), null);
  const commands = await Promise.all(Array.from({ length: 20 }, () => nextSmsCommand(env, "manual", hash, sessionId)));
  const first = commands[0];
  assert.ok(first);
  for (const command of commands) assert.deepEqual(command, first);
  assert.deepEqual(Object.keys(first).sort(), ["id", "op", "device_id", "to", "content", "expires_at", "digest", "session_id"].sort());
  assert.equal(first.session_id, sessionId);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'dispatched'").n, 1);
  const stored = db.row("SELECT * FROM sms_commands WHERE id = ?", first.id);
  assert.equal(stored.dispatch_session, sessionId);
  const original = queued.find(({ command }) => command.id === first.id);
  assert.equal((await getSms(env, original.item.id)).send_status, "dispatched");
  assert.deepEqual(await nextSmsCommand(env, "manual", hash, sessionId), first);
  assert.deepEqual(db.row("SELECT * FROM sms_commands WHERE id = ?", first.id), stored);
  await assert.rejects(recordSmsResult(env, "other", { command_id: first.id, status: "submitted" }), status(404));
  await assert.rejects(recordSmsResult(env, "manual", { command_id: first.id, status: "sent" }), status(400));
  assert.deepEqual(await recordSmsResult(env, "manual", { command_id: first.id, status: "submitted" }), { ok: true });
  const second = await nextSmsCommand(env, "manual", hash, sessionId);
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(second.session_id, sessionId);
  assert.equal((await getSms(env, original.item.id)).send_status, "submitted");
});

test("polling rechecks session, hash, version and enabled/deleted state inside the claim transaction", async (t) => {
  for (const kind of ["session", "hash", "same-hash version", "disabled", "deleted"]) await t.test(kind, async (st) => {
    const time = clock(st);
    const { db, env } = d1Fixture(st);
    const hash = await manual(env);
    const sessionId = await activeSession(env, "manual", hash);
    const queued = await queueSms(env, request());
    const newSession = session43();
    const newHash = await digest("new-poll-race-token");
    let afterRace;
    db.beforeBatch = (statements) => {
      if (!statements.some(({ sql }) => sql.includes("UPDATE sms_commands SET status = 'dispatched', dispatched_at"))) return;
      db.beforeBatch = undefined;
      if (kind === "session") {
        db.sqlite.prepare("UPDATE device_registry SET command_session = ? WHERE id = 'manual'").run(newSession);
        db.sqlite.prepare("UPDATE sms_commands SET status = 'dispatched', dispatched_at = ?, dispatch_session = ? WHERE id = ?")
          .run(new Date(time.now()).toISOString(), newSession, queued.command.id);
        db.sqlite.prepare("UPDATE sms_messages SET send_status = 'dispatched' WHERE command_id = ?").run(queued.command.id);
      } else if (kind === "hash" || kind === "same-hash version") {
        db.sqlite.prepare("UPDATE device_registry SET token_hash = ?, credential_version = credential_version + 1 WHERE id = 'manual'")
          .run(kind === "hash" ? newHash : hash);
        // Simulate a new-version queued command even when the hash/session text is unchanged.
        db.sqlite.prepare("UPDATE sms_commands SET credential_hash = ?, credential_version = (SELECT credential_version FROM device_registry WHERE id = 'manual') WHERE id = ?")
          .run(kind === "hash" ? newHash : hash, queued.command.id);
      } else {
        db.sqlite.exec(`UPDATE device_registry SET ${kind === "disabled" ? "enabled = 0" : "deleted = 1"} WHERE id = 'manual'`);
      }
      afterRace = snapshot(db);
    };
    assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
    assert.ok(afterRace);
    assert.deepEqual(snapshot(db), afterRace);
  });
});

test("a different registry session cannot redeliver a dispatch assigned to an older or NULL owner", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const firstSession = await activeSession(env, "manual", hash);
  await queueSms(env, request());
  const command = await nextSmsCommand(env, "manual", hash, firstSession);
  const secondSession = session43();
  db.sqlite.prepare("UPDATE device_registry SET command_session = ? WHERE id = 'manual'").run(secondSession);
  for (const owner of [firstSession, null]) {
    db.sqlite.prepare("UPDATE sms_commands SET dispatch_session = ? WHERE id = ?").run(owner, command.id);
    const before = snapshot(db);
    assert.equal(await nextSmsCommand(env, "manual", hash, secondSession), null);
    assert.equal(await nextSmsCommand(env, "manual", hash, firstSession), null);
    assert.deepEqual(snapshot(db), before);
  }
});

test("a failed initial dispatch batch rolls back its session stamp and message status", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  const queued = await queueSms(env, request());
  const before = snapshot(db);
  let claimed = false;
  db.failSql = (sql) => {
    if (sql.includes("UPDATE sms_commands SET status = 'dispatched', dispatched_at")) claimed = true;
    return claimed && sql.includes("UPDATE sms_messages SET send_status = (SELECT status FROM sms_commands");
  };
  await assert.rejects(nextSmsCommand(env, "manual", hash, sessionId), /simulated D1/);
  db.failSql = undefined;
  assert.deepEqual(snapshot(db), before);
  const command = await nextSmsCommand(env, "manual", hash, sessionId);
  assert.equal(command.id, queued.command.id);
  assert.equal(command.session_id, sessionId);
});

test("results are idempotent, unknown never downgrades a failure and late failures never override submitted", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  const queued = await queueSms(env, request());
  const command = await nextSmsCommand(env, "manual", hash, sessionId);
  await recordSmsResult(env, "manual", { command_id: command.id, status: "unknown", error: "首次未知" });
  assert.equal((await getSms(env, queued.item.id)).send_status, "unknown");
  assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
  time.advance(1000);
  await recordSmsResult(env, "manual", { command_id: command.id, status: "failed", error: "调制解调器失败" });
  const failure = db.row("SELECT * FROM sms_commands WHERE id = ?", command.id);
  time.advance(1000);
  await recordSmsResult(env, "manual", { command_id: command.id, status: "unknown", error: "旧的未知回执" });
  const stillFailed = db.row("SELECT * FROM sms_commands WHERE id = ?", command.id);
  assert.equal(stillFailed.status, "failed");
  assert.equal(stillFailed.error, "调制解调器失败");
  assert.equal(stillFailed.result_at, failure.result_at);
  const attempts = await Promise.all(Array.from({ length: 18 }, (_, n) => recordSmsResult(env, "manual", {
    command_id: command.id, status: n % 3 === 0 ? "submitted" : "failed", error: "迟到的失败",
  })));
  for (const attempt of attempts) assert.deepEqual(attempt, { ok: true });
  const submitted = db.row("SELECT * FROM sms_commands WHERE id = ?", command.id);
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.error, null);
  time.advance(1000);
  await recordSmsResult(env, "manual", { command_id: command.id, status: "failed", error: "仍然迟到" });
  assert.equal(db.row("SELECT result_at FROM sms_commands WHERE id = ?", command.id).result_at, submitted.result_at);
  assert.equal((await getSms(env, queued.item.id)).send_status, "submitted");
});

test("credential rotation cancels queued work, clears session ownership and never executes an old credential", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  const queued = await Promise.all([queueSms(env, request()), queueSms(env, request({ content: "等待重绑" }))]);
  const dispatched = await nextSmsCommand(env, "manual", hash, sessionId);
  const newHash = await digest("replacement-manual-local-token");
  await putJson(dataStore(env), keys.deviceToken("manual"), { hash: newHash });
  assert.equal((await dataStore(env).getDeviceRecord("manual")).commandSession, null);
  for (const entry of queued) {
    assert.equal((await getSms(env, entry.item.id)).send_status, entry.command.id === dispatched.id ? "unknown" : "cancelled");
  }
  assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
  assert.equal(await nextSmsCommand(env, "manual", newHash, sessionId), null);
  const replacement = await queueSms(env, request({ content: "新凭据命令" }));
  const stored = db.row("SELECT credential_hash, credential_version FROM sms_commands WHERE id = ?", replacement.command.id);
  assert.equal(stored.credential_hash, newHash);
  assert.equal(stored.credential_version, db.row("SELECT credential_version FROM device_registry WHERE id = 'manual'").credential_version);
  assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
  assert.equal(await nextSmsCommand(env, "manual", newHash, sessionId), null);
  const replacementSessionId = await activeSession(env, "manual", newHash);
  assert.equal((await nextSmsCommand(env, "manual", newHash, replacementSessionId)).id, replacement.command.id);
  await dataStore(env).updateDeviceRecord("manual", { enabled: false });
  assert.equal((await dataStore(env).getDeviceRecord("manual")).commandSession, null);
  assert.equal((await getSms(env, replacement.item.id)).send_status, "unknown");
  await dataStore(env).updateDeviceRecord("manual", { enabled: true });
  assert.equal(await nextSmsCommand(env, "manual", newHash, replacementSessionId), null);
});

test("automatic rebind and delete revoke command credentials atomically", async (t) => {
  clock(t);
  const { env } = d1Fixture(t);
  const store = dataStore(env);
  const hardware = { identity_type: "sn", identity_value: "SMS-AUTO-LOCAL" };
  const id = `auto~${await digest(`sn:${hardware.identity_value}`)}`;
  const oldHash = await digest("old-automatic-local-token");
  await store.registerDevice(id, hardware, oldHash);
  const sessionId = await activeSession(env, id, oldHash);
  const queued = await queueSms(env, request({ device_id: id }));
  await store.rebindDeviceRecord(id);
  assert.equal((await store.getDeviceRecord(id)).commandSession, null);
  assert.equal((await getSms(env, queued.item.id)).send_status, "cancelled");
  await assert.rejects(store.registerDevice(id, hardware, oldHash), status(409));
  const newHash = await digest("new-automatic-local-token");
  await store.registerDevice(id, hardware, newHash);
  assert.equal((await store.getDeviceRecord(id)).commandSession, null);
  assert.equal(await nextSmsCommand(env, id, oldHash, sessionId), null);
  const replacementSessionId = await activeSession(env, id, newHash);
  const replacement = await queueSms(env, request({ device_id: id }));
  await store.deleteDeviceRecord(id);
  assert.equal((await store.getDeviceRecord(id)).commandSession, null);
  assert.equal((await getSms(env, replacement.item.id)).send_status, "cancelled");
  assert.equal(await nextSmsCommand(env, id, newHash, replacementSessionId), null);
});

test("explicit device cancellation never labels dispatched work cancelled", async (t) => {
  clock(t);
  const { env } = d1Fixture(t);
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  const queued = await Promise.all([queueSms(env, request()), queueSms(env, request({ content: "排队取消" }))]);
  const command = await nextSmsCommand(env, "manual", hash, sessionId);
  assert.deepEqual(await cancelDeviceSmsCommands(env, "manual"), { cancelled: 1, unknown: 1 });
  assert.deepEqual(await cancelDeviceSmsCommands(env, "manual"), { cancelled: 0, unknown: 0 });
  for (const entry of queued) {
    assert.equal((await getSms(env, entry.item.id)).send_status, entry.command.id === command.id ? "unknown" : "cancelled");
  }
  assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
  const cancelled = queued.find(({ command: entry }) => entry.id !== command.id);
  await assert.rejects(recordSmsResult(env, "manual", { command_id: cancelled.command.id, status: "submitted" }), status(409));
});

test("queue batch rechecks credential versions and rolls back both records on statement failures", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  await manual(env);
  const changedHash = await digest("race-replacement-local-token");
  db.beforeBatch = (statements) => {
    if (statements.some(({ sql }) => sql.includes("INSERT INTO sms_commands"))) {
      db.beforeBatch = undefined;
      db.sqlite.prepare("UPDATE device_registry SET token_hash = ?, credential_version = credential_version + 1 WHERE id = 'manual'").run(changedHash);
    }
  };
  await assert.rejects(queueSms(env, request()), status(409));
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 0);
  const input = request();
  db.failSql = (sql) => sql.includes("INSERT INTO sms_messages");
  await assert.rejects(queueSms(env, input), /simulated D1/);
  db.failSql = undefined;
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 0);
  assert.equal((await queueSms(env, input)).item.send_status, "queued");
});

test("list and detail reads expose queued expiry and unknown dispatches at exact TTL without Cron", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  const inputs = [request(), request({ content: "无需 Cron 的过期队列" })];
  const queued = await Promise.all(inputs.map((input) => queueSms(env, input)));
  const dispatched = await nextSmsCommand(env, "manual", hash, sessionId);
  const first = queued.find(({ command }) => command.id === dispatched.id);
  const second = queued.find(({ command }) => command.id !== dispatched.id);
  time.advance(599_999);
  assert.equal((await getSms(env, first.item.id)).send_status, "dispatched");
  assert.equal((await listSms(env, params({ status: "queued" }))).items.length, 1);
  time.advance(1);
  assert.equal((await getSms(env, first.item.id)).send_status, "unknown");
  const expired = await listSms(env, params({ device_id: "manual", status: "expired" }));
  assert.deepEqual(expired.items.map(({ id }) => id), [second.item.id]);
  assert.equal((await listSms(env, params({ status: "queued" }))).items.length, 0);
  assert.equal((await listSms(env, params({ status: "unknown" }))).items[0].id, first.item.id);
  assert.equal((await getSms(env, second.item.id)).send_status, "expired");
  for (const entry of queued) assert.equal((await getSms(env, entry.item.id)).expires_at, entry.item.expires_at);
  const originalInput = inputs[queued.findIndex(({ command }) => command.id === dispatched.id)];
  assert.equal((await queueSms(env, originalInput)).item.send_status, "unknown");
  assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
  await recordSmsResult(env, "manual", { command_id: dispatched.id, status: "submitted" });
  assert.equal((await getSms(env, first.item.id)).send_status, "submitted");
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands").n, 2);
});

test("read-time maintenance is bounded while detail expiry is targeted beyond the backlog", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  await manual(env);
  const base = await queueSms(env, request());
  copyCommands(db, base.command.id, 250);
  time.advance(600_000);
  const first = await listSms(env, params({ status: "expired", limit: "100" }));
  assert.equal(first.items.length, 100);
  assert.ok(first.cursor);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'expired'").n, 200);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'queued'").n, 51);
  const target = db.row("SELECT message_id FROM sms_commands WHERE status = 'queued' ORDER BY id DESC LIMIT 1");
  assert.equal((await getSms(env, target.message_id)).send_status, "expired");
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'expired'").n, 201);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'queued'").n, 50);
  await listSms(env, params({ status: "expired" }));
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE status = 'expired'").n, 251);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages WHERE send_status = 'expired'").n, 251);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 251);
  assert.equal(db.row("SELECT expires_at FROM sms_messages WHERE id = ?", target.message_id).expires_at, base.item.expires_at);
});

test("command expiry records queued as expired and dispatched as unknown, TTL erases personal data without nonce replay", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const hash = await manual(env);
  const sessionId = await activeSession(env, "manual", hash);
  await incoming(env, time);
  const firstInput = request();
  const secondInput = request({ content: "另一个过期命令" });
  const queued = await Promise.all([queueSms(env, firstInput), queueSms(env, secondInput)]);
  const dispatched = await nextSmsCommand(env, "manual", hash, sessionId);
  time.advance(600_000);
  assert.equal((await expireSms(env)).expired, 2);
  for (const entry of queued) {
    assert.equal((await getSms(env, entry.item.id)).send_status, entry.command.id === dispatched.id ? "unknown" : "expired");
  }
  assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
  const original = queued.find(({ command }) => command.id === dispatched.id);
  const originalInput = queued[0].command.id === dispatched.id ? firstInput : secondInput;
  assert.equal((await queueSms(env, originalInput)).item.send_status, "unknown");
  await recordSmsResult(env, "manual", { command_id: dispatched.id, status: "submitted" });
  assert.equal((await getSms(env, original.item.id)).send_status, "submitted");
  time.advance(30 * 86400_000 - 600_000);
  const expiration = await expireSms(env);
  assert.equal(expiration.deleted, 3);
  assert.equal(expiration.purged, 2);
  assert.equal((await listSms(env, params())).items.length, 0);
  await assert.rejects(getSms(env, queued[0].item.id), status(404));
  const tombstones = db.rows("SELECT * FROM sms_commands");
  assert.equal(tombstones.length, 2);
  assert.ok(tombstones.every((row) => row.content === "" && row.peer === "" && row.device_name === "" && row.purged_at !== null));
  await assert.rejects(queueSms(env, firstInput), status(410));
  await assert.rejects(queueSms(env, { ...firstInput, content: "过期后不同内容" }), status(409));
  assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands").n, 2);
});

test("TTL cleanup is bounded and expired records are hidden before physical deletion", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const insert = db.sqlite.prepare(`
    INSERT INTO sms_messages (id, device_id, device_name, event_id, direction, peer, content, occurred_at, received_at, send_status, expires_at)
    VALUES (?, 'manual', '本地设备', ?, 'incoming', '10086', '过期的本地内容', ?, ?, 'received', ?)
  `);
  db.sqlite.exec("BEGIN");
  for (let n = 0; n < 251; n++) insert.run(`expired-${n}`, `event-${n}`, new Date(time.now()).toISOString(), new Date(time.now()).toISOString(), time.seconds());
  db.sqlite.exec("COMMIT");
  assert.equal((await listSms(env, params())).items.length, 0);
  assert.equal((await expireSms(env)).deleted, 200);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 51);
  assert.equal((await expireSms(env)).deleted, 51);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 0);
});

test("overlapping SMS expiry jobs count only their own bounded erasure and preserve UUID replay tombstones", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  await manual(env);
  const input = request({ content: "Cron 竞争只在本地 SQLite 运行" });
  const base = await queueSms(env, input);
  db.sqlite.prepare("UPDATE sms_commands SET status = 'failed', retention_expires_at = ? WHERE id = ?").run(time.seconds(), base.command.id);
  db.sqlite.prepare("UPDATE sms_messages SET send_status = 'failed', expires_at = ? WHERE command_id = ?").run(time.seconds(), base.command.id);
  copyCommands(db, base.command.id, 250);
  const first = await Promise.all([expireSms(env), expireSms(env)]);
  for (const batch of first) {
    assert.ok(batch.deleted >= 0 && batch.deleted <= 200);
    assert.ok(batch.purged >= 0 && batch.purged <= 200);
    assert.equal(batch.deleted, batch.purged);
  }
  const last = await expireSms(env);
  assert.equal(first.reduce((total, batch) => total + batch.deleted, last.deleted), 251);
  assert.equal(first.reduce((total, batch) => total + batch.purged, last.purged), 251);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_messages").n, 0);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM sms_commands WHERE purged_at IS NOT NULL").n, 251);
  await assert.rejects(queueSms(env, input), status(410));
  assert.ok(db.rows("SELECT peer, content, device_name, credential_hash FROM sms_commands").every((row) => Object.values(row).every((value) => value === "")));
});
