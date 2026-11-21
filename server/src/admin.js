import { channelTypes, sendChannel, validateChannelConfig } from "./channels.js";
import { dataStore } from "./db.js";
import { getSms, listSms, queueSms } from "./sms.js";
import { closeDeviceConnection, notifyDeviceCommands, refreshDevicePresence } from "./realtime.js";
import { rescheduleDelivery } from "./delivery.js";
import { deviceRegistry, hardwareIdentity } from "./enrollment.js";
import { getRetentionPolicy, saveRetentionPolicy, previewCleanup, executeCleanup } from "./retention.js";
import { listEvents, presentEvent, SCHEDULER_DEVICE } from "./events.js";
import { deviceSnapshots, normalizeJob } from "./scheduler.js";
import { authenticateAdmin, digest, newSession, newToken, openConfig, requireAdmin, requireSameOrigin, sealConfig, sessionCookie } from "./security.js";
import { deviceIdentifier, enabled, getJson, getMany, HttpError, identifier, idList, isAutomaticDeviceId, jsonResponse, keys, listValues, object, putJson, readBody, text, validDeviceId } from "./store.js";
import { deviceEventTypes, eventTypes, getEventTemplates, normalizeTemplate, renderMessage, sampleEvent, templateVariables } from "./templates.js";

const MAX_ADMIN_BYTES = 32 * 1024;

async function storageStatus(env) {
  const session = dataStore(env).session();
  const tables = ["relay_records", "device_registry", "sms_messages", "sms_commands"];
  const counts = await Promise.all(tables.map((table) => session.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()));
  return jsonResponse({ ok: true, mode: "d1", counts: Object.fromEntries(tables.map((table, index) => [table, counts[index].count])) });
}

const resources = {
  devices: keys.device,
  channels: keys.channel,
  templates: keys.template,
  rules: keys.rule,
  jobs: keys.job,
};

function pageOptions(url, limit) {
  const cursor = url.searchParams.get("cursor") || undefined;
  if (cursor && cursor.length > 4096) throw new HttpError(400, "分页标识无效");
  return { cursor, limit };
}

async function publicChannel(env, record) {
  const config = await openConfig(env, record.id, record.type, record.sealed_config);
  const fields = channelTypes[record.type]?.fields ?? [];
  const { sealed_config, ...channel } = record;
  return {
    ...channel,
    config: Object.fromEntries(fields.filter(({ key, secret }) => !secret && Object.hasOwn(config, key)).map(({ key }) => [key, config[key]])),
    secret_fields: fields.filter(({ key, secret }) => secret && config[key] != null && config[key] !== "").map(({ key }) => key),
  };
}

async function issueDeviceToken(kv, id) {
  const token = newToken();
  await putJson(kv, keys.deviceToken(id), { hash: await digest(token) });
  return token;
}

async function channelConfiguration(env, input, id, current) {
  const type = input.type;
  if (typeof type !== "string" || !Object.hasOwn(channelTypes, type)) throw new HttpError(400, "请选择支持的渠道类型");
  const submitted = object(input.config, "渠道配置");
  const config = { ...submitted };
  if (current?.type === type) {
    const previous = await openConfig(env, id, type, current.sealed_config);
    for (const { key, secret } of channelTypes[type].fields) {
      if (secret && (!Object.hasOwn(config, key) || config[key] === "") && Object.hasOwn(previous, key)) {
        config[key] = previous[key];
      } else if (secret && config[key] === null) {
        delete config[key];
      }
    }
  }
  let normalized;
  try {
    normalized = validateChannelConfig(type, config);
  } catch (error) {
    throw new HttpError(400, error.message ?? "渠道配置无效");
  }
  return { type, sealed_config: await sealConfig(env, id, type, normalized) };
}

async function checkReferences(kv, { device_ids, template_id, channel_ids }) {
  const names = [
    ...device_ids.map(keys.device),
    ...channel_ids.map(keys.channel),
    ...(template_id ? [keys.template(template_id)] : []),
  ];
  const values = await getMany(kv, names);
  if (names.some((name) => !values.get(name))) throw new HttpError(400, "部分设备、模板或渠道不存在，请刷新后重新选择");
}

