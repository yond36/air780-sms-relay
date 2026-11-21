import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { dataStore } from "../src/db.js";
import { dispatchEvent } from "../src/delivery.js";
import { acceptDeviceEvent, makeRoutes, normalizeEvent } from "../src/events.js";
import { keys, putJson } from "../src/store.js";
import { defaultTemplate, eventTypes, renderMessage, sampleEvent } from "../src/templates.js";
import { clock, d1Fixture } from "./helpers/d1-sqlite.js";

const BASE = "https://event-templates.example";
const ADMIN = "/api/v1/admin";
const CATALOG = `${ADMIN}/event-templates`;
const PASSWORD = "local-event-template-password";
const SAMPLE_TIME = Date.parse("2026-11-20T08:00:00.000Z");
const smsFormat = { title: "{{FROM}}", body: "{{SMS}}\n{{SMS_TIME}}\n来自：{{DEVICE_NAME}}" };
const builtins = [
  ["sms.received", "收到短信", "{{DEVICE_NAME}} · 收到短信", "发件号码 {{FROM}}\n接收时间 {{RECEIVE_TIME}}\n\n{{SMS}}"],
  ["call.incoming", "来电", "{{DEVICE_NAME}} · {{EVENT_TYPE}}", "通话号码 {{CALL_NUMBER}}\n事件时间 {{RECEIVE_TIME}}"],
  ["call.disconnected", "通话挂断", "{{DEVICE_NAME}} · {{EVENT_TYPE}}", "通话号码 {{CALL_NUMBER}}\n事件时间 {{RECEIVE_TIME}}"],
  ["device.boot", "设备开机", "{{DEVICE_NAME}} · 设备开机", "开机原因 {{BOOT_REASON}}\n{{DEVICE_INFO}}"],
  ["device.heartbeat", "设备心跳", "{{DEVICE_NAME}} · {{EVENT_TYPE}}", "{{RECEIVE_TIME}}\n{{DEVICE_INFO}}"],
  ["device.test", "设备测试", "{{DEVICE_NAME}} · {{EVENT_TYPE}}", "{{RECEIVE_TIME}}\n{{DEVICE_INFO}}"],
  ["device.location", "基站定位", "{{DEVICE_NAME}} · 基站定位", "{{LOCATION}}\n{{RECEIVE_TIME}}"],
  ["device.traffic", "流量统计", "{{DEVICE_NAME}} · 流量统计", "{{TRAFFIC}}\n{{RECEIVE_TIME}}"],
  ["uart.received", "串口事件", "{{DEVICE_NAME}} · {{EVENT_TYPE}}", "{{CONTENT}}"],
  ["schedule.message", "定时推送", "{{JOB_NAME}}", "{{CONTENT}}"],
  ["schedule.status", "设备状态汇总", "{{JOB_NAME}}", "{{CONTENT}}"],
  ["schedule.offline", "设备离线提醒", "{{JOB_NAME}}", "{{CONTENT}}"],
].map(([id, label, title, body]) => ({ id, label, title, body, customized: false, defaults: { title, body } }));

