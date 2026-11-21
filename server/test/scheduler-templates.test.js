import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { dataStore } from "../src/db.js";
import { normalizeJob, runScheduledJobs } from "../src/scheduler.js";
import { keys, putJson } from "../src/store.js";
import { clock, d1Fixture } from "./helpers/d1-sqlite.js";

const TICK = Date.parse("2026-11-21T01:15:00Z");
const schedule = { mode: "daily", time: "09:15", time_zone: "Asia/Shanghai" };
const channel = { id: "local-channel", name: "本地记录渠道", enabled: true };

function job(id, kind = "message", fields = {}) {
  return { id, name: `任务 ${id}`, enabled: true, kind, schedule, device_ids: [], channel_ids: [channel.id],
    offline_minutes: 60, title: "任务内 {{JOB_NAME}}", body: "正文 {{RECEIVE_TIME}}",
    created_at: "2026-11-20T00:00:00.000Z", updated_at: "2026-11-20T00:00:00.000Z", ...fields };
}

async function fixture(t) {
  clock(t, new Date(TICK).toISOString());
  const fx = d1Fixture(t, { ADMIN_PASSWORD: "local-scheduler-test", APP_SECRET: "local-scheduler-test-secret-at-least-32-characters" });
  const store = dataStore(fx.env);
  await putJson(store, keys.channel(channel.id), channel);
  return { ...fx, store };
}

async function saveJobs(fx, jobs) {
  for (const item of jobs) await putJson(fx.store, keys.job(item.id), item);
}

function messageFor(results, id) {
  const event = results.find(({ item }) => item.data.job_id === id)?.item;
  assert.ok(event, `missing scheduled event for ${id}`);
  assert.equal(event.routes.length, 1);
  return event.routes[0].message;
}

test("job template modes validate and preserve the implicit format of existing API inputs", () => {
  const input = job("normalize");
  assert.equal(normalizeJob(input).template_mode, "inline");
  assert.equal(normalizeJob({ ...input, template_id: "shared" }).template_mode, "custom");
  for (const template_mode of ["event", "inline"]) {
    assert.equal(normalizeJob({ ...input, template_mode }).template_mode, template_mode);
    assert.throws(() => normalizeJob({ ...input, template_mode, template_id: "shared" }), /仅共用自定义模板/);
    assert.throws(() => normalizeJob({ ...input, template_mode, body: " " }), /正文/);
  }
  assert.equal(normalizeJob({ ...input, template_mode: "custom", template_id: "shared", body: "" }).template_mode, "custom");
  assert.throws(() => normalizeJob({ ...input, template_mode: "custom" }), /请选择自定义模板/);
  for (const template_mode of ["unknown", "", 1, false]) {
    assert.throws(() => normalizeJob({ ...input, template_mode }), /模板模式/);
  }
});

test("all three scheduled event types use their independently edited default formats", async (t) => {
  const fx = await fixture(t);
  const device = { id: "offline-device", name: "测试设备 {{SMS}}", enabled: true, created_at: "2026-11-20T00:00:00.000Z" };
  await putJson(fx.store, keys.device(device.id), device);
  await putJson(fx.store, keys.latest(device.id), { last_seen: device.created_at, status: { rsrp_dbm: -89 } });
  const jobs = ["message", "status", "offline"].map((kind) => job(kind, kind, { template_mode: "event", body: "提醒 {{JOB_NAME}} 于 {{RECEIVE_TIME}}" }));
  await saveJobs(fx, jobs);
  for (const { kind } of jobs) {
    await putJson(fx.store, keys.eventTemplate(`schedule.${kind}`), { title: `默认 ${kind} {{JOB_NAME}}`, body: `${kind}内容：\n{{CONTENT}}` });
  }
  const results = await runScheduledJobs(fx.env, TICK, TICK);
  assert.equal(results.length, 3);
  assert.deepEqual(messageFor(results, "message"), {
    title: "默认 message 任务 message", body: "message内容：\n提醒 任务 message 于 2026-11-21T01:15:00.000Z",
  });
  const status = messageFor(results, "status");
  assert.equal(status.title, "默认 status 任务 status");
  assert.match(status.body, /status内容：/);
  assert.match(status.body, /信号 -89 dBm/);
  assert.match(status.body, /测试设备 \{\{SMS\}\}/);
  const offline = messageFor(results, "offline");
  assert.equal(offline.title, "默认 offline 任务 offline");
  assert.match(offline.body, /offline内容：\n测试设备 \{\{SMS\}\} · 最后上报/);
  for (const { item } of results) assert.doesNotMatch(item.routes[0].message.title, /任务内/);
});

