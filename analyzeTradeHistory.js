#!/usr/bin/env node
/**
 * analyzeTradeHistory.js
 *
 * Reads every completed (status='CLOSED') trade from trading_orders.db and
 * produces a breakdown workbook: per-trade detail, day-trade vs multi-day
 * split, and month/quarter/year summaries — plus overall accuracy and
 * Sharpe ratio.
 *
 * Per-trade columns: Entry, Stop (original, pre-trailing), Take Profit
 * (original), Long/Short, Shares, Risk $ (|entry - orig stop| × shares),
 * Day of Week, P/L, R-multiple, Day Trade? (entry/exit same Eastern
 * calendar day), Inside-Day status (see below), Entry/Exit dates.
 *
 * Inside-Day status (requires ALPACA_API_KEY/ALPACA_API_SECRET in .env —
 * skip with --no-inside-day to run without it, much faster):
 *   'Inside all day'                  - held within the prior day's H/L the
 *                                        whole session (9am-4pm ET)
 *   'Inside 9-11am, broke out later'  - held 9-11am ET, broke the range
 *                                        sometime after 11am
 *   'Outside by 11am'                 - already outside the prior day's
 *                                        range during the 9-11am window
 *   'No data'                         - couldn't fetch enough bar data
 *
 * Sharpe ratio is trade-based (mean ÷ stdev of per-trade results across the
 * group), not a time-annualized daily-equity-curve Sharpe — there's no
 * portfolio-level daily P/L series here, just discrete trades. Reported
 * both on raw $P/L and on R-multiples (P/L ÷ risk); R-multiple is usually
 * the more meaningful one since it normalizes for position size.
 *
 * Usage:
 *   node analyzeTradeHistory.js                    # full run, with inside-day lookups
 *   node analyzeTradeHistory.js --no-inside-day     # skip Alpaca calls (fast)
 *   node analyzeTradeHistory.js --out report.xlsx   # custom output filename
 */

'use strict';

require('dotenv').config();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const { Workbook }  = require('./xlsxlite.js');
const t             = require('./timeHelpers.js');
const { computeTradeMetrics, computeStats, groupBy } = require('./metrics.js');
const { getInsideDayStatus } = require('./insideDay.js');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name, fallback) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const SKIP_INSIDE_DAY = args.includes('--no-inside-day');
const OUT_PATH = path.resolve(getArg('--out', path.join(__dirname, 'trade-analysis.xlsx')));
const DB_PATH  = path.join(__dirname, 'trading_orders.db');
const ALPACA_KEY    = process.env.ALPACA_API_KEY    || '';
const ALPACA_SECRET = process.env.ALPACA_API_SECRET || '';

// ---------------------------------------------------------------------------
// DB query — every completed trade, with original (pre-modification)
// stop-loss/take-profit recovered from order_modifications when available.
// ---------------------------------------------------------------------------
function fetchClosedTrades(db) {
    return db.prepare(`
        SELECT
            o.primary_order_id, o.symbol, o.trade_action, o.quantity,
            o.entry_price, o.stop_loss, o.take_profit, o.status,
            ef.fill_price AS event_entry_fill, ef.event_timestamp AS entry_ts,
            xf.fill_price AS event_exit_fill, xf.event_timestamp AS exit_ts,
            o.entry_fill_price AS order_entry_fill,
            o.exit_fill_price AS order_exit_fill,
            o.created_timestamp, o.closed_timestamp,
            origStop.old_price AS orig_stop_mod,
            origTp.old_price AS orig_tp_mod
        FROM orders o
        LEFT JOIN (
            SELECT order_id, fill_price, event_timestamp,
                   ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY event_timestamp DESC) AS rn
            FROM order_events WHERE event_type = 'ENTRY_FILLED'
        ) ef ON ef.order_id = o.primary_order_id AND ef.rn = 1
        LEFT JOIN (
            SELECT order_id, fill_price, event_timestamp,
                   ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY event_timestamp DESC) AS rn
            FROM order_events WHERE event_type = 'EXIT_FILLED'
        ) xf ON xf.order_id = o.primary_order_id AND xf.rn = 1
        LEFT JOIN (
            SELECT order_id, old_price, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY modified_timestamp ASC) AS rn
            FROM order_modifications WHERE leg_type = 'STOP_LOSS'
        ) origStop ON origStop.order_id = o.primary_order_id AND origStop.rn = 1
        LEFT JOIN (
            SELECT order_id, old_price, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY modified_timestamp ASC) AS rn
            FROM order_modifications WHERE leg_type = 'TAKE_PROFIT'
        ) origTp ON origTp.order_id = o.primary_order_id AND origTp.rn = 1
        WHERE o.leg_role = 'ENTRY' AND o.status = 'CLOSED'
        ORDER BY o.created_timestamp ASC
    `).all();
}