function normalizeRule(input) {
  const event_types = idList(input.event_types, "事件类型");
  if (event_types.some((type) => !deviceEventTypes.has(type))) throw new HttpError(400, "转发规则须选择设备事件类型");
  const priority = input.priority ?? 100;
  if (!Number.isInteger(priority) || Math.abs(priority) > 10000) throw new HttpError(400, "优先级须为 -10000 到 10000 的整数");
  return {
    name: text(input.name, "规则名称", { required: true }),
    enabled: enabled(input.enabled),
    priority,
    event_types,
    device_ids: idList(input.device_ids, "设备", { max: 100, validate: validDeviceId }),
    sender_contains: text(input.sender_contains, "号码关键词", { max: 80 }),
    content_contains: text(input.content_contains, "正文关键词", { max: 256 }),
    template_id: input.template_id ? identifier(input.template_id, "模板标识") : "",
    channel_ids: idList(input.channel_ids, "渠道", { required: true }),
  };
}

async function normalizeResource(env, resource, input, id, current) {
  if (resource === "jobs" || resource === "rules") {
    const item = resource === "jobs" ? normalizeJob(input) : normalizeRule(input);
    await checkReferences(dataStore(env), item);
    return item;
  }
  const name = text(input.name, "名称", { required: true });
  if (resource === "templates") return { name, ...normalizeTemplate(input) };
  const item = { name, enabled: enabled(input.enabled) };
  if (resource === "channels") Object.assign(item, await channelConfiguration(env, input, id, current));
  return item;
}

async function presentResource(env, resource, items) {
  if (resource === "devices") return refreshDevicePresence(env, await deviceSnapshots(dataStore(env), items));
  if (resource === "channels") return Promise.all(items.map((item) => publicChannel(env, item)));
  return items;
}

async function automaticDeviceRoute(request, env, id, action) {
  if (action === "provision" && request.method === "POST") {
    const input = object(await readBody(request, MAX_ADMIN_BYTES));
    if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0
      || typeof input.hash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.hash)) {
      throw new HttpError(400, "请提供有效的凭据版本与新凭据摘要");
    }
    const identity = hardwareIdentity(input);
    const expectedId = `auto~${await digest(`${identity.identity_type}:${identity.identity_value}`)}`;
    if (expectedId !== id) throw new HttpError(409, "配置身份与原设备不匹配");
    const store = dataStore(env);
    const current = await store.getDeviceRecord(id);
    if (!current || current.deleted) throw new HttpError(404, "设备不存在");
    if (current.device.identity_type !== identity.identity_type || current.device.identity_value !== identity.identity_value) {
      throw new HttpError(409, "配置身份与登记记录不匹配");
    }
    const record = await store.provisionDeviceRecord(id, { expectedVersion: input.expected_version, hash: input.hash });
    await closeDeviceConnection(env, id);
    return jsonResponse({ ok: true, credential_version: record.credentialVersion });
  }
  let command;
  if (action === "rebind" && request.method === "POST") {
    command = { action: "rebind" };
  } else if (action) {
    throw new HttpError(404, "接口不存在");
  } else if (request.method === "GET") {
    command = { action: "get" };
  } else if (request.method === "PUT") {
    const input = await readBody(request, MAX_ADMIN_BYTES);
    command = { action: "update", ...await normalizeResource(env, "devices", input, id) };
  } else if (request.method === "DELETE") {
    await deviceRegistry(env, id, { action: "delete" });
    return jsonResponse({ ok: true });
  } else {
    throw new HttpError(405, "此接口不支持该请求方法");
  }
  const { item: record } = await deviceRegistry(env, id, command);
  const [item] = await deviceSnapshots(dataStore(env), [record]);
  const [fresh] = await refreshDevicePresence(env, [item]);
  return jsonResponse({ item: fresh });
}

