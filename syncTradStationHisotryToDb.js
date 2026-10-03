const fs = require('fs');
const path = require('path');
const db = require('./db.js');

const TOKEN_FILE_PATH = path.join(__dirname, '.token');

/**
 * 1. Read and parse `.token` file
 */
function readTokenFile() {
    if (!fs.existsSync(TOKEN_FILE_PATH)) {
        console.error(`❌ Token file not found at: ${TOKEN_FILE_PATH}`);
        process.exit(1);
    }

    try {
        const rawContent = fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim();
        return JSON.parse(rawContent);
    } catch (err) {
        console.error(`❌ Failed to parse .token file:`, err.message);
        process.exit(1);
    }
}

/**
 * 2. Get valid access token (refreshes if expired)
 */
async function getValidAccessToken() {
    const tokenData = readTokenFile();
    const now = Date.now();

    // Check if token is present
    if (!tokenData.accessToken) {
        console.error("❌ 'accessToken' key missing from .token JSON.");
        process.exit(1);
    }

    // Check if token is expired (or expires within 60 seconds)
    if (tokenData.expiresAt && now >= (tokenData.expiresAt - 60000)) {
        console.log("⚠️ Access token is expired or about to expire. Attempting refresh...");
        
        if (!tokenData.refreshToken) {
            console.error("❌ Refresh token missing from .token file. Re-authentication required.");
            process.exit(1);
        }

        return await refreshAccessToken(tokenData);
    }

    return tokenData.accessToken;
}

/**
 * Helper to refresh expired token and save updated keys back to `.token`
 */
async function refreshAccessToken(tokenData) {
    try {
        const res = await fetch('https://signin.tradestation.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: '7RH1luCKlCSBekUx1WTyUoYH0n5ofVA5', // Parsed from your JWT azp claim
                refresh_token: tokenData.refreshToken
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`OAuth Refresh Error [${res.status}]: ${errText}`);
        }

        const data = await res.json();
        
        // Update object properties
        tokenData.accessToken = data.access_token;
        if (data.refresh_token) tokenData.refreshToken = data.refresh_token;
        tokenData.expiresAt = Date.now() + (data.expires_in * 1000);

        // Write back to .token file
        fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokenData, null, 2), 'utf8');
        console.log("✅ Token refreshed successfully and written to .token!");

        return tokenData.accessToken;

    } catch (err) {
        console.error("❌ Token refresh failed:", err.message);
        process.exit(1);
    }
}

/**
 * 3. Fetch Order History from TradeStation API
 */


/**
 * Fetch Order History from TradeStation API (Including Closed/Filled/Canceled)
 */
async function fetchOrderHistory(accessToken) {
    console.log("🔄 Fetching account details from TradeStation API...");

    try {
        const accountsRes = await fetch('https://api.tradestation.com/v3/brokerage/accounts', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!accountsRes.ok) {
            const errText = await accountsRes.text();
            throw new Error(`Accounts API Error [${accountsRes.status}]: ${errText}`);
        }

        const accountsData = await accountsRes.json();
        const accounts = accountsData.Accounts || accountsData;
        
        if (!accounts || accounts.length === 0) {
            throw new Error("No accounts found for the authenticated user.");
        }

        const accountId = accounts[0].AccountID;
        console.log(`👤 Syncing orders for Account ID: ${accountId}`);

        // Historical lookback period. Override with LOOKBACK_DAYS=90 for a
        // one-off wider backfill without touching this default (e.g. for a
        // cron job that should normally only pull the last few days):
        //   LOOKBACK_DAYS=90 node syncTradStationHisotryToDb.js
        const lookbackDays = parseInt(process.env.LOOKBACK_DAYS || '3', 10);
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - lookbackDays);
        const untilDate = new Date(); // "now" — was previously computed wrong
        // (used sinceDate's day-of-month against untilDate's month, which
        // landed a month in the future whenever the lookback crossed a
        // month boundary, e.g. 3 days back from Oct 2 -> "Oct 29" instead
        // of "Oct 2". TradeStation appears to just cap an in-the-future
        // `until` at "now" server-side, so this was silently harmless for
        // short lookbacks, but would be wrong to rely on for a real backfill).
        const sinceStr = sinceDate.toISOString();
        const untilStr = untilDate.toISOString();

        // Append 'since'/'until' query parameters to pull closed/historical orders
        console.log(`📡 Requesting order history since ${sinceStr} until ${untilStr} (lookback: ${lookbackDays}d)...`);
        const ordersUrl = `https://api.tradestation.com/v3/brokerage/accounts/${accountId}/historicalorders?since=${sinceStr}&until=${untilStr}`;

        const ordersRes = await fetch(ordersUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!ordersRes.ok) {
            const errText = await ordersRes.text();
            throw new Error(`Orders API Error [${ordersRes.status}]: ${errText}`);
        }

        const ordersData = await ordersRes.json();
        const orders = ordersData.Orders || (Array.isArray(ordersData) ? ordersData : []);

        console.log(`📦 Retrieved ${orders.length} historical/active orders from TradeStation.`);
        return { accountId, orders };

    } catch (err) {
        console.error("❌ Failed to fetch order history:", err.message);
        process.exit(1);
    }
}


