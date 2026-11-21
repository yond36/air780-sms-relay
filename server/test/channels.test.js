import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { channelTypes, sendChannel, validateChannelConfig } from "../src/channels.js";

const now = Date.parse("2026-01-02T03:04:05Z");
const message = { title: "收到短信 🔔", body: "发件号码：10086\n正文：你好 & \"quoted\" 🌍" };
const content = `${message.title}\n${message.body}`;
const success = { ok: true, retryable: false, status: 200 };
const secret = "fixture-secret-never-display";
const configs = {
  dingtalk_group: { webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=token", secret },
  dingtalk_app: { appKey: "fixture-key", appSecret: secret, mode: "work_notice", agentId: "42", userIds: "a, b,a", departmentIds: "2, 3" },
  wecom_group: { webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-key" },
  wecom_app: { corpId: "fixture-corp", corpSecret: secret, agentId: 42, toUser: "a| b", toParty: "2", toTag: "3" },
  feishu_group: { webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/fixture-key", secret },
  feishu_app: { appId: "cli_fixture", appSecret: secret, receiveIdType: "chat_id", receiveId: "oc_fixture" },
  email: { from: "notify@example.test", to: "recipient@example.test" },
  bark: { deviceKey: secret, baseUrl: "https://bark.example.test/relay/" },
  webhook: { url: "https://webhook.example.test/endpoint" },
  telegram: { botToken: "123456:fixture_token", chatId: "-1001234567890" },
  serverchan: { sendKey: "SCTfixture" },
  pushplus: { token: secret, topic: "group" },
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}

function mockFetch(...replies) {
  const calls = [];
  return {
    calls,
    async fetchImpl(target, init) {
      const index = calls.length;
      calls.push({ url: new URL(target), ...init, headers: new Headers(init.headers) });
      if (replies[index] instanceof Error) throw replies[index];
      return replies[index];
    },
  };
}

function jsonBody(call) {
  assert.match(call.headers.get("Content-Type"), /^application\/json/);
  return JSON.parse(call.body);
}

function safeError(result) {
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret-never-display|https:\/\//);
}

function send(type, mock, config = configs[type], payload = message, options = {}) {
  return sendChannel(type, config, payload, { fetchImpl: mock.fetchImpl, now: () => now, ...options });
}

test("publishes channel metadata and validates normalized configs without exposing secrets", async () => {
  assert.deepEqual(Object.keys(channelTypes), Object.keys(configs));
  for (const [type, config] of Object.entries(configs)) {
    const normalized = validateChannelConfig(type, config);
    assert.deepEqual(validateChannelConfig(type, normalized), normalized);
    const { label, fields } = channelTypes[type];
    assert.equal(typeof label, "string");
    for (const field of fields) {
      assert.equal(typeof field.label, "string");
      assert.equal(typeof field.required, "boolean");
      assert.equal(typeof field.secret, "boolean");
      assert.match(field.kind, /^(text|url|password|number|select|json|textarea)$/);
      if (["url", "password"].includes(field.kind)) assert.equal(field.secret, true);
    }
  }
  const hidden = channelTypes.webhook.fields.filter(({ secret }) => secret).map(({ key }) => key);
  assert.deepEqual(hidden, ["url", "headers", "body"]);
  assert.throws(() => validateChannelConfig("__proto__", {}), /未知渠道/);
  assert.throws(() => validateChannelConfig("bark", { ...configs.bark, [secret]: 1 }), (error) => !error.message.includes(secret));
  assert.throws(() => validateChannelConfig("dingtalk_group", { webhookUrl: `https://evil.example.test/robot/send?access_token=${secret}` }), /地址与渠道不匹配/);
  assert.throws(() => validateChannelConfig("wecom_app", { ...configs.wecom_app, toUser: "a|@all" }), /有效 ID/);
  assert.throws(() => validateChannelConfig("dingtalk_app", { ...configs.dingtalk_app, userIds: "", departmentIds: "" }), /接收方/);
  assert.throws(() => validateChannelConfig("webhook", { ...configs.webhook, body: `{"token":"${secret}"` }), (error) => !error.message.includes(secret));
  assert.throws(() => validateChannelConfig("webhook", { ...configs.webhook, headers: { Host: "other.example.test" } }), /受限/);
  assert.throws(() => validateChannelConfig("webhook", { ...configs.webhook, headers: { Authorization: `${secret}\r\nOther: bad` } }), /无效/);
  assert.throws(() => validateChannelConfig("webhook", { ...configs.webhook, bodyType: "form", body: ["{msg}"] }), /表单/);
  assert.throws(() => validateChannelConfig("webhook", { url: `https://webhook.example.test/${"中".repeat(2000)}` }), /编码后过长/);
  const mock = mockFetch();
  const result = await send("webhook", mock, { url: `https://u:${secret}@webhook.example.test/` });
  assert.equal(result.code, "invalid_config");
  assert.equal(mock.calls.length, 0);
  safeError(result);
});

test("DingTalk group signs milliseconds and classifies throttling", async () => {
  const mock = mockFetch(json({ errcode: 0 }));
  const config = { ...configs.dingtalk_group, webhookUrl: `${configs.dingtalk_group.webhookUrl}&sign=stale&timestamp=1` };
  assert.deepEqual(await send("dingtalk_group", mock, config), success);
  const [call] = mock.calls;
  assert.equal(call.method, "POST");
  assert.equal(call.redirect, "manual");
  assert.equal(call.url.searchParams.get("access_token"), "token");
  assert.equal(call.url.searchParams.get("timestamp"), String(now));
  assert.equal(call.url.searchParams.get("sign"), createHmac("sha256", secret).update(`${now}\n${secret}`).digest("base64"));
  assert.deepEqual(jsonBody(call), { msgtype: "text", text: { content } });

  const result = await send("dingtalk_group", mockFetch(json({ errcode: 130101, errmsg: secret })));
  assert.equal(result.code, "130101");
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterMs, 600_000);
  safeError(result);

  const length = mockFetch(json({ errcode: 0 }));
  const long = { title: "", body: "中".repeat(4000) };
  assert.deepEqual(await send("dingtalk_group", length, config, long), success);
  assert.equal(jsonBody(length.calls[0]).text.content, long.body);
  assert.equal((await send("dingtalk_group", length, config, { title: "", body: `${long.body}中` })).code, "message_too_long");
  assert.equal(length.calls.length, 1);
});

test("DingTalk app obtains a token and submits a nested work notification", async () => {
  const mock = mockFetch(json({ errcode: 0, access_token: "temporary-token" }), json({ errcode: 0, task_id: 2 }));
  assert.deepEqual(await send("dingtalk_app", mock), success);
  const [token, call] = mock.calls;
  assert.equal(token.method, "GET");
  assert.equal(token.url.origin + token.url.pathname, "https://oapi.dingtalk.com/gettoken");
  assert.deepEqual(Object.fromEntries(token.url.searchParams), { appkey: "fixture-key", appsecret: secret });
  assert.equal(call.url.pathname, "/topapi/message/corpconversation/asyncsend_v2");
  assert.equal(call.url.searchParams.get("access_token"), "temporary-token");
  assert.deepEqual(jsonBody(call), {
    agent_id: 42, to_all_user: false, userid_list: "a,b", dept_id_list: "2,3", msg: { msgtype: "text", text: { content } },
  });

  const denied = mockFetch(json({ errcode: 40001, errmsg: `bad credential ${secret}` }));
  const result = await send("dingtalk_app", denied);
  assert.equal(denied.calls.length, 1);
  assert.equal(result.code, "40001");
  assert.equal(result.retryable, false);
  safeError(result);
});

test("DingTalk app defaults to the SmsForwarder-compatible direct robot API", async () => {
  const token = () => json({ accessToken: "temporary-token", expireIn: 7200 });
  const mock = mockFetch(
    token(), json({ processQueryKey: "query", invalidStaffIdList: ["b"], flowControlledStaffIdList: [] }),
    token(), json({ processQueryKey: "", invalidStaffIdList: ["b"], flowControlledStaffIdList: ["a", "c"] }),
  );
  const config = { appKey: "fixture-key", appSecret: secret, userIds: " a，b ; c " };
  assert.deepEqual(await send("dingtalk_app", mock, config), { ...success, code: "partial_delivery" });
  const [auth, deliver] = mock.calls;
  assert.equal(auth.url.href, "https://api.dingtalk.com/v1.0/oauth2/accessToken");
  assert.deepEqual(jsonBody(auth), { appKey: config.appKey, appSecret: secret });
  assert.equal(deliver.url.href, "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
  assert.equal(deliver.headers.get("x-acs-dingtalk-access-token"), "temporary-token");
  assert.deepEqual(jsonBody(deliver), {
    robotCode: config.appKey, userIds: ["a", "b", "c"], msgKey: "sampleText", msgParam: JSON.stringify({ content }),
  });
  const limited = await send("dingtalk_app", mock, config);
  assert.equal(limited.code, "rate_limited");
  assert.equal(limited.retryable, true);
  assert.throws(() => validateChannelConfig("dingtalk_app", { ...config, userIds: Array.from({ length: 21 }, (_, index) => `id${index}`).join(",") }), /最多 20 项/);
});

test("DingTalk app sends to a group conversation and classifies modern API errors", async () => {
  const token = () => json({ accessToken: "temporary-token" });
  const mock = mockFetch(
    token(), json({ processQueryKey: "query" }),
    token(), json({ code: "send.byToken.tooFast", message: secret }, 400, { "Retry-After": "6" }),
    token(), json({ code: "invalidParameter.msgParam.tooLong", message: secret }, 400),
  );
  const config = {
    mode: "robot_group", appKey: "fixture-key", appSecret: secret,
    robotCode: "fixture-robot", openConversationId: "cid_fixture", msgKey: "sampleMarkdown",
  };
  assert.deepEqual(await send("dingtalk_app", mock, config), success);
  assert.equal(mock.calls[1].url.href, "https://api.dingtalk.com/v1.0/robot/groupMessages/send");
  assert.deepEqual(jsonBody(mock.calls[1]), {
    robotCode: config.robotCode, openConversationId: config.openConversationId, msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title: message.title, text: message.body }),
  });
  const limited = await send("dingtalk_app", mock, config);
  assert.equal(limited.code, "send.byToken.tooFast");
  assert.equal(limited.retryAfterMs, 6000);
  assert.equal(limited.retryable, true);
  safeError(limited);
  const tooLong = await send("dingtalk_app", mock, config);
  assert.equal(tooLong.code, "message_too_long");
  assert.equal(tooLong.retryable, false);
  safeError(tooLong);
});

test("WeCom group enforces the UTF-8 byte limit and understands business 45009", async () => {
  const mock = mockFetch(json({ errcode: 0 }), json({ errcode: 45009, errmsg: secret }));
  const body = "😀".repeat(512);
  assert.deepEqual(await send("wecom_group", mock, configs.wecom_group, { title: "", body }), success);
  assert.equal(mock.calls[0].url.href, configs.wecom_group.webhookUrl);
  assert.deepEqual(jsonBody(mock.calls[0]), { msgtype: "text", text: { content: body } });
  const tooLong = await send("wecom_group", mock, configs.wecom_group, { title: "", body: `${body}中` });
  assert.equal(tooLong.code, "message_too_long");
  assert.equal(tooLong.retryable, false);
  assert.equal(mock.calls.length, 1);
  const limited = await send("wecom_group", mock);
  assert.equal(limited.code, "45009");
  assert.equal(limited.retryAfterMs, 60_000);
  safeError(limited);
});

test("WeCom app sends to explicit recipients and reports partial delivery without retrying", async () => {
  const token = () => json({ errcode: 0, access_token: "temporary-token" });
  const mock = mockFetch(token(), json({ errcode: 0, invaliduser: "b" }), token(), json({ errcode: 42001 }));
  assert.deepEqual(await send("wecom_app", mock), { ...success, code: "partial_delivery" });
  assert.equal(mock.calls[0].url.href, `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=fixture-corp&corpsecret=${secret}`);
  assert.equal(mock.calls[1].url.href, "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=temporary-token");
  assert.deepEqual(jsonBody(mock.calls[1]), {
    agentid: 42, touser: "a|b", toparty: "2", totag: "3", msgtype: "text", text: { content },
  });
  const expired = await send("wecom_app", mock);
  assert.equal(expired.retryable, true);
  assert.equal(expired.code, "42001");
});

test("Feishu group signs an empty message using seconds and accepts legacy success fields", async () => {
  const mock = mockFetch(json({ StatusCode: 0, StatusMessage: "success" }), json({ code: 19021, msg: secret }));
  assert.deepEqual(await send("feishu_group", mock), success);
  const timestamp = String(now / 1000);
  assert.equal(mock.calls[0].url.href, configs.feishu_group.webhookUrl);
  assert.deepEqual(jsonBody(mock.calls[0]), {
    msg_type: "text", content: { text: content }, timestamp,
    sign: createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64"),
  });
  const rejected = await send("feishu_group", mock);
  assert.equal(rejected.retryable, false);
  assert.equal(rejected.code, "19021");
  safeError(rejected);
});

test("Feishu app uses a bearer token, JSON content, and a deterministic delivery UUID", async () => {
  const token = () => json({ code: 0, tenant_access_token: "temporary-token" });
  const mock = mockFetch(token(), json({ code: 0 }), token(), json({ code: 230020, msg: secret }, 400, { "x-ogw-ratelimit-reset": "7" }));
  const deliveryId = "event.1.channel.1";
  assert.deepEqual(await send("feishu_app", mock, configs.feishu_app, message, { deliveryId }), success);
  assert.equal(mock.calls[0].url.href, "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
  assert.deepEqual(jsonBody(mock.calls[0]), { app_id: "cli_fixture", app_secret: secret });
  assert.equal(mock.calls[1].url.href, "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id");
  assert.equal(mock.calls[1].headers.get("Authorization"), "Bearer temporary-token");
  assert.deepEqual(jsonBody(mock.calls[1]), {
    receive_id: "oc_fixture", msg_type: "text", content: JSON.stringify({ text: content }),
    uuid: createHash("sha256").update(deliveryId).digest("hex").slice(0, 40),
  });
  const limited = await send("feishu_app", mock, configs.feishu_app, message, { deliveryId });
  assert.equal(jsonBody(mock.calls[3]).uuid, jsonBody(mock.calls[1]).uuid);
  assert.equal(limited.status, 400);
  assert.equal(limited.code, "230020");
  assert.equal(limited.retryAfterMs, 7000);
  assert.equal(limited.retryable, true);
  safeError(limited);
});

test("Cloudflare Email Sending passes a structured Unicode message through the optional binding", async () => {
  const sent = [];
  const config = { ...configs.email, to: `${configs.email.to}, group@example.test` };
  const result = await sendChannel("email", config, message, {
    env: { SEND_EMAIL: { async send(mail) { sent.push(mail); } } },
  });
  assert.deepEqual(result, { ok: true, retryable: false });
  assert.deepEqual(sent, [{ from: config.from, to: [configs.email.to, "group@example.test"], subject: message.title, text: message.body }]);
  const missing = await sendChannel("email", config, message);
  assert.equal(missing.code, "email_binding_missing");
  assert.equal(missing.retryable, false);
  const limited = await sendChannel("email", config, message, {
    env: { SEND_EMAIL: { async send() { throw Object.assign(new Error(secret), { code: "E_RATE_LIMIT_EXCEEDED" }); } } },
  });
  assert.equal(limited.retryable, true);
  assert.equal(limited.code, "E_RATE_LIMIT_EXCEEDED");
  safeError(limited);
});

test("Cloudflare Email Routing builds valid raw MIME for one verified recipient", async () => {
  class EmailMessage {
    constructor(from, to, raw) { Object.assign(this, { from, to, raw }); }
  }
  const out = [];
  const config = { ...configs.email, mode: "routing" };
  const title = `${"短信📩".repeat(12)}\r\n标题`;
  const body = `${message.body}\n${"测试📩".repeat(20)}`;
  const result = await sendChannel("email", config, { title, body }, {
    env: { EmailMessage, SEND_EMAIL: { async send(mail) { out.push(mail); } } }, now,
  });
  assert.deepEqual(result, { ok: true, retryable: false });
  assert.equal(out.length, 1);
  const [email] = out;
  assert.ok(email instanceof EmailMessage);
  assert.equal(email.from, config.from);
  assert.equal(email.to, config.to);
  const [headers, encoded] = email.raw.split("\r\n\r\n");
  assert.match(headers, /^From: notify@example\.test\r\nTo: recipient@example\.test\r\n/);
  assert.match(headers, /Message-ID: <[\da-f-]+@example\.test>/);
  assert.match(headers, /Date: Fri, 02 Jan 2026 03:04:05 GMT/);
  assert.match(headers, /Content-Transfer-Encoding: base64/);
  const decodedTitle = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(([, word]) => Buffer.from(word, "base64").toString("utf8")).join("");
  assert.equal(decodedTitle, title.replace("\r\n", " "));
  assert.ok(encoded.split("\r\n").every((line) => line.length <= 76));
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), body.replaceAll("\n", "\r\n"));
  assert.throws(() => validateChannelConfig("email", { ...config, to: `${config.to},other@example.test` }), /一个/);
});

