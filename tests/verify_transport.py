"""Run real Lua 5.3 RAM-only WSS/command/SMS code against offline hardware mocks.

No production service, SIM, modem, device credential file, deployment, or storage is read.
Every application fskv/io call throws and is counted, even if Lua swallows the exception.
TLS tests verify API arguments/fail-closed behavior, not a firmware certificate verifier.
Run: python -I tests/verify_transport.py --deps server/.wrangler/device-test-deps
"""
import argparse
import base64
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deps", type=Path, default=ROOT / "server/.wrangler/device-test-deps")
    args = parser.parse_args()
    sys.path.insert(0, str(args.deps.resolve()))
try:
    from lupa.lua53 import LuaRuntime
except ImportError:
    raise SystemExit("Existing isolated Lua 5.3 test runtime not found; provide --deps")

# Public trust anchors only. In particular, never glob/read the private device_auth.lua.
CA = re.search(rb"return \[\[(.*?)\]\]", (ROOT / "server_ca.lua").read_bytes(), re.S).group(1)
BASE = "https://device.example.test/prefix"
EPOCH = 1795100000
TOKEN = "A" * 20 + "_-" + "b" * 21
SESSION_ID, NEXT_SESSION_ID = "S" * 43, "T" * 43
PRIVATE_ERROR = "PRIVATE_OFFLINE_EXCEPTION_DETAIL"
DEFAULT_AUTH = object()


def auto_id(kind, value):
    return "auto~" + base64.urlsafe_b64encode(hashlib.sha256((kind + ":" + value).encode()).digest()).decode().rstrip("=")


AUTO_ID = auto_id("imei", "012345678901234")
SCOPE = hashlib.sha256(BASE.encode()).hexdigest()[:40]
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def static_auth(**changes):
    """Synthetic module data, never imported from an on-disk credential module."""
    value = {"server_url": BASE, "identity_type": "imei", "identity_value": "012345678901234", "token": TOKEN}
    value.update(changes)
    return value


def hello(*, session_id=SESSION_ID, device_id=AUTO_ID, **changes):
    message = {"type": "hello", "protocol_version": 2, "device_id": device_id,
               "session_id": session_id, "reconciled": True, "heartbeat_seconds": 60, "server_time": EPOCH}
    message.update(changes)
    return message


def ready_frame(*, session_id=SESSION_ID, heartbeat_seconds=60):
    return {"type": "ready", "session_id": session_id, "capabilities": ["event.report", "sms.send"],
            "journal": {"usable_slots": 16, "quarantined_slots": 0}, "heartbeat_seconds": heartbeat_seconds}


def server_frame(payload, opcode=1, fin=True, masked=False):
    if isinstance(payload, str):
        payload = payload.encode()
    if isinstance(payload, dict):
        payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    length = len(payload)
    header = bytes([(128 if fin else 0) | opcode])
    header += bytes([length]) if length < 126 else b"\x7e" + length.to_bytes(2, "big")
    if masked:
        header = header[:1] + bytes([header[1] | 128]) + header[2:]
        mask = b"test"
        return header + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return header + payload


def command(command_id="cmd-001", to="+8613800138000", content="离线测试", expires_at=EPOCH + 300,
            *, session_id=SESSION_ID, device_id=AUTO_ID):
    return {"id": command_id, "op": "sms.send", "device_id": device_id, "session_id": session_id,
            "to": to, "content": content, "expires_at": expires_at,
            "digest": hashlib.sha256((to + "\n" + content).encode()).hexdigest()}


def assert_private_logs_redacted(test, device, *extra):
    private = (TOKEN, SESSION_ID, NEXT_SESSION_ID, AUTO_ID, "012345678901234", "+8613800138000", "离线测试",
               PRIVATE_ERROR, *extra)
    text = json.dumps(device.logs, ensure_ascii=False)
    test.assertFalse(any(value in text for value in private),
                     "Diagnostics exposed private fixture data or raw exception details")


