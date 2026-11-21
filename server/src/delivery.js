import { sendChannel } from "./channels.js";
import { dataStore } from "./db.js";
import { openConfig } from "./security.js";
import { getJson, getMany, HttpError, keys, putJson } from "./store.js";

const MAX_ATTEMPTS = 7;
const MAX_SWEEP_ATTEMPTS = 8;
const SWEEP_PAGE_SIZE = 12;
const CURSOR_KEY = "maintenance:pending-cursor";

export const isTerminal = ({ state }) => state === "sent" || state === "failed";

export async function deliveryStates(kv, event) {
  const { device_id, event_id, routes } = event;
  const names = routes.flatMap(({ channel_id }) => [keys.sent(device_id, event_id, channel_id), keys.delivery(device_id, event_id, channel_id)]);
  const values = await getMany(kv, names);
  return routes.map(({ channel_id, channel_name }) => {
    const last = values.get(keys.sent(device_id, event_id, channel_id)) ?? values.get(keys.delivery(device_id, event_id, channel_id));
    return { channel_id, channel_name, state: "pending", attempts: 0, ...last };
  });
}

function retryDelay(failures, retryAfterMs) {
  const exponential = Math.min(60 * 60_000, 30_000 * 2 ** (failures - 1));
  const serverDelay = Number.isFinite(retryAfterMs) ? Math.min(24 * 60 * 60_000, retryAfterMs) : 0;
  return Math.max(exponential + Math.floor(exponential * Math.random() / 5), serverDelay);
}

async function sendRoute(env, event, route, now) {
  const kv = dataStore(env);
  const channel = await getJson(kv, keys.channel(route.channel_id));
  if (!channel?.enabled) return { ok: false, retryable: false, error: channel ? "渠道已停用" : "渠道已移除" };
  let config;
  try {
    config = await openConfig(env, channel.id, channel.type, channel.sealed_config);
  } catch {
    return { ok: false, retryable: true, error: "渠道凭据暂不可用" };
  }
  return sendChannel(channel.type, config, route.message, {
    env, deliveryId: `${event.device_id}.${event.event_id}.${route.channel_id}`, now,
  });
}

async function attempt(env, event, route, previous, now) {
  const result = await sendRoute(env, event, route, now);
  const updatedAt = now();
  const kv = dataStore(env);
  const updated = {
    attempts: previous.attempts + 1,
    updated_at: new Date(updatedAt).toISOString(),
    ...(Number.isInteger(result.status) ? { status: result.status } : {}),
    ...(result.code ? { code: result.code } : {}),
  };
  if (result.ok) {
    updated.state = "sent";
    // A concurrent failed attempt cannot overwrite a successful marker.
    await putJson(kv, keys.sent(event.device_id, event.event_id, route.channel_id), updated, event.expires_at);
    return updated;
  }
  updated.failures = (previous.failures ?? 0) + 1;
  const retryAt = updatedAt + retryDelay(updated.failures, result.retryAfterMs);
  const canRetry = result.retryable && updated.failures < MAX_ATTEMPTS && retryAt < event.expires_at * 1000;
  updated.state = canRetry ? "retry" : "failed";
  updated.error = result.error ?? "渠道发送失败";
  if (canRetry) updated.retry_at = new Date(retryAt).toISOString();
  await putJson(kv, keys.delivery(event.device_id, event.event_id, route.channel_id), updated, event.expires_at);
  return updated;
}

async function attemptSafely(env, event, route, previous, now) {
  const store = dataStore(env);
  if (!store.claimDelivery) return attempt(env, event, route, previous, now);
  const owner = await store.claimDelivery(event.device_id, event.event_id, route.channel_id, event.expires_at, now());
  if (!owner) return null;
  try {
    const sentKey = keys.sent(event.device_id, event.event_id, route.channel_id);
    const resultKey = keys.delivery(event.device_id, event.event_id, route.channel_id);
    const current = await getMany(store, [sentKey, resultKey]);
    const status = current.get(sentKey) || current.get(resultKey);
    if (status && (isTerminal(status) || (status.retry_at && Date.parse(status.retry_at) > now()))) return status;
    return await attempt(env, event, route, { ...previous, ...status }, now);
  } finally {
    await store.releaseDelivery(event.device_id, event.event_id, route.channel_id, owner);
  }
}

export async function dispatchEvent(env, event, { now = Date.now, limit = MAX_SWEEP_ATTEMPTS } = {}) {
  if (!event || event.cleared || event.expires_at * 1000 <= now()) return 0;
  const kv = dataStore(env);
  const states = await deliveryStates(kv, event);
  const due = states.map((state, index) => ({ state, index })).filter(({ state }) =>
    !isTerminal(state) && (!state.retry_at || Date.parse(state.retry_at) <= now())).slice(0, limit);
  const results = await Promise.allSettled(due.map(({ state, index }) => attemptSafely(env, event, event.routes[index], state, now)));
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled" && result.value) states[due[index].index] = result.value;
  }
  if (states.every(isTerminal)) await kv.delete(keys.pending(event.device_id, event.event_id));
  return due.length;
}

export async function rescheduleDelivery(kv, event, channelId, now = Date.now()) {
  const state = (await deliveryStates(kv, event)).find((entry) => entry.channel_id === channelId);
  if (!state) throw new HttpError(404, "这条事件没有该渠道的投递记录");
  if (state.state === "sent") throw new HttpError(409, "该渠道已送达");
  if (state.state !== "pending") {
    await putJson(kv, keys.delivery(event.device_id, event.event_id, channelId), {
      state: "retry",
      attempts: state.attempts,
      failures: 0,
      updated_at: new Date(now).toISOString(),
      retry_at: new Date(now + 2000).toISOString(),
    }, event.expires_at);
  }
  await putJson(kv, keys.pending(event.device_id, event.event_id), {
    device_id: event.device_id, event_id: event.event_id,
  }, event.expires_at);
}

export async function sweepPending(env, now = Date.now) {
  const kv = dataStore(env);
  const cursor = await getJson(kv, CURSOR_KEY);
  const page = await kv.list({ prefix: "pending:", limit: SWEEP_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
  let remaining = MAX_SWEEP_ATTEMPTS;
  for (const pending of page.keys) {
    const [, deviceId, eventId] = pending.name.split(":");
    const event = await getJson(kv, keys.event(deviceId, eventId));
    if (!event) continue;
    try {
      const count = await dispatchEvent(env, event, { now, limit: remaining });
      remaining -= count;
    } catch {
      // Leave this record available for a later sweep.
    }
  }
  if (!page.list_complete) await putJson(kv, CURSOR_KEY, page.cursor);
  else if (cursor) await kv.delete(CURSOR_KEY);
}
