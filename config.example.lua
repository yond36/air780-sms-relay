return {
    -- Copy to config.lua and set your own HTTPS service base URL.
    SERVER_URL = "https://relay.example.com",
    -- SERVER_CA_PEM = "",

    WSS_HEARTBEAT_SECONDS = 60,
    SMS_SEND_TIMEOUT_MS = 180000,
    COMMAND_DEDUP_SECONDS = 60 * 60,

    BOOT_NOTIFY = true,
    INCLUDE_STATUS = true,
    REPORT_INTERVAL = 6 * 60 * 60 * 1000,
    SNTP_INTERVAL = 6 * 60 * 60 * 1000,
    FLYMODE_INTERVAL = 0,
    LOCATION_INTERVAL = 0,
    TRAFFIC_INTERVAL = 0,
    QUERY_TRAFFIC_INTERVAL = 0,

    UART_ENABLED = false,
    ROLE = "MASTER",
    FALLBACK_LOCAL_NUMBER = "",
    PIN_CODE = "",
}
