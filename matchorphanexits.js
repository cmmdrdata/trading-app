#!/usr/bin/env node
/**
 * matchOrphanExits.js
 *
 * TradeStation's historical order data has NO linkage at all between a
 * stop/limit OCO pair placed SEPARATELY to close an existing position and
 * the entry order that originally opened that position — unlike a true
 * 3-leg OSO bracket (entry+stop+target submitted together), which carries
 * exact OrderID references the whole way through. See classifyOrder() in
 * syncTradStationHisotryToDb.js for the full explanation of why; those
 * orphaned exits are synced correctly (their OWN fill price/time is
 * accurate) but sit with parent_order_id = NULL, so they never show up as
 * a completed, chartable trade.
 *
 * This script closes that gap with a best-effort heuristic: for each
 * orphaned, filled exit leg, find the most likely entry it closed —
 *   - same symbol
 *   - same quantity   (exact match only; split/partial closes won't match —
 *                       see the note at the bottom of this file)
 *   - entry's fill time strictly BEFORE the exit's fill time
 *   - FIFO: if more than one entry qualifies, claim the EARLIEST one that
 *     hasn't already been claimed by a different exit in this same run
 *
 * This is a GUESS, not a confirmed link — unlike the exact ID-based linking
 * the main sync does. Every heuristic match is labeled as such directly in
 * order_events.details, so it stays distinguishable from a confirmed match:
 *   grep for "HEURISTIC MATCH" vs "synced from TS history" in that column.
 *
 * Idempotent: already-matched exits (parent_order_id already set) and
 * already-closed entries (status='CLOSED') are excluded from consideration,
 * so re-running this after more data comes in only matches what's new.
 *
 * Usage:
 *   node matchOrphanExits.js            # match and write
 *   node matchOrphanExits.js --dry-run  # show what would match, write nothing
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const db       = require('./db.js'); // for recordEvent — keeps status/exit_fill_price/closed_timestamp logic in one place

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = path.join(__dirname, 'trading_orders.db');

function openDb() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`❌  Database not found at ${DB_PATH}`);
        process.exit(1);
    }
    // Separate connection from db.js's own — fine under WAL (already enabled),
    // and keeps this script's ad-hoc reads/writes out of db.js's narrower API.
    const raw = new Database(DB_PATH);
    raw.pragma('journal_mode = WAL');
    return raw;
}

// Most recent fill event recorded for this order — every row (entry or exit
// leg alike) gets an ENTRY_FILLED event fired on its OWN row when it fills,
// regardless of leg_role, so this works for both sides of a match.
function getFillEvent(raw, orderId) {
    return raw.prepare(`
        SELECT fill_price, event_timestamp FROM order_events
        WHERE order_id = ? AND event_type = 'ENTRY_FILLED'
        ORDER BY event_timestamp DESC LIMIT 1
    `).get(orderId) || null;
}

function main() {
    const raw = openDb();

    // Candidate entries: filled, not already closed (CLOSED means something
    // — ID-linked or a previous heuristic match — already claimed it).
    const entries = raw.prepare(`
        SELECT primary_order_id, symbol, quantity
        FROM orders
        WHERE leg_role = 'ENTRY' AND status = 'FILLED'
    `).all()
        .map(e => ({ ...e, fillTs: getFillEvent(raw, e.primary_order_id)?.event_timestamp || null }))
        .filter(e => e.fillTs);

    // Orphaned exits: genuinely filled, with no parent known yet.
    const exits = raw.prepare(`
        SELECT primary_order_id, symbol, quantity, leg_role
        FROM orders
        WHERE leg_role IN ('STOP_LOSS', 'TAKE_PROFIT')
          AND parent_order_id IS NULL
          AND status = 'FILLED'
    `).all()
        .map(x => ({ ...x, fillEvent: getFillEvent(raw, x.primary_order_id) }))
        .filter(x => x.fillEvent)
        .sort((a, b) => a.fillEvent.event_timestamp.localeCompare(b.fillEvent.event_timestamp)); // earliest exit first

    console.log(`\n🔗  matchOrphanExits.js${DRY_RUN ? '  [DRY RUN]' : ''}`);
    console.log(`    Candidate filled entries : ${entries.length}`);
    console.log(`    Orphaned filled exits     : ${exits.length}\n`);

    const claimed = new Set();
    let matched = 0, unmatched = 0;

    for (const exit of exits) {
        const candidates = entries
            .filter(e => !claimed.has(e.primary_order_id))
            .filter(e => e.symbol === exit.symbol)
            .filter(e => e.quantity === exit.quantity)
            .filter(e => e.fillTs < exit.fillEvent.event_timestamp)
            .sort((a, b) => a.fillTs.localeCompare(b.fillTs)); // FIFO: earliest first

        if (candidates.length === 0) {
            unmatched++;
            continue;
        }

        const entry = candidates[0];
        claimed.add(entry.primary_order_id);
        matched++;

        console.log(`   ${DRY_RUN ? 'would match' : 'matched'}  ${exit.leg_role.padEnd(11)} ${exit.primary_order_id} (${exit.symbol} x${exit.quantity}) -> entry ${entry.primary_order_id}`);

        if (DRY_RUN) continue;

        // Link the exit leg's row back to its matched entry...
        raw.prepare(`UPDATE orders SET parent_order_id = ? WHERE primary_order_id = ?`)
            .run(entry.primary_order_id, exit.primary_order_id);

        // ...and the entry's row forward to this exit leg, same convention a true bracket uses.
        const childCol = exit.leg_role === 'STOP_LOSS' ? 'stop_order_id' : 'tp_order_id';
        raw.prepare(`UPDATE orders SET ${childCol} = ? WHERE primary_order_id = ?`)
            .run(exit.primary_order_id, entry.primary_order_id);

        // Fire EXIT_FILLED on the entry — reuses db.js's existing logic for
        // status='CLOSED', exit_fill_price, closed_timestamp. Guarded by
        // eventExists so re-running this script is safe.
        if (!db.eventExists(entry.primary_order_id, 'EXIT_FILLED')) {
            db.recordEvent({
                orderId: entry.primary_order_id,
                eventType: 'EXIT_FILLED',
                fillPrice: exit.fillEvent.fill_price,
                details: `HEURISTIC MATCH (symbol+quantity, not ID-linked): closed by ${exit.leg_role} leg ${exit.primary_order_id}`,
                timestamp: new Date(exit.fillEvent.event_timestamp)
            });
        }
    }

    console.log(`\n=========================================`);
    console.log(`  Matched   : ${matched}`);
    console.log(`  Unmatched : ${unmatched}  (no same-symbol/quantity entry filled before this exit)`);
    console.log(`=========================================`);
    if (DRY_RUN) console.log('  (dry run — no changes written)\n'); else console.log('');

    raw.close();
}

main();

/**
 * Known limitation: exact-quantity matching only. If a position was opened
 * across multiple entries (e.g. two 50-share buys) and closed in one
 * 100-share order, or vice versa, neither side's quantity matches the
 * other and it won't link. Those will show up as "unmatched" above —
 * worth spot-checking if that count looks high for your trading style.
 */