async function resourceRoute(request, url, env, resource, id, action) {
  const kv = dataStore(env);
  const keyFor = resources[resource];
  if (!id && request.method === "GET") {
    const page = await listValues(kv, `${resource}:`, pageOptions(url, 30));
    return jsonResponse({ items: await presentResource(env, resource, page.items), cursor: page.cursor });
  }
  if (!id && request.method === "POST") {
    const input = await readBody(request, MAX_ADMIN_BYTES);
    const newId = resource === "devices" ? identifier(input.id, "设备标识") : crypto.randomUUID();
    if (newId === SCHEDULER_DEVICE) throw new HttpError(400, "该标识保留给计划任务");
    if (await getJson(kv, keyFor(newId))) throw new HttpError(409, "该标识已存在");
    const now = new Date().toISOString();
    const record = { id: newId, ...await normalizeResource(env, resource, input, newId), created_at: now, updated_at: now };
    await putJson(kv, keyFor(newId), record);
    const token = resource === "devices" ? await issueDeviceToken(kv, newId) : undefined;
    const [item] = await presentResource(env, resource, [record]);
    return jsonResponse({ item, token }, 201);
  }
  if (!id) throw new HttpError(405, "此接口不支持该请求方法");
  if (resource === "devices" && isAutomaticDeviceId(id)) return automaticDeviceRoute(request, env, id, action);
  identifier(id, "记录标识");
  const current = await getJson(kv, keyFor(id));
  if (!current) throw new HttpError(404, "记录不存在");
  if (action === "rotate-token" && resource === "devices" && request.method === "POST") {
    const token = await issueDeviceToken(kv, id);
    await closeDeviceConnection(env, id);
    const [item] = await presentResource(env, resource, [current]);
    return jsonResponse({ item, token });
  }
  if (action === "test" && resource === "channels" && request.method === "POST") {
    const input = await readBody(request, MAX_ADMIN_BYTES);
    const title = text(input.title, "标题", { max: 256, trim: false }) || "短信转发测试通知";
    const body = text(input.body, "正文", { max: 4096, trim: false }) || "渠道配置测试";
    const config = await openConfig(env, id, current.type, current.sealed_config);
    const result = await sendChannel(current.type, config, { title, body }, { env, deliveryId: crypto.randomUUID(), now: Date.now });
    if (!result.ok) throw new HttpError(502, result.error ?? "测试推送失败");
    return jsonResponse({ ok: true });
  }
  if (action) throw new HttpError(404, "接口不存在");
  if (request.method === "GET") {
    const [item] = await presentResource(env, resource, [current]);
    return jsonResponse({ item });
  }
  if (request.method === "PUT") {
    const input = await readBody(request, MAX_ADMIN_BYTES);
    const record = { id, ...await normalizeResource(env, resource, input, id, current), created_at: current.created_at, updated_at: new Date().toISOString() };
    await putJson(kv, keyFor(id), record);
    if (resource === "devices" && !record.enabled) await closeDeviceConnection(env, id);
    const [item] = await presentResource(env, resource, [record]);
    return jsonResponse({ item });
  }
  if (request.method === "DELETE") {
    await kv.delete(keyFor(id));
    if (resource === "devices") {
      await closeDeviceConnection(env, id);
      await Promise.all([kv.delete(keys.deviceToken(id)), kv.delete(keys.latest(id))]);
    }
    return jsonResponse({ ok: true });
  }
  throw new HttpError(405, "此接口不支持该请求方法");
}

async function eventTemplateRoute(request, env, type) {
  if (type && !eventTypes.some(({ id }) => id === type)) throw new HttpError(404, "事件类型不存在");
  if (request.method !== "GET" && (!type || !["PUT", "DELETE"].includes(request.method))) {
    throw new HttpError(405, "此接口不支持该请求方法");
  }
  const kv = dataStore(env);
  if (request.method === "PUT") {
    const template = normalizeTemplate(await readBody(request, MAX_ADMIN_BYTES));
    await putJson(kv, keys.eventTemplate(type), template);
  } else if (request.method === "DELETE") {
    await kv.delete(keys.eventTemplate(type));
  }
  const items = await getEventTemplates(kv, type);
  return jsonResponse(type ? { item: items[0] } : { items });
}

