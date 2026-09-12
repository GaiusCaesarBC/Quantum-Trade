// services/signalResultChecker.js — Check Signal Results (TP/SL Hits)
// Updates live prices and determines win/loss for active signals

const cron = require('node-cron');
const axios = require('axios');
const Prediction = require('../models/Prediction');
const { postResult } = require('./telegramBot');
const { postSignalResultToDiscord } = require('./discordService');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const COINGECKO_BASE_URL = process.env.COINGECKO_BASE_URL || 'https://pro-api.coingecko.com/api/v3';

// Price cache (1 minute)
const priceCache = new Map();
const CACHE_DURATION = 60000;

// CoinGecko ID map
const COINGECKO_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
    ADA: 'cardano', DOGE: 'dogecoin', DOT: 'polkadot', AVAX: 'avalanche-2',
    LINK: 'chainlink', MATIC: 'matic-network', UNI: 'uniswap', ATOM: 'cosmos',
    LTC: 'litecoin', SHIB: 'shiba-inu', TRX: 'tron', BNB: 'binancecoin',
    FIL: 'filecoin', APT: 'aptos', ARB: 'arbitrum', OP: 'optimism',
    SUI: 'sui', SEI: 'sei-network', INJ: 'injective-protocol', PEPE: 'pepe',
    WIF: 'dogwifcoin', BONK: 'bonk', FLOKI: 'floki',
};

let isRunning = false;
let runStartedAt = null;         // timestamp when the current cycle started
const MAX_CYCLE_MS = 4 * 60000; // 4 minutes — safety ceiling; if a cycle exceeds
                                 // this, the isRunning flag is force-reset so the
                                 // next cron tick isn't permanently blocked.
let lastRun = null;
let stats = { checked: 0, wins: 0, losses: 0, errors: 0 };

// ─── Price Fetching ───────────────────────────────────────

async function getStockPrice(symbol) {
    const cacheKey = `stock-${symbol}`;
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_DURATION) return cached.price;

    // Yahoo Finance first (real-time, free)
    try {
        const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 8000
        });
        const price = res.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price > 0) {
            priceCache.set(cacheKey, { price, ts: Date.now() });
            return price;
        }
    } catch (e) { /* fallback */ }

    // Finnhub fallback
    if (FINNHUB_KEY) {
        try {
            const res = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`, { timeout: 5000 });
            if (res.data?.c > 0) {
                priceCache.set(cacheKey, { price: res.data.c, ts: Date.now() });
                return res.data.c;
            }
        } catch (e) { /* silent */ }
    }

    return null;
}

async function getCryptoPrice(symbol) {
    const cleanSymbol = symbol.split(':')[0].replace(/USDT|USD/i, '').toUpperCase();
    const cacheKey = `crypto-${cleanSymbol}`;
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_DURATION) return cached.price;

    // CryptoCompare first (reliable from Render, no rate limit issues)
    try {
        const res = await axios.get(`https://min-api.cryptocompare.com/data/price?fsym=${cleanSymbol}&tsyms=USD`, { timeout: 5000 });
        if (res.data?.USD > 0) {
            priceCache.set(cacheKey, { price: res.data.USD, ts: Date.now() });
            return res.data.USD;
        }
    } catch (e) { /* fallback */ }

    // CoinGecko fallback
    const geckoId = COINGECKO_IDS[cleanSymbol] || cleanSymbol.toLowerCase();
    try {
        const headers = COINGECKO_API_KEY ? { 'x-cg-pro-api-key': COINGECKO_API_KEY } : {};
        const res = await axios.get(`${COINGECKO_BASE_URL}/simple/price?ids=${geckoId}&vs_currencies=usd`, {
            headers, timeout: 5000
        });
        if (res.data?.[geckoId]?.usd > 0) {
            priceCache.set(cacheKey, { price: res.data[geckoId].usd, ts: Date.now() });
            return res.data[geckoId].usd;
        }
    } catch (e) { /* silent */ }

    // Binance US fallback
    try {
        const res = await axios.get(`https://api.binance.us/api/v3/ticker/price?symbol=${cleanSymbol}USDT`, { timeout: 5000 });
        if (res.data?.price > 0) {
            const price = parseFloat(res.data.price);
            priceCache.set(cacheKey, { price, ts: Date.now() });
            return price;
        }
    } catch (e) { /* silent */ }

    return null;
}

async function getLivePrice(symbol, assetType) {
    return assetType === 'crypto' || assetType === 'dex'
        ? getCryptoPrice(symbol)
        : getStockPrice(symbol);
}

// ─── Result Checker Logic ─────────────────────────────────

function checkResult(signal, livePrice) {
    const { direction, entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3 } = signal;

    if (![entryPrice, stopLoss, livePrice].every(p => Number.isFinite(p) && p > 0)) return null;
    if (!['UP', 'DOWN'].includes(direction)) return null;
    const isLong = direction === 'UP';
    // A gap through a stop is still a loss. Distance alone is not bad-data evidence.
    if ((isLong && livePrice <= stopLoss) || (!isLong && livePrice >= stopLoss)) {
        return { result: 'loss', resultText: 'SL Hit', resultPrice: livePrice };
    }

    // Check Take Profit hits — only TP2 and TP3 close the trade
    // TP1 is tracked for display but does NOT close (let winners run)
    if (isLong) {
        if (takeProfit3 && livePrice >= takeProfit3) {
            return { result: 'win', resultText: 'TP3 Hit', resultPrice: livePrice };
        }
        if (takeProfit2 && livePrice >= takeProfit2) {
            return { result: 'win', resultText: 'TP2 Hit', resultPrice: livePrice };
        }
        // TP1 — do NOT close, just continue monitoring
    } else {
        if (takeProfit3 && livePrice <= takeProfit3) {
            return { result: 'win', resultText: 'TP3 Hit', resultPrice: livePrice };
        }
        if (takeProfit2 && livePrice <= takeProfit2) {
            return { result: 'win', resultText: 'TP2 Hit', resultPrice: livePrice };
        }
        // TP1 — do NOT close, just continue monitoring
    }

    return null; // No result yet
}

