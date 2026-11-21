import assert from "node:assert/strict";
import test from "node:test";
import { dataStore } from "../src/db.js";
import { refreshConnectionPresence, refreshDevicePresence, runPresenceAlarm } from "../src/realtime.js";
import { DeviceSession } from "../src/device-session.js";
import { activateSmsSession } from "../src/sms.js";
import { digest, newToken } from "../src/security.js";
import { keys } from "../src/store.js";
import { d1Fixture } from "./helpers/d1-sqlite.js";

async function fixture(t) {
  const { db, env } = d1Fixture(t);
  const store = dataStore(env);
  const identity = { identity_type: "sn", identity_value: "PRESENCE-LEASE-LOCAL" };
  const id = `auto~${await digest(`sn:${identity.identity_value}`)}`;
  const hash = await digest("presence-lease-local-test-token");
  await store.registerDevice(id, identity, hash);
  const sessionId = newToken();
  const activated = await activateSmsSession(env, id, hash, sessionId);
  const connectedAt = Date.now();
  const metadata = {
    id: sessionId, protocol_version: 2, device_id: id, hash, session_id: sessionId,
    credential_version: activated.credential_version, superseded: false, ready: true,
    event_ready: true, command_ready: true, heartbeat_seconds: 60,
    connected_at: new Date(connectedAt).toISOString(), lastHeartbeatAt: null,
    usable_slots: 14, quarantined_slots: 2,
  };
  await store.put(keys.latest(id), JSON.stringify({ last_seen: "2026-11-21T07:00:00.000Z",
    status: { rsrp_dbm: -81 }, connection: {
      id: sessionId, session_id: sessionId, state: "online", ready: true,
      event_ready: true, command_ready: true, heartbeat_seconds: 60,
      connected_at: metadata.connected_at, updated_at: metadata.connected_at,
      journal: { usable_slots: 14, quarantined_slots: 2 },
    } }));
  let lastAutoResponse = connectedAt;
  let alarmAt = null;
  let closed = false;
  const socket = {
    readyState: 1,
    deserializeAttachment: () => metadata,
    serializeAttachment(value) { Object.assign(metadata, value); },
    close() { closed = true; this.readyState = 3; },
  };
  const state = {
    storage: {
      async get(name) { return name === "presence-device-id" ? id : null; },
      async put() {},
      async setAlarm(value) { alarmAt = value; },
      async deleteAlarm() { alarmAt = null; },
    },
    getWebSockets: () => closed ? [] : [socket],
    getWebSocketAutoResponseTimestamp: (candidate) => candidate === socket ? new Date(lastAutoResponse) : null,
  };
  return { db, env, store, id, sessionId, connectedAt, metadata, socket, state,
    get alarmAt() { return alarmAt; }, set lastAutoResponse(value) { lastAutoResponse = value; }, get closed() { return closed; } };
}

test("fresh auto-answered heartbeat keeps WSS online; silence expires it without a close callback", async (t) => {
  const fx = await fixture(t);
  fx.lastAutoResponse = fx.connectedAt + 100_000;
  await runPresenceAlarm(fx.state, fx.env, fx.connectedAt + 120_000);
  let latest = await fx.store.get(keys.latest(fx.id), "json");
  assert.equal(latest.connection.state, "online");
  assert.equal(latest.connection.command_ready, true);
  assert.ok(fx.alarmAt);

  fx.lastAutoResponse = fx.connectedAt;
  await runPresenceAlarm(fx.state, fx.env, fx.connectedAt + 120_000);
  latest = await fx.store.get(keys.latest(fx.id), "json");
  assert.equal(latest.connection.state, "offline");
  assert.equal(latest.connection.ready, false);
  assert.equal(latest.connection.event_ready, false);
  assert.equal(latest.connection.command_ready, false);
  assert.equal(latest.last_seen, "2026-11-21T07:00:00.000Z");
  assert.equal(latest.status.rsrp_dbm, -81);
  assert.equal((await fx.store.getDeviceRecord(fx.id)).commandSession, fx.sessionId);
  assert.equal(fx.closed, true);
  assert.equal(fx.alarmAt, null);
  await fx.store.updateLatestStatus(fx.id, { received_at: "2026-11-21T07:00:02.000Z", type: "device.test.late", status: { temperature: 22 } });
  const afterEvent = await fx.store.get(keys.latest(fx.id), "json");
  assert.equal(afterEvent.connection.state, "offline");
  assert.equal(afterEvent.status.temperature, 22);
});

