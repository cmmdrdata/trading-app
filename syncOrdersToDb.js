const fs = require('fs');
const path = require('path');
const db = require('./db.js');

// 1. Read access token from local `.token` file
const tokenFilePath = path.join(__dirname, '.token');

if (!fs.existsSync(tokenFilePath)) {
    console.error(`❌ Token file not found at: ${tokenFilePath}`);
    process.exit(1);
}

let accessToken = fs.readFileSync(tokenFilePath, 'utf8').trim();

// Support JSON format inside .token (e.g., {"access_token": "..."}) or plain text string
if (accessToken.startsWith('{')) {
    try {
        const parsed = JSON.parse(accessToken);
        accessToken = parsed.access_token || parsed.token || accessToken;
    } catch (e) {
        // Fall back to raw content if JSON parsing fails
    }
}

// 2. Fetch order history from TradeStation Brokerage API
async function fetchOrderHistory() {
    console.log("🔄 Fetching order history from TradeStation API...");

    try {
        // Retrieve account list first to get the main AccountID
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

        // Fetch historical orders for the account (default last 14 days)
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

// 3. Process and insert orders into `trading_orders.db`
async function syncOrdersToDatabase() {
    const { orders } = await fetchOrderHistory();

    if (orders.length === 0) {
        console.log("No orders found to sync.");
        return;
    }

    let insertedCount = 0;
    let updatedCount = 0;

    orders.forEach(order => {
        const orderId = String(order.OrderID);
        const symbol = order.Symbol || 'UNKNOWN';
        const tradeAction = order.Legs?.[0]?.BuySell || order.TradeAction || 'BUY';
        const quantity = parseInt(order.Quantity || order.Legs?.[0]?.Quantity || 0, 10);
        
        const isStopOrder = order.OrderType === 'StopMarket';
        const entryPrice = parseFloat(order.LimitPrice || order.StopPrice || order.FilledPrice || 0);
        
        const status = order.StatusDescription || order.Status || 'UNKNOWN';
        const fillPrice = parseFloat(order.FilledPrice || order.AverageFillPrice || 0);

        // Derive date/time components
        const orderDate = order.OpenedDateTime ? new Date(order.OpenedDateTime) : new Date();
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const timeStr = orderDate.toTimeString().split(' ')[0];
        const dateStr = orderDate.toISOString().split('T')[0];
        const dayOfWeekStr = days[orderDate.getDay()];

        // Check if order already exists in SQLite DB
        const existing = db.prepare ? 
            db.prepare(`SELECT primary_order_id FROM orders WHERE primary_order_id = ?`).get(orderId) : null;

        if (!existing) {
            // Record new order submission into DB
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

            // Log event status if already Filled or Cancelled
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
            // Update status & fill price if order was already present
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
