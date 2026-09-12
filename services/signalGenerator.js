// services/signalGenerator.js — Automated Signal Generator
// Uses smart asset discovery pipeline, then runs ML/indicator analysis.

const cron = require('node-cron');
const axios = require('axios');
const Prediction = require('../models/Prediction');
const { discoverAssets } = require('./assetDiscovery');
const { postSignalTeaser } = require('./telegramBot');
const { postNewSignal: postSignalToX } = require('./xPosterService');
const NotificationService = require('./notificationService');
const { postNewSignalToDiscord } = require('./discordService');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:5001';
const ML_API_KEY = process.env.ML_API_KEY;
const ML_HEADERS = ML_API_KEY ? { 'X-API-Key': ML_API_KEY } : {};
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

// ─── Quality gates ────────────────────────────────────────
// Tightened after a losing streak dropped win rate from 54% → 48%.
// Each gate independently rejects garbage signals before they get published.
const MIN_CONFIDENCE = 70;          // Raised from 55. Below this, the signal is ~coin-flip.
const MIN_PCT_MAGNITUDE = 2.5;      // Predicted move must be >= 2.5%; below this is noise.
const NOTIFY_CONFIDENCE = 78;       // Only blast Telegram/Discord/X above this threshold.
const COOLDOWN_LOSS_STREAK = 3;     // After this many losses in a row on a symbol, cool it off.
const COOLDOWN_WINDOW_DAYS = 7;     // Loss streak is measured over this window.
const COOLDOWN_DURATION_HOURS = 48; // How long to skip the symbol after triggering cooldown.

let isRunning = false;
let runStartedAt = null;
const MAX_CYCLE_MS = 10 * 60000; // 10 min safety ceiling for signal generation
let lastRun = null;
let stats = { totalGenerated: 0, totalSkipped: 0, lastCycleGenerated: 0, errors: 0 };

// ─── Price fetching ───────────────────────────────────────

