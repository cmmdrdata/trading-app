'use strict';

const t = require('./timeHelpers.js');

/**
 * Compute all derived per-trade fields from one raw query row (see
 * fetchClosedTrades's SELECT shape in analyzeTradeHistory.js).
 */
function computeTradeMetrics(row) {
    const entryFill = row.event_entry_fill || row.order_entry_fill || row.entry_price || 0;
    const exitFill  = row.event_exit_fill  || row.order_exit_fill  || 0;
    const entryMs   = row.entry_ts ? Date.parse(row.entry_ts) : Date.parse(row.created_timestamp);
    const exitMs    = row.exit_ts  ? Date.parse(row.exit_ts)  : (row.closed_timestamp ? Date.parse(row.closed_timestamp) : null);

    // Long/short purely from the entry order's own direction.
    const side = (row.trade_action || '').toUpperCase() === 'SELLSHORT' ? 'SHORT' : 'LONG';

    // Original stop/target — the value BEFORE any trailing/modification, if
    // one occurred; otherwise the current column already IS the original
    // (never touched). Same recovery logic used for the trade charts.
    const origStopLoss   = row.orig_stop_mod || row.stop_loss   || 0;
    const origTakeProfit = row.orig_tp_mod   || row.take_profit || 0;

    const quantity = row.quantity || 0;
    const riskPerShare = (entryFill > 0 && origStopLoss > 0) ? Math.abs(entryFill - origStopLoss) : null;
    const riskSize = riskPerShare !== null ? riskPerShare * quantity : null;

    let pl = null;
    if (entryFill > 0 && exitFill > 0 && quantity > 0) {
        const diff = side === 'LONG' ? (exitFill - entryFill) : (entryFill - exitFill);
        pl = diff * quantity;
    }

    const rMultiple = (pl !== null && riskSize) ? pl / riskSize : null;

    const dayOfWeek   = entryMs ? t.easternParts(entryMs).weekday : null;
    const entryDateKey = entryMs ? t.easternDateKey(entryMs) : null;
    const exitDateKey  = exitMs  ? t.easternDateKey(exitMs)  : null;
    const isDayTrade = (entryDateKey && exitDateKey) ? (entryDateKey === exitDateKey) : null;

    let monthKey = null, quarterKey = null, yearKey = null;
    if (entryMs) {
        const p = t.easternParts(entryMs);
        monthKey   = `${p.year}-${String(p.month).padStart(2, '0')}`;
        quarterKey = `${p.year}-Q${t.quarterOf(p.month)}`;
        yearKey    = `${p.year}`;
    }

    return {
        orderId: row.primary_order_id,
        symbol: row.symbol,
        side,
        quantity,
        entryFill,
        exitFill,
        origStopLoss,
        origTakeProfit,
        currentStopLoss: row.stop_loss || 0,
        currentTakeProfit: row.take_profit || 0,
        riskPerShare,
        riskSize,
        pl,
        rMultiple,
        entryMs, exitMs,
        dayOfWeek,
        entryDateKey, exitDateKey,
        isDayTrade,
        monthKey, quarterKey, yearKey,
        // Filled in later by the Alpaca inside-day check (async, separate pass).
        insideDayStatus: null
    };
}

/**
 * Aggregate accuracy + Sharpe over a list of computed trades.
 * Sharpe here is trade-based (mean/stdev of per-trade results, not
 * annualized against a daily equity curve — there's no portfolio-level
 * daily P/L series to annualize against, just discrete trades), computed
 * two ways: on raw $P/L and on R-multiples (P/L ÷ risk). R-multiple Sharpe
 * is usually the more meaningful one for position-sized trading since it
 * normalizes for size; $P/L Sharpe is included for reference.
 */
function computeStats(trades) {
    const withPL = trades.filter(tr => tr.pl !== null);
    const wins   = withPL.filter(tr => tr.pl > 0);
    const losses = withPL.filter(tr => tr.pl < 0);
    const breakeven = withPL.filter(tr => tr.pl === 0);

    const accuracy = withPL.length ? wins.length / withPL.length : null;
    const totalPL  = withPL.reduce((s, tr) => s + tr.pl, 0);
    const avgPL    = withPL.length ? totalPL / withPL.length : null;

    function stdev(arr, mean) {
        if (arr.length < 2) return null;
        const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
        return Math.sqrt(variance);
    }

    const plValues = withPL.map(tr => tr.pl);
    const plStdev  = avgPL !== null ? stdev(plValues, avgPL) : null;
    const sharpePL = (plStdev && plStdev > 0) ? avgPL / plStdev : null;

    const withR = withPL.filter(tr => tr.rMultiple !== null);
    const rValues = withR.map(tr => tr.rMultiple);
    const avgR = rValues.length ? rValues.reduce((s, v) => s + v, 0) / rValues.length : null;
    const rStdev = avgR !== null ? stdev(rValues, avgR) : null;
    const sharpeR = (rStdev && rStdev > 0) ? avgR / rStdev : null;

    return {
        count: trades.length,
        countWithPL: withPL.length,
        wins: wins.length, losses: losses.length, breakeven: breakeven.length,
        accuracy, totalPL, avgPL, plStdev, sharpePL,
        avgR, rStdev, sharpeR
    };
}

function groupBy(trades, keyFn) {
    const map = new Map();
    for (const tr of trades) {
        const k = keyFn(tr);
        if (k === null || k === undefined) continue;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(tr);
    }
    return map;
}

module.exports = { computeTradeMetrics, computeStats, groupBy };
