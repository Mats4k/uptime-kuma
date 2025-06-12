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

        // Get status page to read heartbeat range configuration
        let statusPage = await R.findOne("status_page", " id = ? ", [ statusPageID ]);
        let heartbeatRangeDays = statusPage?.heartbeat_range_days || 0;

        let monitorIDList = await R.getCol(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        for (let monitorID of monitorIDList) {
            let processedData = [];
            let aggregationType = "";
            let aggregationPeriod = "";

            if (heartbeatRangeDays > 0) {
                // Use aggregated data based on range
                const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
                
                // Helper function to determine status from aggregated row
                const determineStatus = (row) => {
                    if (row.maintenance && row.maintenance > 0) {
                        return 3; // MAINTENANCE
                    } else if (row.up > 0 && row.down === 0) {
                        return 1; // UP
                    } else if (row.down > 0 && row.up === 0) {
                        return 0; // DOWN
                    } else if (row.up > 0 && row.down > 0) {
                        // Mixed status - determine by majority
                        return row.up >= row.down ? 1 : 0;
                    } else {
                        return 2; // PENDING (no data)
                    }
                };

                if (heartbeatRangeDays <= 1) {
                    // For 1 day or less: use minutely data
                    const totalMinutes = Math.max(1, Math.floor(heartbeatRangeDays * 24 * 60));
                    aggregationType = "minute";
                    aggregationPeriod = "1 minute per bar";
                    
                    const dayjs = require("dayjs");
                    const utc = require("dayjs/plugin/utc");
                    dayjs.extend(utc);
                    
                    // Get minutely aggregated data
                    const minutelyData = uptimeCalculator.getDataArray(Math.min(totalMinutes, 1440), "minute");
                    const dataMap = new Map();
                    minutelyData.forEach(item => {
                        dataMap.set(item.timestamp, item);
                    });
                    
                    // Create timeline for exactly totalMinutes minutes
                    const endTime = dayjs().utc();
                    for (let i = totalMinutes - 1; i >= 0; i--) {
                        const time = endTime.subtract(i, 'minute');
                        const timestamp = time.unix();
                        const aggregatedItem = dataMap.get(timestamp);
                        
                        if (aggregatedItem) {
                            processedData.push({
                                status: determineStatus(aggregatedItem),
                                time: time.toISOString(),
                                ping: aggregatedItem.avgPing ? Math.round(aggregatedItem.avgPing) : null,
                                msg: null
                            });
                        } else {
                            processedData.push({
                                status: 4, // UNKNOWN
                                time: time.toISOString(),
                                ping: null,
                                msg: "No data available"
                            });
                        }
                    }
                    
                } else if (heartbeatRangeDays <= 60) {
                    // For 2-60 days: use hybrid approach - detailed last 24h + hourly for older data
                    const dayjs = require("dayjs");
                    const utc = require("dayjs/plugin/utc");
                    dayjs.extend(utc);
                    
                    let recentData = [];
                    let olderData = [];
                    
                    // Always get detailed recent data for last 24 hours for accurate "last beat" timing
                    const recentList = await R.getAll(`
                        SELECT * FROM heartbeat
                        WHERE monitor_id = ?
                        AND time > datetime('now', '-24 hours')
                        ORDER BY time ASC
                    `, [
                        monitorID,
                    ]);
                    
                    recentData = recentList.map(row => ({
                        status: row.status,
                        time: row.time,
                        ping: row.ping,
                        msg: row.msg
                    }));
                    
                    // If we need more than 24 hours, get hourly aggregated data for the older period
                    if (heartbeatRangeDays > 1) {
                        const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
                        const olderHours = Math.min((heartbeatRangeDays - 1) * 24, 1416); // -24h for recent data
                        
                        // Helper function to determine status from aggregated row
                        const determineStatus = (row) => {
                            if (row.maintenance && row.maintenance > 0) {
                                return 3; // MAINTENANCE
                            } else if (row.up > 0 && row.down === 0) {
                                return 1; // UP
                            } else if (row.down > 0 && row.up === 0) {
                                return 0; // DOWN
                            } else if (row.up > 0 && row.down > 0) {
                                // Mixed status - determine by majority
                                return row.up >= row.down ? 1 : 0;
                            } else {
                                return 4; // UNKNOWN
                            }
                        };
                        
                        // Get hourly aggregated data (excluding last 24 hours)
                        const hourlyData = uptimeCalculator.getDataArray(olderHours + 24, "hour");
                        const dataMap = new Map();
                        hourlyData.forEach(item => {
                            dataMap.set(item.timestamp, item);
                        });
                        
                        // Create timeline for older hours (excluding recent 24h)
                        const endTime = dayjs().utc().subtract(24, 'hours').startOf('hour');
                        for (let i = olderHours - 1; i >= 0; i--) {
                            const time = endTime.subtract(i, 'hour');
                            const timestamp = time.unix();
                            const aggregatedItem = dataMap.get(timestamp);
                            
                            if (aggregatedItem) {
                                olderData.push({
                                    status: determineStatus(aggregatedItem),
                                    time: time.toISOString(),
                                    ping: aggregatedItem.avgPing ? Math.round(aggregatedItem.avgPing) : null,
                                    msg: null
                                });
                            } else {
                                olderData.push({
                                    status: 4, // UNKNOWN
                                    time: time.toISOString(),
                                    ping: null,
                                    msg: "No data available"
                                });
                            }
                        }
                    }
                    
                    // Combine older aggregated data + recent detailed data
                    processedData = olderData.concat(recentData);
                    aggregationType = "hybrid";
                    aggregationPeriod = "hourly + recent detailed";
                    
                } else {
                    // For 61+ days: use daily data
                    const totalDays = Math.min(heartbeatRangeDays, 365);
                    aggregationType = "day";
                    aggregationPeriod = "1 day per bar";
                    
                    const dayjs = require("dayjs");
                    const utc = require("dayjs/plugin/utc");
                    dayjs.extend(utc);
                    
                    // Get daily aggregated data
                    const dailyData = uptimeCalculator.getDataArray(totalDays, "day");
                    const dataMap = new Map();
                    dailyData.forEach(item => {
                        dataMap.set(item.timestamp, item);
                    });
                    
                    // Create timeline for exactly totalDays days
                    const endTime = dayjs().utc().startOf('day');
                    for (let i = totalDays - 1; i >= 0; i--) {
                        const time = endTime.subtract(i, 'day');
                        const timestamp = time.unix();
                        const aggregatedItem = dataMap.get(timestamp);
                        
                        if (aggregatedItem) {
                            processedData.push({
                                status: determineStatus(aggregatedItem),
                                time: time.toISOString(),
                                ping: aggregatedItem.avgPing ? Math.round(aggregatedItem.avgPing) : null,
                                msg: null
                            });
                        } else {
                            processedData.push({
                                status: 4, // UNKNOWN
                                time: time.toISOString(),
                                ping: null,
                                msg: "No data available"
                            });
                        }
                    }
                }

                heartbeatList[monitorID] = processedData;
                
                // Calculate uptime from processed data
                const totalUp = processedData.reduce((sum, item) => sum + (item.status === 1 ? 1 : 0), 0);
                const totalChecks = processedData.length;
                uptimeList[`${monitorID}_24`] = totalChecks > 0 ? (totalUp / totalChecks) : 0;
                
            } else {
                // Default behavior: Use last 100 heartbeats
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

        // Add metadata about aggregation levels used
        let aggregationInfo = {};
        for (let monitorID of monitorIDList) {
            if (heartbeatRangeDays > 0) {
                if (heartbeatRangeDays <= 1) {
                    aggregationInfo[monitorID] = { type: "minute", period: "1 minute per bar" };
                } else if (heartbeatRangeDays <= 60) {
                    aggregationInfo[monitorID] = { type: "hybrid", period: "hourly + recent detailed" };
                } else {
                    aggregationInfo[monitorID] = { type: "day", period: "1 day per bar" };
                }
            } else {
                aggregationInfo[monitorID] = { type: "heartbeat", period: "individual heartbeats" };
            }
        }

        response.json({
            heartbeatList,
            uptimeList,
            aggregationInfo
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