test("expired projection is durably repaired when its DO no longer has a socket", async (t) => {
  const fx = await fixture(t);
  const state = { ...fx.state, getWebSockets: () => [] };
  await runPresenceAlarm(state, fx.env, fx.connectedAt + 120_000);
  const latest = await fx.store.get(keys.latest(fx.id), "json");
  assert.equal(latest.connection.state, "offline");
  assert.equal(latest.status.rsrp_dbm, -81);
  assert.equal(fx.alarmAt, null);
});

test("device-list presence check updates the returned badge and fails closed when the DO is unavailable", async () => {
  const online = { id: "online-local", connection: { id: "old-session", session_id: "old-session", state: "online", ready: true } };
  const offline = { id: "offline-local", connection: { id: "offline-session", session_id: "offline-session", state: "offline" } };
  const checked = [];
  const env = { DEVICE_SESSION: {
    idFromName: (id) => id,
    get: (id) => ({ async fetch(_url, init) {
      const request = JSON.parse(init.body);
      assert.equal(request.action, "presence");
      assert.equal(request.device_id, id);
      checked.push(id);
      return Response.json({ ok: true, connection: { ...online.connection, state: "offline", ready: false } });
    } }),
  } };
  const result = await refreshDevicePresence(env, [online, offline]);
  assert.deepEqual(checked, [online.id]);
  assert.equal(result[0].connection.state, "offline");
  assert.equal(online.connection.state, "online", "read-time refresh does not mutate the source snapshot");
  assert.equal(result[1], offline);

  env.DEVICE_SESSION.get = () => ({ async fetch() { throw new Error("local simulated DO unavailable"); } });
  const unavailable = await refreshDevicePresence(env, [online]);
  assert.equal(unavailable[0].connection.state, "unknown");
  assert.equal(unavailable[0].connection.command_ready, false);
});

test("SQLite DO alarm keeps live heartbeat sessions and only changes presentation state", async (t) => {
  const fx = await fixture(t);
  const sessions = new Map([["presence-device-id", fx.id]]);
  const state = {
    id: { toString: () => "presence-test-object" },
    storage: {
      async get(key) { return sessions.get(key) ?? null; },
      async put(key, value) { sessions.set(key, value); },
      async setAlarm() {},
      async deleteAlarm() {},
    },
    blockConcurrencyWhile: (callback) => callback(),
    getWebSockets: () => [fx.socket],
    getWebSocketAutoResponseTimestamp: () => new Date(fx.connectedAt),
  };
  const instance = new DeviceSession(state, fx.env);
  let now = fx.connectedAt;
  t.mock.method(Date, "now", () => now);
  await fx.store.updateLatestStatus(fx.id, { received_at: "2026-11-21T07:00:01.000Z", type: "device.test", status: { temperature: 22 } });
  await instance.alarm();
  let latest = await fx.store.get(keys.latest(fx.id), "json");
  assert.equal(latest.connection.state, "online");
  assert.equal(latest.status.temperature, 22);
  assert.equal((await fx.store.getDeviceRecord(fx.id)).commandSession, fx.sessionId);

  state.getWebSocketAutoResponseTimestamp = () => new Date(fx.connectedAt - 600_000);
  now = fx.connectedAt + 120_000;
  await instance.alarm();
  latest = await fx.store.get(keys.latest(fx.id), "json");
  assert.equal(latest.connection.state, "offline");
  assert.equal(latest.connection.command_ready, false);
  assert.equal(latest.status.temperature, 22);
  assert.equal((await fx.store.getDeviceRecord(fx.id)).commandSession, fx.sessionId);
  assert.equal(fx.metadata.superseded, true);
});

test("failed offline projection is retried by the next presence alarm", async (t) => {
  const fx = await fixture(t);
  fx.lastAutoResponse = fx.connectedAt;
  fx.db.failSql = (sql) => sql.includes("UPDATE relay_records SET value = json_set(value, '$.connection'");
  await assert.rejects(runPresenceAlarm(fx.state, fx.env, fx.connectedAt + 120_000), /simulated D1/);
  assert.equal((await fx.store.get(keys.latest(fx.id), "json")).connection.state, "online");
  assert.equal(fx.metadata.superseded, false);
  fx.db.failSql = undefined;
  await runPresenceAlarm(fx.state, fx.env, fx.connectedAt + 120_000);
  assert.equal((await fx.store.get(keys.latest(fx.id), "json")).connection.state, "offline");
});
