'use strict';

// Reuses the DST-safe pattern already proven in chart-from-db.js/trade-chart.js.

function easternOffsetMinutesAt(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', timeZoneName: 'shortOffset'
    }).formatToParts(date);
    const offsetStr = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
    const match = /GMT([+-]\d+)/.exec(offsetStr);
    return match ? parseInt(match[1], 10) * 60 : -300;
}

/** Decompose a unix-ms timestamp into its Eastern calendar/clock parts. */
function easternParts(ms) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        weekday: 'long'
    });
    const parts = dtf.formatToParts(ms).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return {
        year: parseInt(parts.year, 10),
        month: parseInt(parts.month, 10),
        day: parseInt(parts.day, 10),
        hour: parseInt(parts.hour === '24' ? '0' : parts.hour, 10),
        minute: parseInt(parts.minute, 10),
        weekday: parts.weekday
    };
}

/** 'YYYY-MM-DD' in Eastern calendar terms — stable key for "same trading day". */
function easternDateKey(ms) {
    const p = easternParts(ms);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Unix ms for a specific Eastern clock time on the SAME Eastern calendar date as `ms`. */
function easternClockMs(ms, hour, minute = 0) {
    const p = easternParts(ms);
    const noonGuessUTC = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
    const offsetMin = easternOffsetMinutesAt(noonGuessUTC);
    return Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0) - offsetMin * 60 * 1000;
}

function marketOpenMs(ms)   { return easternClockMs(ms, 9, 0); }
function elevenAmMs(ms)     { return easternClockMs(ms, 11, 0); }
function marketCloseMs(ms)  { return easternClockMs(ms, 16, 0); }

function quarterOf(month) { return Math.ceil(month / 3); }

module.exports = {
    easternOffsetMinutesAt, easternParts, easternDateKey, easternClockMs,
    marketOpenMs, elevenAmMs, marketCloseMs, quarterOf
};
