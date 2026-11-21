import assert from "node:assert/strict";
import test from "node:test";
import { dataStore, D1Store } from "../src/db.js";
import { digest, newToken } from "../src/security.js";
import { activateSmsSession, nextSmsCommand, queueSms } from "../src/sms.js";
import { allValues, keys, putJson } from "../src/store.js";
import { clock, d1Fixture, SQLiteD1 } from "./helpers/d1-sqlite.js";

const status = (expected) => (error) => error.status === expected;
const identity = { identity_type: "sn", identity_value: "D1-LOCAL-TEST" };
const snapshot = (db) => ({
  registry: db.rows("SELECT * FROM device_registry ORDER BY id"),
  commands: db.rows("SELECT * FROM sms_commands ORDER BY id"),
  messages: db.rows("SELECT * FROM sms_messages ORDER BY id"),
  records: db.rows("SELECT * FROM relay_records ORDER BY key"),
});

async function automaticId(value = identity.identity_value) { return `auto~${await digest(`sn:${value}`)}`; }

function event(time, overrides = {}) {
  return {
    version: 1, device_id: "device-a", device_name: "设备 A", event_id: "event-001", type: "sms.received",
    occurred_at: new Date(time.now()).toISOString(), received_at: new Date(time.now()).toISOString(),
    data: { sender: "10086", content: "D1 保存测试" }, status: {}, routes: [], fingerprint: "same-fingerprint",
    expires_at: time.seconds() + 86400, ...overrides,
  };
}

test("0002 adds nullable TEXT session columns without changing legacy records, history, indexes or UUID tombstones", async (t) => {
  const time = clock(t);
  const db = new SQLiteD1({ through: "0001_d1.sql" });
  t.after(() => db.close());
  const device = { id: "manual", name: "已有设备", enabled: true };
  db.sqlite.prepare("INSERT INTO device_registry (id, device_json, token_hash, enabled, credential_version) VALUES ('manual', ?, 'existing-hash', 1, 7)")
    .run(JSON.stringify(device));
  const sealed = { id: "sealed-local", type: "smtp", sealed_config: "unchanged.encrypted.value" };
  db.sqlite.prepare("INSERT INTO relay_records (key, value) VALUES (?, ?)").run("channels:sealed-local", JSON.stringify(sealed));
  db.sqlite.prepare("INSERT INTO relay_records (key, value) VALUES (?, ?)").run(keys.device("manual"), JSON.stringify(device));
  db.sqlite.prepare("INSERT INTO relay_records (key, value) VALUES (?, ?)").run(keys.deviceToken("manual"), '{"hash":"existing-hash"}');
  const insert = db.sqlite.prepare(`
    INSERT INTO sms_commands (id, request_id, request_fingerprint, message_id, device_id, device_name,
      credential_hash, credential_version, peer, content, command_digest, encoding, segments,
      status, created_at, expires_at, retention_expires_at, purged_at)
    VALUES (?, ?, ?, ?, 'manual', '已有设备', 'existing-hash', 7, '10086', ?, 'existing-digest', 'ucs2', 1, ?, ?, ?, ?, ?)
  `);
  for (const state of ["queued", "dispatched", "submitted", "unknown"]) {
    const tombstone = state === "unknown";
    const id = crypto.randomUUID();
    insert.run(id, crypto.randomUUID(), `keep-fingerprint-${state}`, crypto.randomUUID(), tombstone ? "" : "已有短信",
      state, new Date(time.now()).toISOString(), time.seconds() + 600, time.seconds() + 86400, tombstone ? time.seconds() : null);
    if (tombstone) db.sqlite.prepare("UPDATE sms_commands SET peer = '', device_name = '' WHERE id = ?").run(id);
  }
  db.sqlite.exec(`
    INSERT INTO sms_messages (id, device_id, device_name, command_id, direction, peer, content,
      occurred_at, received_at, send_status, expires_at)
    SELECT message_id, device_id, device_name, id, 'outgoing', peer, content, created_at, created_at, status, retention_expires_at
    FROM sms_commands WHERE purged_at IS NULL
  `);
  const before = snapshot(db);
  db.migrate("0002_ws_command_sessions.sql");
  const after = snapshot(db);
  assert.deepEqual(after.registry.map(({ command_session, ...row }) => { assert.equal(command_session, null); return row; }), before.registry);
  assert.deepEqual(after.commands.map(({ dispatch_session, ...row }) => { assert.equal(dispatch_session, null); return row; }), before.commands);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.records, before.records);
  assert.equal(db.row("SELECT type FROM pragma_table_info('device_registry') WHERE name = 'command_session'").type, "TEXT");
  assert.equal(db.row("SELECT type FROM pragma_table_info('sms_commands') WHERE name = 'dispatch_session'").type, "TEXT");
  assert.throws(() => db.sqlite.prepare("UPDATE sms_commands SET status = 'dispatched' WHERE status = 'queued'").run(), /UNIQUE constraint failed/);
  const store = dataStore({ DB: db });
  const record = await store.getDeviceRecord("manual");
  assert.equal(record.credentialVersion, 7);
  assert.equal(record.commandSession, null);
  assert.deepEqual(record.device, device);
  assert.deepEqual(await store.get("channels:sealed-local", "json"), sealed);
  db.migrate("0002_ws_command_sessions.sql");
  assert.deepEqual(snapshot(db), after);
  assert.throws(() => db.migrate("../untrusted.sql"), /Unknown fixture migration/);
});

