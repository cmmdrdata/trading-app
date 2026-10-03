#!/usr/bin/env node
/**
 * chart-from-db.js
 *
 * Reads completed trades directly from trading_orders.db and generates
 * a trade chart PNG for each one that hasn't been charted yet.
 *
 * A "completed trade" is any row in the `orders` table that has:
 *   - leg_role = 'ENTRY'   (STOP_LOSS/TAKE_PROFIT rows are legs, not trades —
 *                           their own stop_loss/take_profit are always 0)
 *   - status   = 'CLOSED'  (a real, confirmed exit — not just FILLED/still-open)
 *   - an ENTRY_FILLED event in order_events  (gives us entryTime + fillPrice)
 *   - an EXIT_FILLED  event in order_events  (gives us exitTime  + exitPrice)
 *
 * NOTE: status only reaches 'CLOSED' when an exit leg's fill can be traced
 * back to its entry via TradeStation's own order linkage. Exits placed as a
 * separate stop/limit OCO pair (not submitted together with the entry as one
 * OSO) have no such link in TradeStation's data, so they won't produce a
 * 'CLOSED' row here even though the position really did close — see
 * syncTradStationHisotryToDb.js's classifyOrder() for the full explanation.
 *
 * Usage:
 *   node chart-from-db.js [--days 30] [--out ./order-responses]
 *
 * Defaults:
 *   --days  30  (only chart trades from the last N calendar days)
 *   --out   ./order-responses
 */

'use strict';

require('dotenv').config();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const { generateTradeChart } = require('./trade-chart');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name, fallback) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const DAYS    = parseInt(getArg('--days', '30'), 10);
const OUT_DIR = path.resolve(getArg('--out', path.join(__dirname, 'order-responses')));

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, 'trading_orders.db');

function openDb() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`❌  Database not found at ${DB_PATH}`);
        console.error('    Run syncTradStationHisotryToDb.js first to populate it.');
        process.exit(1);
    }
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
    return db;
}

// ---------------------------------------------------------------------------
// Market-open (9:00 AM America/New_York) boundary helpers
//
// Using exact "now minus N*24h" math for the --days lookback means the
// window's start point drifts with whatever time of day the script happens
// to run — e.g. running at 11pm vs 6am gives you different effective
// windows. Anchoring the start to 9:00 AM Eastern on the appropriate
// calendar day instead gives a stable, market-aligned cutoff regardless of
// when the script runs. Intl's America/New_York zone handles the EST/EDT
// switch automatically — no DST table to maintain here.
// ---------------------------------------------------------------------------
function easternOffsetMinutesAt(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'shortOffset'
    }).formatToParts(date);
    const offsetStr = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
    const match = /GMT([+-]\d+)/.exec(offsetStr);
    return match ? parseInt(match[1], 10) * 60 : -300; // fallback: EST
}

/**
 * Unix ms for 9:00 AM America/New_York on the SAME Eastern calendar date
 * as the given timestamp. Used to anchor each trade's chart to market
 * open for its own trading day, regardless of the exact moment it filled.
 */
function marketOpenForDate(ms) {
    const nyParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(ms));
    const y = parseInt(nyParts.find(p => p.type === 'year').value, 10);
    const m = parseInt(nyParts.find(p => p.type === 'month').value, 10);
    const d = parseInt(nyParts.find(p => p.type === 'day').value, 10);

    const noonGuessUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const offsetMin = easternOffsetMinutesAt(noonGuessUTC);
    return Date.UTC(y, m - 1, d, 9, 0, 0) - offsetMin * 60 * 1000;
}

/**
 * Unix ms for 9:00 AM America/New_York, `daysAgo` calendar days before
 * today (today is also taken in Eastern's own calendar, so this lines up
 * with trading-day boundaries regardless of the server's local timezone).
 */
