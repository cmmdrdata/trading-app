/**
 * Submits an OSO (Order-Sends-Order) with a child Bracket (Take Profit + Stop Loss)
 * directly to TradeStation and launches the Live Order Management Modal upon success.
 */
async function executeOrder() {
    const submitBtn = document.getElementById('btnPlaceTrade');
    
    // 1. Guard check: Valid access token
    if (!tradeStationToken) {
        alert("Not connected to TradeStation. Please wait for authentication.");
        return;
    }

    // 2. Gather inputs from UI
    const symbolInput = document.getElementById('tickerInput');
    const symbol = symbolInput ? symbolInput.value.trim().toUpperCase() : '';
    const shares = parseInt(document.getElementById('shareInput').value) || 0;
    const entryPrice = parseFloat(document.getElementById('entryPrice').value) || 0;
    const stopLoss = parseFloat(document.getElementById('stopLoss').value) || 0;
    const profitTarget = parseFloat(document.getElementById('takeProfit').value) || 0;

    // Validation
    if (!symbol || shares <= 0 || entryPrice <= 0 || stopLoss <= 0 || profitTarget <= 0) {
        alert("Please ensure Ticker, Shares, Entry, Stop Loss, and Take Profit are all valid positive values.");
        return;
    }

    // 3. Determine Entry Order Type & Price Key based on orderType toggle
    const isStopOrder = (orderType === 'STOP');
    const entryType = isStopOrder ? "StopMarket" : "Limit";
    const priceKey = isStopOrder ? "StopPrice" : "LimitPrice";

    // 4. Handle Direction (BUY vs SELL / SELLSHORT vs BUY TO COVER)
    const primaryAction = (currentSide === 'BUY') ? "BUY" : "SELLSHORT";
    const exitAction = (currentSide === 'BUY') ? "SELL" : "BUYTOCOVER";

    // 5. Construct Payload
    const payload = {
        Type: "OSO",
        AccountID: CONFIG.ACCOUNT_ID,
        Symbol: symbol,
        Quantity: shares.toString(),
        OrderType: entryType,
        TradeAction: primaryAction,
        Route: "Intelligent",
        TimeInForce: { Duration: "DAY" },
        OSOs: [
            {
                Type: "BRK",
                Orders: [
                    {
                        AccountID: CONFIG.ACCOUNT_ID,
                        Symbol: symbol,
                        Quantity: shares.toString(),
                        OrderType: "Limit",
                        TradeAction: exitAction,
                        LimitPrice: profitTarget.toFixed(2),
                        Route: "Intelligent",
                        TimeInForce: { Duration: "DAY" }
                    },
                    {
                        AccountID: CONFIG.ACCOUNT_ID,
                        Symbol: symbol,
                        Quantity: shares.toString(),
                        OrderType: "StopMarket",
                        TradeAction: exitAction,
                        StopPrice: stopLoss.toFixed(2),
                        Route: "Intelligent",
                        TimeInForce: { Duration: "DAY" }
                    }
                ]
            }
        ]
    };

    payload[priceKey] = entryPrice.toFixed(2);

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = "Placing Order...";
        }

        const url = "https://api.tradestation.com/v3/orderexecution/orders";
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tradeStationToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        console.log(`[TradeStation Response Code] Status: ${response.status} ${response.statusText}`);
        const data = await response.json();
        const orderList = data.Orders || (Array.isArray(data) ? data : []);

        // Check for error responses
        const failedOrders = orderList.filter(o => o.Error || o.RejectReason || o.Status === "Rejected");

        if (failedOrders.length > 0) {
            const errorMessages = failedOrders.map((o, idx) => {
                const idStr = o.OrderID ? ` (Order ID: ${o.OrderID})` : '';
                const msg = o.Message || o.RejectReason || o.Error || 'Unknown Error';
                return `Leg ${idx + 1}${idStr}: ${msg}`;
            }).join('\n\n');

            alert(`⚠️ TradeStation Order Placement Failed:\n\n${errorMessages}`);

            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = "Place Order";
            }
            return;
        }

        // Proceed if order accepted without errors
        if (response.ok && (orderList.length > 0 || data.OrderID)) {
            let primaryOrderId = data.OrderID || (orderList[0] ? orderList[0].OrderID : null);
            let childOrderIds = orderList.map(o => o.OrderID).filter(Boolean);

            if (!childOrderIds.length && primaryOrderId) {
                childOrderIds = [primaryOrderId];
            }

            if (submitBtn) {
                submitBtn.innerText = "Order Placed! ✓";
                setTimeout(() => {
                    submitBtn.disabled = false;
                    submitBtn.innerText = "Place Order";
                }, 2500);
            }

            // Launch Realtime Order Monitor & Controls Window
            openOrderMonitorModal({
                primaryOrderId,
                allOrderIds: childOrderIds,
                symbol,
                shares,
                entryPrice,
                stopLoss,
                profitTarget,
                side: currentSide
            });

        } else {
            const errorMsg = data.Error || data.message || data.error_description || JSON.stringify(data);
            throw new Error(errorMsg);
        }
    } catch (err) {
        console.error("Order execution failed:", err);
        alert(`Order Execution Error:\n${err.message}`);

        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = "Place Order";
        }
    }
}

