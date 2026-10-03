/**
 * db.js - SQLite Handler for Trade Station Orders
 */
const Database = require('better-sqlite3');
const path = require('path');

// Initialize database file
const dbPath = path.join(__dirname, 'trading_orders.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency performance
db.pragma('journal_mode = WAL');

// -------------------------------------------------------------------
// DATABASE INITIALIZATION & SCHEMA
// -------------------------------------------------------------------

// Adds `column` to `table` if it doesn't already exist. SQLite's
// CREATE TABLE IF NOT EXISTS is a no-op against an existing DB file, so this
// is what lets older trading_orders.db files pick up new columns without
// the user having to delete/recreate the database.
function ensureColumn(table, column, definition) {
    const existingCols = db.prepare(`PRAGMA table_info(${table})`).all();
    const alreadyExists = existingCols.some(c => c.name === column);
    if (!alreadyExists) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
        console.log(`[SQLite] Migrated: added column ${table}.${column}`);
    }
}

// Drops `column` from `table` if present — used to clean up columns from
// earlier schema versions. Requires SQLite 3.35+ (bundled with any
// reasonably recent better-sqlite3); falls back to a warning rather than
// crashing if the installed SQLite is too old to support DROP COLUMN, since
// a leftover unused column is harmless.
function dropColumnIfExists(table, column) {
    const existingCols = db.prepare(`PRAGMA table_info(${table})`).all();
    const stillExists = existingCols.some(c => c.name === column);
    if (stillExists) {
        try {
            db.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run();
            console.log(`[SQLite] Migrated: dropped column ${table}.${column}`);
        } catch (err) {
            console.warn(`[SQLite] Could not drop ${table}.${column} (SQLite may be too old for DROP COLUMN): ${err.message}`);
        }
    }
}

function initDatabase() {
    // 1. Primary Orders Table
    // Every order TradeStation returns — entry, stop-loss leg, take-profit
    // leg — is stored as its OWN row here (so raw history stays intact and
    // 1:1 with TradeStation's OrderIDs). What links them together:
    //   - parent_order_id : on a STOP_LOSS/TAKE_PROFIT row, the primary_order_id
    //                        of the ENTRY row it belongs to (null on entry rows).
    //   - leg_role         : 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT'
    //   - stop_order_id / tp_order_id (pre-existing) : on an ENTRY row, the
    //                        OrderIDs of its two children, once known.
    db.prepare(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            primary_order_id TEXT UNIQUE,
            stop_order_id TEXT,
            tp_order_id TEXT,
            parent_order_id TEXT,
            leg_role TEXT DEFAULT 'ENTRY',
            symbol TEXT NOT NULL,
            trade_action TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            entry_price REAL NOT NULL,
            stop_loss REAL NOT NULL,
            take_profit REAL NOT NULL,
            order_type TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            entry_fill_price REAL,
            exit_fill_price REAL,
            created_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            closed_timestamp DATETIME,
            raw_payload TEXT
        )
    `).run();

    // Migrate existing DB files created before these columns existed —
    // CREATE TABLE IF NOT EXISTS above only applies to brand-new DB files.
    ensureColumn('orders', 'parent_order_id', 'TEXT');
    ensureColumn('orders', 'leg_role', "TEXT DEFAULT 'ENTRY'");

    // Columns from earlier schema versions that are now redundant —
    // date/time/day-of-week are all derivable from the *_timestamp columns
    // (e.g. strftime('%Y-%m-%d', created_timestamp)), and bracket_group_id
    // turned out to never appear on entry rows, making it useless as a
    // standalone grouping key (parent_order_id + leg_role cover the same
    // need). Dropped if present; no-op on a fresh DB.
    ['bracket_group_id', 'created_time', 'created_date', 'created_day_of_week',
     'exit_time', 'exit_date', 'exit_day_of_week'].forEach(col => dropColumnIfExists('orders', col));

    // 2. Order Modifications Table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS order_modifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT NOT NULL,
            leg_type TEXT NOT NULL, -- ENTRY, STOP_LOSS, TAKE_PROFIT
            old_price REAL,
            new_price REAL NOT NULL,
            modified_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            raw_response TEXT
        )
    `).run();
    ['modified_time', 'modified_date', 'modified_day_of_week']
        .forEach(col => dropColumnIfExists('order_modifications', col));

    // 3. Order Executions & Cancellations Log
    db.prepare(`
        CREATE TABLE IF NOT EXISTS order_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT NOT NULL,
            event_type TEXT NOT NULL, -- FILLED, CANCELLED, REJECTED
            fill_price REAL,
            event_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            details TEXT
        )
    `).run();
    ['event_time', 'event_date', 'event_day_of_week']
        .forEach(col => dropColumnIfExists('order_events', col));

    console.log('[SQLite] Database initialized successfully.');
}

