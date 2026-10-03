#!/usr/bin/env node
/**
 * chart-history.js
 *
 * Pull the last N trading days of orders from TradeStation, reconstruct
 * completed trades (entry + exit legs), and generate a trade chart PNG
 * for each trade that hasn't been charted yet.
 *
 * Usage:
 *   node chart-history.js [--days 5] [--out ./order-responses]
 *
 * Defaults:
 *   --days  5   (look back 5 calendar days)
 *   --out   ./order-responses
 *
 * Requires a valid .token file (same one used by server.js) and ALPACA_*
 * env vars (via .env or environment).
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { generateTradeChart } = require('./trade-chart');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name, fallback) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const DAYS    = parseInt(getArg('--days', '5'), 10);
const OUT_DIR = path.resolve(getArg('--out', path.join(__dirname, 'order-responses')));

// ---------------------------------------------------------------------------
// Token helpers  (mirrors syncTradStationHisotryToDb.js)
// ---------------------------------------------------------------------------
const TOKEN_FILE = path.join(__dirname, '.token');

function readToken() {
    if (!fs.existsSync(TOKEN_FILE)) throw new Error('No .token file found — run the server first to authenticate.');
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

async function getAccessToken() {
    const t = readToken();
    if (!t.accessToken) throw new Error("'accessToken' missing from .token");

    if (t.expiresAt && Date.now() >= t.expiresAt - 60_000) {
        console.log('⚠️  Token near expiry — refreshing…');
        const res = await fetch('https://signin.tradestation.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type:    'refresh_token',
                client_id:     process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                refresh_token: t.refreshToken
            })
        });
        if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
        const d = await res.json();
        t.accessToken  = d.access_token;
        if (d.refresh_token) t.refreshToken = d.refresh_token;
        t.expiresAt = Date.now() + d.expires_in * 1000;
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
        console.log('✅ Token refreshed.');
    }
    return t.accessToken;
}

// ---------------------------------------------------------------------------
// TradeStation fetch helpers
// ---------------------------------------------------------------------------
async function tsGet(url, token) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`TS API ${res.status}: ${await res.text()}`);
    return res.json();
}

async function getAccountId(token) {
    const data = await tsGet('https://api.tradestation.com/v3/brokerage/accounts', token);
    const accounts = data.Accounts || data;
    if (!accounts?.length) throw new Error('No accounts found');
    return accounts[0].AccountID;
}

async function fetchHistoricalOrders(accountId, token, days) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const url   = `https://api.tradestation.com/v3/brokerage/accounts/${accountId}/historicalorders?since=${encodeURIComponent(since)}`;
    const data  = await tsGet(url, token);
    return data.Orders || (Array.isArray(data) ? data : []);
}

// ---------------------------------------------------------------------------
// Trade reconstruction
//
// TradeStation OSO bracket:  one primary leg + two child legs (TP + stop).
// The API links them via order.OSOs[].Orders[].OrderID on the entry leg,
// and via order.Legs[].RelatedOrderID / order.GroupName on the exit legs.
//
// Strategy — group by GroupName first; fall back to price-matching.
// ---------------------------------------------------------------------------

/**
 * Parse a TradeStation datetime string into a unix ms timestamp.
 * Handles both ISO strings and the TS "MM/DD/YYYY HH:MM:SS AM" format.
 */
function parseTS(str) {
    if (!str) return null;
    // ISO format
    if (str.includes('T') || str.includes('-')) return new Date(str).getTime();
    // "10/02/2024 09:31:00 AM" style
    return new Date(str).getTime();
}

/**
 * Given a flat array of TradeStation order objects, reconstruct trades:
 * Each trade = { symbol, side, entryOrder, exitOrder, exitReason }
 *
 * Only returns trades where BOTH the entry is Filled AND at least one exit leg is Filled.
 */
