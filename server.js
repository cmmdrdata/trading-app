require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_FILE_PATH = path.join(__dirname, '.token');

app.use(express.json());

// Global State
let tokens = {
    accessToken: null,
    refreshToken: null,
    expiresAt: null
};

let refreshTimer = null;
let tokenRefreshTimeoutId = null;

// -------------------------------------------------------------------
// 1. FILE I/O & TOKEN PERSISTENCE
// -------------------------------------------------------------------
function saveTokensToFile(tokenData) {
    try {
        fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokenData, null, 2), 'utf-8');
        console.log('[STORAGE] Saved updated tokens to .token file.');
    } catch (err) {
        console.error('[STORAGE ERROR] Failed to save .token file:', err.message);
    }
}

function loadTokensFromFile() {
    if (!fs.existsSync(TOKEN_FILE_PATH)) {
        console.log('[STORAGE] No existing .token file found.');
        return null;
    }

    try {
        const fileContent = fs.readFileSync(TOKEN_FILE_PATH, 'utf-8');
        return JSON.parse(fileContent);
    } catch (err) {
        console.error('[STORAGE ERROR] Failed to read .token file:', err.message);
        return null;
    }
}

// -------------------------------------------------------------------
// 2. TOKEN REFRESH LOGIC & TIMER
// -------------------------------------------------------------------
async function refreshAccessToken() {
    console.log('\n[TOKEN REFRESH] Refreshing TradeStation API token...');

    if (!tokens.refreshToken) {
        console.error('[TOKEN REFRESH ERROR] No refresh token available.');
        return false;
    }

    try {
        const refreshParams = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            refresh_token: tokens.refreshToken
        });

        const response = await axios.post(
            'https://signin.tradestation.com/oauth/token',
            refreshParams.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        tokens.accessToken = response.data.access_token;
        if (response.data.refresh_token) {
            tokens.refreshToken = response.data.refresh_token;
        }

        const expiresInMs = response.data.expires_in * 1000;
        tokens.expiresAt = Date.now() + expiresInMs;

        saveTokensToFile(tokens);
        console.log(`[TOKEN REFRESH] Token refreshed successfully. Next refresh in ${Math.round((expiresInMs - REFRESH_LEAD_MS) / 60000)} min.`);
        scheduleNextRefresh();
        return true;

    } catch (err) {
        console.error('[TOKEN REFRESH ERROR] Refresh failed:', err.response?.data || err.message);
        // Retry in 60 seconds on failure instead of giving up
        console.log('[TOKEN REFRESH] Retrying in 60 seconds...');
        if (tokenRefreshTimeoutId) clearTimeout(tokenRefreshTimeoutId);
        tokenRefreshTimeoutId = setTimeout(refreshAccessToken, 60 * 1000);
        return false;
    }
}

// Refresh 5 minutes before expiry using a single proactive setTimeout
const REFRESH_LEAD_MS = 5 * 60 * 1000;

function scheduleNextRefresh() {
    if (tokenRefreshTimeoutId) clearTimeout(tokenRefreshTimeoutId);
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

    if (!tokens.expiresAt || !tokens.refreshToken) return;

    const delay = Math.max(tokens.expiresAt - Date.now() - REFRESH_LEAD_MS, 10 * 1000);
    console.log(`[TOKEN REFRESH] Next refresh scheduled in ${Math.round(delay / 60000)} min.`);
    tokenRefreshTimeoutId = setTimeout(refreshAccessToken, delay);
}

// Keep the old name as an alias so callers inside the auth code route still work
function scheduleBackgroundRefresh() {
    scheduleNextRefresh();
}

async function initializeTokensOnLaunch() {
    const savedTokens = loadTokensFromFile();
    if (!savedTokens || !savedTokens.accessToken) return;

    tokens = savedTokens;
    const timeRemaining = tokens.expiresAt - Date.now();

    console.log(`[STARTUP] Access Token Loaded. ${Math.round(timeRemaining / 1000)}s remaining.`);

    if (timeRemaining > REFRESH_LEAD_MS) {
        scheduleNextRefresh();
    } else if (timeRemaining > 0) {
        // Token still valid but within the lead window — refresh immediately
        await refreshAccessToken();
    } else {
        // Token already expired — attempt refresh immediately
        console.log('[STARTUP] Token expired. Attempting immediate refresh...');
        await refreshAccessToken();
    }
}