// -------------------------------------------------------------------
// QUERY OPERATIONS
// -------------------------------------------------------------------

/**
 * Log Initial Order Submission
 *
 * @param {string}  primaryOrderId - TradeStation OrderID for THIS row.
 * @param {string}  [stopOrderId]  - (entry rows only) child stop-loss leg's OrderID, once known.
 * @param {string}  [tpOrderId]    - (entry rows only) child take-profit leg's OrderID, once known.
 * @param {string}  [parentOrderId] - (exit-leg rows only) the ENTRY row's primary_order_id.
 * @param {string}  [legRole]      - 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT'. Defaults to 'ENTRY'.
 * @param {object}  payload        - Order payload (Symbol, TradeAction, Quantity, OrderType, LimitPrice/StopPrice, OSOs?).
 * @param {object}  response       - Raw broker response, stored for audit.
 * @param {number}  [stopLoss]     - Pass directly to skip payload.OSOs parsing (used by the history sync).
 * @param {number}  [takeProfit]   - Pass directly to skip payload.OSOs parsing (used by the history sync).
 * @param {Date}    [timestamp]    - Real historical time this order was opened; defaults to now (live trading).
 */
function recordInitialOrder({
    primaryOrderId, stopOrderId, tpOrderId,
    parentOrderId = null, legRole = 'ENTRY',
    payload, response,
    stopLoss, takeProfit,
    timestamp
}) {
    const now = (timestamp instanceof Date && !isNaN(timestamp)) ? timestamp : new Date();

    const stmt = db.prepare(`
        INSERT OR IGNORE INTO orders (
            primary_order_id, stop_order_id, tp_order_id, parent_order_id,
            leg_role, symbol,
            trade_action, quantity, entry_price, stop_loss,
            take_profit, order_type, created_timestamp, raw_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const isStopOrder = payload.OrderType === 'StopMarket';
    const entryPrice = parseFloat(isStopOrder ? payload.StopPrice : payload.LimitPrice);

    // Prefer explicit stopLoss/takeProfit (the history sync resolves these
    // from the linked sibling orders); fall back to parsing a live OSO
    // payload's embedded bracket legs, as the real-time order flow does.
    const resolvedStopLoss = (stopLoss !== undefined && stopLoss !== null)
        ? parseFloat(stopLoss)
        : parseFloat(payload.OSOs?.[0]?.Orders?.find(o => o.OrderType === 'StopMarket')?.StopPrice || 0);
    const resolvedTakeProfit = (takeProfit !== undefined && takeProfit !== null)
        ? parseFloat(takeProfit)
        : parseFloat(payload.OSOs?.[0]?.Orders?.find(o => o.OrderType === 'Limit')?.LimitPrice || 0);

    return stmt.run(
        primaryOrderId,
        stopOrderId || null,
        tpOrderId || null,
        parentOrderId || null,
        legRole,
        payload.Symbol,
        payload.TradeAction,
        parseInt(payload.Quantity, 10),
        entryPrice,
        resolvedStopLoss,
        resolvedTakeProfit,
        payload.OrderType,
        now.toISOString(),
        JSON.stringify({ payload, response })
    );
}

/**
 * Log Order Modifications (Entry, Stop Loss, or Take Profit updates)
 */
function recordModification({ orderId, legType, oldPrice, newPrice, rawResponse, timestamp }) {
    const now = (timestamp instanceof Date && !isNaN(timestamp)) ? timestamp : new Date();

    const stmt = db.prepare(`
        INSERT INTO order_modifications (
            order_id, leg_type, old_price, new_price,
            modified_timestamp, raw_response
        ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(orderId, legType, oldPrice || null, newPrice, now.toISOString(), JSON.stringify(rawResponse));

    // Also update current price in primary orders table
    if (legType === 'ENTRY') {
        db.prepare(`UPDATE orders SET entry_price = ? WHERE primary_order_id = ?`).run(newPrice, orderId);
    } else if (legType === 'STOP_LOSS') {
        db.prepare(`UPDATE orders SET stop_loss = ? WHERE stop_order_id = ? OR primary_order_id = ?`).run(newPrice, orderId, orderId);
    } else if (legType === 'TAKE_PROFIT') {
        db.prepare(`UPDATE orders SET take_profit = ? WHERE tp_order_id = ? OR primary_order_id = ?`).run(newPrice, orderId, orderId);
    }
}

/**
 * Log Fills and Cancellations
 *
 * @param {string} orderId   - Which row's event this is. For EXIT_FILLED/CANCELLED
 *                              fired from the history sync, this is matched against
 *                              primary_order_id OR stop_order_id OR tp_order_id, so
 *                              passing the ENTRY's primary_order_id here is what
 *                              correctly closes out the parent trade row.
 * @param {string} eventType - 'ENTRY_FILLED' | 'EXIT_FILLED' | 'CANCELLED'
 * @param {number} [fillPrice]
 * @param {string} [details]
 * @param {Date}   [timestamp] - Real historical fill/cancel time; defaults to now (live trading).
 */
function recordEvent({ orderId, eventType, fillPrice, details, timestamp }) {
    const now = (timestamp instanceof Date && !isNaN(timestamp)) ? timestamp : new Date();

    const stmt = db.prepare(`
        INSERT INTO order_events (
            order_id, event_type, fill_price, event_timestamp, details
        ) VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(orderId, eventType, fillPrice || null, now.toISOString(), details || '');

    // Update terminal state on primary orders table
    if (eventType === 'ENTRY_FILLED') {
        db.prepare(`UPDATE orders SET status = 'FILLED', entry_fill_price = ? WHERE primary_order_id = ?`).run(fillPrice, orderId);
    } else if (eventType === 'EXIT_FILLED') {
        db.prepare(`
            UPDATE orders
            SET status = 'CLOSED',
                exit_fill_price = ?,
                closed_timestamp = ?
            WHERE primary_order_id = ? OR stop_order_id = ? OR tp_order_id = ?
        `).run(fillPrice, now.toISOString(), orderId, orderId, orderId);
    } else if (eventType === 'CANCELLED') {
        // Guard against clobbering an already-CLOSED trade: when an OCO
        // sibling leg gets auto-cancelled because the OTHER leg just filled
        // (e.g. take-profit shows UROut because the stop-loss filled first),
        // this WHERE also matches the parent entry row via stop_order_id/
        // tp_order_id — without the status check, that would incorrectly
        // overwrite a trade that's genuinely closed back to "cancelled".
        // This also makes event processing order-independent: whichever of
        // EXIT_FILLED / CANCELLED is processed first, CLOSED always wins.
        db.prepare(`
            UPDATE orders
            SET status = 'CANCELLED', closed_timestamp = ?
            WHERE (primary_order_id = ? OR stop_order_id = ? OR tp_order_id = ?)
              AND status != 'CLOSED'
        `).run(now.toISOString(), orderId, orderId, orderId);
    }
}

/**
 * Does a row for this OrderID already exist?
 * (The db module doesn't expose the raw `db` handle, so callers that need
 * to check first — like the history sync — use this instead.)
 */
function orderExists(primaryOrderId) {
    return !!db.prepare(`SELECT 1 FROM orders WHERE primary_order_id = ?`).get(primaryOrderId);
}

/**
 * Has an event of this type already been recorded for this order?
 * Used by the history sync to stay idempotent across repeated runs (the
 * same fill/cancel shouldn't be logged again every time the sync script
 * re-fetches an overlapping date window).
 */
function eventExists(orderId, eventType) {
    return !!db.prepare(`SELECT 1 FROM order_events WHERE order_id = ? AND event_type = ? LIMIT 1`).get(orderId, eventType);
}

// Auto-run schema init on import
initDatabase();

module.exports = {
    recordInitialOrder,
    recordModification,
    recordEvent,
    orderExists,
    eventExists
};
