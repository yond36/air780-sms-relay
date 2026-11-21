import { dataStore } from "./db.js";
import { deliveryStates, isTerminal } from "./delivery.js";
import { authenticateAutomaticDevice } from "./enrollment.js";
import { deviceBearer, digest, matchesToken } from "./security.js";
import { allValues, deviceIdentifier, getJson, getMany, HttpError, identifier, isAutomaticDeviceId, isRecord, keys, listValues, object, putJson, text } from "./store.js";
import { deviceEventTypes, renderMessage } from "./templates.js";
import { getRetentionPolicy } from "./retention.js";

export const SCHEDULER_DEVICE = "scheduler";
export const MAX_EVENT_BYTES = 24 * 1024;

function eventTime(value) {
  if (value == null) return null;
  let milliseconds;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 253402300799) {
    milliseconds = value * 1000;
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    milliseconds = Date.parse(value);
  }
  if (!Number.isFinite(milliseconds)) throw new HttpError(400, "事件时间须为 Unix 秒或带时区的 ISO 时间");
  return new Date(milliseconds).toISOString();
}

function validateData(value, depth = 0) {
  if (depth > 8) throw new HttpError(400, "事件字段层级过深");
  if (Array.isArray(value)) {
    if (value.length > 64) throw new HttpError(400, "事件字段项数过多");
    for (const item of value) validateData(item, depth + 1);
  } else if (isRecord(value)) {
    for (const [name, item] of Object.entries(value)) {
      if (name.length > 64 || ["constructor", "__proto__", "prototype"].includes(name)) {
        throw new HttpError(400, "事件包含无效字段名");
      }
      validateData(item, depth + 1);
    }
  } else if (typeof value === "number" && !Number.isFinite(value)) {
    throw new HttpError(400, "事件包含无效数值");
  }
}