// -------------------------------------------------------------------
// 2. REALTIME MONITOR & ORDER MANAGEMENT MODAL
// -------------------------------------------------------------------
let monitorInterval = null;

function openOrderMonitorModal(tradeDetails) {
    // Remove existing modal if any
    const existing = document.getElementById('tsOrderMonitorModal');
    if (existing) existing.remove();

    // Inject Modal HTML Container
    const modalHTML = `
    <div id="tsOrderMonitorModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:99999; font-family:sans-serif;">
        <div style="background:#1a1d24; border:1px solid #363b44; border-radius:10px; width:560px; padding:24px; color:#fff; box-shadow: 0 10px 25px rgba(0,0,0,0.7);">
            
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #2d3139; padding-bottom:12px; margin-bottom:15px;">
                <h3 style="margin:0; font-size:18px; color:#38bdf8;">Live Order Monitor: ${tradeDetails.symbol} (${tradeDetails.side})</h3>
                <span id="tsMarketStatusBadge" style="font-size:11px; padding:3px 8px; border-radius:4px; background:#1e293b; color:#94a3b8;">MONITORING</span>
            </div>

            <!-- P/L Realtime Display Header -->
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; background:#0f1115; padding:12px; border-radius:6px; margin-bottom:15px; text-align:center;">
                <div>
                    <span style="font-size:11px; color:#94a3b8; display:block;">Alpaca Live Price</span>
                    <strong id="tsLiveMarketPrice" style="font-size:16px; color:#fff;">$0.00</strong>
                </div>
                <div>
                    <span style="font-size:11px; color:#94a3b8; display:block;">Unrealized P/L ($)</span>
                    <strong id="tsLiveUnrealizedPL" style="font-size:16px; color:#4ade80;">$0.00</strong>
                </div>
                <div>
                    <span style="font-size:11px; color:#94a3b8; display:block;">Unrealized P/L (%)</span>
                    <strong id="tsLiveUnrealizedPLPct" style="font-size:16px; color:#4ade80;">0.00%</strong>
                </div>
            </div>

            <!-- Order Legs Status Table -->
            <div style="max-height:160px; overflow-y:auto; margin-bottom:15px; border:1px solid #2d3139; border-radius:6px;">
                <table style="width:100%; border-collapse:collapse; font-size:12px; text-align:left;">
                    <thead style="background:#232730; color:#94a3b8;">
                        <tr>
                            <th style="padding:8px;">Order ID</th>
                            <th style="padding:8px;">Type/Side</th>
                            <th style="padding:8px;">Price</th>
                            <th style="padding:8px;">Status</th>
                        </tr>
                    </thead>
                    <tbody id="tsOrderMonitorTableBody">
                        <tr><td colspan="4" style="padding:10px; text-align:center; color:#94a3b8;">Fetching initial order status...</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- Order Modification Inputs -->
            <div style="background:#0f1115; padding:12px; border-radius:6px; margin-bottom:15px; border:1px solid #2d3139;">
                <div style="font-size:12px; font-weight:bold; color:#facc15; margin-bottom:8px;">Modify Active Bracket Legs</div>
                <div style="display:flex; gap:10px; margin-bottom:8px;">
                    <div style="flex:1;">
                        <label style="font-size:11px; color:#94a3b8; display:block;">New Stop Loss ($)</label>
                        <input type="number" id="tsModStopInput" step="0.01" value="${tradeDetails.stopLoss.toFixed(2)}" style="width:100%; padding:6px; background:#1a1d24; border:1px solid #363b44; color:#fff; border-radius:4px; font-size:12px;">
                    </div>
                    <button onclick="modifyOrderLeg('STOP')" style="align-self:flex-end; padding:6px 12px; background:#f59e0b; color:#000; font-weight:bold; border:none; border-radius:4px; cursor:pointer; font-size:12px;">Update Stop</button>
                </div>
                <div style="display:flex; gap:10px;">
                    <div style="flex:1;">
                        <label style="font-size:11px; color:#94a3b8; display:block;">New Take Profit ($)</label>
                        <input type="number" id="tsModTPInput" step="0.01" value="${tradeDetails.profitTarget.toFixed(2)}" style="width:100%; padding:6px; background:#1a1d24; border:1px solid #363b44; color:#fff; border-radius:4px; font-size:12px;">
                    </div>
                    <button onclick="modifyOrderLeg('LIMIT')" style="align-self:flex-end; padding:6px 12px; background:#2563eb; color:#fff; font-weight:bold; border:none; border-radius:4px; cursor:pointer; font-size:12px;">Update Profit</button>
                </div>
            </div>

            <!-- Action Buttons -->
            <div style="display:flex; gap:10px; justify-content:space-between;">
                <button onclick="cancelAllTradeOrders()" style="flex:1; padding:10px; background:#dc2626; color:#fff; font-weight:bold; border:none; border-radius:4px; cursor:pointer;">Cancel All Orders</button>
                <button onclick="closeOrderMonitorModal()" style="padding:10px 20px; background:#374151; color:#fff; font-weight:bold; border:none; border-radius:4px; cursor:pointer;">Close Window</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    window.currentTradeState = {
        ...tradeDetails,
        ordersMap: {}
    };

    // Begin 1-Second Polling Loop
    startOrderMonitorLoop();
}

function closeOrderMonitorModal() {
    if (monitorInterval) clearInterval(monitorInterval);
    const modal = document.getElementById('tsOrderMonitorModal');
    if (modal) modal.remove();
}

// -------------------------------------------------------------------
// 3. MONITOR POLLING LOOP & REALTIME P/L
// -------------------------------------------------------------------
function isMarketClosed() {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    // NYSE Market Hours roughly 13:30 UTC to 20:00 UTC (M-F)
    if (day === 0 || day === 6) return true;
    if (hour < 13 || hour >= 20) return true;
    return false;
}

function startOrderMonitorLoop() {
    if (monitorInterval) clearInterval(monitorInterval);

    // Run immediately then every 1000ms
    updateOrderMonitor();
    monitorInterval = setInterval(updateOrderMonitor, 1000);
}

async function updateOrderMonitor() {
    if (!window.currentTradeState) return;

    const { symbol, shares, entryPrice, side, allOrderIds } = window.currentTradeState;

    // 1. Check Market Hours
    if (isMarketClosed()) {
        const badge = document.getElementById('tsMarketStatusBadge');
        if (badge) {
            badge.innerText = "MARKET CLOSED";
            badge.style.background = "#7f1d1d";
            badge.style.color = "#fca5a5";
        }
        clearInterval(monitorInterval);
        return;
    }

    // 2. Get Live Alpaca Price from DOM
    const rawPriceText = document.getElementById('dispPrice')?.innerText || "$0.00";
    const currentPrice = parseFloat(rawPriceText.replace('$', '')) || 0;

    if (currentPrice > 0) {
        document.getElementById('tsLiveMarketPrice').innerText = '$' + currentPrice.toFixed(2);

        // Calculate Realtime P/L
        let diff = (side === 'BUY') ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
        let totalPL = diff * shares;
        let pctPL = (diff / entryPrice) * 100;

        const plElem = document.getElementById('tsLiveUnrealizedPL');
        const pctElem = document.getElementById('tsLiveUnrealizedPLPct');

        if (plElem && pctElem) {
            plElem.innerText = `${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}`;
            pctElem.innerText = `${pctPL >= 0 ? '+' : ''}${pctPL.toFixed(2)}%`;

            const plColor = totalPL >= 0 ? '#4ade80' : '#f87171';
            plElem.style.color = plColor;
            pctElem.style.color = plColor;
        }
    }

    // 3. Query TradeStation Order Statuses
    try {
        const idsParam = allOrderIds.join(',');
        const statusUrl = `https://api.tradestation.com/v3/brokerage/accounts/${CONFIG.ACCOUNT_ID}/orders/${idsParam}`;

        const response = await fetch(statusUrl, {
            headers: { 'Authorization': `Bearer ${tradeStationToken}` }
        });

        if (response.ok) {
            const data = await response.json();
            const orders = data.Orders || (Array.isArray(data) ? data : [data]);

            let activeCount = 0;
            let tableRowsHTML = '';

            orders.forEach(o => {
                const status = o.StatusDescription || o.Status || 'UNKNOWN';
                window.currentTradeState.ordersMap[o.OrderID] = o;

                if (['Received', 'Sent', 'Queued', 'PartiallyFilled'].includes(status)) {
                    activeCount++;
                }

                const priceStr = o.LimitPrice ? `$${o.LimitPrice}` : (o.StopPrice ? `$${o.StopPrice}` : 'Market');

                tableRowsHTML += `
                    <tr style="border-bottom:1px solid #2d3139;">
                        <td style="padding:6px 8px; font-family:monospace;">${o.OrderID}</td>
                        <td style="padding:6px 8px;">${o.OrderType || 'Bracket'} (${o.TradeAction || ''})</td>
                        <td style="padding:6px 8px;">${priceStr}</td>
                        <td style="padding:6px 8px; font-weight:bold; color:${getStatusColor(status)}">${status}</td>
                    </tr>
                `;
            });

            const tbody = document.getElementById('tsOrderMonitorTableBody');
            if (tbody) tbody.innerHTML = tableRowsHTML;

            // Stop timer if all orders are in a terminal state (Filled, Cancelled, Rejected)
            if (orders.length > 0 && activeCount === 0) {
                const badge = document.getElementById('tsMarketStatusBadge');
                if (badge) {
                    badge.innerText = "ALL ORDERS TERMINATED";
                    badge.style.background = "#374151";
                }
                clearInterval(monitorInterval);
            }
        }
    } catch (err) {
        console.error("Error polling TradeStation order status:", err);
    }
}

