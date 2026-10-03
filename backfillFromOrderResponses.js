#!/usr/bin/env node
/**
 * backfillFromOrderResponses.js
 *
 * One-time recovery tool: reads the order_responses/*.txt files your server
 * writes on every OSO submission (via /api/log-order-response) and uses the
 * TradeStation response's real OrderIDs — logged right when the order was
 * placed — to backfill stop_loss/take_profit/stop_order_id/tp_order_id/
 * parent_order_id on trades the sync couldn't link on its own.
 *
 * Why this is more reliable than guessing: each file contains both the
 * exact submitted OSO payload (entry + stop + target prices) AND
 * TradeStation's response, which returns the real OrderID for all three
 * legs. Matching response entries to payload legs is done by CONTENT
 * (action + symbol + quantity + price parsed from each response order's
 * "Message" text), not by assuming a fixed array order — this is robust to
 * however TradeStation happens to order that array.
 *
 * Safety policy:
 *   - Only fills in fields that are currently empty (0 / NULL). Never
 *     silently overwrites an existing non-empty value that disagrees with
 *     what a file says — those get reported as CONFLICTS for you to look
 *     at by hand, not auto-resolved. (This includes cases where an exit was
 *     previously linked by the symbol+quantity heuristic matcher to a
 *     DIFFERENT entry than this exact evidence points to — worth a manual
 *     look rather than this script silently rewriting history.)
 *   - Skips files whose OrderIDs aren't in the `orders` table yet (means
 *     that order hasn't been synced from TradeStation's history yet — run
 *     the sync first).
 *   - Idempotent — safe to re-run; already-filled fields are simply skipped.
 *
 * Usage:
 *   node backfillFromOrderResponses.js              # apply
 *   node backfillFromOrderResponses.js --dry-run     # preview only
 *   node backfillFromOrderResponses.js --dir ./order_responses   # (default)
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const db       = require('./db.js'); // for recordEvent (EXIT_FILLED side effects)

const DRY_RUN   = process.argv.includes('--dry-run');
const dirArgIdx = process.argv.indexOf('--dir');
const RESPONSES_DIR = path.resolve(
    dirArgIdx !== -1 && process.argv[dirArgIdx + 1] ? process.argv[dirArgIdx + 1]
                                                     : path.join(__dirname, 'order-responses')
);
const DB_PATH = path.join(__dirname, 'trading_orders.db');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function actionToBuyOrSell(action) {
    const a = (action || '').toUpperCase();
    if (a === 'BUY' || a === 'BUYTOCOVER') return 'Buy';
    if (a === 'SELL' || a === 'SELLSHORT') return 'Sell';
    return null;
}

/**
 * Parse one order_responses/*.txt file into { symbol, quantity,
 * entryOrderId, stopOrderId, tpOrderId, stopPrice, tpPrice, ... } or
 * { error } if it can't be used (not an OSO, malformed, etc).
 */