export function normalizeEvent(input) {
  if (input.version !== 1) throw new HttpError(400, "仅支持版本 1 的事件协议");
  const device_id = deviceIdentifier(input.device_id);
  const event_id = identifier(input.event_id, "事件标识");
  const type = input.type;
  if (!deviceEventTypes.has(type)) throw new HttpError(400, "事件类型无效");
  const data = object(input.data, "事件数据");
  const status = input.status == null ? {} : object(input.status, "设备状态");
  validateData(data);
  validateData(status);
  if (type === "sms.received") {
    text(data.sender, "发件号码", { max: 80 });
    if (typeof data.content !== "string") throw new HttpError(400, "短信正文须为文字");
  }
  if (type.startsWith("call.")) text(data.number, "通话号码", { max: 80 });
  return { version: 1, device_id, event_id, type, occurred_at: eventTime(input.occurred_at), data, status };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function authenticateDevice(request, env, deviceId) {
  const token = deviceBearer(request);
  if (!token || deviceId === SCHEDULER_DEVICE) throw new HttpError(401, "设备令牌无效");
  if (isAutomaticDeviceId(deviceId)) return authenticateAutomaticDevice(env, deviceId, token);
  const records = await getMany(dataStore(env), [keys.device(deviceId), keys.deviceToken(deviceId)]);
  const device = records.get(keys.device(deviceId));
  if (!device || !await matchesToken(token, records.get(keys.deviceToken(deviceId))?.hash)) {
    throw new HttpError(401, "设备令牌无效");
  }
  if (!device.enabled) throw new HttpError(403, "设备已停用");
  return device;
}

function ruleMatches(rule, event) {
  if (!rule.enabled) return false;
  if (rule.device_ids.length && !rule.device_ids.includes(event.device_id)) return false;
  if (rule.event_types.length && !rule.event_types.includes(event.type)) return false;
  const sender = String(event.data.sender ?? event.data.number ?? "").toLowerCase();
  const content = String(event.data.content ?? event.data.text ?? "").toLowerCase();
  return sender.includes(rule.sender_contains.toLowerCase()) && content.includes(rule.content_contains.toLowerCase());
}

export async function makeRoutes(kv, selections, event) {
  const eventTemplateKey = keys.eventTemplate(event.type);
  const configKeys = new Set([eventTemplateKey]);
  for (const selection of selections) {
    if (selection.template_id) configKeys.add(keys.template(selection.template_id));
    for (const id of selection.channel_ids) configKeys.add(keys.channel(id));
  }
  const configs = await getMany(kv, [...configKeys]);
  const routes = new Map();
  for (const selection of selections) {
    const customTemplate = selection.template_id ? configs.get(keys.template(selection.template_id)) : undefined;
    const template = customTemplate ?? selection.message_template ?? configs.get(eventTemplateKey);
    const message = renderMessage(template, event);
    for (const channelId of selection.channel_ids) {
      const channel = configs.get(keys.channel(channelId));
      if (channel?.enabled && !routes.has(channelId)) {
        routes.set(channelId, { channel_id: channelId, channel_name: channel.name, message });
      }
    }
  }
  return [...routes.values()];
}

async function deviceRoutes(kv, event) {
  const rules = await allValues(kv, "rules:");
  const matches = rules.filter((rule) => ruleMatches(rule, event))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return makeRoutes(kv, matches, event);
}

export async function ensurePending(kv, event) {
  const key = keys.pending(event.device_id, event.event_id);
  if (await getJson(kv, key)) return false;
  await putJson(kv, key, { device_id: event.device_id, event_id: event.event_id }, event.expires_at);
  return true;
}

async function indexEvent(kv, item, eventKey, created) {
  const newestFirst = String(9999999999999 - Date.parse(item.received_at)).padStart(13, "0");
  const key = `timeline:${newestFirst}:${item.device_id}:${item.event_id}`;
  if (created || !await getJson(kv, key)) {
    await putJson(kv, key, { eventKey, device_id: item.device_id, type: item.type, received_at: item.received_at }, item.expires_at);
  }
}

export async function listEvents(kv, { device, type, ...pageOptions }) {
  if (kv.listEvents) return kv.listEvents({ device, type, ...pageOptions });
  const page = await listValues(kv, "timeline:", pageOptions);
  const matches = page.items.filter((entry) => (!device || entry.device_id === device) && (!type || entry.type === type));
  const values = await getMany(kv, matches.map((entry) => entry.eventKey));
  const items = [];
  for (const entry of matches) {
    const event = values.get(entry.eventKey);
    if (event && event.received_at === entry.received_at) items.push(event);
  }
  return { items, cursor: page.cursor };
}

export async function recordEvent(env, event, routesFor, { fingerprint, now = Date.now() } = {}) {
  const kv = dataStore(env);
  const key = keys.event(event.device_id, event.event_id);
  let existing = await getJson(kv, key);
  if (!kv.createEvent && existing && fingerprint && existing.fingerprint !== fingerprint) {
    throw new HttpError(409, "该事件标识已用于另一条记录");
  }
  let item = existing;
  let created = !existing;
  const policy = await getRetentionPolicy(env);
  if (!item) {
    item = {
      ...event,
      fingerprint,
      received_at: new Date(now).toISOString(),
      expires_at: Math.floor(now / 1000) + policy.event_days * 86400,
    };
    item.routes = await routesFor(item);
  }
  if (kv.createEvent) {
    // Even a live read can race cleanup. The authoritative receipt/parent check
    // decides whether this ID still exists, and a cleared ID is an ACK-only no-op.
    const saved = await kv.createEvent({ ...item, fingerprint: fingerprint ?? item.fingerprint }, { eventDays: policy.event_days });
    item = saved.item;
    created = saved.created;
    if (saved.cleared) return { item, created: false, dispatch: false, cleared: true };
    existing = created ? null : item;
  } else if (created) {
    await putJson(kv, key, item, item.expires_at);
  }
  await indexEvent(kv, item, key, created);
  if (item.routes.length === 0) return { item, created, dispatch: false };
  if (existing && await getJson(kv, keys.pending(event.device_id, event.event_id))) {
    return { item, created: false, dispatch: false };
  }
  const needsDelivery = !existing || (await deliveryStates(kv, item)).some((state) => !isTerminal(state));
  const dispatch = needsDelivery && await ensurePending(kv, item);
  return { item, created, dispatch };
}

export function acceptDeviceEvent(env, event, device, now = Date.now(), { recovered = false } = {}) {
  // Recovery is transport metadata, not event content or fingerprint input. Routes
  // are chosen only for a newly-created record; a replay cannot change old routes.
  return digest(canonicalJson(event)).then((fingerprint) => recordEvent(env, { ...event, device_name: device.name },
    (saved) => recovered && saved.type === "device.boot" ? [] : deviceRoutes(dataStore(env), saved), { fingerprint, now }));
}

export async function updateDeviceStatus(kv, event) {
  if (!event || event.cleared || event.suppressed || !event.received_at) return;
  if (kv.updateLatestStatus) return kv.updateLatestStatus(event.device_id, event);
  const key = keys.latest(event.device_id);
  const latest = await getJson(kv, key);
  if (latest?.last_seen >= event.received_at) return;
  await putJson(kv, key, {
    ...latest,
    last_seen: event.received_at,
    last_event_type: event.type,
    status: { ...latest?.status, ...event.status },
  });
}

function deliveryStatus(states) {
  if (states.length === 0) return "unrouted";
  if (states.some((state) => !isTerminal(state))) return "pending";
  const shipped = states.filter((state) => state.state === "sent").length;
  if (shipped === states.length) return "delivered";
  return shipped > 0 ? "mixed" : "failed";
}

export async function presentEvent(kv, event) {
  const { routes, fingerprint, ...fields } = event;
  const deliveries = await deliveryStates(kv, event);
  return { ...fields, delivery_status: deliveryStatus(deliveries), deliveries };
}