function reconstructTrades(orders) {
    // Index all orders by ID
    const byId = {};
    for (const o of orders) byId[String(o.OrderID)] = o;

    const trades  = [];
    const usedIds = new Set();

    // Sort oldest-first so we match entry before exits
    const sorted = [...orders].sort((a, b) => {
        return (parseTS(a.OpenedDateTime) || 0) - (parseTS(b.OpenedDateTime) || 0);
    });

    for (const order of sorted) {
        const id     = String(order.OrderID);
        const status = order.StatusDescription || order.Status || '';
        const action = (order.Legs?.[0]?.BuySell || order.TradeAction || '').toUpperCase();
        const isFilled = ['Filled', 'Fills', 'PartiallyFilled'].includes(status);

        // Skip non-entry legs (SELL/SELLSHORT without being marked as entry action)
        // An entry is a BUY or SELLSHORT that is Filled and not yet used.
        const isEntry = (action === 'BUY' || action === 'SELLSHORT') && isFilled;
        if (!isEntry || usedIds.has(id)) continue;

        const symbol    = order.Legs?.[0]?.Symbol || order.Symbol || 'UNKNOWN';
        const side      = action === 'BUY' ? 'BUY' : 'SELL';
        const entryFill = parseFloat(order.FilledPrice || order.AverageFillPrice || order.LimitPrice || order.StopPrice || 0);
        const entryTime = parseTS(order.FilledDateTime || order.OpenedDateTime);
        const qty       = parseInt(order.Quantity || order.FilledQuantity || 0, 10);

        // Collect linked exit IDs from the OSO structure on the entry order
        const linkedIds = new Set();
        for (const oso of order.OSOs || []) {
            for (const leg of oso.Orders || []) {
                if (leg.OrderID) linkedIds.add(String(leg.OrderID));
            }
        }
        // Also scan all orders for matching GroupName
        const group = order.GroupName || order.ConditionalOrderId || null;
        if (group) {
            for (const o of orders) {
                if (String(o.OrderID) !== id && (o.GroupName === group || o.ConditionalOrderId === group)) {
                    linkedIds.add(String(o.OrderID));
                }
            }
        }

        // Find the filled exit leg among linked IDs
        let exitOrder  = null;
        let exitReason = 'terminated';

        for (const eid of linkedIds) {
            const leg = byId[eid];
            if (!leg) continue;
            const ls = leg.StatusDescription || leg.Status || '';
            if (!['Filled', 'Fills'].includes(ls)) continue;

            const legAction = (leg.Legs?.[0]?.BuySell || leg.TradeAction || '').toUpperCase();
            // Exit must be opposite direction
            const isExit = side === 'BUY'
                ? legAction === 'SELL' || legAction === 'BUYTOCOVER'
                : legAction === 'BUYTOCOVER' || legAction === 'BUY';

            if (!isExit) continue;

            // Prefer the leg that actually filled (take-profit or stop)
            if (!exitOrder) {
                exitOrder = leg;
            } else {
                // If two exits are filled, take the one with the later fill time
                const prev = parseTS(exitOrder.FilledDateTime || exitOrder.ClosedDateTime);
                const curr = parseTS(leg.FilledDateTime     || leg.ClosedDateTime);
                if ((curr || 0) > (prev || 0)) exitOrder = leg;
            }
        }

        // If no linked exit found, do a lookahead price-match on same symbol
        if (!exitOrder) {
            const entryPrice = parseFloat(order.LimitPrice || order.StopPrice || 0);
            const stopPrice  = entryPrice; // will match via proximity below
            for (const o of sorted) {
                if (usedIds.has(String(o.OrderID))) continue;
                if ((o.Legs?.[0]?.Symbol || o.Symbol) !== symbol) continue;
                const oStatus = o.StatusDescription || o.Status || '';
                if (!['Filled', 'Fills'].includes(oStatus)) continue;
                const oAction = (o.Legs?.[0]?.BuySell || o.TradeAction || '').toUpperCase();
                const oTime   = parseTS(o.FilledDateTime || o.OpenedDateTime) || 0;
                if (oTime <= (entryTime || 0)) continue; // must be after entry
                const isExitAction = side === 'BUY'
                    ? oAction === 'SELL'
                    : oAction === 'BUYTOCOVER' || oAction === 'BUY';
                if (isExitAction && !exitOrder) exitOrder = o;
            }
        }

        if (!exitOrder) continue; // no completed exit — skip

        // Determine exit reason from exit order type
        const exitOrderType = (exitOrder.OrderType || '').toLowerCase();
        if (exitOrderType.includes('stop'))  exitReason = 'stop';
        else if (exitOrderType.includes('limit')) exitReason = 'target';

        const exitFill = parseFloat(exitOrder.FilledPrice || exitOrder.AverageFillPrice || 0);
        const exitTime = parseTS(exitOrder.FilledDateTime || exitOrder.ClosedDateTime);

        usedIds.add(id);
        usedIds.add(String(exitOrder.OrderID));

        trades.push({
            symbol,
            side,
            shares:       qty,
            entryPrice:   entryFill,
            fillPrice:    entryFill,
            stopLoss:     parseFloat(order.StopPrice || 0),
            profitTarget: parseFloat(order.LimitPrice || 0),
            exitPrice:    exitFill,
            exitReason,
            entryTime,
            exitTime
        });
    }

    return trades;
}