test("Bark sends the JSON /push request and checks the APNs payload size", async () => {
  const mock = mockFetch(json({ code: 200, message: "success" }), json({ code: 500, message: secret }));
  assert.deepEqual(await send("bark", mock), success);
  assert.equal(mock.calls[0].url.href, "https://bark.example.test/relay/push");
  assert.deepEqual(jsonBody(mock.calls[0]), { device_key: secret, title: message.title, body: message.body });
  const result = await send("bark", mock, configs.bark, { title: "", body: "😀".repeat(1024) });
  assert.equal(result.code, "message_too_long");
  assert.equal(mock.calls.length, 1);
  const upstream = await send("bark", mock);
  assert.equal(upstream.code, "500");
  assert.equal(upstream.retryable, true);
  safeError(upstream);
});

test("Webhook expands nested JSON values and preserves static destination and headers", async () => {
  const mock = mockFetch(json({ id: 1 }, 201));
  const config = {
    url: `https://gotify.example.test/message?token=${secret}`,
    headers: { "X-Gotify-Key": secret },
    body: { title: "{{TITLE}}", message: "{msg}", priority: 8, extras: ["{{BODY}}", { "{{TITLE}}": true }] },
  };
  const body = `${message.body}\n{{TITLE}}`;
  assert.deepEqual(await send("webhook", mock, config, { ...message, body }), { ...success, status: 201 });
  const [call] = mock.calls;
  assert.equal(call.url.href, config.url);
  assert.equal(call.method, "POST");
  assert.equal(call.redirect, "manual");
  assert.equal(call.headers.get("X-Gotify-Key"), secret);
  assert.deepEqual(jsonBody(call), {
    title: message.title, message: body, priority: 8, extras: [body, { "{{TITLE}}": true }],
  });
});