// ---------------------------------------------------------------------------
// Sheet-writing helpers
// ---------------------------------------------------------------------------
const TRADE_COLUMNS = [
    { key: 'orderId',          header: 'Order ID',       width: 14 },
    { key: 'symbol',           header: 'Symbol',         width: 9  },
    { key: 'side',             header: 'Long/Short',     width: 10 },
    { key: 'entryDateKey',     header: 'Entry Date',     width: 12 },
    { key: 'dayOfWeek',        header: 'Day of Week',    width: 11 },
    { key: 'quantity',         header: 'Shares',         width: 9  },
    { key: 'entryFill',        header: 'Entry',          width: 10, fmt: '$#,##0.00' },
    { key: 'origStopLoss',     header: 'Stop (Orig)',    width: 11, fmt: '$#,##0.00' },
    { key: 'origTakeProfit',   header: 'Take Profit (Orig)', width: 14, fmt: '$#,##0.00' },
    { key: 'riskSize',         header: 'Risk ($)',       width: 10, fmt: '$#,##0.00' },
    { key: 'pl',               header: 'P/L ($)',        width: 10, fmt: '$#,##0.00;($#,##0.00)' },
    { key: 'rMultiple',        header: 'R-Multiple',     width: 11, fmt: '0.00' },
    { key: 'isDayTrade',       header: 'Day Trade?',     width: 11 },
    { key: 'insideDayStatus',  header: 'Inside Day (9-11am ET)', width: 24 },
    { key: 'exitDateKey',      header: 'Exit Date',      width: 12 },
    { key: 'monthKey',         header: 'Month',          width: 9  },
    { key: 'quarterKey',       header: 'Quarter',        width: 9  },
];

function writeTradeSheet(wb, name, trades) {
    const ws = wb.addSheet(name);
    ws.setColumns(TRADE_COLUMNS.map(c => ({ width: c.width })));
    ws.freezeTopRow();
    ws.addRow(TRADE_COLUMNS.map(c => c.header), { bold: true, fillColor: 'FFD9E1F2' });

    for (const tr of trades) {
        const values = TRADE_COLUMNS.map(c => {
            let v = tr[c.key];
            if (c.key === 'isDayTrade') v = v === true ? 'Yes' : v === false ? 'No' : 'Unknown';
            if (v === null || v === undefined) v = '';
            return v;
        });
        const numFmts = TRADE_COLUMNS.map(c => c.fmt || null);
        const fontColors = TRADE_COLUMNS.map(c =>
            c.key === 'pl' && typeof tr.pl === 'number' ? (tr.pl < 0 ? 'FFCC0000' : 'FF006100') : null
        );
        ws.addRow(values, { numFmts, fontColor: fontColors });
    }
    ws.setAutoFilter(`A1:${String.fromCharCode(64 + TRADE_COLUMNS.length)}1`);
    return ws;
}

function writeStatsBlock(ws, title, stats) {
    ws.addRow([title], { bold: true, fillColor: 'FF4472C4', fontColor: 'FFFFFFFF' });
    ws.addRow(['Total trades', stats.count]);
    ws.addRow(['Trades with known P/L', stats.countWithPL]);
    ws.addRow(['Wins', stats.wins]);
    ws.addRow(['Losses', stats.losses]);
    ws.addRow(['Breakeven', stats.breakeven]);
    ws.addRow(['Accuracy (win rate)', stats.accuracy], { numFmts: [null, '0.0%'] });
    ws.addRow(['Total P/L', stats.totalPL], { numFmts: [null, '$#,##0.00;($#,##0.00)'] });
    ws.addRow(['Average P/L per trade', stats.avgPL], { numFmts: [null, '$#,##0.00;($#,##0.00)'] });
    ws.addRow(['Std Dev of P/L', stats.plStdev], { numFmts: [null, '$#,##0.00'] });
    ws.addRow(['Sharpe (trade-based, $P/L)', stats.sharpePL], { numFmts: [null, '0.00'] });
    ws.addRow(['Average R-Multiple', stats.avgR], { numFmts: [null, '0.00'] });
    ws.addRow(['Std Dev of R-Multiple', stats.rStdev], { numFmts: [null, '0.00'] });
    ws.addRow(['Sharpe (trade-based, R-multiple)', stats.sharpeR], { numFmts: [null, '0.00'] });
    ws.addRow([]);
}