test("dataStore requires D1, accepts explicit unit mocks and caches first-primary adapters", async (t) => {
  assert.throws(() => dataStore({}), status(503));
  assert.throws(() => dataStore({ DB: { prepare() {} } }), status(503));
  const mock = { get() {} };
  assert.equal(dataStore({ DATA: mock }), mock);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  assert.ok(store instanceof D1Store);
  assert.equal(store.isD1, true);
  assert.equal(store.db, db);
  assert.equal(dataStore(env), store);
  await store.put("channels:test", JSON.stringify({ id: "test", sealed_config: "unchanged.encrypted-value" }));
  assert.equal((await store.get("channels:test", "json")).sealed_config, "unchanged.encrypted-value");
  assert.ok(db.sessions.length >= 2);
  assert.ok(db.sessions.every((mode) => mode === "first-primary"));
});

test("D1 JSON compatibility handles bulk maps, literal prefixes, keyset pages and exact TTL", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const values = Array.from({ length: 205 }, (_, n) => ({ id: `item-${String(n).padStart(3, "0")}`, n }));
  await Promise.all(values.map((value) => putJson(store, `rules:${value.id}`, value)));
  const names = [...values.map((value) => `rules:${value.id}`), "rules:missing"];
  const map = await store.get(names, "json");
  assert.equal(map.size, 206);
  assert.deepEqual(map.get(names[204]), values[204]);
  assert.equal(map.get("rules:missing"), null);
  assert.equal(await store.get("rules:missing"), null);
  assert.equal(await store.get(names[0]), JSON.stringify(values[0]));
  assert.deepEqual(await allValues(store, "rules:"), values);

  await store.put("literal%_:一", '"一"');
  await store.put("literal%_:🙂", '"emoji key"');
  await store.put("literalXXX:other", '"other"');
  const first = await store.list({ prefix: "literal%_:", limit: 1 });
  assert.equal(first.list_complete, false);
  const second = await store.list({ prefix: "literal%_:", limit: 1, cursor: first.cursor });
  assert.equal(second.list_complete, true);
  assert.deepEqual([...first.keys, ...second.keys].map(({ name }) => name), ["literal%_:一", "literal%_:🙂"]);
  await assert.rejects(store.list({ prefix: "other:", cursor: first.cursor }), status(400));
  await assert.rejects(store.list({ prefix: "rules:", cursor: "bad!" }), status(400));

  await store.put("expiring:one", '{"ttl":1}', { expiration: time.seconds() + 10 });
  await store.put("expiring:two", '{"ttl":2}', { expiration: time.seconds() + 10 });
  await store.put("expiring:permanent", '{"ttl":0}');
  time.advance(9_999);
  assert.ok(await store.get("expiring:one", "json"));
  time.advance(1);
  assert.equal(await store.get("expiring:one", "json"), null);
  assert.deepEqual((await store.list({ prefix: "expiring:" })).keys, [{ name: "expiring:permanent" }]);
  assert.deepEqual(await store.cleanup(1), { deleted: 1 });
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'expiring:*'").n, 2);
  assert.deepEqual(await store.cleanup(1), { deleted: 1 });
  assert.equal(await store.get("expiring:permanent"), '{"ttl":0}');
  await store.delete("expiring:permanent");
  assert.equal(await store.get("expiring:permanent"), null);
});