class Harness:
    """Real modules with virtual time, an explicit static-auth mock, and storage/HTTP tripwires.

    Standalone journal fixtures authorize a synthetic session unless disabled.
    Transport/integrated/main fixtures never bypass the reconciled v2 HELLO gate.
    """
    instances, boots = [], 0
    SOURCE_MODULES = {"config", "main", "util_notify", "util_transport", "util_command", "util_ws", "util_sms", "util_mobile", "util_http"}
    PUBLIC_MODULES = SOURCE_MODULES | {"lbsLoc", "libnet", "server_ca", "util_location"}

    def __init__(self, *, mode="journal", online=True, clock=True, registration=1,
                 handshake="valid", heartbeat=60, ack_events=False, ack_results=False,
                 tls_config=True, tls_connect=True, ca=None, base=BASE,
                 imei="012345678901234", sn="SN-001", secure_random=True,
                 authorize_journal=True, session_id=SESSION_ID, hello_message=None, auth=DEFAULT_AUTH,
                 bsp="OFFLINE"):
        Harness.instances.append(self)
        Harness.boots += 1
        self.boot = Harness.boots
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.table_type = type(self.lua.table())
        self.base, self.scope = base, hashlib.sha256(base.encode()).hexdigest()[:40]
        self.imei, self.sn, self.imei_reads, self.sn_reads = imei, sn, 0, 0
        self.identity_exception = False
        self.secure_random, self.random_lengths = secure_random, []
        self.ca = CA if ca is None else ca
        self.ms, self.epoch, self.online = 0, EPOCH if clock else 0, online
        self.registration, self.registration_reads, self.registration_exception = registration, 0, False
        self.gpio_setups, self.gpio_writes, self.gpio_levels, self.ws_ready_events = [], [], {}, []
        self.gpio_reads, self.powerkey_events = [], []
        self.http, self.requests, self.raw_tx, self.frames, self.sockets, self.connects, self.logs = [], [], [], [], [], [], []
        self.storage_calls, self.source_reads, self.auth_requires = [], [], 0
        self.sms_calls, self.remote_commands, self.ntp_calls, self.random_count = [], [], 0, 0
        self.fail_encode = None
        self.expected_device_id = AUTO_ID
        self.sms_return, self.sms_exception, self.ntp_sets_time = True, False, False
        self.handshake, self.ack_events, self.ack_results = handshake, ack_events, ack_results
        self.tls_config_ok, self.tls_connect_ok, self.tx_full = tls_config, tls_connect, False
        self.connect_immediate, self.tx_immediate = True, True
        self.send_hello, self.auto_pong, self.on_ready = True, True, []
        self.session_id, self.first_session_id, self.hello_message = session_id, session_id, hello_message
        self.event_acks, self.result_acks, self.tls_configs = [], [], []
        self.auth_data = copy.deepcopy(static_auth() if auth is DEFAULT_AUTH else auth)
        self.auth = self.table(self.auth_data)
        globals_ = self.lua.globals()
        callbacks = {
            "PY_storage": self.storage, "PY_auth": self.auth_module,
            "PY_encode": self.encode, "PY_log": self.capture_log,
            "PY_decode": lambda value: self.table(json.loads(value)),
            "PY_sha": lambda value: hashlib.sha256(value).hexdigest().encode(),
            "PY_sha1": lambda value: hashlib.sha1(value).hexdigest().encode(),
            "PY_base64": base64.b64encode, "PY_random": self.random,
            "PY_online": lambda *_: self.online, "PY_now": lambda: self.ms,
            "PY_imei": lambda: self.read_identity("imei"), "PY_sn": lambda: self.read_identity("sn"),
            "PY_tick": lambda: ((self.ms + 2**31) % 2**32) - 2**31,
            "PY_time": lambda: self.epoch + self.ms // 1000,
            "PY_ntp": self.ntp, "PY_sms": self.send_sms,
            "PY_create": self.create, "PY_config": self.configure, "PY_connect": self.connect,
            "PY_tx": self.tx, "PY_rx": self.rx, "PY_wait": self.wait, "PY_close": self.close,
            "PY_fetch": self.fetch, "PY_source": self.source,
            "PY_registration": self.read_registration,
            "PY_gpio_setup": self.gpio_setup, "PY_gpio_write": self.gpio_write, "PY_gpio_get": self.gpio_get,
            "PY_ws_ready": lambda ready: self.ws_ready_events.append(ready),
            "PY_powerkey": lambda event, duration: self.powerkey_events.append((self.python(event), duration)),
        }
        for key, value in callbacks.items():
            globals_[key.encode()] = value
        globals_[b"CA_BUNDLE"] = CA
        globals_[b"BSP_NAME"] = bsp.encode()
        self.lua.execute(b"""
            log = {
                info=function(...) PY_log("info", ...) end,
                warn=function(...) PY_log("warn", ...) end,
                error=function(...) PY_log("error", ...) end,
                debug=function(...) PY_log("debug", ...) end,
                setLevel=function() end,
            }
            local function forbidden(namespace)
                return setmetatable({}, {__index=function(_, api)
                    return function(...) return PY_storage(namespace.."."..api) end
                end})
            end
            fskv, io = forbidden("fskv"), forbidden("io")
            os.remove=function(...) return PY_storage("os.remove") end
            os.rename=function(...) return PY_storage("os.rename") end
            os.execute=function(...) return PY_storage("os.execute") end
            json = {encode=PY_encode, decode=PY_decode}
            crypto = {sha256=PY_sha, sha1=PY_sha1,
                trng=function(length) return PY_random(length) end, base64_encode=PY_base64}
            mobile = {imei=function() return PY_imei() end, sn=function() return PY_sn() end,
                imsi=function() return "460001234567890" end, simid=function() return 0 end,
                status=function() return PY_registration() end,
                setAuto=function() end, flymode=function() end}
            mcu = {ticks=PY_tick}
            os.time = PY_time
            sms = {send=function(to, content)
                    -- Snapshot on the Lua side, not via a reentrant Python proxy lookup.
                    local records = TEST_JOURNAL and json.encode(TEST_JOURNAL.records)
                    return PY_sms(to, content, records)
                end, setNewSmsCb=function(cb) NEW_SMS=cb end}
            socket = {LWIP_GP=1, ON_LINE=11, TX_OK=12, EVENT=13, CLOSED=14,
                adapter=PY_online, config=PY_config, connect=PY_connect, tx=PY_tx, rx=PY_rx,
                wait=PY_wait, close=PY_close, release=function() end, debug=function() end, sntp=PY_ntp,
                setDNS=function() end,
                create=function(adapter, cb) assert(adapter==1); return PY_create(cb) end}
            util_http = {fetch=PY_fetch}
            zbuff = {create=function(size)
                return {data="", del=function(self) self.data="" end,
                    query=function(self, start, length) return self.data:sub(start+1, start+length) end}
            end}
            pm = {lastReson=function() return "offline-test" end}
            wdt = {init=function() end, feed=function() end}
            rtos = {bsp=function() return BSP_NAME end}
            GPIO_INTERRUPTS = {}
            gpio = {PULLUP=1, setup=function(pin, mode, pull)
                if type(mode) == "function" then
                    PY_gpio_setup(pin, "interrupt", pull)
                    GPIO_INTERRUPTS[pin] = mode
                    return
                end
                PY_gpio_setup(pin, mode, pull)
                return function(value) return PY_gpio_write(pin, value) end
            end, get=function(pin) return PY_gpio_get(pin) end,
                set=function(pin, value) return PY_gpio_write(pin, value) end}
            cc = {lastNum=function() return "10086" end}
            sys = {tasks={}, subscribers={}, timers={}}
            function sys.taskInit(fn, ...)
                sys.tasks[#sys.tasks+1] = {co=coroutine.create(fn), resume=table.pack(...), runnable=true}
            end
            function sys.timerStart(fn, ms, ...)
                sys.timers[#sys.timers+1] = {fn=fn, ms=ms, due=PY_now()+ms, args=table.pack(...)}
                return #sys.timers
            end
            function sys.timerLoopStart(fn, ms, ...)
                local id = sys.timerStart(fn, ms, ...)
                sys.timers[id].loop = true
                return id
            end
            function sys.run() end
            function sys.subscribe(event, cb)
                local callbacks = sys.subscribers[event] or {}
                callbacks[#callbacks+1] = cb
                sys.subscribers[event] = callbacks
            end
            function sys.publish(event, ...)
                for _, cb in ipairs(sys.subscribers[event] or {}) do cb(...) end
                for _, task in ipairs(sys.tasks) do
                    if task.event == event then
                        task.event, task.due, task.runnable = nil, nil, true
                        task.resume = table.pack(true, ...)
                    end
                end
            end
            sys.subscribe("DEVICE_WS_READY", function(ready) PY_ws_ready(ready) end)
            sys.subscribe("POWERKEY_SHORT_PRESS", function(duration) PY_powerkey("POWERKEY_SHORT_PRESS", duration) end)
            sys.subscribe("POWERKEY_LONG_PRESS", function(duration) PY_powerkey("POWERKEY_LONG_PRESS", duration) end)
            function sys.wait(ms) return coroutine.yield("wait", ms) end
            function sys.waitUntil(event, timeout) return coroutine.yield("event", event, timeout) end
            function sys.expire()
                for _, timer in ipairs(sys.timers) do
                    if timer.due and timer.due <= PY_now() then
                        timer.due = timer.loop and PY_now()+timer.ms or nil
                        timer.fn(table.unpack(timer.args, 1, timer.args.n))
                    end
                end
                for _, task in ipairs(sys.tasks) do
                    if task.due and task.due <= PY_now() then
                        task.resume = table.pack(task.event == nil)
                        task.event, task.due, task.runnable = nil, nil, true
                    end
                end
            end
            function drive()
                local count = 0
                while true do
                    local ran = false
                    for _, task in ipairs(sys.tasks) do
                        if task.runnable then
                            count, ran, task.runnable = count+1, true, false
                            if count > 1000 then error("Offline scheduler did not become idle") end
                            local args = task.resume or table.pack()
                            task.resume = nil
                            local result = table.pack(coroutine.resume(task.co, table.unpack(args, 1, args.n)))
                            if not result[1] then error(result[2]) end
                            if coroutine.status(task.co) == "dead" then task.dead=true
                            elseif result[2] == "wait" then task.due=PY_now()+result[3]
                            elseif result[2] == "event" then
                                task.event=result[3]
                                task.due=result[4] and PY_now()+result[4] or nil
                            else error("Unexpected scheduler yield") end
                        end
                    end
                    if not ran then return count end
                end
            end
            MODULES = {sys=sys, sysplus={},
                util_location={get=function() end, refresh=function() end}}
            function require(name)
                if name == "device_auth" then return PY_auth() end
                if name == "server_ca" then return CA_BUNDLE end
                if MODULES[name] then return MODULES[name] end
                local chunk, err = load(PY_source(name), "@"..name..".lua", "t", _G)
                if not chunk then error(err) end
                MODULES[name] = chunk()
                return MODULES[name]
            end
            config = require "config"
        """)
        self.cfg = globals_[b"config"]
        self.cfg[b"SERVER_URL"] = base.encode()
        self.cfg[b"WSS_HEARTBEAT_SECONDS"] = heartbeat
        self.cfg[b"SMS_SEND_TIMEOUT_MS"] = 30000
        if ca is not None:
            self.cfg[b"SERVER_CA_PEM"] = ca
        self.transport, self.client, self.journal, self.notify = None, None, None, None
        if mode in ("integrated", "main"):
            self.lua.execute(b"""
                local module = require "util_transport"
                local start = module.start
                module.start = function(client)
                    TEST_TRANSPORT = start(client)
                    return TEST_TRANSPORT
                end
            """)
            if mode == "main":
                self.lua.execute(self.source(b"main"))
                self.notify = globals_[b"util_notify"]
            else:
                self.notify = self.lua.eval(b'require("util_notify")')
                self.notify.init()
            self.transport = globals_[b"TEST_TRANSPORT"]
            if self.transport is not None:
                self.client = self.transport[b"client"]
                self.journal = self.transport[b"commands"]
        else:
            self.client = self.table({"base": base, "ca": self.ca, "scope": self.scope,
                                      "device_id": AUTO_ID, "token": TOKEN,
                                      "identity_type": "imei", "identity_value": "012345678901234"})
            globals_[b"TEST_CLIENT"] = self.client
            self.lua.execute(b"""
                TEST_CLIENT.is_current=function() return config.SERVER_URL==TEST_CLIENT.base end
                TEST_CLIENT.prepare=function() return true end
            """)
            if mode == "transport":
                self.transport = self.lua.eval(b'require("util_transport").start')(self.client)
                self.journal = self.transport[b"commands"]
            else:
                self.journal = self.lua.eval(b'require("util_command").new')(self.client)
                if authorize_journal:
                    self.authorize(session_id)
        globals_[b"TEST_JOURNAL"] = self.journal

    def source(self, name):
        name = name.decode()
        self.source_reads.append(name)
        if name not in self.SOURCE_MODULES:
            raise AssertionError("Attempted to load an unapproved source module")
        return (ROOT / (name + ".lua")).read_bytes()

    def storage(self, api):
        self.storage_calls.append(api.decode())
        raise AssertionError("Application attempted forbidden storage API")

    def auth_module(self):
        self.auth_requires += 1
        return self.auth

    def python(self, value):
        if isinstance(value, bytes):
            return value.decode()
        if isinstance(value, self.table_type):
            pairs = list(value.items())
            if pairs and all(isinstance(key, int) for key, _ in pairs) and {key for key, _ in pairs} == set(range(1, len(pairs)+1)):
                return [self.python(value[index]) for index in range(1, len(pairs)+1)]
            return {self.python(key): self.python(item) for key, item in pairs}
        return value

    def table(self, value):
        if isinstance(value, str):
            return value.encode()
        if isinstance(value, dict):
            table = self.lua.table()
            for key, item in value.items():
                table[self.table(key)] = self.table(item)
            return table
        if isinstance(value, list):
            return self.lua.table_from([self.table(item) for item in value])
        return value

    def capture_log(self, level, *values):
        self.logs.append((self.python(level), tuple(self.python(value) for value in values)))

    def encode(self, value):
        native = self.python(value)
        if self.fail_encode and self.fail_encode(native):
            raise RuntimeError(PRIVATE_ERROR)
        return json.dumps(native, ensure_ascii=False, separators=(",", ":")).encode()

    def random(self, length):
        self.random_count += 1
        self.random_lengths.append(length)
        if not self.secure_random:
            return None
        seed = hashlib.sha256(f"offline-only:{self.boot}:{self.random_count}".encode()).digest()
        return (seed * (length // 32 + 1))[:length]

    def read_identity(self, kind):
        if self.identity_exception:
            raise RuntimeError(PRIVATE_ERROR)
        if kind == "imei":
            self.imei_reads += 1
            value = self.imei
        else:
            self.sn_reads += 1
            value = self.sn
        return value.encode() if isinstance(value, str) else value

    def read_registration(self):
        self.registration_reads += 1
        if self.registration_exception:
            raise RuntimeError(PRIVATE_ERROR)
        return self.table(self.registration)

    def gpio_setup(self, pin, mode, pull):
        mode = self.python(mode)
        self.gpio_setups.append((self.ms, pin, mode, pull))
        if mode == "interrupt":
            self.gpio_levels[pin] = 1  # Supported POWERKEY inputs idle at PULLUP.
        else:
            self.gpio_write(pin, mode)

    def gpio_write(self, pin, level):
        assert type(level) is int and level in (0, 1), "GPIO output must be a digital level"
        self.gpio_levels[pin] = level
        self.gpio_writes.append((self.ms, pin, level))
        return None

    def gpio_get(self, pin):
        self.gpio_reads.append((self.ms, pin))
        return self.gpio_levels.get(pin)

    def trigger_gpio_input(self, pin, level):
        """Change a mocked external input and invoke its real Lua interrupt callback."""
        assert type(level) is int and level in (0, 1)
        callback = self.lua.globals()[b"GPIO_INTERRUPTS"][pin]
        assert callback is not None, "Input must have a registered GPIO callback"
        self.gpio_levels[pin] = level
        callback()
        return self.drive()

    def authorize(self, session_id=SESSION_ID):
        self.session_id = session_id
        return self.journal[b"authorize"](self.journal, self.table(session_id))

    def ntp(self):
        self.ntp_calls += 1
        if self.ntp_sets_time:
            self.epoch = EPOCH
        return True

    def send_sms(self, to, content, records_body=None):
        records = json.loads(records_body) if records_body else []
        if (to.decode(), content.decode()) in self.remote_commands:
            digest = hashlib.sha256(to + b"\n" + content).hexdigest()
            assert any(record.get("digest") == digest and record.get("state") == "intent"
                       for record in records), "RAM intent must exist before mocked SMS dispatch"
        self.sms_calls.append({"to": to.decode(), "content": content.decode(), "records": records})
        if self.sms_exception:
            raise RuntimeError(PRIVATE_ERROR)
        return self.sms_return

    def create(self, callback):
        ctrl = self.lua.table_from({b"id": len(self.sockets)})
        self.sockets.append({"ctrl": ctrl, "callback": callback, "incoming": bytearray(), "closed": False})
        return ctrl

    def socket(self, ctrl):
        return self.sockets[ctrl[b"id"]]

    def configure(self, ctrl, local_port, is_udp, is_tls, keep_idle, keep_interval, keep_count, ca):
        self.tls_configs.append({"udp": is_udp, "tls": is_tls, "ca": ca,
                                 "keepalive": (keep_idle, keep_interval, keep_count)})
        assert is_udp is False and is_tls is True and ca == self.ca
        return self.tls_config_ok

    def connect(self, ctrl, host, port, ipv6):
        self.connects.append((host.decode(), port, ipv6))
        return self.tls_connect_ok, self.tls_connect_ok and self.connect_immediate

    def tx(self, ctrl, data):
        sock = self.socket(ctrl)
        self.raw_tx.append(data)
        if self.tx_full:
            return True, True, False
        if data.startswith(b"GET "):
            headers = dict(line.decode().split(": ", 1) for line in data.split(b"\r\n")[1:] if b": " in line)
            identity_type, identity_value = headers.get("X-Relay-Identity-Type"), headers.get("X-Relay-Identity-Value")
            assert identity_type in ("imei", "sn") and identity_value, "WS enrollment requires prepared identity headers"
            assert headers.get("Authorization") == "Bearer " + self.auth_data["token"], "WS must use the static token"
            assert identity_type == self.auth_data["identity_type"] and identity_value == self.auth_data["identity_value"]
            self.expected_device_id = auto_id(identity_type, identity_value)
            self.requests.append({"headers": headers, "device_id": self.expected_device_id})
            index = len(self.requests) - 1
            self.session_id = self.first_session_id if index == 0 else NEXT_SESSION_ID if index == 1 else base64.urlsafe_b64encode(hashlib.sha256(f"session:{self.boot}:{index}".encode()).digest()).decode().rstrip("=")
            key = re.search(rb"Sec-WebSocket-Key: ([^\r]+)", data).group(1)
            expected = base64.b64encode(hashlib.sha1(key + GUID).digest())
            if self.handshake == "404":
                response = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
            else:
                value = expected if self.handshake == "valid" else b"wrong"
                response = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: " + value + b"\r\n\r\n"
                if self.send_hello:
                    message = self.hello_message if self.hello_message is not None else hello(session_id=self.session_id, device_id=self.expected_device_id)
                    response += server_frame(message)
            sock["incoming"].extend(response)
        else:
            assert data[0] & 128 and data[1] & 128, "All client frames must be final and masked"
            length, offset = data[1] & 127, 2
            if length == 126:
                length, offset = int.from_bytes(data[2:4], "big"), 4
            mask = data[offset:offset+4]
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data[offset+4:]))
            assert len(payload) == length
            frame = {"opcode": data[0] & 15, "payload": payload, "mask": mask}
            self.frames.append(frame)
            if frame["opcode"] == 1:
                if payload == b"p" and self.auto_pong:
                    sock["incoming"].extend(server_frame("q"))
                elif payload.startswith(b"{"):
                    message = json.loads(payload)
                    if message["type"] == "ready":
                        assert message["journal"] == {"usable_slots": 16, "quarantined_slots": 0}
                        for value in self.on_ready:
                            sock["incoming"].extend(server_frame(value))
                        self.on_ready.clear()
                    elif message["type"] == "event":
                        event = message["event"]
                        assert event["device_id"] == self.expected_device_id
                        assert event["type"] != "legacy" and "_server_scope" not in event
                        assert "recovered" not in event and message.get("recovered", False) is False
                        assert len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()) <= 4095
                        ack = self.event_acks.pop(0) if self.event_acks else {} if self.ack_events else None
                        if ack is not None:
                            reply = {"type": "event_ack", "ok": True, "accepted": True,
                                     "event_id": event["event_id"], "session_id": self.session_id}
                            reply.update(ack)
                            sock["incoming"].extend(server_frame(reply))
                    elif message["type"] == "command_result":
                        ack = self.result_acks.pop(0) if self.result_acks else {} if self.ack_results else None
                        if ack is not None:
                            reply = {"type": "command_result_ack", "ok": True, "accepted": True,
                                     "command_id": message["command_id"], "session_id": self.session_id}
                            reply.update(ack)
                            sock["incoming"].extend(server_frame(reply))
        return True, False, self.tx_immediate

    def rx(self, ctrl, buff=None, flag=0, limit=None):
        sock = self.socket(ctrl)
        if sock["closed"]:
            return False, 0
        if buff is None:
            return True, len(sock["incoming"])
        length = min(len(sock["incoming"]), limit or len(sock["incoming"]))
        buff[b"data"] = bytes(sock["incoming"][:length])
        del sock["incoming"][:length]
        return True, length

    def wait(self, ctrl):
        sock = self.socket(ctrl)
        return not sock["closed"], bool(sock["incoming"])

    def close(self, ctrl):
        self.socket(ctrl)["closed"] = True

    def fetch(self, *args):
        self.http.append({"forbidden_fetch": True})
        raise AssertionError("WS-only modules attempted forbidden util_http.fetch")

    def drive(self):
        return self.lua.globals().drive()

    def advance(self, ms):
        self.ms += ms
        self.lua.globals().sys.expire()
        return self.drive()

    def next_deadline(self):
        due = [task[b"due"] for _, task in self.lua.globals().sys.tasks.items()
               if task[b"due"] is not None and not task[b"dead"]]
        due += [timer[b"due"] for _, timer in self.lua.globals().sys.timers.items() if timer[b"due"] is not None]
        return min(due) if due else None

    def run_until(self, predicate, max_steps=20):
        self.drive()
        for _ in range(max_steps):
            if predicate():
                return True
            due = self.next_deadline()
            if due is None:
                break
            self.advance(max(0, due - self.ms))
        return bool(predicate())

    def journal_status(self):
        return self.python(self.journal[b"status"](self.journal))

    def queue_status(self):
        return self.python(self.notify.status())

    def emit(self, event, *args):
        self.lua.globals().sys.publish(event.encode(), *[self.table(arg) for arg in args])
        return self.drive()

    def socket_event(self, event, code=0, index=-1):
        sock = self.sockets[index]
        number = self.lua.globals().socket[event.encode()]
        sock["callback"](sock["ctrl"], number, code)
        return self.drive()

    def push(self, payload, opcode=1, fin=True, masked=False):
        sock = next(sock for sock in reversed(self.sockets) if not sock["closed"])
        sock["incoming"].extend(server_frame(payload, opcode, fin, masked))
        return self.emit("DEVICE_TRANSPORT_WAKE")

    def receive(self, value, over_ws=False):
        self.remote_commands.append((value.get("to"), value.get("content")))
        if over_ws:
            return self.push({"type": "command", "command": value})
        return self.python(self.journal.receive(self.journal, self.table(value)))

    def records(self):
        return [self.python(record) for _, record in self.journal[b"records"].items()]

    def record(self, command_id):
        return next(record for record in self.records() if record.get("id") == command_id)

    def raw_record(self, command_id):
        find = self.lua.eval(b'function(j,id) for _,r in ipairs(j.records) do if r.id==id then return r end end end')
        return find(self.journal, command_id.encode())

    def ack(self, command_id):
        return self.journal.ack(self.journal, self.raw_record(command_id), command_id.encode())

    def messages(self, kind):
        return [message for frame in self.frames if frame["opcode"] == 1 and frame["payload"].startswith(b"{")
                if (message := json.loads(frame["payload"]))["type"] == kind]

    def add_event(self, kind="sms.received", content="PRIVATE_EVENT_FIXTURE"):
        data = {"sender": "offline", "content": content} if kind == "sms.received" else {"reason": content}
        return self.notify.add(kind.encode(), self.table(data), None, EPOCH)


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        Harness.instances = []

    def tearDown(self):
        self.assertFalse(any(device.http for device in Harness.instances),
                         "WS-only code attempted business HTTP")
        self.assertFalse(any(device.storage_calls for device in Harness.instances),
                         "Application called forbidden fskv/io APIs (including swallowed errors)")
        self.assertFalse(any("device_auth" in device.source_reads or "util_fskv" in device.source_reads
                             for device in Harness.instances), "Private credentials or obsolete storage module was read")


