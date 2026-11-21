-- Session ownership is independent of credential rotation. Existing rows and
-- UUID/fingerprint tombstones remain intact. NULL dispatches are retired only
-- when an authenticated new session successfully takes ownership.
ALTER TABLE device_registry ADD COLUMN command_session TEXT;
ALTER TABLE sms_commands ADD COLUMN dispatch_session TEXT;
