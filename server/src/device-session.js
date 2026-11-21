import { disconnectDeviceSockets, handleDeviceClose, handleDeviceMessage, openDeviceSocket, pushQueuedCommand, refreshConnectionPresence, runPresenceAlarm } from "./realtime.js";
import { deviceIdentifier, HttpError, isRecord, jsonResponse } from "./store.js";

async function exclusiveOperation(state, operation) {
  // A rejected blockConcurrencyWhile callback resets the DO and closes existing
  // sockets. An ordinary D1/authentication failure must leave the previous,
  // unchanged session intact, so propagate it only after releasing the gate.
  const result = await state.blockConcurrencyWhile(async () => {
    try { return { value: await operation() }; } catch (error) { return { error }; }
  });
  if (Object.prototype.hasOwnProperty.call(result, "error")) throw result.error;
  return result.value;
}

export class DeviceSession {
  constructor(state, env) {
    // Hibernation resumes authenticated socket attachments. Durable activation
    // belongs only to a fresh upgrade, never to reconstruction of this object.
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return await exclusiveOperation(this.state, () => openDeviceSocket(this.state, this.env, request));
      }
      if (request.method !== "POST") throw new HttpError(405, "会话接口不支持该请求方法");
      const input = await request.json();
      if (!isRecord(input)) throw new HttpError(400, "会话消息无效");
      return await exclusiveOperation(this.state, async () => {
        if (input.action === "nudge") return jsonResponse(await pushQueuedCommand(this.state, this.env, input.device_id));
        if (input.action === "presence") {
          const deviceId = deviceIdentifier(input.device_id);
          const savedId = await this.state.storage.get("presence-device-id");
          if (savedId != null && savedId !== deviceId) throw new HttpError(404, "设备会话不存在");
          await this.state.storage.put("presence-device-id", deviceId);
          if (input.now !== undefined && (!Number.isSafeInteger(input.now) || input.now < 0)) throw new HttpError(400, "心跳检查时间无效");
          return jsonResponse({ ok: true, connection: await refreshConnectionPresence(this.state, this.env, deviceId, input.now ?? Date.now()) });
        }
        if (input.action === "disconnect") return disconnectDeviceSockets(this.state, this.env);
        return jsonResponse({ ok: false, error: "会话操作不存在" }, 404);
      });
    } catch (error) {
      if (error instanceof HttpError) return jsonResponse({ ok: false, error: error.message }, error.status);
      return jsonResponse({ ok: false, error: "服务暂不可用，请稍后重试" }, 503);
    }
  }

  webSocketMessage(socket, message) {
    return handleDeviceMessage(this.state, this.env, socket, message);
  }

  webSocketClose(socket) {
    return handleDeviceClose(this.state, this.env, socket);
  }

  webSocketError(socket) {
    return handleDeviceClose(this.state, this.env, socket);
  }

  alarm() {
    return exclusiveOperation(this.state, () => runPresenceAlarm(this.state, this.env));
  }
}
