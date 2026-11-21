import { getMany, HttpError, isRecord, keys, text } from "./store.js";

export const eventTypes = [
  { id: "sms.received", label: "收到短信" },
  { id: "call.incoming", label: "来电" },
  { id: "call.disconnected", label: "通话挂断" },
  { id: "device.boot", label: "设备开机" },
  { id: "device.heartbeat", label: "设备心跳" },
  { id: "device.test", label: "设备测试" },
  { id: "device.location", label: "基站定位" },
  { id: "device.traffic", label: "流量统计" },
  { id: "uart.received", label: "串口事件" },
  { id: "schedule.message", label: "定时推送" },
  { id: "schedule.status", label: "设备状态汇总" },
  { id: "schedule.offline", label: "设备离线提醒" },
];

export const deviceEventTypes = new Set(eventTypes.filter(({ id }) => !id.startsWith("schedule.")).map(({ id }) => id));

const labels = Object.fromEntries(eventTypes.map(({ id, label }) => [id, label]));

export const templateVariables = [
  { name: "FROM", label: "发件号码或来电号码" },
  { name: "SMS", label: "短信正文" },
  { name: "CONTENT", label: "事件内容" },
  { name: "RECEIVE_TIME", label: "设备事件时间" },
  { name: "SMS_TIME", label: "短信自带时间" },
  { name: "SERVER_TIME", label: "服务端接收时间" },
  { name: "DEVICE_NAME", label: "设备名称" },
  { name: "DEVICE_ID", label: "设备标识" },
  { name: "DEVICE_INFO", label: "设备状态摘要" },
  { name: "CARD_SLOT", label: "SIM 槽位" },
  { name: "CARD_NUMBER", label: "本机号码" },
  { name: "CARD_NAME", label: "运营商" },
  { name: "CALL_NUMBER", label: "来电号码" },
  { name: "BOOT_REASON", label: "开机原因" },
  { name: "SIGNAL", label: "信号强度" },
  { name: "UPTIME", label: "开机时长（秒）" },
  { name: "NETWORK_STATE", label: "网络状态" },
  { name: "LOCATION", label: "位置" },
  { name: "TRAFFIC", label: "流量统计" },
  { name: "EVENT_TYPE", label: "事件类型" },
  { name: "JOB_NAME", label: "计划任务名称" },
];

const variableNames = new Set(templateVariables.map(({ name }) => name));
const placeholder = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function normalizeTemplate(input, { preview = false } = {}) {
  const title = text(input.title, "标题", { max: 256, trim: false });
  const body = text(input.body, "正文", { max: 8192, trim: false, required: !preview });
  for (const field of [title, body]) {
    for (const [, name] of field.matchAll(placeholder)) {
      if (!variableNames.has(name)) throw new HttpError(400, `未知占位符 ${name}`);
    }
    if (/\{\{|\}\}/.test(field.replace(placeholder, ""))) throw new HttpError(400, "占位符须使用 {{变量名}} 格式");
  }
  return { title, body };
}

function display(value) {
  return ["number", "string", "boolean"].includes(typeof value) ? String(value) : "";
}

function locationText(location) {
  if (!isRecord(location)) return display(location);
  if (typeof location.lat === "number" && typeof location.lng === "number") return `${location.lat}, ${location.lng}`;
  return display(location.map_url ?? location.map_link);
}

function trafficText(traffic) {
  if (!isRecord(traffic)) return display(traffic);
  const lines = [];
  if (Number.isFinite(traffic.uplink_bytes)) lines.push(`上行 ${traffic.uplink_bytes} B`);
  if (Number.isFinite(traffic.downlink_bytes)) lines.push(`下行 ${traffic.downlink_bytes} B`);
  return lines.join("，");
}

export function statusText(status = {}) {
  const lines = [];
  if (status.number) lines.push(`本机号码 ${display(status.number)}`);
  if (status.operator) lines.push(`运营商 ${display(status.operator)}`);
  if (Number.isFinite(status.rsrp_dbm)) lines.push(`信号 ${status.rsrp_dbm} dBm`);
  if (Number.isFinite(status.uptime_seconds)) lines.push(`开机时长 ${status.uptime_seconds} 秒`);
  if (status.network_state != null) lines.push(`网络 ${display(status.network_state)}`);
  const position = locationText(status.location);
  if (position) lines.push(`位置 ${position}`);
  const traffic = trafficText(status.traffic);
  if (traffic) lines.push(`流量 ${traffic}`);
  return lines.join("\n");
}