test("createEvent atomically returns the first complete winner and rejects fingerprint conflicts", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const attempts = await Promise.all(Array.from({ length: 24 }, (_, n) => store.createEvent(event(time, {
    device_name: `attempt-${n}`, routes: [{ channel_id: `route-${n}` }], received_at: new Date(time.now() + n).toISOString(),
  }))));
  assert.equal(attempts.filter(({ created }) => created).length, 1);
  const winner = attempts.find(({ created }) => created).item;
  for (const attempt of attempts) assert.deepEqual(attempt.item, winner);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM relay_records WHERE key GLOB 'events:*'").n, 1);
  await assert.rejects(store.createEvent(event(time, { fingerprint: "different", data: { content: "overwrite" } })), status(409));
  assert.deepEqual(await store.get(keys.event(winner.device_id, winner.event_id), "json"), winner);
  await assert.rejects(store.createEvent(event(time, { event_id: "has:colon" })), status(400));
});

test("event SQL filters before paging with a stable descending cursor and compatible timeline JSON", async (t) => {
  const time = clock(t);
  const { env } = d1Fixture(t);
  const store = dataStore(env);
  const matched = [];
  for (let index = 0; index < 44; index++) {
    const matches = index % 7 === 0;
    const saved = event(time, { event_id: `event-${String(index).padStart(3, "0")}`, device_id: matches ? "device-a" : "device-other", type: matches ? "sms.received" : "device.test" });
    await store.createEvent(saved);
    if (matches) matched.push(saved);
  }
  await putJson(store, "timeline:0000000000000:device-a:event-000", { eventKey: keys.event("device-a", "event-000"), device_id: "device-a", type: "sms.received" });
  assert.equal((await store.get("timeline:0000000000000:device-a:event-000", "json")).type, "sms.received");
  const first = await store.listEvents({ device: "device-a", type: "sms.received", limit: 3 });
  assert.equal(first.items.length, 3);
  assert.ok(first.cursor);
  await store.createEvent(event(time, { event_id: "new-top", received_at: new Date(time.now() + 1000).toISOString() }));
  const second = await store.listEvents({ device: "device-a", type: "sms.received", limit: 3, cursor: first.cursor });
  const third = await store.listEvents({ device: "device-a", type: "sms.received", limit: 3, cursor: second.cursor });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.event_id), matched.reverse().map((item) => item.event_id));
  assert.equal(third.cursor, null);
  await assert.rejects(store.listEvents({ device: "device-other", type: "sms.received", cursor: first.cursor }), status(400));
});

test("registry first claims, retries, disabled states, revocation and tombstones are authoritative and mirrored atomically", async (t) => {
  const time = clock(t);
  const { env } = d1Fixture(t);
  const store = dataStore(env);
  const id = await automaticId();
  const hashes = await Promise.all(Array.from({ length: 12 }, (_, n) => digest(`local-token-${n}`)));
  const claims = await Promise.allSettled(hashes.map((hash) => store.registerDevice(id, identity, hash)));
  const winners = claims.filter((claim) => claim.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal(winners[0].value.created, true);
  for (const claim of claims.filter((claim) => claim.status === "rejected")) assert.equal(claim.reason.status, 409);
  const winner = winners[0].value.record;
  assert.equal((await store.get(keys.deviceToken(id), "json")).hash, winner.hash);
  assert.equal((await store.get(keys.device(id), "json")).enrollment_pending, false);
  assert.deepEqual(await store.getDeviceRecord(id), winner);
  time.advance(1000);
  assert.deepEqual(await store.registerDevice(id, identity, winner.hash), { record: winner, created: false });
  const disabled = await store.updateDeviceRecord(id, { name: "权威名称", enabled: false });
  assert.equal(disabled.device.name, "权威名称");
  await putJson(store, keys.device(id), { ...disabled.device, name: "不应覆盖权威名称", enabled: true });
  await putJson(store, keys.deviceToken(id), { hash: hashes.find((hash) => hash !== winner.hash) });
  assert.deepEqual(await store.getDeviceRecord(id), disabled);
  assert.equal((await store.get(keys.device(id), "json")).name, "权威名称");
  assert.equal((await store.get(keys.device(id), "json")).enabled, false);
  assert.equal((await store.get(keys.deviceToken(id), "json")).hash, winner.hash);
  await assert.rejects(store.registerDevice(id, identity, winner.hash), status(403));
  await store.updateDeviceRecord(id, { enabled: true });
  const rebound = await store.rebindDeviceRecord(id);
  assert.equal(rebound.hash, null);
  assert.equal(rebound.revokedHash, winner.hash);
  assert.equal((await store.get(keys.device(id), "json")).enrollment_pending, true);
  assert.equal(await store.get(keys.deviceToken(id), "json"), null);
  await assert.rejects(store.registerDevice(id, identity, winner.hash), status(409));
  const newHash = await digest("replacement-local-token");
  const replacement = await store.registerDevice(id, identity, newHash);
  assert.equal(replacement.created, false);
  assert.equal(replacement.record.device.name, "权威名称");
  assert.equal(replacement.record.revokedHash, null);
  await putJson(store, keys.latest(id), { last_seen: new Date(time.now()).toISOString() });
  const deleted = await store.deleteDeviceRecord(id);
  assert.deepEqual(deleted.device, { id });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.revokedHash, newHash);
  assert.deepEqual(await store.deleteDeviceRecord(id), deleted);
  assert.equal(await store.get(keys.device(id), "json"), null);
  assert.equal(await store.get(keys.deviceToken(id), "json"), null);
  assert.equal(await store.get(keys.latest(id), "json"), null);
  await assert.rejects(store.registerDevice(id, identity, newHash), status(410));
});

