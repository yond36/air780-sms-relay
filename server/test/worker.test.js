import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { dataStore } from "../src/db.js";
import { sweepPending } from "../src/delivery.js";
import { normalizeEvent, recordEvent } from "../src/events.js";
import { acceptIncoming } from "../src/ingest.js";
import { digest, newToken } from "../src/security.js";
import { closeDeviceConnection } from "../src/realtime.js";
import { activateSmsSession, nextSmsCommand, queueSms } from "../src/sms.js";
import { runScheduledJobs, slotsInWindow } from "../src/scheduler.js";
import { keys, putJson } from "../src/store.js";
import { clock, d1Fixture } from "./helpers/d1-sqlite.js";

const BASE = "https://relay.example";
const ADMIN = "/api/v1/admin";
const PASSWORD = "a-local-test-password";

function fixture(t) {
  const { db, env } = d1Fixture(t, {
    ADMIN_PASSWORD: PASSWORD,
    APP_SECRET: "a-test-secret-used-only-by-this-fixture",
    RELAY_REGISTRATION_LIMIT: { async limit() { return { success: true }; } },
  });
  const store = dataStore(env);
  let cookie;
  async function request(path, { method = "GET", body, token, authenticated = true } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    if (authenticated && cookie) headers.Cookie = cookie;
    const background = [];
    const response = await worker.fetch(new Request(`${BASE}${path}`, { method, headers, body: JSON.stringify(body) }), env, {
      waitUntil(task) { background.push(task); },
    });
    await Promise.all(background);
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login() {
    const response = await request(`${ADMIN}/login`, { method: "POST", body: { password: PASSWORD } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    cookie = response.headers.get("Set-Cookie").split(";")[0];
    return response;
  }
  async function create(resource, body) {
    const result = await request(`${ADMIN}/${resource}`, { method: "POST", body });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  return { db, env, store, request, login, create };
}

const sms = {
  version: 1,
  device_id: "air780-lab",
  event_id: "sms-00001",
  type: "sms.received",
  occurred_at: "2026-06-10T15:04:05+08:00",
  data: { sender: "10086", content: "设备测试信息\n第二行 🙂" },
  status: { operator: "测试运营商", rsrp_dbm: -93 },
};

function upload(fx, event, token) {
  return fx.request("/api/v1/events", { method: "POST", body: event, token });
}

async function webhook(fx, name, url) {
  const config = { url, method: "POST", bodyType: "json", body: '{"title":"{{TITLE}}","body":"{{BODY}}"}' };
  return (await fx.create("channels", { name, type: "webhook", config })).item;
}

function register(fx, token, identity_type, identity_value) {
  return fx.request("/api/v1/devices/register", { method: "POST", token, body: { version: 1, identity_type, identity_value } });
}

test("automatic devices register directly in D1 without a session binding and appear in admin selection", async (t) => {
  const fx = fixture(t);
  const token = newToken();
  const first = await register(fx, token, "imei", "012345678901234");
  assert.equal(first.status, 201);
  const id = first.data.device_id;
  assert.match(id, /^auto~[A-Za-z0-9_-]{43}$/);
  assert.equal((await fx.store.get(keys.device(id), "json")).id, id);
  assert.equal(fx.db.row("SELECT COUNT(*) AS count FROM device_registry").count, 1);
  assert.deepEqual((await register(fx, token, "imei", " 012345678901234 ")).data, { ok: true, device_id: id });
  const report = { ...sms, device_id: id };
  assert.equal((await upload(fx, report, token)).status, 202);
  assert.equal((await upload(fx, report, token)).status, 200);
  await fx.login();
  const item = (await fx.request(`${ADMIN}/devices`)).data.items[0];
  assert.equal(item.identity_value, "012345678901234");
  assert.equal(item.name, "设备 1234");
  assert.equal(item.enrollment, "automatic");
  assert.equal(item.enabled, true);
  assert.equal(item.status.rsrp_dbm, -93);
  assert.ok(!JSON.stringify([fx.db.rows("SELECT * FROM relay_records"), fx.db.rows("SELECT * FROM device_registry")]).includes(token));
  const channel = await webhook(fx, "测试渠道", "https://example.test/hook");
  await fx.create("rules", { name: "自动设备规则", device_ids: [id], channel_ids: [channel.id] });
  await fx.create("jobs", { name: "设备状态", kind: "status", device_ids: [id], channel_ids: [channel.id], schedule: { mode: "daily", time: "09:00" } });
  assert.equal((await fx.request(`${ADMIN}/events/${id}/${sms.event_id}`)).data.item.device_id, id);
  assert.equal((await fx.request(`${ADMIN}/events?${new URLSearchParams({ device_id: id })}`)).data.items[0].device_id, id);
});

test("hardware claim is atomic and disabled, rebound or deleted devices reject superseded credentials", async (t) => {
  const fx = fixture(t);
  const tokens = [newToken(), newToken()];
  const results = await Promise.all([
    register(fx, tokens[0], "sn", "test-sn-003"),
    register(fx, tokens[1], "sn", " TEST-SN-003 "),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const winner = results.findIndex((result) => result.status === 201);
  const id = results[winner].data.device_id;
  const token = tokens[winner];
  const report = { ...sms, device_id: id };
  await fx.login();
  const path = `${ADMIN}/devices/${id}`;
  assert.equal((await fx.request(path)).data.item.identity_value, "TEST-SN-003");
  assert.equal((await fx.request(`${path}/rebind`, { method: "POST", authenticated: false })).status, 401);
  await fx.request(path, { method: "PUT", body: { name: "已命名设备", enabled: false } });
  assert.equal((await upload(fx, report, token)).status, 403);
  assert.equal((await register(fx, token, "sn", "test-sn-003")).status, 403);
  await fx.request(path, { method: "PUT", body: { name: "已命名设备", enabled: true } });
  const rebind = await fx.request(`${path}/rebind`, { method: "POST" });
  assert.equal(rebind.data.item.enrollment_pending, true);
  assert.equal((await upload(fx, report, token)).status, 401);
  assert.equal((await register(fx, token, "sn", "test-sn-003")).status, 409);
  const replacement = newToken();
  assert.deepEqual((await register(fx, replacement, "sn", "test-sn-003")).data, { ok: true, device_id: id });
  assert.equal((await fx.request(path)).data.item.name, "已命名设备");
  assert.equal((await upload(fx, report, replacement)).status, 202);
  assert.equal((await fx.request(path, { method: "DELETE" })).status, 200);
  assert.equal((await fx.request(path, { method: "DELETE" })).status, 200);
  assert.equal((await register(fx, replacement, "sn", "test-sn-003")).status, 410);
  assert.equal((await upload(fx, report, replacement)).status, 403);
  assert.equal(await fx.store.get(keys.latest(id), "json"), null);
});

test("a failed D1 registration leaves no partial binding and can be retried", async (t) => {
  const fx = fixture(t);
  const token = newToken();
  fx.db.failSql = (sql) => sql.includes("INSERT INTO device_registry");
  assert.equal((await register(fx, token, "sn", "D1-REGISTRATION-RETRY")).status, 503);
  assert.equal(fx.db.row("SELECT COUNT(*) AS count FROM device_registry").count, 0);
  assert.equal(fx.db.row("SELECT COUNT(*) AS count FROM relay_records").count, 0);
  fx.db.failSql = undefined;
  const retried = await register(fx, token, "sn", "D1-REGISTRATION-RETRY");
  assert.equal(retried.status, 201);
  assert.equal((await upload(fx, { ...sms, device_id: retried.data.device_id }, token)).status, 202);
});

test("admin storage status reports only D1 counts and removed migration endpoints return 404", async (t) => {
  const fx = fixture(t);
  assert.equal((await fx.request(`${ADMIN}/storage/status`)).status, 401);
  await fx.login();
  const { token } = await fx.create("devices", { id: sms.device_id, name: "统计测试终端" });
  assert.equal((await upload(fx, sms, token)).status, 202);
  const tables = ["relay_records", "device_registry", "sms_messages", "sms_commands"];
  const counts = Object.fromEntries(tables.map((table) => [table, fx.db.row(`SELECT COUNT(*) AS count FROM ${table}`).count]));
  const response = await fx.request(`${ADMIN}/storage/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { ok: true, mode: "d1", counts });
  for (const action of ["import-kv", "import-device"]) {
    assert.equal((await fx.request(`${ADMIN}/storage/${action}`, { method: "POST", body: {} })).status, 404);
  }
});

test("registration requires a valid identifier and applies the source limit", async (t) => {
  const fx = fixture(t);
  const token = newToken();
  assert.equal((await register(fx, undefined, "imei", "012345678901234")).status, 401);
  assert.equal((await register(fx, token, "imei", "000000000000000")).status, 400);
  assert.equal((await register(fx, token, "sn", "无效标识")).status, 400);
  fx.env.RELAY_REGISTRATION_LIMIT = { async limit() { return { success: false }; } };
  const result = await register(fx, token, "imei", "012345678901234");
  assert.equal(result.status, 429);
  assert.equal(result.headers.get("Retry-After"), "60");
});

test("an authenticated enrollment replay skips registry writes and does not consume a new claim limit", async (t) => {
  const fx = fixture(t);
  const token = newToken();
  const identity = "D1-FAST-ENROLLMENT";
  assert.equal((await register(fx, token, "sn", identity)).status, 201);
  const before = fx.db.rows("SELECT * FROM device_registry");
  let limits = 0;
  fx.env.RELAY_REGISTRATION_LIMIT = { async limit() { limits++; return { success: false }; } };
  fx.db.failSql = (sql) => sql.includes("INSERT INTO device_registry") || sql.includes("INSERT INTO relay_records");
  const replay = await register(fx, token, "sn", ` ${identity.toLowerCase()} `);
  assert.equal(replay.status, 200);
  assert.equal(limits, 0);
  assert.deepEqual(fx.db.rows("SELECT * FROM device_registry"), before);
  assert.equal((await register(fx, newToken(), "sn", "D1-NEW-LIMITED-ENROLLMENT")).status, 429);
  assert.equal(limits, 1);
  assert.equal(fx.db.row("SELECT COUNT(*) AS count FROM device_registry").count, 1);
});

test("a late revocation callback cannot cancel a new owner's queued or dispatched work", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const id = "late-revocation-lab";
  await fx.create("devices", { id, name: "本地迟到撤权测试" });
  const oldRecord = await fx.store.getDeviceRecord(id);
  const oldSession = newToken();
  await activateSmsSession(fx.env, id, oldRecord.hash, oldSession);
  const queued = (content) => queueSms(fx.env, { request_id: crypto.randomUUID(), device_id: id, to: "10086", content });
  const previous = await queued("本地旧命令");
  await nextSmsCommand(fx.env, id, oldRecord.hash, oldSession);
  await fx.store.rebindDeviceRecord(id);
  assert.equal(fx.db.row("SELECT status FROM sms_commands WHERE id = ?", previous.command.id).status, "unknown");
  const hash = await digest(newToken());
  await putJson(fx.store, keys.deviceToken(id), { hash });
  const sessionId = newToken();
  await activateSmsSession(fx.env, id, hash, sessionId);
  const current = await queued("本地新命令一");
  const waiting = await queued("本地新命令二");
  const claimed = await nextSmsCommand(fx.env, id, hash, sessionId);
  assert.ok([current.command.id, waiting.command.id].includes(claimed.id));
  const registry = await fx.store.getDeviceRecord(id);
  // No DEVICE_SESSION binding: this formerly still issued an unconditional D1
  // cancellation after the registry transaction, corrupting the new owner.
  await closeDeviceConnection(fx.env, id);
  assert.deepEqual(await fx.store.getDeviceRecord(id), registry);
  const statuses = [current.command.id, waiting.command.id].map((commandId) => fx.db.row("SELECT status FROM sms_commands WHERE id = ?", commandId).status).sort();
  assert.deepEqual(statuses, ["dispatched", "queued"]);
  assert.equal(fx.db.row("SELECT dispatch_session FROM sms_commands WHERE id = ?", claimed.id).dispatch_session, sessionId);
});

test("recovery is envelope metadata: archive every boot, suppress only new recovered boot routes, retain the event fingerprint", async (t) => {
  const fx = fixture(t);
  await fx.login();
  await fx.create("devices", { id: sms.device_id, name: "本地恢复测试终端" });
  const channel = await webhook(fx, "模拟恢复通知", "https://local-recovery.test/hook");
  await fx.create("rules", { name: "恢复归档", device_ids: [sms.device_id], channel_ids: [channel.id] });
  const device = (await fx.store.getDeviceRecord(sms.device_id)).device;
  let sends = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url instanceof Request ? url.url : url).hostname, "local-recovery.test");
    sends++;
    return new Response("{}", { status: 200 });
  };
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  const archives = [];
  for (const sequence of [1, 2, 3, 5]) {
    const event = { version: 1, device_id: device.id, event_id: `recovered-boot-${sequence}`, type: "device.boot", data: { reason: "本地断线开机", sequence }, status: { boot_nonce: `test-nonce-${sequence}` } };
    const accepted = await acceptIncoming(fx.env, event, device, { recovered: true });
    assert.equal(accepted.created, true);
    assert.equal(accepted.dispatch, false);
    assert.deepEqual(accepted.item.routes, []);
    assert.deepEqual(accepted.item.data, event.data);
    assert.deepEqual(accepted.item.status, event.status);
    assert.equal(accepted.item.fingerprint, await digest(canonical(normalizeEvent(event))));
    assert.equal(await fx.store.get(keys.pending(device.id, event.event_id), "json"), null);
    archives.push({ event, item: accepted.item });
  }
  const replay = await acceptIncoming(fx.env, archives[0].event, device, { recovered: false });
  assert.equal(replay.created, false);
  assert.equal(replay.dispatch, false);
  assert.equal(replay.item.fingerprint, archives[0].item.fingerprint);
  assert.deepEqual(replay.item.routes, []);
  // Even an accidental pending marker cannot cause a recovered boot to notify:
  // no notification routes were persisted in the durable event record.
  await putJson(fx.store, keys.pending(device.id, archives[0].event.event_id), { device_id: device.id, event_id: archives[0].event.event_id });
  await sweepPending(fx.env);
  assert.equal(sends, 0);
  assert.equal(await fx.store.get(keys.pending(device.id, archives[0].event.event_id), "json"), null);
  const liveBoot = { ...archives[0].event, event_id: "live-boot", data: { reason: "本地实时开机" } };
  const live = await acceptIncoming(fx.env, liveBoot, device);
  assert.equal(live.created, true);
  assert.equal(live.dispatch, true);
  assert.equal(live.item.routes.length, 1);
  const laterRecovered = await acceptIncoming(fx.env, liveBoot, device, { recovered: true });
  assert.equal(laterRecovered.created, false);
  assert.equal(laterRecovered.item.fingerprint, live.item.fingerprint);
  assert.deepEqual(laterRecovered.item.routes, live.item.routes, "recovery cannot remove routes from an already-created live boot");
  const incoming = await acceptIncoming(fx.env, { ...sms, event_id: "recovered-sms" }, device, { recovered: true });
  assert.equal(incoming.item.routes.length, 1);
  assert.equal(incoming.dispatch, true);
  const call = await acceptIncoming(fx.env, { version: 1, device_id: device.id, event_id: "recovered-call", type: "call.incoming", data: { number: "10086" } }, device, { recovered: true });
  assert.equal(call.item.routes.length, 1);
  assert.equal(call.dispatch, true);
  await sweepPending(fx.env);
  assert.equal(sends, 3, "live boot and recovered SMS/call still notify through the mock");
  const list = await fx.request(`${ADMIN}/events?type=device.boot`);
  assert.equal(list.data.items.length, 5);
  assert.equal(list.data.items.filter((item) => item.delivery_status === "unrouted").length, 4);
  assert.equal(fx.db.row("SELECT COUNT(*) AS count FROM sms_messages WHERE direction = 'incoming'").count, 1);
  await assert.rejects(acceptIncoming(fx.env, { ...liveBoot, event_id: "bad-recovery-flag" }, device, { recovered: "true" }), /恢复标识/);
});

test("admin session, device enrollment and duplicate durable acknowledgement", async (t) => {
  const fx = fixture(t);
  assert.equal((await fx.request(`${ADMIN}/devices`)).status, 401);
  assert.equal((await fx.request(`${ADMIN}/login`, { method: "POST", body: { password: "wrong" } })).status, 401);
  const login = await fx.login();
  assert.match(login.headers.get("Set-Cookie"), /HttpOnly; SameSite=Strict; Secure/);
  const { token } = await fx.create("devices", { id: sms.device_id, name: "接收终端" });
  assert.equal(token.length, 43);
  assert.equal((await upload(fx, sms, "x".repeat(43))).status, 401);
  assert.equal((await upload(fx, { ...sms, version: 2 }, token)).status, 400);
  const accepted = await upload(fx, sms, token);
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.data, { ok: true, accepted: true, event_id: sms.event_id });
  const reordered = { ...sms, data: { content: sms.data.content, sender: sms.data.sender } };
  assert.equal((await upload(fx, reordered, token)).status, 200);
  assert.equal((await upload(fx, { ...sms, data: { ...sms.data, content: "不同内容" } }, token)).status, 409);
  const listed = await fx.request(`${ADMIN}/events?type=sms.received`);
  assert.equal(listed.data.items.length, 1);
  assert.equal(listed.data.items[0].data.content, sms.data.content);
  assert.equal(listed.data.items[0].occurred_at, "2026-06-10T07:04:05.000Z");
  assert.equal(listed.data.items[0].delivery_status, "unrouted");
  assert.equal((await fx.request(`${ADMIN}/devices/${sms.device_id}`)).data.item.status.rsrp_dbm, -93);
  assert.ok(!JSON.stringify([fx.db.rows("SELECT * FROM relay_records"), fx.db.rows("SELECT * FROM device_registry")]).includes(token));
});

test("channel credentials remain hidden and routes retry independently", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const { token } = await fx.create("devices", { id: sms.device_id, name: "接收终端" });
  const first = await webhook(fx, "渠道一", "https://one.example/hook?key=mock-private-value");
  const second = await webhook(fx, "渠道二", "https://two.example/hook");
  assert.ok(first.secret_fields.includes("url"));
  assert.equal(first.config.url, undefined);
  assert.ok(!JSON.stringify([fx.db.rows("SELECT * FROM relay_records"), fx.db.rows("SELECT * FROM device_registry")]).includes("mock-private-value"));
  const template = (await fx.create("templates", { name: "短信格式", title: "{{DEVICE_NAME}}", body: "{{FROM}}\n{{SMS}}" })).item;
  await fx.create("rules", { name: "设备短信", device_ids: [sms.device_id], event_types: [sms.type], template_id: template.id, channel_ids: [first.id, second.id] });
  const invalid = await fx.request(`${ADMIN}/templates/preview`, { method: "POST", body: { title: "{{UNKNOWN}}", body: "", type: sms.type } });
  assert.equal(invalid.status, 400);
  const preview = await fx.request(`${ADMIN}/templates/preview`, { method: "POST", body: { title: "{{DEVICE_NAME}}", body: "{{FROM}}", type: sms.type } });
  assert.equal(preview.data.body, "10086");
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let isBusy = true;
  globalThis.fetch = async (input, init = {}) => {
    const hostname = new URL(input instanceof Request ? input.url : input).hostname;
    calls.push({ hostname, body: init.body, headers: init.headers });
    if (hostname === "two.example" && isBusy) return new Response("{}", { status: 429, headers: { "Retry-After": "30" } });
    return new Response("{}", { status: 200 });
  };
  assert.equal((await upload(fx, sms, token)).status, 202);
  const path = `${ADMIN}/events/${sms.device_id}/${sms.event_id}`;
  const detail = (await fx.request(path)).data.item;
  const state = Object.fromEntries(detail.deliveries.map((entry) => [entry.channel_id, entry.state]));
  assert.equal(state[first.id], "sent");
  assert.equal(state[second.id], "retry");
  assert.equal(calls.length, 2);
  assert.match(calls[0].body, /设备测试信息/);
  assert.equal((await upload(fx, sms, token)).status, 200);
  assert.equal(calls.length, 2);
  assert.equal((await fx.request(`${path}/retry`, { method: "POST", body: { channel_id: first.id } })).status, 409);
  assert.equal((await fx.request(`${path}/retry`, { method: "POST", body: { channel_id: second.id } })).status, 202);
  isBusy = false;
  await sweepPending(fx.env, () => Date.now() + 120_000);
  assert.equal((await fx.request(path)).data.item.delivery_status, "delivered");
  assert.equal(calls.filter(({ hostname }) => hostname === "one.example").length, 1);
  assert.equal(calls.filter(({ hostname }) => hostname === "two.example").length, 2);
});

test("a failed pending write is repaired before acknowledging the replay", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const { token } = await fx.create("devices", { id: sms.device_id, name: "接收终端" });
  const channel = await webhook(fx, "测试渠道", "https://recover.example/hook");
  await fx.create("rules", { name: "恢复测试", channel_ids: [channel.id] });
  let outgoing = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    outgoing++;
    return new Response("{}");
  };
  fx.db.failSql = (sql, params) => sql.includes("INSERT INTO relay_records") && String(params[0]).startsWith("pending:");
  assert.equal((await upload(fx, sms, token)).status, 503);
  assert.ok(await fx.store.get(keys.event(sms.device_id, sms.event_id), "json"));
  assert.equal(outgoing, 0);
  fx.db.failSql = undefined;
  const retried = await upload(fx, sms, token);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.accepted, true);
  assert.equal(outgoing, 1);
});

test("event history shows the newest records across pages", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const now = Date.now();
  for (let index = 0; index < 18; index++) {
    const event = { ...sms, event_id: `timeline-${String(index).padStart(2, "0")}` };
    await recordEvent(fx.env, event, async () => [], { now: now + index * 1000 });
  }
  const first = await fx.request(`${ADMIN}/events`);
  assert.equal(first.data.items[0].event_id, "timeline-17");
  assert.equal(first.data.items.at(-1).event_id, "timeline-02");
  const second = await fx.request(`${ADMIN}/events?${new URLSearchParams({ cursor: first.data.cursor })}`);
  assert.deepEqual(second.data.items.map((item) => item.event_id), ["timeline-01", "timeline-00"]);
});

test("cron catches up once, daily and weekly slots in their local time zones", async (t) => {
  clock(t, "2026-06-14T01:15:00Z");
  const fx = fixture(t);
  await fx.login();
  const channel = await webhook(fx, "定时渠道", "https://scheduler.example/hook");
  const common = {
    name: "定时通知", enabled: true, kind: "message", channel_ids: [channel.id], device_ids: [], template_id: "",
    title: "{{JOB_NAME}}", body: "通知于 {{RECEIVE_TIME}}", updated_at: "2026-06-01T00:00:00.000Z",
  };
  const jobs = [
    { id: "once", schedule: { mode: "once", at: "2026-06-14T09:11", time_zone: "Asia/Shanghai" } },
    { id: "daily", schedule: { mode: "daily", time: "18:12", time_zone: "America/Los_Angeles" } },
    { id: "weekly", schedule: { mode: "weekly", time: "09:13", time_zone: "Asia/Shanghai", weekdays: [0] } },
  ];
  for (const job of jobs) await putJson(fx.store, keys.job(job.id), { ...common, ...job });
  const tick = Date.parse("2026-06-14T01:15:00Z");
  assert.equal(slotsInWindow("Asia/Shanghai", tick).at(-1).weekday, 0);
  const first = await runScheduledJobs(fx.env, tick, tick);
  assert.equal(first.length, 3);
  assert.ok(first.every(({ created, item }) => created && item.routes.length === 1 && item.routes[0].message.body.includes("2026-06-14T01:")));
  const replay = await runScheduledJobs(fx.env, tick + 5 * 60_000, tick + 5 * 60_000);
  assert.ok(replay.length === 3 && replay.every(({ created, dispatch }) => !created && !dispatch));
});

test("status summaries use the latest device data and offline alerts select only overdue devices", async (t) => {
  clock(t, "2026-06-14T01:15:00Z");
  const fx = fixture(t);
  await fx.login();
  const channel = await webhook(fx, "状态渠道", "https://status.example/hook");
  const tick = Date.parse("2026-06-14T01:15:00Z");
  for (const [id, name, lastSeen, rsrp] of [
    ["offline", "长时间未上报的设备", "2026-06-13T00:00:00.000Z", -111],
    ["online", "刚上报的设备", "2026-06-14T01:10:00.000Z", -85],
  ]) {
    await putJson(fx.store, keys.device(id), { id, name, enabled: true, created_at: "2026-06-01T00:00:00.000Z" });
    await putJson(fx.store, keys.latest(id), { last_seen: lastSeen, status: { rsrp_dbm: rsrp } });
  }
  for (const kind of ["offline", "status"]) {
    await putJson(fx.store, keys.job(kind), {
      id: kind, name: `测试 ${kind}`, kind, enabled: true, offline_minutes: 780,
      channel_ids: [channel.id], device_ids: [], updated_at: "2026-06-01T00:00:00.000Z",
      schedule: { mode: "daily", time: "09:15", time_zone: "Asia/Shanghai" },
    });
  }
  const results = await runScheduledJobs(fx.env, tick, tick);
  const offline = results.find(({ item }) => item.type === "schedule.offline").item.routes[0].message.body;
  assert.match(offline, /长时间未上报的设备/);
  assert.doesNotMatch(offline, /刚上报的设备/);
  const status = results.find(({ item }) => item.type === "schedule.status").item.routes[0].message.body;
  assert.match(status, /-85 dBm/);
  assert.match(status, /-111 dBm/);
});