// -------------------------------------------------------------------
// 3. API ROUTES FOR FRONTEND
// -------------------------------------------------------------------
app.get('/login', (req, res) => {
    const authUrl = new URL('https://signin.tradestation.com/authorize');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', process.env.CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', process.env.REDIRECT_URI);
    authUrl.searchParams.append('audience', 'https://api.tradestation.com');
    authUrl.searchParams.append('scope', 'openid profile offline_access MarketData ReadAccount Trade');
    res.redirect(authUrl.toString());
});

app.get('/api/equity', async (req, res) => {
    if (!tokens.accessToken) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const accountId = process.env.ACCOUNT_ID;
        const response = await axios.get(
            `https://api.tradestation.com/v3/brokerage/accounts/${accountId}/balances`,
            { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
        );

        const balances = response.data.Balances?.[0] || response.data;
        const buyingPower = parseFloat(
            balances?.DayTradingBuyingPower ||
            balances?.BuyingPower ||
            balances?.CashBalance ||
            10000
        );

        res.json({ buyingPower });
    } catch (err) {
        res.json({ buyingPower: 25000, simulated: true });
    }
});

app.get('/api/token', (req, res) => {
    res.json({
        token: tokens.accessToken,
        accountId: process.env.ACCOUNT_ID,
        expiresAt: tokens.expiresAt || null
    });
});

app.get('/api/config', (req, res) => {
    res.json({
        alpacaApiKey:    process.env.ALPACA_API_KEY,
        alpacaApiSecret: process.env.ALPACA_API_SECRET
    });
});

// Serve static trading.js file if placed in the same directory
app.use(express.static(__dirname));