test("Webhook supports PushDeer and SMTP proxy forms, Pushover status, and plain text", async () => {
  const mock = mockFetch(json({ code: 0 }), json({ code: 1, error: secret }), json({ status: 1 }), json({ status: 0 }), new Response(null, { status: 204 }));
  const form = {
    url: "https://pushdeer.example.test/message/push", bodyType: "form", responseCheck: "json_code_0",
    body: { pushkey: secret, type: "text", text: "{{BODY}}" },
  };
  assert.deepEqual(await send("webhook", mock, form), success);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(mock.calls[0].body)), { pushkey: secret, type: "text", text: message.body });
  assert.match(mock.calls[0].headers.get("Content-Type"), /^application\/x-www-form-urlencoded/);
  const proxy = { ...form, url: "https://smtp.example.test/api", body: `password=${secret}&subject={{TITLE}}&text={msg}&port=587` };
  const bad = await send("webhook", mock, proxy);
  assert.equal(bad.retryable, false);
  assert.equal(bad.code, "1");
  safeError(bad);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(mock.calls[1].body)), { password: secret, subject: message.title, text: message.body, port: "587" });
  const pushover = { url: "https://api.pushover.net/1/messages.json", responseCheck: "json_status_1", body: { token: secret, message: "{{BODY}}" } };
  assert.deepEqual(await send("webhook", mock, pushover), success);
  assert.equal((await send("webhook", mock, pushover)).code, "0");
  assert.deepEqual(await send("webhook", mock, { ...configs.webhook, method: "patch", bodyType: "text", body: "{{TITLE}}\n{msg}" }), { ...success, status: 204 });
  assert.equal(mock.calls[4].method, "PATCH");
  assert.equal(mock.calls[4].body, content);
});