test("concurrent device status writes preserve the independent WSS presence projection", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const initial = { last_seen: new Date(time.now()).toISOString(), last_event_type: "device.boot",
    status: { operator: "本地运营商", rsrp_dbm: -80 },
    connection: { id: "session-current", session_id: "session-current", state: "online", ready: true,
      event_ready: true, command_ready: true, heartbeat_seconds: 60, updated_at: "2026-11-20T08:00:00.000Z" } };
  await putJson(store, keys.latest("manual"), initial);
  await Promise.all([1, 2, 3].map((seconds) => store.updateLatestStatus("manual", {
    received_at: new Date(time.now() + seconds * 1000).toISOString(), type: `device.test.${seconds}`,
    status: { [`sample_${seconds}`]: seconds },
  })));
  const latest = await store.get(keys.latest("manual"), "json");
  assert.deepEqual(latest.connection, initial.connection);
  assert.deepEqual(latest.status, { operator: "本地运营商", rsrp_dbm: -80, sample_1: 1, sample_2: 2, sample_3: 3 });
  assert.equal(latest.last_seen, new Date(time.now() + 3000).toISOString());
  assert.equal(latest.last_event_type, "device.test.3");
  assert.equal(db.row("SELECT expires_at FROM relay_records WHERE key = ?", keys.latest("manual")).expires_at, null);
});

test("manual device management preserves authoritative mirrors and atomic credential versions", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const hash = await digest("manual-local-token");
  await putJson(store, keys.device("manual"), { id: "manual", name: "手动设备", enabled: true });
  await putJson(store, keys.deviceToken("manual"), { hash });
  assert.equal((await store.getDeviceRecord("manual")).hash, hash);
  assert.deepEqual(await store.get(keys.device("manual"), "json"), { id: "manual", name: "手动设备", enabled: true });
  const before = db.row("SELECT credential_version FROM device_registry WHERE id = 'manual'").credential_version;
  const replacement = await digest("manual-new-local-token");
  await putJson(store, keys.deviceToken("manual"), { hash: replacement });
  assert.equal(db.row("SELECT credential_version FROM device_registry WHERE id = 'manual'").credential_version, before + 1);
  assert.equal((await store.getDeviceRecord("manual")).hash, replacement);
  await Promise.all([store.updateDeviceRecord("manual", { name: "并发新名称" }), store.updateDeviceRecord("manual", { enabled: false })]);
  const updated = await store.getDeviceRecord("manual");
  assert.equal(updated.device.name, "并发新名称");
  assert.equal(updated.device.enabled, false);
  await store.delete(keys.device("manual"));
  assert.equal(await store.get(keys.deviceToken("manual"), "json"), null);
  await putJson(store, keys.device("manual"), { id: "manual", name: "重新创建", enabled: true });
  assert.equal((await store.getDeviceRecord("manual")).deleted, false);
  assert.equal((await store.getDeviceRecord("manual")).hash, null);
});

