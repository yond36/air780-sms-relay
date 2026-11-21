import assert from "node:assert/strict";
import { splitMigrationSql } from "../test/helpers/migration-sql.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as LocalResponse } from "miniflare";

// Local-only GUI fixtures. No production credentials, SIM API or external delivery.
const root = new URL("../", import.meta.url);
const password = "local-ws-gui-test";
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("src/index.js", root))], bundle: true, write: false,
  format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"],
});
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: "ws-gui-local", modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: "2025-11-01", host: "127.0.0.1", port: 8794,
  d1Databases: ["DB"], durableObjects: { DEVICE_SESSION: { className: "DeviceSession", useSQLite: true } },
  ratelimits: { RELAY_REGISTRATION_LIMIT: { namespace_id: "1", simple: { limit: 100, period: 60 } } },
  bindings: { ADMIN_PASSWORD: password, APP_SECRET: "local-gui-secret-not-used-in-production-at-least-32", SMS_COMMAND_TTL_SECONDS: "60" },
  serviceBindings: { ASSETS: async (request) => {
    const file = staticFiles.get(new URL(request.url).pathname);
    if (!file) return new LocalResponse("Not found", { status: 404 });
    return new LocalResponse(await readFile(new URL(`public/${file[0]}`, root)), {
      headers: { "Content-Type": file[1], "Cache-Control": "no-store" },
    });
  } },
  outboundService: () => { throw new Error("External delivery is disabled for local GUI verification"); },
  cf: false, log: new Log(LogLevel.ERROR),
}));
const database = await runtime.getD1Database("DB");
for (const name of ["0001_d1.sql", "0002_ws_command_sessions.sql", "0003_history_retention.sql", "0004_permanent_sms.sql"]) {
  const schema = await readFile(new URL(`migrations/${name}`, root), "utf8");
  await database.batch(splitMigrationSql(schema).map((sql) => database.prepare(sql)));
}
const sockets = [];
const actorTimers = new Set();
async function actor(identity, token, sending) {
  const response = await runtime.dispatchFetch("http://127.0.0.1:8794/api/v1/device/ws", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}`,
      "X-Relay-Identity-Type": "sn", "X-Relay-Identity-Value": identity },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  sockets.push(socket);
  let resolveHello;
  const helloPromise = new Promise((resolve) => { resolveHello = resolve; });
  socket.addEventListener("message", ({ data }) => {
    if (data === "p") { socket.send("q"); return; }
    if (data === "q") return;
    const input = JSON.parse(data);
    if (input.type === "hello") {
      socket.send(JSON.stringify({ type: "ready", session_id: input.session_id,
        capabilities: sending ? ["event.report", "sms.send"] : ["event.report"],
        journal: sending ? { usable_slots: 16, quarantined_slots: 0 } : { usable_slots: 0, quarantined_slots: 0 } }));
      resolveHello(input);
    } else if (input.type === "command") {
      assert.equal(sending, true);
      const timer = setTimeout(() => {
        actorTimers.delete(timer);
        socket.send(JSON.stringify({ type: "command_result", command_id: input.command.id, status: "submitted" }));
        console.log("Local simulated result submitted; no SMS API exists in this process");
      }, 15000);
      actorTimers.add(timer);
    }
  });
  socket.accept();
  const hello = await helloPromise;
  const record = await database.prepare("SELECT device_json FROM device_registry WHERE id = ?").bind(hello.device_id).first();
  const device = JSON.parse(record.device_json);
  device.name = sending ? "WS 模拟设备（可发送）" : "WS 模拟设备（仅上报）";
  await database.batch([
    database.prepare("UPDATE device_registry SET device_json = ? WHERE id = ?").bind(JSON.stringify(device), hello.device_id),
    database.prepare("UPDATE relay_records SET value = ? WHERE key = ?").bind(JSON.stringify(device), `devices:${hello.device_id}`),
  ]);
  return { ...hello, socket };
}
async function seedEvent(device, event_id, type, data) {
  const ack = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { device.socket.removeEventListener("message", receive); reject(new Error("Local GUI seed ACK timeout")); }, 4000);
    function receive({ data }) {
      if (data === "q") return;
      const input = JSON.parse(data);
      if (input.type === "event_ack" && input.event_id === event_id) {
        clearTimeout(timer); device.socket.removeEventListener("message", receive); resolve();
      }
    }
    device.socket.addEventListener("message", receive);
  });
  device.socket.send(JSON.stringify({ type: "event", recovered: false,
    event: { version: 1, device_id: device.device_id, event_id, type, data } }));
  await ack;
}
const ready = await actor("GUI-WS-READY", "A".repeat(43), true);
const readonly = await actor("GUI-WS-READONLY", "B".repeat(43), false);
await delay(50);
await seedEvent(readonly, "gui-history-sms", "sms.received", { sender: "10086", content: "仅用于本地清理验收的模拟短信" });
await seedEvent(ready, "gui-history-boot", "device.boot", { reason: "local-gui-fixture" });
await runtime.ready;
console.log(JSON.stringify({ url: "http://127.0.0.1:8794/", password,
  fixtures: ["WS 模拟设备（可发送）", "WS 模拟设备（仅上报）"], ready: Boolean(ready), readonly: Boolean(readonly) }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const timer of actorTimers) clearTimeout(timer);
  for (const socket of sockets) { try { socket.close(); } catch {} }
  await runtime.dispose();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
