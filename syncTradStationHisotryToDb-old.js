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
        console.log(`👤 Syncing orders for Account ID: `);

        // Define historical lookback period (defaulting to last 30 days)
        const lookbackDays = 3;
        const lookfwdDays = 0;
        const sinceDate = new Date();
        const untilDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - lookbackDays);
        untilDate.setDate(sinceDate.getDate() - lookfwdDays);
        const sinceStr = sinceDate.toISOString() //.split('T')[0]; // YYYY-MM-DD format
        const untilStr = untilDate.toISOString()// .split('T')[0]; // YYYY-MM-DD format

        // Append 'since' query parameter to pull closed/historical orders
        console.log(`📡 Requesting order history since ${sinceStr}...`);
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
        console.log(`👤 Syncing orders for Account `);

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
async function syncOrdersToDatabase() {
    const accessToken = await getValidAccessToken();
    const { orders } = await fetchOrderHistory(accessToken);

    if (orders.length === 0) {
        console.log("No orders found to sync.");
        return;
    }

    let insertedCount = 0;
    let updatedCount = 0;

    orders.forEach(order => {
        const orderId = String(order.OrderID);
        console.log(order);
        const symbol = order.Legs[0].Symbol || 'UNKNOWN';
        const tradeAction = order.Legs?.[0]?.BuySell || order.TradeAction || 'BUY';
        const quantity = parseInt(order.Quantity || order.Legs?.[0]?.Quantity || 0, 10);
        
        const isStopOrder = order.OrderType === 'StopMarket';
        const entryPrice = parseFloat(order.LimitPrice || order.StopPrice || order.FilledPrice || 0);
        
        const status = order.StatusDescription || order.Status || 'UNKNOWN';
        const fillPrice = parseFloat(order.FilledPrice || order.AverageFillPrice || 0);

        // Derive Date, Time, and Day of Week
        const orderDate = order.OpenedDateTime ? new Date(order.OpenedDateTime) : new Date();
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const timeStr = orderDate.toTimeString().split(' ')[0];
        const dateStr = orderDate.toISOString().split('T')[0];
        const dayOfWeekStr = days[orderDate.getDay()];

        // Check existing record
        const existing = db.prepare ? 
            db.prepare(`SELECT primary_order_id FROM orders WHERE primary_order_id = ?`).get(orderId) : null;

        if (!existing) {
            // Record initial submission
            db.recordInitialOrder({
                primaryOrderId: orderId,
                stopOrderId: null,
                tpOrderId: null,
                payload: {
                    Symbol: symbol,
                    TradeAction: tradeAction,
                    Quantity: quantity,
                    OrderType: order.OrderType || 'Limit',
                    [isStopOrder ? 'StopPrice' : 'LimitPrice']: entryPrice,
                    OSOs: []
                },
                response: order
            });

            // Log event status
            if (['Filled', 'Fills'].includes(status)) {
                db.recordEvent({
                    orderId: orderId,
                    eventType: 'ENTRY_FILLED',
                    fillPrice: fillPrice,
                    details: order.StatusDescription || 'Synced from TS history'
                });
            } else if (status === 'Cancelled') {
                db.recordEvent({
                    orderId: orderId,
                    eventType: 'CANCELLED',
                    details: 'Synced from TS history'
                });
            }

            insertedCount++;
        } else {
            // Update existing status/fill
            if (['Filled', 'Fills'].includes(status)) {
                db.recordEvent({
                    orderId: orderId,
                    eventType: 'ENTRY_FILLED',
                    fillPrice: fillPrice,
                    details: 'Updated from TS history sync'
                });
            } else if (status === 'Cancelled') {
                db.recordEvent({
                    orderId: orderId,
                    eventType: 'CANCELLED',
                    details: 'Updated from TS history sync'
                });
            }
            updatedCount++;
        }
    });

    console.log(`\n=========================================`);
    console.log(`✅ SYNC COMPLETE`);
    console.log(`=========================================`);
    console.log(`New Orders Inserted:  ${insertedCount}`);
    console.log(`Existing Orders Sync: ${updatedCount}`);
    console.log(`=========================================\n`);
}

syncOrdersToDatabase();
