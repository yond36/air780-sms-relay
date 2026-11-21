import { acceptDeviceEvent, normalizeEvent } from "./events.js";
import { archiveSms } from "./sms.js";
import { dataStore } from "./db.js";
import { HttpError } from "./store.js";

export async function acceptIncoming(env, input, device, { recovered = false } = {}) {
  if (typeof recovered !== "boolean") throw new HttpError(400, "恢复标识须为布尔值");
  const event = normalizeEvent(input);
  if (event.device_id !== device.id) throw new HttpError(403, "事件与当前设备不匹配");
  const accepted = await acceptDeviceEvent(env, event, device, Date.now(), { recovered });
  if (dataStore(env).isD1 && !accepted.cleared) await archiveSms(env, accepted.item);
  return accepted;
}