async function getStockPrice(symbol) {
    // Finnhub (fast, have key)
    if (FINNHUB_KEY) {
        try {
            const res = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`, { timeout: 5000 });
            if (res.data?.c > 0) return res.data.c;
        } catch (e) { /* next */ }
    }
    // Yahoo fallback
    try {
        const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, { timeout: 8000 });
        const p = res.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (p > 0) return p;
    } catch (e) { /* silent */ }
    return null;
}

async function getCryptoPrice(symbol, prefetchedPrice) {
    // Use prefetched price from CoinGecko markets endpoint if available
    if (prefetchedPrice && prefetchedPrice > 0) return prefetchedPrice;

    // CryptoCompare fallback
    try {
        const res = await axios.get(`https://min-api.cryptocompare.com/data/price?fsym=${symbol}&tsyms=USD`, { timeout: 5000 });
        if (res.data?.USD > 0) return res.data.USD;
    } catch (e) { /* silent */ }
    return null;
}

// ─── ML + indicator generation ────────────────────────────

async function getMLPrediction(symbol, type, days) {
    try {
        const url = `${ML_SERVICE_URL}/predict`;
        const res = await axios.post(url, { symbol, days, type }, {
            headers: { ...ML_HEADERS, 'Content-Type': 'application/json' }, timeout: 30000
        });
        if (res.data?.prediction) return res.data;
        console.log(`[SignalGen] ML returned no prediction for ${symbol}:`, JSON.stringify(res.data).slice(0, 200));
    } catch (e) {
        console.error(`[SignalGen] ML call failed for ${symbol}: ${e.message} (URL: ${ML_SERVICE_URL})`);
    }
    return null;
}

// ─── Process single asset ─────────────────────────────────

async function processAsset(symbol, assetType, prefetchedPrice = null) {
    try {
        // Skip if a RECENT system signal exists (< 24h old)
        // Older signals are allowed to be refreshed with new analysis
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentExisting = await Prediction.findOne({
            symbol, status: 'pending', user: null,
            createdAt: { $gt: oneDayAgo }
        });
        if (recentExisting) return { status: 'skipped', reason: 'recent signal exists' };

        // ── COOLDOWN: skip symbols on a losing streak ─────────
        // If the last N closed signals on this symbol were all losses within
        // the cooldown window, and the most recent loss was inside the cooldown
        // duration, skip this symbol entirely. Prevents doubling down.
        const cooldownWindowAgo = new Date(Date.now() - COOLDOWN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const recentClosed = await Prediction.find({
            symbol, user: null,
            result: { $in: ['win', 'loss'] },
            resultAt: { $gt: cooldownWindowAgo }
        }).sort({ resultAt: -1 }).limit(COOLDOWN_LOSS_STREAK);
        if (recentClosed.length >= COOLDOWN_LOSS_STREAK && recentClosed.every(r => r.result === 'loss')) {
            const lastLossAt = recentClosed[0].resultAt;
            const cooldownExpires = new Date(lastLossAt.getTime() + COOLDOWN_DURATION_HOURS * 60 * 60 * 1000);
            if (Date.now() < cooldownExpires.getTime()) {
                return { status: 'skipped', reason: `cooldown (${COOLDOWN_LOSS_STREAK} losses in a row)` };
            }
        }

        // Get price
        const price = assetType === 'crypto'
            ? await getCryptoPrice(symbol, prefetchedPrice)
            : await getStockPrice(symbol);

        if (!price || price <= 0) return { status: 'skipped', reason: 'no price' };

        // ML prediction — 7-day horizon to match trained models
        // (signals still expire in 7 days, giving the prediction time to play out)
        const days = 7;
        let direction, targetPrice, confidence, indicators, analysis;

        const ml = await getMLPrediction(symbol, assetType, days);
        if (ml?.prediction && ml.prediction_method !== 'rule_based') {
            const p = ml.prediction;
            const mlConf = p.confidence || 0;
            const pctChange = p.price_change_percent || 0;

            // ── GATE: NEUTRAL means the model is unsure → skip ──
            // The previous code juiced NEUTRAL signals with +10 confidence which
            // was a major source of bad signals. If the model says it doesn't
            // know, we don't publish.
            if (!p.direction || p.direction === 'NEUTRAL') {
                return { status: 'skipped', reason: 'ml direction NEUTRAL' };
            }

            direction = p.direction;
            targetPrice = p.target_price || p.targetPrice;
            confidence = mlConf;

            // ── GATE: target must agree with direction ──
            // If ML says UP but the target price is below current (or DOWN with
            // target above), the model is contradicting itself — skip.
            if (direction === 'UP' && targetPrice <= price) {
                return { status: 'skipped', reason: 'direction/target contradiction' };
            }
            if (direction === 'DOWN' && targetPrice >= price) {
                return { status: 'skipped', reason: 'direction/target contradiction' };
            }

            // ── GATE: predicted move must be meaningful ──
            // A 0.3% predicted move with a 5% stop is just trading noise. Require
            // the model to forecast at least MIN_PCT_MAGNITUDE% movement.
            if (Math.abs(pctChange) < MIN_PCT_MAGNITUDE) {
                return { status: 'skipped', reason: `low magnitude (${pctChange.toFixed(1)}%)` };
            }

            indicators = ml.indicators || {};
            if (!Object.keys(indicators).length) return { status: 'skipped', reason: 'missing measured indicators' };
            analysis = ml.analysis || {};
        } else {
            // ML unavailable — skip this asset instead of publishing random signals
            console.log(`[SignalGen] ⚠ ML unavailable for ${symbol}, skipping (no random fallback)`);
            return { status: 'skipped', reason: 'ml unavailable' };
        }

        // Cap confidence at 95% — never show 100% (damages credibility)
        confidence = Math.min(95, confidence);

        if (confidence < MIN_CONFIDENCE) return { status: 'skipped', reason: `low confidence (${confidence}%)` };

        const priceChange = targetPrice - price;
        const priceChangePercent = (priceChange / price) * 100;
        const signalStrength = confidence >= 80 ? 'strong' : confidence >= 65 ? 'moderate' : 'weak';
        const expiresAt = new Date(Date.now() + days * 86400000);

        // ═══════════════════════════════════════════════════════════
        // LOCK entry/SL/TP at creation - these NEVER change after this
        // Fixed percentage levels from entry price
        // ═══════════════════════════════════════════════════════════
        const entryPrice = price;  // Locked entry price
        const isLong = direction === 'UP';

        // For LONG positions (expecting price to go UP):
        //   SL: 5% below entry, TP2: 8% above, TP3: 12% above
        // For SHORT positions (expecting price to go DOWN):
        //   SL: 5% above entry, TP2: 8% below, TP3: 12% below
        // 5% SL gives 7-day signals room for normal volatility
        const stopLoss = isLong
            ? entryPrice * 0.95   // 5% below entry
            : entryPrice * 1.05;  // 5% above entry

        const takeProfit1 = isLong
            ? entryPrice * 1.03   // 3% above entry
            : entryPrice * 0.97;  // 3% below entry

        const takeProfit2 = isLong
            ? entryPrice * 1.08   // 8% above entry
            : entryPrice * 0.92;  // 8% below entry

        const takeProfit3 = isLong
            ? entryPrice * 1.12   // 12% above entry
            : entryPrice * 0.88;  // 12% below entry

        // ═══════════════════════════════════════════════════════════
        // SAFETY VALIDATION - Catch any issues before saving
        // ═══════════════════════════════════════════════════════════
        if (entryPrice <= 0 || stopLoss <= 0 || takeProfit1 <= 0 || takeProfit2 <= 0 || takeProfit3 <= 0) {
            console.error(`[SignalGen] ❌ ${symbol}: Invalid prices detected - entry=${entryPrice}, sl=${stopLoss}, tp1=${takeProfit1}`);
            return { status: 'skipped', reason: 'invalid prices' };
        }
        if (isLong && (stopLoss >= entryPrice || takeProfit1 <= entryPrice)) {
            console.error(`[SignalGen] ❌ ${symbol}: LONG signal with invalid SL/TP relationship`);
            return { status: 'skipped', reason: 'invalid sl/tp' };
        }
        if (!isLong && (stopLoss <= entryPrice || takeProfit1 >= entryPrice)) {
            console.error(`[SignalGen] ❌ ${symbol}: SHORT signal with invalid SL/TP relationship`);
            return { status: 'skipped', reason: 'invalid sl/tp' };
        }

        // ─── SL/TP DISTANCE AUDIT ────────────────────────────
        // Verify the computed levels match our intended structure.
        // Our SL is 5% from entry; TP3 is 12%. If any level is more
        // than 20% from entry, the price input was likely garbage
        // (wrong token, stale cache, API error). Reject the signal
        // before it gets saved — this is the inline equivalent of
        // cleanupBrokenSignals.js and cleanupBadLosses.js.
        const slDist = Math.abs((stopLoss - entryPrice) / entryPrice) * 100;
        const tp3Dist = Math.abs((takeProfit3 - entryPrice) / entryPrice) * 100;
        if (slDist > 20 || tp3Dist > 20) {
            console.error(`[SignalGen] ❌ ${symbol}: SL/TP distances out of range (SL ${slDist.toFixed(1)}%, TP3 ${tp3Dist.toFixed(1)}%) — rejecting`);
            return { status: 'skipped', reason: 'sl/tp distance out of range' };
        }

        await new Prediction({
            user: null,
            symbol,
            assetType,
            currentPrice: price,
            targetPrice,
            // Locked trading levels
            entryPrice,
            stopLoss,
            takeProfit1,
            takeProfit2,
            takeProfit3,
            livePrice: price,  // Will be updated by price checker
            livePriceUpdatedAt: new Date(),
            direction,
            signalStrength,
            isActionable: confidence >= MIN_CONFIDENCE, // every published signal is actionable now
            priceChange,
            priceChangePercent,
            confidence,
            timeframe: days,
            indicators,
            analysis: {
                trend: direction === 'UP' ? 'Bullish' : 'Bearish',
                volatility: 'moderate',
                riskLevel: 'medium',
                message: analysis.message || `AI signal for ${symbol}`
            },
            expiresAt,
            status: 'pending',
            isPublic: true,
            viewCount: 0
        }).save();

        console.log(`[SignalGen] ✅ ${symbol} (${assetType}) — ${direction} ${confidence}% → $${targetPrice >= 1 ? targetPrice.toFixed(2) : targetPrice.toFixed(6)}`);

        // Distribute only the highest-conviction signals to external channels.
        // Lower-conviction signals still appear in the app but don't blast users.
        if (confidence >= NOTIFY_CONFIDENCE) {
            try { await NotificationService.createSignalNotification({ symbol, direction, confidence }); } catch (e) { console.error(`[SignalGen] Notification error: ${e.message}`); }
            try { await postSignalTeaser({ _id: symbol, symbol, direction, confidence }); } catch (e) { console.error(`[SignalGen] Telegram error: ${e.message}`); }
            try { await postSignalToX({ _id: symbol, symbol, direction, confidence }); } catch (e) { console.error(`[SignalGen] X post error: ${e.message}`); }
            try { await postNewSignalToDiscord({ symbol, direction, confidence, entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3, targetPrice, currentPrice: price }); } catch (e) { console.error(`[SignalGen] Discord error: ${e.message}`); }
        }

        return { status: 'generated' };
    } catch (err) {
        console.error(`[SignalGen] ❌ ${symbol}: ${err.message}`);
        return { status: 'error' };
    }
}

// ─── Run cycle ────────────────────────────────────────────

async function runCycle() {
    // Safety: force-reset a stuck isRunning flag after MAX_CYCLE_MS
    if (isRunning && runStartedAt && (Date.now() - runStartedAt > MAX_CYCLE_MS)) {
        console.warn(`[SignalGen] ⚠️ Previous cycle stuck for ${((Date.now() - runStartedAt) / 1000).toFixed(0)}s — force-resetting`);
        isRunning = false;
    }
    if (isRunning) { console.log('[SignalGen] Already running'); return; }
    isRunning = true;
    runStartedAt = Date.now();
    const start = Date.now();
    let gen = 0, skip = 0, err = 0;

    try {
        console.log(`[SignalGen] ══════════════════════════════════`);

        // Smart asset discovery pipeline
        const { stocks, crypto } = await discoverAssets();

        console.log(`[SignalGen] Processing ${stocks.length} stocks + ${crypto.length} crypto`);

        // Process stocks (3s delay for ML rate limit)
        for (const candidate of stocks) {
            console.log(`[SignalGen] → ${candidate.symbol} [${candidate.bucket}] score=${candidate.compositeScore}`);
            const r = await processAsset(candidate.symbol, 'stock', candidate.price);
            if (r.status === 'generated') gen++; else if (r.status === 'error') err++; else skip++;
            await new Promise(r => setTimeout(r, 3000));
        }

        // Process crypto (2s delay, price already prefetched)
        for (const candidate of crypto) {
            console.log(`[SignalGen] → ${candidate.symbol} [${candidate.bucket}] score=${candidate.compositeScore}`);
            const r = await processAsset(candidate.symbol, 'crypto', candidate.price);
            if (r.status === 'generated') gen++; else if (r.status === 'error') err++; else skip++;
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (cycleErr) {
        console.error(`[SignalGen] Cycle crashed: ${cycleErr.message}`);
        err++;
    } finally {
        // ALWAYS release the lock — prevents permanent stuck-flag blockage
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        stats.totalGenerated += gen;
        stats.totalSkipped += skip;
        stats.lastCycleGenerated = gen;
        stats.errors += err;
        lastRun = new Date();
        isRunning = false;
        runStartedAt = null;

        console.log(`[SignalGen] Done in ${elapsed}s — ${gen} generated, ${skip} skipped, ${err} errors`);
        console.log(`[SignalGen] ══════════════════════════════════`);
    }
}

// ─── Start ────────────────────────────────────────────────

function startSignalGenerator() {
    console.log(`[SignalGen] Starting automated signal generator`);
    console.log(`[SignalGen] Mode: Smart discovery pipeline (liquidity → movement → scoring)`);
    console.log(`[SignalGen] Quality gates:`);
    console.log(`[SignalGen]   • min confidence:        ${MIN_CONFIDENCE}%`);
    console.log(`[SignalGen]   • min predicted move:    ${MIN_PCT_MAGNITUDE}%`);
    console.log(`[SignalGen]   • notify threshold:      ${NOTIFY_CONFIDENCE}%`);
    console.log(`[SignalGen]   • cooldown loss streak:  ${COOLDOWN_LOSS_STREAK} losses → ${COOLDOWN_DURATION_HOURS}h skip`);
    console.log(`[SignalGen]   • NEUTRAL ML predictions: rejected`);
    console.log(`[SignalGen]   • direction/target check: enforced`);

    // Every hour at :30
    cron.schedule('30 * * * *', () => runCycle());

    // Initial run 15s after startup
    setTimeout(() => { console.log('[SignalGen] Initial cycle...'); runCycle(); }, 15000);
}

function getGeneratorStats() { return { ...stats, lastRun, isRunning }; }

module.exports = { startSignalGenerator, runCycle, getGeneratorStats };