async function smsRoute(request, url, env, id, action) {
  if (!id && request.method === "GET") return jsonResponse(await listSms(env, url.searchParams));
  if (id && !action && request.method === "GET") return jsonResponse({ item: await getSms(env, id) });
  if (request.method === "POST" && (!id || action === "reply")) {
    const body = await readBody(request, MAX_ADMIN_BYTES);
    const result = await queueSms(env, body, id);
    await notifyDeviceCommands(env, result.item.device_id);
    return jsonResponse(result, 202);
  }
  throw new HttpError(405, "短信接口不支持该请求方法");
}

async function eventRoute(request, url, kv, deviceId, eventId, action) {
  if (!deviceId && request.method === "GET") {
    const device = url.searchParams.get("device_id");
    if (device) deviceIdentifier(device);
    const type = url.searchParams.get("type");
    if (type && !eventTypes.some(({ id }) => id === type)) throw new HttpError(400, "事件类型无效");
    const page = await listEvents(kv, { device, type, ...pageOptions(url, 16) });
    return jsonResponse({ items: await Promise.all(page.items.map((event) => presentEvent(kv, event))), cursor: page.cursor });
  }
  if (!deviceId || !eventId) throw new HttpError(404, "事件不存在");
  deviceIdentifier(deviceId);
  identifier(eventId, "事件标识");
  const event = await getJson(kv, keys.event(deviceId, eventId));
  if (!event) throw new HttpError(404, "事件不存在或已过保留期");
  if (action === "retry" && request.method === "POST") {
    const input = await readBody(request, MAX_ADMIN_BYTES);
    await rescheduleDelivery(kv, event, identifier(input.channel_id, "渠道标识"));
    return jsonResponse({ ok: true }, 202);
  }
  if (!action && request.method === "GET") return jsonResponse({ item: await presentEvent(kv, event) });
  throw new HttpError(405, "此接口不支持该请求方法");
}

export async function adminRoute(request, url, env, parts) {
  const [resource, id, action, eventAction, ...extra] = parts;
  requireSameOrigin(request);
  if (resource === "login" && parts.length === 1 && request.method === "POST") {
    const input = await readBody(request, MAX_ADMIN_BYTES);
    await authenticateAdmin(env, text(input.password, "管理员密码", { max: 1024, trim: false, required: true }));
    const token = await newSession(env);
    return jsonResponse({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, token) });
  }
  if (resource === "logout" && parts.length === 1 && request.method === "POST") {
    return jsonResponse({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, "") });
  }
  await requireAdmin(request, env);
  if (resource === "retention" && parts.length === 1) {
    if (request.method === "GET") return jsonResponse(await getRetentionPolicy(env));
    if (request.method === "PUT") return jsonResponse(await saveRetentionPolicy(env, await readBody(request, MAX_ADMIN_BYTES)));
    throw new HttpError(405, "此接口不支持该请求方法");
  }
  if (resource === "history" && parts.length === 2 && ["preview", "cleanup"].includes(id)) {
    if (request.method !== "POST") throw new HttpError(405, "请使用 POST");
    const input = await readBody(request, MAX_ADMIN_BYTES);
    return jsonResponse(await (id === "preview" ? previewCleanup(env, input) : executeCleanup(env, input)));
  }
  if (resource === "storage" && id === "status" && parts.length === 2 && request.method === "GET") return storageStatus(env);
  if (resource === "sms" && parts.length <= 3) return smsRoute(request, url, env, id, action);
  if (resource === "event-templates" && parts.length <= 2) return eventTemplateRoute(request, env, id);
  if (resource === "meta" && parts.length === 1 && request.method === "GET") {
    return jsonResponse({ channel_types: channelTypes, event_types: eventTypes, template_variables: templateVariables });
  }
  if (resource === "templates" && id === "preview" && parts.length === 2 && request.method === "POST") {
    const input = await readBody(request, MAX_ADMIN_BYTES);
    const template = normalizeTemplate(input, { preview: true });
    return jsonResponse(renderMessage(template, sampleEvent(input.type)));
  }
  if (resource === "events" && extra.length === 0) return eventRoute(request, url, dataStore(env), id, action, eventAction);
  if (Object.hasOwn(resources, resource) && parts.length <= 3) return resourceRoute(request, url, env, resource, id, action);
  throw new HttpError(404, "接口不存在");
}
