// server/services/predictionChecker.js - SELF-CONTAINED VERSION
// All price fetching logic is inline to avoid circular dependency issues

const cron = require('node-cron');
const axios = require('axios');
const Prediction = require('../models/Prediction');
const User = require('../models/User');
const GamificationService = require('./gamificationService');
const NotificationService = require('./notificationService');
const { postResult } = require('./telegramBot');
const { postSignalResult: postResultToX } = require('./xPosterService');

// ============ INLINE PRICE CACHE ============
const priceCache = new Map();
const CACHE_DURATION = 60000; // 60 seconds cache

// ============ CRYPTO DETECTION ============
const CRYPTO_SYMBOLS = new Set([
    'BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOGE', 'DOT', 'MATIC', 'SHIB', 'AVAX',
    'LINK', 'UNI', 'ATOM', 'LTC', 'ETC', 'XLM', 'ALGO', 'VET', 'FIL', 'AAVE',
    'SAND', 'MANA', 'AXS', 'THETA', 'XTZ', 'EOS', 'CAKE', 'RUNE', 'ZEC', 'DASH',
    'NEO', 'WAVES', 'BAT', 'ENJ', 'CHZ', 'COMP', 'SNX', 'YFI', 'SUSHI', 'CRV',
    'BNB', 'TRX', 'BCH', 'NEAR', 'APT', 'ARB', 'OP', 'SUI', 'SEI', 'TIA',
    'PEPE', 'WIF', 'BONK', 'FLOKI', 'RENDER', 'FET', 'TAO', 'INJ', 'RNDR', 'GRT',
    'IMX', 'STX', 'MKR', 'EGLD', 'HBAR', 'QNT', 'FTM', 'KAVA', 'FLOW', 'MINA',
    'TRUMP', 'BITCOIN', 'ETHEREUM', 'RIPPLE', 'SOLANA', 'CARDANO', 'DOGECOIN'
]);

const CRYPTO_ID_MAP = {
    'BTC': 'bitcoin', 'BITCOIN': 'bitcoin',
    'ETH': 'ethereum', 'ETHEREUM': 'ethereum',
    'XRP': 'ripple', 'RIPPLE': 'ripple',
    'SOL': 'solana', 'SOLANA': 'solana',
    'ADA': 'cardano', 'CARDANO': 'cardano',
    'DOGE': 'dogecoin', 'DOGECOIN': 'dogecoin',
    'DOT': 'polkadot', 'MATIC': 'matic-network',
    'SHIB': 'shiba-inu', 'AVAX': 'avalanche-2',
    'LINK': 'chainlink', 'UNI': 'uniswap',
    'ATOM': 'cosmos', 'LTC': 'litecoin',
    'ETC': 'ethereum-classic', 'XLM': 'stellar',
    'ALGO': 'algorand', 'VET': 'vechain',
    'FIL': 'filecoin', 'AAVE': 'aave',
    'SAND': 'the-sandbox', 'MANA': 'decentraland',
    'AXS': 'axie-infinity', 'THETA': 'theta-token',
    'BNB': 'binancecoin', 'TRX': 'tron',
    'BCH': 'bitcoin-cash', 'NEAR': 'near',
    'APT': 'aptos', 'ARB': 'arbitrum',
    'OP': 'optimism', 'SUI': 'sui',
    'SEI': 'sei-network', 'TIA': 'celestia',
    'PEPE': 'pepe', 'WIF': 'dogwifcoin',
    'BONK': 'bonk', 'FLOKI': 'floki',
    'TRUMP': 'official-trump',
    'RENDER': 'render-token', 'RNDR': 'render-token',
    'FET': 'fetch-ai', 'TAO': 'bittensor',
    'INJ': 'injective-protocol', 'GRT': 'the-graph',
    'MKR': 'maker', 'HBAR': 'hedera-hashgraph',
    'FTM': 'fantom', 'KAVA': 'kava',
    'FLOW': 'flow', 'MINA': 'mina-protocol'
};

