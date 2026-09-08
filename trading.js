/**
 * trading.js
 *
 * Responsibilities:
 *  1. Keeps tradeStationToken fresh by polling /api/token before expiry.
 *  2. Submits an OSO bracket order to TradeStation.
 *  3. Opens a non-modal, draggable floating panel to monitor the order.
 *  4. P/L is only shown after the entry leg is confirmed Filled.
 *  5. Entry price input is editable (and sends a replace-order) while the
 *     entry leg is still pending.
 *  6. Live price in the monitor comes exclusively from the Alpaca REST API
 *     (no DOM-scraping of the main page price display).
 */

// -------------------------------------------------------------------
// 1. TOKEN MANAGEMENT — poll /api/token and refresh before expiry
// -------------------------------------------------------------------
const TOKEN_REFRESH_LEAD_MS = 4 * 60 * 1000; // refresh 4 min before expiry
let _tokenRefreshTimer = null;

async function refreshClientToken() {
    try {
        const res = await fetch('/api/token');
        if (!res.ok) return;
        const data = await res.json();

        if (data.token) {
            tradeStationToken = data.token;
            CONFIG.ACCOUNT_ID = data.accountId || CONFIG.ACCOUNT_ID;
        }

        // Schedule next refresh 4 minutes before the token expires
        if (data.expiresAt) {
            const delay = Math.max(data.expiresAt - Date.now() - TOKEN_REFRESH_LEAD_MS, 30 * 1000);
            if (_tokenRefreshTimer) clearTimeout(_tokenRefreshTimer);
            _tokenRefreshTimer = setTimeout(refreshClientToken, delay);
        }
    } catch (e) {
        console.error('[TOKEN] Failed to refresh client token:', e);
        // Retry in 60 s on error
        if (_tokenRefreshTimer) clearTimeout(_tokenRefreshTimer);
        _tokenRefreshTimer = setTimeout(refreshClientToken, 60 * 1000);
    }
}

// Called once from window.onload in the inline script; sets up the auto-refresh loop.
async function initClientToken() {
    await refreshClientToken();
}