// ---------------------------------------------------------------------------
// Already-charted check — look for an existing PNG matching symbol+date+time
// ---------------------------------------------------------------------------
function chartFilename(symbol, entryTimeMs) {
    const d   = new Date(entryTimeMs);
    const mm  = String(d.getMonth() + 1).padStart(2, '0');
    const dd  = String(d.getDate()).padStart(2, '0');
    const yy  = String(d.getFullYear()).slice(2);
    const hh  = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `trade-chart_${symbol}_${mm}-${dd}-${yy}_${hh}-${min}.png`;
}

function alreadyCharted(outDir, symbol, entryTimeMs) {
    const name = chartFilename(symbol, entryTimeMs);
    return fs.existsSync(path.join(outDir, name));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const alpacaKey    = process.env.ALPACA_API_KEY    || '';
    const alpacaSecret = process.env.ALPACA_API_SECRET || '';

    if (!alpacaKey || !alpacaSecret) {
        console.warn('⚠️  ALPACA_API_KEY / ALPACA_API_SECRET not set — bar data will be empty, charts will show "No bar data available".');
    }

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log(`\n📈 chart-history.js`);
    console.log(`   Lookback : ${DAYS} days`);
    console.log(`   Output   : ${OUT_DIR}\n`);

    const token     = await getAccessToken();
    const accountId = await getAccountId(token);
    console.log(`   Account  : ${accountId}`);

    const orders = await fetchHistoricalOrders(accountId, token, DAYS);
    console.log(`   Orders   : ${orders.length} fetched from TradeStation\n`);

    const trades = reconstructTrades(orders);
    console.log(`   Trades   : ${trades.length} completed trades found`);

    if (trades.length === 0) {
        console.log('   Nothing to chart.');
        return;
    }

    let charted = 0, skipped = 0;

    for (const trade of trades) {
        if (!trade.entryTime) { skipped++; continue; }

        if (alreadyCharted(OUT_DIR, trade.symbol, trade.entryTime)) {
            console.log(`   ⏭  ${chartFilename(trade.symbol, trade.entryTime)} — already exists, skipping`);
            skipped++;
            continue;
        }

        try {
            const file = await generateTradeChart({
                ...trade,
                alpacaKey,
                alpacaSecret,
                outputDir: OUT_DIR
            });
            console.log(`   ✅ ${path.basename(file)}`);
            charted++;
        } catch (err) {
            console.error(`   ❌ Failed for ${trade.symbol} @ ${new Date(trade.entryTime).toLocaleString()}: ${err.message}`);
            skipped++;
        }
    }

    console.log(`\n=========================================`);
    console.log(`  Charts generated : ${charted}`);
    console.log(`  Skipped          : ${skipped}`);
    console.log(`=========================================\n`);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
