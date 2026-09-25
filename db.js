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
function initDatabase() {
    // 1. Primary Orders Table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            primary_order_id TEXT UNIQUE,
            stop_order_id TEXT,
            tp_order_id TEXT,
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
            created_time TEXT NOT NULL,
            created_date TEXT NOT NULL,
            created_day_of_week TEXT NOT NULL,
            created_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            closed_timestamp DATETIME,
            raw_payload TEXT
        )
    `).run();

    // 2. Order Modifications Table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS order_modifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT NOT NULL,
            leg_type TEXT NOT NULL, -- ENTRY, STOP_LOSS, TAKE_PROFIT
            old_price REAL,
            new_price REAL NOT NULL,
            modified_time TEXT NOT NULL,
            modified_date TEXT NOT NULL,
            modified_day_of_week TEXT NOT NULL,
            modified_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            raw_response TEXT
        )
    `).run();

    // 3. Order Executions & Cancellations Log
    db.prepare(`
        CREATE TABLE IF NOT EXISTS order_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT NOT NULL,
            event_type TEXT NOT NULL, -- FILLED, CANCELLED, REJECTED
            fill_price REAL,
            event_time TEXT NOT NULL,
            event_date TEXT NOT NULL,
            event_day_of_week TEXT NOT NULL,
            event_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            details TEXT
        )
    `).run();

    console.log('[SQLite] Database initialized successfully.');
}

// Helper to derive date, time, and day of week
function getDateTimeDetails(dateObj = new Date()) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
        time: dateObj.toTimeString().split(' ')[0], // HH:MM:SS
        date: dateObj.toISOString().split('T')[0],   // YYYY-MM-DD
        dayOfWeek: days[dateObj.getDay()]
    };
}

// -------------------------------------------------------------------
// QUERY OPERATIONS
// -------------------------------------------------------------------

/**
 * Log Initial Order Submission
 */
function recordInitialOrder({ primaryOrderId, stopOrderId, tpOrderId, payload, response }) {
    const now = new Date();
    const { time, date, dayOfWeek } = getDateTimeDetails(now);

    const stmt = db.prepare(`
        INSERT OR IGNORE INTO orders (
            primary_order_id, stop_order_id, tp_order_id, symbol,
            trade_action, quantity, entry_price, stop_loss,
            take_profit, order_type, created_time, created_date,
            created_day_of_week, raw_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const isStopOrder = payload.OrderType === 'StopMarket';
    const entryPrice = parseFloat(isStopOrder ? payload.StopPrice : payload.LimitPrice);
    const stopLoss = parseFloat(payload.OSOs?.[0]?.Orders?.find(o => o.OrderType === 'StopMarket')?.StopPrice || 0);
    const profitTarget = parseFloat(payload.OSOs?.[0]?.Orders?.find(o => o.OrderType === 'Limit')?.LimitPrice || 0);

    return stmt.run(
        primaryOrderId,
        stopOrderId || null,
        tpOrderId || null,
        payload.Symbol,
        payload.TradeAction,
        parseInt(payload.Quantity, 10),
        entryPrice,
        stopLoss,
        profitTarget,
        payload.OrderType,
        time,
        date,
        dayOfWeek,
        JSON.stringify({ payload, response })
    );
}

/**
 * Log Order Modifications (Entry, Stop Loss, or Take Profit updates)
 */
function recordModification({ orderId, legType, oldPrice, newPrice, rawResponse }) {
    const { time, date, dayOfWeek } = getDateTimeDetails();

    const stmt = db.prepare(`
        INSERT INTO order_modifications (
            order_id, leg_type, old_price, new_price,
            modified_time, modified_date, modified_day_of_week, raw_response
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(orderId, legType, oldPrice || null, newPrice, time, date, dayOfWeek, JSON.stringify(rawResponse));

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
 */
function recordEvent({ orderId, eventType, fillPrice, details }) {
    const { time, date, dayOfWeek } = getDateTimeDetails();

    const stmt = db.prepare(`
        INSERT INTO order_events (
            order_id, event_type, fill_price,
            event_time, event_date, event_day_of_week, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(orderId, eventType, fillPrice || null, time, date, dayOfWeek, details || '');

    // Update terminal state on primary orders table
    if (eventType === 'ENTRY_FILLED') {
        db.prepare(`UPDATE orders SET status = 'FILLED', entry_fill_price = ? WHERE primary_order_id = ?`).run(fillPrice, orderId);
    } else if (eventType === 'EXIT_FILLED') {
        db.prepare(`UPDATE orders SET status = 'CLOSED', exit_fill_price = ?, closed_timestamp = CURRENT_TIMESTAMP WHERE primary_order_id = ? OR stop_order_id = ? OR tp_order_id = ?`).run(fillPrice, orderId, orderId, orderId);
    } else if (eventType === 'CANCELLED') {
        db.prepare(`UPDATE orders SET status = 'CANCELLED', closed_timestamp = CURRENT_TIMESTAMP WHERE primary_order_id = ? OR stop_order_id = ? OR tp_order_id = ?`).run(orderId, orderId, orderId);
    }
}

// Auto-run schema init on import
initDatabase();

module.exports = {
    recordInitialOrder,
    recordModification,
    recordEvent
};