// -------------------------------------------------------------------
// 2. ORDER SUBMISSION
// -------------------------------------------------------------------
async function executeOrder() {
    // Guard check: Valid access token
    if (!tradeStationToken) {
        alert("Not connected to TradeStation. Please wait for authentication.");
        return;
    }

    const symbolInput = document.getElementById('tickerInput');
    const symbol = symbolInput ? symbolInput.value.trim().toUpperCase() : '';
    const shares = parseInt(document.getElementById('shareInput').value) || 0;
    const entryPrice = parseFloat(document.getElementById('entryPrice').value) || 0;
    const stopLoss = parseFloat(document.getElementById('stopLoss').value) || 0;
    const profitTarget = parseFloat(document.getElementById('takeProfit').value) || 0;

    if (!symbol || shares <= 0 || entryPrice <= 0 || stopLoss <= 0 || profitTarget <= 0) {
        alert("Please ensure Ticker, Shares, Entry, Stop Loss, and Take Profit are all valid positive values.");
        return;
    }

    const isStopOrder = (orderType === 'STOP');
    const entryType = isStopOrder ? "StopMarket" : "Limit";
    const priceKey  = isStopOrder ? "StopPrice"  : "LimitPrice";

    const primaryAction = (currentSide === 'BUY') ? "BUY"       : "SELLSHORT";
    const exitAction    = (currentSide === 'BUY') ? "SELL"      : "BUYTOCOVER";

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

    const buyBtn  = document.getElementById('btnPlaceTradeBuy');
    const sellBtn = document.getElementById('btnPlaceTradeSell');

    try {
        if (buyBtn)  { buyBtn.disabled  = true; buyBtn.innerText  = "Placing..."; }
        if (sellBtn) { sellBtn.disabled = true; sellBtn.innerText = "Placing..."; }

        const response = await fetch("https://api.tradestation.com/v3/orderexecution/orders", {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tradeStationToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        console.log(`[TradeStation] Status: ${response.status} ${response.statusText}`);
        const data = await response.json();
        const orderList = data.Orders || (Array.isArray(data) ? data : []);

        const failedOrders = orderList.filter(o => o.Error || o.RejectReason || o.Status === "Rejected");
        if (failedOrders.length > 0) {
            const msgs = failedOrders.map((o, i) => {
                const id  = o.OrderID ? ` (Order ID: ${o.OrderID})` : '';
                const msg = o.Message || o.RejectReason || o.Error || 'Unknown Error';
                return `Leg ${i + 1}${id}: ${msg}`;
            }).join('\n\n');
            alert(`⚠️ TradeStation Order Placement Failed:\n\n${msgs}`);
            return;
        }

        if (response.ok && (orderList.length > 0 || data.OrderID)) {
            let childOrderIds  = orderList.map(o => o.OrderID).filter(Boolean);

            // Identify the entry leg by matching the submitted trade action and order type.
            // The OSO response may return child bracket legs first, so index 0 is unreliable.
            const entryTradeAction = primaryAction;  // 'BUY' or 'SELLSHORT'
            const entryOrderTypeLower = entryType.toLowerCase(); // 'limit' or 'stopmarket'
            const entryLeg = orderList.find(o =>
                o.TradeAction?.toUpperCase() === entryTradeAction &&
                o.OrderType?.toLowerCase()   === entryOrderTypeLower
            );
            let primaryOrderId = entryLeg?.OrderID || data.OrderID || (orderList[0] ? orderList[0].OrderID : null);

            if (!childOrderIds.length && primaryOrderId) childOrderIds = [primaryOrderId];

            if (buyBtn)  { buyBtn.innerText  = "Order Placed! ✓"; }
            if (sellBtn) { sellBtn.innerText = "Order Placed! ✓"; }
            setTimeout(() => {
                if (buyBtn)  { buyBtn.disabled  = false; buyBtn.innerText  = "BUY"; }
                if (sellBtn) { sellBtn.disabled = false; sellBtn.innerText = "SELL"; }
            }, 2500);

            openOrderMonitorPanel({
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
    } finally {
        // Re-enable buttons if they were not already reset by the success path
        setTimeout(() => {
            if (buyBtn  && buyBtn.disabled)  { buyBtn.disabled  = false; buyBtn.innerText  = "BUY"; }
            if (sellBtn && sellBtn.disabled) { sellBtn.disabled = false; sellBtn.innerText = "SELL"; }
        }, 3000);
    }
}

// -------------------------------------------------------------------
// 3. NON-MODAL FLOATING PANEL
//    Multiple panels can coexist; each gets a unique ID.
// -------------------------------------------------------------------
let _panelCounter = 0;

function openOrderMonitorPanel(tradeDetails) {
    _panelCounter++;
    const panelId  = `tsPanel_${_panelCounter}`;
    const stateKey = `tsState_${_panelCounter}`;

    // Each panel tracks its own state on window
    window[stateKey] = {
        ...tradeDetails,
        ordersMap:       {},
        entryFilled:     false,
        fillPrice:       null,
        entryOrderId:    tradeDetails.primaryOrderId,
        intervalId:      null,
        alpacaWs:        null,
        latestAlpacaPrice: 0,
        panelId,
        stateKey
    };

    const panel = document.createElement('div');
    panel.id = panelId;
    panel.style.cssText = [
        'position:fixed',
        'top:60px',
        `left:${80 + (_panelCounter - 1) * 30}px`,
        'width:580px',
        'background:#1a1d24',
        'border:1px solid #363b44',
        'border-radius:10px',
        'padding:0',
        'color:#fff',
        'box-shadow:0 10px 25px rgba(0,0,0,0.7)',
        'z-index:' + (9000 + _panelCounter),
        'font-family:sans-serif',
        'resize:both',
        'overflow:hidden',
        'min-width:420px',
        'min-height:300px'
    ].join(';');

    panel.innerHTML = `
        <!-- Drag Handle / Title Bar -->
        <div id="${panelId}_titlebar" style="display:flex;justify-content:space-between;align-items:center;background:#232730;border-radius:10px 10px 0 0;padding:10px 16px;cursor:move;user-select:none;">
            <span style="font-size:15px;font-weight:bold;color:#38bdf8;">
                Order Monitor: ${tradeDetails.symbol} (${tradeDetails.side})
            </span>
            <div style="display:flex;gap:8px;align-items:center;">
                <span id="${panelId}_badge" style="font-size:11px;padding:3px 8px;border-radius:4px;background:#1e293b;color:#94a3b8;">MONITORING</span>
                <button onclick="closeOrderMonitorPanel('${panelId}','${stateKey}')" style="background:#374151;color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:13px;">✕</button>
            </div>
        </div>

        <!-- Body -->
        <div style="padding:16px;">

            <!-- Live Price (always shown) + P/L (revealed after entry fill) -->
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;background:#0f1115;padding:12px;border-radius:6px;margin-bottom:14px;text-align:center;">
                <div>
                    <span style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px;">Alpaca Live Price</span>
                    <strong id="${panelId}_price" style="font-size:18px;color:#38bdf8;">$0.00</strong>
                </div>
                <div id="${panelId}_plCell" style="display:none;">
                    <span style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px;">Unrealized P/L ($)</span>
                    <strong id="${panelId}_pl" style="font-size:18px;color:#94a3b8;">—</strong>
                </div>
                <div id="${panelId}_plpctCell" style="display:none;">
                    <span style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px;">Unrealized P/L (%)</span>
                    <strong id="${panelId}_plpct" style="font-size:18px;color:#94a3b8;">—</strong>
                </div>
            </div>

            <!-- Order Legs Table -->
            <div style="max-height:160px;overflow-y:auto;margin-bottom:14px;border:1px solid #2d3139;border-radius:6px;">
                <table style="width:100%;border-collapse:collapse;font-size:12px;">
                    <thead style="background:#232730;color:#94a3b8;">
                        <tr>
                            <th style="padding:7px 8px;text-align:left;">Role</th>
                            <th style="padding:7px 8px;text-align:left;">Order ID</th>
                            <th style="padding:7px 8px;text-align:left;">Price</th>
                            <th style="padding:7px 8px;text-align:left;">Status</th>
                        </tr>
                    </thead>
                    <tbody id="${panelId}_tbody">
                        <tr><td colspan="4" style="padding:10px;text-align:center;color:#94a3b8;">Fetching order status…</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- Entry Price Modify (only while unfilled) -->
            <div id="${panelId}_entryModSection" style="background:#0f1115;padding:12px;border-radius:6px;margin-bottom:12px;border:1px solid #2d3139;">
                <div style="font-size:12px;font-weight:bold;color:#facc15;margin-bottom:8px;">Modify Entry Price (while pending)</div>
                <div style="display:flex;gap:10px;">
                    <div style="flex:1;">
                        <label style="font-size:11px;color:#94a3b8;display:block;">New Entry Price ($)</label>
                        <input type="number" id="${panelId}_entryInput" step="0.01" value="${tradeDetails.entryPrice.toFixed(2)}"
                               style="width:100%;padding:6px;background:#1a1d24;border:1px solid #363b44;color:#fff;border-radius:4px;font-size:12px;">
                    </div>
                    <button onclick="modifyEntryOrder('${panelId}','${stateKey}')"
                            style="align-self:flex-end;padding:6px 12px;background:#f59e0b;color:#000;font-weight:bold;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
                        Update Entry
                    </button>
                </div>
            </div>

            <!-- Bracket Leg Modification -->
            <div style="background:#0f1115;padding:12px;border-radius:6px;margin-bottom:12px;border:1px solid #2d3139;">
                <div style="font-size:12px;font-weight:bold;color:#facc15;margin-bottom:8px;">Modify Bracket Legs</div>
                <div style="display:flex;gap:10px;margin-bottom:8px;">
                    <div style="flex:1;">
                        <label style="font-size:11px;color:#94a3b8;display:block;">New Stop Loss ($)</label>
                        <input type="number" id="${panelId}_stopInput" step="0.01" value="${tradeDetails.stopLoss.toFixed(2)}"
                               style="width:100%;padding:6px;background:#1a1d24;border:1px solid #363b44;color:#fff;border-radius:4px;font-size:12px;">
                    </div>
                    <button onclick="modifyBracketLeg('${panelId}','${stateKey}','STOP')"
                            style="align-self:flex-end;padding:6px 12px;background:#f59e0b;color:#000;font-weight:bold;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
                        Update Stop
                    </button>
                </div>
                <div style="display:flex;gap:10px;">
                    <div style="flex:1;">
                        <label style="font-size:11px;color:#94a3b8;display:block;">New Take Profit ($)</label>
                        <input type="number" id="${panelId}_tpInput" step="0.01" value="${tradeDetails.profitTarget.toFixed(2)}"
                               style="width:100%;padding:6px;background:#1a1d24;border:1px solid #363b44;color:#fff;border-radius:4px;font-size:12px;">
                    </div>
                    <button onclick="modifyBracketLeg('${panelId}','${stateKey}','LIMIT')"
                            style="align-self:flex-end;padding:6px 12px;background:#2563eb;color:#fff;font-weight:bold;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
                        Update Profit
                    </button>
                </div>
            </div>

            <!-- Action Row -->
            <div style="display:flex;gap:10px;">
                <button onclick="cancelAllPanelOrders('${panelId}','${stateKey}')"
                        style="flex:1;padding:10px;background:#dc2626;color:#fff;font-weight:bold;border:none;border-radius:4px;cursor:pointer;">
                    Cancel All Orders
                </button>
                <button onclick="closeOrderMonitorPanel('${panelId}','${stateKey}')"
                        style="padding:10px 20px;background:#374151;color:#fff;font-weight:bold;border:none;border-radius:4px;cursor:pointer;">
                    Close
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(panel);
    makePanelDraggable(panelId);
    startPanelMonitor(panelId, stateKey);
}

// -------------------------------------------------------------------
// 4. DRAG SUPPORT
// -------------------------------------------------------------------
function makePanelDraggable(panelId) {
    const panel   = document.getElementById(panelId);
    const titlebar = document.getElementById(`${panelId}_titlebar`);
    if (!panel || !titlebar) return;

    let startX, startY, origLeft, origTop;

    titlebar.addEventListener('mousedown', (e) => {
        startX   = e.clientX;
        startY   = e.clientY;
        origLeft = panel.offsetLeft;
        origTop  = panel.offsetTop;

        function onMove(e) {
            panel.style.left = (origLeft + e.clientX - startX) + 'px';
            panel.style.top  = (origTop  + e.clientY - startY) + 'px';
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// -------------------------------------------------------------------
// 5. PANEL LIFECYCLE
// -------------------------------------------------------------------
function closeOrderMonitorPanel(panelId, stateKey) {
    const state = window[stateKey];
    if (state) {
        if (state.intervalId)        clearInterval(state.intervalId);
        if (state.alpacaRestFallback) clearInterval(state.alpacaRestFallback);
        if (state.alpacaWs && state.alpacaWs.readyState === WebSocket.OPEN) {
            state.alpacaWs.close();
        }
        delete window[stateKey];
    }
    const panel = document.getElementById(panelId);
    if (panel) panel.remove();
}

// -------------------------------------------------------------------
// 6. MONITOR POLLING LOOP
// -------------------------------------------------------------------
function startPanelMonitor(panelId, stateKey) {
    const state = window[stateKey];
    if (!state) return;

    // Start Alpaca price stream for this panel's symbol
    connectAlpacaPriceStream(panelId, stateKey);

    // Poll TradeStation order status every 2 seconds
    updatePanelMonitor(panelId, stateKey);
    state.intervalId = setInterval(() => updatePanelMonitor(panelId, stateKey), 2000);
}

// -------------------------------------------------------------------
// 7. ALPACA PRICE STREAM (per panel — REST seed + WS ticks + REST fallback)
// -------------------------------------------------------------------
async function connectAlpacaPriceStream(panelId, stateKey) {
    const state = window[stateKey];
    if (!state) return;

    const symbol = state.symbol.toUpperCase();

    // 1. Seed price immediately via REST so the display is never $0.00 at open
    const seedPrice = await fetchAlpacaLatestPrice(symbol);
    if (seedPrice > 0) {
        state.latestAlpacaPrice = seedPrice;
        updatePanelPriceDisplay(panelId, stateKey);
    }

    // 2. REST polling every 5 s — always running as a reliable baseline
    state.alpacaRestFallback = setInterval(async () => {
        const price = await fetchAlpacaLatestPrice(symbol);
        if (price > 0) {
            state.latestAlpacaPrice = price;
            updatePanelPriceDisplay(panelId, stateKey);
        }
    }, 5000);

    // 3. WebSocket for sub-second updates on top of the REST baseline
    const ws = new WebSocket(ALPACA_CONFIG.WS_URL);
    state.alpacaWs = ws;

    ws.onopen = () => {
        ws.send(JSON.stringify({ action: 'auth', key: ALPACA_CONFIG.API_KEY, secret: ALPACA_CONFIG.API_SECRET }));
    };

    ws.onmessage = (event) => {
        try {
            const messages = JSON.parse(event.data);
            messages.forEach(msg => {
                if (msg.T === 'success' && msg.msg === 'authenticated') {
                    ws.send(JSON.stringify({ action: 'subscribe', quotes: [symbol] }));
                }
                if (msg.T === 't' || msg.T === 'q') {
                    const p = parseFloat(msg.p || msg.bp || 0);
                    if (p > 0) {
                        state.latestAlpacaPrice = p;
                        updatePanelPriceDisplay(panelId, stateKey);
                    }
                }
            });
        } catch (e) { /* ignore parse errors */ }
    };

    // WS close/error: REST fallback is already running, nothing extra needed
    ws.onerror = (e) => { console.warn(`[AlpacaWS ${panelId}] error, REST fallback active`, e); };
    ws.onclose = ()  => { console.log(`[AlpacaWS ${panelId}] closed, REST fallback active`); };
}

async function fetchAlpacaLatestPrice(symbol) {
    try {
        const res = await fetch(
            `${ALPACA_CONFIG.REST_URL}/stocks/${symbol}/snapshot`,
            { headers: {
                'APCA-API-KEY-ID':     ALPACA_CONFIG.API_KEY,
                'APCA-API-SECRET-KEY': ALPACA_CONFIG.API_SECRET
            }}
        );
        const data = await res.json();
        return parseFloat(data.latestTrade?.p || data.latestQuote?.ap || 0);
    } catch (e) { return 0; }
}

// -------------------------------------------------------------------
// 8. PRICE DISPLAY — always shows live price; P/L shown only after entry fill
// -------------------------------------------------------------------
function updatePanelPriceDisplay(panelId, stateKey) {
    const state = window[stateKey];
    if (!state) return;
    const price = state.latestAlpacaPrice;
    if (price <= 0) return;

    const priceEl = document.getElementById(`${panelId}_price`);
    if (priceEl) priceEl.innerText = '$' + price.toFixed(2);

    // P/L only computed and shown after the entry order is confirmed filled
    if (!state.entryFilled || !state.fillPrice) return;

    const { fillPrice, shares, side } = state;
    const diff    = (side === 'BUY') ? (price - fillPrice) : (fillPrice - price);
    const totalPL = diff * shares;
    const pctPL   = (diff / fillPrice) * 100;
    const color   = totalPL >= 0 ? '#4ade80' : '#f87171';

    // Reveal the P/L cells on first fill detection
    const plCell    = document.getElementById(`${panelId}_plCell`);
    const plpctCell = document.getElementById(`${panelId}_plpctCell`);
    if (plCell)    plCell.style.display    = '';
    if (plpctCell) plpctCell.style.display = '';

    const plEl  = document.getElementById(`${panelId}_pl`);
    const pctEl = document.getElementById(`${panelId}_plpct`);
    if (plEl) {
        plEl.innerText   = `${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}`;
        plEl.style.color = color;
    }
    if (pctEl) {
        pctEl.innerText   = `${pctPL >= 0 ? '+' : ''}${pctPL.toFixed(2)}%`;
        pctEl.style.color = color;
    }
}

// -------------------------------------------------------------------
// 9. TRADESTATION ORDER POLLING
// -------------------------------------------------------------------
async function updatePanelMonitor(panelId, stateKey) {
    const state = window[stateKey];
    if (!state) return;

    const { allOrderIds, entryOrderId } = state;

    try {
        const idsParam  = allOrderIds.join(',');
        const statusUrl = `https://api.tradestation.com/v3/brokerage/accounts/${CONFIG.ACCOUNT_ID}/orders/${idsParam}`;

        const response = await fetch(statusUrl, {
            headers: { 'Authorization': `Bearer ${tradeStationToken}` }
        });
        if (!response.ok) return;

        const data   = await response.json();
        const orders = data.Orders || (Array.isArray(data) ? data : [data]);

        let activeCount  = 0;
        let tableRowsHTML = '';

        orders.forEach(o => {
            const status = o.StatusDescription || o.Status || 'UNKNOWN';
            state.ordersMap[o.OrderID] = o;

            // Detect entry fill
            if (o.OrderID === entryOrderId && (status === 'Filled' || status === 'Fills')) {
                if (!state.entryFilled) {
                    state.entryFilled = true;
                    state.fillPrice = parseFloat(o.FilledPrice || o.AverageFillPrice || state.entryPrice);

                    // Hide the "Modify Entry" section — order is filled
                    const entrySection = document.getElementById(`${panelId}_entryModSection`);
                    if (entrySection) entrySection.style.display = 'none';

                    const badge = document.getElementById(`${panelId}_badge`);
                    if (badge) {
                        badge.innerText        = 'FILLED';
                        badge.style.background = '#14532d';
                        badge.style.color      = '#4ade80';
                    }
                }
            }

            if (['Received', 'Sent', 'Queued', 'PartiallyFilled', 'ACK', 'OPN'].includes(status)) {
                activeCount++;
            }

            const priceStr = o.LimitPrice
                ? `$${o.LimitPrice}`
                : (o.StopPrice ? `$${o.StopPrice}` : 'Market');

            // Derive a human-readable role label for this order leg
            let roleLabel, roleColor;
            if (o.OrderID === entryOrderId) {
                roleLabel = '📥 ENTRY';
                roleColor = '#38bdf8';
            } else if (o.OrderType === 'StopMarket' || o.StopPrice) {
                roleLabel = '🛑 STOP LOSS';
                roleColor = '#f87171';
            } else {
                roleLabel = '🎯 TAKE PROFIT';
                roleColor = '#4ade80';
            }

            tableRowsHTML += `
                <tr style="border-bottom:1px solid #2d3139;">
                    <td style="padding:6px 8px;font-weight:bold;color:${roleColor};white-space:nowrap;">${roleLabel}</td>
                    <td style="padding:6px 8px;font-family:monospace;font-size:11px;">${o.OrderID}</td>
                    <td style="padding:6px 8px;">${priceStr}</td>
                    <td style="padding:6px 8px;font-weight:bold;color:${getStatusColor(status)}">${status}</td>
                </tr>`;
        });

        const tbody = document.getElementById(`${panelId}_tbody`);
        if (tbody) tbody.innerHTML = tableRowsHTML || '<tr><td colspan="4" style="padding:10px;text-align:center;color:#94a3b8;">No orders returned.</td></tr>';

        // Stop polling when all orders reach terminal state
        if (orders.length > 0 && activeCount === 0) {
            clearInterval(state.intervalId);
            const badge = document.getElementById(`${panelId}_badge`);
            if (badge && !state.entryFilled) {
                badge.innerText        = 'ALL TERMINATED';
                badge.style.background = '#374151';
                badge.style.color      = '#94a3b8';
            }
        }
    } catch (err) {
        console.error(`[Monitor ${panelId}] Error polling order status:`, err);
    }
}

function getStatusColor(status) {
    switch (status) {
        case 'Fills':
        case 'Filled':     return '#4ade80';
        case 'CancelSent':
        case 'Cancelled':  return '#94a3b8';
        case 'Rejected':
        case 'Error':      return '#f87171';
        default:           return '#facc15';
    }
}

// -------------------------------------------------------------------
// 10. ENTRY ORDER MODIFICATION (while pending)
// -------------------------------------------------------------------
async function modifyEntryOrder(panelId, stateKey) {
    const state = window[stateKey];
    if (!state || state.entryFilled) {
        alert("Entry order is already filled. Cannot modify.");
        return;
    }

    const newPrice = parseFloat(document.getElementById(`${panelId}_entryInput`)?.value);
    if (!newPrice || newPrice <= 0) {
        alert("Please enter a valid entry price.");
        return;
    }

    const targetOrder = state.ordersMap[state.entryOrderId];
    if (!targetOrder) {
        alert("Entry order not yet retrieved from TradeStation. Please wait a moment.");
        return;
    }

    const currentOrderType = targetOrder.OrderType || 'Limit';
    const priceField = (currentOrderType === 'StopMarket' || currentOrderType === 'Stop')
        ? 'StopPrice' : 'LimitPrice';

    const updatePayload = {
        Quantity:  targetOrder.Quantity,
        OrderType: currentOrderType,
        [priceField]: newPrice.toFixed(2)
    };

    try {
        const res = await fetch(
            `https://api.tradestation.com/v3/orderexecution/orders/${state.entryOrderId}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${tradeStationToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updatePayload)
            }
        );
        const resData = await res.json();
        if (res.ok) {
            state.entryPrice = newPrice;
            alert(`Entry order ${state.entryOrderId} updated to $${newPrice.toFixed(2)}`);
            updatePanelMonitor(panelId, stateKey);
        } else {
            alert(`Failed to update entry: ${resData.Message || JSON.stringify(resData)}`);
        }
    } catch (err) {
        alert(`Error modifying entry order: ${err.message}`);
    }
}

// -------------------------------------------------------------------
// 11. BRACKET LEG MODIFICATION
// -------------------------------------------------------------------
async function modifyBracketLeg(panelId, stateKey, type) {
    const state = window[stateKey];
    if (!state) return;

    const { ordersMap } = state;

    // Find the correct child order (exclude the entry order itself)
    const targetOrder = Object.values(ordersMap).find(o => {
        if (o.OrderID === state.entryOrderId) return false;
        return type === 'STOP'
            ? (o.OrderType === 'StopMarket' || o.StopPrice)
            : (o.OrderType === 'Limit'      || o.LimitPrice);
    });

    if (!targetOrder) {
        alert(`No active ${type} bracket order found to modify.`);
        return;
    }

    const inputId    = type === 'STOP' ? `${panelId}_stopInput` : `${panelId}_tpInput`;
    const newPrice   = parseFloat(document.getElementById(inputId)?.value);

    if (!newPrice || newPrice <= 0) {
        alert("Please enter a valid price.");
        return;
    }

    const updatePayload = {
        Quantity:  targetOrder.Quantity,
        OrderType: targetOrder.OrderType,
        [type === 'STOP' ? 'StopPrice' : 'LimitPrice']: newPrice.toFixed(2)
    };

    try {
        const res = await fetch(
            `https://api.tradestation.com/v3/orderexecution/orders/${targetOrder.OrderID}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${tradeStationToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updatePayload)
            }
        );
        const resData = await res.json();
        if (res.ok) {
            alert(`Order ${targetOrder.OrderID} updated successfully!`);
            updatePanelMonitor(panelId, stateKey);
        } else {
            alert(`Failed to update order: ${resData.Message || JSON.stringify(resData)}`);
        }
    } catch (err) {
        alert(`Error replacing order: ${err.message}`);
    }
}

// -------------------------------------------------------------------
// 12. CANCEL ALL ORDERS FOR A PANEL
// -------------------------------------------------------------------
async function cancelAllPanelOrders(panelId, stateKey) {
    const state = window[stateKey];
    if (!state || !confirm("Are you sure you want to cancel all active orders for this trade?")) return;

    const { allOrderIds } = state;

    for (const orderId of allOrderIds) {
        try {
            const res = await fetch(
                `https://api.tradestation.com/v3/orderexecution/orders/${orderId}`,
                {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${tradeStationToken}` }
                }
            );
            const data = await res.json();
            console.log(`Cancelled order ${orderId}:`, data);
        } catch (err) {
            console.error(`Failed to cancel order ${orderId}:`, err);
        }
    }

    updatePanelMonitor(panelId, stateKey);
}