function parseOrderResponseFile(content, sourceFile) {
    const loggedAtMatch = /^Logged at:\s*(.+)$/m.exec(content);
    const loggedAt = loggedAtMatch ? loggedAtMatch[1].trim() : null;

    const payloadMatch  = /Submitted payload:\s*\n([\s\S]*?)\n\nTradeStation response:/.exec(content);
    const responseMatch = /TradeStation response:\s*\n([\s\S]*?)\s*$/.exec(content);
    if (!payloadMatch || !responseMatch) {
        return { error: 'Could not find payload/response sections', sourceFile };
    }

    let payload, response;
    try {
        payload = JSON.parse(payloadMatch[1]);
        response = JSON.parse(responseMatch[1]);
    } catch (e) {
        return { error: `JSON parse failed: ${e.message}`, sourceFile };
    }

    if (payload.Type !== 'OSO' || !Array.isArray(payload.OSOs) || payload.OSOs.length === 0) {
        return { error: 'Not an OSO payload (or no OSOs) — skipping', sourceFile };
    }

    const children = (payload.OSOs[0] && payload.OSOs[0].Orders) || [];
    if (children.length !== 2) {
        return { error: `Expected 2 child orders, found ${children.length}`, sourceFile };
    }

    const stopChild = children.find(o => o.OrderType === 'StopMarket');
    const tpChild    = children.find(o => o.OrderType === 'Limit');
    if (!stopChild || !tpChild) {
        return { error: 'Could not identify stop/tp children by OrderType', sourceFile };
    }

    const expectedLegs = [
        {
            role: 'ENTRY',
            buyOrSell: actionToBuyOrSell(payload.TradeAction),
            price: parseFloat(payload.StopPrice || payload.LimitPrice || 0),
            quantity: parseInt(payload.Quantity, 10),
            symbol: payload.Symbol
        },
        {
            role: 'STOP_LOSS',
            buyOrSell: actionToBuyOrSell(stopChild.TradeAction),
            price: parseFloat(stopChild.StopPrice || 0),
            quantity: parseInt(stopChild.Quantity, 10),
            symbol: stopChild.Symbol
        },
        {
            role: 'TAKE_PROFIT',
            buyOrSell: actionToBuyOrSell(tpChild.TradeAction),
            price: parseFloat(tpChild.LimitPrice || 0),
            quantity: parseInt(tpChild.Quantity, 10),
            symbol: tpChild.Symbol
        }
    ];

    const responseOrders = response.Orders || [];
    const matchedIds = {};
    const usedRoles = new Set();
    const unparsedMessages = [];

    for (const respOrder of responseOrders) {
        const msg = respOrder.Message || '';
        const m = /Sent order:\s*(Buy|Sell)\s+([\d,]+)\s+(\S+)\s+@\s+([\d.]+)\s+(.+)/.exec(msg);
        if (!m) { unparsedMessages.push(msg); continue; }

        const [, msgAction, msgQtyStr, msgSymbol, msgPriceStr] = m;
        const msgQty = parseInt(msgQtyStr.replace(/,/g, ''), 10);
        const msgPrice = parseFloat(msgPriceStr);

        for (const leg of expectedLegs) {
            if (usedRoles.has(leg.role)) continue;
            if (leg.buyOrSell === msgAction &&
                leg.quantity === msgQty &&
                leg.symbol === msgSymbol &&
                Math.abs(leg.price - msgPrice) < 0.005) {
                matchedIds[leg.role] = respOrder.OrderID;
                usedRoles.add(leg.role);
                break;
            }
        }
    }

    return {
        sourceFile,
        loggedAt,
        symbol: payload.Symbol,
        quantity: parseInt(payload.Quantity, 10),
        entryOrderId: matchedIds.ENTRY || null,
        stopOrderId:  matchedIds.STOP_LOSS || null,
        tpOrderId:    matchedIds.TAKE_PROFIT || null,
        stopPrice:    expectedLegs[1].price,
        tpPrice:      expectedLegs[2].price,
        allThreeMatched: usedRoles.size === 3,
        unparsedMessages
    };
}

// ---------------------------------------------------------------------------
// DB helpers (direct, read-write connection — separate from db.js's own,
// same pattern matchOrphanExits.js already uses)
// ---------------------------------------------------------------------------

function openDb() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`❌  Database not found at ${DB_PATH}`);
        process.exit(1);
    }
    const raw = new Database(DB_PATH);
    raw.pragma('journal_mode = WAL');
    return raw;
}

