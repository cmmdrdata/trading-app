'use strict';

const t = require('./timeHelpers.js');

/**
 * "Inside day" check: did the stock stay within the PREVIOUS trading day's
 * high/low range during 9:00-11:00 AM Eastern on the trade's entry day?
 * And if so, did it later break out of that range before the close?
 *
 * Returns one of:
 *   'Inside all day'              - stayed in range 9am through close
 *   'Inside 9-11am, broke out later' - held 9-11am, broke range after 11am
 *   'Outside by 11am'             - already broke the prior day's range during 9-11am
 *   'No data'                     - couldn't fetch enough bar data to tell
 */
async function getInsideDayStatus(symbol, entryMs, alpacaKey, alpacaSecret, cache) {
    const dateKey = t.easternDateKey(entryMs);
    const cacheKey = `${symbol}|${dateKey}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const result = await computeInsideDayStatus(symbol, entryMs, alpacaKey, alpacaSecret);
    cache.set(cacheKey, result);
    return result;
}

async function computeInsideDayStatus(symbol, entryMs, alpacaKey, alpacaSecret) {
    if (!alpacaKey || !alpacaSecret) return 'No data';

    try {
        const tradeDayOpen = t.marketOpenMs(entryMs);

        // Previous trading day's daily bar — look back up to 7 calendar days
        // to safely skip weekends/holidays, take the most recent bar before
        // the trade day's open.
        const lookbackStart = new Date(tradeDayOpen - 7 * 24 * 60 * 60 * 1000).toISOString();
        const dailyUrl = `https://data.alpaca.markets/v2/stocks/${symbol}/bars` +
            `?timeframe=1Day&start=${encodeURIComponent(lookbackStart)}&end=${encodeURIComponent(new Date(tradeDayOpen).toISOString())}&limit=10&feed=sip`;
        const dailyRes = await fetch(dailyUrl, {
            headers: { 'APCA-API-KEY-ID': alpacaKey, 'APCA-API-SECRET-KEY': alpacaSecret }
        });
        if (!dailyRes.ok) return 'No data';
        const dailyData = await dailyRes.json();
        const dailyBars = dailyData.bars || [];
        if (dailyBars.length === 0) return 'No data';
        const prevBar = dailyBars[dailyBars.length - 1]; // most recent bar strictly before trade day
        const prevHigh = prevBar.h, prevLow = prevBar.l;
        if (!(prevHigh > 0) || !(prevLow > 0)) return 'No data';

        // Intraday bars for the full session (9am-4pm ET) on the trade day.
        const sessionStart = new Date(tradeDayOpen).toISOString();
        const sessionEnd   = new Date(t.marketCloseMs(entryMs)).toISOString();
        const intraUrl = `https://data.alpaca.markets/v2/stocks/${symbol}/bars` +
            `?timeframe=5Min&start=${encodeURIComponent(sessionStart)}&end=${encodeURIComponent(sessionEnd)}&limit=200&feed=sip`;
        const intraRes = await fetch(intraUrl, {
            headers: { 'APCA-API-KEY-ID': alpacaKey, 'APCA-API-SECRET-KEY': alpacaSecret }
        });
        if (!intraRes.ok) return 'No data';
        const intraData = await intraRes.json();
        const bars = intraData.bars || [];
        if (bars.length === 0) return 'No data';

        const elevenAm = t.elevenAmMs(entryMs);
        const earlyBars = bars.filter(b => Date.parse(b.t) < elevenAm);
        const lateBars  = bars.filter(b => Date.parse(b.t) >= elevenAm);

        if (earlyBars.length === 0) return 'No data';

        const insideEarly = earlyBars.every(b => b.h <= prevHigh && b.l >= prevLow);
        if (!insideEarly) return 'Outside by 11am';

        const brokeOutLater = lateBars.some(b => b.h > prevHigh || b.l < prevLow);
        return brokeOutLater ? 'Inside 9-11am, broke out later' : 'Inside all day';
    } catch (err) {
        console.warn(`[InsideDay] ${symbol} ${t.easternDateKey(entryMs)}: ${err.message}`);
        return 'No data';
    }
}

module.exports = { getInsideDayStatus };
