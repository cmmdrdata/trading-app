/**
 * trade-chart.js
 *
 * Fetches 2-minute OHLCV bars from Alpaca for a trade window,
 * then draws a TradingView-style candlestick chart with entry /
 * take-profit / stop-loss lines marked, and saves it as a PNG.
 *
 * Exported function:
 *   generateTradeChart(options) → Promise<string>  (resolves to saved file path)
 *
 * Options:
 *   symbol       {string}  e.g. 'AAPL'
 *   side         {string}  'BUY' | 'SELL'
 *   entryPrice   {number}
 *   fillPrice    {number}  actual fill price (may differ from limit)
 *   stopLoss     {number}
 *   profitTarget {number}
 *   exitPrice    {number}  price at which the position was exited
 *   exitReason   {string}  'target' | 'stop' | 'terminated'
 *   entryTime    {number}  unix ms — when the entry was detected as filled
 *                          (used for the entry marker, chart title, and
 *                          output filename — NOT the chart's visual window)
 *   exitTime     {number}  unix ms — when the exit was detected
 *   chartWindowStart {number} unix ms — where bar-fetching/the x-axis
 *                          should start (e.g. 9am Eastern on the trade's
 *                          day). Falls back to entryTime if omitted.
 *   partialSells {Array<{price,qty,time}>}  optional partial limit sells
 *   outputDir    {string}  directory to write the PNG (default: ./order-responses)
 *   alpacaKey    {string}
 *   alpacaSecret {string}
 */

'use strict';

const { createCanvas } = require('canvas');
const fs               = require('fs');
const path             = require('path');
const https            = require('https');

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
    });
}

/**
 * Fetch 2-minute bars from Alpaca, for exactly the window the caller asks
 * for (chart-from-db.js anchors `startMs` to 9:00 AM Eastern on the
 * trade's own day). End has a 10-min pad after the exit. Uses the SIP feed
 * (required if the window ever includes pre/after-hours; IEX is
 * regular-hours only).
 */
async function fetchBars(symbol, startMs, endMs, alpacaKey, alpacaSecret) {
    const from = new Date(startMs).toISOString();
    const to   = new Date(endMs + 10 * 60 * 1000).toISOString();

    const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars` +
        `?timeframe=2Min&start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&limit=500&feed=sip`;

    const headers = {
        'APCA-API-KEY-ID':     alpacaKey,
        'APCA-API-SECRET-KEY': alpacaSecret
    };

    const data = await httpsGet(url, headers);
    const bars = (data.bars || []).map(b => ({
        t: new Date(b.t).getTime(),
        o: b.o, h: b.h, l: b.l, c: b.c, v: b.v
    }));
    return bars;
}

/**
 * Fetch the previous trading day's high and low from Alpaca daily bars.
 * Returns { prevHigh, prevLow } or null on failure.
 */
async function fetchPrevDayHighLow(symbol, tradeDateMs, alpacaKey, alpacaSecret) {
    // Request the 3 most recent daily bars ending on the trade date — the
    // second-to-last bar will be the previous session.
    const to   = new Date(tradeDateMs).toISOString().slice(0, 10); // YYYY-MM-DD
    const from = new Date(tradeDateMs - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars` +
        `?timeframe=1Day&start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&limit=5&feed=sip`;

    const headers = {
        'APCA-API-KEY-ID':     alpacaKey,
        'APCA-API-SECRET-KEY': alpacaSecret
    };

    try {
        const data = await httpsGet(url, headers);
        const daily = data.bars || [];
        // Find the bar whose date is strictly before the trade date
        const tradeDay = new Date(tradeDateMs).toISOString().slice(0, 10);
        const prev = [...daily].reverse().find(b => b.t.slice(0, 10) < tradeDay);
        if (!prev) return null;
        return { prevHigh: prev.h, prevLow: prev.l };
    } catch (e) {
        console.warn('[TradeChart] Prev day H/L fetch failed:', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Eastern-explicit time/date formatting
//
// Date's own getHours()/getMinutes()/toLocaleDateString() (with no
// timeZone option) render in whatever timezone the SERVER process happens
// to be running in — not necessarily Eastern. On a cloud host (commonly
// UTC) every time label on the chart would silently be wrong. Always go
// through these so labels are Eastern regardless of server location.
// ---------------------------------------------------------------------------
function fmtEasternTime(ms) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(ms);
}
function fmtEasternDate(ms) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric'
    }).format(ms);
}