function isCryptoSymbol(symbol) {
    if (!symbol) return false;
    // Clean the symbol
    let clean = symbol.toUpperCase().trim();
    // Remove common suffixes
    clean = clean.replace(/[/-]USD[T]?$/, '').replace(/USD$/, '');
    return CRYPTO_SYMBOLS.has(clean) || CRYPTO_ID_MAP[clean] !== undefined;
}

function getCleanSymbol(symbol) {
    if (!symbol) return '';
    let clean = symbol.toUpperCase().trim();
    // Remove /USD, -USD, USDT suffixes for crypto
    clean = clean.replace(/[/-]USD[T]?$/, '').replace(/USD$/, '');
    return clean;
}

// ============ INLINE PRICE FETCHING ============

async function fetchStockPrice(symbol) {
    const cleanSymbol = symbol.toUpperCase().trim();
    
    // Check cache
    const cached = priceCache.get(`stock-${cleanSymbol}`);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return { price: cached.price, source: 'cache' };
    }
    
    try {
        // Yahoo Finance API
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanSymbol}?interval=1d&range=1d`;
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });
        
        const result = response.data?.chart?.result?.[0];
        const price = result?.meta?.regularMarketPrice || result?.indicators?.quote?.[0]?.close?.slice(-1)[0];
        
        if (price && !isNaN(price)) {
            priceCache.set(`stock-${cleanSymbol}`, { price, timestamp: Date.now() });
            return { price, source: 'yahoo' };
        }
        
        throw new Error('No price data');
    } catch (error) {
        console.log(`[PriceCheck] Yahoo failed for ${cleanSymbol}: ${error.message}`);
        return { price: null, source: 'error', error: error.message };
    }
}

async function fetchCryptoPrice(symbol) {
    const cleanSymbol = getCleanSymbol(symbol);
    const coinId = CRYPTO_ID_MAP[cleanSymbol] || cleanSymbol.toLowerCase();
    
    // Check cache
    const cached = priceCache.get(`crypto-${cleanSymbol}`);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return { price: cached.price, source: 'cache' };
    }
    
    try {
        // CoinGecko API
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
        const response = await axios.get(url, { timeout: 10000 });
        const price = response.data?.[coinId]?.usd;
        
        if (price && !isNaN(price)) {
            priceCache.set(`crypto-${cleanSymbol}`, { price, timestamp: Date.now() });
            return { price, source: 'coingecko' };
        }
        
        throw new Error('No price from CoinGecko');
    } catch (error) {
        console.log(`[PriceCheck] CoinGecko failed for ${cleanSymbol}: ${error.message}`);
        
        // Fallback: Try Yahoo Finance with -USD suffix
        try {
            const yahooSymbol = `${cleanSymbol}-USD`;
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1d`;
            const response = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000
            });
            
            const result = response.data?.chart?.result?.[0];
            const price = result?.meta?.regularMarketPrice;
            
            if (price && !isNaN(price)) {
                priceCache.set(`crypto-${cleanSymbol}`, { price, timestamp: Date.now() });
                return { price, source: 'yahoo-crypto' };
            }
        } catch (yahooError) {
            console.log(`[PriceCheck] Yahoo crypto fallback failed for ${cleanSymbol}`);
        }
        
        return { price: null, source: 'error', error: error.message };
    }
}

async function getCurrentPrice(symbol, assetType) {
    if (!symbol) return { price: null, source: 'error', error: 'No symbol' };
    
    const isCrypto = assetType === 'crypto' || isCryptoSymbol(symbol);
    
    if (isCrypto) {
        return await fetchCryptoPrice(symbol);
    } else {
        return await fetchStockPrice(symbol);
    }
}

// ============ CHECKER STATISTICS ============
const checkerStats = {
    lastRun: null,
    totalChecked: 0,
    successCount: 0,
    errorCount: 0,
    correctPredictions: 0,
    incorrectPredictions: 0
};

