import { HttpError } from "./store.js";
import { validateChannelConfig } from "./channels-config.js";
import {
  ChannelError, invalidResponse, postJson, requireBusinessSuccess, requireLength,
  request, secondsToMs, sent, timeoutError, utf8Size,
} from "./channels-http.js";
import { sendWebhook } from "./channels-webhook.js";

export { channelTypes, validateChannelConfig } from "./channels-config.js";

const SEND_TIMEOUT_MS = 20_000;
const encoder = new TextEncoder();
const dingtalkBase = "https://oapi.dingtalk.com";
const dingtalkRobotBase = "https://api.dingtalk.com/v1.0";
const wecomBase = "https://qyapi.weixin.qq.com";
const feishuBase = "https://open.feishu.cn/open-apis";

const dingtalkGroupErrors = { transient: [-1], rateLimits: { 130101: 600_000, 410100: 600_000 } };
const dingtalkAppErrors = {
  transient: [-1],
  rateLimits: { 90002: 1000, 90005: 60_000, 90006: 60_000, 90008: 60_000, 90010: 60_000, 90014: 60_000, 90018: 1000, 90019: 1000 },
};
const wecomErrors = { transient: [-1], rateLimits: { 45009: undefined, 45011: undefined, 45033: undefined } };
const feishuErrors = {
  transient: [96402, 5000],
  rateLimits: { 11232: undefined, 11233: undefined, 11247: undefined, 230020: undefined, 99991400: undefined },
};

function textMessage({ title, body }) {
  return title && body ? `${title}\n${body}` : title || body;
}

function singleLineTitle(title) {
  return title.replace(/[\r\n\u2028\u2029]+/g, " ").trim() || "设备通知";
}

function byteLimit(value, max, label = "通知内容") {
  requireLength(utf8Size(value) <= max, label, `${max} UTF-8 字节`);
}

function charLimit(value, max, label = "通知内容") {
  let length = 0;
  for (const _ of value) {
    if (++length > max) {
      requireLength(false, label, `${max} 字符`);
    }
  }
}

async function signature(key, value) {
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(value)));
  return btoa(String.fromCharCode(...bytes));
}

function apiUrl(base, path, params) {
  const url = new URL(base + path);
  url.search = new URLSearchParams(params).toString();
  return url;
}

function getToken(reply, field) {
  const value = reply.data?.[field];
  if (typeof value !== "string" || !value || /[\s\u0000-\u001f\u007f]/.test(value)) throw invalidResponse(reply);
  return value;
}

async function sendDingtalkGroup(config, message, context) {
  const content = textMessage(message);
  // DingTalk's developer community reports a 4,000-character limit for legacy group bots.
  charLimit(content, 4000);
  const url = new URL(config.webhookUrl);
  if (config.secret) {
    const timestamp = String(Math.floor(context.now()));
    url.searchParams.set("timestamp", timestamp);
    url.searchParams.set("sign", await signature(config.secret, `${timestamp}\n${config.secret}`));
  }
  const reply = await postJson(context, url, { msgtype: "text", text: { content } });
  requireBusinessSuccess(reply, reply.data?.errcode, 0, dingtalkGroupErrors);
  return sent(reply.status);
}

async function sendDingtalkWorkNotice(config, message, context) {
  const msg = { msgtype: "text", text: { content: textMessage(message) } };
  byteLimit(JSON.stringify(msg), 2048);

  const tokenUrl = apiUrl(dingtalkBase, "/gettoken", { appkey: config.appKey, appsecret: config.appSecret });
  const token = await request(context, tokenUrl, { method: "GET" });
  requireBusinessSuccess(token, token.data?.errcode, 0, dingtalkAppErrors);
  const url = apiUrl(dingtalkBase, "/topapi/message/corpconversation/asyncsend_v2", { access_token: getToken(token, "access_token") });
  const all = config.userIds === "@all";
  const payload = { agent_id: config.agentId, to_all_user: all, msg };
  if (config.userIds && !all) payload.userid_list = config.userIds;
  if (config.departmentIds) payload.dept_id_list = config.departmentIds;
  const reply = await postJson(context, url, payload);
  requireBusinessSuccess(reply, reply.data?.errcode, 0, { ...dingtalkAppErrors, transient: [-1, 40014, 42001] });
  return sent(reply.status);
}

const dingtalkRobotRateLimits = new Set(["send.byToken.tooFast", "send.too.fast", "too.many.group", "too.many.people"]);

