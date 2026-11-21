"""Exercise bounded RAM events, static authentication, no-LED startup, and POWERKEY offline.

All fskv/io APIs throw and every attempted call fails the suite, including swallowed calls.
The required device_auth module is always synthetic; never read per-device credentials,
production services, SIM state, or manifests. Mirror checks read only scoped public Lua files.
Run: python -I tests/verify_device.py --deps server/.wrangler/device-test-deps
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import ssl
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--deps", type=Path, default=ROOT / "server/.wrangler/device-test-deps")
args = parser.parse_args()
sys.path.insert(0, str(args.deps.resolve()))
sys.dont_write_bytecode = True  # Keep offline test runs from modifying harness cache files.
# -I excludes the script directory. Import only this explicit trusted offline harness.
sys.path.insert(0, str((ROOT / "tests").resolve()))
from verify_transport import (AUTO_ID, BASE, CA, EPOCH, NEXT_SESSION_ID, PRIVATE_ERROR,
                              SESSION_ID, TOKEN, Harness, OfflineTestCase,
                              assert_private_logs_redacted, auto_id, command, hello,
                              ready_frame, static_auth)


class Device(Harness):
    def __init__(self, *, ack_events=True, **kwargs):
        super().__init__(mode="integrated", ack_events=ack_events, **kwargs)

    def add(self, kind="sms.received", content="PRIVATE_EVENT_FIXTURE"):
        return self.add_event(kind, content)

    def queued(self):
        return self.queue_status()["queued"]

    def is_ready(self):
        return self.transport is not None and bool(self.transport[b"ready"])


class DeviceQueueTests(OfflineTestCase):
    def test_offline_ram_queue_then_prepared_ws_enrollment(self):
        device = Device(online=False)
        self.assertTrue(device.add("device.boot"))
        self.assertTrue(device.add())
        self.assertEqual(device.queued(), 2)
        device.drive()
        self.assertEqual(device.requests, [])
        self.assertEqual(device.sockets, [])
        self.assertFalse(device.journal[b"available"])
        self.assertIsNone(device.client[b"device_id"])
        device.online = True
        device.emit("IP_READY")
        self.assertTrue(device.is_ready())
        self.assertEqual(device.queued(), 0)
        self.assertEqual(device.messages("ready"), [ready_frame()])
        events = device.messages("event")
        self.assertEqual([message["event"]["type"] for message in events], ["sms.received", "device.boot"])
        for message in events:
            self.assertEqual(message["event"]["device_id"], AUTO_ID)
            self.assertFalse(message.get("recovered", False))
            self.assertNotIn("_server_scope", message["event"])
            self.assertNotIn("recovered", message["event"])
        assert_private_logs_redacted(self, device, "PRIVATE_EVENT_FIXTURE")

    def test_queue_32_priority_reserve_24_overflow_rejected_without_growth(self):
        device = Device(online=False)
        self.assertEqual(device.queue_status(), {"queued": 0, "capacity": 32, "priority_reserve": 24, "max_body_bytes": 4095})
        for _ in range(8):
            self.assertTrue(device.add("device.heartbeat"))
        for _ in range(50):
            self.assertFalse(device.add("device.heartbeat"))
        for _ in range(24):
            self.assertTrue(device.add())
        self.assertEqual(device.queued(), 32)
        for kind in ("device.heartbeat", "sms.received", "call.incoming", "call.disconnected"):
            for _ in range(50):
                self.assertFalse(device.add(kind))
        self.assertEqual(device.queued(), 32)
        self.assertEqual(len(device.records()), 16)
        device.drive()
        device.online = True
        device.emit("IP_READY")
        events = device.messages("event")
        self.assertEqual(len(events), 32)
        self.assertTrue(all(message["event"]["type"] == "sms.received" for message in events[:24]))
        self.assertTrue(all(message["event"]["type"] == "device.heartbeat" for message in events[24:]))
        self.assertEqual(device.queued(), 0)
        self.assertTrue(device.add("device.heartbeat"))
        device.drive()
        self.assertEqual(device.queued(), 0)

    def test_important_events_alone_fill_all_32_without_eviction(self):
        device = Device(online=False)
        for index in range(32):
            self.assertTrue(device.add("call.incoming", str(index)))
        self.assertFalse(device.add())
        self.assertFalse(device.add("device.test"))
        self.assertEqual(device.queued(), 32)
        device.drive()
        device.online = True
        device.emit("IP_READY")
        self.assertEqual([message["event"]["data"]["reason"] for message in device.messages("event")],
                         [str(index) for index in range(32)])

    def test_event_body_exact_4095_bytes_and_utf8_overflow_are_bounded(self):
        device = Device(online=False)
        exemplar = {"version": 1, "device_id": AUTO_ID,
                    "event_id": "ev1h-" + "0" * 10 + "-" + "0" * 24, "type": "sms.received",
                    "occurred_at": EPOCH, "data": {"sender": "offline", "content": ""}}
        overhead = len(json.dumps(exemplar, ensure_ascii=False, separators=(",", ":")).encode())
        length = 4095 - overhead
        self.assertFalse(device.add(content="x" * (length + 1)))
        self.assertFalse(device.add(content="汉" * (length // 3 + 1)))
        self.assertEqual(device.queued(), 0)
        self.assertTrue(device.add(content="x" * length))
        device.drive()
        device.online = True
        device.emit("IP_READY")
        event = device.messages("event")[0]["event"]
        self.assertEqual(len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()), 4095)
        self.assertEqual(device.queued(), 0)

    def test_event_arguments_and_encode_failure_rejected_without_retaining_or_leaking_data(self):
        device = Device()
        device.drive()
        for args_ in ((b"legacy", device.table({}), None, EPOCH),
                      (b"sms.received", b"not-a-table", None, EPOCH),
                      (b"sms.received", device.table({}), b"not-a-table", EPOCH),
                      (b"sms.received", device.table({}), None, EPOCH + .5),
                      (b"sms.received", device.table({}), None, b"bad-time")):
            self.assertFalse(device.notify.add(*args_))
        device.fail_encode = lambda value: isinstance(value, dict) and "event_id" in value
        self.assertFalse(device.add())
        self.assertEqual(device.queued(), 0)
        device.drive()
        self.assertEqual(device.messages("event"), [])
        self.assertTrue(device.logs)
        assert_private_logs_redacted(self, device, "PRIVATE_EVENT_FIXTURE")

    def test_event_snapshot_preserves_original_data_status_and_timestamp(self):
        device = Device(online=False)
        data = device.table({"sender": "offline", "content": "PRIVATE_EVENT_FIXTURE", "sim_slot": 0})
        status = device.table({"number": "PRIVATE_STATUS_FIXTURE", "rsrp_dbm": -95,
                               "traffic": {"uplink_bytes": 2147483648}})
        self.assertTrue(device.notify.add(b"sms.received", data, status, EPOCH))
        data[b"content"], status[b"number"] = b"changed-after-enqueue", b"changed-after-enqueue"
        device.drive()
        device.online = True
        device.emit("IP_READY")
        event = device.messages("event")[0]["event"]
        self.assertEqual(event["data"]["content"], "PRIVATE_EVENT_FIXTURE")
        self.assertEqual(event["status"]["number"], "PRIVATE_STATUS_FIXTURE")
        self.assertEqual(event["status"]["traffic"]["uplink_bytes"], 2147483648)
        self.assertEqual(event["occurred_at"], EPOCH)
        assert_private_logs_redacted(self, device, "PRIVATE_EVENT_FIXTURE", "PRIVATE_STATUS_FIXTURE", "changed-after-enqueue")

    def test_matching_ack_deletes_only_ram_and_frees_capacity_without_resend(self):
        device = Device(ack_events=False)
        self.assertTrue(device.add())
        device.drive()
        event = device.messages("event")[0]["event"]
        for fields in ({"event_id": "wrong"}, {"event_id": event["event_id"], "accepted": False},
                       {"event_id": event["event_id"], "ok": False}):
            device.push({"type": "event_ack", "ok": True, "accepted": True, **fields})
            self.assertEqual(device.queued(), 1)
        device.push({"type": "event_ack", "ok": True, "accepted": True, "event_id": event["event_id"]})
        self.assertEqual(device.queued(), 0)
        device.advance(60000)
        self.assertEqual(len(device.messages("event")), 1)
        self.assertTrue(device.add())
        self.assertEqual(device.queued(), 1)
        self.assertEqual(device.storage_calls, [])

    def test_lost_ack_same_boot_reconnect_reuses_exact_id_body_and_static_token(self):
        device = Device(ack_events=False)
        self.assertTrue(device.add())
        device.drive()
        original = device.messages("event")[0]
        device.advance(20000)
        self.assertEqual(device.queued(), 1)
        self.assertFalse(device.is_ready())
        device.ack_events = True
        self.assertTrue(device.run_until(lambda: device.is_ready() and device.queued() == 0))
        self.assertGreaterEqual(len(device.messages("event")), 2)
        self.assertTrue(all(message == original for message in device.messages("event")))
        self.assertTrue(all(request["headers"]["Authorization"] == "Bearer " + TOKEN for request in device.requests))
        self.assertEqual(device.auth_requires, 1)
        assert_private_logs_redacted(self, device, "PRIVATE_EVENT_FIXTURE")

    def test_ram_ownership_never_rebinds_to_changed_destination_or_device(self):
        for field, changed in (("scope", b"f" * 40), ("device_id", b"auto~" + b"c" * 43)):
            with self.subTest(field=field):
                device = Device(ack_events=False)
                self.assertTrue(device.add())
                device.drive()
                original = device.messages("event")[0]
                device.client[field.encode()] = changed
                device.emit("DEVICE_TRANSPORT_WAKE")
                device.advance(300000)
                self.assertEqual(device.messages("event"), [original])
                self.assertEqual(device.queued(), 1)
                self.assertFalse(device.is_ready())
                self.assertEqual(len(device.requests), 1)
                self.assertEqual(device.auth_requires, 1)

    def test_permanent_event_rejection_drops_ram_record_without_quarantine_or_blocking_others(self):
        for code in (400, 413, 415, 422):
            with self.subTest(code=code):
                device = Device(ack_events=False)
                self.assertTrue(device.add(content="PRIVATE_REJECTED_EVENT"))
                self.assertTrue(device.add(content="PRIVATE_NEXT_EVENT"))
                device.drive()
                event = device.messages("event")[0]["event"]
                device.ack_events = True
                device.push({"type": "error", "event_id": event["event_id"], "code": code})
                self.assertEqual(device.queued(), 0)
                self.assertEqual(len(device.messages("event")), 2)
                self.assertEqual(device.messages("event")[-1]["event"]["data"]["content"], "PRIVATE_NEXT_EVENT")
                self.assertEqual(device.journal_status(), {"usable_slots": 16, "quarantined_slots": 0})
                assert_private_logs_redacted(self, device, "PRIVATE_REJECTED_EVENT", "PRIVATE_NEXT_EVENT")

    def test_boot_nonce_is_trng_only_and_event_ids_are_unique_within_boot(self):
        device = Device(online=False)
        for _ in range(5):
            self.assertTrue(device.add())
        self.assertEqual(device.random_lengths, [12])
        device.drive()
        device.online = True
        device.emit("IP_READY")
        ids = [message["event"]["event_id"] for message in device.messages("event")]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(re.fullmatch(r"ev1h-\d{10}-[a-f0-9]{24}", value) for value in ids))
        self.assertEqual(len({value.rsplit("-", 1)[1] for value in ids}), 1)
        self.assertEqual([int(value.split("-")[1]) for value in ids], list(range(1, 6)))
        self.assertNotIn(32, device.random_lengths, "Authentication must never generate a runtime token")
        blocked = Device(online=False, secure_random=False)
        self.assertFalse(blocked.add())
        self.assertEqual(blocked.queued(), 0)
        self.assertEqual(blocked.storage_calls, [])
        blocked.secure_random = True
        self.assertTrue(blocked.add())
        self.assertEqual(blocked.queued(), 1)

    def test_boot_sequence_rejects_overflow_before_32bit_integer_wrap(self):
        device = Device(online=False)
        device.lua.execute(b'''
            local add = require("util_notify").add
            local found = false
            for index=1,32 do
                local name = debug.getupvalue(add, index)
                if name == "sequence" then
                    debug.setupvalue(add, index, 2147483646)
                    found = true
                    break
                end
            end
            assert(found, "Test must reach the real RAM sequence")
        ''')
        self.assertTrue(device.add())
        self.assertFalse(device.add())
        self.assertEqual(device.queued(), 1)
        device.drive()
        device.online = True
        device.emit("IP_READY")
        self.assertTrue(device.messages("event")[0]["event"]["event_id"].startswith("ev1h-2147483647-"))
        self.assertEqual(device.queued(), 0)
        self.assertFalse(device.add())

    def test_missing_short_or_throwing_trng_has_no_kv_or_time_fallback(self):
        for replacement in (b"nil", b"function() return 'short' end", b"function() error('PRIVATE_OFFLINE_EXCEPTION_DETAIL') end"):
            device = Device(online=False)
            device.lua.execute(b"crypto.trng=" + replacement)
            self.assertFalse(device.add())
            self.assertEqual(device.queued(), 0)
            self.assertEqual(device.storage_calls, [])
            assert_private_logs_redacted(self, device)

    def test_restart_drops_offline_and_inflight_ram_events_and_uses_new_boot_nonce(self):
        for online in (False, True):
            with self.subTest(online=online):
                old = Device(online=online, ack_events=False)
                self.assertTrue(old.add())
                old.drive()
                self.assertEqual(old.queued(), 1)
                if not online:
                    old.online = True
                    old.emit("IP_READY")
                old_event = old.messages("event")[0]["event"]
                restarted = Device(session_id=NEXT_SESSION_ID)
                self.assertEqual(restarted.queued(), 0)
                self.assertTrue(all(record["state"] == "empty" for record in restarted.records()))
                restarted.drive()
                self.assertTrue(restarted.is_ready())
                self.assertEqual(restarted.messages("event"), [])
                self.assertTrue(restarted.add())
                restarted.drive()
                fresh = restarted.messages("event")[0]
                self.assertNotEqual(fresh["event"]["event_id"], old_event["event_id"])
                self.assertFalse(fresh.get("recovered", False))
                self.assertEqual(fresh["event"]["device_id"], old_event["device_id"])
                self.assertEqual(restarted.queued(), 0)

    def test_hello_loss_reconnect_and_ready_wakeup_do_not_poll_or_reinitialize_queue(self):
        device = Device()
        device.send_hello = False
        self.assertTrue(device.add("device.boot"))
        self.assertTrue(device.add())
        device.drive()
        tasks = len(device.lua.globals().sys.tasks)
        self.assertFalse(device.is_ready())
        self.assertEqual(device.messages("event"), [])
        self.assertEqual(device.queued(), 2)
        device.notify.init()
        self.assertEqual(len(device.lua.globals().sys.tasks), tasks)
        self.assertEqual(device.queued(), 2)
        device.push(hello())
        self.assertTrue(device.is_ready())
        self.assertEqual(device.ms, 0)
        self.assertEqual(len(device.messages("event")), 2)
        self.assertEqual(device.queued(), 0)
        self.assertTrue(all(not message.get("recovered", False) for message in device.messages("event")))

    def test_upgrade_failure_retains_ram_events_until_reconciled_hello(self):
        device = Device(handshake="404")
        self.assertTrue(device.add())
        device.drive()
        self.assertFalse(device.is_ready())
        self.assertFalse(device.journal[b"available"])
        self.assertEqual(device.messages("event"), [])
        self.assertEqual(device.queued(), 1)
        self.assertIsNone(device.receive(command()))
        device.handshake = "valid"
        self.assertTrue(device.run_until(device.is_ready))
        self.assertEqual(device.queued(), 0)
        self.assertEqual(len(device.messages("event")), 1)
        self.assertEqual(device.sms_calls, [])

    def test_ca_override_shared_by_event_and_result_reconnections(self):
        override = re.search(rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", CA, re.S).group(0) + b"\n"
        device = Device(ca=override, ack_events=False)
        device.drive()
        self.assertTrue(device.add())
        device.drive()
        original = device.messages("event")[0]
        device.advance(20000)
        device.ack_events = True
        self.assertTrue(device.run_until(lambda: device.is_ready() and device.queued() == 0))
        self.assertEqual(device.messages("event")[-1], original)
        value = command(session_id=device.session_id)
        device.receive(value, over_ws=True)
        device.emit("SMS_SENT", True)
        self.assertTrue(device.record(value["id"])["pending"])
        device.push(b"", opcode=8)
        self.assertFalse(device.journal[b"available"])
        device.ack_results = True
        self.assertTrue(device.run_until(lambda: device.is_ready() and not device.record(value["id"])["pending"]))
        self.assertTrue(all(config["ca"] == override for config in device.tls_configs))
        device.receive({**value, "session_id": device.session_id}, over_ws=True)
        self.assertEqual(len(device.sms_calls), 1)

    def test_bind_encoding_failure_retries_same_boot_without_storage_or_unbounded_copy(self):
        device = Device(online=False)
        self.assertTrue(device.add())
        device.fail_encode = lambda value: isinstance(value, dict) and value.get("device_id") == AUTO_ID
        device.drive()
        device.online = True
        device.emit("IP_READY")
        self.assertTrue(device.is_ready())
        self.assertEqual(device.messages("event"), [])
        self.assertEqual(device.queued(), 1)
        device.fail_encode = None
        device.advance(5000)
        self.assertEqual(len(device.messages("event")), 1)
        self.assertEqual(device.queued(), 0)
        assert_private_logs_redacted(self, device, "PRIVATE_EVENT_FIXTURE")


class StaticAuthenticationTests(OfflineTestCase):
    def test_required_static_auth_prepares_exact_ws_client_and_never_generates_credentials(self):
        for token in (TOKEN, "Z" * 43):
            with self.subTest(static_token=True):
                device = Device(auth=static_auth(token=token))
                self.assertIsNone(device.client[b"device_id"])
                self.assertIsNone(device.client[b"token"])
                device.drive()
                self.assertTrue(device.is_ready())
                self.assertEqual(device.auth_requires, 1)
                self.assertTrue(device.client[b"device_id"].decode() == AUTO_ID)
                headers = device.requests[0]["headers"]
                self.assertTrue(headers["Authorization"] == "Bearer " + token)
                self.assertEqual(headers["X-Relay-Identity-Type"], "imei")
                self.assertTrue(headers["X-Relay-Identity-Value"] == "012345678901234")
                self.assertNotIn(32, device.random_lengths)
                assert_private_logs_redacted(self, device, token)
        self.assertEqual(auto_id("imei", "012345678901234"), AUTO_ID)

    def test_canonical_server_url_must_equal_static_binding(self):
        canonical = Device(base="https://DEVICE.EXAMPLE.TEST:443/prefix///")
        canonical.drive()
        self.assertTrue(canonical.is_ready())
        self.assertEqual(canonical.client[b"base"].decode(), BASE)
        self.assertEqual(canonical.connects, [("device.example.test", 443, False)])
        for changes in ({"base": "https://other.example.test"},
                        {"auth": static_auth(server_url=BASE + "/")},
                        {"auth": static_auth(server_url="https://DEVICE.EXAMPLE.TEST:443/prefix")},
                        {"base": "http://device.example.test"}, {"base": "https://127.0.0.1"},
                        {"base": "https://user@device.example.test"}, {"base": BASE + "?bad=1"},
                        {"base": BASE + "#fragment"}, {"base": BASE + "\\evil"},
                        {"base": "https://device.example.test:0"}, {"ca": b"not-a-certificate"}):
            with self.subTest(unsafe_url_or_ca=True):
                device = Device(**changes)
                self.assertTrue(device.add())
                device.drive()
                self.assertFalse(device.is_ready())
                self.assertEqual(device.requests, [])
                self.assertEqual(device.sockets, [])
                self.assertEqual(device.queued(), 1)
                assert_private_logs_redacted(self, device)

    def test_invalid_or_missing_static_fields_fail_closed_without_aliases_or_regeneration(self):
        invalid = [None, False, 123, "not-a-table", {}]
        for key in ("server_url", "identity_type", "identity_value", "token"):
            invalid.append({name: value for name, value in static_auth().items() if name != key})
        for value in ("", "x" * 42, "x" * 44, "?" * 43, "汉" * 43, "x" * 42 + " ", "x\r\nInjected: yes"):
            invalid.append(static_auth(token=value))
        for field, value in (("identity_type", "IMEI"), ("identity_type", "imsi"),
                             ("identity_type", "imei\r\nInjected: yes"), ("identity_value", "000000000000000"),
                             ("identity_value", "123"), ("identity_value", " 012345678901234 "),
                             ("identity_value", 123456789012345)):
            invalid.append(static_auth(**{field: value}))
        aliases = static_auth()
        aliases["token43"] = aliases.pop("token")
        invalid.append(aliases)
        for index, auth in enumerate(invalid):
            with self.subTest(invalid_static_fixture=index):
                device = Device(auth=auth)
                self.assertTrue(device.add())
                device.drive()
                self.assertFalse(device.is_ready())
                self.assertEqual(device.requests, [])
                self.assertEqual(device.sockets, [])
                self.assertEqual(device.imei_reads + device.sn_reads, 0)
                self.assertEqual(device.auth_requires, 1)
                self.assertNotIn(32, device.random_lengths)
                self.assertEqual(device.queued(), 1)
                assert_private_logs_redacted(self, device)

    def test_missing_required_module_raises_without_reading_secret_or_storage(self):
        device = Harness()
        def missing_module():
            raise RuntimeError("Synthetic missing required module")
        device.lua.globals()[b"PY_auth"] = missing_module
        with self.assertRaises(RuntimeError):
            device.lua.eval(b'require("util_notify")')
        self.assertEqual(device.requests, [])
        self.assertEqual(device.storage_calls, [])
        self.assertNotIn("device_auth", device.source_reads)
        self.assertNotIn(32, device.random_lengths)

    def test_actual_modem_identity_mismatch_never_connects_or_falls_back(self):
        for options in ({"imei": "999999999999999"}, {"imei": None}, {"imei": "000000000000000"},
                        {"imei": "invalid"}, {"imei": "01234567890123"}):
            with self.subTest(identity_unmatched=True):
                device = Device(**options)
                self.assertTrue(device.add())
                device.drive()
                device.advance(5000)
                device.advance(10000)
                self.assertFalse(device.is_ready())
                self.assertEqual(device.requests, [])
                self.assertEqual(device.sockets, [])
                self.assertEqual(device.sn_reads, 0, "Static IMEI selection must never silently fall back to SN")
                self.assertEqual(device.queued(), 1)
                self.assertNotIn(32, device.random_lengths)
                assert_private_logs_redacted(self, device, "999999999999999")
        sn = Device(auth=static_auth(identity_type="sn", identity_value="SN-001"), sn="SN-OTHER")
        sn.drive()
        self.assertFalse(sn.is_ready())
        self.assertEqual(sn.imei_reads, 0)
        self.assertEqual(sn.requests, [])

    def test_only_expected_identity_is_retried_and_actual_imei_sn_are_normalized(self):
        waiting = Device(imei=None)
        waiting.drive()
        self.assertFalse(waiting.is_ready())
        self.assertEqual(waiting.sn_reads, 0)
        waiting.imei = " 012345678901234\r\n"
        self.assertTrue(waiting.run_until(waiting.is_ready))
        self.assertEqual(waiting.requests[0]["headers"]["X-Relay-Identity-Value"], "012345678901234")
        sn_auth = static_auth(identity_type="sn", identity_value="SN-001")
        sn = Device(auth=sn_auth, sn="  sn-001\r\n")
        sn.drive()
        self.assertTrue(sn.is_ready())
        self.assertEqual(sn.imei_reads, 0)
        self.assertEqual(sn.client[b"device_id"].decode(), auto_id("sn", "SN-001"))
        self.assertEqual(sn.requests[0]["headers"]["X-Relay-Identity-Value"], "SN-001")
        malformed = Device(auth=static_auth(identity_type="sn", identity_value="sn-001"))
        malformed.drive()
        self.assertFalse(malformed.is_ready(), "Provisioned identity must already be canonical")
        assert_private_logs_redacted(self, sn, "SN-001")

    def test_modem_read_exception_is_sanitized_and_reconnect_rechecks_identity(self):
        device = Device()
        device.identity_exception = True
        device.drive()
        self.assertFalse(device.is_ready())
        self.assertEqual(device.requests, [])
        assert_private_logs_redacted(self, device)
        device.identity_exception = False
        self.assertTrue(device.run_until(device.is_ready))
        reads = device.imei_reads
        device.imei = "999999999999999"
        device.push(b"", opcode=8)
        device.advance(5000)
        device.advance(10000)
        self.assertFalse(device.is_ready())
        self.assertGreater(device.imei_reads, reads)
        self.assertEqual(len(device.requests), 1)
        self.assertNotIn(32, device.random_lengths)

    def test_static_or_runtime_client_tampering_never_regenerates_or_retargets(self):
        for target, field, value in (("auth", "token", "Z" * 43), ("auth", "server_url", "https://other.example.test"),
                                     ("auth", "identity_value", "999999999999999"),
                                     ("client", "token", "Z" * 43), ("config", "SERVER_URL", "https://other.example.test")):
            with self.subTest(target=target, field=field):
                device = Device(ack_events=False)
                self.assertTrue(device.add())
                device.drive()
                table = device.auth if target == "auth" else device.client if target == "client" else device.cfg
                table[field.encode()] = value.encode()
                device.emit("DEVICE_TRANSPORT_WAKE")
                device.notify.init()
                device.advance(300000)
                self.assertFalse(device.is_ready())
                self.assertEqual(len(device.requests), 1)
                self.assertEqual(device.auth_requires, 1)
                self.assertEqual(device.queued(), 1)
                self.assertNotIn(32, device.random_lengths)
                assert_private_logs_redacted(self, device, value if field == "token" else "999999999999999")

    def test_fixed_token_and_auto_id_are_same_across_restart_but_no_ram_state_is_restored(self):
        old = Device(ack_events=False)
        self.assertTrue(old.add())
        old.drive()
        restarted = Device(session_id=NEXT_SESSION_ID)
        restarted.drive()
        self.assertEqual(old.requests[0]["device_id"], restarted.requests[0]["device_id"])
        self.assertTrue(old.requests[0]["headers"]["Authorization"] == restarted.requests[0]["headers"]["Authorization"])
        self.assertEqual(restarted.messages("event"), [])
        self.assertEqual(restarted.queued(), 0)
        self.assertEqual(restarted.storage_calls, [])


class NoLedRegressionTests(OfflineTestCase):
    def assert_no_gpio(self, device):
        self.assertEqual(device.gpio_setups, [])
        self.assertEqual(device.gpio_writes, [])
        self.assertEqual(device.gpio_reads, [])
        self.assertEqual(device.gpio_levels, {})
        self.assertNotIn("util_netled", device.source_reads)
        self.assertNotIn("NET灯", json.dumps(device.logs, ensure_ascii=False))

    def test_offline_boot_and_network_notifications_never_touch_led_gpio_or_poll_status(self):
        for initial in (0, 1, 8, None):
            with self.subTest(registration=initial):
                device = Harness(mode="main", online=False, registration=initial)
                self.assert_no_gpio(device)  # Include synchronous startup before tasks run.
                status_reads = device.registration_reads
                device.drive()
                for elapsed in (1000, 1000, 3200, 300000):
                    device.advance(elapsed)
                    self.assert_no_gpio(device)
                for state in (*range(11), None):
                    device.registration = state
                    device.emit("NET_STATE")
                    device.emit("DEVICE_WS_READY", True)
                    device.emit("DEVICE_WS_READY", False)
                    device.emit("IP_LOSE")
                    device.emit("IP_READY")
                    device.advance(1000)
                    self.assert_no_gpio(device)
                self.assertEqual(device.registration_reads, status_reads, "No LED registration polling remains")
                self.assertEqual(device.queue_status()["queued"], 1)
                self.assertEqual(device.requests, [])
                self.assertEqual(device.sockets, [])
                self.assertEqual(device.sms_calls, [])
                assert_private_logs_redacted(self, device)

    def test_main_wss_ready_upload_results_sms_and_reconnect_work_without_gpio(self):
        device = Harness(mode="main", ack_events=True)
        device.send_hello = False
        device.drive()
        self.assertFalse(device.transport[b"ready"])
        self.assertEqual(device.ws_ready_events, [])
        self.assertEqual(device.messages("event"), [])
        self.assertEqual(device.queue_status()["queued"], 1)
        self.assert_no_gpio(device)
        device.tx_immediate = False
        device.push(hello())
        self.assertEqual(device.messages("ready"), [ready_frame()])
        self.assertFalse(device.transport[b"ready"])
        self.assertEqual(device.ws_ready_events, [])
        self.assert_no_gpio(device)
        device.tx_immediate = True
        device.socket_event("TX_OK")
        self.assertTrue(device.transport[b"ready"])
        self.assertEqual(device.ws_ready_events, [True])
        self.assertEqual(device.messages("event")[0]["event"]["type"], "device.boot")
        self.assertEqual(device.queue_status()["queued"], 0)
        device.receive(command(session_id=device.session_id), over_ws=True)
        device.emit("SMS_SENT", True)
        self.assertEqual(device.record("cmd-001")["status"], "submitted")
        self.assertTrue(device.record("cmd-001")["pending"])
        self.assert_no_gpio(device)
        device.send_hello = True
        device.push(b"", opcode=8)
        self.assertFalse(device.transport[b"ready"])
        self.assertEqual(device.ws_ready_events, [True, False])
        device.ack_results = True
        self.assertTrue(device.run_until(lambda: bool(device.transport[b"ready"]) and not device.record("cmd-001")["pending"]))
        self.assertEqual(device.ws_ready_events, [True, False, True])
        self.assertEqual(len(device.sms_calls), 1, "Reconnect must report the RAM result, not resend SMS")
        self.assertGreaterEqual(len(device.messages("command_result")), 2)
        self.assert_no_gpio(device)
        device.online = False
        device.socket_event("CLOSED")
        self.assertEqual(device.ws_ready_events, [True, False, True, False])
        device.lua.globals()[b"NEW_SMS"](b"10086", b"PRIVATE_RECONNECT_INBOUND", None)
        device.drive()
        self.assertEqual(device.queue_status()["queued"], 1)
        device.registration = 0
        device.emit("NET_STATE")
        self.assert_no_gpio(device)
        device.registration = 5
        device.emit("NET_STATE")
        device.online = True
        device.emit("IP_READY")
        self.assertTrue(device.run_until(lambda: bool(device.transport[b"ready"]) and device.queue_status()["queued"] == 0))
        self.assertEqual(device.ws_ready_events, [True, False, True, False, True])
        inbound = device.messages("event")[-1]["event"]
        self.assertEqual(inbound["type"], "sms.received")
        self.assertEqual(inbound["data"]["content"], "PRIVATE_RECONNECT_INBOUND")
        self.assert_no_gpio(device)
        assert_private_logs_redacted(self, device, "PRIVATE_RECONNECT_INBOUND")

    def test_supported_bsp_powerkey_input_short_debounce_and_long_press_are_preserved(self):
        for bsp, pin in (("EC618", 35), ("EC718P", 46)):
            with self.subTest(bsp=bsp, pin=pin):
                device = Harness(mode="main", bsp=bsp, online=False, ack_events=True)
                expected_setup = [(0, pin, "interrupt", 1)]
                self.assertEqual(device.gpio_setups, expected_setup)
                self.assertEqual(device.gpio_levels, {pin: 1})
                self.assertEqual(device.gpio_reads, [])
                self.assertEqual(device.gpio_writes, [])
                device.drive()
                device.advance(3000)
                self.assertEqual(device.ws_ready_events, [False], "Offline startup publishes the existing not-ready signal")
                device.online = True
                device.emit("IP_READY")
                self.assertTrue(device.transport[b"ready"])
                self.assertEqual(device.ws_ready_events, [False, True])
                self.assertEqual(device.gpio_reads, [], "Network readiness must not read the POWERKEY or LED pins")
                device.trigger_gpio_input(pin, 1)  # A release without a press is ignored.
                self.assertEqual(device.powerkey_events, [])
                device.advance(300)
                device.trigger_gpio_input(pin, 0)
                device.advance(100)
                device.trigger_gpio_input(pin, 1)
                self.assertEqual(device.powerkey_events, [("POWERKEY_SHORT_PRESS", 100)])
                event = device.messages("event")[-1]["event"]
                self.assertEqual(event["type"], "device.test")
                self.assertEqual(event["data"], {"reason": "powerkey"})
                device.advance(50)
                device.trigger_gpio_input(pin, 0)
                device.advance(100)
                device.trigger_gpio_input(pin, 1)  # Within 250 ms of the previous release.
                self.assertEqual(device.powerkey_events, [("POWERKEY_SHORT_PRESS", 100)])
                device.advance(300)
                device.trigger_gpio_input(pin, 0)
                device.advance(2001)
                device.trigger_gpio_input(pin, 1)
                self.assertEqual(device.powerkey_events, [("POWERKEY_SHORT_PRESS", 100), ("POWERKEY_LONG_PRESS", 2001)])
                self.assertEqual([(call["to"], call["content"]) for call in device.sms_calls], [("10086", "CXLL")])
                device.emit("SMS_SENT", True)
                input_reads = list(device.gpio_reads)
                self.assertEqual(len(input_reads), 7)
                self.assertTrue(all(read_pin == pin for _, read_pin in input_reads))
                device.push(b"", opcode=8)
                self.assertTrue(device.run_until(lambda: bool(device.transport[b"ready"])))
                self.assertEqual(device.ws_ready_events, [False, True, False, True])
                self.assertEqual(device.gpio_setups, expected_setup)
                self.assertEqual(device.gpio_reads, input_reads)
                self.assertEqual(device.gpio_writes, [], "POWERKEY remains an input; no LED outputs are configured")
                self.assertEqual(device.gpio_levels, {pin: 1})
                self.assertNotIn("util_netled", device.source_reads)
                assert_private_logs_redacted(self, device)

    def test_mobile_status_and_event_snapshots_remain_without_led_classifier(self):
        device = Harness(online=False)
        mobile_util = device.lua.eval(b'require("util_mobile")')
        self.assertIsNone(mobile_util[b"isRegistered"])
        states = ("网络未注册", "网络已注册", "网络搜索中", "网络注册被拒绝", "网络状态未知",
                  "网络已注册,漫游", "网络已注册,仅SMS", "网络已注册,漫游,仅SMS", "网络已注册,紧急服务",
                  "网络已注册,非主要服务", "网络已注册,非主要服务,漫游")
        for state, description in enumerate(states):
            with self.subTest(state=state):
                device.registration = state
                self.assertEqual(mobile_util.status().decode(), description)
                self.assertEqual(device.python(mobile_util.eventStatus())["network_state"], description)
        for state in (None, -1, 11):
            device.registration = state
            self.assertEqual(mobile_util.status().decode(), "未知网络状态")
            self.assertIsNone(mobile_util.eventStatus()[b"network_state"])
        self.assert_no_gpio(device)

    def test_http_wrapper_success_and_exception_remain_offline_and_have_no_led_dependency(self):
        device = Harness(online=False)
        device.lua.execute(b'''
            HTTP_CALLS = {}
            http = {request=function(method, url, headers, body, opts, ca)
                HTTP_CALLS[#HTTP_CALLS+1] = {method=method, url=url, headers=headers,
                    body=body, timeout=opts.timeout, debug=opts.debug, ca=ca}
                return {wait=function()
                    if HTTP_THROW then error("PRIVATE_OFFLINE_EXCEPTION_DETAIL") end
                    return 200, {offline="ok"}, "offline-body"
                end}
            end}
        ''')
        fetch = device.lua.eval(b'require("util_http").fetch')
        for timeout, expected in ((None, 20000), (1234, 1234)):
            code, headers, body = fetch(timeout, b"POST", b"https://offline.example.test/mock",
                                        device.table({"offline": "header"}), b"PRIVATE_HTTP_FIXTURE", b"offline-ca")
            self.assertEqual((code, device.python(headers), body), (200, {"offline": "ok"}, b"offline-body"))
            call = device.python(device.lua.globals()[b"HTTP_CALLS"][len(device.lua.globals()[b"HTTP_CALLS"])])
            self.assertEqual(call, {"method": "POST", "url": "https://offline.example.test/mock",
                                    "headers": {"offline": "header"}, "body": "PRIVATE_HTTP_FIXTURE",
                                    "timeout": expected, "debug": False, "ca": "offline-ca"})
        device.lua.execute(b"HTTP_THROW=true")
        self.assertEqual(fetch(None, b"GET", b"https://offline.example.test/mock"), (-99, None, None))
        starts = [values[2] for _, values in device.logs if values[:2] == ("util_http.fetch", "开始请求")]
        self.assertEqual(starts, ["http_1", "http_2", "http_3"], "Keep request IDs, not the LED-only running counter")
        self.assert_no_gpio(device)
        assert_private_logs_redacted(self, device, "PRIVATE_HTTP_FIXTURE")


class StartupAndSourceTests(OfflineTestCase):
    def test_real_main_startup_receive_send_ack_reconnect_and_timeout_make_zero_storage_calls(self):
        device = Harness(mode="main", ack_events=True, ack_results=True)
        self.assertEqual(device.lua.globals()[b"VERSION"], b"1.0.6")
        device.drive()
        self.assertTrue(device.transport[b"ready"])
        self.assertEqual(device.messages("ready"), [ready_frame()])
        self.assertEqual(device.messages("event")[0]["event"]["type"], "device.boot")
        device.lua.globals()[b"NEW_SMS"](b"10086", b"PRIVATE_INBOUND_FIXTURE", device.table({"year": 26, "mon": 11,
                                                                                               "day": 20, "hour": 8, "min": 9, "sec": 10}))
        device.drive()
        inbound = device.messages("event")[-1]["event"]
        self.assertEqual(inbound["type"], "sms.received")
        self.assertEqual(inbound["data"]["sms_time"], "2026-11-20T08:09:10")
        device.emit("CC_IND", "INCOMINGCALL")
        device.emit("CC_IND", "DISCONNECTED")
        self.assertEqual([event["event"]["type"] for event in device.messages("event")][-2:],
                         ["call.incoming", "call.disconnected"])
        device.receive(command(), over_ws=True)
        device.emit("SMS_SENT", True)
        self.assertFalse(device.record("cmd-001")["pending"])
        self.assertEqual(device.record("cmd-001")["status"], "submitted")
        device.ack_events = False
        self.assertTrue(device.add_event())
        device.drive()
        device.advance(20000)
        self.assertFalse(device.transport[b"ready"])
        device.ack_events = True
        self.assertTrue(device.run_until(lambda: bool(device.transport[b"ready"]) and device.queue_status()["queued"] == 0))
        device.receive(command("timeout", session_id=device.session_id), over_ws=True)
        device.advance(30000)
        self.assertEqual(device.record("timeout")["status"], "unknown")
        device.receive(command("blocked", session_id=device.session_id), over_ws=True)
        self.assertEqual(device.record("blocked")["error"], "executor_blocked")
        self.assertEqual(device.storage_calls, [])
        self.assertEqual(device.auth_requires, 1)
        assert_private_logs_redacted(self, device, "PRIVATE_INBOUND_FIXTURE", "PRIVATE_EVENT_FIXTURE")

    def test_offline_main_startup_is_volatile_and_has_no_old_queue_scan(self):
        device = Harness(mode="main", online=False)
        device.drive()
        self.assertEqual(device.queue_status()["queued"], 1)
        self.assertEqual(device.requests, [])
        self.assertEqual(device.storage_calls, [])
        restarted = Harness(mode="main", online=False, ack_events=True)
        restarted.drive()
        self.assertEqual(restarted.queue_status()["queued"], 1, "Only the new boot event exists; no old queue is loaded")
        self.assertTrue(all(record["state"] == "empty" for record in restarted.records()))
        restarted.online = True
        restarted.emit("IP_READY")
        self.assertEqual(len(restarted.messages("event")), 1)
        self.assertEqual(restarted.queue_status()["queued"], 0)

    def test_notify_requires_init_but_not_any_storage_readiness_argument(self):
        device = Harness()
        notify = device.lua.eval(b'require("util_notify")')
        self.assertFalse(notify.add(b"device.boot", device.table({}), None, EPOCH))
        self.assertEqual(device.python(notify.status())["queued"], 0)
        notify.init()
        self.assertTrue(notify.add(b"device.boot", device.table({}), None, EPOCH))
        device.drive()
        self.assertEqual(device.storage_calls, [])

    def test_only_explicit_public_root_modules_compile_no_manifest_or_secret_reads(self):
        device = Harness()
        compile_ = device.lua.eval(b'function(source,name) local fn,err=load(source,name,"t",_G); return fn~=nil,err end')
        gpio_calls = []
        for name in sorted(Harness.PUBLIC_MODULES):
            path = ROOT / (name + ".lua")
            source = path.read_bytes()
            self.assertEqual(compile_(source, str(path).encode()), (True, None), name)
            source = source.decode("utf-8")
            self.assertNotRegex(source, r"\b(?:util_netled|NET_LED\w*|netled|isRegistered)\b|\.blink\s*\(")
            for line in source.splitlines():
                if line.lstrip().startswith("--"):
                    continue
                self.assertNotRegex(line, r"\bpm\.ioVol\s*\(", "GPIO voltage configuration stays disabled")
                if re.search(r"\b(?:gpio|pwm)\s*[.:]\s*\w+\s*\(", line):
                    gpio_calls.append((name, line.strip()))
        self.assertEqual(gpio_calls, [("main", "gpio.setup(powerkey_pin, function()"),
                                      ("main", "if gpio.get(powerkey_pin) == 0 then")])
        for name in ("main", "util_notify", "util_command", "util_transport", "util_mobile", "config"):
            source = (ROOT / (name + ".lua")).read_text(encoding="utf-8")
            self.assertNotRegex(source, r"\b(?:fskv|io)\s*[.:\[]|\butil_fskv\b")
            self.assertNotRegex(source, r"\butil_http\.fetch\s*\(")
        command_source = (ROOT / "util_command.lua").read_text(encoding="utf-8")
        self.assertNotRegex(command_source, r"\b(?:768|dirty|readback|quarantined_slots\s*=\s*[^0 ])\b")
        main = (ROOT / "main.lua").read_text(encoding="utf-8")
        self.assertIn('VERSION = "1.0.6"', main)
        self.assertIn("util_notify.init()", main)
        self.assertIn("-- pm.ioVol(pm.IOVOL_ALL_GPIO, 3300)", main)
        self.assertNotIn("http_running_count", (ROOT / "util_http.lua").read_text(encoding="utf-8"))
        notify = (ROOT / "util_notify.lua").read_text(encoding="utf-8")
        self.assertRegex(notify, r'require\s*(?:\(\s*)?["\']device_auth["\']')
        self.assertNotIn("registration_key", notify)
        self.assertNotIn("newToken", notify)
        call_sites = []
        for name in Harness.SOURCE_MODULES:
            for line in (ROOT / (name + ".lua")).read_text(encoding="utf-8").splitlines():
                if re.search(r"(?:pcall\(sms\.send|\bsms\.send\s*\()", line) and not line.lstrip().startswith("--"):
                    call_sites.append(name)
        self.assertEqual(call_sites, ["util_sms"])
        self.assertEqual(device.cfg[b"WSS_HEARTBEAT_SECONDS"], 60)
        self.assertEqual(device.cfg[b"SMS_SEND_TIMEOUT_MS"], 30000)  # Harness-only timeout override.
        self.assertEqual(device.cfg[b"COMMAND_DEDUP_SECONDS"], 3600)
        self.assertEqual(device.cfg[b"FLYMODE_INTERVAL"], 0)
        self.assertEqual(device.cfg[b"REPORT_INTERVAL"], 6 * 60 * 60 * 1000)
        self.assertFalse(any(key.startswith(b"NET_LED") for key in device.cfg))
        defaults = device.lua.execute((ROOT / "config.lua").read_bytes())
        self.assertEqual(defaults[b"SMS_SEND_TIMEOUT_MS"], 180000)
        self.assertEqual(defaults[b"SNTP_INTERVAL"], 6 * 60 * 60 * 1000)
        for name in ("LOCATION_INTERVAL", "TRAFFIC_INTERVAL", "QUERY_TRAFFIC_INTERVAL"):
            self.assertEqual(defaults[name.encode()], 0)

    def test_scoped_root_and_device_copies_match_byte_for_byte_and_compile(self):
        device = Harness()
        compile_ = device.lua.eval(b'function(source,name) local fn,err=load(source,name,"t",_G); return fn~=nil,err end')
        for name in sorted(Harness.PUBLIC_MODULES):
            path = ROOT / "device" / (name + ".lua")
            source = path.read_bytes()
            self.assertEqual(source, (ROOT / (name + ".lua")).read_bytes(), name)
            self.assertEqual(compile_(source, str(path).encode()), (True, None), name)
        self.assertFalse((ROOT / "util_netled.lua").exists())
        self.assertFalse((ROOT / "device" / "util_netled.lua").exists())
        self.assertFalse((ROOT / "diagnostics" / "gpio27").exists())

    def test_public_ca_fingerprints_still_match_trust_anchors(self):
        source = (ROOT / "server_ca.lua").read_text(encoding="utf-8")
        certificates = re.findall(rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", CA, re.S)
        fingerprints = re.findall(r"SHA-256 ([A-F0-9]{64})", source)
        self.assertEqual(len(certificates), 4)
        self.assertEqual(len(fingerprints), 4)
        for certificate, expected in zip(certificates, fingerprints):
            der = ssl.PEM_cert_to_DER_cert(certificate.decode())
            self.assertEqual(hashlib.sha256(der).hexdigest().upper(), expected)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