// ---------------------------------------------------------------------------
// Chart drawing
// ---------------------------------------------------------------------------

const CHART_W   = 1200;
const CHART_H   = 700;
const PAD_LEFT  = 80;
const PAD_RIGHT = 90;
const PAD_TOP   = 60;
const PAD_BOT   = 60;

const COLOR = {
    bg:         '#131722',
    grid:       '#1e2433',
    axisText:   '#9598a1',
    bullBody:   '#26a69a',
    bullWick:   '#26a69a',
    bearBody:   '#ef5350',
    bearWick:   '#ef5350',
    entryLine:  '#38bdf8',
    tpLine:     '#4ade80',
    stopLine:   '#f87171',
    exitLine:   '#facc15',
    partialLine:'#c084fc',
    origStopLine: '#f87171', // same red as the current stop — dashed distinguishes them
    oneRLine:     '#4ade80', // same green as TP — solid+thin distinguishes it
    vwap:       '#f59e0b',   // amber — same as TradingView default
    ema9:       '#e879f9',   // fuchsia / magenta
    prevHigh:   '#fbbf24',   // yellow-amber
    prevLow:    '#60a5fa',   // cornflower blue
    labelBg:    'rgba(0,0,0,0.65)',
    titleText:  '#e1e3ea',
    plGain:     '#4ade80',
    plLoss:     '#f87171',
};

// ---------------------------------------------------------------------------
// 9-period EMA on close prices
// EMA[0] = close[0]  (seed with first value)
// EMA[i] = close[i] * k + EMA[i-1] * (1 - k),  k = 2 / (period + 1)
// ---------------------------------------------------------------------------
function computeEma(bars, period) {
    if (bars.length === 0) return [];
    const k   = 2 / (period + 1);
    const out  = [bars[0].c];
    for (let i = 1; i < bars.length; i++) {
        out.push(bars[i].c * k + out[i - 1] * (1 - k));
    }
    return out;
}

// ---------------------------------------------------------------------------
// VWAP calculation
// Typical price = (H + L + C) / 3
// VWAP[i] = Σ(TP × V, 0..i) / Σ(V, 0..i)
// Resets at the start of each new calendar day (market day boundary).
// ---------------------------------------------------------------------------
function computeVwap(bars) {
    let cumTPV = 0;
    let cumV   = 0;
    let lastDay = null;

    return bars.map(bar => {
        const d = new Date(bar.t);
        const day = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;

        // Reset accumulators at the start of a new trading day
        if (day !== lastDay) {
            cumTPV = 0;
            cumV   = 0;
            lastDay = day;
        }

        const tp = (bar.h + bar.l + bar.c) / 3;
        cumTPV += tp * bar.v;
        cumV   += bar.v;

        return cumV > 0 ? cumTPV / cumV : bar.c;
    });
}