test("session ownership is exposed only internally and ordinary retries or edits do not rotate credentials", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const id = await automaticId("SESSION-CREDENTIAL-LOCAL");
  const hash = await digest("session-only-local-token");
  const registered = (await store.registerDevice(id, identity, hash)).record;
  assert.equal(registered.credentialVersion, 1);
  assert.equal(registered.commandSession, null);
  const sessionId = newToken();
  assert.deepEqual(await activateSmsSession(env, id, hash, sessionId), { session_id: sessionId, credential_version: 1, retired: 0 });
  const before = db.row("SELECT * FROM device_registry WHERE id = ?", id);
  const active = await store.getDeviceRecord(id);
  assert.deepEqual(active, { ...registered, commandSession: sessionId });
  assert.equal(Object.hasOwn(active.device, "commandSession"), false);
  assert.equal(Object.hasOwn(active.device, "credentialVersion"), false);
  time.advance(1000);
  assert.deepEqual(await store.registerDevice(id, identity, hash), { record: active, created: false });
  assert.deepEqual(db.row("SELECT * FROM device_registry WHERE id = ?", id), before);
  await store.updateDeviceRecord(id, { name: "会话不变的新名称", enabled: true });
  const edited = await store.getDeviceRecord(id);
  assert.equal(edited.commandSession, sessionId);
  assert.equal(edited.credentialVersion, registered.credentialVersion);
  assert.equal(edited.hash, hash);
  assert.equal(edited.revokedHash, registered.revokedHash);
  assert.equal((await store.get(keys.deviceToken(id), "json")).hash, hash);
  assert.equal(Object.hasOwn(await store.get(keys.device(id), "json"), "command_session"), false);

  const manualHash = await digest("same-manual-hash-local");
  await putJson(store, keys.device("manual"), { id: "manual", name: "手动设备", enabled: true });
  await putJson(store, keys.deviceToken("manual"), { hash: manualHash });
  const manualSession = newToken();
  await activateSmsSession(env, "manual", manualHash, manualSession);
  const manualBefore = db.row("SELECT * FROM device_registry WHERE id = 'manual'");
  await putJson(store, keys.deviceToken("manual"), { hash: manualHash });
  assert.deepEqual(db.row("SELECT * FROM device_registry WHERE id = 'manual'"), manualBefore);
  await putJson(store, keys.device("manual"), { id: "manual", name: "手动名称变更", enabled: true });
  const manualEdited = await store.getDeviceRecord("manual");
  assert.equal(manualEdited.commandSession, manualSession);
  assert.equal(manualEdited.credentialVersion, manualBefore.credential_version);
});

test("disable, delete, rebind, rotation and mirror invalidations clear session ownership atomically", async (t) => {
  const operations = [
    ["disable", (store) => store.updateDeviceRecord("manual", { enabled: false })],
    ["mirror disable", (store) => putJson(store, keys.device("manual"), { id: "manual", name: "本地设备", enabled: false })],
    ["delete", (store) => store.deleteDeviceRecord("manual")],
    ["mirror delete", (store) => store.delete(keys.device("manual"))],
    ["rebind", (store) => store.rebindDeviceRecord("manual")],
    ["rotate", (store, hash) => putJson(store, keys.deviceToken("manual"), { hash })],
    ["remove token", (store) => store.delete(keys.deviceToken("manual"))],
  ];
  for (const [name, mutate] of operations) await t.test(name, async (st) => {
    clock(st);
    const { db, env } = d1Fixture(st);
    const store = dataStore(env);
    const hash = await digest(`mutation-local-token:${name}`);
    const replacement = await digest(`replacement-local-token:${name}`);
    await putJson(store, keys.device("manual"), { id: "manual", name: "本地设备", enabled: true });
    await putJson(store, keys.deviceToken("manual"), { hash });
    const sessionId = newToken();
    await activateSmsSession(env, "manual", hash, sessionId);
    const queued = await Promise.all(["已下发", "仍排队"].map((content) => queueSms(env, {
      request_id: crypto.randomUUID(), device_id: "manual", to: "10086", content,
    })));
    const dispatched = await nextSmsCommand(env, "manual", hash, sessionId);
    const before = snapshot(db);
    db.failSql = (sql) => sql.includes("UPDATE sms_messages SET send_status");
    await assert.rejects(mutate(store, replacement), /simulated D1/);
    db.failSql = undefined;
    assert.deepEqual(snapshot(db), before);
    await mutate(store, replacement);
    const record = await store.getDeviceRecord("manual");
    assert.equal(record.commandSession, null);
    assert.equal(record.credentialVersion, before.registry[0].credential_version + (name.includes("disable") ? 0 : 1));
    for (const entry of queued) {
      const expected = entry.command.id === dispatched.id ? "unknown" : "cancelled";
      assert.equal(db.row("SELECT status FROM sms_commands WHERE id = ?", entry.command.id).status, expected);
      assert.equal(db.row("SELECT send_status FROM sms_messages WHERE id = ?", entry.item.id).send_status, expected);
    }
    assert.equal(await nextSmsCommand(env, "manual", hash, sessionId), null);
    assert.equal(await nextSmsCommand(env, "manual", replacement, sessionId), null);
  });
});