async function fetchOrderHistoryOlde(accessToken) {
    console.log("🔄 Fetching account details from TradeStation API...");

    try {
        const accountsRes = await fetch('https://api.tradestation.com/v3/brokerage/accounts', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!accountsRes.ok) {
            const errText = await accountsRes.text();
            throw new Error(`Accounts API Error [${accountsRes.status}]: ${errText}`);
        }

        const accountsData = await accountsRes.json();
        const accounts = accountsData.Accounts || accountsData;
        
        if (!accounts || accounts.length === 0) {
            throw new Error("No accounts found for the authenticated user.");
        }

        const accountId = accounts[0].AccountID;
        console.log(`👤 Syncing orders for Account ID: ${accountId}`);

        const ordersUrl = `https://api.tradestation.com/v3/brokerage/accounts/${accountId}/orders`;
        const ordersRes = await fetch(ordersUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!ordersRes.ok) {
            const errText = await ordersRes.text();
            throw new Error(`Orders API Error [${ordersRes.status}]: ${errText}`);
        }

        const ordersData = await ordersRes.json();
        const orders = ordersData.Orders || (Array.isArray(ordersData) ? ordersData : []);

        console.log(`📦 Retrieved ${orders.length} orders from TradeStation.`);
        return { accountId, orders };

    } catch (err) {
        console.error("❌ Failed to fetch order history:", err.message);
        process.exit(1);
    }
}

/**
 * 4. Sync Orders to SQLite DB
 */
const FILLED_STATUSES    = ['Filled', 'Fills'];
// TradeStation's real StatusDescription is the American spelling 'Canceled'
// (one L) — the original code checked for 'Cancelled' (two L) and so never
// matched. Expired/Rejected/UROut (an OCO sibling being cancelled when the
// other leg fills) are all "didn't execute" terminal states too.
const NON_FILL_TERMINAL_STATUSES = ['Canceled', 'Cancelled', 'Expired', 'Rejected', 'UROut'];

/**
 * Classify an order as the ENTRY of a trade, or a STOP_LOSS/TAKE_PROFIT exit
 * leg of one — using TradeStation's own ConditionalOrders linkage. There are
 * two distinct patterns in real TradeStation data, confirmed against actual
 * account history:
 *
 *   1. A full 3-leg OSO (entry + stop + target submitted together): the
 *      entry carries 'OSO' links to its two children, and each child carries
 *      an 'OSP' link straight back to the entry's OrderID. We know the exact
 *      parent here.
 *
 *   2. A stop+limit OCO pair placed SEPARATELY to close an already-open
 *      position (common when a position wasn't opened via this app's
 *      bracket flow in the first place): both legs only carry a 'BRK' link
 *      to each other — there is no 'OSP' back-reference and no entry order
 *      in the ConditionalOrders graph at all. TradeStation simply doesn't
 *      tell us which prior order opened the position being closed.
 *
 * Both patterns are real exit legs and should NOT be counted as new
 * entries. For pattern 2, parentOrderId comes back null — that's an honest
 * reflection of what the data actually tells us, not a bug: there is no
 * entry OrderID anywhere in this order's conditional links.
 *
 * A plain order with no ConditionalOrders at all is a genuine standalone
 * entry (no bracket, no attached exit).
 */