function getStatusColor(status) {
    switch (status) {
        case 'Fills': case 'Filled': return '#4ade80';
        case 'CancelSent': case 'Cancelled': return '#94a3b8';
        case 'Rejected': case 'Error': return '#f87171';
        default: return '#facc15';
    }
}

// -------------------------------------------------------------------
// 4. ORDER MODIFICATION & CANCELLATION HANDLERS
// -------------------------------------------------------------------
async function modifyOrderLeg(type) {
    if (!window.currentTradeState) return;

    const { ordersMap } = window.currentTradeState;
    let targetOrder = Object.values(ordersMap).find(o => 
        type === 'STOP' ? (o.OrderType === 'StopMarket' || o.StopPrice) : (o.OrderType === 'Limit' || o.LimitPrice)
    );

    if (!targetOrder) {
        alert(`No active ${type} order found to modify.`);
        return;
    }

    const newPriceVal = type === 'STOP' 
        ? parseFloat(document.getElementById('tsModStopInput').value) 
        : parseFloat(document.getElementById('tsModTPInput').value);

    if (!newPriceVal || newPriceVal <= 0) {
        alert("Please enter a valid target price.");
        return;
    }

    const updatePayload = {
        Quantity: targetOrder.Quantity,
        OrderType: targetOrder.OrderType,
        [type === 'STOP' ? 'StopPrice' : 'LimitPrice']: newPriceVal.toFixed(2)
    };

    try {
        const replaceUrl = `https://api.tradestation.com/v3/orderexecution/orders/${targetOrder.OrderID}`;
        const res = await fetch(replaceUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${tradeStationToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePayload)
        });

        const resData = await res.json();
        if (res.ok) {
            alert(`Order ${targetOrder.OrderID} updated successfully!`);
            updateOrderMonitor();
        } else {
            alert(`Failed to update order: ${resData.Message || JSON.stringify(resData)}`);
        }
    } catch (err) {
        alert(`Error replacing order: ${err.message}`);
    }
}

async function cancelAllTradeOrders() {
    if (!window.currentTradeState || !confirm("Are you sure you want to cancel all active orders for this trade?")) return;

    const { allOrderIds } = window.currentTradeState;

    for (let orderId of allOrderIds) {
        try {
            const cancelUrl = `https://api.tradestation.com/v3/orderexecution/orders/${orderId}`;
            const res = await fetch(cancelUrl, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${tradeStationToken}` }
            });
            const data = await res.json();
            console.log(`Cancelled order ${orderId}:`, data);
        } catch (err) {
            console.error(`Failed to cancel order ${orderId}:`, err);
        }
    }

    updateOrderMonitor();
}
