local util_location = {}

PRODUCT_KEY = "v32xEAKsGTIEQxtqgwCldp5aPlcnPs3K"
local lbsLoc = require("lbsLoc")

local last_location
local cell_pending, location_pending = false, false

local function refreshCellInfo()
    if not cell_pending then
        cell_pending = true
        mobile.reqCellInfo(20) -- 秒
    end
    local ready = sys.waitUntil("CELL_INFO_UPDATE", 21000)
    cell_pending = false
    return ready
end

--- 刷新基站定位，成功时回调传入 WGS84 坐标。
function util_location.refresh(timeout, on_fix)
    if location_pending then return end
    location_pending = true
    sys.taskInit(function()
        if not refreshCellInfo() then
            location_pending = false
            return
        end
        lbsLoc.request(function(result, lat, lng)
            location_pending = false
            if result ~= 0 then return end
            lat, lng = tonumber(lat), tonumber(lng)
            if not (lat and lng and lat >= -90 and lat <= 90 and lng >= -180 and lng <= 180) then return end
            last_location = { lat = lat, lng = lng }
            if on_fix then on_fix(last_location) end
        end, nil, timeout)
    end)
end

function util_location.get()
    return last_location
end

sys.taskInit(refreshCellInfo)

return util_location