function fixture(t) {
  const { db, env } = d1Fixture(t, {
    ADMIN_PASSWORD: PASSWORD, APP_SECRET: "local-event-template-secret-not-for-production",
  });
  const store = dataStore(env);
  let cookie;
  async function request(path, { method = "GET", body, authenticated = true, origin = BASE, headers = {} } = {}) {
    const background = [];
    const response = await worker.fetch(new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(authenticated && cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { waitUntil(task) { background.push(task); } });
    await Promise.all(background);
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login() {
    const response = await request(`${ADMIN}/login`, { method: "POST", body: { password: PASSWORD } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    cookie = response.headers.get("Set-Cookie").split(";")[0];
  }
  async function create(resource, body) {
    const response = await request(`${ADMIN}/${resource}`, { method: "POST", body });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.item;
  }
  return { db, env, store, request, login, create };
}

async function routeChannel(fx) {
  const channel = { id: "local-channel", name: "本地路由渠道", enabled: true };
  await putJson(fx.store, keys.channel(channel.id), channel);
  return channel;
}

async function message(fx, channel, event, selection = {}) {
  const routes = await makeRoutes(fx.store, [{ channel_ids: [channel.id], ...selection }], event);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].channel_name, channel.name);
  return routes[0].message;
}

function smsEvent(event_id = "sms-template") {
  return {
    version: 1, device_id: "template-device", device_name: "短信终端", event_id, type: "sms.received",
    occurred_at: "2026-11-20T07:59:00.000Z", received_at: "2026-11-20T08:00:00.000Z",
    data: { sender: "106900", content: "第一行短信\n第二行短信", sms_time: "2026-11-20 15:59:00" }, status: {},
  };
}

test("empty D1 catalog lists all 12 immutable builtins without writing records or paginating", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const before = fx.db.rows("SELECT * FROM relay_records ORDER BY key");
  assert.deepEqual(eventTypes, builtins.map(({ id, label }) => ({ id, label })));
  const response = await fx.request(`${CATALOG}?limit=1&cursor=ignored`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { items: builtins });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  for (const builtin of builtins) {
    const detail = await fx.request(`${CATALOG}/${builtin.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data, { item: builtin });
    assert.deepEqual(defaultTemplate({ type: builtin.id }), builtin.defaults);
    const copy = defaultTemplate({ type: builtin.id });
    copy.title = "不能修改内置标题";
    copy.body = "不能修改内置正文";
    assert.deepEqual(defaultTemplate({ type: builtin.id }), builtin.defaults);
  }
  assert.deepEqual((await fx.request(`${ADMIN}/templates`)).data, { items: [], cursor: null });
  assert.deepEqual(fx.db.rows("SELECT * FROM relay_records ORDER BY key"), before);
});

test("every event type PUT, GET and reset is isolated and uses the separate durable D1 override key", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const channel = await routeChannel(fx);
  const expected = structuredClone(builtins);
  for (const [index, builtin] of builtins.entries()) {
    const template = { title: `{{DEVICE_NAME}} · ${builtin.id}`, body: `事件 ${builtin.id}\n设备 {{DEVICE_ID}}` };
    const saved = await fx.request(`${CATALOG}/${builtin.id}`, {
      method: "PUT", body: { ...template, id: "cannot-add-a-type", label: "不能修改标签", defaults: {}, customized: false },
    });
    expected[index] = { ...builtin, ...template, customized: true };
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data, { item: expected[index] });
    assert.deepEqual((await fx.request(`${CATALOG}/${builtin.id}`)).data, saved.data);
    assert.deepEqual((await fx.request(CATALOG)).data, { items: expected });
    assert.deepEqual(await fx.store.get(keys.eventTemplate(builtin.id), "json"), template);
    assert.equal(fx.db.row("SELECT expires_at FROM relay_records WHERE key = ?", keys.eventTemplate(builtin.id)).expires_at, null);
    const event = sampleEvent(builtin.id, SAMPLE_TIME);
    assert.deepEqual(await message(fx, channel, event), {
      title: `${event.device_name} · ${builtin.id}`, body: `事件 ${builtin.id}\n设备 ${event.device_id}`,
    });
    assert.deepEqual(defaultTemplate(event), builtin.defaults);
  }
  assert.equal(fx.db.row("SELECT COUNT(*) AS count FROM relay_records WHERE key GLOB 'event-templates:*'").count, 12);
  assert.deepEqual((await fx.request(`${ADMIN}/templates`)).data, { items: [], cursor: null });
  for (const [index, builtin] of builtins.entries()) {
    const reset = await fx.request(`${CATALOG}/${builtin.id}`, { method: "DELETE" });
    expected[index] = builtin;
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.data, { item: builtin });
    assert.deepEqual((await fx.request(`${CATALOG}/${builtin.id}`)).data, reset.data);
    assert.deepEqual((await fx.request(CATALOG)).data, { items: expected });
    assert.equal(await fx.store.get(keys.eventTemplate(builtin.id), "json"), null);
    const event = sampleEvent(builtin.id, SAMPLE_TIME);
    assert.deepEqual(await message(fx, channel, event), renderMessage(null, event));
  }
  assert.deepEqual((await fx.request(`${CATALOG}/sms.received`, { method: "DELETE" })).data, { item: builtins[0] });
  assert.equal(fx.db.row("SELECT COUNT(*) AS count FROM relay_records WHERE key GLOB 'event-templates:*'").count, 0);
});

test("the requested SMS format changes only SMS defaults and preview uses the supplied title and body", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const channel = await routeChannel(fx);
  const others = eventTypes.filter(({ id }) => id !== "sms.received").map(({ id }) => sampleEvent(id, SAMPLE_TIME));
  const before = await Promise.all(others.map((event) => message(fx, channel, event)));
  const saved = await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body: smsFormat });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.item.defaults, builtins[0].defaults);
  assert.deepEqual(await message(fx, channel, smsEvent()), {
    title: "106900", body: "第一行短信\n第二行短信\n2026-11-20 15:59:00\n来自：短信终端",
  });
  assert.deepEqual(await Promise.all(others.map((event) => message(fx, channel, event))), before);
  const preview = await fx.request(`${ADMIN}/templates/preview`, { method: "POST", body: { ...smsFormat, type: "sms.received" } });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data, { title: "10086", body: "这是用于预览的短信。\n2026-06-10 15:04:05\n来自：示例设备" });
  const otherPreview = await fx.request(`${ADMIN}/templates/preview`, {
    method: "POST", body: { type: "sms.received", title: "预览 {{DEVICE_ID}}", body: "预览 {{FROM}}" },
  });
  assert.deepEqual(otherPreview.data, { title: "预览 air780-demo", body: "预览 10086" });
});

test("routes batch configs and prioritize explicit custom, inline, event override, then builtin without reset leakage", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const channel = await routeChannel(fx);
  const event = smsEvent();
  const custom = await fx.create("templates", { name: "共享短信模板", title: "共享 {{FROM}}", body: "共享 {{SMS}}" });
  const inline = { title: "行内 {{FROM}}", body: "行内 {{SMS}}" };
  await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body: smsFormat });
  const call = await fx.request(`${CATALOG}/call.incoming`, { method: "PUT", body: { title: "来电 {{FROM}}", body: "号码 {{CALL_NUMBER}}" } });
  const get = t.mock.method(fx.store, "get");
  assert.deepEqual(await message(fx, channel, event, { template_id: custom.id, message_template: inline }), renderMessage(custom, event));
  assert.equal(get.mock.callCount(), 1);
  assert.deepEqual(new Set(get.mock.calls[0].arguments[0]), new Set([
    keys.eventTemplate(event.type), keys.template(custom.id), keys.channel(channel.id),
  ]));
  assert.equal(get.mock.calls[0].arguments[1], "json");
  get.mock.restore();
  assert.deepEqual(await message(fx, channel, event, { message_template: inline }), renderMessage(inline, event));
  assert.deepEqual(await message(fx, channel, event, { template_id: "missing-template", message_template: inline }), renderMessage(inline, event));
  assert.deepEqual(await message(fx, channel, event, { template_id: "missing-template" }), renderMessage(smsFormat, event));
  assert.deepEqual(await message(fx, channel, event), renderMessage(smsFormat, event));
  const reset = await fx.request(`${CATALOG}/sms.received`, { method: "DELETE" });
  assert.deepEqual(reset.data, { item: builtins[0] });
  assert.deepEqual((await fx.request(`${CATALOG}/call.incoming`)).data, call.data);
  assert.deepEqual((await fx.request(`${ADMIN}/templates/${custom.id}`)).data, { item: custom });
  assert.deepEqual((await fx.request(`${ADMIN}/templates`)).data.items, [custom]);
  assert.deepEqual(await message(fx, channel, event), renderMessage(null, event));
  assert.deepEqual(await message(fx, channel, event, { template_id: "missing-template" }), renderMessage(null, event));
  assert.deepEqual(await message(fx, channel, event, { message_template: inline }), renderMessage(inline, event));
  assert.deepEqual(await message(fx, channel, event, { template_id: custom.id }), renderMessage(custom, event));
});

test("nullable and blank titles report their effective builtin fallback and retain custom and inline rendering semantics", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const channel = await routeChannel(fx);
  const event = smsEvent();
  for (const title of [null, "", undefined]) {
    const template = { title, body: "事件正文 {{SMS}}" };
    const saved = await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body: template });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.item, { ...builtins[0], body: template.body, customized: true });
    assert.deepEqual((await fx.request(`${CATALOG}/sms.received`)).data, saved.data);
    assert.deepEqual(await fx.store.get(keys.eventTemplate(event.type), "json"), { title: "", body: template.body });
    const expected = { title: renderMessage(null, event).title, body: `事件正文 ${event.data.content}` };
    assert.deepEqual(await message(fx, channel, event), expected);
    assert.deepEqual(await message(fx, channel, event, { template_id: "missing-template" }), expected);
    const preview = await fx.request(`${ADMIN}/templates/preview`, { method: "POST", body: { ...template, type: event.type } });
    assert.equal(preview.data.title, "示例设备 · 收到短信");
    assert.equal(preview.data.body, "事件正文 这是用于预览的短信。");
  }
  await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body: smsFormat });
  const custom = await fx.create("templates", { name: "空标题共享模板", title: "", body: "共享正文 {{SMS}}" });
  assert.deepEqual(await message(fx, channel, event, { template_id: custom.id }), renderMessage(custom, event));
  assert.equal((await message(fx, channel, event, { template_id: custom.id })).title, "短信终端 · 收到短信");
  assert.deepEqual(await message(fx, channel, event, { message_template: { title: "", body: "行内正文" } }), {
    title: "短信终端 · 收到短信", body: "行内正文",
  });
});

test("event template endpoints enforce admin, same origin, known types, exact paths, methods and template validation", async (t) => {
  const fx = fixture(t);
  for (const [path, method] of [[CATALOG, "GET"], [`${CATALOG}/sms.received`, "GET"], [`${CATALOG}/sms.received`, "PUT"], [`${CATALOG}/sms.received`, "DELETE"]]) {
    assert.equal((await fx.request(path, { method, authenticated: false, ...(method === "PUT" ? { body: smsFormat } : {}) })).status, 401);
  }
  await fx.login();
  await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body: smsFormat });
  const before = fx.db.rows("SELECT * FROM relay_records ORDER BY key");
  for (const method of ["PUT", "DELETE"]) {
    assert.equal((await fx.request(`${CATALOG}/sms.received`, { method, body: smsFormat, origin: "https://other.example" })).status, 403);
  }
  for (const type of ["unknown.type", "__proto__", "constructor"]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      assert.equal((await fx.request(`${CATALOG}/${type}`, { method, ...(method === "PUT" ? { body: smsFormat } : {}) })).status, 404);
    }
  }
  for (const suffix of ["/sms.received/reset", "/sms.received/extra/nested"]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      assert.equal((await fx.request(`${CATALOG}${suffix}`, { method, ...(method === "PUT" ? { body: smsFormat } : {}) })).status, 404);
    }
  }
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    assert.equal((await fx.request(CATALOG, { method, body: smsFormat })).status, 405);
  }
  for (const method of ["POST", "PATCH", "OPTIONS"]) {
    assert.equal((await fx.request(`${CATALOG}/sms.received`, { method, body: smsFormat })).status, 405);
  }
  for (const body of [
    { title: "{{UNKNOWN}}", body: "正文" }, { title: "标题", body: "{{sms}}" },
    { title: "{{FROM", body: "正文" }, { title: "标题", body: "{{SMS" }, { title: "标题", body: "SMS}}" },
    { title: false, body: "正文" }, { title: "标题", body: 42 }, { title: "标题" }, { body: "" }, { body: null },
    { title: "x".repeat(257), body: "正文" }, { body: "x".repeat(8193) }, [], null,
  ]) {
    const response = await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body });
    assert.equal(response.status, 400, JSON.stringify(response.data));
  }
  assert.equal((await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body: smsFormat, headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await fx.request(`${ADMIN}/templates/preview`, { method: "POST", body: { type: "sms.received", title: "{{UNKNOWN}}", body: "" } })).status, 400);
  assert.deepEqual(fx.db.rows("SELECT * FROM relay_records ORDER BY key"), before);
});

test("saved routes and retries keep their original message after event default edits and reset", async (t) => {
  const time = clock(t);
  const fx = fixture(t);
  await fx.login();
  const device = await fx.create("devices", { id: "template-device", name: "短信终端" });
  const channel = await fx.create("channels", {
    name: "本地投递测试", type: "webhook",
    config: { url: `${BASE}/mock-hook`, method: "POST", bodyType: "json", body: '{"title":"{{TITLE}}","body":"{{BODY}}"}' },
  });
  await fx.create("rules", { name: "事件默认模板", event_types: ["sms.received"], channel_ids: [channel.id] });
  await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body: smsFormat });
  const sends = [];
  let busy = true;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), `${BASE}/mock-hook`);
    sends.push(JSON.parse(init.body));
    return new Response("{}", { status: busy ? 429 : 200, headers: busy ? { "Retry-After": "30" } : {} });
  });
  const event = normalizeEvent(smsEvent("before-template-edit"));
  const first = await acceptDeviceEvent(fx.env, event, device, time.now());
  assert.equal(first.created, true);
  assert.equal(first.dispatch, true);
  const originalRoutes = structuredClone(first.item.routes);
  const originalMessage = { title: "106900", body: "第一行短信\n第二行短信\n2026-11-20 15:59:00\n来自：短信终端" };
  assert.deepEqual(originalRoutes[0].message, originalMessage);
  assert.equal(await dispatchEvent(fx.env, first.item, { now: time.now }), 1);
  assert.deepEqual(sends, [originalMessage]);
  assert.equal((await fx.store.get(keys.delivery(device.id, event.event_id, channel.id), "json")).state, "retry");
  await fx.request(`${CATALOG}/sms.received`, { method: "PUT", body: { title: "已修改 {{FROM}}", body: "已修改 {{SMS}}" } });
  const second = await acceptDeviceEvent(fx.env, { ...event, event_id: "after-template-edit" }, device, time.now());
  assert.equal(second.item.routes[0].message.title, "已修改 106900");
  await fx.request(`${CATALOG}/sms.received`, { method: "DELETE" });
  const third = await acceptDeviceEvent(fx.env, { ...event, event_id: "after-template-reset" }, device, time.now());
  assert.deepEqual(third.item.routes[0].message, renderMessage(null, third.item));
  const replay = await acceptDeviceEvent(fx.env, event, device, time.now());
  assert.equal(replay.created, false);
  assert.equal(replay.dispatch, false);
  assert.deepEqual(replay.item.routes, originalRoutes);
  assert.deepEqual((await fx.store.get(keys.event(device.id, second.item.event_id), "json")).routes, second.item.routes);
  const retry = await fx.request(`${ADMIN}/events/${device.id}/${event.event_id}/retry`, { method: "POST", body: { channel_id: channel.id } });
  assert.equal(retry.status, 202);
  time.advance(3000);
  busy = false;
  const saved = await fx.store.get(keys.event(device.id, event.event_id), "json");
  assert.deepEqual(saved.routes, originalRoutes);
  assert.equal(await dispatchEvent(fx.env, saved, { now: time.now }), 1);
  assert.deepEqual(sends, [originalMessage, originalMessage]);
  assert.ok(await fx.store.get(keys.sent(device.id, event.event_id, channel.id), "json"));
  assert.deepEqual((await fx.store.get(keys.event(device.id, event.event_id), "json")).routes, originalRoutes);
});
