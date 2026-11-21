"""Deterministic, offline FSKV bounds and fault injection, not a V2056 capacity claim.

Native constraints supplied for the repair: keys <=63 bytes, encoded values <=4096
bytes including one type byte (string payload <=4095), LittleFS block_size=4096,
cache_size=256, and one file per key. The actual V2056 partition size is unknown.
For these tests every file costs at least one block; two metadata blocks and two
update/headroom blocks are budgeted separately. This deliberately conservative
model exposes eager tiny-file reservations; it is not a complete LittleFS emulator
or a measurement of hardware allocation. All capacities below are synthetic.
"""
import copy
import json
import math


class FlashModel:
    BLOCK_SIZE = 4096
    CACHE_SIZE = 256
    MAX_KEY_BYTES = 63
    MAX_ENCODED_BYTES = 4096
    PRIVATE_ERROR = "PRIVATE_FLASH_EXCEPTION_DETAIL"

    def __init__(self, saved=None, *, total_blocks=64, metadata_blocks=2, update_blocks=2):
        if total_blocks < metadata_blocks + update_blocks:
            raise ValueError("Synthetic capacity must include metadata and update headroom")
        self.kv = saved if saved is not None else {}
        self.total_blocks = total_blocks
        self.metadata_blocks, self.update_blocks = metadata_blocks, update_blocks
        self.writes, self.set_attempts, self.reads, self.delete_attempts = [], [], [], []
        self.key_scans, self.status_calls, self.failures = 0, 0, []
        self.fail_delete = 0
        self.get_errors, self.set_errors, self.delete_errors = set(), set(), set()
        self.nil_get, self.retain_deletes = set(), set()
        self.readback_mismatches = {}
        self.iter_error, self.status_error = False, False

    @classmethod
    def encoded_size(cls, value):
        # A synthetic native encoding size; tables use the harness's UTF-8 JSON.
        if isinstance(value, bytes):
            payload = len(value)
        elif isinstance(value, str):
            payload = len(value.encode("utf-8"))
        elif isinstance(value, bool):
            payload = 0
        elif isinstance(value, (int, float)):
            payload = 8
        elif isinstance(value, (dict, list)):
            payload = len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
        else:
            raise TypeError("Unsupported synthetic FSKV encoding")
        return payload + 1

    @classmethod
    def file_blocks(cls, value):
        return max(1, math.ceil(cls.encoded_size(value) / cls.BLOCK_SIZE))

    @property
    def used_blocks(self):
        return self.metadata_blocks + sum(self.file_blocks(value) for value in self.kv.values())

    @property
    def free_file_blocks(self):
        return self.total_blocks - self.used_blocks - self.update_blocks

    def reject(self, operation, reason):
        # Diagnostics contain reasons only, never keys, identifiers or values.
        self.failures.append((operation, reason))
        return False

    def get(self, key):
        self.reads.append(key)
        if key in self.get_errors:
            raise RuntimeError(self.PRIVATE_ERROR)
        if key in self.nil_get:
            return None
        if key in self.readback_mismatches:
            return copy.deepcopy(self.readback_mismatches[key])
        return copy.deepcopy(self.kv.get(key))

    def set(self, key, value, fail=None):
        self.set_attempts.append(key)
        if key in self.set_errors:
            raise RuntimeError(self.PRIVATE_ERROR)
        if fail and fail(key, value):
            return self.reject("set", "injected_failure")
        if not isinstance(key, bytes) or not 1 <= len(key) <= self.MAX_KEY_BYTES:
            return self.reject("set", "key_length")
        try:
            if self.encoded_size(value) > self.MAX_ENCODED_BYTES:
                return self.reject("set", "encoded_length")
            new_blocks = self.file_blocks(value)
            old_blocks = self.file_blocks(self.kv[key]) if key in self.kv else 0
            steady_blocks = self.used_blocks - old_blocks + new_blocks
        except (TypeError, ValueError, UnicodeError):
            return self.reject("set", "encoding")
        if steady_blocks + self.update_blocks > self.total_blocks:
            return self.reject("set", "capacity")
        # Existing files can be rewritten using the reserved update blocks.
        if old_blocks and self.used_blocks + new_blocks > self.total_blocks:
            return self.reject("set", "update_headroom")
        self.kv[key] = copy.deepcopy(value)
        self.writes.append((key, copy.deepcopy(value)))
        return True

    def delete(self, key):
        self.delete_attempts.append(key)
        if key in self.delete_errors:
            raise RuntimeError(self.PRIVATE_ERROR)
        if self.fail_delete:
            self.fail_delete -= 1
            return self.reject("delete", "injected_failure")
        if key not in self.retain_deletes:
            self.kv.pop(key, None)
        return True

    def keys(self):
        self.key_scans += 1
        if self.iter_error:
            raise RuntimeError(self.PRIVATE_ERROR)
        return sorted(self.kv)

    def status(self):
        self.status_calls += 1
        if self.status_error:
            raise RuntimeError(self.PRIVATE_ERROR)
        return self.used_blocks * self.BLOCK_SIZE, self.total_blocks * self.BLOCK_SIZE, len(self.kv)