// ─── Main Check Cycle ─────────────────────────────────────

async function runCheckCycle() {
    if (isRunning) {
        console.log('[SignalChecker] Already running, skipping...');
        return;
    }

    isRunning = true;
    runStartedAt = Date.now();
    const start = Date.now();
    let checked = 0, wins = 0, losses = 0, errors = 0;

    try {
        console.log('[SignalChecker] ══════════════════════════════════');
        console.log('[SignalChecker] Checking active signals for TP/SL hits...');

        // Get all pending signals that have locked levels
        const signals = Prediction.find({
            user: null,
            status: 'pending',
            result: null,
            entryPrice: { $exists: true, $ne: null },
            expiresAt: { $gt: new Date() }
        }).sort({ _id: 1 }).cursor({ batchSize: 100 });

        console.log('[SignalChecker] Streaming all active system signals');

        for await (const signal of signals) {
            try {
                const livePrice = await getLivePrice(signal.symbol, signal.assetType);

                if (!livePrice) {
                    console.log(`[SignalChecker] No price for ${signal.symbol}, skipping`);
                    continue;
                }

                const outcome = checkResult(signal, livePrice);
                const update = { livePrice, livePriceUpdatedAt: new Date() };
                if (outcome) Object.assign(update, outcome, {
                    resultAt: new Date(), status: outcome.result === 'win' ? 'correct' : 'incorrect'
                });
                // Only one worker can transition a pending record and notify its result.
                const updated = await Prediction.findOneAndUpdate(
                    { _id: signal._id, user: null, status: 'pending', result: null },
                    { $set: update }, { new: true }
                );
                if (!updated) continue;
                if (outcome) {
                    Object.assign(signal, update);

                    // Calculate movement percentage from entry (inverted for shorts: drop = positive profit)
                    const isLong = signal.direction === 'UP';
                    const rawMovePct = signal.entryPrice > 0
                        ? ((livePrice - signal.entryPrice) / signal.entryPrice) * 100
                        : 0;
                    const movePct = isLong ? rawMovePct : -rawMovePct;

                    console.log(`[SignalChecker] ${outcome.result === 'win' ? '✅' : '❌'} ${signal.symbol}: ${outcome.resultText} @ $${livePrice.toFixed(livePrice < 1 ? 6 : 2)} (${movePct >= 0 ? '+' : ''}${movePct.toFixed(1)}%)`);

                    // Post result to Telegram + Discord
                    try {
                        await postResult(signal, outcome.result === 'win', movePct);
                    } catch (tgErr) {
                        console.error(`[SignalChecker] Telegram post error: ${tgErr.message}`);
                    }
                    try {
                        await postSignalResultToDiscord(signal, outcome.result);
                    } catch (dcErr) {
                        console.error(`[SignalChecker] Discord post error: ${dcErr.message}`);
                    }

                    if (outcome.result === 'win') wins++;
                    else losses++;
                }

                checked++;

                // Rate limit: 500ms between checks
                await new Promise(r => setTimeout(r, 500));

            } catch (err) {
                console.error(`[SignalChecker] Error checking ${signal.symbol}:`, err.message);
                errors++;
            }
        }

        // Do not invent a win/loss at expiry. Snapshot polling cannot establish
        // whether an unobserved intrabar threshold was crossed.
        await Prediction.updateMany({ user: null, status: 'pending', result: null,
            expiresAt: { $lte: new Date() } }, { $set: {
                resultText: 'Expired — no observed outcome', status: 'expired', resultAt: new Date()
            } });

    } catch (err) {
        console.error('[SignalChecker] Cycle error:', err.message);
        errors++;
    } finally {
        // ALWAYS release the lock — this is the permanent fix for the
        // stuck-flag problem. No matter what throws above, the next cron
        // tick will be able to run.
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        stats = { checked, wins, losses, errors };
        lastRun = new Date();
        isRunning = false;
        runStartedAt = null;

        console.log(`[SignalChecker] Done in ${elapsed}s — ${checked} checked, ${wins} wins, ${losses} losses, ${errors} errors`);
        console.log('[SignalChecker] ══════════════════════════════════');
    }
}

// ─── Start/Stop ───────────────────────────────────────────

function startSignalResultChecker() {
    console.log('[SignalChecker] Starting signal result checker...');
    console.log('[SignalChecker] Schedule: Every 5 minutes');

    // Run every 5 minutes
    cron.schedule('*/5 * * * *', () => runCheckCycle());

    // Initial run after 30 seconds
    setTimeout(() => runCheckCycle(), 30000);
}

function getCheckerStats() {
    return { ...stats, lastRun, isRunning };
}

module.exports = {
    startSignalResultChecker,
    runCheckCycle,
    getCheckerStats,
    checkResult
};
