<template>
    <div ref="wrap" class="wrap" :style="wrapStyle">
        <div class="hp-bar-big" :style="barStyle">
            <div
                v-for="(beat, index) in shortBeatList"
                :key="index"
                class="beat-hover-area"
                :class="{ 'empty': (beat === 0) }"
                :style="beatHoverAreaStyle"
                :title="getBeatTitle(beat)"
            >
                <div
                    class="beat"
                    :class="{ 'empty': (beat === 0), 'down': (beat.status === 0), 'pending': (beat.status === 2), 'maintenance': (beat.status === 3), 'unknown': (beat.status === 4) }"
                    :style="beatStyle"
                />
            </div>
        </div>
        <div
            v-if="!$root.isMobile && size !== 'small' && beatList.length > 4 && $root.styleElapsedTime !== 'none'"
            class="d-flex justify-content-between align-items-center word" :style="timeStyle"
        >
            <div>{{ timeSinceFirstBeat }}</div>
            <div v-if="$root.styleElapsedTime === 'with-line'" class="connecting-line"></div>
            <div>{{ timeSinceLastBeat }}</div>
        </div>
    </div>
</template>

<script>
import dayjs from "dayjs";

export default {
    props: {
        /** Size of the heartbeat bar */
        size: {
            type: String,
            default: "big",
        },
        /** ID of the monitor */
        monitorId: {
            type: Number,
            required: true,
        },
        /** Array of the monitors heartbeats */
        heartbeatList: {
            type: Array,
            default: null,
        }
    },
    data() {
        return {
            beatWidth: 10,
            beatHeight: 30,
            hoverScale: 1.5,
            beatHoverAreaPadding: 4,
            move: false,
            maxBeat: -1,
        };
    },
    computed: {

        /**
         * If heartbeatList is null, get it from $root.heartbeatList
         * @returns {object} Heartbeat list
         */
        beatList() {
            if (this.heartbeatList === null) {
                return this.$root.heartbeatList[this.monitorId];
            } else {
                return this.heartbeatList;
            }
        },

        /**
         * Calculates the amount of beats of padding needed to fill the length of shortBeatList.
         * @returns {number} The amount of beats of padding needed to fill the length of shortBeatList.
         */
        numPadding() {
            if (!this.beatList) {
                return 0;
            }
            
            // Get aggregation info for this monitor
            const aggregationInfo = this.$root.aggregationInfo?.[this.monitorId];
            
            // If we're using adaptive sampling, no padding needed
            if (aggregationInfo && this.maxBeat > 0) {
                const dataLength = this.beatList.length;
                
                // For hourly or hybrid data with sampling, no padding
                if ((aggregationInfo.type === "hour" || aggregationInfo.type === "hybrid") && dataLength > this.maxBeat) {
                    return 0;
                }
                
                // For daily data that fits completely, no padding
                if (aggregationInfo.type === "day" && dataLength < this.maxBeat) {
                    return 0;
                }
            }
            
            let num = this.beatList.length - this.maxBeat;

            if (this.move) {
                num = num - 1;
            }

            if (num > 0) {
                return 0;
            }

            return -1 * num;
        },

        shortBeatList() {
            if (!this.beatList) {
                return [];
            }

            let placeholders = [];
            let start = this.beatList.length - this.maxBeat;

            // Get aggregation info for this monitor
            const aggregationInfo = this.$root.aggregationInfo?.[this.monitorId];
            
            // Adaptive data sampling for better space utilization
            if (aggregationInfo && this.maxBeat > 0) {
                const availableSpace = this.maxBeat;
                const dataLength = this.beatList.length;
                
                // If we have hourly or hybrid data and lots of space, show more data
                if ((aggregationInfo.type === "hour" || aggregationInfo.type === "hybrid") && dataLength > availableSpace) {
                    // Calculate sampling ratio to fill available space optimally
                    const samplingRatio = Math.max(1, Math.floor(dataLength / availableSpace));
                    
                    // For hybrid data, always include the most recent data
                    if (aggregationInfo.type === "hybrid") {
                        // Keep recent detailed data (last 24h) and sample older data
                        const recentDataCount = Math.min(dataLength, 144); // Assume ~144 recent beats for 24h
                        const olderDataCount = dataLength - recentDataCount;
                        
                        let sampledData = [];
                        
                        // Sample older data
                        if (olderDataCount > 0) {
                            const olderAvailableSpace = Math.max(1, availableSpace - recentDataCount);
                            const olderSamplingRatio = Math.max(1, Math.floor(olderDataCount / olderAvailableSpace));
                            
                            for (let i = 0; i < olderDataCount; i += olderSamplingRatio) {
                                sampledData.push(this.beatList[i]);
                            }
                        }
                        
                        // Always include recent detailed data
                        const recentData = this.beatList.slice(olderDataCount);
                        sampledData = sampledData.concat(recentData);
                        
                        // Ensure we don't exceed maxBeat
                        if (sampledData.length > availableSpace) {
                            sampledData = sampledData.slice(-availableSpace);
                        }
                        
                        return sampledData;
                    } else {
                        // Original sampling logic for pure hourly data
                        let sampledData = [];
                        for (let i = 0; i < dataLength; i += samplingRatio) {
                            sampledData.push(this.beatList[i]);
                        }
                        
                        // Ensure we don't exceed maxBeat
                        if (sampledData.length > availableSpace) {
                            sampledData = sampledData.slice(-availableSpace);
                        }
                        
                        return sampledData;
                    }
                }
                
                // If we have daily data but lots of space, we might want to show all available data
                if (aggregationInfo.type === "day" && dataLength < availableSpace) {
                    // Show all available data if it fits
                    return this.beatList;
                }
            }

            if (this.move) {
                start = start - 1;
            }

            if (start < 0) {
                // Add empty placeholder
                for (let i = start; i < 0; i++) {
                    placeholders.push(0);
                }
                start = 0;
            }

            return placeholders.concat(this.beatList.slice(start));
        },

        wrapStyle() {
            let topBottom = (((this.beatHeight * this.hoverScale) - this.beatHeight) / 2);
            let leftRight = (((this.beatWidth * this.hoverScale) - this.beatWidth) / 2);

            return {
                padding: `${topBottom}px ${leftRight}px`,
                width: "100%",
            };
        },

        barStyle() {
            if (this.move && this.shortBeatList.length > this.maxBeat) {
                let width = -(this.beatWidth + this.beatHoverAreaPadding * 2);

                return {
                    transition: "all ease-in-out 0.25s",
                    transform: `translateX(${width}px)`,
                };

            }
            return {
                transform: "translateX(0)",
            };

        },

        beatHoverAreaStyle() {
            return {
                padding: this.beatHoverAreaPadding + "px",
                "--hover-scale": this.hoverScale,
            };
        },

        beatStyle() {
            return {
                width: this.beatWidth + "px",
                height: this.beatHeight + "px",
            };
        },

        /**
         * Returns the style object for positioning the time element.
         * @returns {object} The style object containing the CSS properties for positioning the time element.
         */
        timeStyle() {
            return {
                "margin-left": this.numPadding * (this.beatWidth + this.beatHoverAreaPadding * 2) + "px",
            };
        },

        /**
         * Calculates the time elapsed since the first valid beat.
         * @returns {string} The time elapsed in minutes or hours.
         */
        timeSinceFirstBeat() {
            const firstValidBeat = this.shortBeatList.at(this.numPadding);
            if (!firstValidBeat) {
                return "";
            }
            
            const minutes = dayjs().diff(dayjs.utc(firstValidBeat?.time), "minutes");
            const hours = minutes / 60;
            const days = hours / 24;
            
            // More precise time formatting based on the actual time range
            if (days >= 1) {
                return Math.floor(days) + "d";
            } else if (hours >= 1) {
                return Math.floor(hours) + "h";
            } else {
                return Math.floor(minutes) + "m";
            }
        },

        /**
         * Calculates the elapsed time since the last valid beat was registered.
         * @returns {string} The elapsed time in a minutes, hours or "now".
         */
        timeSinceLastBeat() {
            const lastValidBeat = this.shortBeatList.at(-1);
            if (!lastValidBeat) {
                return "";
            }
            
            const seconds = dayjs().diff(dayjs.utc(lastValidBeat?.time), "seconds");
            const minutes = seconds / 60;
            const hours = minutes / 60;
            const days = hours / 24;

            let tolerance = 60 * 2; // default for when monitorList not available
            if (this.$root.monitorList[this.monitorId] != null) {
                tolerance = this.$root.monitorList[this.monitorId].interval * 2;
            }

            if (seconds < tolerance) {
                return this.$t("now");
            } else if (days >= 1) {
                return this.$t("time ago", [ Math.floor(days) + "d" ]);
            } else if (hours >= 1) {
                return this.$t("time ago", [ Math.floor(hours) + "h" ]);
            } else {
                return this.$t("time ago", [ Math.floor(minutes) + "m" ]);
            }
        }
    },
    watch: {
        beatList: {
            handler(val, oldVal) {
                this.move = true;

                setTimeout(() => {
                    this.move = false;
                }, 300);
            },
            deep: true,
        },
    },
    unmounted() {
        window.removeEventListener("resize", this.resize);
    },
    beforeMount() {
        if (this.heartbeatList === null) {
            if (!(this.monitorId in this.$root.heartbeatList)) {
                this.$root.heartbeatList[this.monitorId] = [];
            }
        }
    },

    mounted() {
        if (this.size !== "big") {
            this.beatWidth = 5;
            this.beatHeight = 16;
            this.beatHoverAreaPadding = 2;
        }

        // Suddenly, have an idea how to handle it universally.
        // If the pixel * ratio != Integer, then it causes render issue, round it to solve it!!
        const actualWidth = this.beatWidth * window.devicePixelRatio;
        const actualHoverAreaPadding = this.beatHoverAreaPadding * window.devicePixelRatio;

        if (!Number.isInteger(actualWidth)) {
            this.beatWidth = Math.round(actualWidth) / window.devicePixelRatio;
        }

        if (!Number.isInteger(actualHoverAreaPadding)) {
            this.beatHoverAreaPadding = Math.round(actualHoverAreaPadding) / window.devicePixelRatio;
        }

        window.addEventListener("resize", this.resize);
        this.resize();
    },
    methods: {
        /**
         * Resize the heartbeat bar
         * @returns {void}
         */
        resize() {
            if (this.$refs.wrap) {
                this.maxBeat = Math.floor(this.$refs.wrap.clientWidth / (this.beatWidth + this.beatHoverAreaPadding * 2));
            }
        },

        /**
         * Get the title of the beat.
         * Used as the hover tooltip on the heartbeat bar.
         * @param {object} beat Beat to get title from
         * @returns {string} Beat title
         */
        getBeatTitle(beat) {
            if (beat === 0) {
                return ""; // Empty beat
            }
            
            // Get aggregation info for this monitor
            const aggregationInfo = this.$root.aggregationInfo?.[this.monitorId];
            let timeInfo = this.$root.datetime(beat.time);
            
            if (aggregationInfo && aggregationInfo.type !== "heartbeat") {
                // Show aggregated time period info
                if (aggregationInfo.type === "day") {
                    timeInfo = this.$root.date(beat.time) + " (1 day)";
                } else if (aggregationInfo.type === "hour") {
                    timeInfo = this.$root.datetime(beat.time).replace(/:\d{2}$/, '') + " (1 hour)";
                } else if (aggregationInfo.type === "minute") {
                    timeInfo = this.$root.datetime(beat.time) + " (1 minute)";
                } else if (aggregationInfo.type === "hybrid") {
                    // For hybrid data, check if this is recent detailed data or older aggregated data
                    const beatTime = dayjs.utc(beat.time);
                    const hoursAgo = dayjs().diff(beatTime, 'hours');
                    
                    if (hoursAgo <= 24) {
                        // Recent detailed data - show exact time
                        timeInfo = this.$root.datetime(beat.time);
                    } else {
                        // Older aggregated data - show as hourly
                        timeInfo = this.$root.datetime(beat.time).replace(/:\d{2}$/, '') + " (1 hour)";
                    }
                }
                
                // Add status information for aggregated data
                if (beat.status === 4) {
                    return timeInfo + " - No data available";
                } else if (beat.status === 0) {
                    return timeInfo + " - Down";
                } else if (beat.status === 1) {
                    return timeInfo + " - Up";
                } else if (beat.status === 2) {
                    return timeInfo + " - Pending";
                } else if (beat.status === 3) {
                    return timeInfo + " - Maintenance";
                }
            }
            
            return timeInfo + ((beat.msg) ? ` - ${beat.msg}` : "");
        },

    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.wrap {
    overflow: hidden;
    width: 100%;
    white-space: nowrap;
}

.hp-bar-big {
    .beat-hover-area {
        display: inline-block;

        &:not(.empty):hover {
            transition: all ease-in-out 0.15s;
            opacity: 0.8;
            transform: scale(var(--hover-scale));
        }

        .beat {
            background-color: $primary;
            border-radius: $border-radius;

            /*
            pointer-events needs to be changed because
            tooltip momentarily disappears when crossing between .beat-hover-area and .beat
            */
            pointer-events: none;

            &.empty {
                background-color: aliceblue;
            }

            &.down {
                background-color: $danger;
            }

            &.pending {
                background-color: $warning;
            }

            &.maintenance {
                background-color: $maintenance;
            }

            &.unknown {
                background-color: #888888;
            }
        }
    }
}

.dark {
    .hp-bar-big .beat.empty {
        background-color: #848484;
    }
    .hp-bar-big .beat.unknown {
        background-color: #666666;
    }
}

.word {
    color: $secondary-text;
    font-size: 12px;
}

.connecting-line {
    flex-grow: 1;
    height: 1px;
    background-color: #ededed;
    margin-left: 10px;
    margin-right: 10px;
    margin-top: 2px;

    .dark & {
        background-color: #333;
    }
}
</style>
