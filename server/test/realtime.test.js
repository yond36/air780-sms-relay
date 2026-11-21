import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as LocalResponse } from "miniflare";
import { digest, newToken } from "../src/security.js";
import { closeDeviceConnection, runPresenceAlarm } from "../src/realtime.js";
import { splitMigrationSql } from "./helpers/migration-sql.js";

const workerName = "realtime-test";

function inbox(socket) {
  const waiting = [];
  const received = [];
  const history = [];
  socket.addEventListener("message", (event) => {
    const value = event.data === "q" ? "q" : JSON.parse(event.data);
    history.push(value);
    const index = waiting.findIndex(({ match }) => match(value));
    if (index < 0) received.push(value);
    else {
      const request = waiting.splice(index, 1)[0];
      clearTimeout(request.timer);
      request.resolve(value);
    }
  });
  socket.accept();
  const next = (match) => {
    const index = received.findIndex(match);
    if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const request = { match, resolve };
      request.timer = setTimeout(() => {
        const index = waiting.indexOf(request);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error("Timed out waiting for the expected WebSocket message"));
      }, 4000);
      waiting.push(request);
    });
  };
  next.history = history;
  return next;
}

async function eventually(check, message = "Expected local state was not reached") {
  const deadline = Date.now() + 4000;
  do {
    const value = await check();
    if (value) return value;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(message);
}

function barriers() {
  const armed = new Map();
  return {
    arm(id, phase) {
      let enter, release;
      const gate = {
        entered: new Promise((resolve) => { enter = resolve; }),
        released: new Promise((resolve) => { release = resolve; }),
        release, done: false,
      };
      gate.enter = enter;
      armed.set(`${id}:${phase}`, gate);
      return gate;
    },
    async fetch(request) {
      const { device_id, phase } = await request.json();
      const gate = armed.get(`${device_id}:${phase}`);
      if (gate && !gate.done) {
        gate.done = true;
        gate.enter();
        await gate.released;
      }
      return new LocalResponse("{}");
    },
    releaseAll() { for (const gate of armed.values()) gate.release(); },
  };
}

// This test-only adapter pauses real D1 await boundaries through a local service
// binding. It never changes SQL, credentials, rows, or query results. All socket
// upgrades and callbacks run in the actual SQLite-backed Miniflare DO runtime.
const testEntry = `
import worker from "../src/index.js";
import { DeviceSession as BaseSession } from "../src/device-session.js";
function wrapD1(target, gate) {
  function statement(raw, sql, params = []) {
    return {
      raw, sql, params,
      bind(...values) { return statement(raw.bind(...values), sql, values); },
      first(...args) { return raw.first(...args); },
      all(...args) { return raw.all(...args); },
      run(...args) { return raw.run(...args); },
    };
  }
  async function pause(phase, statements) {
    const device_id = statements.flatMap((item) => item.params).find((value) => typeof value === "string" && /^auto~[A-Za-z0-9_-]{43}$/.test(value));
    await gate.fetch("https://local-await-gate.test/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id, phase }),
    });
  }
  return {
    prepare(sql) { return statement(target.prepare(sql), sql); },
    withSession(mode) { return wrapD1(target.withSession(mode), gate); },
    async batch(statements) {
      const claim = statements.some(({ sql }) => /UPDATE\\s+sms_commands/i.test(sql) && /dispatched_at\\s*=/i.test(sql));
      const activation = statements.some(({ sql }) => /UPDATE\\s+device_registry\\s+SET\\s+command_session/i.test(sql));
      if (claim) await pause("before-claim", statements);
      if (activation) await pause("before-activate", statements);
      const results = await target.batch(statements.map((item) => item.raw));
      if (claim) await pause("after-claim", statements);
      if (activation) await pause("after-activate", statements);
      return results;
    },
  };
}
export class DeviceSession extends BaseSession {
  constructor(state, env) { super(state, { ...env, DB: wrapD1(env.DB, env.RELAY_TEST_GATE) }); }
}
export default worker;
`;

async function fixture(t) {
  const bundle = await build({
    stdin: { contents: testEntry, resolveDir: fileURLToPath(new URL(".", import.meta.url)), sourcefile: "local-realtime-test.js" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"],
  });
  const gates = barriers();
  const sends = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    name: workerName, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2025-11-01",
    d1Databases: ["DB"],
    durableObjects: { DEVICE_SESSION: { className: "DeviceSession", useSQLite: true } },
    ratelimits: { RELAY_REGISTRATION_LIMIT: { namespace_id: "1", simple: { limit: 100, period: 60 } } },
    serviceBindings: { RELAY_TEST_GATE: (request) => gates.fetch(request) },
    outboundService: async (request) => {
      sends.push({ url: request.url, body: await request.text() });
      return new LocalResponse("{}", { status: 200 });
    },
    bindings: { ADMIN_PASSWORD: "realtime-local-test", APP_SECRET: "local-realtime-test-secret-at-least-32-characters" },
    cf: false, log: new Log(LogLevel.ERROR),
  }));
  t.after(async () => { gates.releaseAll(); await runtime.dispose(); });
  const database = await runtime.getD1Database("DB");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    const schema = readFileSync(new URL(file, migrations), "utf8");
    await database.batch(splitMigrationSql(schema).map((sql) => database.prepare(sql)));
  }
  let cookie;
  async function api(path, { method = "GET", body, token, admin = false } = {}) {
    const response = await runtime.dispatchFetch(`http://relay.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(admin && cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const login = await api("/api/v1/admin/login", { method: "POST", body: { password: "realtime-local-test" } });
  assert.equal(login.status, 200);
  cookie = login.headers.get("Set-Cookie").split(";")[0];
  async function upgrade(identity, token, id) {
    const query = id === undefined ? "" : `?${new URLSearchParams({ device_id: id })}`;
    return runtime.dispatchFetch(`http://relay.test/api/v1/device/ws${query}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}`, "X-Relay-Identity-Type": "sn", "X-Relay-Identity-Value": identity },
    });
  }
  async function presence(device, now) {
    const namespace = await runtime.getDurableObjectNamespace("DEVICE_SESSION");
    const response = await namespace.get(namespace.idFromName(device.id)).fetch("https://session.internal/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "presence", device_id: device.id, ...(now === undefined ? {} : { now }) }),
    });
    return { status: response.status, data: await response.json() };
  }
  async function connect(identity, token = newToken(), id) {
    const response = await upgrade(identity, token, id);
    assert.equal(response.status, 101, response.status === 101 ? "" : await response.text());
    const socket = response.webSocket;
    const next = inbox(socket);
    t.after(() => { try { socket.close(); } catch {} });
    const hello = await next((value) => value.type === "hello");
    assert.equal(hello.protocol_version, 2);
    assert.equal(hello.reconciled, true);
    assert.match(hello.session_id, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(hello.device_id, `auto~${await digest(`sn:${identity.trim().toUpperCase()}`)}`);
    assert.equal(hello.heartbeat_seconds, 60);
    assert.ok(Number.isInteger(hello.server_time));
    return { identity, token, id: hello.device_id, socket, next, hello };
  }
  async function queue(device, content = "本地模拟短信") {
    const response = await api("/api/v1/admin/sms", {
      method: "POST", admin: true, body: { request_id: randomUUID(), device_id: device.id, to: "10086", content },
    });
    assert.equal(response.status, 202, JSON.stringify(response.data));
    return response.data;
  }
  const registry = (id) => database.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first();
  const command = (id) => database.prepare("SELECT * FROM sms_commands WHERE id = ?").bind(id).first();
  async function latest(id) {
    const record = await database.prepare("SELECT value FROM relay_records WHERE key = ?").bind(`latest:${id}`).first();
    return record ? JSON.parse(record.value) : null;
  }
  async function eventRecord(id, eventId) {
    const record = await database.prepare("SELECT value FROM relay_records WHERE key = ?").bind(`events:${id}:${eventId}`).first();
    return record ? JSON.parse(record.value) : null;
  }
  return { runtime, database, gates, sends, api, upgrade, connect, presence, queue, registry, command, latest, eventRecord };
}

