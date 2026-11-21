import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import worker from "../src/index.js";
import { dataStore } from "../src/db.js";
import { digest, newToken } from "../src/security.js";
import { activateSmsSession, nextSmsCommand, queueSms } from "../src/sms.js";
import { renderMessage } from "../src/templates.js";
import { d1Fixture } from "./helpers/d1-sqlite.js";

const ORIGIN = "https://admin-controls.example";
const PASSWORD = "local-admin-controls-password";
const ADMIN = "/api/v1/admin";
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const readmeSource = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const nextTurn = () => new Promise(setImmediate);

// Run the shipped UI script with the small DOM surface needed by admin-view regressions.
async function adminUi(route, title, { deviceItems = [], statusRefreshMs } = {}) {
  class Element extends EventTarget {
    constructor(tag) { super(); this.tag = tag; }
    children = [];
    className = "";
    classList = { add: (...names) => { this.className = [this.className, ...names].join(" "); } };
    attributes = new Map();
    dataset = {};
    disabled = false;
    hidden = false;
    #text = "";
    #value = "";
    get textContent() { return this.#text + this.children.map((child) => child.textContent ?? child).join(""); }
    set textContent(text) { this.#text = String(text); this.children = []; }
    get value() { return this.#value; }
    set value(value) { this.#value = String(value); }
    get valueAsNumber() {
      return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(this.value) ? Number(this.value) : NaN;
    }
    get lastElementChild() { return this.children.at(-1); }
    get selectedOptions() { return this.children.filter((option) => option.value === this.value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name); }
    append(...nodes) { this.children.push(...nodes); }
    prepend(...nodes) { this.children.unshift(...nodes); }
    replaceChildren(...nodes) { this.textContent = ""; this.append(...nodes); }
    descendants() {
      return this.children.flatMap((child) => child instanceof Element ? [child, ...child.descendants()] : []);
    }
    contains(node) { return this === node || this.descendants().includes(node); }
    querySelector(selector) { return this.descendants().find((node) => node.className.split(" ").includes(selector.slice(1))); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
  }

  const ids = new Map();
  const byId = (id) => {
    if (!ids.has(id)) ids.set(id, new Element(id));
    return ids.get(id);
  };
  const document = Object.assign(new EventTarget(), {
    activeElement: new Element("body"), createElement: (tag) => new Element(tag), getElementById: byId,
    querySelector: byId, querySelectorAll: () => [],
  });
  const window = Object.assign(new EventTarget(), { location: { hash: `#${route}` } });
  const timers = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timer.handle = nativeSetTimeout(() => { timer.fired = true; callback(); }, delay);
    timer.unref = () => { timer.handle.unref?.(); return timer; };
    timers.push(timer);
    return timer;
  };
  const clearTimeout = (timer) => {
    if (!timer) return;
    timer.cleared = true;
    nativeClearTimeout(timer.handle);
  };
  const api = { policy: { event_days: 7, sms_days: null, revision: 0 } };
  const calls = [];
  const fetch = async (path, { method, body }) => {
    const url = new URL(path, ORIGIN);
    const input = body === undefined ? undefined : JSON.parse(body);
    calls.push([method, url.pathname, input]);
    if (url.pathname === `${ADMIN}/meta`) return Response.json({ event_types: [] });
    if (url.pathname === `${ADMIN}/devices`) return Response.json({ items: deviceItems });
    if (["events", "sms"].some((name) => url.pathname === `${ADMIN}/${name}`)) return Response.json({ items: [] });
    if (url.pathname === `${ADMIN}/retention`) {
      if (method === "PUT") {
        if (input.revision !== api.policy.revision) {
          return Response.json({ error: "保留策略已更新，请刷新后重试" }, { status: 409 });
        }
        api.policy = { ...input, revision: input.revision + 1 };
      }
      return Response.json(api.policy);
    }
    if (url.pathname === `${ADMIN}/history/preview` && method === "POST") {
      return Response.json({ matched: 3, eligible: 2, skipped: 1, preview_token: "test-preview",
        expires_at: new Date(Date.now() + 60_000).toISOString() });
    }
    throw new Error(`Unexpected UI request: ${method} ${path}`);
  };
  const act = async (node, type) => {
    // An explicit submit event bypasses native form validation to also exercise the submit handler's guards.
    const handled = !node.dispatchEvent(new Event(type, { cancelable: true }));
    if (type === "submit") assert.ok(handled);
    await nextTurn();
  };
  const source = statusRefreshMs === undefined ? appSource
    : appSource.replace("const DEVICE_STATUS_REFRESH_MS = 60_000;", `const DEVICE_STATUS_REFRESH_MS = ${statusRefreshMs};`);
  runInNewContext(source, { document, window, fetch, AbortController, URLSearchParams, clearTimeout,
    setTimeout: (...args) => setTimeout(...args).unref() }, { filename: "public/app.js" });
  await nextTurn();
  assert.equal(byId("page-title").textContent, title);
  return { api, calls, act, document, byId, timers, window };
}

async function retentionUi(route, title) {
  const context = await adminUi(route, title);
  const { api, calls, act, document, byId } = context;
  assert.equal(byId("retention").hidden, false);
  calls.length = 0;
  await act(byId("retention"), "click");
  assert.equal(byId("dialog-title").textContent, `${title} · 保留与清理`);
  const dialog = byId("dialog-content");
  const find = (predicate, root = dialog) => {
    const node = root.descendants().find(predicate);
    assert.ok(node, "Expected control or text in the retention dialog");
    return node;
  };
  const form = find((node) => node.getAttribute("aria-label") === "保留设置");
  const button = (label) => find((node) => node.tag === "button" && node.textContent === label);
  const input = (label) => {
    const field = find((node) => node.tag === "label" && node.textContent === label, form);
    return find((node) => node.id === field.htmlFor, form);
  };
  return { ...context, find, form, button, input };
}

function fixture(t) {
  const { db, env } = d1Fixture(t, {
    ADMIN_PASSWORD: PASSWORD, APP_SECRET: "local-admin-controls-secret-not-for-production",
    RELAY_REGISTRATION_LIMIT: { async limit() { return { success: true }; } },
  });
  let cookie;
  async function request(path, { method = "GET", body, authenticated = true, origin, token } = {}) {
    const background = [];
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(authenticated && cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { waitUntil(task) { background.push(task); } });
    await Promise.all(background);
    return { status: response.status, data: await response.json() };
  }
  async function login() {
    const response = await worker.fetch(new Request(`${ORIGIN}${ADMIN}/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }),
    }), env, { waitUntil() {} });
    assert.equal(response.status, 200);
    cookie = response.headers.get("Set-Cookie").split(";")[0];
  }
  return { db, env, store: dataStore(env), request, login };
}

function boot(network_state = "网络未注册") {
  return { type: "device.boot", device_id: "template-test", device_name: "模板测试",
    data: { reason: "0" }, status: { operator: "测试运营商", network_state, rsrp_dbm: -90, uptime_seconds: 0 } };
}

test("channel test notifications use generic relay branding by default", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const created = await fx.request(`${ADMIN}/channels`, { method: "POST", body: { name: "本地测试", type: "webhook", config: {
    url: "https://channel-test.example/hook", method: "POST", bodyType: "json", body: '{"title":"{{TITLE}}","body":"{{BODY}}"}',
  } } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channel = created.data.item;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let payload;
  globalThis.fetch = async (_input, init = {}) => {
    payload = JSON.parse(init.body);
    return new Response("{}", { status: 200 });
  };
  assert.deepEqual(await fx.request(`${ADMIN}/channels/${channel.id}/test`, { method: "POST", body: {} }), { status: 200, data: { ok: true } });
  assert.equal(payload.title, "短信转发测试通知");
  assert.equal(payload.body, "渠道配置测试");
});

test("device list shows WSS connection state without duplicating the cellular registration snapshot", async () => {
  const devices = [
    { id: "online-unregistered", name: "在线设备", enabled: true, last_seen: "2026-11-21T12:00:00.000Z",
      connection: { state: "online", event_ready: true, command_ready: true, usable_slots: 5, quarantined_slots: 1 },
      status: { operator: "运营商甲", network_state: "网络未注册", rsrp_dbm: -71 } },
    { id: "offline-registered", name: "离线设备", enabled: true, last_seen: "2026-11-21T11:00:00.000Z",
      connection: { state: "offline" }, status: { operator: "运营商乙", network_state: "网络已注册", rsrp_dbm: -88 } },
    { id: "unknown-presence", name: "状态待确认设备", enabled: true, last_seen: "2026-11-21T10:00:00.000Z",
      connection: { state: "unknown", event_ready: false, command_ready: false }, status: {} },
  ];
  const before = structuredClone(devices);
  const { byId } = await adminUi("devices", "设备", { deviceItems: devices });
  const text = byId("page-content").textContent;

  assert.match(text, /连接在线/);
  assert.match(text, /连接离线/);
  assert.match(text, /连接状态待确认/);
  assert.match(text, /事件通道在线/);
  assert.match(text, /短信命令就绪/);
  assert.match(text, /运营商甲，-71 dBm/);
  assert.match(text, /运营商乙，-88 dBm/);
  assert.match(text, /5 个健康可用槽位/);
  assert.doesNotMatch(text, /网络未注册|网络已注册/);
  assert.deepEqual(devices, before);
});

test("visible device status refreshes automatically and pauses while the page is hidden", async () => {
  const device = { id: "heartbeat-device", name: "心跳设备", enabled: true,
    connection: { id: "active-session", session_id: "active-session", state: "online", event_ready: true, command_ready: true },
    status: { operator: "测试运营商", rsrp_dbm: -80 } };
  const { calls, timers, byId, document, window } = await adminUi("devices", "设备", { deviceItems: [device], statusRefreshMs: 5 });
  const devicesReads = () => calls.filter(([, path]) => path === `${ADMIN}/devices`).length;
  assert.equal(devicesReads(), 1);
  const refresh = timers.find((timer) => timer.delay === 5 && !timer.cleared);
  assert.ok(refresh);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  assert.ok(devicesReads() >= 2);
  assert.match(byId("page-content").textContent, /连接在线/);

  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  const readsWhenHidden = devicesReads();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  assert.equal(devicesReads(), readsWhenHidden);
  window.dispatchEvent(new Event("pagehide"));
});

test("admin console uses generic product branding while documenting the tested hardware target", () => {
  assert.ok(indexSource.includes("<title>短信转发运维台</title>"));
  assert.doesNotMatch(indexSource, /Air780EPM/);
  assert.match(readmeSource, /LuatOS-SoC_V2056_Air780EPM_106/);
  assert.match(readmeSource, /其他 780 系列型号尚未验证/);
});

test("boot templates omit only the early unregistered snapshot without changing data or saved templates", () => {
  const event = boot();
  const original = structuredClone(event);
  const template = { title: "自定义 {{DEVICE_NAME}}", body: "{{DEVICE_INFO}}\n状态：{{NETWORK_STATE}}" };
  const saved = structuredClone(template);
  const defaults = renderMessage(null, event);
  const custom = renderMessage(template, event);
  assert.ok(!defaults.body.includes("网络未注册"));
  assert.ok(!custom.body.includes("网络未注册"));
  assert.ok(defaults.body.includes("运营商 测试运营商"));
  assert.ok(defaults.body.includes("信号 -90 dBm"));
  assert.equal(custom.body.split("\n").at(-1), "状态：");
  assert.deepEqual(event, original);
  assert.deepEqual(template, saved);
  assert.equal(renderMessage({ body: "用户写死的网络未注册" }, event).body, "用户写死的网络未注册");
  assert.ok(renderMessage(null, boot("已注册主网")).body.includes("已注册主网"));
  const nonboot = { ...boot(), type: "device.heartbeat" };
  assert.ok(renderMessage(null, nonboot).body.includes("网络未注册"));
});

test("retention and cleanup routes require admin, same origin, explicit confirmation and valid inputs", async (t) => {
  const fx = fixture(t);
  assert.equal((await fx.request(`${ADMIN}/retention`, { authenticated: false })).status, 401);
  assert.equal((await fx.request(`${ADMIN}/history/preview`, { method: "POST", body: { kind: "events", mode: "all" }, authenticated: false })).status, 401);
  assert.equal((await fx.request(`${ADMIN}/history/cleanup`, { method: "POST", body: {}, authenticated: false })).status, 401);
  await fx.login();
  const policy = await fx.request(`${ADMIN}/retention`);
  assert.equal(policy.status, 200);
  assert.equal(policy.data.event_days, 7);
  assert.equal(policy.data.sms_days, 30);
  const before = fx.db.rows("SELECT * FROM relay_records ORDER BY key");
  const preview = await fx.request(`${ADMIN}/history/preview`, { method: "POST", body: { kind: "events", mode: "all" } });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.eligible, 0);
  assert.equal(typeof preview.data.preview_token, "string");
  assert.deepEqual(fx.db.rows("SELECT * FROM relay_records ORDER BY key"), before);
  const unconfirmed = await fx.request(`${ADMIN}/history/cleanup`, { method: "POST", body: { preview_token: preview.data.preview_token } });
  assert.ok([400, 403, 409].includes(unconfirmed.status));
  assert.equal((await fx.request(`${ADMIN}/retention`, { method: "PUT", origin: "https://other.example", body: { event_days: 2, sms_days: 4 } })).status, 403);
  assert.equal((await fx.request(`${ADMIN}/history/cleanup`, { method: "POST", origin: "https://other.example", body: { preview_token: preview.data.preview_token, confirm: "清空全部" } })).status, 403);
  for (const body of [
    {}, { event_days: 7 }, { event_days: 7, sms_days: "" }, { event_days: 7, sms_days: " " },
    { event_days: 7, sms_days: "0" }, { event_days: 7, sms_days: -1 }, { event_days: 7, sms_days: 91 },
    { event_days: 7, sms_days: 0.5 }, { event_days: 7, sms_days: false },
    { sms_days: 0 }, { event_days: "", sms_days: 0 }, { event_days: 0, sms_days: 0 }, { event_days: 91, sms_days: 0 },
  ]) {
    const rejected = await fx.request(`${ADMIN}/retention`, { method: "PUT", body });
    assert.equal(rejected.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await fx.request(`${ADMIN}/retention`), policy);
  assert.equal(fx.db.row("SELECT COUNT(*) AS n FROM history_retention_revisions").n, 0);
  const saved = await fx.request(`${ADMIN}/retention`, { method: "PUT", body: { event_days: 9, sms_days: 40 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.event_days, 9);
  assert.equal(saved.data.sms_days, 40);
  assert.equal((await fx.request(`${ADMIN}/history/preview`, { body: undefined })).status, 405);
});

test("admin SMS retention round-trips 0 to finite to 0 without changing event retention", async (t) => {
  const fx = fixture(t);
  await fx.login();
  const path = `${ADMIN}/retention`;
  const put = (sms_days, revision) => fx.request(path, { method: "PUT", body: { event_days: 7, sms_days, revision } });
  for (const [smsDays, revision] of [[0, 1], [40, 2], [0, 3]]) {
    const saved = await put(smsDays, revision - 1);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.event_days, 7);
    assert.equal(saved.data.sms_days, smsDays);
    assert.equal(saved.data.revision, revision);
    assert.deepEqual(await fx.request(path), saved);
  }
});

test("admin reads legacy SQL NULL as 0, saving 0 is a no-op, and legacy null writes return 0", async (t) => {
  const fx = fixture(t);
  const path = `${ADMIN}/retention`;
  const updatedAt = "2026-11-20T08:00:00.000Z";
  fx.db.sqlite.prepare("INSERT INTO history_retention_policy (id, event_days, sms_days, revision, updated_at) VALUES (1, 9, NULL, 4, ?)").run(updatedAt);
  fx.db.sqlite.prepare("INSERT INTO history_retention_revisions (revision, event_days, sms_days, cutover) VALUES (4, 9, NULL, 1795161600)").run();
  await fx.login();
  const put = (sms_days, revision) => fx.request(path, { method: "PUT", body: { event_days: 9, sms_days, revision } });
  const legacy = { status: 200, data: { event_days: 9, sms_days: 0, revision: 4, updated_at: updatedAt } };
  assert.deepEqual(await fx.request(path), legacy);
  assert.deepEqual(await put(0, 4), legacy);
  assert.deepEqual(fx.db.rows("SELECT revision, sms_days FROM history_retention_revisions"), [{ revision: 4, sms_days: null }]);

  const finite = await put(40, 4);
  assert.equal(finite.status, 200, JSON.stringify(finite.data));
  assert.equal(finite.data.sms_days, 40);
  assert.equal(finite.data.revision, 5);
  const aliased = await put(null, 5);
  assert.equal(aliased.status, 200, JSON.stringify(aliased.data));
  assert.equal(aliased.data.sms_days, 0);
  assert.equal(aliased.data.revision, 6);
  assert.deepEqual(await fx.request(path), aliased);
  assert.equal(fx.db.row("SELECT sms_days FROM history_retention_policy").sms_days, null);
});

for (const [route, title] of [["events", "事件"], ["sms", "短信"]]) {
  test(`retention UI (${route}): legacy null loads as 0 and zero saves and reloads without cleanup`, async () => {
    const { api, calls, act, find, form, button, input } = await retentionUi(route, title);
    const events = input("事件保留天数");
    const sms = input("短信保留天数");
    for (const [control, min] of [[events, "1"], [sms, "0"]]) {
      assert.equal(control.type, "number");
      assert.equal(control.required, true);
      assert.equal(control.min, min);
      assert.equal(control.max, "90");
      assert.equal(control.step, "1");
      assert.equal(control.disabled, false);
    }
    assert.equal(events.value, "7");
    assert.equal(sms.value, "0");
    const note = find((node) => node.id === sms.getAttribute("aria-describedby"), form);
    assert.equal(note.textContent, "0 = 永久保留");
    assert.equal(note.hidden, false);
    assert.ok(!form.descendants().some((node) => node.type === "checkbox"));
    const save = button("保存设置");
    assert.ok(form.contains(save));
    assert.equal(save.type, "submit");
    assert.equal(save.disabled, false);
    const status = find((node) => node.role === "status", form);
    assert.match(status.textContent, /服务端当前设置：事件 7 天，短信 永久保留/);

    sms.value = "90";
    await act(sms, "input");
    await act(form, "submit");
    assert.equal(api.policy.sms_days, 90);
    sms.value = "0";
    await act(sms, "input");

    // A valid, explicitly confirmed preview must not run when the policy form is saved.
    const scope = find((node) => node.getAttribute("aria-label") === `${title}清理范围`);
    const mode = find((node) => node.tag === "select", scope);
    mode.value = "all";
    await act(mode, "change");
    await act(scope, "submit");
    const preview = find((node) => node.className.includes("retention-preview"));
    assert.equal(preview.hidden, false);
    const confirmation = find((node) => node.className.includes("retention-confirm"));
    const ack = find((node) => node.type === "checkbox", confirmation);
    ack.checked = true;
    await act(ack, "change");
    const confirmText = find((node) => node.type === "text", confirmation);
    confirmText.value = "清空全部";
    await act(confirmText, "input");
    const cleanup = button("确认清空全部");
    assert.equal(cleanup.disabled, false);

    await act(form, "submit");
    assert.deepEqual(api.policy, { event_days: 7, sms_days: 0, revision: 2 });
    assert.equal(sms.value, "0");
    assert.match(status.textContent, /已保存.*永久保留.*未启动手动清理/);
    assert.equal(preview.hidden, true);
    assert.equal(cleanup.disabled, true);
    assert.equal(ack.checked, false);
    assert.equal(confirmText.value, "");

    sms.value = "56";
    await act(sms, "input");
    await act(button("重新读取"), "click");
    assert.equal(sms.value, "0");
    assert.match(status.textContent, /服务端当前设置：事件 7 天，短信 永久保留/);
    assert.deepEqual(calls, [
      ["GET", `${ADMIN}/retention`, undefined],
      ["PUT", `${ADMIN}/retention`, { event_days: 7, sms_days: 90, revision: 0 }],
      ["POST", `${ADMIN}/history/preview`, { kind: route, mode: "all" }],
      ["PUT", `${ADMIN}/retention`, { event_days: 7, sms_days: 0, revision: 1 }],
      ["GET", `${ADMIN}/retention`, undefined],
    ]);
  });

  test(`retention UI (${route}): rejects blank, malformed, fractional and out-of-range days before saving`, async () => {
    const { calls, act, find, form, input, document } = await retentionUi(route, title);
    const events = input("事件保留天数");
    const sms = input("短信保留天数");
    const error = find((node) => node.role === "alert", form);
    for (const value of ["", "  ", "abc", "0x0", "0.5", "-1", "91"]) {
      sms.value = value;
      await act(form, "submit");
      assert.equal(error.hidden, false, JSON.stringify(value));
      assert.match(error.textContent, /短信保留天数必须为 0–90 的整数/);
      assert.equal(document.activeElement, sms);
    }
    sms.value = "0";
    events.value = "0";
    await act(form, "submit");
    assert.match(error.textContent, /事件保留天数必须为 1–90 的整数/);
    assert.equal(document.activeElement, events);
    assert.deepEqual(calls, [["GET", `${ADMIN}/retention`, undefined]]);
  });
}

test("retention UI: a revision conflict requires reloading before saving again", async () => {
  const { api, calls, act, find, form, button, input } = await retentionUi("events", "事件");
  const sms = input("短信保留天数");
  const error = find((node) => node.role === "alert", form);
  api.policy = { event_days: 15, sms_days: 60, revision: 1 };
  await act(form, "submit");
  const save = button("保存设置");
  assert.equal(save.disabled, true);
  assert.match(error.textContent, /保留策略已更新/);
  await act(form, "submit");
  assert.equal(calls.length, 2);

  await act(button("重新读取"), "click");
  assert.equal(save.disabled, false);
  assert.equal(sms.value, "60");
  sms.value = "0";
  await act(sms, "input");
  await act(form, "submit");
  assert.equal(error.hidden, true);
  assert.deepEqual(calls, [
    ["GET", `${ADMIN}/retention`, undefined],
    ["PUT", `${ADMIN}/retention`, { event_days: 7, sms_days: 0, revision: 0 }],
    ["GET", `${ADMIN}/retention`, undefined],
    ["PUT", `${ADMIN}/retention`, { event_days: 15, sms_days: 0, revision: 1 }],
  ]);
});

test("event detail exposes its retention deadline but hides fingerprints and notification snapshots", async (t) => {
  const fx = fixture(t);
  const identity = { identity_type: "sn", identity_value: "RETENTION-DETAIL-TEST" };
  const id = `auto~${await digest(`sn:${identity.identity_value}`)}`;
  const token = newToken();
  await fx.store.registerDevice(id, identity, await digest(token));
  const event = { version: 1, device_id: id, event_id: "retention-detail", type: "device.boot", data: { reason: "test" } };
  const uploaded = await fx.request("/api/v1/events", { method: "POST", token, body: event });
  assert.equal(uploaded.status, 202);
  await fx.login();
  const detail = await fx.request(`${ADMIN}/events/${id}/${event.event_id}`);
  assert.equal(detail.status, 200);
  assert.equal(Number.isSafeInteger(detail.data.item.expires_at), true);
  assert.ok(detail.data.item.expires_at > Math.floor(Date.now() / 1000));
  assert.equal(Object.hasOwn(detail.data.item, "fingerprint"), false);
  assert.equal(Object.hasOwn(detail.data.item, "routes"), false);
});

test("admin provisions a fixed device credential atomically without an open first-claim window", async (t) => {
  const fx = fixture(t);
  const identity = { identity_type: "sn", identity_value: "STATIC-AUTH-TEST" };
  const id = `auto~${await digest(`sn:${identity.identity_value}`)}`;
  const oldToken = newToken();
  const nextToken = newToken();
  await fx.store.registerDevice(id, identity, await digest(oldToken));
  const before = await fx.store.getDeviceRecord(id);
  const path = `${ADMIN}/devices/${id}`;
  const input = { ...identity, expected_version: before.credentialVersion, hash: await digest(nextToken) };
  assert.equal((await fx.request(`${path}/provision`, { method: "POST", body: input, authenticated: false })).status, 401);
  await fx.login();
  assert.equal((await fx.request(path)).data.item.credential_version, before.credentialVersion);
  assert.equal((await fx.request(`${path}/provision`, { method: "POST", body: input, origin: "https://other.example" })).status, 403);
  assert.equal((await fx.request(`${path}/provision`, { method: "POST", body: { ...input, identity_value: "WRONG-DEVICE" } })).status, 409);
  const first = await queueSms(fx.env, { request_id: crypto.randomUUID(), device_id: id, to: "10086", content: "本地模拟命令一" });
  const session = newToken();
  await activateSmsSession(fx.env, id, before.hash, session);
  assert.equal((await nextSmsCommand(fx.env, id, before.hash, session)).id, first.command.id);
  const second = await queueSms(fx.env, { request_id: crypto.randomUUID(), device_id: id, to: "10086", content: "本地模拟命令二" });
  const configured = await fx.request(`${path}/provision`, { method: "POST", body: input });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  assert.deepEqual(configured.data, { ok: true, credential_version: before.credentialVersion + 1 });
  const after = await fx.store.getDeviceRecord(id);
  assert.equal(after.hash, await digest(nextToken));
  assert.equal(after.revokedHash, before.hash);
  assert.equal(after.commandSession, null);
  assert.equal(after.device.id, before.device.id);
  assert.equal(after.device.created_at, before.device.created_at);
  assert.equal(fx.db.row("SELECT status FROM sms_commands WHERE id = ?", first.command.id).status, "unknown");
  assert.equal(fx.db.row("SELECT status FROM sms_commands WHERE id = ?", second.command.id).status, "cancelled");
  assert.equal(fx.db.row("SELECT COUNT(*) AS count FROM sms_messages WHERE device_id = ?", id).count, 2);
  assert.equal((await fx.request(`${path}/provision`, { method: "POST", body: input })).status, 409);
  assert.ok(!JSON.stringify(configured.data).includes(input.hash));
  assert.ok(!JSON.stringify(configured.data).includes(nextToken));
  assert.equal((await fx.request("/api/v1/devices/register", { method: "POST", token: oldToken, body: { version: 1, ...identity } })).status, 409);
  assert.equal((await fx.request("/api/v1/devices/register", { method: "POST", token: nextToken, body: { version: 1, ...identity } })).status, 200);
});