function requireDingtalkRobotSuccess(reply) {
  const code = reply.data?.code;
  const details = { status: reply.status, retryAfterMs: reply.retryAfterMs };
  if (dingtalkRobotRateLimits.has(code)) {
    throw new ChannelError(code, "钉钉机器人发送过于频繁", { ...details, retryable: true });
  }
  if (code === "invalidParameter.msgParam.tooLong") {
    throw new ChannelError("message_too_long", "通知内容超过钉钉机器人限制", details);
  }
  if (code === "system.error" || code === "token.notExisted") {
    throw new ChannelError(code, "钉钉机器人服务暂不可用", { ...details, retryable: true });
  }
  // v1.0 success responses have no business code.
  requireBusinessSuccess(reply, code ?? 0, 0, dingtalkAppErrors);
}

async function sendDingtalkApp(config, message, context) {
  if (config.mode === "work_notice") return sendDingtalkWorkNotice(config, message, context);
  const group = config.mode === "robot_group";
  const parameters = config.msgKey === "sampleMarkdown"
    ? { title: singleLineTitle(message.title), text: message.body || message.title }
    : { content: textMessage(message) };
  const payload = {
    robotCode: config.robotCode ?? config.appKey,
    msgKey: config.msgKey,
    msgParam: JSON.stringify(parameters),
  };
  if (group) payload.openConversationId = config.openConversationId;
  else payload.userIds = config.userIds.split(",");

  const token = await postJson(context, `${dingtalkRobotBase}/oauth2/accessToken`, { appKey: config.appKey, appSecret: config.appSecret });
  requireDingtalkRobotSuccess(token);
  const endpoint = group ? "/robot/groupMessages/send" : "/robot/oToMessages/batchSend";
  const reply = await postJson(context, dingtalkRobotBase + endpoint, payload, {
    "x-acs-dingtalk-access-token": getToken(token, "accessToken"),
  });
  requireDingtalkRobotSuccess(reply);

  let partial = false;
  if (!group) {
    const invalid = Array.isArray(reply.data?.invalidStaffIdList) ? reply.data.invalidStaffIdList : [];
    const throttled = Array.isArray(reply.data?.flowControlledStaffIdList) ? reply.data.flowControlledStaffIdList : [];
    const rejected = new Set([...invalid, ...throttled]);
    if (payload.userIds.every((id) => rejected.has(id))) {
      const retryable = payload.userIds.some((id) => throttled.includes(id));
      throw new ChannelError(retryable ? "rate_limited" : "invalid_recipients", retryable ? "钉钉机器人发送过于频繁" : "钉钉机器人没有有效接收方", {
        status: reply.status, retryable, retryAfterMs: reply.retryAfterMs,
      });
    }
    partial = payload.userIds.some((id) => rejected.has(id));
  }
  if (typeof reply.data?.processQueryKey !== "string" || !reply.data.processQueryKey) throw invalidResponse(reply);
  return sent(reply.status, partial ? "partial_delivery" : undefined);
}

async function sendWecomGroup(config, message, context) {
  const content = textMessage(message);
  byteLimit(content, 2048);
  const reply = await postJson(context, config.webhookUrl, { msgtype: "text", text: { content } });
  requireBusinessSuccess(reply, reply.data?.errcode, 0, { ...wecomErrors, rateLimits: { ...wecomErrors.rateLimits, 45009: 60_000 } });
  return sent(reply.status);
}

async function sendWecomApp(config, message, context) {
  const content = textMessage(message);
  byteLimit(content, 2048);
  const tokenUrl = apiUrl(wecomBase, "/cgi-bin/gettoken", { corpid: config.corpId, corpsecret: config.corpSecret });
  const token = await request(context, tokenUrl, { method: "GET" });
  requireBusinessSuccess(token, token.data?.errcode, 0, wecomErrors);
  const url = apiUrl(wecomBase, "/cgi-bin/message/send", { access_token: getToken(token, "access_token") });
  const payload = { agentid: config.agentId, msgtype: "text", text: { content } };
  if (config.toUser) payload.touser = config.toUser;
  if (config.toParty) payload.toparty = config.toParty;
  if (config.toTag) payload.totag = config.toTag;
  const reply = await postJson(context, url, payload);
  requireBusinessSuccess(reply, reply.data?.errcode, 0, { ...wecomErrors, transient: [-1, 40014, 42001] });
  const partial = ["invaliduser", "invalidparty", "invalidtag", "unlicenseduser"].some((key) => reply.data?.[key]?.length > 0);
  return sent(reply.status, partial ? "partial_delivery" : undefined);
}

async function sendFeishuGroup(config, message, context) {
  const payload = { msg_type: "text", content: { text: textMessage(message) } };
  if (config.secret) {
    payload.timestamp = String(Math.floor(context.now() / 1000));
    payload.sign = await signature(`${payload.timestamp}\n${config.secret}`, "");
  }
  byteLimit(JSON.stringify(payload), 20 * 1024);
  const reply = await postJson(context, config.webhookUrl, payload, {}, { feishu: true });
  requireBusinessSuccess(reply, reply.data?.code ?? reply.data?.StatusCode, 0, feishuErrors);
  return sent(reply.status);
}