function writePeriodSummarySheet(wb, name, periodMap, labelHeader) {
    const ws = wb.addSheet(name);
    ws.setColumns([{ width: 12 }, { width: 10 }, { width: 8 }, { width: 8 }, { width: 10 },
                    { width: 12 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 9 }, { width: 11 }]);
    ws.freezeTopRow();
    ws.addRow([labelHeader, 'Trades', 'Wins', 'Losses', 'Accuracy', 'Total P/L', 'Avg P/L',
               'Avg R', 'Sharpe (R)', 'Day Trades', 'Multi-Day'], { bold: true, fillColor: 'FFD9E1F2' });

    const sortedKeys = [...periodMap.keys()].sort();
    for (const key of sortedKeys) {
        const list = periodMap.get(key);
        const stats = computeStats(list);
        const dayCount = list.filter(tr => tr.isDayTrade === true).length;
        const multiCount = list.filter(tr => tr.isDayTrade === false).length;
        ws.addRow([
            key, stats.count, stats.wins, stats.losses, stats.accuracy,
            stats.totalPL, stats.avgPL, stats.avgR, stats.sharpeR, dayCount, multiCount
        ], {
            numFmts: [null, null, null, null, '0.0%', '$#,##0.00;($#,##0.00)', '$#,##0.00;($#,##0.00)', '0.00', '0.00', null, null]
        });
    }
    return ws;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`❌  Database not found at ${DB_PATH}`);
        process.exit(1);
    }

    console.log('\n📊  analyzeTradeHistory.js');
    console.log(`    Database : ${DB_PATH}`);
    console.log(`    Output   : ${OUT_PATH}`);
    console.log(`    Inside-day lookups: ${SKIP_INSIDE_DAY ? 'SKIPPED (--no-inside-day)' : (ALPACA_KEY ? 'enabled' : 'disabled — no ALPACA_API_KEY/SECRET set')}\n`);

    const db = new Database(DB_PATH, { readonly: true });
    const rows = fetchClosedTrades(db);
    db.close();

    console.log(`    Closed trades found: ${rows.length}`);
    if (rows.length === 0) {
        console.log('    Nothing to analyze.');
        return;
    }

    const trades = rows.map(computeTradeMetrics);

    // Inside-day lookups — sequential with a small delay to be gentle on
    // Alpaca's rate limits, cached per symbol+day so repeat symbol/day
    // combinations across trades don't re-fetch.
    if (!SKIP_INSIDE_DAY && ALPACA_KEY && ALPACA_SECRET) {
        const cache = new Map();
        let i = 0;
        for (const tr of trades) {
            i++;
            if (tr.entryMs) {
                tr.insideDayStatus = await getInsideDayStatus(tr.symbol, tr.entryMs, ALPACA_KEY, ALPACA_SECRET, cache);
            } else {
                tr.insideDayStatus = 'No data';
            }
            if (i % 10 === 0) console.log(`    Inside-day lookups: ${i}/${trades.length}`);
            await new Promise(r => setTimeout(r, 150)); // gentle rate limiting
        }
    } else {
        trades.forEach(tr => { tr.insideDayStatus = SKIP_INSIDE_DAY ? 'Skipped' : 'No data (no Alpaca credentials)'; });
    }

    const dayTrades      = trades.filter(tr => tr.isDayTrade === true);
    const multiDayTrades = trades.filter(tr => tr.isDayTrade === false);

    const overallStats  = computeStats(trades);
    const dayStats       = computeStats(dayTrades);
    const multiDayStats  = computeStats(multiDayTrades);

    const byMonth   = groupBy(trades, tr => tr.monthKey);
    const byQuarter = groupBy(trades, tr => tr.quarterKey);
    const byYear    = groupBy(trades, tr => tr.yearKey);

    // ---- Build workbook ----
    const wb = new Workbook();

    const overview = wb.addSheet('Overview');
    overview.setColumns([{ width: 32 }, { width: 14 }]);
    overview.addRow(['Trade History Analysis', ''], { bold: true, fillColor: 'FF203864', fontColor: 'FFFFFFFF' });
    overview.addRow([`Generated: ${new Date().toISOString()}`, '']);
    overview.addRow([]);
    writeStatsBlock(overview, 'ALL TRADES', overallStats);
    writeStatsBlock(overview, 'DAY TRADES ONLY', dayStats);
    writeStatsBlock(overview, 'MULTI-DAY TRADES ONLY', multiDayStats);

    writeTradeSheet(wb, 'All Trades', trades);
    writeTradeSheet(wb, 'Day Trades', dayTrades);
    writeTradeSheet(wb, 'Multi-Day Trades', multiDayTrades);

    writePeriodSummarySheet(wb, 'Monthly Summary', byMonth, 'Month');
    writePeriodSummarySheet(wb, 'Quarterly Summary', byQuarter, 'Quarter');
    writePeriodSummarySheet(wb, 'Yearly Summary', byYear, 'Year');

    wb.writeFile(OUT_PATH);

    console.log(`\n=========================================`);
    console.log(`  Total trades analyzed : ${trades.length}`);
    console.log(`  Day trades            : ${dayTrades.length}`);
    console.log(`  Multi-day trades      : ${multiDayTrades.length}`);
    console.log(`  Overall accuracy      : ${overallStats.accuracy !== null ? (overallStats.accuracy * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log(`  Overall Sharpe (R)    : ${overallStats.sharpeR !== null ? overallStats.sharpeR.toFixed(2) : 'N/A'}`);
    console.log(`  Written to            : ${OUT_PATH}`);
    console.log(`=========================================\n`);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