// ============ CHECK SINGLE PREDICTION ============
async function checkPrediction(prediction) {
    try {
        const isCrypto = prediction.assetType === 'crypto' || isCryptoSymbol(prediction.symbol);
        const typeLabel = isCrypto ? 'crypto' : 'stock';
        console.log(`[PredictionChecker] Checking ${prediction.symbol} (${typeLabel})`);

        const priceResult = await getCurrentPrice(prediction.symbol, prediction.assetType);

        if (priceResult.price === null) {
            console.log(`[PredictionChecker] ❌ Could not fetch price for ${prediction.symbol}, skipping...`);
            checkerStats.errorCount++;
            return { success: false, prediction };
        }

        console.log(`[PredictionChecker] Price for ${prediction.symbol}: $${priceResult.price} (source: ${priceResult.source})`);

        // Calculate outcome
        await prediction.calculateOutcome(priceResult.price);

        // Update statistics
        checkerStats.successCount++;
        checkerStats.totalChecked++;
        
        if (prediction.status === 'correct') {
            checkerStats.correctPredictions++;
            console.log(`[PredictionChecker] ✅ ${prediction.symbol}: CORRECT (predicted ${prediction.direction}, actual change: ${prediction.outcome.actualChangePercent.toFixed(2)}%)`);
        } else {
            checkerStats.incorrectPredictions++;
            console.log(`[PredictionChecker] ❌ ${prediction.symbol}: INCORRECT (predicted ${prediction.direction}, actual change: ${prediction.outcome.actualChangePercent.toFixed(2)}%)`);
        }

        // Distribute results: Notifications + Telegram + X (system signals only)
        if (!prediction.user) {
            const isCorrect = prediction.status === 'correct';
            const movePct = prediction.outcome?.actualChangePercent || 0;
            try { NotificationService.createSignalResultNotification(prediction, isCorrect, movePct); } catch (e) { /* non-blocking */ }
            try { postResult(prediction, isCorrect, movePct); } catch (e) { /* non-blocking */ }
            try { postResultToX(prediction, isCorrect, movePct); } catch (e) { /* non-blocking */ }
        }

        return { success: true, prediction };

    } catch (error) {
        console.error(`[PredictionChecker] Error checking prediction ${prediction._id}:`, error.message);
        checkerStats.errorCount++;
        return { success: false, prediction };
    }
}