test("Webhook encodes iNotify GET path and query values, blocks dot segments and redirects", async () => {
  const mock = mockFetch(json({}, 302, { Location: `https://other.example.test/${secret}` }));
  const config = {
    url: `https://inotify.example.test/${secret}.send/{msg}?title={{TITLE}}`,
    method: "GET", headers: { Authorization: `Bearer ${secret}` },
  };
  const body = "a/..//other.example.test?x=1&y=#💚";
  const result = await send("webhook", mock, config, { ...message, body });
  const [call] = mock.calls;
  assert.equal(call.url.origin, "https://inotify.example.test");
  assert.equal(call.url.pathname, `/${secret}.send/${encodeURIComponent(body)}`);
  assert.equal(call.url.searchParams.get("title"), message.title);
  assert.equal(call.body, undefined);
  assert.equal(call.redirect, "manual");
  assert.equal(result.code, "redirect_blocked");
  assert.equal(result.retryable, false);
  safeError(result);
  const traversal = await send("webhook", mock, config, { title: "", body: ".." });
  assert.equal(traversal.code, "invalid_webhook_path");
  assert.equal(mock.calls.length, 1);
  assert.throws(() => validateChannelConfig("webhook", { method: "GET", url: "https://{{BODY}}.example.test/" }), /HTTPS/);
  assert.throws(() => validateChannelConfig("webhook", { method: "GET", url: "https://example.test/?{{TITLE}}=x" }), /查询参数值/);
});