function ready(device, usable = 14, quarantined = 2, heartbeat_seconds = 60) {
  device.socket.send(JSON.stringify({ type: "ready", session_id: device.hello.session_id, capabilities: ["sms.send"],
    journal: { usable_slots: usable, quarantined_slots: quarantined }, heartbeat_seconds }));
}

async function report(device, eventId, type = "device.test", data = {}, recovered = false, status = {}) {
  const event = { version: 1, device_id: device.id, event_id: eventId, type, data, status };
  device.socket.send(JSON.stringify({ type: "event", recovered, event }));
  const ack = await device.next((value) => value.type === "event_ack" && value.event_id === eventId);
  assert.equal(ack.accepted, true);
  return event;
}

test("local D1 WSS v2 enrollment, durable ownership, races and recovered event routing", { timeout: 90_000 }, async (t) => {
  const fx = await fixture(t);

  await t.test("first upgrade bootstraps identity and waits for durable activation before hello/101", async () => {
    const identity = "REALTIME-FRESH-BOOTSTRAP";
    const token = newToken();
    const id = `auto~${await digest(`sn:${identity}`)}`;
    const gate = fx.gates.arm(id, "before-activate");
    let settled = false;
    const pending = fx.upgrade(identity, token).then((response) => { settled = true; return response; });
    await Promise.race([gate.entered, delay(4000).then(() => { throw new Error("Activation barrier was not entered"); })]);
    assert.equal(settled, false, "101 must not be returned before the activation transaction");
    const before = await fx.registry(id);
    assert.equal(before.token_hash, await digest(token));
    assert.equal(before.command_session, null);
    gate.release();
    const response = await pending;
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    const next = inbox(socket);
    t.after(() => { try { socket.close(); } catch {} });
    const hello = await next((value) => value.type === "hello");
    assert.deepEqual(Object.keys(hello).sort(), ["device_id", "heartbeat_seconds", "protocol_version", "reconciled", "server_time", "session_id", "type"]);
    assert.equal(hello.protocol_version, 2);
    assert.equal(hello.device_id, id);
    assert.equal(hello.reconciled, true);
    assert.match(hello.session_id, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await fx.registry(id)).command_session, hello.session_id);
    assert.ok(!JSON.stringify(await fx.registry(id)).includes(token));
    socket.send("p");
    assert.equal(await next((value) => value === "q"), "q");
    const presence = await fx.presence({ id }, Date.now() + 120_000);
    assert.equal(presence.status, 200);
    assert.equal(presence.data.connection.state, "online");
  });

  await t.test("auto-answered p/q heartbeats keep a session online and silence expires only that connection", async () => {
    const device = await fx.connect("REALTIME-PRESENCE-LEASE");
    ready(device, 14, 2, 60);
    const queued = await fx.queue(device, "仅本地模拟的在途命令");
    await device.next((value) => value.type === "command");
    const commandBeforeExpiry = await fx.command(queued.command.id);
    assert.equal(commandBeforeExpiry.status, "dispatched");
    await report(device, "presence-status", "device.test", {}, false, { rsrp_dbm: -77 });
    device.socket.send("p");
    assert.equal(await device.next((value) => value === "q"), "q");
    const pingAt = Date.now();
    const fresh = await fx.presence(device, pingAt + 50_000);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.connection.state, "online");
    assert.equal(fresh.data.connection.heartbeat_seconds, 60);
    const currentList = await fx.api("/api/v1/admin/devices", { admin: true });
    assert.equal(currentList.data.items.find(({ id }) => id === device.id).connection.state, "online");

    const registryBefore = await fx.registry(device.id);
    const stale = await fx.presence(device, pingAt + 120_000);
    assert.equal(stale.status, 200);
    assert.equal(stale.data.connection.state, "offline");
    assert.equal(stale.data.connection.ready, false);
    assert.equal(stale.data.connection.event_ready, false);
    assert.equal(stale.data.connection.command_ready, false);
    assert.equal((await fx.registry(device.id)).command_session, registryBefore.command_session);
    assert.deepEqual(await fx.command(queued.command.id), commandBeforeExpiry);
    const latest = await fx.latest(device.id);
    assert.equal(latest.status.rsrp_dbm, -77);
    assert.ok(latest.last_seen);
    const listed = await fx.api("/api/v1/admin/devices", { admin: true });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.items.find(({ id }) => id === device.id).connection.state, "offline");

    const slow = await fx.connect("REALTIME-PRESENCE-LEASE-300");
    slow.socket.send(JSON.stringify({ type: "ready", session_id: slow.hello.session_id,
      capabilities: ["sms.send"], journal: { usable_slots: 14, quarantined_slots: 2 } }));
    await eventually(async () => (await fx.latest(slow.id))?.connection?.ready);
    slow.socket.send("p");
    assert.equal(await slow.next((value) => value === "q"), "q");
    const slowPingAt = Date.now();
    const slowFresh = await fx.presence(slow, slowPingAt + 200_000);
    assert.equal(slowFresh.data.connection.state, "online");
    assert.equal(slowFresh.data.connection.heartbeat_seconds, 300);
    assert.equal((await fx.presence(slow, slowPingAt + 400_000)).data.connection.state, "offline");
  });

  await t.test("ready echoes the session and healthy14 capacity; repeat ready/hibernation do not rotate it", async () => {
    const device = await fx.connect("REALTIME-HEALTHY14");
    const queued = await fx.queue(device);
    assert.equal((await fx.command(queued.command.id)).status, "queued");
    device.socket.send(JSON.stringify({ type: "ready", capabilities: ["sms.send"], journal: { usable_slots: 14, quarantined_slots: 2 } }));
    assert.equal((await device.next((value) => value.type === "error")).code, 409);
    device.socket.send(JSON.stringify({ type: "ready", session_id: device.hello.session_id, capabilities: ["sms.send"], journal: { usable_slots: 1.5, quarantined_slots: 2 } }));
    assert.equal((await device.next((value) => value.type === "error")).code, 400);
    ready(device, 0, 16);
    await report(device, "readiness-empty");
    const unavailable = await eventually(async () => {
      const latest = await fx.latest(device.id);
      return latest?.connection?.event_ready && latest.connection.journal.usable_slots === 0 ? latest : null;
    });
    assert.equal(unavailable.connection.ready, false);
    assert.equal(unavailable.connection.command_ready, false);
    assert.equal((await fx.command(queued.command.id)).status, "queued");
    ready(device);
    const wire = await device.next((value) => value.type === "command");
    assert.equal(wire.command.id, queued.command.id);
    assert.equal(wire.command.session_id, device.hello.session_id);
    assert.equal(wire.command.device_id, device.id);
    const healthy = await eventually(async () => {
      const latest = await fx.latest(device.id);
      return latest?.connection?.command_ready ? latest : null;
    });
    assert.equal(healthy.connection.ready, true);
    assert.equal(healthy.connection.event_ready, true);
    assert.deepEqual(healthy.connection.journal, { usable_slots: 14, quarantined_slots: 2 });
    const durable = await fx.registry(device.id);
    ready(device);
    await report(device, "ready-repeat");
    assert.deepEqual(await fx.registry(device.id), durable);
    assert.equal((await fx.command(wire.command.id)).status, "dispatched");
    await fx.runtime.unsafeEvictDurableObject(workerName, "DeviceSession", { name: device.id, webSockets: "hibernate" });
    ready(device);
    await report(device, "ready-after-hibernate");
    assert.deepEqual(await fx.registry(device.id), durable);
    assert.equal((await fx.command(wire.command.id)).dispatch_session, device.hello.session_id);
    assert.equal((await fx.command(wire.command.id)).status, "dispatched");
    assert.equal(device.next.history.filter((value) => value.type === "hello").length, 1);
    device.socket.send(JSON.stringify({ type: "command_result", command_id: wire.command.id, status: "submitted" }));
    await device.next((value) => value.type === "command_result_ack");
    assert.equal((await fx.command(wire.command.id)).status, "submitted");
  });

  for (const phase of ["before-claim", "after-claim"]) {
    await t.test(`${phase} replacement fences stale claim/send and old callbacks cannot replace the new connection`, async () => {
      const device = await fx.connect(`REALTIME-RACE-${phase.toUpperCase()}`);
      const queued = await fx.queue(device, `本地 ${phase} 模拟`);
      const gate = fx.gates.arm(device.id, phase);
      ready(device);
      await Promise.race([gate.entered, delay(4000).then(() => { throw new Error("Claim barrier was not entered"); })]);
      const paused = await fx.command(queued.command.id);
      assert.equal(paused.status, phase === "before-claim" ? "queued" : "dispatched");
      const replacement = await fx.connect(device.identity, device.token, device.id);
      assert.notEqual(replacement.hello.session_id, device.hello.session_id);
      assert.equal((await fx.registry(device.id)).command_session, replacement.hello.session_id);
      assert.equal((await fx.command(queued.command.id)).status, phase === "before-claim" ? "queued" : "unknown");
      gate.release();
      ready(replacement, 0, 16);
      await report(replacement, "replacement-alive");
      const latest = await eventually(async () => {
        const saved = await fx.latest(device.id);
        return saved?.connection?.session_id === replacement.hello.session_id && saved.connection.event_ready ? saved : null;
      });
      const staleSessionCheck = await fx.presence(device, Date.now());
      assert.equal(staleSessionCheck.data.connection.session_id, replacement.hello.session_id);
      assert.equal(staleSessionCheck.data.connection.state, "online");
      assert.equal(latest.connection.state, "online");
      assert.equal(latest.connection.ready, false);
      assert.equal(device.next.history.filter((value) => value.type === "command").length, 0, "the stale socket cannot send the claimed command");
      if (phase === "before-claim") {
        assert.equal((await fx.command(queued.command.id)).status, "queued", "stale SQL cannot claim or retire the current queue");
        ready(replacement);
        const wire = await replacement.next((value) => value.type === "command");
        assert.equal(wire.command.id, queued.command.id);
        assert.equal(wire.command.session_id, replacement.hello.session_id);
      } else {
        // The result's command session is historical; the reporting socket must
        // be current and authenticated, not forced to echo that historical ID.
        replacement.socket.send(JSON.stringify({ type: "command_result", command_id: queued.command.id, session_id: device.hello.session_id, status: "submitted" }));
        const ack = await replacement.next((value) => value.type === "command_result_ack");
        assert.equal(ack.command_id, queued.command.id);
        assert.equal((await fx.command(queued.command.id)).status, "submitted");
        assert.equal(replacement.next.history.filter((value) => value.type === "command").length, 0, "an old dispatched command is never redelivered on the new session");
      }
    });
  }

  await t.test("a delayed revocation callback cannot cancel or disconnect a newly activated owner", async () => {
    const previous = await fx.connect("REALTIME-LATE-REVOCATION");
    const oldQueued = await fx.queue(previous, "本地旧会话模拟");
    ready(previous);
    await previous.next((value) => value.type === "command");
    const revoked = await fx.api(`/api/v1/admin/devices/${previous.id}/rebind`, { method: "POST", admin: true });
    assert.equal(revoked.status, 200);
    assert.equal((await fx.command(oldQueued.command.id)).status, "unknown");
    const current = await fx.connect(previous.identity, newToken(), previous.id);
    const newQueued = await fx.queue(current, "本地新会话模拟");
    ready(current);
    const sent = await current.next((value) => value.type === "command");
    assert.equal(sent.command.id, newQueued.command.id);
    const durable = await fx.registry(current.id);
    const namespace = await fx.runtime.getDurableObjectNamespace("DEVICE_SESSION");
    let response;
    await closeDeviceConnection({
      DB: fx.database,
      DEVICE_SESSION: {
        idFromName: (name) => namespace.idFromName(name),
        get: (id) => ({ async fetch(url, init) { response = await namespace.get(id).fetch(url, init); return response; } }),
      },
    }, current.id);
    assert.equal(response?.status, 200, "the delayed disconnect RPC must actually reach the DO");
    assert.deepEqual(await fx.registry(current.id), durable);
    assert.equal((await fx.command(newQueued.command.id)).status, "dispatched");
    assert.equal((await fx.command(newQueued.command.id)).dispatch_session, current.hello.session_id);
    await report(current, "new-owner-survives-late-revocation");
    const latest = await fx.latest(current.id);
    assert.equal(latest.connection.state, "online");
    assert.equal(latest.connection.session_id, current.hello.session_id);
    assert.equal(latest.connection.command_ready, true);
  });

  await t.test("recovered boots retain their full archive/fingerprint without routes, while recovered SMS/calls still route", async () => {
    const device = await fx.connect("REALTIME-RECOVERY-ARCHIVE");
    ready(device);
    const channel = await fx.api("/api/v1/admin/channels", {
      method: "POST", admin: true,
      body: { name: "本地模拟通知", type: "webhook", config: { url: "https://mock-notifications.test/hook", method: "POST", bodyType: "json", body: '{"title":"{{TITLE}}","body":"{{BODY}}"}' } },
    });
    assert.equal(channel.status, 201);
    const channelId = channel.data.item.id;
    const rule = await fx.api("/api/v1/admin/rules", {
      method: "POST", admin: true,
      body: { name: "本地恢复事件", device_ids: [device.id], event_types: ["device.boot", "sms.received", "call.incoming"], channel_ids: [channelId] },
    });
    assert.equal(rule.status, 201);
    const beforeSends = fx.sends.length;
    const boots = [];
    for (const sequence of [1, 2, 3, 5]) {
      const event = await report(device, `boot-local-${sequence}`, "device.boot", { reason: "本地重启归档", sequence }, true, { boot_nonce: `local-nonce-${sequence}` });
      boots.push(event);
      const saved = await fx.eventRecord(device.id, event.event_id);
      assert.deepEqual(saved.routes, []);
      assert.deepEqual(saved.data, event.data);
      assert.deepEqual(saved.status, event.status);
      assert.equal(await fx.database.prepare("SELECT key FROM relay_records WHERE key = ?").bind(`pending:${device.id}:${event.event_id}`).first(), null);
    }
    const first = await fx.eventRecord(device.id, boots[0].event_id);
    device.socket.send(JSON.stringify({ type: "event", recovered: false, event: boots[0] }));
    await device.next((value) => value.type === "event_ack" && value.event_id === boots[0].event_id);
    const replay = await fx.eventRecord(device.id, boots[0].event_id);
    assert.equal(replay.fingerprint, first.fingerprint, "the outer recovery flag cannot change the event fingerprint");
    assert.deepEqual(replay.routes, [], "a replay cannot add routes to a recovered boot");
    const entrypoint = await fx.runtime.getWorker();
    await entrypoint.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() });
    assert.equal(fx.sends.length, beforeSends, "Cron cannot later notify recovered boot archives");
    await report(device, "boot-local-live", "device.boot", { reason: "本地实时开机" }, false);
    await report(device, "sms-local-recovered", "sms.received", { sender: "10086", content: "本地恢复短信 123456", sim_slot: 0 }, true);
    await report(device, "call-local-recovered", "call.incoming", { number: "10086" }, true);
    await eventually(() => fx.sends.length === beforeSends + 3);
    for (const eventId of ["boot-local-live", "sms-local-recovered", "call-local-recovered"]) {
      assert.equal((await fx.eventRecord(device.id, eventId)).routes.length, 1);
    }
    const bootRecords = await fx.database.prepare("SELECT COUNT(*) AS count FROM relay_records WHERE key GLOB 'events:*' AND json_extract(value, '$.device_id') = ? AND json_extract(value, '$.type') = 'device.boot'").bind(device.id).first();
    assert.equal(bootRecords.count, 5, "all distinct boot archives are retained");
    const archive = await fx.api("/api/v1/admin/sms?q=恢复短信", { admin: true });
    assert.equal(archive.status, 200);
    assert.equal(archive.data.items.length, 1);
    assert.equal(archive.data.items[0].content, "本地恢复短信 123456");
    assert.ok(fx.sends.every(({ url }) => new URL(url).hostname === "mock-notifications.test"), "all notification sends stay inside the local mock");
  });
});
