const fs = require('fs');
const path = require('path');

// 1. Get log file path from CLI argument or default
const logFileName = process.argv[2] || 'order-response-2026-09-18T13-39-43-980Z.txt';
const logPath = path.resolve(logFileName);

if (!fs.existsSync(logPath)) {
    console.error(`❌ Error: File not found at '${logPath}'`);
    process.exit(1);
}

const logContent = fs.readFileSync(logPath, 'utf8');

// 2. Extract balanced JSON blocks safely
function extractJsonBlocks(text) {
    const blocks = [];
    const jsonRegex = /\{[\s\S]*?\}(?=\s*(\r?\n[A-Z]|\r?\n=|$))/g;
    let match;
    while ((match = jsonRegex.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[0]);
            blocks.push(parsed);
        } catch (e) {
            // keep looking if partial match failed
        }
    }
    return blocks;
}

const parsedBlocks = extractJsonBlocks(logContent);

if (parsedBlocks.length < 2) {
    console.error("❌ Failed to isolate both Submitted Payload and TradeStation Response JSON blocks.");
    process.exit(1);
}

const payload = parsedBlocks[0];
const responseData = parsedBlocks[1];

// 3. Extract target prices from submission payload
const tradeAction = payload.TradeAction?.toUpperCase() || 'BUY';
const isLong = tradeAction === 'BUY';
const isStopOrder = payload.OrderType === 'StopMarket';

const entryPrice = parseFloat(isStopOrder ? payload.StopPrice : payload.LimitPrice);
const stopLoss = parseFloat(payload.OSOs?.[0]?.Orders?.find(o => o.OrderType === 'StopMarket')?.StopPrice || 0);
const profitTarget = parseFloat(payload.OSOs?.[0]?.Orders?.find(o => o.OrderType === 'Limit')?.LimitPrice || 0);

console.log(`\n📄 Processing File: ${path.basename(logPath)}`);
console.log("=== SUBMITTED TARGET PRICES ===");
console.log(`Trade Direction:          ${isLong ? 'LONG (BUY)' : 'SHORT (SELLSHORT)'}`);
console.log(`Entry Target Price:       $${entryPrice.toFixed(2)}`);
console.log(`Stop Loss Target Price:   $${stopLoss.toFixed(2)}`);
console.log(`Take Profit Target Price: $${profitTarget.toFixed(2)}\n`);

// 4. PRICE DIRECTION VALIDATION
console.log("=== PRICE RELATIONSHIP VALIDATION ===");
let pricesValid = false;

if (isLong) {
    // For LONG: Take Profit > Entry > Stop Loss
    pricesValid = (profitTarget > entryPrice) && (entryPrice > stopLoss);
    console.log(`Checking (Take Profit > Entry > Stop Loss): ${profitTarget} > ${entryPrice} > ${stopLoss}`);
} else {
    // For SHORT: Take Profit < Entry < Stop Loss
    pricesValid = (profitTarget < entryPrice) && (entryPrice < stopLoss);
    console.log(`Checking (Take Profit < Entry < Stop Loss): ${profitTarget} < ${entryPrice} < ${stopLoss}`);
}

if (pricesValid) {
    console.log("✅ Price relationship check PASSED.\n");
} else {
    console.log("⚠️ WARNING: Price relationship check FAILED! Inspect target inputs.\n");
}

// 5. Helper function to extract numerical price from object or text Message
function getOrderPriceFromObject(o) {
    if (!o) return 0;
    if (o.LimitPrice || o.StopPrice) {
        return parseFloat(o.LimitPrice || o.StopPrice);
    }
    if (o.Message) {
        const match = o.Message.match(/@\s*([\d.]+)/);
        if (match) return parseFloat(match[1]);
    }
    return 0;
}

// 6. Match legs from TradeStation order response list
const orderList = responseData.Orders || [];

const entryLeg = orderList.find(o => Math.abs(getOrderPriceFromObject(o) - entryPrice) < 0.005);
const slLeg    = orderList.find(o => Math.abs(getOrderPriceFromObject(o) - stopLoss) < 0.005);
const tpLeg    = orderList.find(o => Math.abs(getOrderPriceFromObject(o) - profitTarget) < 0.005);

const primaryOrderId = entryLeg?.OrderID || null;
const stopOrderId    = slLeg?.OrderID || null;
const tpOrderId      = tpLeg?.OrderID || null;

// 7. Output Extracted Order IDs and Details
console.log("=== EXTRACTED ORDER ROLES & IDs ===");
console.log(`📥 ENTRY ORDER:       ID = ${primaryOrderId} | Price = $${getOrderPriceFromObject(entryLeg).toFixed(2)} | Message = "${entryLeg?.Message || 'N/A'}"`);
console.log(`🛑 STOP LOSS ORDER:   ID = ${stopOrderId}    | Price = $${getOrderPriceFromObject(slLeg).toFixed(2)} | Message = "${slLeg?.Message || 'N/A'}"`);
console.log(`🎯 TAKE PROFIT ORDER: ID = ${tpOrderId}    | Price = $${getOrderPriceFromObject(tpLeg).toFixed(2)} | Message = "${tpLeg?.Message || 'N/A'}"\n`);
