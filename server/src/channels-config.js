import { HttpError, isRecord } from "./store.js";
import { httpsUrl, normalizeWebhookConfig } from "./channels-webhook.js";

function field(key, label, kind = "text", options = {}) {
  return { key, label, kind, required: true, secret: kind === "url" || kind === "password", ...options };
}

const webhookUrl = () => field("webhookUrl", "群机器人 Webhook 地址", "url");
const signingSecret = () => field("secret", "加签密钥", "password", { required: false });
const agentId = (required = true) => field("agentId", "应用 AgentId", "number", { required });

export const channelTypes = {
  dingtalk_group: { label: "钉钉群机器人", fields: [webhookUrl(), signingSecret()] },
  dingtalk_app: { label: "钉钉企业内机器人", fields: [
    field("mode", "发送方式", "select", { required: false, options: [
      { value: "robot_direct", label: "机器人单聊" }, { value: "robot_group", label: "机器人群聊" },
      { value: "work_notice", label: "应用工作通知" },
    ] }),
    field("appKey", "AppKey", "text", { secret: true }), field("appSecret", "AppSecret", "password"),
    field("robotCode", "机器人编码", "text", { required: false, secret: true, placeholder: "留空使用 AppKey" }),
    field("userIds", "接收用户 ID", "text", { required: false, placeholder: "user1,user2（工作通知可用 @all）" }),
    field("openConversationId", "群会话 ID", "text", { required: false, placeholder: "机器人群聊使用" }),
    field("msgKey", "机器人消息格式", "select", { required: false, options: [
      { value: "sampleText", label: "文本" }, { value: "sampleMarkdown", label: "Markdown" },
    ] }),
    agentId(false), field("departmentIds", "接收部门 ID", "text", { required: false, placeholder: "工作通知使用，例如 2,3" }),
  ] },
  wecom_group: { label: "企业微信群机器人", fields: [webhookUrl()] },
  wecom_app: { label: "企业微信应用", fields: [
    field("corpId", "企业 ID", "text", { secret: true }), field("corpSecret", "应用 Secret", "password"), agentId(),
    field("toUser", "接收用户 ID", "text", { required: false, placeholder: "user1|user2 或 @all" }),
    field("toParty", "接收部门 ID", "text", { required: false, placeholder: "2|3" }),
    field("toTag", "接收标签 ID", "text", { required: false, placeholder: "4|5" }),
  ] },
  feishu_group: { label: "飞书群机器人", fields: [webhookUrl(), signingSecret()] },
  feishu_app: { label: "飞书应用机器人", fields: [
    field("appId", "App ID", "text", { secret: true }), field("appSecret", "App Secret", "password"),
    field("receiveIdType", "接收 ID 类型", "select", { options: ["open_id", "union_id", "user_id", "email", "chat_id"] }),
    field("receiveId", "接收 ID"),
  ] },
  email: { label: "Cloudflare 邮件", fields: [
    field("mode", "邮件服务", "select", { required: false, options: [
      { value: "sending", label: "Email Sending" }, { value: "routing", label: "Email Routing（已验证收件地址）" },
    ] }),
    field("from", "发件地址"), field("to", "收件地址", "text", { placeholder: "Email Sending 的多个地址用逗号分隔" }),
  ] },
  bark: { label: "Bark", fields: [
    field("baseUrl", "服务器根地址", "url", { required: false, placeholder: "https://api.day.app" }),
    field("deviceKey", "设备密钥", "password"),
  ] },
  webhook: { label: "通用 Webhook", fields: [
    field("url", "目标 HTTPS 地址", "url", { placeholder: "https://example.com/notify" }),
    field("method", "HTTP 方法", "select", { required: false, options: ["POST", "GET", "PUT", "PATCH", "DELETE"] }),
    field("headers", "请求头（JSON 对象）", "json", { required: false, secret: true }),
    field("bodyType", "正文格式", "select", { required: false, options: ["json", "form", "text"] }),
    field("body", "正文模板", "textarea", { required: false, secret: true, placeholder: '{"title":"{{TITLE}}","message":"{{BODY}}"}' }),
    field("responseCheck", "成功判定", "select", { required: false, options: [
      { value: "http", label: "HTTP 2xx" },
      { value: "json_code_0", label: "HTTP 2xx 和 JSON code = 0" },
      { value: "json_status_1", label: "HTTP 2xx 和 JSON status = 1" },
    ] }),
  ] },
  telegram: { label: "Telegram 机器人", fields: [
    field("botToken", "Bot Token", "password"), field("chatId", "Chat ID 或 @频道用户名"),
  ] },
  serverchan: { label: "Server 酱", fields: [field("sendKey", "SendKey", "password")] },
  pushplus: { label: "PushPlus", fields: [
    field("token", "Token", "password"), field("topic", "群组编码", "text", { required: false }),
    field("plan", "账户额度", "select", { required: false, options: [
      { value: "standard", label: "普通账户" }, { value: "member", label: "会员" },
    ] }),
  ] },
};