class CommandTests(OfflineTestCase):
    def test_journal_requires_explicit_valid_session_before_admission(self):
        device = Harness(authorize_journal=False)
        self.assertFalse(device.journal[b"available"])
        self.assertEqual(device.journal_status(), {"usable_slots": 16, "quarantined_slots": 0})
        self.assertIsNone(device.receive(command()))
        for invalid in (None, False, 123, "S" * 42, "S" * 44, "?" * 43, "S" * 42 + " ", "汉" * 43):
            self.assertFalse(device.authorize(invalid))
            self.assertFalse(device.journal[b"available"])
            self.assertIsNone(device.receive(command()))
        self.assertTrue(device.authorize())
        for value in (command(session_id=NEXT_SESSION_ID), {key: value for key, value in command().items() if key != "session_id"}):
            self.assertIsNone(device.receive(value))
        self.assertTrue(all(record["state"] == "empty" for record in device.records()))
        device.receive(command())
        device.drive()
        self.assertEqual(len(device.sms_calls), 1)
        assert_private_logs_redacted(self, device)

    def test_revocation_or_new_session_blocks_captured_intent(self):
        for fence in ("revoke", "new_session", "invalid_session"):
            with self.subTest(fence=fence):
                device = Harness()
                value = command()
                device.receive(value)
                self.assertEqual(device.record(value["id"])["state"], "intent")
                if fence == "revoke":
                    device.journal[b"revoke"](device.journal)
                else:
                    device.authorize(NEXT_SESSION_ID if fence == "new_session" else "?" * 43)
                device.drive()
                self.assertEqual(device.sms_calls, [])
                self.assertEqual(device.record(value["id"])["error"], "session_changed")
                device.receive(value)
                device.drive()
                self.assertEqual(device.sms_calls, [])
                self.assertTrue(device.authorize(NEXT_SESSION_ID))
                fresh = command("new-session-command", session_id=NEXT_SESSION_ID)
                device.receive(fresh)
                device.drive()
                self.assertEqual(len(device.sms_calls), 1)
                device.emit("SMS_SENT", True)
                self.assertEqual(device.record(fresh["id"])["status"], "submitted")

    def test_session_or_scope_replaced_during_ntp_wait_cannot_release_sms(self):
        for fence in ("session", "revoke", "scope"):
            with self.subTest(fence=fence):
                device = Harness(clock=False)
                device.receive(command())
                device.drive()
                self.assertEqual(device.ntp_calls, 1)
                if fence == "session":
                    device.authorize(NEXT_SESSION_ID)
                elif fence == "revoke":
                    device.journal.revoke(device.journal)
                else:
                    device.cfg[b"SERVER_URL"] = b"https://changed.example.test"
                device.epoch = EPOCH
                device.emit("NTP_UPDATE")
                self.assertEqual(device.sms_calls, [])
                self.assertEqual(device.record("cmd-001")["error"], "scope_changed" if fence == "scope" else "session_changed")

    def test_same_boot_intent_final_ack_and_duplicate_never_send_twice(self):
        device = Harness()
        value = command()
        device.receive(value)
        self.assertEqual(device.record(value["id"])["state"], "intent")
        self.assertEqual(device.record(value["id"])["keep_until"] - value["expires_at"], 3600)
        device.receive(value)  # Duplicate while queued.
        device.drive()
        device.receive(value)  # Duplicate while the modem is active.
        self.assertEqual(len(device.sms_calls), 1)
        device.emit("SMS_SENT", True)
        self.assertEqual(device.record(value["id"])["status"], "submitted")
        self.assertTrue(device.ack(value["id"]))
        self.assertFalse(device.record(value["id"])["pending"])
        self.assertFalse(device.ack("wrong"))
        for _ in range(20):
            device.receive(value)
            device.advance(1000)
            self.assertTrue(device.record(value["id"])["pending"])
            self.assertTrue(device.ack(value["id"]))
        self.assertEqual(len(device.sms_calls), 1)
        self.assertEqual(len(device.records()), 16)
        record = device.record(value["id"])
        for forbidden in ("to", "content", "token", "dirty", "key"):
            self.assertNotIn(forbidden, record)
        self.assertNotIn(TOKEN, json.dumps(record))
        assert_private_logs_redacted(self, device)

    def test_ack_keeps_ids_through_expiry_plus_retention_and_pending_never_pruned(self):
        device = Harness()
        for name in ("acked", "pending"):
            device.receive(command(name, expires_at=EPOCH))
            device.drive()
        self.assertTrue(device.ack("acked"))
        device.epoch = EPOCH + 3599
        device.journal.prune(device.journal)
        self.assertEqual(device.record("acked")["digest"], command()["digest"])
        device.epoch = EPOCH + 3600
        device.journal.prune(device.journal)
        self.assertFalse(any(record.get("id") == "acked" for record in device.records()))
        self.assertTrue(device.record("pending")["pending"])
        device.epoch += 40 * 86400
        device.journal.prune(device.journal)
        self.assertTrue(device.record("pending")["pending"])
        self.assertTrue(device.ack("pending"))
        device.journal.prune(device.journal)
        self.assertTrue(all(record["state"] == "empty" for record in device.records()))
        device.receive(command("pending", expires_at=EPOCH))
        device.drive()
        self.assertEqual(device.record("pending")["error"], "expired")
        self.assertEqual(device.sms_calls, [])

    def test_full_16_slots_reject_overflow_without_forgetting_acked_ids(self):
        device = Harness()
        for index in range(16):
            device.receive(command(f"expired-{index}", expires_at=EPOCH))
            device.drive()
            self.assertTrue(device.ack(f"expired-{index}"))
        snapshot = copy.deepcopy(device.records())
        for index in range(100):
            self.assertEqual(device.receive(command(f"overflow-{index}"))["error"], "journal_full")
        self.assertEqual(device.records(), snapshot)
        self.assertEqual(len(device.records()), 16)
        device.receive(command("expired-0", expires_at=EPOCH))
        self.assertTrue(device.record("expired-0")["pending"])
        self.assertEqual(device.sms_calls, [])
        device.epoch = EPOCH + 3600
        device.journal.prune(device.journal)
        self.assertEqual(sum(record["state"] != "empty" for record in device.records()), 1)
        device.receive(command("fresh-after-prune", expires_at=device.epoch + 600))
        device.drive()
        self.assertEqual(len(device.sms_calls), 1)

    def test_no_valid_clock_never_prunes_same_boot_tombstones(self):
        device = Harness()
        device.receive(command(expires_at=EPOCH))
        device.drive()
        self.assertTrue(device.ack("cmd-001"))
        device.epoch = 0
        device.journal.prune(device.journal)
        self.assertEqual(device.record("cmd-001")["state"], "final")
        self.assertFalse(device.record("cmd-001")["pending"])

    def test_retention_limits_and_completed_slots_recycle(self):
        for seconds, expected in ((0, 3600), (60, 3600), (7200, 7200), (40 * 86400, 30 * 86400)):
            device = Harness()
            device.cfg[b"COMMAND_DEDUP_SECONDS"] = seconds
            device.receive(command(expires_at=EPOCH))
            self.assertEqual(device.record("cmd-001")["keep_until"], EPOCH + expected)
        recycled = Harness()
        for index in range(24):
            value = command(f"regular-{index}", expires_at=recycled.epoch + 600)
            recycled.receive(value)
            recycled.advance(1000)
            self.assertEqual(len(recycled.sms_calls), index + 1)
            recycled.emit("SMS_SENT", True)
            self.assertTrue(recycled.ack(value["id"]))
            recycled.epoch += 7200
        recycled.journal.prune(recycled.journal)
        self.assertEqual(len(recycled.records()), 16)
        self.assertTrue(all(record["state"] == "empty" for record in recycled.records()))

    def test_restart_discards_intents_results_tombstones_and_executor_state(self):
        for state in ("intent", "final_pending", "final_acked", "unknown"):
            with self.subTest(state=state):
                old = Harness()
                value = command()
                old.receive(value)
                old.drive()
                if state == "unknown":
                    old.advance(30000)
                elif state != "intent":
                    old.emit("SMS_SENT", True)
                    if state == "final_acked":
                        self.assertTrue(old.ack(value["id"]))
                restarted = Harness(authorize_journal=False)
                self.assertEqual(restarted.journal_status(), {"usable_slots": 16, "quarantined_slots": 0})
                self.assertTrue(all(record["state"] == "empty" for record in restarted.records()))
                self.assertIsNone(restarted.journal.nextResult(restarted.journal))
                self.assertFalse(restarted.journal.hasPending(restarted.journal))
                restarted.drive()
                self.assertEqual(restarted.sms_calls, [])
                self.assertTrue(restarted.authorize(NEXT_SESSION_ID))
                # Volatile state cannot promise cross-restart dedupe. Only a new, authorized
                # current-session command can run; the server must reconcile old commands.
                restarted.receive({**value, "session_id": NEXT_SESSION_ID})
                restarted.drive()
                self.assertEqual(len(restarted.sms_calls), 1)

    def test_conflict_invalid_digest_op_device_id_expiry_and_utf8_rejected(self):
        device = Harness()
        device.receive(command())
        device.drive()
        device.emit("SMS_SENT", True)
        self.assertEqual(device.receive(command(content="冲突内容"))["error"], "digest_conflict")
        self.assertEqual(device.record("cmd-001")["status"], "submitted")
        cases = [("digest", "0" * 64, "digest_mismatch"), ("digest", "BAD", "invalid_digest"),
                 ("op", "sms.delete", "unsupported_op"), ("device_id", "other", "wrong_device"),
                 ("to", "123\r\nInjected", "invalid_number"), ("content", "😀", "invalid_content"),
                 ("content", "a" * 501, "invalid_content"), ("expires_at", EPOCH + .5, "invalid_expiry"),
                 ("expires_at", 4102444800, "invalid_expiry"), ("expires_at", 0, "invalid_expiry")]
        for field, bad, tag in cases:
            value = command("bad-" + field)
            value[field] = bad
            self.assertEqual(device.receive(value)["error"], tag)
        for invalid in ("", "x" * 81, "id~invalid", "\r\n", "汉"):
            self.assertIsNone(device.receive(command(invalid)))
        self.assertEqual(len(device.sms_calls), 1)
        assert_private_logs_redacted(self, device)

    def test_expiry_ntp_scope_and_exact_ram_intent_rechecked_at_execution(self):
        expired = Harness()
        expired.receive(command(expires_at=EPOCH))
        expired.drive()
        self.assertEqual(expired.sms_calls, [])
        self.assertEqual(expired.record("cmd-001")["error"], "expired")
        no_clock = Harness(clock=False)
        no_clock.receive(command())
        no_clock.drive()
        self.assertEqual(no_clock.ntp_calls, 1)
        no_clock.advance(15000)
        self.assertEqual(no_clock.record("cmd-001")["error"], "clock_unavailable")
        fixed = Harness(clock=False)
        fixed.receive(command())
        fixed.drive()
        fixed.epoch = EPOCH
        fixed.emit("NTP_UPDATE")
        self.assertEqual(len(fixed.sms_calls), 1)
        for field in ("expires_at", "keep_until", "digest"):
            changed = Harness(clock=False)
            changed.receive(command())
            changed.drive()  # The precheck is now suspended for NTP.
            record = changed.raw_record("cmd-001")
            record[field.encode()] = b"f" * 64 if field == "digest" else record[field.encode()] + 1
            changed.epoch = EPOCH
            changed.emit("NTP_UPDATE")
            self.assertEqual(changed.sms_calls, [])
            self.assertEqual(changed.record("cmd-001")["error"], "intent_changed")

    def test_unknown_false_exception_async_error_timeout_and_late_results_lock_executor(self):
        for outcome in ("false", "exception", "async_error", "timeout"):
            with self.subTest(outcome=outcome):
                device = Harness()
                device.sms_return = outcome != "false"
                device.sms_exception = outcome == "exception"
                device.receive(command())
                device.drive()
                if outcome == "async_error":
                    device.emit("SMS_SENT", False)
                elif outcome == "timeout":
                    device.advance(30000)
                    device.emit("SMS_SENT", True)
                self.assertEqual(device.record("cmd-001")["status"], "unknown")
                device.receive(command("cmd-002"))
                device.drive()
                self.assertEqual(device.record("cmd-002")["error"], "executor_blocked")
                self.assertEqual(len(device.sms_calls), 1)
                assert_private_logs_redacted(self, device)

    def test_traffic_queries_share_executor_and_cannot_steal_command_result(self):
        device = Harness()
        self.assertTrue(device.lua.eval(b'require("util_mobile").queryTraffic')())
        device.drive()
        device.receive(command())
        device.drive()
        self.assertEqual([call["to"] for call in device.sms_calls], ["10086"])
        device.emit("SMS_SENT", True)
        self.assertEqual(device.record("cmd-001")["state"], "intent")
        device.advance(1000)
        self.assertEqual([call["to"] for call in device.sms_calls], ["10086", "+8613800138000"])
        device.emit("SMS_SENT", True)
        self.assertEqual(device.record("cmd-001")["status"], "submitted")
        blocked = Harness()
        blocked.lua.eval(b'require("util_mobile").queryTraffic')()
        blocked.drive()
        blocked.receive(command())
        blocked.advance(30000)
        blocked.emit("SMS_SENT", True)
        self.assertEqual(len(blocked.sms_calls), 1)
        self.assertEqual(blocked.record("cmd-001")["error"], "executor_blocked")

    def test_executor_queue_is_bounded_and_queued_expiry_is_enforced(self):
        device = Harness()
        for index in range(9):
            device.receive(command(f"queued-{index}"))
        self.assertEqual(device.record("queued-8")["error"], "sms_queue_full")
        self.assertEqual(len(device.records()), 16)
        expired = Harness()
        expired.lua.eval(b'require("util_mobile").queryTraffic')()
        expired.drive()
        expired.receive(command(expires_at=EPOCH + 1))
        expired.advance(1000)
        expired.emit("SMS_SENT", True)
        expired.advance(1000)
        self.assertEqual(len(expired.sms_calls), 1)
        self.assertEqual(expired.record("cmd-001")["error"], "expired")
        ntp = Harness(clock=False)
        ntp.receive(command())
        ntp.drive()
        ntp.emit("SMS_SENT", True)
        ntp.epoch = EPOCH
        ntp.emit("NTP_UPDATE")
        self.assertEqual(ntp.sms_calls, [])
        self.assertEqual(ntp.record("cmd-001")["error"], "executor_blocked")

    def test_ownership_blocks_foreign_results_and_acks(self):
        device = Harness()
        device.receive(command(expires_at=EPOCH))
        device.drive()
        record = device.raw_record("cmd-001")
        device.client[b"scope"] = b"f" * 40
        self.assertIsNone(device.journal.nextResult(device.journal))
        self.assertFalse(device.journal.hasPending(device.journal))
        self.assertFalse(device.journal.ack(device.journal, record, b"cmd-001"))
        self.assertTrue(device.record("cmd-001")["pending"])

    def test_short_domestic_international_bmp500_and_invalid_utf8(self):
        device = Harness()
        validate = device.lua.eval(b'require("util_sms").validate')
        for number in (b"10086", b"13800138000", b"+441234567890"):
            self.assertTrue(validate(number, ("汉" * 500).encode()))
        for body in (("汉" * 501).encode(), b"\0", "😀".encode(), b"\xed\xa0\x80", b"\xff"):
            self.assertEqual(validate(b"10086", body), (False, b"invalid_content"))


