// --- Alpaca API Config ---
export const ALPACA_CONFIG = {
    API_KEY: 'PKDB252AMB24ONWEO37E67MQH7',
    API_SECRET: '8pyXTnSwwMrh2j3dSc8WaxmXJesm1SC7kkF2CrD8hxfu',
    // Use 'iex' for free real-time data, or 'sip' for full paid feed
    WS_URL: 'wss://stream.data.alpaca.markets/v2/iex',
    REST_URL: 'https://data.alpaca.markets/v2'
};

let alpacaSocket = null;
let currentSubscribedSymbol = null;
let currentDayHigh = 0;
let currentDayLow = 0;

/**
 * Initializes a real-time WebSocket connection to Alpaca
 * @param {string} symbol - Ticker symbol (e.g., 'AAPL')
 * @param {function} onQuoteUpdate - Callback function when a quote arrives
 */
window.connectAlpacaRealtimeQuotes = function(symbol, onQuoteUpdate) {
    const formattedSymbol = symbol.toUpperCase();

    // If socket is already open, just switch the subscription
    if (alpacaSocket && alpacaSocket.readyState === WebSocket.OPEN) {
        subscribeAlpacaSymbol(formattedSymbol);
        return;
    }

    alpacaSocket = new WebSocket(ALPACA_CONFIG.WS_URL);

    alpacaSocket.onopen = () => {
        console.log("Alpaca WebSocket connected. Authenticating...");
        
        // 1. Authenticate with Alpaca
        const authPayload = {
            action: 'auth',
            key: ALPACA_CONFIG.API_KEY,
            secret: ALPACA_CONFIG.API_SECRET
        };
        alpacaSocket.send(JSON.stringify(authPayload));
    };

    alpacaSocket.onmessage = (event) => {
        const messages = JSON.parse(event.data);

        messages.forEach(msg => {
            // Handle Auth Response
            if (msg.T === 'success' && msg.msg === 'authenticated') {
                console.log("Alpaca WebSocket authenticated successfully.");
                subscribeAlpacaSymbol(formattedSymbol);
            }

            // Handle Real-Time Quote / Trade Stream
            // 'q' = Quote (bid/ask), 't' = Trade (last sale)
            if (msg.T === 'q' || msg.T === 't') {
                const quoteData = {
                    symbol: msg.S,
                    price: msg.p || msg.bp || 0, // Last trade price or Bid price
                    bid: msg.bp || 0,
                    ask: msg.ap || 0,
                    timestamp: msg.t
                };

                if (typeof onQuoteUpdate === 'function') {
                    onQuoteUpdate(quoteData);
                }
            }
        });
    };

    alpacaSocket.onerror = (error) => {
        console.error("Alpaca WebSocket Error:", error);
    };

    alpacaSocket.onclose = () => {
        console.warn("Alpaca WebSocket closed. Attempting reconnect in 3s...");
        setTimeout(() => connectAlpacaRealtimeQuotes(symbol, onQuoteUpdate), 3000);
    };
}

/**
 * Updates the active subscribed ticker symbol on the socket
 */
window.subscribeAlpacaSymbol = function(newSymbol) {
    if (!alpacaSocket || alpacaSocket.readyState !== WebSocket.OPEN) return;

    const unsubscribePayload = { action: 'unsubscribe', quotes: [currentSubscribedSymbol] };
    const subscribePayload = { action: 'subscribe', quotes: [newSymbol] };

    if (currentSubscribedSymbol) {
        alpacaSocket.send(JSON.stringify(unsubscribePayload));
    }

    alpacaSocket.send(JSON.stringify(subscribePayload));
    currentSubscribedSymbol = newSymbol;
    console.log(`Subscribed to real-time quotes for: ${newSymbol}`);
}

/**
 * Fetches initial price snapshot including Current Price, Day High, and Day Low
 * @param {string} symbol - Stock ticker symbol
 */
window.fetchAlpacaSnapshot = function(symbol) {
    const formattedSymbol = symbol.toUpperCase();
    const url = `${ALPACA_CONFIG.REST_URL}/stocks/${formattedSymbol}/snapshot`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'APCA-API-KEY-ID': ALPACA_CONFIG.API_KEY,
                'APCA-API-SECRET-KEY': ALPACA_CONFIG.API_SECRET,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Alpaca API Error: ${response.statusText}`);
        }

        const data = await response.json();

        // Extract metrics safely
        const currentPrice = data.latestTrade?.p || data.latestQuote?.ap || 0;
        const dayHigh = data.dailyBar?.h || currentPrice;
        const dayLow = data.dailyBar?.l || currentPrice;

        return {
            symbol: formattedSymbol,
            currentPrice: parseFloat(currentPrice),
            dayHigh: parseFloat(dayHigh),
            dayLow: parseFloat(dayLow)
        };
    } catch (err) {
        console.error("Failed to fetch Alpaca Snapshot:", err);
        return null;
    }
}


/**
 * Initializes Alpaca WebSocket real-time quotes + dynamic Day High/Low tracking
 */
window.connectAlpacaRealtimeWithHighLow = function(symbol, onTickUpdate) {
    const formattedSymbol = symbol.toUpperCase();

    // Step 1: Initialize baseline Day High/Low using Snapshot REST API
    const initialSnapshot = await fetchAlpacaSnapshot(formattedSymbol);
    if (initialSnapshot) {
        currentDayHigh = initialSnapshot.dayHigh;
        currentDayLow = initialSnapshot.dayLow;

        // Pass initial values back immediately
        onTickUpdate({
            price: initialSnapshot.currentPrice,
            dayHigh: currentDayHigh,
            dayLow: currentDayLow
        });
    }

    // Step 2: Connect WebSocket for real-time trade ticks
    if (alpacaSocket && alpacaSocket.readyState === WebSocket.OPEN) {
        subscribeAlpacaSymbol(formattedSymbol);
        return;
    }

    alpacaSocket = new WebSocket(ALPACA_CONFIG.WS_URL);

    alpacaSocket.onopen = () => {
        alpacaSocket.send(JSON.stringify({
            action: 'auth',
            key: ALPACA_CONFIG.API_KEY,
            secret: ALPACA_CONFIG.API_SECRET
        }));
    };

    alpacaSocket.onmessage = (event) => {
        const messages = JSON.parse(event.data);

        messages.forEach(msg => {
            if (msg.T === 'success' && msg.msg === 'authenticated') {
                subscribeAlpacaSymbol(formattedSymbol);
            }

            // Real-time Trade Tick ('t') or Quote ('q')
            if (msg.T === 't' || msg.T === 'q') {
                const livePrice = parseFloat(msg.p || msg.bp || 0);

                if (livePrice > 0) {
                    // Dynamically expand Day High / Day Low if live price breaks them
                    if (livePrice > currentDayHigh || currentDayHigh === 0) currentDayHigh = livePrice;
                    if (livePrice < currentDayLow || currentDayLow === 0) currentDayLow = livePrice;

                    onTickUpdate({
                        price: livePrice,
                        dayHigh: currentDayHigh,
                        dayLow: currentDayLow
                    });
                }
            }
        });
    };

    alpacaSocket.onerror = (err) => console.error("Alpaca WS Error:", err);
}