function nativeWebhook(value, host, path, tokenKey) {
  const url = httpsUrl(value, "群机器人 Webhook 地址");
  if (url.hostname !== host || url.port || !path.test(url.pathname)) {
    throw new HttpError(400, "群机器人 Webhook 地址与渠道不匹配");
  }
  if (tokenKey) {
    const tokens = url.searchParams.getAll(tokenKey);
    if (tokens.length !== 1 || !tokens[0] || /[\s\u0000-\u001f\u007f]/.test(tokens[0])) {
      throw new HttpError(400, "群机器人 Webhook 地址缺少有效凭据");
    }
    url.search = "";
    url.searchParams.set(tokenKey, tokens[0]);
  } else {
    url.search = "";
  }
  return url.href;
}

function recipients(value, separator, limit, label, pattern = /^[^\s@]+$/u, allowAll = false) {
  if (value === undefined) return;
  if (allowAll && value === "@all") return value;
  const ids = [...new Set(value.split(separator).map((id) => id.trim()))];
  if (ids.length > limit || ids.some((id) => !pattern.test(id))) {
    throw new HttpError(400, `${label}须由分隔符两侧的有效 ID 组成，最多 ${limit} 项`);
  }
  return ids.join(separator);
}

const numericId = /^\d+$/;
const mailbox = /^[^\s@<>,;:()\[\]"\\]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function normalizeRecipients(config, specs) {
  for (const [key, separator, limit, label, pattern, allowAll] of specs) {
    if (Object.hasOwn(config, key)) config[key] = recipients(config[key], separator, limit, label, pattern, allowAll);
  }
  if (!specs.some(([key]) => config[key])) throw new HttpError(400, "请至少配置一种应用接收方");
}