export function defaultTemplate(event) {
  switch (event.type) {
    case "sms.received":
      return { title: "{{DEVICE_NAME}} · 收到短信", body: "发件号码 {{FROM}}\n接收时间 {{RECEIVE_TIME}}\n\n{{SMS}}" };
    case "call.incoming":
    case "call.disconnected":
      return { title: "{{DEVICE_NAME}} · {{EVENT_TYPE}}", body: "通话号码 {{CALL_NUMBER}}\n事件时间 {{RECEIVE_TIME}}" };
    case "device.boot":
      return { title: "{{DEVICE_NAME}} · 设备开机", body: "开机原因 {{BOOT_REASON}}\n{{DEVICE_INFO}}" };
    case "device.heartbeat":
    case "device.test":
      return { title: "{{DEVICE_NAME}} · {{EVENT_TYPE}}", body: "{{RECEIVE_TIME}}\n{{DEVICE_INFO}}" };
    case "device.location":
      return { title: "{{DEVICE_NAME}} · 基站定位", body: "{{LOCATION}}\n{{RECEIVE_TIME}}" };
    case "device.traffic":
      return { title: "{{DEVICE_NAME}} · 流量统计", body: "{{TRAFFIC}}\n{{RECEIVE_TIME}}" };
    case "uart.received":
      return { title: "{{DEVICE_NAME}} · {{EVENT_TYPE}}", body: "{{CONTENT}}" };
    case "schedule.message":
    case "schedule.status":
    case "schedule.offline":
      return { title: "{{JOB_NAME}}", body: "{{CONTENT}}" };
    default:
      return { title: "{{DEVICE_NAME}} · {{EVENT_TYPE}}", body: "{{RECEIVE_TIME}}\n{{DEVICE_INFO}}" };
  }
}

export async function getEventTemplates(kv, type) {
  const types = type === undefined ? eventTypes : eventTypes.filter(({ id }) => id === type);
  const overrides = await getMany(kv, types.map(({ id }) => keys.eventTemplate(id)));
  return types.map(({ id, label }) => {
    const defaults = defaultTemplate({ type: id });
    const template = overrides.get(keys.eventTemplate(id));
    return {
      id, label,
      title: template?.title || defaults.title,
      body: template?.body ?? defaults.body,
      customized: template != null,
      defaults,
    };
  });
}

export function renderMessage(template, event) {
  const { data = {}, status = {} } = event;
  const shownStatus = event.type === "device.boot" && status.network_state === "网络未注册"
    ? { ...status, network_state: undefined } : status;
  const values = {
    FROM: data.sender ?? data.number,
    SMS: event.type === "sms.received" ? data.content : "",
    CONTENT: data.content ?? data.text,
    RECEIVE_TIME: event.occurred_at ?? event.received_at,
    SMS_TIME: data.sms_time,
    SERVER_TIME: event.received_at,
    DEVICE_NAME: event.device_name ?? event.device_id,
    DEVICE_ID: event.device_id,
    DEVICE_INFO: statusText(shownStatus),
    CARD_SLOT: data.sim_slot,
    CARD_NUMBER: status.number,
    CARD_NAME: status.operator,
    CALL_NUMBER: data.number,
    BOOT_REASON: data.reason,
    SIGNAL: status.rsrp_dbm,
    UPTIME: status.uptime_seconds,
    NETWORK_STATE: shownStatus.network_state,
    LOCATION: locationText(data.location ?? status.location ?? (event.type === "device.location" ? data : null)),
    TRAFFIC: trafficText(data.traffic ?? status.traffic ?? (event.type === "device.traffic" ? data : null)),
    EVENT_TYPE: labels[event.type] ?? event.type,
    JOB_NAME: data.job_name,
  };
  const render = (value) => value.replace(placeholder, (_, name) => display(values[name]));
  const defaults = defaultTemplate(event);
  return { title: render(template?.title || defaults.title), body: render(template?.body ?? defaults.body) };
}

export function sampleEvent(type, now = Date.now()) {
  if (!Object.hasOwn(labels, type)) throw new HttpError(400, "请选择有效的事件类型");
  const time = new Date(now).toISOString();
  const status = { number: "10001", operator: "示例运营商", rsrp_dbm: -95, uptime_seconds: 7200, network_state: "网络已注册" };
  let data = {};
  if (type === "sms.received") data = { sender: "10086", content: "这是用于预览的短信。", sim_slot: 0, sms_time: "2026-06-10 15:04:05" };
  if (type.startsWith("call.")) data = { number: "13800138000" };
  if (type === "device.boot") data = { reason: "上电" };
  if (type === "device.location") data = { lat: 31.23, lng: 121.47 };
  if (type === "device.traffic") data = { uplink_bytes: 24576, downlink_bytes: 65536 };
  if (type.startsWith("schedule.")) data = { job_name: "示例计划任务", content: "这是用于预览的计划任务。" };
  if (type === "uart.received") data = { content: "这是用于预览的设备记录。" };
  return { type, data, status, device_name: "示例设备", device_id: "air780-demo", occurred_at: time, received_at: time };
}