test("custom and inline modes, including old stored jobs, do not change when event defaults change", async (t) => {
  const fx = await fixture(t);
  await putJson(fx.store, keys.template("shared"), { id: "shared", name: "共用格式", title: "共用 {{JOB_NAME}}", body: "共用正文 {{RECEIVE_TIME}}" });
  await putJson(fx.store, keys.eventTemplate("schedule.message"), { title: "不应使用", body: "不应使用" });
  await saveJobs(fx, [
    job("inline", "message", { template_mode: "inline" }),
    job("old-inline"),
    job("custom", "message", { template_mode: "custom", template_id: "shared", body: "" }),
    job("old-custom", "message", { template_id: "shared", body: "" }),
  ]);
  const results = await runScheduledJobs(fx.env, TICK, TICK);
  for (const id of ["inline", "old-inline"]) {
    assert.deepEqual(messageFor(results, id), { title: `任务内 任务 ${id}`, body: "正文 2026-11-21T01:15:00.000Z" });
  }
  for (const id of ["custom", "old-custom"]) {
    assert.deepEqual(messageFor(results, id), { title: `共用 任务 ${id}`, body: "共用正文 2026-11-21T01:15:00.000Z" });
  }
});

test("restoring a scheduled default affects only new events and not an existing event replay", async (t) => {
  const fx = await fixture(t);
  const item = job("snapshot", "message", { template_mode: "event", body: "通知 {{JOB_NAME}}" });
  await saveJobs(fx, [item]);
  await putJson(fx.store, keys.eventTemplate("schedule.message"), { title: "已保存格式", body: "已保存 {{CONTENT}}" });
  const first = await runScheduledJobs(fx.env, TICK, TICK);
  const saved = structuredClone(first[0].item.routes);
  assert.equal(first[0].created, true);
  await fx.store.delete(keys.eventTemplate("schedule.message"));
  const replay = await runScheduledJobs(fx.env, TICK + 5 * 60_000, TICK + 5 * 60_000);
  assert.equal(replay[0].created, false);
  assert.equal(replay[0].dispatch, false);
  assert.deepEqual(replay[0].item.routes, saved);
  const tomorrow = await runScheduledJobs(fx.env, TICK + 86400_000, TICK + 86400_000);
  assert.deepEqual(messageFor(tomorrow, item.id), { title: item.name, body: `通知 ${item.name}` });
});

test("admin job mode survives save and reload without silently switching existing jobs", async (t) => {
  const fx = await fixture(t);
  const origin = "https://scheduler-test.example";
  let cookie;
  async function request(path, { method = "GET", body } = {}) {
    const response = await worker.fetch(new Request(`${origin}/api/v1/admin${path}`, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), fx.env, { waitUntil() {} });
    return { response, data: await response.json() };
  }
  const login = await request("/login", { method: "POST", body: { password: "local-scheduler-test" } });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get("Set-Cookie").split(";")[0];
  const existing = job("existing");
  await saveJobs(fx, [existing]);
  assert.equal((await request("/jobs/existing")).data.item.template_mode, undefined);
  const inline = await request("/jobs/existing", { method: "PUT", body: existing });
  assert.equal(inline.response.status, 200);
  assert.equal(inline.data.item.template_mode, "inline");
  const changed = await request("/jobs/existing", { method: "PUT", body: { ...inline.data.item, template_mode: "event" } });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
  assert.equal((await request("/jobs/existing")).data.item.template_mode, "event");
  const created = await request("/jobs", { method: "POST", body: { ...job("new"), template_mode: "event" } });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.item.template_mode, "event");
});