function marketOpenEasternMs(daysAgo) {
    const now = new Date();
    const nyParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const y = parseInt(nyParts.find(p => p.type === 'year').value, 10);
    const m = parseInt(nyParts.find(p => p.type === 'month').value, 10);
    const d = parseInt(nyParts.find(p => p.type === 'day').value, 10);

    // Noon UTC guess avoids landing exactly on a DST transition (those
    // happen at 2am local), so the offset we read off is always correct
    // for the target calendar date.
    const noonGuessUTC = new Date(Date.UTC(y, m - 1, d - daysAgo, 12, 0, 0));
    const offsetMin = easternOffsetMinutesAt(noonGuessUTC);

    return Date.UTC(y, m - 1, d - daysAgo, 9, 0, 0) - offsetMin * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Query: pull completed trades joined to their entry & exit events
//
// Schema recap (current):
//   orders        : primary_order_id, leg_role ('ENTRY'|'STOP_LOSS'|'TAKE_PROFIT'),
//                   symbol, trade_action, quantity, entry_price, stop_loss,
//                   take_profit, entry_fill_price, exit_fill_price, status,
//                   created_timestamp, closed_timestamp (ISO 8601 strings)
//   order_events  : order_id, event_type, fill_price, event_timestamp (ISO 8601)
//
// leg_role='ENTRY' is required here: STOP_LOSS/TAKE_PROFIT rows are order
// LEGS, not trades in their own right (their own stop_loss/take_profit are
// always 0 — those only ever get set on the entry row), so charting them
// directly would produce a nonsense chart.
//
// We join order_events twice — once for ENTRY_FILLED, once for EXIT_FILLED —
// using ROW_NUMBER() to reliably pick the most recent event per order,
// rather than the old `GROUP BY ... HAVING col = MAX(col)` pattern (which
// doesn't reliably bind the other selected columns to the max row in SQLite).
// ---------------------------------------------------------------------------
function fetchCompletedTrades(db, sinceDays) {
    // Anchored to 9:00 AM Eastern on the start day, not exact clock-time
    // subtraction from "now" — see marketOpenEasternMs() above for why.
    const since = new Date(marketOpenEasternMs(sinceDays)).toISOString();

    const rows = db.prepare(`
        SELECT
            o.primary_order_id,
            o.symbol,
            o.trade_action,
            o.quantity,
            o.entry_price,
            o.stop_loss,
            o.take_profit,
            o.status,

            -- Entry fill details from order_events (preferred — exact fill moment)
            ef.fill_price      AS event_entry_fill_price,
            ef.event_timestamp AS event_entry_timestamp,

            -- Exit fill details from order_events
            xf.fill_price      AS event_exit_fill_price,
            xf.event_timestamp AS event_exit_timestamp,

            -- Fall back to order-level columns when events are missing
            o.entry_fill_price  AS order_entry_fill,
            o.exit_fill_price   AS order_exit_fill,
            o.created_timestamp AS order_created_ts,
            o.closed_timestamp  AS order_closed_ts,

            -- The stop's value BEFORE its first modification, if it was ever
            -- trailed/moved — orders.stop_loss gets overwritten in place by
            -- recordModification(), so this is the only place the original
            -- value survives. NULL here just means "never modified", in
            -- which case o.stop_loss itself already IS the original.
            firstMod.old_price AS orig_stop_loss_mod

        FROM orders o

        LEFT JOIN (
            SELECT order_id, fill_price, event_timestamp,
                   ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY event_timestamp DESC) AS rn
            FROM order_events
            WHERE event_type = 'ENTRY_FILLED'
        ) ef ON ef.order_id = o.primary_order_id AND ef.rn = 1

        LEFT JOIN (
            SELECT order_id, fill_price, event_timestamp,
                   ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY event_timestamp DESC) AS rn
            FROM order_events
            WHERE event_type = 'EXIT_FILLED'
        ) xf ON xf.order_id = o.primary_order_id AND xf.rn = 1

        LEFT JOIN (
            SELECT order_id, old_price,
                   ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY modified_timestamp ASC) AS rn
            FROM order_modifications
            WHERE leg_type = 'STOP_LOSS'
        ) firstMod ON firstMod.order_id = o.primary_order_id AND firstMod.rn = 1

        WHERE
            o.leg_role = 'ENTRY'
            AND o.status = 'CLOSED'
            AND o.created_timestamp >= ?

        ORDER BY o.created_timestamp ASC
    `).all(since);

    return rows;
}

// ---------------------------------------------------------------------------
// Parse an ISO 8601 timestamp string into unix ms. Returns null if missing
// or unparseable.
// ---------------------------------------------------------------------------
function toMs(isoStr) {
    if (!isoStr) return null;
    const ms = new Date(isoStr).getTime();
    return isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Determine exit reason from order data
// ---------------------------------------------------------------------------
function inferExitReason(row) {
    // If the exit fill price is near or below the stop loss → stopped out
    const exitPrice = row.event_exit_fill_price || row.order_exit_fill || 0;
    const stopLoss  = row.stop_loss || 0;
    const takeProfit = row.take_profit || 0;
    const side = (row.trade_action || '').toUpperCase();

    if (stopLoss > 0 && exitPrice > 0) {
        if (side === 'BUY' || side === 'BUYTOOPEN') {
            if (Math.abs(exitPrice - stopLoss)  < Math.abs(exitPrice - takeProfit)) return 'stop';
            if (Math.abs(exitPrice - takeProfit) < Math.abs(exitPrice - stopLoss))  return 'target';
        } else {
            // Short
            if (Math.abs(exitPrice - stopLoss)  < Math.abs(exitPrice - takeProfit)) return 'stop';
            if (Math.abs(exitPrice - takeProfit) < Math.abs(exitPrice - stopLoss))  return 'target';
        }
    }
    return 'terminated';
}

// ---------------------------------------------------------------------------
// Chart filename helpers — must match trade-chart.js convention exactly:
//   trade-chart_<SYMBOL>_<MM>-<DD>-<YY>_<HH>-<MIN>.png
// ---------------------------------------------------------------------------
function chartFilename(symbol, entryTimeMs) {
    // Must match trade-chart.js's own filename generation exactly (Eastern
    // time, not server-local) — otherwise alreadyCharted() below predicts a
    // different name than what actually gets saved, and every trade looks
    // "not yet charted" forever whenever the server isn't in US Eastern time.
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: '2-digit', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(entryTimeMs).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return `trade-chart_${symbol}_${parts.month}-${parts.day}-${parts.year}_${parts.hour}-${parts.minute}.png`;
}

function alreadyCharted(outDir, symbol, entryTimeMs) {
    return fs.existsSync(path.join(outDir, chartFilename(symbol, entryTimeMs)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const alpacaKey    = process.env.ALPACA_API_KEY    || '';
    const alpacaSecret = process.env.ALPACA_API_SECRET || '';

    if (!alpacaKey || !alpacaSecret) {
        console.warn('⚠️  ALPACA_API_KEY / ALPACA_API_SECRET not set — charts will show "No bar data available".');
    }

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log('\n📊  chart-from-db.js');
    console.log(`    Database : ${DB_PATH}`);
    console.log(`    Lookback : ${DAYS} days (from 9:00 AM Eastern on ${new Date(marketOpenEasternMs(DAYS)).toLocaleDateString('en-US', { timeZone: 'America/New_York' })})`);
    console.log(`    Output   : ${OUT_DIR}\n`);

    const db    = openDb();
    const rows  = fetchCompletedTrades(db, DAYS);
    db.close();

    console.log(`    Trades in DB : ${rows.length} completed trade(s) found\n`);

    if (rows.length === 0) {
        console.log('    Nothing to chart.');
        return;
    }

    let charted = 0, skipped = 0, failed = 0;

    for (const row of rows) {
        const symbol = row.symbol || 'UNKNOWN';

        // Resolve entry timestamp — prefer the order_events row, fall back to created_timestamp
        const entryTimeMs = toMs(row.event_entry_timestamp) || toMs(row.order_created_ts);

        if (!entryTimeMs) {
            console.log(`   ⚠️  ${symbol} (${row.primary_order_id}) — no entry timestamp, skipping`);
            skipped++;
            continue;
        }

        // Resolve exit timestamp — prefer the order_events row, fall back to closed_timestamp
        const exitTimeMs = toMs(row.event_exit_timestamp) || toMs(row.order_closed_ts);

        // Resolve fill prices — prefer event rows, fall back to order columns
        const fillPrice  = row.event_entry_fill_price || row.order_entry_fill || row.entry_price || 0;
        const exitPrice  = row.event_exit_fill_price  || row.order_exit_fill  || 0;

        // Original stop loss: the stop's value before its first modification,
        // if it was ever trailed — otherwise the current stop_loss already IS
        // the original (never changed).
        const origStopLoss = row.orig_stop_loss_mod || row.stop_loss || 0;

        // Theoretical 1R target: same distance from entry as the ORIGINAL
        // stop, projected on the other side — direction-agnostic (works for
        // both long and short) based purely on which side of entry the stop
        // sits on, rather than trusting trade_action.
        let oneRTarget = 0;
        if (fillPrice > 0 && origStopLoss > 0) {
            const risk = Math.abs(fillPrice - origStopLoss);
            oneRTarget = fillPrice > origStopLoss ? fillPrice + risk : fillPrice - risk;
        }

        const fname = chartFilename(symbol, entryTimeMs);

        if (alreadyCharted(OUT_DIR, symbol, entryTimeMs)) {
            console.log(`   ⏭  ${fname} — already exists, skipping`);
            skipped++;
            continue;
        }

        const side = (row.trade_action || 'BUY').toUpperCase() === 'SELLSHORT' ? 'SELL' : 'BUY';

        const tradeOpts = {
            symbol,
            side,
            shares:       row.quantity || 0,
            entryPrice:   row.entry_price   || fillPrice,
            fillPrice,
            stopLoss:     row.stop_loss     || 0,
            profitTarget: row.take_profit   || 0,
            origStopLoss,
            oneRTarget,
            exitPrice,
            exitReason:   inferExitReason(row),
            // entryTime stays the REAL fill moment — trade-chart.js uses it
            // for the entry marker, chart title, and its own filename (which
            // must match chartFilename() below for the dedup check to work).
            // chartWindowStart is the separate 9am-Eastern-market-open value
            // that controls where bar-fetching/the x-axis actually starts.
            entryTime:        entryTimeMs,
            chartWindowStart: marketOpenForDate(entryTimeMs),
            exitTime:     exitTimeMs || Date.now(),
            partialSells: [],
            alpacaKey,
            alpacaSecret,
            outputDir:    OUT_DIR
        };

        try {
            const file = await generateTradeChart(tradeOpts);
            console.log(`   ✅  ${path.basename(file)}`);
            charted++;
        } catch (err) {
            console.error(`   ❌  ${fname} — ${err.message}`);
            failed++;
        }
    }

    console.log(`\n=========================================`);
    console.log(`  Charts generated : ${charted}`);
    console.log(`  Skipped          : ${skipped}`);
    console.log(`  Failed           : ${failed}`);
    console.log(`=========================================\n`);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