function drawChart(bars, opts) {
    const {
        symbol, side, entryPrice, fillPrice, stopLoss, profitTarget,
        exitPrice, exitReason, entryTime, exitTime,
        origStopLoss = 0, oneRTarget = 0,
        partialSells = [],
        prevHigh = null,
        prevLow  = null
    } = opts;

    const canvas = createCanvas(CHART_W, CHART_H);
    const ctx    = canvas.getContext('2d');

    // ---- Background ----
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, CHART_W, CHART_H);

    if (bars.length === 0) {
        ctx.fillStyle = COLOR.axisText;
        ctx.font = '18px sans-serif';
        ctx.fillText('No bar data available', CHART_W / 2 - 80, CHART_H / 2);
        return canvas;
    }

    const plotW = CHART_W - PAD_LEFT - PAD_RIGHT;
    const plotH = CHART_H - PAD_TOP  - PAD_BOT;

    // ---- Price range (extend to include all trade levels) ----
    const tradePrices = [fillPrice, stopLoss, profitTarget, exitPrice, origStopLoss, oneRTarget].filter(p => p > 0);
    let priceMin = Math.min(...bars.map(b => b.l), ...tradePrices);
    let priceMax = Math.max(...bars.map(b => b.h), ...tradePrices);
    const pricePad = (priceMax - priceMin) * 0.08;
    priceMin -= pricePad;
    priceMax += pricePad;
    const priceRange = priceMax - priceMin;

    // ---- Time range ----
    const timeMin = bars[0].t;
    const timeMax = bars[bars.length - 1].t;
    const timeRange = timeMax - timeMin || 1;

    // Coordinate transforms
    const xOf  = t => PAD_LEFT + ((t - timeMin) / timeRange) * plotW;
    const yOf  = p => PAD_TOP  + ((priceMax - p) / priceRange) * plotH;
    const barW = Math.max(2, (plotW / bars.length) * 0.7);

    // ---- Grid lines (price) ----
    ctx.strokeStyle = COLOR.grid;
    ctx.lineWidth   = 1;
    const gridCount = 8;
    for (let i = 0; i <= gridCount; i++) {
        const p = priceMin + (priceRange * i / gridCount);
        const y = yOf(p);
        ctx.beginPath();
        ctx.moveTo(PAD_LEFT, y);
        ctx.lineTo(CHART_W - PAD_RIGHT, y);
        ctx.stroke();

        // Y axis labels
        ctx.fillStyle  = COLOR.axisText;
        ctx.font       = '11px monospace';
        ctx.textAlign  = 'right';
        ctx.fillText(`$${p.toFixed(2)}`, PAD_LEFT - 6, y + 4);
    }

    // ---- Grid lines (time) ----
    const timeGridCount = 6;
    for (let i = 0; i <= timeGridCount; i++) {
        const t = timeMin + (timeRange * i / timeGridCount);
        const x = xOf(t);
        ctx.strokeStyle = COLOR.grid;
        ctx.beginPath();
        ctx.moveTo(x, PAD_TOP);
        ctx.lineTo(x, CHART_H - PAD_BOT);
        ctx.stroke();

        const label = fmtEasternTime(t);
        ctx.fillStyle = COLOR.axisText;
        ctx.font      = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, CHART_H - PAD_BOT + 16);
    }

    // ---- Helper: dashed reference line with right-rail label (TP / Stop / Partial) ----
    function refLine(price, color, label, dash = [6, 4], lineWidth = 1) {
        if (!price || price <= 0) return;
        const y = yOf(price);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth   = lineWidth;
        ctx.setLineDash(dash);
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(PAD_LEFT, y);
        ctx.lineTo(CHART_W - PAD_RIGHT, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        const lbl = `${label} $${price.toFixed(2)}`;
        ctx.font  = '10px sans-serif';
        const tw  = ctx.measureText(lbl).width;
        const lx  = CHART_W - PAD_RIGHT + 4;
        ctx.fillStyle = COLOR.labelBg;
        ctx.fillRect(lx - 2, y - 9, tw + 6, 13);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(lbl, lx, y + 2);
        ctx.restore();
    }

    // TP / Stop / Partial as subtle dashed reference lines (no entry line — triangle handles it)
    refLine(profitTarget, COLOR.tpLine,      'TP',      [6, 3]);
    refLine(stopLoss,     COLOR.stopLine,    'Stop',    [6, 3]);
    for (const ps of partialSells) {
        if (ps.price > 0) refLine(ps.price, COLOR.partialLine, 'Partial', [4, 4]);
    }

    // Original stop loss (before any trailing/modification) — dashed red,
    // same as the current stop line. Only drawn when it actually differs
    // from the current stop; otherwise it'd be a redundant overlapping
    // line+label sitting exactly on top of "Stop".
    if (origStopLoss > 0 && Math.abs(origStopLoss - stopLoss) > 0.01) {
        refLine(origStopLoss, COLOR.origStopLine, 'Orig Stop', [6, 3]);
    }

    // Theoretical 1R target — same distance from entry as the ORIGINAL stop,
    // projected on the other side. Thin solid green (vs. the actual TP's
    // dashed green) so the two stay visually distinct even when equal.
    if (oneRTarget > 0) {
        refLine(oneRTarget, COLOR.oneRLine, '1R', [], 1);
    }

    // ---- VWAP line (drawn before candles so candles sit on top) ----
    const vwapValues = computeVwap(bars);
    ctx.save();
    ctx.strokeStyle = COLOR.vwap;
    ctx.lineWidth   = 1.8;
    ctx.setLineDash([]);
    ctx.beginPath();
    let vwapStarted = false;
    for (let i = 0; i < bars.length; i++) {
        const x = xOf(bars[i].t);
        const y = yOf(vwapValues[i]);
        if (!vwapStarted) { ctx.moveTo(x, y); vwapStarted = true; }
        else               ctx.lineTo(x, y);
    }
    ctx.stroke();

    // VWAP end-of-line label on the right rail
    if (bars.length > 0) {
        const lastVwap = vwapValues[vwapValues.length - 1];
        const lbl = `VWAP $${lastVwap.toFixed(2)}`;
        ctx.font = 'bold 11px sans-serif';
        const tw = ctx.measureText(lbl).width;
        const lx = CHART_W - PAD_RIGHT + 4;
        const ly = yOf(lastVwap);
        ctx.fillStyle = COLOR.labelBg;
        ctx.fillRect(lx - 2, ly - 10, tw + 6, 14);
        ctx.fillStyle = COLOR.vwap;
        ctx.textAlign = 'left';
        ctx.fillText(lbl, lx, ly + 2);
    }
    ctx.restore();

    // ---- 9 EMA line (drawn before candles) ----
    const ema9Values = computeEma(bars, 9);
    if (ema9Values.length > 1) {
        ctx.save();
        ctx.strokeStyle = COLOR.ema9;
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        for (let i = 0; i < bars.length; i++) {
            const x = xOf(bars[i].t);
            const y = yOf(ema9Values[i]);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Right-rail label at last EMA value
        const lastEma = ema9Values[ema9Values.length - 1];
        const emaLbl  = `EMA9 $${lastEma.toFixed(2)}`;
        ctx.font = 'bold 11px sans-serif';
        const etw = ctx.measureText(emaLbl).width;
        const elx = CHART_W - PAD_RIGHT + 4;
        const ely = yOf(lastEma);
        ctx.fillStyle = COLOR.labelBg;
        ctx.fillRect(elx - 2, ely - 10, etw + 6, 14);
        ctx.fillStyle = COLOR.ema9;
        ctx.textAlign = 'left';
        ctx.fillText(emaLbl, elx, ely + 2);
        ctx.restore();
    }

    // ---- Previous day High / Low — only draw if within the chart's price range ----
    function prevDayLine(price, color, label) {
        if (!price || price <= 0) return;
        if (price < priceMin || price > priceMax) return; // outside visible range — skip
        const y = yOf(price);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1;
        ctx.setLineDash([10, 5]);
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(PAD_LEFT, y);
        ctx.lineTo(CHART_W - PAD_RIGHT, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // Left-rail label so it doesn't compete with the right-side TP/Stop/EMA labels
        const lbl = `${label} $${price.toFixed(2)}`;
        ctx.font = 'bold 10px sans-serif';
        const tw = ctx.measureText(lbl).width;
        ctx.fillStyle = COLOR.labelBg;
        ctx.fillRect(PAD_LEFT + 2, y - 9, tw + 6, 13);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(lbl, PAD_LEFT + 4, y + 2);
        ctx.restore();
    }

    prevDayLine(prevHigh, COLOR.prevHigh, 'PDH');
    prevDayLine(prevLow,  COLOR.prevLow,  'PDL');

    // ---- Candlesticks ----
    for (const bar of bars) {
        const x    = xOf(bar.t);
        const bull = bar.c >= bar.o;
        const col  = bull ? COLOR.bullBody : COLOR.bearBody;

        const yH  = yOf(bar.h);
        const yL  = yOf(bar.l);
        const yO  = yOf(bar.o);
        const yC  = yOf(bar.c);
        const top = Math.min(yO, yC);
        const ht  = Math.max(Math.abs(yC - yO), 1);

        // Wick
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(x, yH);
        ctx.lineTo(x, yL);
        ctx.stroke();

        // Body
        ctx.fillStyle = col;
        ctx.fillRect(x - barW / 2, top, barW, ht);
    }

    // ---- Trade marker: filled triangle at exact price + time, with price/time label ----
    // pointUp=true → ▲ drawn below the price (buy signal), pointing up into the candle
    // pointUp=false → ▼ drawn above the price (sell signal), pointing down into the candle
    function tradeMarker(timeMs, price, fillColor, pointUp, line1, line2) {
        if (!timeMs || !price || price <= 0) return;

        // Snap to the closest actual bar so the triangle sits exactly on
        // the candle it belongs to, rather than floating between two bars
        // when the fill happened partway through a 2-min bucket. (line2's
        // label text already carries the real, un-snapped fill time.)
        let snappedTime = timeMs;
        let bestDiff = Infinity;
        for (const bar of bars) {
            const diff = Math.abs(bar.t - timeMs);
            if (diff < bestDiff) { bestDiff = diff; snappedTime = bar.t; }
        }

        const x  = xOf(snappedTime);
        const yp = yOf(price);
        const S  = 10; // half-size of triangle

        ctx.save();

        // Triangle sits just outside the candle body:
        //   buy  (▲) → apex at price, body below  → apex y = yp, base y = yp + 2*S
        //   sell (▼) → apex at price, body above  → apex y = yp, base y = yp - 2*S
        const apexY = yp;
        const baseY = pointUp ? yp + 2 * S : yp - 2 * S;

        ctx.beginPath();
        if (pointUp) {
            ctx.moveTo(x,     apexY);        // tip — points up at price
            ctx.lineTo(x - S, baseY);        // bottom-left
            ctx.lineTo(x + S, baseY);        // bottom-right
        } else {
            ctx.moveTo(x,     apexY);        // tip — points down at price
            ctx.lineTo(x - S, baseY);        // top-left
            ctx.lineTo(x + S, baseY);        // top-right
        }
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();

        // Thin white outline so the triangle pops against same-colour candles
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth   = 0.8;
        ctx.stroke();

        // Label block: two lines stacked, placed on the far side of the triangle base
        const labelY = pointUp ? baseY + 14 : baseY - 6;
        ctx.font      = 'bold 11px sans-serif';
        const w1 = ctx.measureText(line1).width;
        const w2 = line2 ? ctx.measureText(line2).width : 0;
        const boxW = Math.max(w1, w2) + 8;
        const boxH = line2 ? 28 : 16;
        const boxX = x - boxW / 2;
        const boxTopY = pointUp ? labelY - 2 : labelY - boxH + 2;

        ctx.fillStyle = COLOR.labelBg;
        ctx.beginPath();
        ctx.roundRect(boxX, boxTopY, boxW, boxH, 3);
        ctx.fill();

        ctx.fillStyle = fillColor;
        ctx.textAlign = 'center';
        ctx.fillText(line1, x, boxTopY + 12);
        if (line2) {
            ctx.fillStyle = COLOR.axisText;
            ctx.font      = '10px sans-serif';
            ctx.fillText(line2, x, boxTopY + 24);
        }

        ctx.restore();
    }

    // Format time as HH:MM Eastern for the label
    function fmtTime(ms) {
        return fmtEasternTime(ms);
    }

    // Entry triangle: green ▲ below bar for BUY, red ▼ above bar for SELL
    const ep = fillPrice || entryPrice;
    if (side === 'BUY') {
        tradeMarker(entryTime, ep, '#22c55e', true,
            `▲ $${ep.toFixed(2)}`, entryTime ? fmtTime(entryTime) : null);
    } else {
        tradeMarker(entryTime, ep, '#ef4444', false,
            `▼ $${ep.toFixed(2)}`, entryTime ? fmtTime(entryTime) : null);
    }

    // Partial sell triangles: always a downward red ▼
    for (const ps of partialSells) {
        if (ps.price > 0 && ps.time) {
            tradeMarker(ps.time, ps.price, COLOR.partialLine, false,
                `▼ $${ps.price.toFixed(2)}`, fmtTime(ps.time));
        }
    }

    // Exit triangle: opposite direction to entry
    if (exitTime && exitPrice > 0) {
        const exitColor = exitReason === 'target' ? '#22c55e'
                        : exitReason === 'stop'   ? '#ef4444'
                        : COLOR.exitLine;
        const exitPointUp = (side !== 'BUY'); // BUY exits point down, SELL exits point up
        tradeMarker(exitTime, exitPrice, exitColor, exitPointUp,
            `${exitPointUp ? '▲' : '▼'} $${exitPrice.toFixed(2)}`, fmtTime(exitTime));
    }

    // ---- P/L summary box ----
    if (fillPrice > 0 && exitPrice > 0) {
        const diff  = side === 'BUY' ? exitPrice - fillPrice : fillPrice - exitPrice;
        const pl    = diff * (opts.shares || 0);
        const pct   = (diff / fillPrice) * 100;
        const sign  = pl >= 0 ? '+' : '';
        const plCol = pl >= 0 ? COLOR.plGain : COLOR.plLoss;
        const plTxt = `${sign}$${pl.toFixed(2)}  (${sign}${pct.toFixed(2)}%)  ${exitReason === 'target' ? '🎯 TARGET HIT' : exitReason === 'stop' ? '🛑 STOPPED OUT' : ''}`;

        ctx.save();
        ctx.font      = 'bold 13px sans-serif';
        const tw      = ctx.measureText(plTxt).width;
        const bx      = PAD_LEFT + plotW / 2 - tw / 2 - 8;
        const by      = PAD_TOP + 10;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(bx, by, tw + 16, 22);
        ctx.fillStyle  = plCol;
        ctx.textAlign  = 'left';
        ctx.fillText(plTxt, bx + 8, by + 15);
        ctx.restore();
    }

    // ---- Title ----
    ctx.save();
    ctx.font      = 'bold 16px sans-serif';
    ctx.fillStyle = COLOR.titleText;
    ctx.textAlign = 'left';
    ctx.fillText(`${symbol}  ·  2-min bars  ·  ${side}  ·  ${fmtEasternDate(entryTime || Date.now())} ET`, PAD_LEFT, 40);

    // ---- Legend (top-right corner) ----
    // Legend: triangles for entry/exit, line swatches for reference levels
    const legendItems = [
        { color: '#22c55e',         label: '▲ Entry / Exit TP',  tri: true },
        { color: '#ef4444',         label: '▼ Exit / Stop',      tri: true },
        { color: COLOR.tpLine,      label: 'TP',                 tri: false },
        { color: COLOR.stopLine,    label: 'Stop',               tri: false },
        { color: COLOR.origStopLine,label: 'Orig Stop',          tri: false },
        { color: COLOR.oneRLine,    label: '1R',                 tri: false },
        { color: COLOR.vwap,        label: 'VWAP',               tri: false },
        { color: COLOR.ema9,        label: 'EMA 9',              tri: false },
        { color: COLOR.prevHigh,    label: 'PDH',                tri: false },
        { color: COLOR.prevLow,     label: 'PDL',                tri: false },
        { color: COLOR.partialLine, label: '▼ Partial',          tri: true },
    ];
    ctx.font = '11px sans-serif';
    let lx = CHART_W - PAD_RIGHT - 10;
    for (let i = legendItems.length - 1; i >= 0; i--) {
        const item = legendItems[i];
        const tw   = ctx.measureText(item.label).width;
        lx -= (tw + 22);
        if (item.tri) {
            // small triangle swatch
            ctx.fillStyle = item.color;
            ctx.beginPath();
            ctx.moveTo(lx + 6, 25);
            ctx.lineTo(lx,     34);
            ctx.lineTo(lx + 12, 34);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillStyle = item.color;
            ctx.fillRect(lx, 30, 12, 3);
        }
        ctx.fillStyle = COLOR.axisText;
        ctx.textAlign = 'left';
        ctx.fillText(item.label, lx + 16, 34);
    }
    ctx.restore();

    // ---- Chart border ----
    ctx.save();
    ctx.strokeStyle = '#2d3139';
    ctx.lineWidth   = 1;
    ctx.strokeRect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.restore();

    return canvas;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate and save a trade chart PNG.
 * Returns the saved file path.
 */
async function generateTradeChart(opts) {
    const {
        symbol, entryTime, exitTime, chartWindowStart,
        alpacaKey, alpacaSecret,
        outputDir = path.join(__dirname, 'order-responses')
    } = opts;

    // Where the chart's bars/x-axis should actually start — defaults to
    // entryTime itself if the caller doesn't provide a separate window start.
    const windowStart = chartWindowStart || entryTime;

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    let bars    = [];
    let prevHL  = null;
    if (alpacaKey && alpacaSecret && windowStart) {
        // Fetch 2-min bars and prev day H/L in parallel
        [bars, prevHL] = await Promise.all([
            fetchBars(symbol, windowStart, exitTime || Date.now(), alpacaKey, alpacaSecret)
                .catch(e => { console.warn('[TradeChart] Bar fetch failed:', e.message); return []; }),
            fetchPrevDayHighLow(symbol, windowStart, alpacaKey, alpacaSecret)
                .catch(() => null)
        ]);
    }

    const canvas   = drawChart(bars, { ...opts, prevHigh: prevHL?.prevHigh ?? null, prevLow: prevHL?.prevLow ?? null });

    // Filename: trade-chart_AAPL_10-15-25_09-31.png  (entry date + entry time,
    // in Eastern — must match chart-from-db.js's own chartFilename() exactly,
    // since that's how it predicts whether a trade's already been charted).
    const ms  = entryTime || Date.now();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: '2-digit', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(ms).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    const filename  = path.join(outputDir, `trade-chart_${symbol}_${parts.month}-${parts.day}-${parts.year}_${parts.hour}-${parts.minute}.png`);
    const buffer    = canvas.toBuffer('image/png');
    fs.writeFileSync(filename, buffer);

    console.log(`[TradeChart] Saved: ${filename}`);
    return filename;
}

module.exports = { generateTradeChart };
