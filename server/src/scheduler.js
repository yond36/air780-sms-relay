import { dataStore } from "./db.js";
import { makeRoutes, recordEvent, SCHEDULER_DEVICE } from "./events.js";
import { allValues, enabled, getMany, HttpError, idList, identifier, keys, object, text, validDeviceId } from "./store.js";
import { normalizeTemplate, renderMessage, statusText } from "./templates.js";

export const SCHEDULE_CRON = "*/5 * * * *";
export const RETRY_CRON = "2-59/5 * * * *";
const MINUTE = 60_000;
const CATCH_UP_MINUTES = 15;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function formatter(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

function calendarTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  const date = new Date(`${value}Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value;
}

export function normalizeJob(input) {
  const kind = input.kind;
  if (!["message", "status", "offline"].includes(kind)) throw new HttpError(400, "请选择计划任务类型");
  const schedule = object(input.schedule, "执行时间");
  const zone = text(schedule.time_zone || "Asia/Shanghai", "时区", { max: 64 });
  let timeZone;
  try {
    timeZone = formatter(zone).resolvedOptions().timeZone;
  } catch {
    throw new HttpError(400, "请输入有效的时区，例如 Asia/Shanghai");
  }
  const mode = schedule.mode;
  if (!["once", "daily", "weekly"].includes(mode)) throw new HttpError(400, "请选择单次、每日或每周执行");
  const timing = { mode, time_zone: timeZone };
  if (mode === "once") {
    if (typeof schedule.at !== "string" || !calendarTime(schedule.at)) throw new HttpError(400, "请填写有效的执行日期和时间");
    timing.at = schedule.at;
  } else {
    if (typeof schedule.time !== "string" || !timePattern.test(schedule.time)) throw new HttpError(400, "请填写有效的执行时间");
    timing.time = schedule.time;
    if (mode === "weekly") {
      const weekdays = schedule.weekdays;
      if (!Array.isArray(weekdays) || !weekdays.length || weekdays.length > 7 || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new HttpError(400, "每周任务至少选择一天");
      }
      timing.weekdays = [...new Set(weekdays)].sort();
    }
  }
  const templateId = input.template_id ? identifier(input.template_id, "模板标识") : "";
  const templateMode = input.template_mode ?? (templateId ? "custom" : "inline");
  if (!["event", "custom", "inline"].includes(templateMode)) throw new HttpError(400, "请选择有效的模板模式");
  if (templateMode === "custom" && !templateId) throw new HttpError(400, "请选择自定义模板");
  if (templateMode !== "custom" && templateId) throw new HttpError(400, "仅共用自定义模板模式可指定模板标识");
  const message = normalizeTemplate(input, { preview: true });
  if (kind === "message" && templateMode !== "custom" && !message.body.trim()) throw new HttpError(400, "请填写定时推送正文或选择模板");
  const offlineMinutes = input.offline_minutes ?? 780;
  if (!Number.isInteger(offlineMinutes) || offlineMinutes < 1 || offlineMinutes > 43200) {
    throw new HttpError(400, "离线阈值须为 1–43200 分钟");
  }
  return {
    name: text(input.name, "任务名称", { required: true }),
    enabled: enabled(input.enabled),
    kind,
    schedule: timing,
    device_ids: idList(input.device_ids, "设备", { max: 100, validate: validDeviceId }),
    channel_ids: idList(input.channel_ids, "渠道", { required: true }),
    offline_minutes: offlineMinutes,
    template_mode: templateMode,
    template_id: templateId,
    ...message,
  };
}

function localMinute(format, time) {
  const parts = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hourMinute = `${parts.hour}:${parts.minute}`;
  return { date, time: hourMinute, minute: `${date}T${hourMinute}`, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() };
}

function dueSlot(job, window) {
  const { schedule } = job;
  const start = job.updated_at ? Math.floor(Date.parse(job.updated_at) / MINUTE) * MINUTE : 0;
  return window.find((slot) => {
    if (slot.timestamp < start) return false;
    if (schedule.mode === "once") return slot.minute === schedule.at;
    if (slot.time !== schedule.time) return false;
    return schedule.mode === "daily" || schedule.weekdays.includes(slot.weekday);
  });
}

export function slotsInWindow(timeZone, timestamp) {
  const format = formatter(timeZone);
  const scheduledMinute = Math.floor(timestamp / MINUTE) * MINUTE;
  const slots = [];
  for (let age = CATCH_UP_MINUTES; age >= 0; age--) {
    const time = scheduledMinute - age * MINUTE;
    slots.push({ ...localMinute(format, time), timestamp: time });
  }
  return slots;
}

export async function deviceSnapshots(kv, devices) {
  const latest = await getMany(kv, devices.map(({ id }) => keys.latest(id)));
  return devices.map((device) => ({ last_seen: null, status: {}, ...latest.get(keys.latest(device.id)), ...device }));
}

function jobContent(job, devices, timestamp) {
  if (job.kind === "message") return { content: job.body, active: true };
  const selected = devices.filter(({ id, enabled: active }) => active && (!job.device_ids.length || job.device_ids.includes(id)));
  if (job.kind === "offline") {
    const threshold = timestamp - job.offline_minutes * MINUTE;
    const offline = selected.filter((device) => Date.parse(device.last_seen ?? device.created_at) <= threshold);
    return {
      content: offline.map((device) => `${device.name} · 最后上报 ${device.last_seen ?? "尚未上报"}`).join("\n"),
      active: offline.length > 0,
    };
  }
  const content = selected.map((device) => {
    const status = statusText(device.status);
    return [`${device.name}`, `最后上报 ${device.last_seen ?? "尚未上报"}`, status].filter(Boolean).join("\n");
  }).join("\n\n");
  return { content: content || "暂无可汇总的设备", active: true };
}

export async function runScheduledJobs(env, scheduledTime, now = Date.now()) {
  const kv = dataStore(env);
  const jobs = (await allValues(kv, "jobs:")).filter((job) => job.enabled);
  const windows = new Map();
  let devices;
  const saved = [];
  for (const job of jobs) {
    if (!windows.has(job.schedule.time_zone)) windows.set(job.schedule.time_zone, slotsInWindow(job.schedule.time_zone, scheduledTime));
    const slot = dueSlot(job, windows.get(job.schedule.time_zone));
    if (!slot) continue;
    if (job.kind !== "message" && !devices) devices = await deviceSnapshots(kv, await allValues(kv, "devices:"));
    const { content, active } = jobContent(job, devices ?? [], slot.timestamp);
    const event = {
      version: 1,
      device_id: SCHEDULER_DEVICE,
      device_name: job.name,
      event_id: `${job.id}.${slot.minute.replace(/[-:]/g, "")}`,
      type: `schedule.${job.kind}`,
      occurred_at: new Date(slot.timestamp).toISOString(),
      data: { job_id: job.id, job_name: job.name, content },
      status: {},
    };
    const templateMode = job.template_mode ?? (job.template_id ? "custom" : "inline");
    if (templateMode === "event" && job.kind === "message") {
      // Resolve task variables before the event format inserts CONTENT; never re-render inserted text.
      event.data.content = renderMessage({ title: "{{JOB_NAME}}", body: content }, event).body;
    }
    const selection = {
      ...job,
      template_id: templateMode === "custom" ? job.template_id : "",
      ...(templateMode === "event" ? {} : {
        message_template: { title: job.title || "{{JOB_NAME}}", body: job.kind === "message" && job.body ? job.body : "{{CONTENT}}" },
      }),
    };
    try {
      saved.push(await recordEvent(env, event, (item) => active ? makeRoutes(kv, [selection], item) : [], { now }));
    } catch {
      console.warn("计划任务记录暂无法保存");
    }
  }
  return saved;
}