// -------------------------------------------------------------------
// 4. MAIN DASHBOARD / TRADING UI ROUTE
// -------------------------------------------------------------------
app.get('/', async (req, res) => {
    const { code, error, error_description } = req.query;

    if (error) return res.status(400).send(`Authentication Failed: ${error_description}`);

    if (code) {
        try {
            const tokenParams = new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                code: code,
                redirect_uri: process.env.REDIRECT_URI
            });

            const tokenResponse = await axios.post(
                'https://signin.tradestation.com/oauth/token',
                tokenParams.toString(),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );

            tokens.accessToken = tokenResponse.data.access_token;
            tokens.refreshToken = tokenResponse.data.refresh_token;
            tokens.expiresAt = Date.now() + tokenResponse.data.expires_in * 1000;

            saveTokensToFile(tokens);
            scheduleBackgroundRefresh();
            return res.redirect('/');
        } catch (err) {
            return res.status(500).send('Failed to retrieve access token.');
        }
    }

    if (!tokens.accessToken) {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 100px;">
                <h2>TradeStation Authentication Required</h2>
                <a href="/login" style="padding: 10px 20px; background: #0066cc; color: white; text-decoration: none; border-radius: 4px;">Log In to TradeStation</a>
            </div>
        `);
    }

    // Serve HTML Interface
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Trade Window</title>
        <script src="trading.js"></script>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #e1e1e6; margin: 0; padding: 20px; }
            .card { background: #1a1d24; border: 1px solid #2d3139; border-radius: 8px; max-width: 520px; margin: 0 auto; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
            .ticker-bar { display: flex; gap: 10px; margin-bottom: 20px; }
            input { background: #0f1115; border: 1px solid #363b44; color: #fff; padding: 10px; border-radius: 4px; width: 100%; box-sizing: border-box; font-size: 14px; }
            button { cursor: pointer; border: none; border-radius: 4px; font-weight: bold; padding: 10px 15px; transition: all 0.2s ease; }
            .btn-primary { background: #2563eb; color: white; }

            .btn-hl {
                background: #2a2e37;
                color: #858b98;
                padding: 10px 20px;
                font-weight: bold;
                border: 1px solid #363b44;
                opacity: 0.6;
            }
            .btn-hl.active {
                background: #f59e0b;
                color: #000;
                opacity: 1;
                border-color: #f59e0b;
                box-shadow: 0 0 10px rgba(245, 158, 11, 0.4);
            }

            .btn-buy { background: #16a34a; color: white; flex: 1; padding: 12px; font-size: 16px; }
            .btn-sell { background: #dc2626; color: white; flex: 1; padding: 12px; font-size: 16px; }
            .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: #0f1115; padding: 12px; border-radius: 6px; text-align: center; margin-bottom: 20px; }
            .metric-val { font-size: 16px; font-weight: bold; color: #38bdf8; margin-top: 4px; }
            .form-group { margin-bottom: 15px; }
            label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 5px; }
            .row { display: flex; gap: 10px; align-items: center; }
            .radio-group { display: flex; gap: 12px; background: #0f1115; padding: 8px 12px; border-radius: 4px; border: 1px solid #363b44; }
            .radio-group label { margin-bottom: 0; cursor: pointer; color: #fff; display: flex; align-items: center; gap: 4px; font-size: 13px; }
            .radio-group input { width: auto; }
            .summary { background: #232730; padding: 12px; border-radius: 6px; font-size: 14px; margin-top: 15px; border-left: 4px solid #38bdf8; }

            /* --- Custom Slide Selector Styles --- */
            .slide-selector-container {
                display: flex;
                background: #0f1115;
                border: 1px solid #363b44;
                border-radius: 6px;
                padding: 3px;
                position: relative;
                cursor: pointer;
                user-select: none;
            }
            .slide-option {
                flex: 1;
                text-align: center;
                padding: 8px 0;
                font-size: 13px;
                font-weight: bold;
                z-index: 2;
                color: #858b98;
                transition: color 0.2s ease;
            }
            .slide-option.active {
                color: #ffffff;
            }
            .slide-glider {
                position: absolute;
                top: 3px;
                bottom: 3px;
                width: calc(50% - 3px);
                background: #2563eb;
                border-radius: 4px;
                transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                z-index: 1;
            }
            .slide-glider.stop-pos {
                transform: translateX(100%);
            }
        </style>
    </head>
    <body>
        <div class="card">
            <h3>Trade Execution Window</h3>
            <div class="ticker-bar">
                <input type="text" id="tickerInput" value="AAPL" style="text-transform:uppercase;">
                <button class="btn-primary" onclick="changeSymbol()">Connect</button>
                <button id="btnHl" class="btn-hl" onclick="toggleHighLowPreset()" title="Toggle H/L Preset">H/L</button>
            </div>

            <!-- Live Market Metrics -->
            <div class="metrics">
                <div><label>Current</label><div class="metric-val" id="dispPrice">$0.00</div></div>
                <div><label>Day High</label><div class="metric-val" id="dispHigh" style="color:#4ade80">$0.00</div></div>
                <div><label>Day Low</label><div class="metric-val" id="dispLow" style="color:#f87171">$0.00</div></div>
            </div>

            <!-- Order Type Slide Selector -->
            <div class="form-group">
                <label>Order Type</label>
                <div class="slide-selector-container" onclick="toggleOrderTypeSlide()">
                    <div id="optLimit" class="slide-option active">LIMIT</div>
                    <div id="optStop" class="slide-option">STOP</div>
                    <div id="slideGlider" class="slide-glider"></div>
                </div>
            </div>

            <!-- Take Profit Field -->
            <div class="form-group">
                <label>Take Profit ($) </label>
                <input type="number" step="0.01" id="takeProfit">
            </div>

            <!-- Price Inputs -->
            <div class="form-group">
                <label>Entry Price ($)</label>
                <input type="number" step="0.01" id="entryPrice" oninput="onEntryOrStopChange()">
            </div>
            <div class="form-group">
                <label>Stop Loss Price ($)</label>
                <input type="number" step="0.01" id="stopLoss" oninput="onEntryOrStopChange()">
            </div>

            <!-- Risk Multipliers -->
            <div class="form-group">
                <label>Risk Multiplier</label>
                <div class="radio-group">
                    <label><input type="radio" name="riskMult" value="0.5" onchange="calculatePositionSize()"> 0.5x</label>
                    <label><input type="radio" name="riskMult" value="1.0" id="riskMultDefault" checked onchange="calculatePositionSize()"> 1.0x</label>
                    <label><input type="radio" name="riskMult" value="1.5" onchange="calculatePositionSize()"> 1.5x</label>
                    <label><input type="radio" name="riskMult" value="2.0" onchange="calculatePositionSize()"> 2.0x</label>
                </div>
            </div>

            <div class="row">
                <div class="form-group" style="flex:1;">
                    <label>Base Risk Amount ($)</label>
                    <input type="number" id="riskAmount" value="100" oninput="calculatePositionSize()">
                </div>
                <div class="form-group" style="flex:1;">
                    <label>Buying Power ($)</label>
                    <input type="number" id="accountEquity" readonly>
                </div>
            </div>

            <!-- Dynamic Position Sizing Readout & Shares Field -->
            <div class="summary">
                <div class="row" style="margin-bottom: 8px;">
                    <label style="margin: 0; align-self: center; font-weight: bold; color: #facc15;">Calculated Shares:</label>
                    <input type="number" id="shareInput" value="0" style="width: 120px; font-weight: bold; color: #facc15; font-size: 16px;" readonly>
                </div>
                <span style="font-size: 11px; color:#94a3b8;" id="sizingDetail">Risk per share: $0.00</span>
            </div>

            <div class="row" style="margin-top: 20px;">
                <button id="btnPlaceTradeBuy" class="btn-buy" onclick="handleTradeAction('BUY')">BUY</button>
                <button id="btnPlaceTradeSell" class="btn-sell" onclick="handleTradeAction('SELL')">SELL</button>
            </div>
        </div>

        <script>
            // Global variables expected by trading.js
            var tradeStationToken = null;
            var CONFIG = { ACCOUNT_ID: '' };
            var currentSide = 'BUY';
            var orderType = 'LIMIT';

            // --- Alpaca Config — loaded from server via /api/config (no hardcoded secrets) ---
            const ALPACA_CONFIG = {
                API_KEY:    '',
                API_SECRET: '',
                WS_URL:     'wss://stream.data.alpaca.markets/v2/iex',
                REST_URL:   'https://data.alpaca.markets/v2'
            };

            let alpacaSocket = null;
            let currentSubscribedSymbol = null;
            let currentDayHigh = 0;
            let currentDayLow = 0;
            let isInitialLoad = true;
            let isHlActive = false;
            let snapshotRefreshTimer = null;

            // --- Reset Helper ---
            function resetControlsToDefault() {
                document.getElementById('riskMultDefault').checked = true;
                isHlActive = false;
                const btn = document.getElementById('btnHl');
                if (btn) btn.classList.remove('active');
                setOrderType('LIMIT');
            }

            async function fetchAlpacaSnapshot(symbol) {
                const url = \`\${ALPACA_CONFIG.REST_URL}/stocks/\${symbol}/snapshot\`;
                try {
                    const res = await fetch(url, {
                        headers: {
                            'APCA-API-KEY-ID': ALPACA_CONFIG.API_KEY,
                            'APCA-API-SECRET-KEY': ALPACA_CONFIG.API_SECRET
                        }
                    });
                    const data = await res.json();
                    const currentPrice = data.latestTrade?.p || data.latestQuote?.ap || 0;
                    return {
                        currentPrice: parseFloat(currentPrice),
                        dayHigh: parseFloat(data.dailyBar?.h || currentPrice),
                        dayLow: parseFloat(data.dailyBar?.l || currentPrice)
                    };
                } catch(e) { return null; }
            }

            // Refresh the official daily high/low from Alpaca snapshot every 60 s
            function startSnapshotRefresh(symbol) {
                if (snapshotRefreshTimer) clearInterval(snapshotRefreshTimer);
                snapshotRefreshTimer = setInterval(async () => {
                    const snap = await fetchAlpacaSnapshot(symbol);
                    if (snap) {
                        // Always trust the official bar for high/low
                        if (snap.dayHigh > currentDayHigh) currentDayHigh = snap.dayHigh;
                        if (snap.dayLow  > 0 && (snap.dayLow < currentDayLow || currentDayLow === 0)) currentDayLow = snap.dayLow;
                        document.getElementById('dispHigh').innerText = '$' + currentDayHigh.toFixed(2);
                        document.getElementById('dispLow').innerText  = '$' + currentDayLow.toFixed(2);
                    }
                }, 60000);
            }

            async function connectAlpacaRealtimeWithHighLow(symbol) {
                const formattedSymbol = symbol.toUpperCase();
                isInitialLoad = true;

                resetControlsToDefault();

                // Seed high/low from snapshot immediately
                const snapshot = await fetchAlpacaSnapshot(formattedSymbol);
                if (snapshot) {
                    currentDayHigh = snapshot.dayHigh;
                    currentDayLow  = snapshot.dayLow;
                    updateTickUI(snapshot.currentPrice, currentDayHigh, currentDayLow);
                }

                // Keep high/low current via periodic snapshot re-fetch
                startSnapshotRefresh(formattedSymbol);

                if (alpacaSocket && alpacaSocket.readyState === WebSocket.OPEN) {
                    subscribeAlpacaSymbol(formattedSymbol);
                    return;
                }

                alpacaSocket = new WebSocket(ALPACA_CONFIG.WS_URL);
                alpacaSocket.onopen = () => {
                    alpacaSocket.send(JSON.stringify({ action: 'auth', key: ALPACA_CONFIG.API_KEY, secret: ALPACA_CONFIG.API_SECRET }));
                };

                alpacaSocket.onmessage = (event) => {
                    const messages = JSON.parse(event.data);
                    messages.forEach(msg => {
                        if (msg.T === 'success' && msg.msg === 'authenticated') {
                            subscribeAlpacaSymbol(formattedSymbol);
                        }
                        // Live trade tick — update current price and track intraday extremes
                        if (msg.T === 't' || msg.T === 'q') {
                            const livePrice = parseFloat(msg.p || msg.bp || 0);
                            if (livePrice > 0) {
                                if (livePrice > currentDayHigh) currentDayHigh = livePrice;
                                if (currentDayLow === 0 || livePrice < currentDayLow) currentDayLow = livePrice;
                                updateTickUI(livePrice, currentDayHigh, currentDayLow);
                            }
                        }
                        // Daily bar update — Alpaca pushes 'b' (bar) messages with official OHLC
                        if (msg.T === 'b') {
                            if (msg.h && msg.h > currentDayHigh) {
                                currentDayHigh = parseFloat(msg.h);
                                document.getElementById('dispHigh').innerText = '$' + currentDayHigh.toFixed(2);
                            }
                            if (msg.l && (currentDayLow === 0 || parseFloat(msg.l) < currentDayLow)) {
                                currentDayLow = parseFloat(msg.l);
                                document.getElementById('dispLow').innerText = '$' + currentDayLow.toFixed(2);
                            }
                        }
                    });
                };
            }

            function subscribeAlpacaSymbol(newSymbol) {
                if (currentSubscribedSymbol) {
                    alpacaSocket.send(JSON.stringify({ action: 'unsubscribe', quotes: [currentSubscribedSymbol], bars: [currentSubscribedSymbol] }));
                }
                // Subscribe to both quotes (for live price) and bars (for official H/L updates)
                alpacaSocket.send(JSON.stringify({ action: 'subscribe', quotes: [newSymbol], bars: [newSymbol] }));
                currentSubscribedSymbol = newSymbol;
            }

            function updateTickUI(price, high, low) {
                document.getElementById('dispPrice').innerText = '$' + price.toFixed(2);
                document.getElementById('dispHigh').innerText = '$' + high.toFixed(2);
                document.getElementById('dispLow').innerText = '$' + low.toFixed(2);

                if (isInitialLoad && price > 0) {
                    if (isHlActive) {
                        applyHighLowValues();
                    } else {
                        document.getElementById('entryPrice').value = price.toFixed(2);
                        document.getElementById('stopLoss').value = low.toFixed(2);
                    }
                    isInitialLoad = false;
                    updateTakeProfit();
                    calculatePositionSize();
                }
            }

            // --- Slide Selector Control ---
            function setOrderType(type) {
                orderType = type;
                const optLimit = document.getElementById('optLimit');
                const optStop = document.getElementById('optStop');
                const glider = document.getElementById('slideGlider');

                if (type === 'STOP') {
                    optLimit.classList.remove('active');
                    optStop.classList.add('active');
                    glider.classList.add('stop-pos');
                } else {
                    optStop.classList.remove('active');
                    optLimit.classList.add('active');
                    glider.classList.remove('stop-pos');
                }
                calculatePositionSize();
            }

            function toggleOrderTypeSlide() {
                const newType = orderType === 'LIMIT' ? 'STOP' : 'LIMIT';
                setOrderType(newType);
            }

            // --- Toggle H/L Logic ---
            function applyHighLowValues() {
                setOrderType('STOP');
                document.getElementById('entryPrice').value = currentDayHigh.toFixed(2);
                document.getElementById('stopLoss').value = currentDayLow.toFixed(2);
            }

            function toggleHighLowPreset() {
                isHlActive = !isHlActive;
                const btn = document.getElementById('btnHl');

                if (isHlActive) {
                    btn.classList.add('active');
                    applyHighLowValues();
                } else {
                    btn.classList.remove('active');
                    setOrderType('LIMIT');
                    const currPrice = parseFloat(document.getElementById('dispPrice').innerText.replace('$', '')) || 0;
                    if (currPrice > 0) {
                        document.getElementById('entryPrice').value = currPrice.toFixed(2);
                        document.getElementById('stopLoss').value = currentDayLow.toFixed(2);
                    }
                }
                onEntryOrStopChange();
            }

            // --- Calculation Functions ---
            function updateTakeProfit() {
                const entry = parseFloat(document.getElementById('entryPrice').value) || 0;
                const stop = parseFloat(document.getElementById('stopLoss').value) || 0;

                const target = (2 * entry) - stop;
                document.getElementById('takeProfit').value = target > 0 ? target.toFixed(2) : '0.00';
            }

            function onEntryOrStopChange() {
                updateTakeProfit();
                calculatePositionSize();
            }

            function getSelectedMultiplier() {
                const radios = document.getElementsByName('riskMult');
                for (let r of radios) {
                    if (r.checked) return parseFloat(r.value);
                }
                return 1.0;
            }


            function calculatePositionSize() {
                const entry = parseFloat(document.getElementById('entryPrice').value) || 0;
                const stop = parseFloat(document.getElementById('stopLoss').value) || 0;
                const baseRisk = parseFloat(document.getElementById('riskAmount').value) || 0;
                const equity = parseFloat(document.getElementById('accountEquity').value) || 0;
                const multiplier = getSelectedMultiplier();

                const effectiveRisk = baseRisk * multiplier;
                const riskPerShare = Math.abs(entry - stop);

                if (riskPerShare <= 0 || effectiveRisk <= 0 || entry <= 0) {
                    document.getElementById('shareInput').value = 0;
                    document.getElementById('sizingDetail').innerText = 'Invalid Price or Risk parameters';
                    return;
                }

                let shares = Math.floor(effectiveRisk / riskPerShare);
                const maxEquityShares = Math.floor(equity / entry);

                if (shares > maxEquityShares) {
                    shares = maxEquityShares;
                    document.getElementById('sizingDetail').innerText = \`Capped by Buying Power limit (\$\${equity.toFixed(2)}) | Effective Risk: \$\${effectiveRisk.toFixed(2)}\`;
                } else {
                    document.getElementById('sizingDetail').innerText = \`Risk/Share: \$\${riskPerShare.toFixed(2)} | Total Target Risk: \$\${effectiveRisk.toFixed(2)}\`;
                }

                document.getElementById('shareInput').value = shares;
            }

            function changeSymbol() {
                const sym = document.getElementById('tickerInput').value.trim();
                if (sym) connectAlpacaRealtimeWithHighLow(sym);
            }

            async function loadAccountEquity() {
                const res = await fetch('/api/equity');
                const data = await res.json();
                document.getElementById('accountEquity').value = data.buyingPower;
                calculatePositionSize();
            }

            // Handler called on BUY or SELL button click
            async function handleTradeAction(side) {
                currentSide = side;
                if (typeof executeOrder === 'function') {
                    await executeOrder();
                } else {
                    alert('[SIMULATED] Executing ' + side + ' Order');
                }
            }

            // Initialization — token management is handled by initClientToken() in trading.js
            window.onload = async () => {
                // Load Alpaca keys from server (kept in .env, never hardcoded)
                try {
                    const cfgRes = await fetch('/api/config');
                    const cfg = await cfgRes.json();
                    ALPACA_CONFIG.API_KEY    = cfg.alpacaApiKey    || '';
                    ALPACA_CONFIG.API_SECRET = cfg.alpacaApiSecret || '';
                } catch(e) {
                    console.error('Failed to load Alpaca config', e);
                }

                await initClientToken();   // sets tradeStationToken + schedules auto-refresh
                await loadAccountEquity();
                changeSymbol();
            };
        </script>
    </body>
    </html>
    `);
});
// -------------------------------------------------------------------
// ROUTE: INCOMING TRADE MODAL TRIGGER
// -------------------------------------------------------------------
app.post('/api/trade-modal', async (req, res) => {
    // 1. Check Authentication
    if (!tokens.accessToken) {
        return res.status(401).json({ error: 'TradeStation not authenticated on server.' });
    }

    // 2. Extract Body Parameters
    const { Symbol, EntryPrice, StopLoss } = req.body;

    if (!Symbol || !EntryPrice || !StopLoss) {
        return res.status(400).json({ error: 'Missing required parameters: Symbol, EntryPrice, or StopLoss.' });
    }

    // 3. Compute Default Take Profit (2:1 Ratio matching frontend logic)
    const entry = parseFloat(EntryPrice);
    const stop = parseFloat(StopLoss);
    const profitTarget = (2 * entry) - stop;

    // 4. Construct OSO Order Payload
    const payload = {
        Type: "OSO",
        AccountID: process.env.ACCOUNT_ID,
        Symbol: Symbol.toUpperCase(),
        Quantity: "100", // Set or compute your target share quantity
        OrderType: "Limit",
        TradeAction: "BUY",
        LimitPrice: entry.toFixed(2),
        Route: "Intelligent",
        TimeInForce: { Duration: "DAY" },
        OSOs: [
            {
                Type: "BRK",
                Orders: [
                    {
                        AccountID: process.env.ACCOUNT_ID,
                        Symbol: Symbol.toUpperCase(),
                        Quantity: "100",
                        OrderType: "Limit",
                        TradeAction: "SELL",
                        LimitPrice: profitTarget.toFixed(2),
                        Route: "Intelligent",
                        TimeInForce: { Duration: "DAY" }
                    },
                    {
                        AccountID: process.env.ACCOUNT_ID,
                        Symbol: Symbol.toUpperCase(),
                        Quantity: "100",
                        OrderType: "StopMarket",
                        TradeAction: "SELL",
                        StopPrice: stop.toFixed(2),
                        Route: "Intelligent",
                        TimeInForce: { Duration: "DAY" }
                    }
                ]
            }
        ]
    };

    // 5. Send Order directly to TradeStation
    try {
        const response = await axios.post(
            'https://api.tradestation.com/v3/orderexecution/orders',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${tokens.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return res.json({ success: true, data: response.data });
    } catch (err) {
        console.error('[API TRADE ERROR]:', err.response?.data || err.message);
        return res.status(500).json({
            error: 'Order execution failed',
            details: err.response?.data || err.message
        });
    }
});

// Start Express and initialize tokens
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\nServer running on http://localhost:${PORT}`);
    await initializeTokensOnLaunch();
});
