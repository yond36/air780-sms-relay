import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { digest, newToken } from "../src/security.js";
import { splitMigrationSql } from "./helpers/migration-sql.js";

const workerName = "enrollment-sqlite-test";
const adminPassword = "sqlite-local-test-password";

function nextMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", receive);
      reject(new Error(`Timed out waiting for WebSocket ${type}`));
    }, 4000);
    function receive(event) {
      const value = JSON.parse(event.data);
      if (value.type !== type) return;
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      resolve(value);
    }
    socket.addEventListener("message", receive);
  });
}

async function fixture(t, limit = 100) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"],
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: workerName, script: bundle.outputFiles[0].text, modules: true, compatibilityDate: "2025-11-01",
      d1Databases: ["DB"],
      durableObjects: { DEVICE_SESSION: { className: "DeviceSession", useSQLite: true } },
      ratelimits: { RELAY_REGISTRATION_LIMIT: { namespace_id: "1", simple: { limit, period: 60 } } },
      bindings: { ADMIN_PASSWORD: adminPassword, APP_SECRET: "a-local-sqlite-test-secret-with-over-32-characters" },
      outboundService: async () => { throw new Error("Enrollment tests must not send external requests"); },
    }],
    cf: false, log: new Log(LogLevel.ERROR),
  }));
  t.after(() => runtime.dispose());
  const database = await runtime.getD1Database("DB");
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    const schema = readFileSync(new URL(file, directory), "utf8");
    await database.batch(splitMigrationSql(schema).map((sql) => database.prepare(sql)));
  }
  function upgrade(identity, token, deviceId) {
    const query = deviceId === undefined ? "" : `?${new URLSearchParams({ device_id: deviceId })}`;
    return runtime.dispatchFetch(`http://relay.test/api/v1/device/ws${query}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}`, "X-Relay-Identity-Type": "sn", "X-Relay-Identity-Value": identity },
    });
  }
  async function connect(identity, token, deviceId) {
    const response = await upgrade(identity, token, deviceId);
    assert.equal(response.status, 101, response.status === 101 ? "" : await response.text());
    const socket = response.webSocket;
    t.after(() => { try { socket.close(); } catch {} });
    const pending = nextMessage(socket, "hello");
    socket.accept();
    const hello = await pending;
    assert.equal(hello.protocol_version, 2);
    assert.equal(hello.reconciled, true);
    assert.match(hello.session_id, /^[A-Za-z0-9_-]{43}$/);
    return { socket, hello };
  }
  return { runtime, database, upgrade, connect };
}