class TransportTests(OfflineTestCase):
    def test_ready_events_carry_booleans_after_ready_tx_and_on_disconnect_reconnect(self):
        device = Harness(mode="transport")
        device.send_hello = False
        device.drive()
        self.assertEqual(device.ws_ready_events, [])
        device.tx_immediate = False
        device.push(hello())
        self.assertEqual(device.messages("ready"), [ready_frame()])
        self.assertFalse(device.transport[b"ready"])
        self.assertEqual(device.ws_ready_events, [])
        device.socket_event("TX_OK")
        self.assertTrue(device.transport[b"ready"])
        self.assertEqual(device.ws_ready_events, [True])
        device.tx_immediate = True
        device.send_hello = True
        device.push(b"", opcode=8)
        self.assertFalse(device.transport[b"ready"])
        self.assertEqual(device.ws_ready_events, [True, False])
        self.assertTrue(device.run_until(lambda: bool(device.transport[b"ready"])))
        self.assertEqual(device.ws_ready_events, [True, False, True])
        device.online = False
        device.socket_event("CLOSED")
        self.assertEqual(device.ws_ready_events, [True, False, True, False])
        self.assertTrue(all(type(ready) is bool for ready in device.ws_ready_events))

    def test_failed_ready_tx_never_publishes_true(self):
        device = Harness(mode="transport")
        device.send_hello = False
        device.drive()
        device.tx_full = True
        device.push(hello())
        self.assertFalse(device.transport[b"ready"])
        self.assertEqual(device.ws_ready_events, [False])

    def test_reconciled_hello_enables_exactly_16_ram_slots_and_zero_quarantine(self):
        device = Harness(mode="transport", ack_results=True)
        device.send_hello = False
        self.assertFalse(device.journal[b"available"])
        device.drive()
        self.assertFalse(device.transport[b"ready"])
        self.assertIsNone(device.receive(command("before-proof")))
        device.push(hello())
        self.assertTrue(device.transport[b"ready"])
        self.assertTrue(device.journal[b"available"])
        self.assertEqual(device.messages("ready"), [ready_frame()])
        for index in range(16):
            device.receive(command(f"expired-{index}", expires_at=EPOCH), over_ws=True)
        self.assertEqual(sum(record["state"] != "empty" for record in device.records()), 16)
        self.assertTrue(all(not record.get("pending", False) for record in device.records()))
        device.receive(command("over-16"), over_ws=True)
        self.assertEqual(device.messages("command_result")[-1]["error"], "journal_full")
        self.assertEqual(device.sms_calls, [])
        self.assertEqual(device.journal_status(), {"usable_slots": 16, "quarantined_slots": 0})

    def test_stale_session_commands_ignored_before_validation_allocation_or_results(self):
        device = Harness(mode="transport", ack_results=True)
        device.drive()
        old = command("old-session", session_id=NEXT_SESSION_ID)
        malformed = {**old, "op": "unsupported", "digest": "bad", "to": "invalid", "content": "😀"}
        for value in (old, malformed, {key: value for key, value in old.items() if key != "session_id"}):
            device.receive(value, over_ws=True)
        self.assertTrue(all(record["state"] == "empty" for record in device.records()))
        self.assertEqual(device.messages("command_result"), [])
        self.assertEqual(device.sms_calls, [])
        value = command()
        device.receive(value, over_ws=True)
        device.emit("SMS_SENT", True)
        snapshot = copy.deepcopy(device.record(value["id"]))
        count = len(device.messages("command_result"))
        device.receive(command(content="PRIVATE_STALE_CONFLICT", session_id=NEXT_SESSION_ID), over_ws=True)
        self.assertEqual(device.record(value["id"]), snapshot)
        self.assertEqual(len(device.messages("command_result")), count)
        self.assertEqual(len(device.sms_calls), 1)
        assert_private_logs_redacted(self, device, "PRIVATE_STALE_CONFLICT")

    def test_old_or_malformed_hello_never_authorizes_commands(self):
        cases = [{"type": "hello", "heartbeat_seconds": 60, "server_time": EPOCH}]
        for field in ("protocol_version", "device_id", "session_id", "reconciled", "heartbeat_seconds", "server_time"):
            cases.append({key: value for key, value in hello().items() if key != field})
        for field, bad in (("protocol_version", 1), ("protocol_version", "2"), ("reconciled", False),
                           ("reconciled", "true"), ("device_id", "auto~" + "c" * 43),
                           ("session_id", "S" * 42), ("session_id", "S" * 44), ("session_id", "?" * 43),
                           ("heartbeat_seconds", 59), ("heartbeat_seconds", 301), ("heartbeat_seconds", 60.5),
                           ("server_time", 1714499999), ("server_time", 4102444800), ("server_time", EPOCH + .5)):
            cases.append(hello(**{field: bad}))
        for index, message in enumerate(cases):
            with self.subTest(malformed_hello=index):
                device = Harness(mode="transport", hello_message=message)
                device.drive()
                self.assertFalse(device.transport[b"ready"])
                self.assertFalse(device.journal[b"available"])
                self.assertEqual(device.ws_ready_events, [False])
                self.assertEqual(device.messages("ready"), [])
                self.assertIsNone(device.receive(command()))
                device.drive()
                self.assertEqual(device.sms_calls, [])
                assert_private_logs_redacted(self, device)
        device = Harness(mode="transport")
        device.drive()
        device.push(hello(session_id=NEXT_SESSION_ID))
        self.assertFalse(device.transport[b"ready"])
        self.assertFalse(device.journal[b"available"])

    def test_identity_and_bearer_headers_reject_injection_and_keep_secrets_out_of_uri(self):
        device = Harness(mode="transport")
        request = device.lua.eval(b'require("util_ws").request')
        packet = request(device.client)[0]
        self.assertIn(b"\r\nX-Relay-Identity-Type: imei\r\n", packet)
        self.assertIn(b"\r\nX-Relay-Identity-Value: ", packet)
        self.assertNotIn(TOKEN.encode(), packet.split(b"\r\n", 1)[0])
        for field, bad in (("identity_type", "imei\r\nInjected: yes"), ("identity_value", "value\r\nInjected: yes"),
                           ("identity_value", "x" * 65), ("identity_value", " "),
                           ("token", "bad\r\nInjected: yes"), ("token", "bad token")):
            original = device.client[field.encode()]
            device.client[field.encode()] = bad.encode()
            self.assertIsNone(request(device.client))
            device.client[field.encode()] = original
        self.assertEqual(device.raw_tx, [])
        self.assertEqual(device.sockets, [])

    def test_tls_ca_domain_accept_and_coalesced_hello_remain_strict(self):
        device = Harness(mode="transport")
        device.drive()
        self.assertTrue(device.transport[b"ready"])
        self.assertEqual(device.connects, [("device.example.test", 443, False)])
        self.assertEqual(device.tls_configs[0]["ca"], CA)
        self.assertEqual(device.tls_configs[0]["keepalive"], (None, None, None))
        request = device.raw_tx[0]
        self.assertTrue(request.startswith(f"GET /prefix/api/v1/device/ws?device_id={AUTO_ID} HTTP/1.1\r\n".encode()))
        self.assertIn(b"Authorization: Bearer " + TOKEN.encode() + b"\r\n", request)
        self.assertNotIn(TOKEN.encode(), request.split(b"\r\n", 1)[0])
        self.assertNotIn(b"Bearer%20", request)
        self.assertEqual(device.messages("ready"), [ready_frame()])
        upgrade = device.lua.eval(b'require("util_ws").upgrade')
        response = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: checked\r\n"
        self.assertTrue(upgrade(response + b"Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n", b"checked"))
        self.assertEqual(upgrade(response + b"Sec-WebSocket-Accept: checked\r\n\r\n", b"checked"), (False, b"duplicate_header"))
        for failure in ({"tls_config": False}, {"tls_connect": False}, {"handshake": "wrong_accept"}):
            failed = Harness(mode="transport", **failure)
            failed.drive()
            self.assertFalse(failed.transport[b"ready"])
            self.assertEqual(failed.ws_ready_events, [False])
            self.assertEqual(failed.messages("ready"), [])
            if "handshake" not in failure:
                self.assertEqual(failed.raw_tx, [])

    def test_online_command_result_ack_keeps_tombstone_and_conflict_cannot_overwrite_it(self):
        device = Harness(mode="transport")
        device.drive()
        value = command()
        device.receive(value, over_ws=True)
        self.assertEqual(device.ms, 0)
        self.assertEqual(len(device.sms_calls), 1)
        device.emit("SMS_SENT", True)
        result = device.messages("command_result")[-1]
        self.assertEqual((result["command_id"], result["status"]), ("cmd-001", "submitted"))
        self.assertNotIn("to", result)
        self.assertNotIn("content", result)
        for ack in ({"command_id": "wrong"}, {"command_id": value["id"], "accepted": False}):
            device.push({"type": "command_result_ack", "ok": True, "accepted": True, **ack})
            self.assertTrue(device.record(value["id"])["pending"])
        device.push({"type": "command_result_ack", "ok": True, "accepted": True, "command_id": value["id"]})
        self.assertFalse(device.record(value["id"])["pending"])
        device.ack_results = True
        device.receive(command(content="不同正文"), over_ws=True)
        self.assertEqual(device.messages("command_result")[-1]["error"], "digest_conflict")
        self.assertEqual(device.record(value["id"])["status"], "submitted")
        self.assertFalse(device.record(value["id"])["pending"])
        device.receive(value, over_ws=True)
        self.assertFalse(device.record(value["id"])["pending"])
        self.assertEqual(len(device.sms_calls), 1)

    def test_result_timeout_reconnects_same_ram_state_without_sms_resend(self):
        device = Harness(mode="transport")
        device.drive()
        value = command()
        device.receive(value, over_ws=True)
        device.emit("SMS_SENT", True)
        device.advance(20000)
        self.assertFalse(device.transport[b"ready"])
        self.assertFalse(device.journal[b"available"])
        self.assertTrue(device.record(value["id"])["pending"])
        device.ack_results = True
        self.assertTrue(device.run_until(lambda: bool(device.transport[b"ready"]) and not device.record(value["id"])["pending"]))
        count = len(device.messages("command_result"))
        device.receive(value, over_ws=True)  # Old session is now stale.
        self.assertEqual(len(device.messages("command_result")), count)
        device.receive({**value, "session_id": device.session_id}, over_ws=True)
        self.assertEqual(len(device.sms_calls), 1)
        self.assertEqual(device.record(value["id"])["status"], "submitted")
        requests = [raw for raw in device.raw_tx if raw.startswith(b"GET ")]
        keys = [re.search(rb"Sec-WebSocket-Key: ([^\r]+)", raw).group(1) for raw in requests]
        self.assertGreaterEqual(len(keys), 2)
        self.assertEqual(len(keys), len(set(keys)))
        masks = [frame["mask"] for frame in device.frames]
        self.assertEqual(len(masks), len(set(masks)))

    def test_heartbeat_bounds_no_storage_polling_and_reconnect_backoff_cap(self):
        for interval in (60, 300):
            device = Harness(mode="transport", heartbeat=interval)
            device.drive()
            self.assertEqual(device.messages("ready"), [ready_frame(heartbeat_seconds=interval)])
            device.advance(interval * 1000 - 1)
            self.assertFalse(any(frame["payload"] == b"p" for frame in device.frames))
            device.advance(1)
            self.assertEqual(sum(frame["payload"] == b"p" for frame in device.frames), 1)
            self.assertEqual(device.storage_calls, [])
        failing = Harness(mode="transport", handshake="404")
        failing.drive()
        waits = []
        for _ in range(10):
            tasks = failing.lua.globals().sys.tasks
            due = [task[b"due"] for _, task in tasks.items() if task[b"due"] is not None and task[b"event"] is None]
            wait = min(due) - failing.ms
            waits.append(wait)
            failing.advance(wait)
        self.assertTrue(all(4000 <= wait <= 300000 for wait in waits))
        self.assertTrue(any(wait >= 200000 for wait in waits))
        lost_pong = Harness(mode="transport")
        lost_pong.auto_pong = False
        lost_pong.drive()
        lost_pong.advance(60000)
        lost_pong.advance(20000)
        self.assertFalse(lost_pong.transport[b"ready"])

    def test_scope_change_stops_old_credentials_commands_and_results(self):
        device = Harness(mode="integrated")
        device.drive()
        device.receive(command(), over_ws=True)
        device.cfg[b"SERVER_URL"] = b"https://different.example.test"
        device.emit("SMS_SENT", True)
        count = len(device.raw_tx)
        device.advance(300000)
        self.assertEqual(len(device.raw_tx), count)
        self.assertTrue(device.record("cmd-001")["pending"])
        self.assertFalse(device.transport[b"ready"])
        self.assertIsNone(device.receive(command("changed")))
        self.assertEqual(len(device.sms_calls), 1)

    def test_transient_rejection_queue_bounded_at_eight_without_growing_journal(self):
        device = Harness(mode="transport")
        device.drive()
        for index in range(100):
            value = command(f"reject-{index}")
            value["op"] = "unsupported"
            device.receive(value, over_ws=True)
        self.assertEqual(len(device.transport[b"transients"]), 8)
        self.assertTrue(all(record["state"] == "empty" for record in device.records()))
        self.assertEqual(device.sms_calls, [])
        device.ack_results = True
        self.assertTrue(device.run_until(lambda: bool(device.transport[b"ready"]) and len(device.transport[b"transients"]) == 0))

    def test_fragments_control_limits_utf8_mask_rejection_and_tick_wrap(self):
        device = Harness()
        decoder = device.lua.eval(b'require("util_ws").decoder')()
        text = "汉字测试".encode()
        first = server_frame(text[:4], fin=False)
        self.assertEqual(device.python(decoder.feed(decoder, first[:1])), {})
        self.assertEqual(device.python(decoder.feed(decoder, first[1:])), {})
        self.assertEqual(device.python(decoder.feed(decoder, server_frame(b"x", opcode=9))), [{"opcode": 9, "data": "x"}])
        self.assertEqual(device.python(decoder.feed(decoder, server_frame(text[4:], opcode=0) + server_frame("next"))),
                         [{"opcode": 1, "data": "汉字测试"}, {"opcode": 1, "data": "next"}])
        for raw in (server_frame("masked", masked=True), server_frame(b"\xff"), b"\x81\x7f",
                    server_frame(b"x", opcode=9, fin=False), server_frame(b"x" * 8193)):
            broken = device.lua.eval(b'require("util_ws").decoder')()
            result = broken.feed(broken, raw)
            self.assertIsInstance(result, tuple)
            self.assertIsNone(result[0])
        online = Harness(mode="transport")
        online.drive()
        online.push({"type": "command", "command": command()}, masked=True)
        self.assertFalse(online.transport[b"ready"])
        self.assertEqual(online.sms_calls, [])
        now = device.lua.eval(b'require("util_ws").now')
        self.assertEqual(now(), 0)
        for tick in (2**31 - 1, 2**31, 2**32 - 1, 2**32, 2**32 + 1):
            device.ms = tick
            self.assertEqual(now(), tick)

    def test_async_numeric_socket_events_tx_full_and_hello_timeout(self):
        failed = Harness(mode="transport")
        failed.connect_immediate = False
        failed.drive()
        self.assertEqual(failed.raw_tx, [])
        failed.socket_event("EVENT")
        self.assertEqual(failed.raw_tx, [])
        failed.socket_event("ON_LINE", -4)
        self.assertFalse(failed.transport[b"ready"])
        device = Harness(mode="transport")
        device.connect_immediate = device.tx_immediate = False
        device.drive()
        device.socket_event("ON_LINE")
        self.assertEqual(len(device.raw_tx), 1)
        device.socket_event("EVENT")
        self.assertFalse(device.transport[b"ready"])
        device.socket_event("TX_OK")
        self.assertEqual(len(device.messages("ready")), 1)
        self.assertFalse(device.transport[b"ready"])
        device.socket_event("TX_OK")
        self.assertTrue(device.transport[b"ready"])
        partial = Harness(mode="transport")
        partial.drive()
        partial.receive(command(), over_ws=True)
        partial.tx_full = True
        partial.emit("SMS_SENT", True)
        self.assertFalse(partial.transport[b"ready"])
        self.assertTrue(partial.record("cmd-001")["pending"])
        partial.tx_full = False
        partial.ack_results = True
        self.assertTrue(partial.run_until(lambda: bool(partial.transport[b"ready"]) and not partial.record("cmd-001")["pending"]))
        self.assertEqual(len(partial.sms_calls), 1)
        before = Harness(mode="transport")
        before.send_hello = False
        before.drive()
        before.receive(command(), over_ws=True)
        self.assertFalse(before.transport[b"ready"])
        self.assertEqual(before.sms_calls, [])
        timeout = Harness(mode="transport")
        timeout.send_hello = False
        timeout.drive()
        timeout.advance(15000)
        self.assertTrue(timeout.sockets[0]["closed"])
        self.assertFalse(timeout.transport[b"ready"])

    def test_authenticated_hello_time_prevents_expiry_with_stale_valid_rtc(self):
        device = Harness(mode="transport", ack_results=True)
        device.epoch = EPOCH - 86400
        device.drive()
        device.receive(command(expires_at=EPOCH - 1), over_ws=True)
        self.assertEqual(device.sms_calls, [])
        self.assertEqual(device.record("cmd-001")["error"], "expired")
        device.lua.eval(b'require("util_mobile").queryTraffic')()
        device.drive()
        device.receive(command("queued-expiry", expires_at=EPOCH + 1), over_ws=True)
        device.advance(2000)
        device.emit("SMS_SENT", True)
        device.advance(1000)
        self.assertEqual(len(device.sms_calls), 1)
        self.assertEqual(device.record("queued-expiry")["error"], "expired")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