test("Telegram uses sendMessage, plain Unicode text and the longest 429 retry hint", async () => {
  const mock = mockFetch(json({ ok: true }), json({ ok: false, error_code: 429, parameters: { retry_after: 12 }, description: secret }, 429, { "Retry-After": "5" }));
  assert.deepEqual(await send("telegram", mock), success);
  assert.equal(mock.calls[0].url.href, "https://api.telegram.org/bot123456:fixture_token/sendMessage");
  assert.deepEqual(jsonBody(mock.calls[0]), {
    chat_id: configs.telegram.chatId, text: content, link_preview_options: { is_disabled: true },
  });
  const limited = await send("telegram", mock);
  assert.equal(limited.code, "429");
  assert.equal(limited.retryAfterMs, 12_000);
  assert.equal(limited.retryable, true);
  safeError(limited);
  const large = await send("telegram", mock, configs.telegram, { title: "", body: "😀".repeat(4097) });
  assert.equal(large.code, "message_too_long");
  assert.equal(mock.calls.length, 2);
});

test("ServerChan sends forms to Turbo and ³ and reports title truncation and nested errors", async () => {
  const mock = mockFetch(json({ code: 0, data: { errno: 0 } }), json({ code: 0 }), json({ code: 0, data: { errno: 4, error: secret } }));
  const long = { ...message, title: "📱".repeat(33) };
  assert.deepEqual(await send("serverchan", mock, configs.serverchan, long), { ...success, code: "title_truncated" });
  assert.equal(mock.calls[0].url.href, "https://sctapi.ftqq.com/SCTfixture.send");
  assert.equal(new URLSearchParams(mock.calls[0].body).get("title"), "📱".repeat(32));
  assert.equal(new URLSearchParams(mock.calls[0].body).get("desp"), message.body);
  assert.deepEqual(await send("serverchan", mock, { sendKey: "sctp123tfixture" }), success);
  assert.equal(mock.calls[1].url.href, "https://123.push.ft07.com/send/sctp123tfixture.send");
  const rejected = await send("serverchan", mock);
  assert.equal(rejected.code, "4");
  assert.equal(rejected.retryable, false);
  safeError(rejected);
});