test("D1 HTTP/header enrollment and WSS session reconstruction share durable authority", { timeout: 60_000 }, async (t) => {
  const { runtime, database, upgrade, connect } = await fixture(t);
  let cookie;
  async function request(path, { method = "GET", body, token, admin = false } = {}) {
    const response = await runtime.dispatchFetch(`http://relay.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(admin && cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const login = await request("/api/v1/admin/login", { method: "POST", body: { password: adminPassword } });
  assert.equal(login.status, 200);
  cookie = login.headers.get("Set-Cookie").split(";")[0];
  const register = (identity, token) => request("/api/v1/devices/register", {
    method: "POST", token, body: { version: 1, identity_type: "sn", identity_value: identity },
  });

  await t.test("concurrent claims, first report and admin changes preserve the D1 binding", async () => {
    const identity = "SQLITE-CONCURRENT";
    const tokens = Array.from({ length: 6 }, () => newToken());
    const attempts = await Promise.all(tokens.map((token) => register(identity, token)));
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [201, 409, 409, 409, 409, 409]);
    const winner = attempts.findIndex(({ status }) => status === 201);
    const token = tokens[winner];
    const id = attempts[winner].data.device_id;
    const record = await database.prepare("SELECT token_hash, deleted FROM device_registry WHERE id = ?").bind(id).first();
    assert.deepEqual(record, { token_hash: await digest(token), deleted: 0 });
    const event = { version: 1, device_id: id, event_id: "first", type: "device.test", data: { reason: "SQLite verification" } };
    assert.equal((await request("/api/v1/events", { method: "POST", body: event, token })).status, 202);
    const path = `/api/v1/admin/devices/${id}`;
    assert.equal((await request(path, { admin: true })).data.item.identity_value, identity);
    assert.equal((await register(identity, token)).status, 200);
    assert.equal((await request("/api/v1/events", { method: "POST", body: event, token })).status, 200);
    assert.equal((await request(path, { method: "PUT", admin: true, body: { name: "设备一", enabled: false } })).status, 200);
    assert.equal((await register(identity, token)).status, 403);
    assert.equal((await upgrade(identity, token, id)).status, 403);
    assert.equal((await request(path, { method: "PUT", admin: true, body: { name: "设备一", enabled: true } })).status, 200);
    assert.equal((await request(`${path}/rebind`, { method: "POST", admin: true })).data.item.enrollment_pending, true);
    assert.equal((await register(identity, token)).status, 409);
    assert.equal((await upgrade(identity, token, id)).status, 409);
    const replacement = newToken();
    const rebound = await connect(identity, replacement, id);
    assert.equal(rebound.hello.device_id, id);
    assert.deepEqual((await register(identity, replacement)).data, { ok: true, device_id: id });
    assert.equal((await request(path, { admin: true })).data.item.name, "设备一");
    assert.equal((await request(path, { method: "DELETE", admin: true })).status, 200);
    assert.equal((await register(identity, replacement)).status, 410);
    assert.equal((await upgrade(identity, replacement, id)).status, 410);
  });

  await t.test("first header-only WSS bootstraps without a device ID or HTTP registration", async () => {
    const identity = "sqlite-header-bootstrap";
    const token = newToken();
    const { hello } = await connect(identity, token);
    const id = `auto~${await digest(`sn:${identity.toUpperCase()}`)}`;
    assert.equal(hello.device_id, id);
    const record = await database.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first();
    assert.equal(record.token_hash, await digest(token));
    assert.equal(record.command_session, hello.session_id);
    assert.equal(record.credential_version, 1);
    assert.equal(JSON.parse(record.device_json).identity_value, identity.toUpperCase());
    assert.ok(!JSON.stringify(record).includes(token));
    const header = { Upgrade: "websocket", Authorization: `Bearer ${token}` };
    assert.equal((await runtime.dispatchFetch("http://relay.test/api/v1/device/ws", { headers: header })).status, 400);
    assert.equal((await runtime.dispatchFetch(`http://relay.test/api/v1/device/ws?identity_type=sn&identity_value=${identity}&token=${token}`, { headers: { Upgrade: "websocket" } })).status, 401);
    assert.equal((await upgrade(identity, token, "different-device")).status, 403);
    assert.equal((await upgrade(identity, newToken(), id)).status, 409);
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM device_registry WHERE id = ?").bind(id).first()).count, 1);
  });

  await t.test("authenticated existing identity bypasses registration/projection writes on WSS and HTTP reconnect", async () => {
    const identity = "SQLITE-FAST-AUTH";
    const token = newToken();
    const first = await connect(identity, token);
    const id = first.hello.device_id;
    const before = await database.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first();
    // These projections are written by store.registerDevice, never by session
    // activation. The trigger proves an authenticated reconnect skips that batch.
    await database.prepare(`CREATE TRIGGER reject_fast_auth_projection BEFORE UPDATE ON relay_records
      WHEN NEW.key IN ('devices:${id}', 'device-tokens:${id}')
      BEGIN SELECT RAISE(ABORT, 'needless enrollment projection write'); END`).run();
    try {
      const reconnect = await connect(identity, token, id);
      assert.notEqual(reconnect.hello.session_id, first.hello.session_id);
      assert.equal((await register(identity, token)).status, 200);
      const after = await database.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first();
      assert.equal(after.device_json, before.device_json);
      assert.equal(after.token_hash, before.token_hash);
      assert.equal(after.credential_version, before.credential_version);
      assert.equal(after.command_session, reconnect.hello.session_id);
    } finally {
      await database.prepare("DROP TRIGGER reject_fast_auth_projection").run();
    }
  });

  await t.test("failed durable activation returns no upgrade and leaves the previous session usable", async () => {
    const identity = "SQLITE-ACTIVATION-ROLLBACK";
    const token = newToken();
    const first = await connect(identity, token);
    const id = first.hello.device_id;
    const before = await database.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first();
    await database.prepare(`CREATE TRIGGER reject_session_activation BEFORE UPDATE OF command_session ON device_registry
      WHEN NEW.id = '${id}' AND NEW.command_session IS NOT OLD.command_session
      BEGIN SELECT RAISE(ABORT, 'local activation rollback'); END`).run();
    try {
      const failed = await upgrade(identity, token, id);
      assert.equal(failed.status, 503);
      assert.equal(Boolean(failed.webSocket), false);
      assert.deepEqual(await database.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first(), before);
      const event = { version: 1, device_id: id, event_id: "session-survived-rollback", type: "device.test", data: { reason: "local activation failure" } };
      const accepted = nextMessage(first.socket, "event_ack");
      first.socket.send(JSON.stringify({ type: "event", recovered: false, event }));
      assert.equal((await accepted).event_id, event.event_id);
    } finally {
      await database.prepare("DROP TRIGGER reject_session_activation").run();
    }
    const retried = await connect(identity, token, id);
    assert.notEqual(retried.hello.session_id, first.hello.session_id);
    assert.equal((await database.prepare("SELECT command_session FROM device_registry WHERE id = ?").bind(id).first()).command_session, retried.hello.session_id);
  });

  await t.test("hibernated sessions retain attachment/session without a second activation", async () => {
    const identity = "SQLITE-SESSION";
    const token = newToken();
    const { socket, hello } = await connect(identity, token);
    const id = hello.device_id;
    const record = await database.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first();
    socket.send(JSON.stringify({ type: "ready", session_id: hello.session_id, capabilities: ["sms.send"], journal: { usable_slots: 14, quarantined_slots: 2 } }));
    const event = { version: 1, device_id: id, event_id: "session-event", type: "device.test", data: { reason: "Session reconstruction" } };
    const firstAck = nextMessage(socket, "event_ack");
    socket.send(JSON.stringify({ type: "event", recovered: false, event }));
    assert.equal((await firstAck).accepted, true);
    await runtime.unsafeEvictDurableObject(workerName, "DeviceSession", { name: id, webSockets: "hibernate" });
    socket.send(JSON.stringify({ type: "ready", session_id: hello.session_id, capabilities: ["sms.send"], journal: { usable_slots: 14, quarantined_slots: 2 } }));
    const replayAck = nextMessage(socket, "event_ack");
    socket.send(JSON.stringify({ type: "event", recovered: false, event }));
    assert.deepEqual(await replayAck, { type: "event_ack", ok: true, accepted: true, event_id: event.event_id });
    assert.equal((await register(identity, token)).status, 200);
    assert.deepEqual(await database.prepare("SELECT * FROM device_registry WHERE id = ?").bind(id).first(), record);
    const saved = await database.prepare("SELECT COUNT(*) AS count FROM relay_records WHERE key = ?").bind(`events:${id}:${event.event_id}`).first();
    assert.equal(saved.count, 1);
    assert.equal((await request("/api/v1/events", { method: "POST", body: event, token })).status, 200);
  });
});

test("fresh WSS enrollment uses the source limiter but authenticated reconnects do not", { timeout: 30_000 }, async (t) => {
  const { upgrade, connect, database } = await fixture(t, 1);
  const identity = "SQLITE-ONE-LIMITED-CLAIM";
  const token = newToken();
  const first = await connect(identity, token);
  const limited = await upgrade("SQLITE-SECOND-LIMITED-CLAIM", newToken());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM device_registry").first()).count, 1);
  const reconnect = await connect(identity, token, first.hello.device_id);
  assert.notEqual(reconnect.hello.session_id, first.hello.session_id);
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM device_registry").first()).count, 1);
});