test("registry and mirror statements roll back together on a D1 batch failure", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const id = await automaticId("ROLLBACK-LOCAL");
  const hash = await digest("rollback-local-token");
  db.failSql = (sql) => sql.includes("INSERT INTO relay_records");
  await assert.rejects(store.registerDevice(id, identity, hash), /simulated D1/);
  db.failSql = undefined;
  assert.equal(await store.getDeviceRecord(id), null);
  assert.equal(await store.get(keys.device(id), "json"), null);
  assert.equal((await store.registerDevice(id, identity, hash)).created, true);
});

test("delivery leases allow only one concurrent owner and stale releases cannot clear a renewed lease", async (t) => {
  const time = clock(t);
  const { env } = d1Fixture(t);
  const store = dataStore(env);
  const expires = time.seconds() + 600;
  await store.createEvent(event(time, { device_id: "manual", expires_at: expires }));
  const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimDelivery("manual", "event-001", "channel-001", expires, time.now())));
  assert.equal(claims.filter(Boolean).length, 1);
  const owner = claims.find(Boolean);
  await store.releaseDelivery("manual", "event-001", "channel-001", "not-the-owner");
  assert.equal(await store.claimDelivery("manual", "event-001", "channel-001", expires, time.now()), null);
  time.advance(45_000);
  const renewed = await store.claimDelivery("manual", "event-001", "channel-001", expires, time.now());
  assert.ok(renewed);
  assert.notEqual(renewed, owner);
  await store.releaseDelivery("manual", "event-001", "channel-001", owner);
  assert.equal(await store.claimDelivery("manual", "event-001", "channel-001", expires, time.now()), null);
  await store.releaseDelivery("manual", "event-001", "channel-001", renewed);
  assert.ok(await store.claimDelivery("manual", "event-001", "channel-001", expires, time.now()));
  assert.ok(await store.claimDelivery("manual", "event-001", "channel-002", expires, time.now()));
  assert.equal(await store.claimDelivery("manual", "expired-event", "channel-001", time.seconds(), time.now()), null);
  assert.equal(await store.claimDelivery("manual", "missing-event", "channel-001", expires, time.now()), null);
});

