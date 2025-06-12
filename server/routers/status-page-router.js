let express = require("express");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const { badgeConstants } = require("../../src/util");
const { makeBadge } = require("badge-maker");
const { UptimeCalculator } = require("../uptime-calculator");

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status/:slug/rss", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageRSSResponse(response, slug);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [
            slug
        ]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        // Response
        response.json(statusPageData);

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
router.get("/api/status-page/heartbeat/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        let monitorIDList = await R.getCol(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        for (let monitorID of monitorIDList) {
            let list = await R.getAll(`
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 100
            `, [
                monitorID,
            ]);

            list = R.convertToBeans("heartbeat", list);
            heartbeatList[monitorID] = list.reverse().map(row => row.toPublicJSON());

            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            uptimeList[`${monitorID}_24`] = uptimeCalculator.get24Hour().uptime;
        }

        response.json({
            heartbeatList,
            uptimeList
        });

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Daily Aggregated Heartbeat Data (3 months)
// Can fetch only if published
router.get("/api/status-page/heartbeat-daily/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};
        let dailyViewSettings = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        // Get monitor data with daily view settings
        let monitorData = await R.getAll(`
            SELECT monitor_group.monitor_id, monitor_group.daily_view FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        // Get 3 months of daily aggregated data
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        for (let monitor of monitorData) {
            const monitorID = monitor.monitor_id;
            const useDailyView = monitor.daily_view;

            dailyViewSettings[monitorID] = useDailyView;

                        if (useDailyView) {
                // Get daily aggregated data from stat_daily table (v2.0 compatible)
                // stat_daily gets updated in real-time, so no separation needed for today's data
                let dailyData = await R.getAll(`
                    SELECT 
                        DATE(FROM_UNIXTIME(timestamp)) as date,
                        (up + down) as total_beats,
                        up as up_beats,
                        down as down_beats,
                        0 as pending_beats,
                        COALESCE(JSON_EXTRACT(extras, '$.maintenance'), 0) as maintenance_beats,
                        ping as avg_ping,
                        FROM_UNIXTIME(timestamp) as latest_time,
                        -- Determine status based on majority (done in SQL for better performance)
                        CASE 
                            WHEN COALESCE(JSON_EXTRACT(extras, '$.maintenance'), 0) > 0 THEN 3
                            WHEN down > (up / 2) THEN 0
                            WHEN up > 0 THEN 1
                            ELSE 2
                        END as status,
                        -- Calculate uptime (done in SQL for better performance)  
                        CASE 
                            WHEN (up + down) > 0 THEN ROUND(up / (up + down), 4)
                            ELSE 0
                        END as uptime
                    FROM stat_daily
                    WHERE monitor_id = ? 
                    AND timestamp >= ?
                    ORDER BY timestamp ASC
                `, [
                    monitorID,
                    threeMonthsAgo.unix()
                ]);

                // Convert to daily heartbeat format (minimal processing since SQL does most work)
                let processedData = dailyData.map(row => ({
                    status: parseInt(row.status),
                    time: row.latest_time,
                    ping: row.avg_ping ? Math.round(row.avg_ping) : null,
                    msg: null,
                    uptime: parseFloat(row.uptime),
                    date: row.date,
                    // Additional daily stats
                    dailyStats: {
                        total: parseInt(row.total_beats) || 0,
                        up: parseInt(row.up_beats) || 0,
                        down: parseInt(row.down_beats) || 0,
                        pending: parseInt(row.pending_beats) || 0,
                        maintenance: parseInt(row.maintenance_beats) || 0
                    }
                }));

                heartbeatList[monitorID] = processedData;

                // Calculate uptime based only on actual daily data (not including missing days)
                if (processedData.length > 0) {
                    // Get recent data (last 30 days worth of actual data)
                    const recentData = processedData.slice(-30);

                    let totalUp = 0;
                    let totalDown = 0;

                    recentData.forEach(day => {
                        if (day.dailyStats) {
                            // Convert strings to numbers to avoid concatenation
                            totalUp += parseInt(day.dailyStats.up) || 0;
                            totalDown += parseInt(day.dailyStats.down) || 0;
                        }
                    });

                    const totalChecks = totalUp + totalDown;
                    uptimeList[`${monitorID}_24`] = totalChecks > 0 ? (totalUp / totalChecks) : 0;
                } else {
                    uptimeList[`${monitorID}_24`] = 0;
                }
            } else {
                // Use regular heartbeat data (last 100 beats)
                let list = await R.getAll(`
                        SELECT * FROM heartbeat
                        WHERE monitor_id = ?
                        ORDER BY time DESC
                        LIMIT 100
                `, [
                    monitorID,
                ]);

                list = R.convertToBeans("heartbeat", list);
                heartbeatList[monitorID] = list.reverse().map(row => row.toPublicJSON());

                const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
                uptimeList[`${monitorID}_24`] = uptimeCalculator.get24Hour().uptime;
            }
        }

        response.json({
            heartbeatList,
            uptimeList,
            dailyViewSettings,
            hasMixedData: true
        });

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [
            slug
        ]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            "name": statusPage.title,
            "start_url": "/status/" + statusPage.slug,
            "display": "standalone",
            "icons": [
                {
                    "src": statusPage.icon,
                    "sizes": "128x128",
                    "type": "image/png"
                }
            ]
        });

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    const statusPageID = await StatusPage.slugToID(slug);
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle
    } = request.query;

    try {
        let monitorIDList = await R.getCol(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(`
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `, [
                monitorID,
            ]);

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }

        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;

        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }

        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