// ============ MAIN CHECK FUNCTION ============
async function checkExpiredPredictions() {
    try {
        const startTime = Date.now();
        console.log('\n================================');
        console.log('[PredictionChecker] 🔍 Starting check for expired predictions...');
        console.log(`[PredictionChecker] Time: ${new Date().toLocaleString()}`);

        // Find all pending predictions that have expired
        const expiredPredictions = await Prediction.find({
            user: { $ne: null },
            status: 'pending',
            expiresAt: { $lte: new Date() }
        }).limit(50);

        if (expiredPredictions.length === 0) {
            console.log('[PredictionChecker] ✨ No expired predictions found.');
            console.log('================================\n');
            return;
        }

        console.log(`[PredictionChecker] Found ${expiredPredictions.length} expired predictions to check`);
        
        const symbols = [...new Set(expiredPredictions.map(p => p.symbol))];
        console.log(`[PredictionChecker] Unique symbols: ${symbols.join(', ')}`);

        // Reset run statistics
        const runStats = {
            checked: 0,
            success: 0,
            errors: 0,
            correct: 0,
            incorrect: 0
        };

        // Track which users need gamification updates
        const userResults = new Map();

        // Check each prediction
        for (const prediction of expiredPredictions) {
            const result = await checkPrediction(prediction);

            if (result.success) {
                runStats.success++;

                // System signals (user=null) don't have user stats to update
                const userId = prediction.user?.toString();
                if (userId) {
                    if (!userResults.has(userId)) {
                        userResults.set(userId, { correct: 0, incorrect: 0 });
                    }

                    if (prediction.status === 'correct') {
                        userResults.get(userId).correct++;
                        try {
                            await NotificationService.createPredictionResultNotification(userId, prediction, true);
                        } catch (e) { console.error('[PredictionChecker] Notification error:', e.message); }
                    } else if (prediction.status === 'incorrect') {
                        userResults.get(userId).incorrect++;
                        try {
                            await NotificationService.createPredictionResultNotification(userId, prediction, false);
                        } catch (e) { console.error('[PredictionChecker] Notification error:', e.message); }
                    }
                }

                if (prediction.status === 'correct') runStats.correct++;
                else if (prediction.status === 'incorrect') runStats.incorrect++;
            } else {
                runStats.errors++;
            }

            runStats.checked++;

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        // Update global statistics
        checkerStats.lastRun = new Date();

        // Update gamification for affected users
        await updateGamificationStats(userResults);

        // Update user stats
        const affectedUserIds = [...new Set(expiredPredictions.filter(p => p.user).map(p => p.user.toString()))];
        await updateUserStats(affectedUserIds);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        console.log('\n[PredictionChecker] 📊 Run Summary:');
        console.log(`  ✅ Success: ${runStats.success}`);
        console.log(`  ❌ Errors: ${runStats.errors}`);
        console.log(`  🎯 Correct: ${runStats.correct}`);
        console.log(`  ⚠️  Incorrect: ${runStats.incorrect}`);
        console.log(`  ⏱️  Duration: ${duration}s`);
        console.log(`  👥 Users affected: ${affectedUserIds.length}`);
        console.log(`  💾 Cache size: ${priceCache.size} entries`);
        console.log('================================\n');

    } catch (error) {
        console.error('[PredictionChecker] ❌ Error in checkExpiredPredictions:', error.message);
        console.error(error.stack);
    }
}

// ============ GAMIFICATION UPDATES ============
async function updateGamificationStats(userResults) {
    console.log(`[PredictionChecker] 🎮 Updating gamification for ${userResults.size} users...`);
    
    for (const [userId, results] of userResults) {
        try {
            if (results.correct > 0) {
                const xpAmount = results.correct * 50;
                await GamificationService.awardXP(userId, xpAmount, `${results.correct} correct prediction(s)`);
                
                const coinAmount = results.correct * 25;
                await GamificationService.awardCoins(userId, coinAmount, `${results.correct} correct prediction(s)`);
                
                console.log(`[PredictionChecker]   🎯 User ${userId}: +${xpAmount} XP, +${coinAmount} coins for ${results.correct} correct`);
            }
            
            if (results.incorrect > 0) {
                const xpAmount = results.incorrect * 5;
                await GamificationService.awardXP(userId, xpAmount, `${results.incorrect} prediction(s) resolved`);
                console.log(`[PredictionChecker]   📉 User ${userId}: +${xpAmount} XP for ${results.incorrect} incorrect`);
            }
            
            await GamificationService.checkAchievements(userId);
            
        } catch (error) {
            console.error(`[PredictionChecker]   ❌ Gamification error for ${userId}:`, error.message);
        }
    }
}

// ============ USER STATS UPDATES ============
async function updateUserStats(userIds) {
    try {
        console.log(`[PredictionChecker] 🔄 Updating stats for ${userIds.length} users...`);

        for (const userId of userIds) {
            try {
                const user = await User.findById(userId);
                if (!user) continue;

                if (!user.stats) user.stats = {};

                const accuracy = await Prediction.getUserAccuracy(userId);
                const totalPredictionsCount = await Prediction.countDocuments({ user: userId });
                const resolvedCount = await Prediction.countDocuments({ 
                    user: userId, 
                    status: { $in: ['correct', 'incorrect'] } 
                });

                user.stats.totalPredictions = totalPredictionsCount;
                user.stats.correctPredictions = accuracy.correctPredictions || 0;
                user.stats.predictionAccuracy = accuracy.accuracy || 0;
                // Note: totalTrades is set by paper trading, NOT predictions
                // winRate for predictions is tracked as predictionAccuracy

                // Calculate streak
                const recentPredictions = await Prediction.find({
                    user: userId,
                    status: { $in: ['correct', 'incorrect'] }
                }).sort({ 'outcome.checkedAt': -1 }).limit(20);

                let currentStreak = 0;
                for (const pred of recentPredictions) {
                    if (pred.status === 'correct') currentStreak++;
                    else break;
                }

                user.stats.currentStreak = currentStreak;
                user.stats.longestStreak = Math.max(user.stats.longestStreak || 0, currentStreak);
                user.stats.lastPredictionDate = new Date();
                user.stats.lastUpdated = Date.now();

                await user.save();
                
                console.log(`[PredictionChecker]   ✅ Updated user ${userId}:`);
                console.log(`      - Total Predictions: ${totalPredictionsCount}`);
                console.log(`      - Resolved: ${resolvedCount}`);
                console.log(`      - Correct: ${accuracy.correctPredictions}`);
                console.log(`      - Accuracy: ${accuracy.accuracy.toFixed(1)}%`);
                console.log(`      - Current Streak: ${currentStreak}`);
                
            } catch (userError) {
                console.error(`[PredictionChecker]   ❌ Error updating user ${userId}:`, userError.message);
            }
        }

        console.log(`[PredictionChecker] ✨ User stats update complete`);

    } catch (error) {
        console.error('[PredictionChecker] ❌ Error updating user stats:', error.message);
    }
}

// ============ CLEANUP ============
async function markStaleAsExpired() {
    try {
        console.log('[PredictionChecker] 🧹 Running daily cleanup...');
        
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const result = await Prediction.updateMany(
            { user: { $ne: null }, status: 'pending', expiresAt: { $lte: thirtyDaysAgo } },
            { $set: { status: 'expired' } }
        );

        if (result.modifiedCount > 0) {
            console.log(`[PredictionChecker] ✨ Marked ${result.modifiedCount} stale predictions as expired`);
        } else {
            console.log(`[PredictionChecker] No stale predictions found`);
        }
        
        // Clear cache
        priceCache.clear();
        console.log(`[PredictionChecker] 🗑️  Cleared price cache`);
        
    } catch (error) {
        console.error('[PredictionChecker] ❌ Error marking stale predictions:', error.message);
    }
}

// ============ STATISTICS ============
function getCheckerStats() {
    return {
        ...checkerStats,
        accuracyRate: checkerStats.totalChecked > 0 
            ? ((checkerStats.correctPredictions / checkerStats.totalChecked) * 100).toFixed(2) + '%'
            : 'N/A',
        uptime: checkerStats.lastRun 
            ? `Last run: ${new Date(checkerStats.lastRun).toLocaleString()}`
            : 'Not run yet',
        cacheSize: priceCache.size
    };
}

// ============ STARTUP ============
let isStarted = false;

function startPredictionChecker() {
    if (isStarted) {
        console.log('[PredictionChecker] ⚠️ Already started, skipping duplicate initialization');
        return;
    }
    isStarted = true;

    console.log('\n🚀 ================================');
    console.log('[PredictionChecker] Starting prediction checker service...');
    console.log('[PredictionChecker] Self-contained price fetching (no external dependencies)');
    console.log('[PredictionChecker] Gamification integration enabled');
    console.log('================================\n');

    // Check expired predictions every hour
    cron.schedule('0 * * * *', async () => {
        console.log('[PredictionChecker] ⏰ Hourly check triggered...');
        await checkExpiredPredictions();
    });

    // Daily cleanup at 2 AM
    cron.schedule('0 2 * * *', async () => {
        console.log('[PredictionChecker] ⏰ Daily cleanup triggered...');
        await markStaleAsExpired();
    });

    console.log('[PredictionChecker] ✅ Cron jobs scheduled:');
    console.log('  • Check expired predictions: Every hour (0 * * * *)');
    console.log('  • Mark stale as expired: Daily at 2 AM (0 2 * * *)');
    console.log('');

    // Run immediately on startup if enabled
    if (process.env.CHECK_PREDICTIONS_ON_STARTUP === 'true') {
        console.log('[PredictionChecker] 🏃 Running initial check on startup...');
        setTimeout(async () => {
            await checkExpiredPredictions();
        }, 5000);
    }
}

// Manual trigger
async function manualCheck() {
    console.log('[PredictionChecker] 🔧 Manual check triggered');
    await checkExpiredPredictions();
}

// ============ EXPORTS ============
module.exports = {
    startPredictionChecker,
    checkExpiredPredictions,
    manualCheck,
    getCheckerStats,
    isCryptoSymbol,
    getCurrentPrice
};