function classifyOrder(order) {
    const cond = order.ConditionalOrders || [];
    const ospLink = cond.find(c => c.Relationship === 'OSP');
    const osoLinks = cond.filter(c => c.Relationship === 'OSO');
    const isBrkOnlyPair = cond.length > 0 && cond.every(c => c.Relationship === 'BRK');

    if (ospLink || isBrkOnlyPair) {
        return {
            role: order.OrderType === 'StopMarket' ? 'STOP_LOSS' : 'TAKE_PROFIT',
            parentOrderId: ospLink ? String(ospLink.OrderID) : null,
            childOrderIds: [],
        };
    }
    return {
        role: 'ENTRY',
        parentOrderId: null,
        childOrderIds: osoLinks.map(c => String(c.OrderID)),
    };
}

/**
 * TradeStation's historical order data only gives us BuyOrSell ('Buy'/'Sell')
 * + OpenOrClose ('Open'/'Close') on each leg — not the 4-way BUY/SELL/
 * SELLSHORT/BUYTOCOVER convention the live-trading flow uses when PLACING
 * orders (see trading.js's executeOrder). Derive the matching value so
 * trade_action means the same thing regardless of whether a row came from
 * a live trade or a historical sync:
 *   Buy  + Open  -> BUY         (opening a long)
 *   Sell + Close -> SELL        (closing a long)
 *   Sell + Open  -> SELLSHORT   (opening a short)
 *   Buy  + Close -> BUYTOCOVER  (closing a short)
 * If OpenOrClose is missing (happens occasionally in this data), falls back
 * to the plain BUY/SELL reading rather than guessing open-vs-close.
 */
function resolveTradeAction(leg) {
    const buyOrSell   = (leg?.BuyOrSell   || '').toLowerCase();
    const openOrClose = (leg?.OpenOrClose || '').toLowerCase();

    if (buyOrSell === 'buy'  && openOrClose === 'close') return 'BUYTOCOVER';
    if (buyOrSell === 'sell' && openOrClose === 'open')  return 'SELLSHORT';
    if (buyOrSell === 'sell') return 'SELL';
    if (buyOrSell === 'buy')  return 'BUY';
    return 'BUY'; // BuyOrSell itself missing — last-resort fallback
}

function toOrderPayload(order, quantity) {
    const isStopOrder = order.OrderType === 'StopMarket';
    const entryPrice = parseFloat(order.LimitPrice || order.StopPrice || order.FilledPrice || 0);
    return {
        Symbol: order.Legs?.[0]?.Symbol || 'UNKNOWN',
        TradeAction: resolveTradeAction(order.Legs?.[0]),
        Quantity: quantity,
        OrderType: order.OrderType || 'Limit',
        [isStopOrder ? 'StopPrice' : 'LimitPrice']: entryPrice,
        OSOs: []
    };
}