async function sendFeishuApp(config, message, context) {
  const payload = {
    receive_id: config.receiveId,
    msg_type: "text",
    content: JSON.stringify({ text: textMessage(message) }),
  };
  if (context.deliveryId) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(context.deliveryId)));
    payload.uuid = Array.from(hash.subarray(0, 20), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  byteLimit(JSON.stringify(payload), 150 * 1024);

  const token = await postJson(context, `${feishuBase}/auth/v3/tenant_access_token/internal`, {
    app_id: config.appId, app_secret: config.appSecret,
  }, {}, { feishu: true });
  requireBusinessSuccess(token, token.data?.code, 0, feishuErrors);
  const url = apiUrl(feishuBase, "/im/v1/messages", { receive_id_type: config.receiveIdType });
  const reply = await postJson(context, url, payload, {
    Authorization: `Bearer ${getToken(token, "tenant_access_token")}`,
  }, { feishu: true });
  requireBusinessSuccess(reply, reply.data?.code, 0, { ...feishuErrors, transient: [...feishuErrors.transient, 99991663, 99991677] });
  return sent(reply.status);
}

const transientEmailErrors = new Set([
  "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR", "E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED",
]);
const permanentEmailErrors = new Set([
  "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS", "E_CONTENT_TOO_LARGE",
  "E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_SENDER_DOMAIN_NOT_CONFIGURED", "E_EMAIL_SENDING_NOT_READY",
  "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_PLAN_RESTRICTED", "E_RECIPIENT_SUPPRESSED", "E_ACCOUNT_SUSPENDED",
  "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID", "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY",
]);

const emailLimit = 25 * 1024 * 1024;
const base64 = (bytes) => btoa(String.fromCharCode(...bytes));

function encodeMimeSubject(subject) {
  const words = [];
  let word = "";
  let size = 0;
  for (const character of subject) {
    const bytes = utf8Size(character);
    // A 42-byte chunk fits an encoded word on the first Subject header line.
    if (size + bytes > 42) {
      words.push(`=?UTF-8?B?${base64(encoder.encode(word))}?=`);
      word = "";
      size = 0;
    }
    word += character;
    size += bytes;
  }
  words.push(`=?UTF-8?B?${base64(encoder.encode(word))}?=`);
  return words.join("\r\n ");
}

function routingMime({ from, to, subject, text }, now) {
  const bytes = encoder.encode(text.replace(/\r\n|\r|\n/g, "\r\n"));
  const domain = from.split("@")[1];
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodeMimeSubject(subject)}`,
    `Date: ${new Date(now).toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
  ];
  // 57 input bytes form an unpadded 76-character base64 line.
  for (let offset = 0; offset < bytes.length; offset += 57) lines.push(base64(bytes.subarray(offset, offset + 57)));
  const raw = lines.join("\r\n") + "\r\n";
  byteLimit(raw, emailLimit, "邮件内容");
  return raw;
}

async function sendEmail(config, message, context) {
  const binding = context.env?.SEND_EMAIL;
  if (typeof binding?.send !== "function") throw new ChannelError("email_binding_missing", "Worker 未配置 SEND_EMAIL 邮件绑定");
  const recipients = config.to.split(",");
  const email = {
    from: config.from,
    to: recipients.length === 1 ? recipients[0] : recipients,
    subject: singleLineTitle(message.title),
    text: message.body || message.title,
  };
  byteLimit(email.subject + email.text, emailLimit, "邮件内容");
  try {
    if (config.mode === "routing") {
      const EmailMessage = context.env.EmailMessage ?? (await import("cloudflare:email")).EmailMessage;
      if (context.signal.aborted) throw timeoutError();
      await binding.send(new EmailMessage(email.from, email.to, routingMime(email, context.now())));
    } else {
      await binding.send(email);
    }
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    const code = error?.code;
    if (code === "ERR_UNSUPPORTED_ESM_URL_SCHEME") {
      throw new ChannelError("email_runtime_unavailable", "运行环境缺少 EmailMessage 构造器");
    }
    if (permanentEmailErrors.has(code) || error instanceof TypeError) {
      throw new ChannelError(permanentEmailErrors.has(code) ? code : "email_invalid_message", "Cloudflare 邮件服务拒绝了请求");
    }
    throw new ChannelError(transientEmailErrors.has(code) ? code : "email_error", "Cloudflare 邮件服务暂时无法发送", { retryable: true });
  }
  return sent();
}