const normalize = {
  dingtalk_group(config) {
    config.webhookUrl = nativeWebhook(config.webhookUrl, "oapi.dingtalk.com", /^\/robot\/send$/, "access_token");
  },
  dingtalk_app(config) {
    config.mode ??= "robot_direct";
    if (config.mode === "work_notice") {
      if (!config.agentId) throw new HttpError(400, "工作通知须填写应用 AgentId");
      normalizeRecipients(config, [
        ["userIds", ",", 100, "接收用户 ID", undefined, true],
        ["departmentIds", ",", 20, "接收部门 ID", numericId],
      ]);
      if (config.userIds === "@all") delete config.departmentIds;
      delete config.robotCode;
      delete config.openConversationId;
      delete config.msgKey;
      return;
    }
    delete config.agentId;
    delete config.departmentIds;
    config.msgKey ??= "sampleText";
    if (config.mode === "robot_group") {
      if (!config.openConversationId) throw new HttpError(400, "机器人群聊须填写群会话 ID");
      delete config.userIds;
      return;
    }
    delete config.openConversationId;
    const ids = config.userIds?.split(/[,，;；|]/).map((id) => id.trim()).filter(Boolean).join(",");
    if (!ids) throw new HttpError(400, "机器人单聊须填写接收用户 ID");
    config.userIds = recipients(ids, ",", 20, "接收用户 ID");
  },
  wecom_group(config) {
    config.webhookUrl = nativeWebhook(config.webhookUrl, "qyapi.weixin.qq.com", /^\/cgi-bin\/webhook\/send$/, "key");
  },
  wecom_app(config) {
    normalizeRecipients(config, [
      ["toUser", "|", 1000, "接收用户 ID", undefined, true],
      ["toParty", "|", 100, "接收部门 ID", numericId],
      ["toTag", "|", 100, "接收标签 ID", numericId],
    ]);
    if (config.toUser === "@all") {
      delete config.toParty;
      delete config.toTag;
    }
  },
  feishu_group(config) {
    config.webhookUrl = nativeWebhook(config.webhookUrl, "open.feishu.cn", /^\/open-apis\/bot\/v2\/hook\/[\w-]+$/);
  },
  feishu_app(config) {
    if (config.receiveIdType === "email" && !mailbox.test(config.receiveId)) throw new HttpError(400, "接收 ID 须为邮箱地址");
  },
  email(config) {
    if (!mailbox.test(config.from) || config.from.length > 254) throw new HttpError(400, "发件地址须为有效邮箱地址");
    const to = [...new Set(config.to.split(",").map((address) => address.trim()))];
    if (to.length > 50 || to.some((address) => !mailbox.test(address) || address.length > 254)) {
      throw new HttpError(400, "请填写最多 50 个有效收件地址，多个地址用逗号分隔");
    }
    config.mode ??= "sending";
    if (config.mode === "routing" && to.length !== 1) throw new HttpError(400, "Email Routing 每个渠道须配置一个已验证收件地址");
    config.to = to.join(",");
  },
  bark(config) {
    const url = httpsUrl(config.baseUrl ?? "https://api.day.app", "Bark 服务器根地址");
    if (url.search) throw new HttpError(400, "Bark 服务器根地址不能包含查询参数");
    config.baseUrl = url.origin + url.pathname.replace(/\/+$/, "");
  },
  telegram(config) {
    if (!/^\d+:[\w-]+$/.test(config.botToken)) throw new HttpError(400, "Bot Token 格式无效");
    if (!/^-?\d+$|^@[a-z0-9_]+$/i.test(config.chatId)) throw new HttpError(400, "请填写数字 Chat ID 或 @频道用户名");
  },
  serverchan(config) {
    if (!/^(?:SCT[\w-]+|sctp\d{1,63}t[\w-]+)$/.test(config.sendKey)) throw new HttpError(400, "SendKey 格式无效");
  },
  pushplus(config) {
    config.plan ??= "standard";
  },
};

function normalizeField(spec, value) {
  const { key, label, kind, options } = spec;
  if (kind === "number") {
    const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number <= 0) throw new HttpError(400, `${label}须为正整数`);
    return number;
  }
  if (kind === "json" || kind === "textarea") return value;
  if (key === "chatId" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string" || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value.trim())) {
    throw new HttpError(400, `${label}须为有效文字`);
  }
  let text = value.trim();
  if (key === "method") text = text.toUpperCase();
  if (kind === "select" && !options.some((option) => (typeof option === "string" ? option : option.value) === text)) {
    throw new HttpError(400, `${label}值无效`);
  }
  return text;
}

export function validateChannelConfig(type, raw) {
  if (typeof type !== "string" || !Object.hasOwn(channelTypes, type)) throw new HttpError(400, "未知渠道类型");
  if (!isRecord(raw)) throw new HttpError(400, "渠道配置须为 JSON 对象");
  const { fields } = channelTypes[type];
  if (Object.keys(raw).some((key) => !fields.some((spec) => spec.key === key))) {
    throw new HttpError(400, "渠道配置包含未知字段");
  }

  const config = {};
  for (const spec of fields) {
    const value = Object.hasOwn(raw, spec.key) ? raw[spec.key] : undefined;
    if (value == null || value === "" || (typeof value === "string" && spec.kind !== "textarea" && !value.trim())) {
      if (spec.required) throw new HttpError(400, `请填写${spec.label}`);
    } else {
      config[spec.key] = normalizeField(spec, value);
    }
  }
  if (type === "webhook") return normalizeWebhookConfig(config);
  normalize[type](config);
  return config;
}