async function syncOrdersToDatabase() {
    const accessToken = await getValidAccessToken();
    const { orders } = await fetchOrderHistory(accessToken);

    if (orders.length === 0) {
        console.log("No orders found to sync.");
        return;
    }

    const byId = new Map(orders.map(o => [String(o.OrderID), o]));

    let insertedCount = 0;
    let updatedCount = 0;
    let entryFilledEvents = 0;
    let exitFilledEvents = 0;
    let cancelledEvents = 0;

    // --- PASS 1: insert a row for every order (entry AND exit legs alike),
    // with the parent/role/bracket linkage and, for entries, the real
    // stop-loss/take-profit prices read off their linked children. ---
    orders.forEach(order => {
        const orderId = String(order.OrderID);
        // Real field is Legs[0].QuantityOrdered (ExecQuantity once filled) —
        // order.Quantity never actually exists on a TradeStation order.
        // Note: ExecQuantity is a STRING, so '0' is truthy — `||` alone
        // wouldn't fall through to QuantityOrdered for unfilled orders.
        const leg = order.Legs?.[0] || {};
        const execQty = parseInt(leg.ExecQuantity || 0, 10);
        const quantity = execQty > 0 ? execQty : parseInt(leg.QuantityOrdered || 0, 10);
        const { role, parentOrderId, childOrderIds } = classifyOrder(order);
        const openedAt = order.OpenedDateTime ? new Date(order.OpenedDateTime) : new Date();

        const alreadyExisted = db.orderExists(orderId);

        let stopLoss, takeProfit, stopOrderId = null, tpOrderId = null;
        if (role === 'ENTRY' && childOrderIds.length > 0) {
            childOrderIds.forEach(cid => {
                const child = byId.get(cid);
                if (!child) return; // child wasn't in this batch — picked up on a later sync
                if (child.OrderType === 'StopMarket') {
                    stopOrderId = cid;
                    stopLoss = parseFloat(child.StopPrice || 0);
                } else {
                    tpOrderId = cid;
                    takeProfit = parseFloat(child.LimitPrice || 0);
                }
            });
        }

        db.recordInitialOrder({
            primaryOrderId: orderId,
            stopOrderId,
            tpOrderId,
            parentOrderId,
            legRole: role,
            payload: toOrderPayload(order, quantity),
            response: order,
            stopLoss,
            takeProfit,
            timestamp: openedAt
        });

        if (alreadyExisted) updatedCount++; else insertedCount++;
    });

    // --- PASS 2: fire fill/cancel events now that every row (including
    // parents) is guaranteed to exist, so EXIT_FILLED can find its entry. ---
    orders.forEach(order => {
        const orderId = String(order.OrderID);
        const { role, parentOrderId } = classifyOrder(order);
        const status = order.StatusDescription || order.Status || 'UNKNOWN';
        const fillPrice = parseFloat(order.FilledPrice || order.AverageFillPrice || 0);
        const closedAt = order.ClosedDateTime ? new Date(order.ClosedDateTime) : new Date();

        if (FILLED_STATUSES.includes(status)) {
            // Record the fill on this row's own history...
            if (!db.eventExists(orderId, 'ENTRY_FILLED')) {
                db.recordEvent({
                    orderId,
                    eventType: 'ENTRY_FILLED',
                    fillPrice,
                    details: `${status} — synced from TS history`,
                    timestamp: closedAt
                });
                entryFilledEvents++;
            }
            // ...and if this was actually an exit leg, ALSO close out the
            // parent trade (exit_fill_price, exit_date/time, status=CLOSED).
            if ((role === 'STOP_LOSS' || role === 'TAKE_PROFIT') && parentOrderId) {
                if (!db.eventExists(parentOrderId, 'EXIT_FILLED')) {
                    db.recordEvent({
                        orderId: parentOrderId,
                        eventType: 'EXIT_FILLED',
                        fillPrice,
                        details: `${role} leg ${orderId} filled — synced from TS history`,
                        timestamp: closedAt
                    });
                    exitFilledEvents++;
                }
            }
        } else if (NON_FILL_TERMINAL_STATUSES.includes(status)) {
            if (!db.eventExists(orderId, 'CANCELLED')) {
                db.recordEvent({
                    orderId,
                    eventType: 'CANCELLED',
                    details: `${status} — synced from TS history`,
                    timestamp: closedAt
                });
                cancelledEvents++;
            }
        }
    });

    console.log(`\n=========================================`);
    console.log(`✅ SYNC COMPLETE`);
    console.log(`=========================================`);
    console.log(`New Order Rows Inserted:   ${insertedCount}`);
    console.log(`Existing Order Rows Seen:  ${updatedCount}`);
    console.log(`ENTRY_FILLED events fired: ${entryFilledEvents}`);
    console.log(`EXIT_FILLED events fired:  ${exitFilledEvents}`);
    console.log(`CANCELLED events fired:    ${cancelledEvents}`);
    console.log(`=========================================\n`);
}

syncOrdersToDatabase();