function getOrder(raw, orderId) {
    return raw.prepare(`SELECT * FROM orders WHERE primary_order_id = ?`).get(orderId) || null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    if (!fs.existsSync(RESPONSES_DIR)) {
        console.error(`❌  Directory not found: ${RESPONSES_DIR}`);
        process.exit(1);
    }

    const files = fs.readdirSync(RESPONSES_DIR).filter(f => f.endsWith('.txt'));
    console.log(`\n📂  backfillFromOrderResponses${DRY_RUN ? '  [DRY RUN]' : ''}`);
    console.log(`    Directory : ${RESPONSES_DIR}`);
    console.log(`    Files found: ${files.length}\n`);

    const raw = openDb();

    let parsedOk = 0, parseErrors = 0, notYetSynced = 0;
    let fieldsFilledCount = 0, conflictCount = 0, fullyCleanCount = 0;
    const conflicts = [];
    const notSyncedList = [];
    const parseErrorList = [];

    for (const file of files) {
        const content = fs.readFileSync(path.join(RESPONSES_DIR, file), 'utf8');
        const result = parseOrderResponseFile(content, file);

        if (result.error) {
            parseErrors++;
            parseErrorList.push(`${file}: ${result.error}`);
            continue;
        }
        if (!result.allThreeMatched) {
            parseErrors++;
            parseErrorList.push(`${file}: only matched ${Object.values([result.entryOrderId, result.stopOrderId, result.tpOrderId]).filter(Boolean).length}/3 legs (unparsed messages: ${JSON.stringify(result.unparsedMessages)})`);
            continue;
        }
        parsedOk++;

        const entryRow = getOrder(raw, result.entryOrderId);
        const stopRow  = getOrder(raw, result.stopOrderId);
        const tpRow    = getOrder(raw, result.tpOrderId);

        if (!entryRow) {
            notYetSynced++;
            notSyncedList.push(`${file}: entry ${result.entryOrderId} (${result.symbol}) not in orders table yet`);
            continue;
        }

        let thisFileHadConflict = false;
        let thisFileHadFill = false;

        // --- Entry row: stop_loss / take_profit / stop_order_id / tp_order_id ---
        const checks = [
            { field: 'stop_loss',     newVal: result.stopPrice,    isPrice: true },
            { field: 'take_profit',   newVal: result.tpPrice,      isPrice: true },
            { field: 'stop_order_id', newVal: result.stopOrderId,  isPrice: false },
            { field: 'tp_order_id',   newVal: result.tpOrderId,    isPrice: false },
        ];

        for (const { field, newVal, isPrice } of checks) {
            const current = entryRow[field];
            const isEmpty = isPrice ? (!current || current === 0) : !current;

            if (isEmpty) {
                if (!DRY_RUN) {
                    raw.prepare(`UPDATE orders SET ${field} = ? WHERE primary_order_id = ?`)
                        .run(newVal, result.entryOrderId);
                }
                console.log(`   ${DRY_RUN ? 'would fill' : 'filled'}  ${result.entryOrderId} (${result.symbol}).${field} = ${newVal}  [from ${file}]`);
                fieldsFilledCount++;
                thisFileHadFill = true;
            } else {
                const matches = isPrice ? Math.abs(current - newVal) < 0.005 : current === newVal;
                if (!matches) {
                    conflictCount++;
                    thisFileHadConflict = true;
                    const msg = `${result.entryOrderId} (${result.symbol}).${field}: DB has ${current}, ${file} says ${newVal} — NOT changed, review manually`;
                    conflicts.push(msg);
                    console.log(`   ⚠️  CONFLICT  ${msg}`);
                }
            }
        }

        // --- Exit leg rows: parent_order_id ---
        for (const [legRow, legId] of [[stopRow, result.stopOrderId], [tpRow, result.tpOrderId]]) {
            if (!legRow) {
                notYetSynced++;
                notSyncedList.push(`${file}: leg ${legId} (${result.symbol}) not in orders table yet`);
                continue;
            }
            if (!legRow.parent_order_id) {
                if (!DRY_RUN) {
                    raw.prepare(`UPDATE orders SET parent_order_id = ? WHERE primary_order_id = ?`)
                        .run(result.entryOrderId, legId);
                }
                console.log(`   ${DRY_RUN ? 'would fill' : 'filled'}  ${legId} (${result.symbol}).parent_order_id = ${result.entryOrderId}  [from ${file}]`);
                fieldsFilledCount++;
                thisFileHadFill = true;
            } else if (legRow.parent_order_id !== result.entryOrderId) {
                conflictCount++;
                thisFileHadConflict = true;
                const msg = `${legId} (${result.symbol}).parent_order_id: DB has ${legRow.parent_order_id}, ${file} says ${result.entryOrderId} — NOT changed, review manually`;
                conflicts.push(msg);
                console.log(`   ⚠️  CONFLICT  ${msg}`);
            }
        }

        if (!thisFileHadConflict && !thisFileHadFill) fullyCleanCount++;
    }

    console.log(`\n=========================================`);
    console.log(`  Files found            : ${files.length}`);
    console.log(`  Fully parsed (3 legs)   : ${parsedOk}`);
    console.log(`  Parse errors/skipped    : ${parseErrors}`);
    console.log(`  Not yet synced (skipped): ${notYetSynced}`);
    console.log(`  Fields filled in        : ${fieldsFilledCount}`);
    console.log(`  Conflicts (not touched) : ${conflictCount}`);
    console.log(`  Already fully correct   : ${fullyCleanCount}`);
    console.log(`=========================================`);
    if (DRY_RUN) console.log('  (dry run — no changes written)\n'); else console.log('');

    if (conflicts.length > 0) {
        console.log('--- Conflicts needing manual review ---');
        conflicts.forEach(c => console.log('  ' + c));
        console.log('');
    }
    if (notSyncedList.length > 0 && notSyncedList.length <= 20) {
        console.log('--- Not yet synced (run the sync, then re-run this) ---');
        notSyncedList.forEach(n => console.log('  ' + n));
        console.log('');
    } else if (notSyncedList.length > 20) {
        console.log(`--- ${notSyncedList.length} orders not yet synced (too many to list — run the sync first) ---\n`);
    }
    if (parseErrorList.length > 0 && parseErrorList.length <= 20) {
        console.log('--- Parse errors/skipped files ---');
        parseErrorList.forEach(p => console.log('  ' + p));
        console.log('');
    }

    raw.close();
}

main();