test("authenticated provisioning directly swaps a non-null credential with a monotonic version, session invalidation and atomic command retirement", async (t) => {
  const time = clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const id = await automaticId("PROVISION-CAS");
  const original = await digest("provision-original-local-token");
  const replacement = await digest("provision-replacement-local-token");
  await store.registerDevice(id, identity, original);
  const session = newToken();
  await activateSmsSession(env, id, original, session);
  const messages = await Promise.all(["在途", "排队"].map((content) => queueSms(env, { request_id: crypto.randomUUID(), device_id: id, to: "10086", content })));
  const dispatched = await nextSmsCommand(env, id, original, session);
  const before = await store.getDeviceRecord(id);
  time.advance(1000);
  const next = await store.provisionDeviceRecord(id, { expectedVersion: before.credentialVersion, hash: replacement });
  assert.equal(next.hash, replacement);
  assert.equal(next.revokedHash, original);
  assert.equal(next.credentialVersion, before.credentialVersion + 1);
  assert.equal(next.commandSession, null);
  assert.equal((await store.get(keys.deviceToken(id), "json")).hash, replacement);
  assert.equal((await store.get(keys.device(id), "json")).enrollment_pending, false);
  assert.equal(Object.hasOwn(await store.get(keys.device(id), "json"), "credential_version"), false);
  for (const entry of messages) {
    const expected = entry.command.id === dispatched.id ? "unknown" : "cancelled";
    assert.equal(db.row("SELECT status FROM sms_commands WHERE id = ?", entry.command.id).status, expected);
    assert.equal(db.row("SELECT send_status FROM sms_messages WHERE id = ?", entry.item.id).send_status, expected);
  }
  assert.equal(await nextSmsCommand(env, id, original, session), null);
  const after = snapshot(db);
  for (const options of [
    { expectedVersion: before.credentialVersion, hash: await digest("stale-cas-local-token") },
    { expectedVersion: next.credentialVersion, hash: replacement },
    { expectedVersion: next.credentialVersion, hash: original },
  ]) {
    await assert.rejects(store.provisionDeviceRecord(id, options), status(409));
    assert.deepEqual(snapshot(db), after);
  }
  for (const expectedVersion of [-1, "2", 2.5, null, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(store.provisionDeviceRecord(id, { expectedVersion, hash: replacement }), status(400));
  }
  await assert.rejects(store.provisionDeviceRecord(id, { expectedVersion: next.credentialVersion, hash: null }), status(400));
  await store.updateDeviceRecord(id, { enabled: false });
  const disabled = snapshot(db);
  await assert.rejects(store.provisionDeviceRecord(id, { expectedVersion: next.credentialVersion, hash: await digest("disabled-local-token") }), status(403));
  assert.deepEqual(snapshot(db), disabled);
  await store.deleteDeviceRecord(id);
  const deleted = snapshot(db);
  await assert.rejects(store.provisionDeviceRecord(id, { expectedVersion: next.credentialVersion, hash: await digest("deleted-local-token") }), status(404));
  assert.deepEqual(snapshot(db), deleted);
});

test("competing provision CAS requests have one winner, never expose NULL, reject stale versions and roll back all projections", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const id = await automaticId("PROVISION-RACE");
  const original = await digest("race-original-local-token");
  await store.registerDevice(id, identity, original);
  const candidates = await Promise.all(Array.from({ length: 10 }, (_, n) => digest(`candidate-local-token-${n}`)));
  const results = await Promise.allSettled(candidates.map((hash) => store.provisionDeviceRecord(id, { expectedVersion: 1, hash })));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  for (const result of results.filter(({ status }) => status === "rejected")) assert.equal(result.reason.status, 409);
  const winner = await store.getDeviceRecord(id);
  assert.equal(winner.credentialVersion, 2);
  assert.ok(winner.hash);
  assert.equal((await store.get(keys.deviceToken(id), "json")).hash, winner.hash);
  const fresh = await digest("next-monotonic-local-token");
  const before = snapshot(db);
  db.failSql = (sql) => sql.includes("UPDATE sms_messages SET send_status");
  await assert.rejects(store.provisionDeviceRecord(id, { expectedVersion: 2, hash: fresh }), /simulated D1/);
  db.failSql = undefined;
  assert.deepEqual(snapshot(db), before);
  const next = await store.provisionDeviceRecord(id, { expectedVersion: 2, hash: fresh });
  assert.equal(next.credentialVersion, 3);
  assert.equal(next.revokedHash, winner.hash);
  assert.equal(next.hash, fresh);
  assert.ok(db.sessions.every((mode) => mode === "first-primary"));
});

test("a provisioning loser rechecks registry CAS and cannot project or invalidate a newer authority generation", async (t) => {
  clock(t);
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const id = await automaticId("PROVISION-INTERLEAVE");
  const old = await digest("interleave-original-local-token");
  const proposed = await digest("interleave-proposed-local-token");
  const racing = await digest("interleave-winning-local-token");
  await store.registerDevice(id, identity, old);
  let afterRace;
  db.beforeBatch = (statements) => {
    if (!statements.some(({ sql }) => sql.includes("RETURNING credential_version"))) return;
    db.beforeBatch = undefined;
    db.sqlite.prepare("UPDATE device_registry SET token_hash = ?, revoked_hash = ?, credential_version = credential_version + 1 WHERE id = ?")
      .run(racing, old, id);
    afterRace = snapshot(db);
  };
  await assert.rejects(store.provisionDeviceRecord(id, { expectedVersion: 1, hash: proposed }), status(409));
  assert.ok(afterRace);
  assert.deepEqual(snapshot(db), afterRace);
  assert.equal((await store.getDeviceRecord(id)).hash, racing);
});