async function sendBark(config, message, context) {
  const title = message.body ? message.title : "";
  const body = message.body || message.title;
  const apns = JSON.stringify({ aps: {
    alert: { title, body }, "mutable-content": 1, sound: "1107.caf", category: "myNotificationCategory",
  } }).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  byteLimit(apns, 4096, "Bark APNs 载荷");
  const reply = await postJson(context, `${config.baseUrl}/push`, { device_key: config.deviceKey, title, body });
  requireBusinessSuccess(reply, reply.data?.code, 200, { transient: [500, 502, 503, 504] });
  return sent(reply.status);
}

async function sendTelegram(config, message, context) {
  const text = textMessage(message);
  charLimit(text, 4096);
  const reply = await postJson(context, `https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    chat_id: config.chatId, text, link_preview_options: { is_disabled: true },
  });
  if (reply.data?.ok === false) {
    const delay = secondsToMs(reply.data.parameters?.retry_after);
    const retryAfterMs = Math.max(reply.retryAfterMs ?? -1, delay ?? -1);
    requireBusinessSuccess(reply, reply.data.error_code, 0, {
      transient: [408, 409, 425, 500, 502, 503, 504], retryAfterMs: retryAfterMs >= 0 ? retryAfterMs : undefined,
    });
  }
  requireBusinessSuccess(reply, reply.data?.ok === true ? 0 : undefined, 0);
  return sent(reply.status);
}

async function sendServerchan(config, message, context) {
  const uid = /^sctp(\d+)t/.exec(config.sendKey)?.[1];
  const path = `${config.sendKey}.send`;
  const url = uid ? `https://${uid}.push.ft07.com/send/${path}` : `https://sctapi.ftqq.com/${path}`;
  const title = Array.from(singleLineTitle(message.title));
  const body = new URLSearchParams({ title: title.slice(0, 32).join(""), desp: message.body });
  const reply = await request(context, url, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }, body: body.toString(),
  });
  const errors = { transient: [500, 502, 503, 504] };
  requireBusinessSuccess(reply, reply.data?.code, 0, errors);
  if (reply.data?.data?.errno !== undefined) requireBusinessSuccess(reply, reply.data.data.errno, 0, errors);
  return sent(reply.status, title.length > 32 ? "title_truncated" : undefined);
}

async function sendPushplus(config, message, context) {
  const title = singleLineTitle(message.title);
  const content = message.body || message.title;
  const member = config.plan === "member";
  charLimit(title, member ? 200 : 100, "PushPlus 标题");
  charLimit(content, member ? 100_000 : 20_000, "PushPlus 正文");
  const payload = { token: config.token, title, content, template: "txt" };
  if (config.topic) payload.topic = config.topic;
  const reply = await postJson(context, "https://www.pushplus.plus/send", payload);
  requireBusinessSuccess(reply, reply.data?.code, 200, { transient: [500, 502, 503, 504] });
  return sent(reply.status);
}

const senders = {
  dingtalk_group: sendDingtalkGroup, dingtalk_app: sendDingtalkApp,
  wecom_group: sendWecomGroup, wecom_app: sendWecomApp,
  feishu_group: sendFeishuGroup, feishu_app: sendFeishuApp,
  email: sendEmail, bark: sendBark, webhook: sendWebhook,
  telegram: sendTelegram, serverchan: sendServerchan, pushplus: sendPushplus,
};

export async function sendChannel(type, config, message, options = {}) {
  let normalized;
  try {
    normalized = validateChannelConfig(type, config);
  } catch (error) {
    const problem = error instanceof HttpError ? error.message : "渠道配置无效";
    return new ChannelError("invalid_config", problem).result;
  }
  if (typeof message?.title !== "string" || typeof message?.body !== "string" ||
      !message.title.isWellFormed() || !message.body.isWellFormed() || (!message.title && !message.body)) {
    return new ChannelError("invalid_message", "通知须包含有效标题或正文").result;
  }

  const controller = new AbortController();
  let timer;
  try {
    const { env, fetchImpl = fetch, deliveryId, now } = options;
    const clock = () => {
      const value = typeof now === "function" ? now() : now ?? Date.now();
      if (!Number.isFinite(value) || value < 0) throw new ChannelError("invalid_clock", "渠道发送时间无效");
      return value;
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError());
        controller.abort();
      }, SEND_TIMEOUT_MS);
    });
    const context = { env, fetchImpl, deliveryId, now: clock, signal: controller.signal };
    return await Promise.race([timeout, senders[type](normalized, message, context)]);
  } catch (error) {
    if (error instanceof ChannelError) return error.result;
    return new ChannelError("send_error", "渠道发送暂时失败", { retryable: true }).result;
  } finally {
    clearTimeout(timer);
  }
}
