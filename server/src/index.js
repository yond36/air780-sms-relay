import { adminRoute } from "./admin.js";
import { dataStore } from "./db.js";
import { dispatchEvent, sweepPending } from "./delivery.js";
import { registerDevice } from "./enrollment.js";
import { authenticateDevice, MAX_EVENT_BYTES, normalizeEvent, updateDeviceStatus } from "./events.js";
import { acceptIncoming } from "./ingest.js";
import { connectDevice, notifyDeviceCommands } from "./realtime.js";
import { expireSms, recordSmsResult } from "./sms.js";
import { RETRY_CRON, runScheduledJobs, SCHEDULE_CRON } from "./scheduler.js";
import { expireCleanupPreviews, reconcileRetention } from "./retention.js";
import { deviceIdentifier, HttpError, jsonResponse, readBody } from "./store.js";

export { DeviceSession } from "./device-session.js";

export function runtimeEnvironment(env) {
  if (env.DATA) return env;
  return { ...env, DATA: dataStore(env) };
}

async function ingest(request, env, ctx) {
  if (request.method !== "POST") throw new HttpError(405, "请使用 POST 上报事件");
  const input = await readBody(request, MAX_EVENT_BYTES);
  const event = normalizeEvent(input);
  const device = await authenticateDevice(request, env, event.device_id);
  const { item, created, dispatch } = await acceptIncoming(env, event, device);
  const background = [updateDeviceStatus(dataStore(env), item)];
  if (dispatch) background.push(dispatchEvent(env, item));
  ctx.waitUntil(Promise.allSettled(background));
  return jsonResponse({ ok: true, accepted: true, event_id: event.event_id }, created ? 202 : 200);
}

async function commandResult(request, env, ctx) {
  if (request.method !== "POST") throw new HttpError(405, "请使用 POST 回报命令结果");
  const body = await readBody(request, 2048);
  const id = deviceIdentifier(body.device_id);
  await authenticateDevice(request, env, id);
  await recordSmsResult(env, id, body);
  ctx.waitUntil(notifyDeviceCommands(env, id));
  return jsonResponse({ ok: true, accepted: true, command_id: body.command_id });
}

export default {
  async fetch(request, rawEnv, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/v1/health" && request.method === "GET") return jsonResponse({ ok: true });
      if (url.pathname.startsWith("/api/")) {
        const env = runtimeEnvironment(rawEnv);
        if (url.pathname === "/api/v1/events") return await ingest(request, env, ctx);
        if (url.pathname === "/api/v1/devices/register") return await registerDevice(request, env);
        if (url.pathname === "/api/v1/device/ws") return await connectDevice(request, env);
        if (url.pathname === "/api/v1/device/command-results") return await commandResult(request, env, ctx);
        if (url.pathname.startsWith("/api/v1/admin/")) {
          const parts = url.pathname.slice("/api/v1/admin/".length).split("/").filter(Boolean);
          return await adminRoute(request, url, env, parts);
        }
        throw new HttpError(404, "接口不存在");
      }
      return rawEnv.ASSETS ? await rawEnv.ASSETS.fetch(request) : new Response("未绑定管理页资源", { status: 404 });
    } catch (error) {
      if (error instanceof HttpError) return jsonResponse({ ok: false, error: error.message }, error.status);
      console.error("Worker 操作暂未完成");
      return jsonResponse({ ok: false, error: "服务暂不可用，请稍后重试" }, 503);
    }
  },

  async scheduled(controller, rawEnv) {
    const env = runtimeEnvironment(rawEnv);
    if (controller.cron === RETRY_CRON) {
      if (dataStore(env).isD1) await reconcileRetention(env);
      await sweepPending(env);
      if (dataStore(env).isD1) {
        await expireSms(env);
        await dataStore(env).cleanup();
        await expireCleanupPreviews(env);
      }
    } else if (controller.cron === SCHEDULE_CRON || !controller.cron) {
      const jobs = await runScheduledJobs(env, controller.scheduledTime);
      let limit = 8;
      for (const { item, dispatch } of jobs) {
        if (dispatch && limit > 0) limit -= await dispatchEvent(env, item, { limit });
      }
    }
  },
};