test("PushPlus sends a plain-text notification and respects account restrictions", async () => {
  const mock = mockFetch(json({ code: 200, data: "tracking-id" }), json({ code: 900, msg: secret }), json({ code: 500, msg: secret }), json({ code: 200 }));
  assert.deepEqual(await send("pushplus", mock), success);
  assert.equal(mock.calls[0].url.href, "https://www.pushplus.plus/send");
  assert.deepEqual(jsonBody(mock.calls[0]), { token: secret, topic: "group", title: message.title, content: message.body, template: "txt" });
  const blocked = await send("pushplus", mock);
  assert.equal(blocked.code, "900");
  assert.equal(blocked.retryable, false);
  safeError(blocked);
  const temporary = await send("pushplus", mock);
  assert.equal(temporary.code, "500");
  assert.equal(temporary.retryable, true);
  const long = { ...message, title: "名".repeat(101) };
  assert.equal((await send("pushplus", mock, configs.pushplus, long)).code, "message_too_long");
  assert.deepEqual(await send("pushplus", mock, { ...configs.pushplus, plan: "member" }, long), success);
});

test("HTTP failures and malformed bodies produce sanitized, independent outcomes", async () => {
  const cases = [
    [new Response(secret, { status: 429, headers: { "Retry-After": new Date(now + 15_000).toUTCString() } }), "rate_limited", true, 15_000],
    [new Response(secret, { status: 503, headers: { "Retry-After": "2" } }), "http_error", true, 2000],
    [new Response(secret, { status: 401 }), "http_error", false, undefined],
    [new Response(secret, { status: 200 }), "invalid_response", true, undefined],
    [json({ errcode: null, errmsg: secret }), "invalid_response", true, undefined],
    [new Error(`https://example.test/${secret}`), "network_error", true, undefined],
  ];
  await Promise.all(cases.map(async ([reply, code, retryable, ms]) => {
    const result = await send("wecom_group", mockFetch(reply));
    assert.equal(result.code, code);
    assert.equal(result.retryable, retryable);
    assert.equal(result.retryAfterMs, ms);
    safeError(result);
  }));
});

test("one timed out attempt aborts without a late send and leaves other channels independent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let completeToken;
  const pending = sendChannel("dingtalk_app", configs.dingtalk_app, message, {
    fetchImpl: async (url, { signal }) => {
      calls.push({ url, signal });
      return new Promise((resolve) => { completeToken = resolve; });
    },
  });
  assert.deepEqual(await send("webhook", mockFetch(json({}))), success);
  t.mock.timers.tick(20_000);
  const timedOut = await pending;
  assert.equal(timedOut.code, "timeout");
  assert.equal(timedOut.retryable, true);
  assert.equal(calls[0].signal.aborted, true);
  completeToken(json({ errcode: 0, access_token: "temporary-token" }));
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
});

test("the send deadline also cancels a stalled response stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = send("wecom_group", mockFetch(new Response(body)));
  await new Promise(setImmediate);
  t.mock.timers.tick(20_000);
  assert.equal((await pending).code, "timeout");
  assert.equal(cancelled, true);
});
