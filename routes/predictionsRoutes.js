const { scoreSignal, signalViewer } = require('../utils/signalPresentation');
const requireAdmin = require('../middleware/adminMiddleware');
const { verifyAccessToken } = require('../utils/authTokens');
// server/routes/predictionsRoutes.js - WITH SHARED PREDICTIONS & ACCURATE PRICING

const express = require('express');
const router = express.Router();

const axios = require('axios');
const rateLimit = require('express-rate-limit');
// Protect all mounts, including /predictions, before viewer/auth database lookups.
const predictionReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Too many prediction requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false,
});
router.use(predictionReadLimiter);
router.use(['/recent', '/signals', '/performance'], signalViewer);
const auth = require('../middleware/authMiddleware');
const { checkUsageLimit, requireSubscription } = require('../middleware/subscriptionMiddleware');
const Prediction = require('../models/Prediction');
const GamificationService = require('../services/gamificationService');
const { sanitizeSymbol, encodeSymbolForUrl, validateSymbol } = require('../utils/symbolValidation');

// Rate limiter for prediction-related endpoints
const predictionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 requests per minute
    message: { error: 'Too many requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false
});

const priceService = require('../services/priceService');
const stockDataService = require('../services/stockDataService');
const geckoTerminalService = require('../services/geckoTerminalService');
const { sendMLPredictionAlert } = require('../services/telegramScheduler');
const { sendMLPredictionAlert: sendDiscordMLPredictionAlert } = require('../services/discordScheduler');
const CopyTradingService = require('../services/copyTradingService');
const fs = require('fs');
const path = require('path');

const DEBUG_LOG_PATH = path.resolve(__dirname, '..', '..', 'prediction_debug.log');

function appendDebugLog(label, obj) {
    try {
        const entry = `\n=== ${new Date().toISOString()} - ${label} ===\n` + (typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)) + '\n';
        fs.appendFileSync(DEBUG_LOG_PATH, entry, { encoding: 'utf8' });
    } catch (e) {
        console.warn('[Predictions] Failed to write debug log:', e.message);
    }
}


// @route   GET /api/predictions/symbols/search
// @desc    Search for valid stock/crypto/DEX symbols
// @access  Public
router.get('/symbols/search', async (req, res) => {
    try {
        const { q, type, network: queryNetwork } = req.query;
        const query = (q || '').trim();
        const queryUpper = query.toUpperCase();

        if (!query || query.length < 1) {
            return res.json({ symbols: [] });
        }

        const results = [];

        // ============ CONTRACT ADDRESS DETECTION ============
        // EVM address: 0x followed by 40 hex characters
        // Solana address: Base58 encoded, 32-44 characters (no 0x prefix)
        const isEvmAddress = /^0x[a-fA-F0-9]{40}$/i.test(query);
        const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(query) && !query.startsWith('0x');

        if (isEvmAddress || isSolanaAddress) {
            console.log(`[Predictions] Contract address detected: ${query.substring(0, 10)}...`);

            try {
                // Determine which networks to search
                let networksToSearch = [];
                if (isSolanaAddress) {
                    networksToSearch = ['solana'];
                } else if (queryNetwork) {
                    networksToSearch = [queryNetwork.toLowerCase()];
                } else {
                    // Search top EVM networks first (most tokens live here)
                    networksToSearch = ['eth', 'bsc', 'base', 'arbitrum', 'polygon_pos', 'solana', 'avax', 'optimism'];
                }

                // Search networks sequentially (avoids GeckoTerminal 429 rate limits)
                // Stop as soon as we find a match
                const validResults = [];
                for (const network of networksToSearch) {
                    try {
                        const tokenInfo = await geckoTerminalService.getTokenPrice(network, query.toLowerCase());
                        if (tokenInfo && tokenInfo.price > 0) {
                            validResults.push({
                                symbol: `${tokenInfo.symbol}:${network}`,
                                name: tokenInfo.name || tokenInfo.symbol,
                                type: 'dex',
                                chain: network.toUpperCase(),
                                price: tokenInfo.price,
                                contractAddress: query.toLowerCase(),
                                network: network,
                                priceChange24h: tokenInfo.priceChange24h
                            });
                            console.log(`[Predictions] ✅ Found token on ${network}: ${tokenInfo.symbol} $${tokenInfo.price}`);
                            break; // Found it, stop searching
                        }
                    } catch (err) {
                        console.log(`[Predictions] Contract search failed on ${network}:`, err.message);
                    }
                }

                if (validResults.length > 0) {
                    results.push(...validResults);
                    console.log(`[Predictions] Found ${validResults.length} tokens by contract address`);

                    // Return immediately for contract address searches
                    return res.json({
                        symbols: results,
                        query: query,
                        searchType: 'contract_address'
                    });
                } else {
                    console.log(`[Predictions] No token found for contract address: ${query.substring(0, 10)}...`);
                }
            } catch (caError) {
                console.log('[Predictions] Contract address search error:', caError.message);
            }
        }
        // ============ END CONTRACT ADDRESS DETECTION ============

        // Search crypto symbols (CoinGecko)
        if (!type || type === 'crypto' || type === 'all') {
            const cryptoSymbols = Array.from(priceService.CRYPTO_SYMBOLS);
            const matchingCrypto = cryptoSymbols.filter(s =>
                s.startsWith(queryUpper) || s.includes(queryUpper)
            ).slice(0, 15).map(s => ({
                symbol: s,
                name: priceService.COINGECKO_IDS[s] ?
                    priceService.COINGECKO_IDS[s].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : s,
                type: 'crypto'
            }));
            results.push(...matchingCrypto);
        }

        // Search DEX tokens (GeckoTerminal) - only if query is 2+ chars
        if ((!type || type === 'dex' || type === 'all') && queryUpper.length >= 2) {
            try {
                // Search across multiple networks in parallel
                const networks = ['bsc', 'eth', 'solana'];
                const dexSearchPromises = networks.map(network =>
                    geckoTerminalService.search(queryUpper, network, false).catch(() => [])
                );

                const dexResults = await Promise.all(dexSearchPromises);
                const allDexTokens = dexResults.flat();

                // Filter and format DEX tokens
                const matchingDex = allDexTokens
                    .filter(token =>
                        token.symbol?.toUpperCase().includes(queryUpper) ||
                        token.name?.toUpperCase().includes(queryUpper)
                    )
                    .filter(token => token.price > 0 && token.tvl > 1000) // Only tokens with liquidity
                    .slice(0, 15)
                    .map(token => ({
                        symbol: `${token.symbol}:${token.network}`,
                        name: token.name || token.symbol,
                        type: 'dex',
                        chain: token.chain || token.network?.toUpperCase(),
                        price: token.price,
                        contractAddress: token.contractAddress,
                        poolAddress: token.poolAddress,
                        network: token.network
                    }));

                results.push(...matchingDex);
                console.log(`[Predictions] DEX search for "${queryUpper}" found ${matchingDex.length} tokens`);
            } catch (dexError) {
                console.log('[Predictions] DEX search error:', dexError.message);
            }
        }

        // Search popular stocks (hardcoded list for quick search)
        if (!type || type === 'stock' || type === 'all') {
            const popularStocks = [
                { symbol: 'AAPL', name: 'Apple Inc.' },
                { symbol: 'MSFT', name: 'Microsoft Corporation' },
                { symbol: 'GOOGL', name: 'Alphabet Inc.' },
                { symbol: 'AMZN', name: 'Amazon.com Inc.' },
                { symbol: 'TSLA', name: 'Tesla Inc.' },
                { symbol: 'META', name: 'Meta Platforms Inc.' },
                { symbol: 'NVDA', name: 'NVIDIA Corporation' },
                { symbol: 'AMD', name: 'Advanced Micro Devices' },
                { symbol: 'NFLX', name: 'Netflix Inc.' },
                { symbol: 'DIS', name: 'Walt Disney Co.' },
                { symbol: 'BA', name: 'Boeing Company' },
                { symbol: 'JPM', name: 'JPMorgan Chase & Co.' },
                { symbol: 'V', name: 'Visa Inc.' },
                { symbol: 'MA', name: 'Mastercard Inc.' },
                { symbol: 'WMT', name: 'Walmart Inc.' },
                { symbol: 'JNJ', name: 'Johnson & Johnson' },
                { symbol: 'PG', name: 'Procter & Gamble' },
                { symbol: 'UNH', name: 'UnitedHealth Group' },
                { symbol: 'HD', name: 'Home Depot Inc.' },
                { symbol: 'INTC', name: 'Intel Corporation' },
                { symbol: 'CRM', name: 'Salesforce Inc.' },
                { symbol: 'PYPL', name: 'PayPal Holdings' },
                { symbol: 'COIN', name: 'Coinbase Global' },
                { symbol: 'SQ', name: 'Block Inc.' },
                { symbol: 'PLTR', name: 'Palantir Technologies' },
                { symbol: 'GME', name: 'GameStop Corp.' },
                { symbol: 'AMC', name: 'AMC Entertainment' },
                { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
                { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
                { symbol: 'ARKK', name: 'ARK Innovation ETF' }
            ];

            const matchingStocks = popularStocks.filter(s =>
                s.symbol.startsWith(queryUpper) || s.symbol.includes(queryUpper) ||
                s.name.toUpperCase().includes(queryUpper)
            ).slice(0, 15).map(s => ({ ...s, type: 'stock' }));
            results.push(...matchingStocks);
        }

        // Sort by exact match first, then by type priority, then alphabetically
        results.sort((a, b) => {
            // Exact symbol match first
            if (a.symbol === queryUpper) return -1;
            if (b.symbol === queryUpper) return 1;
            // Then starts with query
            if (a.symbol.startsWith(queryUpper) && !b.symbol.startsWith(queryUpper)) return -1;
            if (!a.symbol.startsWith(queryUpper) && b.symbol.startsWith(queryUpper)) return 1;
            // Then by type priority (crypto > dex > stock)
            const typePriority = { crypto: 0, dex: 1, stock: 2 };
            const typeA = typePriority[a.type] ?? 3;
            const typeB = typePriority[b.type] ?? 3;
            if (typeA !== typeB) return typeA - typeB;
            // Finally alphabetically
            return a.symbol.localeCompare(b.symbol);
        });

        res.json({
            symbols: results.slice(0, 30),
            query: query
        });

    } catch (error) {
        console.error('[Predictions] Symbol search error:', error.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

// @route   GET /api/predictions/symbols/all
// @desc    Get all available symbols for predictions
// @access  Public
router.get('/symbols/all', (req, res) => {
    try {
        const cryptoSymbols = Array.from(priceService.CRYPTO_SYMBOLS).map(s => ({
            symbol: s,
            name: priceService.COINGECKO_IDS[s] || s,
            type: 'crypto'
        }));

        res.json({
            crypto: cryptoSymbols,
            cryptoCount: cryptoSymbols.length,
            note: 'Stocks can use any valid ticker symbol'
        });
    } catch (error) {
        console.error('[Predictions] Symbols list error:', error.message);
        res.status(500).json({ error: 'Failed to get symbols' });
    }
});

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:5001';
const ML_API_KEY = process.env.ML_API_KEY;
const ML_HEADERS = ML_API_KEY ? { 'X-API-Key': ML_API_KEY } : {};
const USE_MOCK_PREDICTIONS = process.env.USE_MOCK_PREDICTIONS === 'true' || false;

// ============ REAL-TIME PRICE FETCHING ============
// Fetch fresh price directly from external APIs (bypass cache for display)
async function getFreshPrice(symbol, assetType, dexInfo = null) {
    // Validate symbol to prevent SSRF attacks
    const upperSymbol = sanitizeSymbol(symbol);
    console.log(`[Price] Fetching fresh price for ${upperSymbol} (${assetType})`);

    // Get CoinGecko Pro API key from environment
    const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

    try {
        // For DEX tokens, use GeckoTerminal
        if (assetType === 'dex') {
            try {
                // DEX symbol format: SYMBOL:network (e.g., DYOR:bsc)
                let network = dexInfo?.network || 'bsc';
                let tokenSymbol = upperSymbol;

                // Parse symbol:network format
                if (upperSymbol.includes(':')) {
                    const parts = upperSymbol.split(':');
                    tokenSymbol = parts[0];
                    network = parts[1]?.toLowerCase() || 'bsc';
                }

                console.log(`[Price] DEX token: ${tokenSymbol} on ${network}`);

                // PRIORITY 1: If we have contract address, get token price directly (most reliable)
                if (dexInfo?.contractAddress) {
                    const tokenData = await geckoTerminalService.getTokenPrice(network, dexInfo.contractAddress);
                    if (tokenData?.price > 0) {
                        console.log(`[Price] ✅ Fresh ${tokenSymbol} from GeckoTerminal token: $${tokenData.price}`);
                        return {
                            price: tokenData.price,
                            source: 'geckoterminal-token',
                            network: network,
                            contractAddress: dexInfo.contractAddress
                        };
                    }
                }

                // PRIORITY 2: If we have pool address, get direct pool data
                if (dexInfo?.poolAddress) {
                    const poolData = await geckoTerminalService.getPoolData(network, dexInfo.poolAddress);
                    if (poolData?.price) {
                        console.log(`[Price] ✅ Fresh ${tokenSymbol} from GeckoTerminal pool: $${poolData.price}`);
                        return { price: poolData.price, source: 'geckoterminal-pool' };
                    }
                }

                // PRIORITY 3: Search by symbol (fallback)
                const searchResults = await geckoTerminalService.search(tokenSymbol, network, false);
                if (searchResults && searchResults.length > 0) {
                    // Find best match (exact symbol match preferred)
                    const exactMatch = searchResults.find(r => r.symbol === tokenSymbol);
                    const result = exactMatch || searchResults[0];

                    if (result?.price > 0) {
                        console.log(`[Price] ✅ Fresh ${tokenSymbol} from GeckoTerminal: $${result.price}`);
                        return {
                            price: result.price,
                            source: 'geckoterminal',
                            poolAddress: result.poolAddress,
                            network: network
                        };
                    }
                }

                console.log(`[Price] ❌ No DEX price found for ${tokenSymbol}`);
                return { price: null, source: 'error' };
            } catch (dexError) {
                console.error(`[Price] DEX price error for ${upperSymbol}:`, dexError.message);
                return { price: null, source: 'error' };
            }
        }

        // For crypto, use CoinGecko Pro FIRST (you're paying for it!), then Binance as fallback
        if (assetType === 'crypto') {
            // Use priceService for consistent CoinGecko ID mapping
            const coinId = priceService.getCoinGeckoId(upperSymbol);
            
            // Try CoinGecko Pro FIRST (real-time with your API key)
            try {
                const headers = {};
                let baseUrl = 'https://api.coingecko.com/api/v3';
                
                if (COINGECKO_API_KEY) {
                    headers['x-cg-pro-api-key'] = COINGECKO_API_KEY;
                    baseUrl = 'https://pro-api.coingecko.com/api/v3';
                    console.log(`[Price] Using CoinGecko Pro API for ${upperSymbol}`);
                }
                
                const response = await axios.get(
                    `${baseUrl}/simple/price?ids=${coinId}&vs_currencies=usd&precision=full`,
                    { headers, timeout: 5000 }
                );
                
                if (response.data[coinId]?.usd) {
                    const price = response.data[coinId].usd;
                    console.log(`[Price] ✅ Fresh ${upperSymbol} from CoinGecko Pro: $${price}`);
                    return { price, source: 'coingecko-pro' };
                }
            } catch (cgError) {
                console.log(`[Price] CoinGecko failed for ${upperSymbol}:`, cgError.message);
            }
            
            // Fallback to Binance (free, real-time)
            try {
                const binanceSymbol = `${upperSymbol}USDT`;
                const response = await axios.get(
                    `https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`,
                    { timeout: 5000 }
                );

                if (response.data?.price) {
                    const price = parseFloat(response.data.price);
                    console.log(`[Price] ✅ Fresh ${upperSymbol} from Binance: $${price}`);
                    return { price, source: 'binance' };
                }
            } catch (binanceError) {
                console.log(`[Price] Binance failed for ${upperSymbol}:`, binanceError.message);
            }

            // Fallback to CoinCap (no key, no geo-restrictions)
            try {
                const coinCapId = coinId; // CoinCap uses similar IDs to CoinGecko
                const response = await axios.get(
                    `https://api.coincap.io/v2/assets/${coinCapId}`,
                    { timeout: 5000 }
                );
                if (response.data?.data?.priceUsd) {
                    const price = parseFloat(response.data.data.priceUsd);
                    console.log(`[Price] ✅ Fresh ${upperSymbol} from CoinCap: $${price}`);
                    return { price, source: 'coincap' };
                }
            } catch (ccError) {
                console.log(`[Price] CoinCap failed for ${upperSymbol}:`, ccError.message);
            }

            // Fallback to CryptoCompare (no key needed for basic)
            try {
                const response = await axios.get(
                    `https://min-api.cryptocompare.com/data/price?fsym=${upperSymbol}&tsyms=USD`,
                    { timeout: 5000 }
                );
                if (response.data?.USD) {
                    const price = response.data.USD;
                    console.log(`[Price] ✅ Fresh ${upperSymbol} from CryptoCompare: $${price}`);
                    return { price, source: 'cryptocompare' };
                }
            } catch (ccmpError) {
                console.log(`[Price] CryptoCompare failed for ${upperSymbol}:`, ccmpError.message);
            }
        }
        
        // For stocks, try multiple sources
        if (assetType === 'stock') {
            // Try Yahoo Finance with 1-minute interval for more recent data
            try {
                const response = await axios.get(
                    `https://query1.finance.yahoo.com/v8/finance/chart/${upperSymbol}?interval=1m&range=1d`,
                    { 
                        timeout: 5000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                    }
                );
                
                const result = response.data?.chart?.result?.[0];
                if (result?.meta?.regularMarketPrice) {
                    const price = result.meta.regularMarketPrice;
                    console.log(`[Price] ✅ Fresh ${upperSymbol} from Yahoo: $${price}`);
                    return { price, source: 'yahoo' };
                }
            } catch (yahooError) {
                console.log(`[Price] Yahoo failed for ${upperSymbol}:`, yahooError.message);
            }
            
            // Try Finnhub as backup (free tier available)
            try {
                const finnhubKey = process.env.FINNHUB_API_KEY;
                if (finnhubKey) {
                    const response = await axios.get(
                        `https://finnhub.io/api/v1/quote?symbol=${upperSymbol}&token=${finnhubKey}`,
                        { timeout: 5000 }
                    );
                    
                    if (response.data?.c) { // 'c' is current price
                        const price = response.data.c;
                        console.log(`[Price] ✅ Fresh ${upperSymbol} from Finnhub: $${price}`);
                        return { price, source: 'finnhub' };
                    }
                }
            } catch (finnhubError) {
                console.log(`[Price] Finnhub failed for ${upperSymbol}:`, finnhubError.message);
            }
        }
        
        // ❌ NO FALLBACK - If we couldn't get a price from real APIs, return error
        console.log(`[Price] ❌ No valid price found for ${upperSymbol} - rejecting`);
        return { price: null, source: 'error' };
        
    } catch (error) {
        console.error(`[Price] Error fetching fresh price for ${symbol}:`, error.message);
        return { price: null, source: 'error' };
    }
}

// ============ GENERATE MOCK INDICATORS ============
function generateMockIndicators(currentPrice, direction) {
    const isUp = direction === 'UP';
    
    const rsiBase = isUp ? 55 : 45;
    const rsiValue = rsiBase + (Math.random() * 20 - 10);
    const rsiSignal = rsiValue < 40 ? 'BUY' : rsiValue > 60 ? 'SELL' : 'NEUTRAL';
    
    const macdValue = isUp 
        ? (Math.random() * 2 + 0.5).toFixed(2)
        : (-Math.random() * 2 - 0.5).toFixed(2);
    const macdSignal = parseFloat(macdValue) > 0 ? 'BUY' : 'SELL';
    
    const sma20 = currentPrice * (isUp ? 0.98 : 1.02);
    const sma50 = currentPrice * (isUp ? 0.95 : 1.05);
    const sma20Signal = currentPrice > sma20 ? 'BUY' : 'SELL';
    const sma50Signal = currentPrice > sma50 ? 'BUY' : 'SELL';
    
    const bbPosition = isUp ? 'Near Upper Band' : 'Near Lower Band';
    
    const volumeOptions = ['High', 'Above Average', 'Average', 'Below Average'];
    const volumeValue = volumeOptions[Math.floor(Math.random() * volumeOptions.length)];
    
    const stochValue = isUp 
        ? (Math.random() * 30 + 50).toFixed(1)
        : (Math.random() * 30 + 20).toFixed(1);
    const stochSignal = parseFloat(stochValue) > 80 ? 'SELL' : parseFloat(stochValue) < 20 ? 'BUY' : 'NEUTRAL';
    
    return {
        'RSI': { value: parseFloat(rsiValue.toFixed(1)), signal: rsiSignal },
        'MACD': { value: parseFloat(macdValue), signal: macdSignal },
        'SMA 20': { value: parseFloat(sma20.toFixed(2)), signal: sma20Signal },
        'SMA 50': { value: parseFloat(sma50.toFixed(2)), signal: sma50Signal },
        'Bollinger': { value: bbPosition, signal: isUp ? 'BUY' : 'SELL' },
        'Volume': { value: volumeValue, signal: 'NEUTRAL' },
        'Stochastic': { value: parseFloat(stochValue), signal: stochSignal },
        'Trend': { value: isUp ? 'Bullish' : 'Bearish', signal: isUp ? 'BUY' : 'SELL' }
    };
}

// Generate mock prediction
function generateMockPrediction(symbol, days, currentPrice = null) {
    const basePrice = currentPrice || (Math.random() * 500 + 50);
    const direction = Math.random() > 0.5 ? 'UP' : 'DOWN';
    const changePercent = direction === 'UP' 
        ? (Math.random() * 8 + 1).toFixed(2)
        : -(Math.random() * 8 + 1).toFixed(2);
    const targetPrice = basePrice * (1 + parseFloat(changePercent) / 100);
    const confidence = (Math.random() * 25 + 65).toFixed(1);

    const indicators = generateMockIndicators(basePrice, direction);

    return {
        symbol: symbol.toUpperCase(),
        current_price: parseFloat(basePrice),
        prediction: {
            target_price: parseFloat(targetPrice),
            direction: direction,
            price_change: parseFloat(targetPrice - basePrice),
            price_change_percent: parseFloat(changePercent),
            confidence: parseFloat(confidence),
            days: days
        },
        analysis: {
            trend: direction === 'UP' ? 'Bullish' : 'Bearish',
            volatility: 'Moderate',
            risk_level: 'Medium'
        },
        indicators: indicators,
        timestamp: new Date().toISOString()
    };
}

// Calculate live confidence
function calculateLiveConfidence(prediction, currentPrice) {
    const originalConfidence = prediction.confidence;
    const targetPrice = prediction.targetPrice;
    const startPrice = prediction.currentPrice;
    
    const targetMovement = targetPrice - startPrice;
    const actualMovement = currentPrice - startPrice;
    
    if (prediction.direction === 'UP') {
        if (actualMovement > 0) {
            const progress = Math.min(actualMovement / targetMovement, 1);
            return Math.min(95, originalConfidence + (progress * 20));
        } else {
            const wrongProgress = Math.abs(actualMovement / targetMovement);
            return Math.max(30, originalConfidence - (wrongProgress * 30));
        }
    }
    
    if (prediction.direction === 'DOWN') {
        if (actualMovement < 0) {
            const progress = Math.min(Math.abs(actualMovement / targetMovement), 1);
            return Math.min(95, originalConfidence + (progress * 20));
        } else {
            const wrongProgress = actualMovement / Math.abs(targetMovement);
            return Math.max(30, originalConfidence - (wrongProgress * 30));
        }
    }
    
    return originalConfidence;
}

// ============ SHARED PREDICTION ROUTES ============

// @route   GET /api/predictions/active/:symbol
// @desc    Get active shared prediction for a symbol (if exists)
// @access  Public
router.get('/active/:symbol', predictionLimiter, auth, requireSubscription('starter'), async (req, res) => {
    try {
        // Validate symbol to prevent SSRF/injection attacks
        let symbol;
        try {
            symbol = sanitizeSymbol(req.params.symbol);
        } catch (validationError) {
            return res.status(400).json({
                success: false,
                error: 'Invalid symbol',
                message: validationError.message
            });
        }
        
        // Find an active (non-expired) prediction for this symbol
        const activePrediction = await Prediction.findOne({
            user: null, isPublic: true,
            symbol: symbol,
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).sort({ createdAt: -1 }); // Get most recent
        
        if (!activePrediction) {
            return res.json({ 
                success: true, 
                exists: false, 
                message: 'No active prediction for this symbol' 
            });
        }
        
        // Get fresh current price
        const priceResult = await getFreshPrice(symbol, activePrediction.assetType);
        const currentPrice = priceResult.price || activePrediction.currentPrice;
        
        // Calculate live stats
        const liveConfidence = calculateLiveConfidence(activePrediction, currentPrice);
        const timeRemaining = Math.max(0, activePrediction.expiresAt - Date.now());
        
        res.json({
            success: true,
            exists: true,
            isShared: true,
            prediction: {
                _id: activePrediction._id,
                symbol: activePrediction.symbol,
                assetType: activePrediction.assetType,
                current_price: currentPrice,
                prediction: {
                    target_price: activePrediction.targetPrice,
                    direction: activePrediction.direction,
                    price_change: activePrediction.priceChange,
                    price_change_percent: activePrediction.priceChangePercent,
                    confidence: activePrediction.confidence,
                    days: activePrediction.timeframe
                },
                liveConfidence,
                livePrice: currentPrice,
                liveChange: currentPrice - activePrediction.currentPrice,
                liveChangePercent: ((currentPrice - activePrediction.currentPrice) / activePrediction.currentPrice) * 100,
                timeRemaining,
                daysRemaining: Math.ceil(timeRemaining / (1000 * 60 * 60 * 24)),
                indicators: activePrediction.indicators || {},
                analysis: activePrediction.analysis,
                createdAt: activePrediction.createdAt,
                expiresAt: activePrediction.expiresAt,
                createdBy: activePrediction.user // Optional: show who started it
            }
        });
        
    } catch (error) {
        console.error('[Predictions] Error fetching active prediction:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch active prediction' });
    }
});

// @route   POST /api/predictions/predict
// @desc    Get or create prediction for a stock/crypto/DEX
// @access  Private (Starter+ required, limited by plan)
router.post('/predict', predictionLimiter, auth, requireSubscription('starter'), checkUsageLimit('dailySignals', 'Prediction'), async (req, res) => {
    try {
        let { symbol, days = 7, assetType, poolAddress, network, contractAddress } = req.body;

        if (!symbol) {
            return res.status(400).json({ error: 'Symbol is required' });
        }

        // Validate symbol to prevent SSRF/injection attacks
        const validationResult = validateSymbol(symbol);
        if (!validationResult.valid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid symbol',
                message: validationResult.error
            });
        }

        const originalSymbol = validationResult.sanitized;

        // If validateSymbol detected a contract address, auto-set as DEX
        if (validationResult.isContract && !assetType) {
            assetType = 'dex';
        }

        // Detect DEX tokens (format: SYMBOL:network like DYOR:bsc)
        let dexInfo = null;
        if (originalSymbol.includes(':')) {
            const parts = originalSymbol.split(':');
            symbol = parts[0];
            network = parts[1]?.toLowerCase() || network || 'bsc';
            assetType = 'dex';
            dexInfo = { network, poolAddress, contractAddress };
            console.log(`[Predictions] DEX token detected: ${symbol} on ${network}, contractAddress: ${contractAddress || 'none'}, poolAddress: ${poolAddress || 'none'}`);
        } else if (assetType === 'dex') {
            // Explicit DEX type passed
            symbol = originalSymbol;
            dexInfo = { network: network || 'bsc', poolAddress, contractAddress };
            console.log(`[Predictions] DEX token (explicit): ${symbol} on ${dexInfo.network}`);
        } else {
            // Detect contract addresses (EVM: 0x..., Solana: base58)
            const isContractAddress = /^0x[a-fA-F0-9]{40}$/i.test(originalSymbol) ||
                (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(originalSymbol) && !originalSymbol.startsWith('0x'));

            if (isContractAddress) {
                assetType = 'dex';
                symbol = originalSymbol.toLowerCase();
                dexInfo = { network: network || 'eth', poolAddress, contractAddress: symbol };
                console.log(`[Predictions] Contract address detected in predict: ${symbol.slice(0, 10)}... on ${dexInfo.network}`);
            } else {
                // Normalize symbol for stocks/crypto (handles BTC-USD, BTCUSD -> BTC for crypto)
                symbol = priceService.normalizeSymbol(originalSymbol);
                if (originalSymbol !== symbol) {
                    console.log(`[Predictions] Symbol normalized: ${originalSymbol} -> ${symbol}`);
                }

                // Auto-detect asset type
                if (!assetType) {
                    assetType = priceService.isCryptoSymbol(symbol) ? 'crypto' : 'stock';
                    console.log(`[Predictions] Auto-detected ${symbol} as ${assetType}`);
                }
            }
        }

        // For DEX tokens, use the full format for database storage
        const dbSymbol = assetType === 'dex' ? `${symbol}:${dexInfo?.network || 'bsc'}` : symbol;

        console.log(`[Predictions] Getting prediction for ${dbSymbol} (${assetType}), days: ${days}`);

        // ============ VALIDATE TICKER - Check if we can get a real price ============
        let currentPrice = null;
        let priceSource = null;
        let pricePoolAddress = null;
        try {
            const priceResult = await getFreshPrice(dbSymbol, assetType, dexInfo);
            currentPrice = priceResult.price;
            priceSource = priceResult.source;
            pricePoolAddress = priceResult.poolAddress;
            console.log(`[Predictions] Fresh price for ${dbSymbol}: $${currentPrice} (source: ${priceSource})`);
        } catch (priceError) {
            console.log(`[Predictions] Could not get price for ${dbSymbol}:`, priceError.message);
        }

        // ❌ REJECT INVALID TICKERS - If we can't get a price, the ticker is likely invalid
        if (!currentPrice || priceSource === 'error') {
            console.log(`[Predictions] ❌ Rejecting invalid ticker: ${dbSymbol}`);
            return res.status(400).json({
                error: 'Invalid symbol',
                message: `Could not find price data for "${dbSymbol}". Please check the ticker symbol and try again.`,
                symbol: dbSymbol
            });
        }
        // Check for existing SYSTEM signal first (any timeframe), then user predictions
        const existingPrediction = await Prediction.findOne({
            symbol: dbSymbol,
            status: 'pending',
            expiresAt: { $gt: new Date() },
            $or: [
                { user: null, isPublic: true },  // System signals (priority — any timeframe)
                { user: req.user.id, timeframe: days }  // User's own prediction (exact timeframe)
            ]
        }).sort({ user: 1, createdAt: -1 }); // user:null sorts first (system signals win)

        if (existingPrediction) {
            const isSystem = !existingPrediction.user;
            console.log(`[Predictions] ✅ Found existing ${isSystem ? 'SYSTEM' : 'user'} prediction for ${dbSymbol}`);
            
            // Get fresh price for display (use already fetched price, or refresh)
            const displayPrice = currentPrice || existingPrediction.currentPrice;
            
            // Calculate live stats
            const liveConfidence = calculateLiveConfidence(existingPrediction, displayPrice);
            const timeRemaining = Math.max(0, existingPrediction.expiresAt - Date.now());
            
            // Track that this user viewed/joined this prediction
            if (!existingPrediction.viewers) {
                existingPrediction.viewers = [];
            }
            if (!existingPrediction.viewers.includes(req.user.id)) {
                existingPrediction.viewers.push(req.user.id);
                existingPrediction.viewCount = (existingPrediction.viewCount || 0) + 1;
                await existingPrediction.save();
            }
            
            // Award small XP for joining shared prediction
            try {
                await GamificationService.awardXP(req.user.id, 5, `Joined shared prediction for ${dbSymbol}`);
            } catch (e) { /* ignore */ }
            
            return res.json({
                symbol: existingPrediction.symbol,
                current_price: displayPrice,
                prediction: {
                    target_price: existingPrediction.targetPrice,
                    direction: existingPrediction.direction,
                    price_change: existingPrediction.priceChange,
                    price_change_percent: existingPrediction.priceChangePercent,
                    confidence: existingPrediction.confidence,
                    signal_strength: existingPrediction.signalStrength || (existingPrediction.confidence >= 70 ? 'strong' : 'moderate'),
                    is_actionable: existingPrediction.confidence >= 55,
                    days: existingPrediction.timeframe
                },
                analysis: existingPrediction.analysis,
                indicators: existingPrediction.indicators || {},
                // Trade levels (locked at creation)
                entryPrice: existingPrediction.entryPrice,
                stopLoss: existingPrediction.stopLoss,
                takeProfit1: existingPrediction.takeProfit1,
                takeProfit2: existingPrediction.takeProfit2,
                takeProfit3: existingPrediction.takeProfit3,
                predictionId: existingPrediction._id,
                _id: existingPrediction._id,
                isShared: true,
                isSystemSignal: isSystem,
                sharedMessage: isSystem ? 'Active AI signal found — showing live tracked data.' : 'Prediction already in progress!',
                liveConfidence: isSystem ? existingPrediction.confidence : liveConfidence, // System signals use their own confidence
                livePrice: displayPrice,
                timeRemaining,
                daysRemaining: Math.ceil(timeRemaining / (1000 * 60 * 60 * 24)),
                viewCount: existingPrediction.viewCount || 1,
                createdAt: existingPrediction.createdAt,
                expiresAt: existingPrediction.expiresAt
            });
        }
        
        // ============ CREATE NEW PREDICTION ============
        console.log(`[Predictions] Creating new prediction for ${dbSymbol}`);

        // currentPrice is already set from validation above

        let predictionData;
        let formattedIndicators = {};

        // Try ML service if not using mocks (skip for DEX tokens - ML doesn't support them yet)
        if (!USE_MOCK_PREDICTIONS && assetType !== 'dex') {
            try {
                console.log(`[Predictions] Trying ML service at ${ML_SERVICE_URL}`);

                const mlResponse = await axios.post(`${ML_SERVICE_URL}/predict`, {
                    symbol: dbSymbol,
                    days: days,
                    type: assetType
                }, { timeout: 30000, headers: ML_HEADERS });
                
                if (mlResponse.data) {
                    const ml = mlResponse.data;
                    
                    const mlCurrentPrice = ml.currentPrice || ml.current_price || currentPrice;
                    const mlTargetPrice = ml.prediction?.targetPrice || ml.prediction?.target_price || ml.targetPrice || ml.target_price;
                    const mlDirection = ml.prediction?.direction || ml.direction || 'UP';
                    const mlConfidence = ml.prediction?.confidence || ml.confidence || 70;
                    
                    let validDirection = mlDirection.toUpperCase();
                    if (validDirection !== 'UP' && validDirection !== 'DOWN' && validDirection !== 'NEUTRAL') {
                        validDirection = mlTargetPrice >= mlCurrentPrice ? 'UP' : 'DOWN';
                    }

                    // Get signal strength from ML
                    const mlSignalStrength = ml.prediction?.signal_strength || ml.signal_strength;
                    const mlIsActionable = ml.prediction?.is_actionable !== undefined ? ml.prediction.is_actionable : ml.is_actionable;
                    const mlWarning = ml.warning;
                    
                    // Use fresh price, not ML's potentially stale price
                    const finalCurrentPrice = currentPrice || mlCurrentPrice;
                    const finalTargetPrice = mlTargetPrice || (finalCurrentPrice * (1 + (validDirection === 'UP' ? 0.05 : -0.05)));
                    const finalPriceChange = finalTargetPrice - finalCurrentPrice;
                    const finalPercentChange = (finalPriceChange / finalCurrentPrice) * 100;

                    // Get indicators from ML
                    if (ml.indicators && Object.keys(ml.indicators).length > 0) {
                        formattedIndicators = ml.indicators;
                    }
                    
                    if (finalCurrentPrice && finalTargetPrice) {
                        predictionData = {
                            symbol: dbSymbol,
                            current_price: parseFloat(finalCurrentPrice),
                            prediction: {
                                target_price: parseFloat(finalTargetPrice),
                                direction: validDirection,
                                price_change: parseFloat(finalPriceChange),
                                price_change_percent: parseFloat(finalPercentChange.toFixed(2)),
                                confidence: parseFloat(mlConfidence),
                                days: days,
                                // Signal strength fields from ML
                                signal_strength: mlSignalStrength,
                                is_actionable: mlIsActionable
                            },
                            analysis: ml.analysis || {
                                trend: validDirection === 'UP' ? 'Bullish' : (validDirection === 'NEUTRAL' ? 'Neutral' : 'Bearish'),
                                volatility: 'Moderate',
                                risk_level: validDirection === 'NEUTRAL' ? 'Low Signal' : 'Medium'
                            },
                            indicators: formattedIndicators,
                            warning: mlWarning // Include warning for weak signals
                        };
                    }
                }
            } catch (mlError) {
                console.log(`[Predictions] ML service unavailable:`, mlError.message);
            }
        }
        
        // Fallback to mock prediction
        if (!predictionData) {
            console.log(`[Predictions] Using generated prediction for ${dbSymbol}`);
            predictionData = generateMockPrediction(dbSymbol, days, currentPrice);
            formattedIndicators = predictionData.indicators;
        }

        // Ensure current price is accurate
        if (currentPrice && predictionData.current_price !== currentPrice) {
            // Recalculate with fresh price
            const direction = predictionData.prediction.direction;
            const percentChange = predictionData.prediction.price_change_percent;
            const newTargetPrice = currentPrice * (1 + percentChange / 100);
            
            predictionData.current_price = currentPrice;
            predictionData.prediction.target_price = parseFloat(newTargetPrice);
            predictionData.prediction.price_change = parseFloat(newTargetPrice - currentPrice);
        }
        
        // Guarantee indicators
        if (!formattedIndicators || Object.keys(formattedIndicators).length === 0) {
            formattedIndicators = generateMockIndicators(
                predictionData.current_price, 
                predictionData.prediction.direction
            );
        }

        predictionData.indicators = formattedIndicators;
        
        // Save prediction to database
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + days);

        // Lock trade levels (same logic as signalGenerator)
        const entryPrice = predictionData.current_price;
        const targetPrice = predictionData.prediction.target_price;
        const rawRange = Math.abs(targetPrice - entryPrice);
        const minRange = entryPrice * 0.02;
        const range = Math.max(rawRange, minRange);
        const isLong = predictionData.prediction.direction === 'UP';
        const slDistance = Math.max(range * 0.25, entryPrice * 0.015);

        // Build prediction data object
        const predictionRecord = {
            user: req.user.id,
            symbol: dbSymbol,
            assetType,
            currentPrice: entryPrice,
            targetPrice,
            entryPrice,
            stopLoss: isLong ? entryPrice - slDistance : entryPrice + slDistance,
            takeProfit1: isLong ? entryPrice + range * 0.5 : entryPrice - range * 0.5,
            takeProfit2: isLong ? entryPrice + range : entryPrice - range,
            takeProfit3: isLong ? entryPrice + range * 1.75 : entryPrice - range * 1.75,
            livePrice: entryPrice,
            livePriceUpdatedAt: new Date(),
            direction: predictionData.prediction.direction === 'NEUTRAL'
                ? (predictionData.prediction.price_change_percent >= 0 ? 'UP' : 'DOWN')
                : predictionData.prediction.direction,
            priceChange: predictionData.prediction.price_change,
            priceChangePercent: predictionData.prediction.price_change_percent,
            confidence: predictionData.prediction.confidence,
            signalStrength: predictionData.prediction.signal_strength || 'moderate',
            isActionable: predictionData.prediction.is_actionable !== false,
            timeframe: days,
            indicators: formattedIndicators,
            analysis: {
                trend: predictionData.analysis?.trend,
                volatility: predictionData.analysis?.volatility,
                riskLevel: predictionData.analysis?.risk_level,
                message: predictionData.analysis?.message
            },
            expiresAt,
            isPublic: false, // User predictions are NOT public (don't show in feed)
            viewers: [req.user.id],
            viewCount: 1
        };

        // Add DEX-specific fields if applicable
        if (assetType === 'dex' && dexInfo) {
            predictionRecord.dexInfo = {
                network: dexInfo.network,
                poolAddress: pricePoolAddress || dexInfo.poolAddress,
                contractAddress: dexInfo.contractAddress
            };
        }

        const prediction = new Prediction(predictionRecord);

        await prediction.save();

        console.log(`[Predictions] ✅ Created NEW prediction ${prediction._id} for ${dbSymbol}`);
        console.log(`[Predictions] Price: $${predictionData.current_price}, Target: $${predictionData.prediction.target_price}`);

        // Copy Trading: Auto-copy this prediction to all copiers
        try {
            const copyResult = await CopyTradingService.processPredictionForCopiers(prediction, req.user.id);
            if (copyResult.copied > 0) {
                console.log(`[Predictions] Copy trading: ${copyResult.copied} users copied this prediction`);
            }
        } catch (copyError) {
            console.warn('[Predictions] Copy trading error:', copyError.message);
        }

        // Gamification
        try {
            await GamificationService.trackPrediction(req.user.id);
            await GamificationService.awardXP(req.user.id, 15, `Started prediction for ${dbSymbol}`);
        } catch (gamError) {
            console.warn('[Predictions] Gamification error:', gamError.message);
        }

        // Send Telegram alert for high-confidence predictions (>70%)
        const confidencePercent = predictionData.prediction.confidence;
        if (confidencePercent >= 70) {
            try {
                // Helper to safely extract indicator values (handles nested objects)
                const getIndicatorValue = (indicator) => {
                    if (indicator === null || indicator === undefined) return null;
                    if (typeof indicator === 'object' && indicator.value !== undefined) {
                        // Standard format: { value: X, signal: Y }
                        const val = indicator.value;
                        // If value is itself an object, stringify it
                        return typeof val === 'object' ? JSON.stringify(val) : val;
                    }
                    // Direct value (number or string)
                    return typeof indicator === 'object' ? JSON.stringify(indicator) : indicator;
                };

                const getIndicatorSignal = (indicator) => {
                    if (indicator === null || indicator === undefined) return 'NEUTRAL';
                    if (typeof indicator === 'object' && indicator.signal !== undefined) {
                        return String(indicator.signal).toUpperCase();
                    }
                    return 'NEUTRAL';
                };

                // Build factors from actual indicators
                const factors = [];
                const ind = formattedIndicators;

                if (ind['RSI']) {
                    const rsiVal = getIndicatorValue(ind['RSI']);
                    const rsiSignal = getIndicatorSignal(ind['RSI']);
                    if (rsiVal !== null) {
                        factors.push(`RSI: ${rsiVal} (${rsiSignal})`);
                    }
                }
                if (ind['MACD']) {
                    const macdVal = getIndicatorValue(ind['MACD']);
                    const macdSignal = getIndicatorSignal(ind['MACD']);
                    if (macdVal !== null) {
                        const prefix = typeof macdVal === 'number' && macdVal > 0 ? '+' : '';
                        factors.push(`MACD: ${prefix}${macdVal} (${macdSignal})`);
                    }
                }
                if (ind['SMA 20'] && ind['SMA 50']) {
                    const sma20Signal = getIndicatorSignal(ind['SMA 20']);
                    const sma50Signal = getIndicatorSignal(ind['SMA 50']);
                    const smaSignal = sma20Signal === sma50Signal ? sma20Signal : 'MIXED';
                    factors.push(`Moving Averages: ${smaSignal}`);
                }
                if (ind['Bollinger']) {
                    const bbVal = getIndicatorValue(ind['Bollinger']);
                    if (bbVal !== null) {
                        factors.push(`Bollinger: ${bbVal}`);
                    }
                }
                if (ind['Stochastic']) {
                    const stochVal = getIndicatorValue(ind['Stochastic']);
                    const stochSignal = getIndicatorSignal(ind['Stochastic']);
                    if (stochVal !== null) {
                        factors.push(`Stochastic: ${stochVal} (${stochSignal})`);
                    }
                }
                if (ind['Volume']) {
                    const volVal = getIndicatorValue(ind['Volume']);
                    if (volVal !== null) {
                        factors.push(`Volume: ${volVal}`);
                    }
                }
                if (ind['Trend']) {
                    const trendVal = getIndicatorValue(ind['Trend']);
                    if (trendVal !== null) {
                        factors.push(`Trend: ${trendVal}`);
                    }
                }

                const alertPayload = {
                    symbol: dbSymbol,
                    direction: predictionData.prediction.direction,
                    confidence: confidencePercent, // Send raw percentage (matches website display)
                    currentPrice: predictionData.current_price,
                    targetPrice: predictionData.prediction.target_price,
                    stopLoss: predictionData.prediction.stop_loss,
                    timeframe: `${days} day${days > 1 ? 's' : ''}`,
                    factors: factors.length > 0 ? factors : ['Technical analysis', 'Price momentum']
                };

                // Send Telegram alert
                await sendMLPredictionAlert(alertPayload);
                console.log(`[Predictions] 📱 Telegram alert sent for ${dbSymbol} (${confidencePercent}% confidence)`);

                // Send Discord alert
                try {
                    await sendDiscordMLPredictionAlert(alertPayload);
                    console.log(`[Predictions] 🎮 Discord alert sent for ${dbSymbol} (${confidencePercent}% confidence)`);
                } catch (discordError) {
                    console.warn('[Predictions] Discord alert error:', discordError.message);
                }
            } catch (telegramError) {
                console.warn('[Predictions] Telegram alert error:', telegramError.message);
            }
        }

        res.json({
            ...predictionData,
            indicators: formattedIndicators,
            predictionId: prediction._id,
            _id: prediction._id,
            isShared: false,
            isNew: true,
            message: 'New prediction created!'
        });
        
    } catch (error) {
        console.error('[Predictions] ❌ Error:', error.message);
        return res.status(500).json({ error: 'Prediction service error', message: error.message });
    }
});

// @route   GET /api/predictions/live/:id
// @desc    Get live prediction update with current confidence
// @access  Private
router.get('/live/:id', predictionLimiter, auth, requireSubscription('starter'), async (req, res) => {
    try {
        const prediction = await Prediction.findOne({ _id: req.params.id, $or: [{ user: req.user.id }, { user: null, isPublic: true }] });
        
        if (!prediction) {
            return res.status(404).json({ error: 'Prediction not found' });
        }

        // For shared predictions, allow anyone to view
        // (Remove this check if you want strict ownership)
        // if (prediction.user.toString() !== req.user.id) {
        //     return res.status(403).json({ error: 'Not authorized' });
        // }

        // Get FRESH price
        const priceResult = await getFreshPrice(prediction.symbol, prediction.assetType);
        const currentPrice = priceResult.price || prediction.currentPrice;

        const liveConfidence = calculateLiveConfidence(prediction, currentPrice);
        
        const now = Date.now();
        const timeRemaining = Math.max(0, prediction.expiresAt - now);
        const hasExpired = timeRemaining === 0;

        if (hasExpired && prediction.status === 'pending' && prediction.user) {
            await prediction.calculateOutcome(currentPrice);
            // Update copied prediction outcomes
            try {
                await CopyTradingService.updateCopiedPredictionOutcomes(prediction);
            } catch (copyErr) {
                console.warn('[Predictions] Error updating copy outcomes:', copyErr.message);
            }
        }

        res.json({
            success: true,
            prediction: {
                ...prediction.toObject(),
                livePrice: currentPrice,
                currentPrice: currentPrice,
                liveConfidence,
                liveChange: currentPrice - prediction.currentPrice,
                liveChangePercent: ((currentPrice - prediction.currentPrice) / prediction.currentPrice) * 100,
                timeRemaining,
                hasExpired,
                daysRemaining: Math.ceil(timeRemaining / (1000 * 60 * 60 * 24)),
                updatedAt: new Date().toISOString(),
                priceSource: priceResult.source
            }
        });
    } catch (error) {
        console.error('[Live] Error:', error);
        res.status(500).json({ error: 'Failed to get live prediction' });
    }
});

// @route   GET /api/predictions/shared
// @desc    Get all active shared predictions
// @access  Public
router.get('/shared', predictionLimiter, auth, requireSubscription('starter'), async (req, res) => {
    try {
        const { limit = 20 } = req.query;
        
        const activePredictions = await Prediction.find({
            user: null, isPublic: true,
            status: 'pending',
            expiresAt: { $gt: new Date() }
        })
        .sort({ viewCount: -1, createdAt: -1 }) // Most popular first
        .limit(Math.max(1, Math.min(200, parseInt(limit, 10) || 20)))
        .populate('user', 'username avatar');
        
        // Get fresh prices for all
        const predictionsWithPrices = await Promise.all(
            activePredictions.map(async (pred) => {
                const priceResult = await getFreshPrice(pred.symbol, pred.assetType);
                const currentPrice = priceResult.price || pred.currentPrice;
                const liveConfidence = calculateLiveConfidence(pred, currentPrice);
                const timeRemaining = Math.max(0, pred.expiresAt - Date.now());
                
                return {
                    _id: pred._id,
                    symbol: pred.symbol,
                    direction: pred.direction,
                    targetPrice: pred.targetPrice,
                    currentPrice: currentPrice,
                    livePrice: currentPrice,
                    liveConfidence,
                    confidence: pred.confidence,
                    timeRemaining,
                    daysRemaining: Math.ceil(timeRemaining / (1000 * 60 * 60 * 24)),
                    viewCount: pred.viewCount || 0,
                    createdBy: pred.user?.username || 'Anonymous',
                    createdAt: pred.createdAt,
                    expiresAt: pred.expiresAt
                };
            })
        );
        
        res.json({
            success: true,
            predictions: predictionsWithPrices
        });
    } catch (error) {
        console.error('[Predictions] Error fetching shared:', error);
        res.status(500).json({ error: 'Failed to fetch shared predictions' });
    }
});

// ============ REMAINING ROUTES (unchanged) ============

router.post('/check-outcomes', predictionLimiter, auth, async (req, res) => {
    try {
        const predictions = await Prediction.find({
            user: req.user.id,
            status: 'pending',
            expiresAt: { $lt: Date.now() }
        });

        const results = [];

        for (const prediction of predictions) {
            try {
                const priceResult = await getFreshPrice(prediction.symbol, prediction.assetType);
                if (!priceResult.price) continue;

                await prediction.calculateOutcome(priceResult.price);

                // Update copied prediction outcomes
                try {
                    await CopyTradingService.updateCopiedPredictionOutcomes(prediction);
                } catch (copyErr) {
                    console.warn('[Check] Error updating copy outcomes:', copyErr.message);
                }

                results.push({
                    symbol: prediction.symbol,
                    wasCorrect: prediction.outcome.wasCorrect,
                    accuracy: prediction.outcome.accuracy
                });

                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.error(`[Check] Error checking ${prediction.symbol}:`, error.message);
            }
        }

        res.json({ success: true, checkedCount: results.length, results });
    } catch (error) {
        console.error('[Check] Error:', error);
        res.status(500).json({ error: 'Failed to check outcomes' });
    }
});

router.get('/history', predictionLimiter, auth, async (req, res) => {
    try {
        const { limit = 20, status } = req.query;
        const query = { user: req.user.id };
        // Sanitize status to prevent NoSQL injection (only allow string values)
        if (status && typeof status === 'string') {
            // Only allow valid status values
            const validStatuses = ['pending', 'completed', 'expired', 'correct', 'incorrect'];
            if (validStatuses.includes(status)) {
                query.status = status;
            }
        }

        const predictions = await Prediction.find(query)
            .sort({ createdAt: -1 })
            .limit(Math.max(1, Math.min(200, parseInt(limit, 10) || 20)));

        res.json({ success: true, predictions });
    } catch (error) {
        console.error('[Predictions] Error fetching history:', error);
        res.status(500).json({ error: 'Failed to fetch prediction history' });
    }
});

// @route   GET /api/predictions/recent-public
// @desc    Get recent predictions for landing page (no auth required)
// @access  Public
router.get('/recent-public', predictionLimiter, auth, requireSubscription('starter'), async (req, res) => {
    try {
        const { limit = 5 } = req.query;
        
        // Get recent predictions (hide user info for privacy)
        const predictions = await Prediction.find({ status: 'pending', user: null, isPublic: true })
            .sort({ createdAt: -1 })
            .limit(Math.max(1, Math.min(200, parseInt(limit, 10) || 20)))
            .select('symbol direction targetPrice confidence createdAt expiresAt')
            .lean();
        
        res.json(predictions);
    } catch (error) {
        console.error('[Predictions] Error fetching public recent:', error.message);
        res.status(500).json({ error: 'Failed to fetch recent predictions' });
    }
});

// Also handle /recent without auth for landing page
// Price cache for /recent endpoint (60 second TTL)
const recentPriceCache = new Map();
const RECENT_CACHE_TTL = 60000; // 60 seconds

router.get('/recent', predictionLimiter, async (req, res) => {
    try {
        const { limit = 10 } = req.query;

        // Check if user is authenticated
        let userId = null;
        try {
            const token = req.header('Authorization')?.replace('Bearer ', '') || req.header('x-auth-token');
            if (token) {
                const jwt = require('jsonwebtoken');
                const decoded = verifyAccessToken(token);
                userId = decoded.user?.id || decoded.id;
            }
        } catch (e) { /* No valid token */ }

        let predictions;
        const systemQuery = { user: null, isPublic: true };
        const fields = 'symbol direction targetPrice currentPrice entryPrice stopLoss takeProfit1 takeProfit2 takeProfit3 livePrice livePriceUpdatedAt confidence createdAt expiresAt status assetType indicators analysis signalStrength priceChangePercent result resultText resultPrice resultAt';

        // Live Signal Feed: ONLY system signals (user=null)
        // User predictions stay on the AI Predict page, not the feed
        predictions = await Prediction.find(systemQuery)
            .sort({ createdAt: -1 })
            .limit(Math.max(1, Math.min(200, parseInt(limit, 10) || 20)))
            .select(fields)
            .lean();

        // Fetch live prices for active predictions (with caching)
        // Skip price fetching for closed signals (they have resultPrice)
        // Skip if livePrice was updated recently by signalResultChecker
        const now = Date.now();
        const LIVE_PRICE_FRESH = 5 * 60 * 1000; // 5 minutes — matches signalResultChecker interval
        const predictionsWithLivePrices = await Promise.all(
            predictions.map(async (pred) => {
                const entryPrice = pred.entryPrice || pred.currentPrice;
                const isClosed = pred.result === 'win' || pred.result === 'loss' || pred.status === 'correct' || pred.status === 'incorrect';

                // Closed signals: use resultPrice, no need to fetch live
                if (isClosed) {
                    const closedPrice = pred.resultPrice || pred.livePrice || entryPrice;
                    return {
                        ...pred,
                        entryPrice,
                        livePrice: closedPrice,
                        liveChange: closedPrice - entryPrice,
                        liveChangePercent: entryPrice > 0 ? ((closedPrice - entryPrice) / entryPrice) * 100 : 0,
                    };
                }

                // Active signals: use cached/DB livePrice if recent enough
                const dbLiveFresh = pred.livePriceUpdatedAt && (now - new Date(pred.livePriceUpdatedAt).getTime()) < LIVE_PRICE_FRESH;
                if (dbLiveFresh && pred.livePrice > 0) {
                    return {
                        ...pred,
                        entryPrice,
                        livePrice: pred.livePrice,
                        liveChange: pred.livePrice - entryPrice,
                        liveChangePercent: entryPrice > 0 ? ((pred.livePrice - entryPrice) / entryPrice) * 100 : 0,
                        priceUpdatedAt: pred.livePriceUpdatedAt,
                    };
                }

                // Fetch fresh price
                const cacheKey = `${pred.symbol}-${pred.assetType}`;
                const cached = recentPriceCache.get(cacheKey);
                let livePrice = null;

                if (cached && (now - cached.ts) < RECENT_CACHE_TTL) {
                    livePrice = cached.price;
                } else {
                    try {
                        const priceResult = await getFreshPrice(pred.symbol, pred.assetType, pred.dexInfo);
                        if (priceResult?.price > 0) {
                            livePrice = priceResult.price;
                            recentPriceCache.set(cacheKey, { price: livePrice, ts: now });
                        }
                    } catch (e) {
                        // Use DB livePrice as fallback
                    }
                }

                const finalPrice = livePrice || pred.livePrice || entryPrice;
                return {
                    ...pred,
                    entryPrice,
                    livePrice: finalPrice,
                    liveChange: finalPrice - entryPrice,
                    liveChangePercent: entryPrice > 0 ? ((finalPrice - entryPrice) / entryPrice) * 100 : 0,
                    priceUpdatedAt: livePrice ? new Date().toISOString() : pred.livePriceUpdatedAt,
                };
            })
        );

        // Clean old cache entries (keep max 200)
        if (recentPriceCache.size > 200) {
            const entries = [...recentPriceCache.entries()];
            entries.sort((a, b) => a[1].ts - b[1].ts);
            entries.slice(0, 100).forEach(([key]) => recentPriceCache.delete(key));
        }

        // Cap confidence at 95% on all responses
        const capped = predictionsWithLivePrices.map(p => ({
            ...p,
            confidence: Math.min(95, p.confidence || 0)
        }));
        res.json(capped);
    } catch (error) {
        console.error('[Predictions] Error fetching recent:', error.message);
        res.status(500).json({ error: 'Failed to fetch recent predictions' });
    }
});

// Public performance data (no auth — used by Live Performance Tracker)
router.get('/performance', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 200, 500);
        const systemQuery = { user: null, isPublic: true };
        const total = await Prediction.countDocuments(systemQuery);
        const wins = await Prediction.countDocuments({ ...systemQuery, result: 'win' });
        const losses = await Prediction.countDocuments({ ...systemQuery, result: 'loss' });
        const active = await Prediction.countDocuments({ ...systemQuery, status: 'pending', expiresAt: { $gt: new Date() } });
        const closed = wins + losses;
        const winRate = closed > 0 ? Math.round((wins / closed) * 100) : 0;

        // Get all closed trades for avg calculations + equity curve
        const closedTrades = await Prediction.find({
            ...systemQuery,
            result: { $in: ['win', 'loss'] },
            entryPrice: { $gt: 0 },
            resultPrice: { $gt: 0 },
        }).sort({ resultAt: 1 }).select('symbol direction entryPrice resultPrice result resultText confidence assetType createdAt resultAt').lean();

        // Calculate returns
        let totalReturnPct = 0;
        let winReturns = [];
        let lossReturns = [];
        const equityCurve = [];
        let cumReturn = 0;

        for (const t of closedTrades) {
            const isLong = t.direction === 'UP';
            const rawPct = ((t.resultPrice - t.entryPrice) / t.entryPrice) * 100;
            const pct = isLong ? rawPct : -rawPct;
            totalReturnPct += pct;
            cumReturn += pct;

            if (t.result === 'win') winReturns.push(pct);
            else lossReturns.push(pct);

            equityCurve.push({
                date: t.resultAt || t.createdAt,
                cumReturn: Math.round(cumReturn * 100) / 100,
                symbol: t.symbol,
                result: t.result,
                pct: Math.round(pct * 100) / 100,
            });
        }

        const avgReturn = closed > 0 ? totalReturnPct / closed : 0;
        const avgWin = winReturns.length > 0 ? winReturns.reduce((a, b) => a + b, 0) / winReturns.length : 0;
        const avgLoss = lossReturns.length > 0 ? lossReturns.reduce((a, b) => a + b, 0) / lossReturns.length : 0;
        const edge = closed > 0 ? (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss : 0;

        // Recent trades (last 30 days + active, up to limit)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // Get open/pending trades
        const openTrades = await Prediction.find({
            ...systemQuery,
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).sort({ createdAt: -1 }).select(
            'symbol direction entryPrice stopLoss takeProfit1 takeProfit2 takeProfit3 resultPrice livePrice result resultText confidence assetType status createdAt resultAt expiresAt'
        ).lean();

        // Get closed trades from last 30 days
        const recentClosedTrades = await Prediction.find({
            ...systemQuery,
            result: { $in: ['win', 'loss'] },
            resultAt: { $gte: thirtyDaysAgo }
        }).sort({ resultAt: -1 }).limit(limit).select(
            'symbol direction entryPrice stopLoss takeProfit1 takeProfit2 takeProfit3 resultPrice livePrice result resultText confidence assetType status createdAt resultAt expiresAt'
        ).lean();

        const recentTrades = [...openTrades, ...recentClosedTrades].slice(0, limit);

        // 7-day rolling performance
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recent7d = closedTrades.filter(t => new Date(t.resultAt || t.createdAt) > sevenDaysAgo);
        const wins7d = recent7d.filter(t => t.result === 'win').length;
        const closed7d = recent7d.length;
        const winRate7d = closed7d > 0 ? Math.round((wins7d / closed7d) * 100) : 0;

        res.json({
            success: true,
            stats: { total, wins, losses, active, closed, winRate, avgReturn: Math.round(avgReturn * 100) / 100, totalReturn: Math.round(totalReturnPct * 100) / 100, avgWin: Math.round(avgWin * 100) / 100, avgLoss: Math.round(avgLoss * 100) / 100, edge: Math.round(edge * 100) / 100 },
            rolling7d: { wins: wins7d, losses: closed7d - wins7d, closed: closed7d, winRate: winRate7d },
            equityCurve,
            trades: recentTrades.map(t => {
                const isLong = t.direction === 'UP';
                const currentPrice = t.resultPrice || t.livePrice || t.entryPrice;
                const rawPct = t.entryPrice > 0 ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100 : 0;
                const changePct = isLong ? rawPct : -rawPct;
                return { ...t, changePct: Math.round(changePct * 100) / 100, confidence: Math.min(95, t.confidence || 50), currentPrice, exitPrice: t.resultPrice || null };
            })
        });
    } catch (e) {
        console.error('[Performance] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Archived trades (older than 30 days)
router.get('/performance/archived', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 200, 500);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const systemQuery = { user: null, isPublic: true };

        const archivedTrades = await Prediction.find({
            ...systemQuery,
            result: { $in: ['win', 'loss'] },
            resultAt: { $lt: thirtyDaysAgo }
        }).sort({ resultAt: -1 }).limit(limit).select(
            'symbol direction entryPrice stopLoss takeProfit1 takeProfit2 takeProfit3 resultPrice livePrice result resultText confidence assetType status createdAt resultAt expiresAt'
        ).lean();

        // Calculate archived stats
        const wins = archivedTrades.filter(t => t.result === 'win').length;
        const losses = archivedTrades.filter(t => t.result === 'loss').length;
        const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;

        // Calculate total return
        let totalReturn = 0;
        const tradesWithPct = archivedTrades.map(t => {
            const isLong = t.direction === 'UP';
            const currentPrice = t.resultPrice || t.livePrice || t.entryPrice;
            const rawPct = t.entryPrice > 0 ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100 : 0;
            const changePct = isLong ? rawPct : -rawPct;
            totalReturn += changePct;
            return { ...t, changePct: Math.round(changePct * 100) / 100, confidence: Math.min(95, t.confidence || 50), currentPrice, exitPrice: t.resultPrice || null };
        });

        res.json({
            success: true,
            trades: tradesWithPct,
            stats: {
                total: archivedTrades.length,
                wins,
                losses,
                winRate,
                totalReturn: Math.round(totalReturn * 100) / 100
            }
        });
    } catch (e) {
        console.error('[Performance/Archived] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Public platform stats (no auth — used by Live Signal Feed)
router.get('/stats', async (req, res) => {
    try {
        const total = await Prediction.countDocuments({ user: null, isPublic: true });
        const wins = await Prediction.countDocuments({ user: null, isPublic: true, result: 'win' });
        const losses = await Prediction.countDocuments({ user: null, isPublic: true, result: 'loss' });
        const active = await Prediction.countDocuments({ user: null, isPublic: true, status: 'pending', expiresAt: { $gt: new Date() } });
        const closed = wins + losses;
        const winRate = closed > 0 ? Math.round((wins / closed) * 100) : 0;
        res.json({ success: true, total, wins, losses, active, closed, winRate });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// User's personal prediction accuracy (auth required)
router.get('/stats/me', predictionLimiter, auth, async (req, res) => {
    try {
        const stats = await Prediction.getUserAccuracy(req.user.id);
        res.json(stats);
    } catch (error) {
        console.error('[Predictions] Error fetching stats:', error.message);
        res.status(500).json({ error: 'Failed to fetch prediction stats' });
    }
});

// Public: get any user's predictions by userId
router.get('/user/:userId', predictionLimiter, auth, async (req, res) => {
    try {
        const { limit = 20 } = req.query;
        const predictions = await Prediction.find({ user: req.params.userId, ...(String(req.user.id) === req.params.userId ? {} : { isPublic: true }) })
            .sort({ createdAt: -1 })
            .limit(Math.max(1, Math.min(200, parseInt(limit, 10) || 20)))
            .select('symbol direction targetPrice currentPrice entryPrice stopLoss takeProfit1 takeProfit2 takeProfit3 confidence status result resultText resultPrice resultAt assetType timeframe createdAt expiresAt signalStrength')
            .lean();
        res.json(predictions);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/user', predictionLimiter, auth, async (req, res) => {
    try {
        const { limit = 5 } = req.query;
        
        const predictions = await Prediction.find({ user: req.user.id })
            .sort({ createdAt: -1 })
            .limit(Math.max(1, Math.min(200, parseInt(limit, 10) || 20)));
        
        const stats = await Prediction.getUserAccuracy(req.user.id);
        
        const statusCounts = await Prediction.aggregate([
            { $match: { user: req.user.id } },
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        
        const counts = { pending: 0, correct: 0, incorrect: 0, total: 0 };
        statusCounts.forEach(item => {
            counts[item._id] = item.count;
            counts.total += item.count;
        });
        
        res.json({
            success: true,
            predictions,
            stats: {
                accuracy: stats.accuracy || 0,
                totalPredictions: stats.totalPredictions || counts.total,
                correctPredictions: stats.correctPredictions || counts.correct,
                pendingPredictions: counts.pending
            }
        });
    } catch (error) {
        console.error('[Predictions] Error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch user predictions' });
    }
});

router.get('/platform-stats', async (req, res) => {
    try {
        const stats = await Prediction.getPlatformAccuracy();
        res.json({
            success: true,
            accuracy: stats.accuracy || 0,
            totalPredictions: stats.totalPredictions || 0,
            correctPredictions: stats.correctPredictions || 0
        });
    } catch (error) {
        console.error('[Predictions] Error:', error.message);
        res.status(500).json({ success: false, accuracy: 0, totalPredictions: 0, correctPredictions: 0 });
    }
});

router.get('/trending', auth, requireSubscription('starter'), async (req, res) => {
    try {
        const { limit = 10 } = req.query;
        const trending = await Prediction.getTrending(Math.max(1, Math.min(200, parseInt(limit, 10) || 20)));
        res.json(trending);
    } catch (error) {
        console.error('[Predictions] Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch trending predictions' });
    }
});

router.get('/health', predictionLimiter, auth, async (req, res) => {
    try {
        let mlStatus = 'unknown';
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/health`, { timeout: 5000, headers: ML_HEADERS });
            mlStatus = 'healthy';
        } catch (e) {
            mlStatus = 'unhealthy';
        }
        
        const cacheStats = priceService.getCacheStats();
        
        res.json({
            ml_service: mlStatus,
            ml_url: ML_SERVICE_URL,
            mock_mode: USE_MOCK_PREDICTIONS,
            price_cache: cacheStats
        });
    } catch (error) {
        res.json({ ml_service: 'error', error: error.message });
    }
});

router.get('/price/:symbol', predictionLimiter, auth, async (req, res) => {
    try {
        // Validate symbol to prevent SSRF/injection attacks
        let symbol;
        try {
            symbol = sanitizeSymbol(req.params.symbol);
        } catch (validationError) {
            return res.status(400).json({
                success: false,
                error: 'Invalid symbol',
                message: validationError.message
            });
        }

        const { type } = req.query;

        const result = await getFreshPrice(symbol, type || (priceService.isCryptoSymbol(symbol) ? 'crypto' : 'stock'));
        
        if (result.price === null) {
            return res.status(404).json({ success: false, error: `Could not fetch price for ${symbol}` });
        }
        
        res.json({
            success: true,
            symbol: symbol.toUpperCase(),
            price: result.price,
            source: result.source
        });
    } catch (error) {
        console.error('[Predictions] Price fetch error:', error.message);
        res.status(500).json({ error: 'Failed to fetch price' });
    }
});

// ============ CLEANUP ROUTES ============

// @route   POST /api/predictions/cleanup
// @desc    Run cleanup to remove stale/invalid predictions
// @access  Private (admin only in production)
router.post('/cleanup', predictionLimiter, auth, requireAdmin, async (req, res) => {
    return res.status(410).json({ error: 'Historical cleanup is disabled. Use a reviewed offline migration.' });
});

// @route   GET /api/predictions/cleanup/stats
// @desc    Get cleanup statistics
// @access  Private
router.get('/cleanup/stats', predictionLimiter, auth, async (req, res) => {
    try {
        const now = new Date();
        const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
        
        const stats = {
            totalPredictions: await Prediction.countDocuments(),
            pendingPredictions: await Prediction.countDocuments({ status: 'pending' }),
            correctPredictions: await Prediction.countDocuments({ status: 'correct' }),
            incorrectPredictions: await Prediction.countDocuments({ status: 'incorrect' }),
            expiredPending: await Prediction.countDocuments({ 
                status: 'pending', 
                expiresAt: { $lt: now } 
            }),
            stalePredictions: await Prediction.countDocuments({
                status: 'pending',
                expiresAt: { $lt: now },
                createdAt: { $lt: oneDayAgo }
            }),
            markedForDeletion: await Prediction.countDocuments({
                deleteAfter: { $ne: null, $lt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) }
            }),
            cacheStats: priceService.getCacheStats ? priceService.getCacheStats() : null
        };
        
        res.json({ success: true, stats });
    } catch (error) {
        console.error('[Cleanup] Stats error:', error.message);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// @route   GET /api/predictions/accuracy-dashboard
// @desc    Get comprehensive accuracy dashboard data
// @access  Private
router.get('/accuracy-dashboard', predictionLimiter, auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date();

        // Get all resolved predictions for the user
        const allPredictions = await Prediction.find({
            user: userId,
            status: { $in: ['correct', 'incorrect'] }
        }).sort({ createdAt: -1 });

        // Get pending predictions
        const pendingPredictions = await Prediction.find({
            user: userId,
            status: 'pending'
        }).sort({ expiresAt: 1 });

        // Calculate overall stats
        const totalResolved = allPredictions.length;
        const correctCount = allPredictions.filter(p => p.status === 'correct').length;
        const overallAccuracy = totalResolved > 0 ? (correctCount / totalResolved) * 100 : 0;
        const avgConfidence = totalResolved > 0
            ? allPredictions.reduce((sum, p) => sum + (p.confidence || 0), 0) / totalResolved
            : 0;

        // Calculate accuracy by asset type
        const byAssetType = {};
        ['stock', 'crypto', 'dex'].forEach(type => {
            const typePredictions = allPredictions.filter(p => p.assetType === type);
            const typeCorrect = typePredictions.filter(p => p.status === 'correct').length;
            byAssetType[type] = {
                total: typePredictions.length,
                correct: typeCorrect,
                accuracy: typePredictions.length > 0 ? (typeCorrect / typePredictions.length) * 100 : 0
            };
        });

        // Calculate accuracy by direction
        const byDirection = {};
        ['UP', 'DOWN'].forEach(dir => {
            const dirPredictions = allPredictions.filter(p => p.direction === dir);
            const dirCorrect = dirPredictions.filter(p => p.status === 'correct').length;
            byDirection[dir] = {
                total: dirPredictions.length,
                correct: dirCorrect,
                accuracy: dirPredictions.length > 0 ? (dirCorrect / dirPredictions.length) * 100 : 0
            };
        });

        // Calculate accuracy over time (last 30 days, grouped by week)
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
        const recentPredictions = allPredictions.filter(p => p.createdAt >= thirtyDaysAgo);

        const weeklyStats = [];
        for (let i = 0; i < 4; i++) {
            const weekStart = new Date(now - (i + 1) * 7 * 24 * 60 * 60 * 1000);
            const weekEnd = new Date(now - i * 7 * 24 * 60 * 60 * 1000);
            const weekPredictions = recentPredictions.filter(p =>
                p.createdAt >= weekStart && p.createdAt < weekEnd
            );
            const weekCorrect = weekPredictions.filter(p => p.status === 'correct').length;
            weeklyStats.unshift({
                week: `Week ${4 - i}`,
                startDate: weekStart.toISOString().split('T')[0],
                total: weekPredictions.length,
                correct: weekCorrect,
                accuracy: weekPredictions.length > 0 ? (weekCorrect / weekPredictions.length) * 100 : 0
            });
        }

        // Get best performing symbols (min 2 predictions)
        const symbolStats = {};
        allPredictions.forEach(p => {
            if (!symbolStats[p.symbol]) {
                symbolStats[p.symbol] = { total: 0, correct: 0, avgReturn: 0, returns: [] };
            }
            symbolStats[p.symbol].total++;
            if (p.status === 'correct') symbolStats[p.symbol].correct++;
            if (p.outcome?.actualChangePercent) {
                symbolStats[p.symbol].returns.push(p.outcome.actualChangePercent);
            }
        });

        const symbolPerformance = Object.entries(symbolStats)
            .filter(([_, stats]) => stats.total >= 2)
            .map(([symbol, stats]) => ({
                symbol,
                total: stats.total,
                correct: stats.correct,
                accuracy: (stats.correct / stats.total) * 100,
                avgReturn: stats.returns.length > 0
                    ? stats.returns.reduce((a, b) => a + b, 0) / stats.returns.length
                    : 0
            }))
            .sort((a, b) => b.accuracy - a.accuracy);

        const bestSymbols = symbolPerformance.slice(0, 5);
        const worstSymbols = [...symbolPerformance].sort((a, b) => a.accuracy - b.accuracy).slice(0, 5);

        // Calculate current streak
        let currentStreak = 0;
        let streakType = null;
        for (const prediction of allPredictions) {
            if (streakType === null) {
                streakType = prediction.status;
                currentStreak = 1;
            } else if (prediction.status === streakType) {
                currentStreak++;
            } else {
                break;
            }
        }

        // Get recent predictions with outcomes (last 10)
        const recentWithOutcomes = allPredictions.slice(0, 10).map(p => ({
            _id: p._id,
            symbol: p.symbol,
            assetType: p.assetType,
            direction: p.direction,
            confidence: p.confidence,
            status: p.status,
            currentPrice: p.currentPrice,
            targetPrice: p.targetPrice,
            outcome: p.outcome,
            createdAt: p.createdAt,
            expiresAt: p.expiresAt
        }));

        // Get platform stats for comparison
        const platformStats = await Prediction.getPlatformAccuracy();

        res.json({
            success: true,
            overview: {
                totalPredictions: totalResolved,
                correctPredictions: correctCount,
                incorrectPredictions: totalResolved - correctCount,
                pendingPredictions: pendingPredictions.length,
                accuracy: Math.round(overallAccuracy * 100) / 100,
                avgConfidence: Math.round(avgConfidence * 100) / 100
            },
            streak: {
                current: currentStreak,
                type: streakType // 'correct' or 'incorrect'
            },
            byAssetType,
            byDirection,
            weeklyTrend: weeklyStats,
            bestSymbols,
            worstSymbols,
            recentPredictions: recentWithOutcomes,
            pendingPredictions: pendingPredictions.slice(0, 5).map(p => ({
                _id: p._id,
                symbol: p.symbol,
                direction: p.direction,
                confidence: p.confidence,
                targetPrice: p.targetPrice,
                expiresAt: p.expiresAt
            })),
            platformComparison: {
                platformAccuracy: platformStats.accuracy,
                userAccuracy: Math.round(overallAccuracy * 100) / 100,
                difference: Math.round((overallAccuracy - platformStats.accuracy) * 100) / 100
            }
        });

    } catch (error) {
        console.error('[Predictions] Accuracy dashboard error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch accuracy dashboard',
            message: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════
// GET /api/predictions/signals — Clean scored signal feed
// Same logic as frontend /signals page + Telegram bot
// Public (no auth) — entry/SL/TP hidden for non-premium
// ═══════════════════════════════════════════════════════════
router.get('/signals', predictionLimiter, async (req, res) => {
    try {
        const { limit = 20, status = 'active' } = req.query;
        const now = new Date();
        const MIN_CONF = 65;

        const query = {
            confidence: { $gte: MIN_CONF },
            user: null, isPublic: true
        };

        if (status === 'active') {
            query.status = 'pending';
            query.expiresAt = { $gt: now };
        }

        const signals = await Prediction.find(query)
            .sort({ confidence: -1 })
            .limit(Math.max(1, Math.min(200, parseInt(limit, 10) || 20)) * 2) // Fetch extra for scoring
            .select('symbol direction confidence currentPrice targetPrice entryPrice stopLoss takeProfit1 takeProfit2 takeProfit3 livePrice livePriceUpdatedAt result resultText resultPrice resultAt assetType signalStrength indicators analysis createdAt expiresAt status priceChangePercent')
            .lean();

        // Score each signal using LOCKED values (not recalculated)
        const scored = signals.map(s => {
            const sym = s.symbol?.split(':')[0]?.replace(/USDT|USD/i, '') || s.symbol;
            const conf = Math.round(s.confidence || 0);
            const long = s.direction === 'UP';

            // Use LOCKED values from DB, with fallback calculation for old signals
            const entry = s.entryPrice || s.currentPrice || 0;
            const target = s.targetPrice || 0;
            const range = Math.abs(target - entry);

            // Use stored SL/TP or calculate for legacy signals
            const sl = s.stopLoss || (long ? entry - range * 0.4 : entry + range * 0.4);
            const tp1 = s.takeProfit1 || (long ? entry + range * 0.4 : entry - range * 0.4);
            const tp2 = s.takeProfit2 || target;
            const tp3 = s.takeProfit3 || (long ? entry + range * 1.5 : entry - range * 1.5);

            const rrNum = range > 0 && Math.abs(entry - sl) > 0 ? Math.abs(target - entry) / Math.abs(entry - sl) : 2;

            const { score, riskReward, scoreVersion } = scoreSignal(s);

            const tier = conf >= 70 ? 'Strong Setup' : conf >= 65 ? 'Moderate Setup' : 'Below Threshold';


            return {
                id: s._id,
                symbol: sym,
                asset: `${sym}/USD`,
                direction: long ? 'LONG' : 'SHORT',
                confidence: conf,
                tier,
                score,
                scoreVersion,
                riskReward,
                assetType: s.assetType || 'crypto',
                signalStrength: s.signalStrength || 'moderate',
                status: s.status,
                // ═══════════════════════════════════════════════════════════
                // LOCKED trading levels - these NEVER change after creation
                // ═══════════════════════════════════════════════════════════
                entryPrice: entry,
                stopLoss: sl,
                takeProfit1: tp1,
                takeProfit2: tp2,
                takeProfit3: tp3,
                // Live price for tracking (this one updates)
                livePrice: s.livePrice || null,
                livePriceUpdatedAt: s.livePriceUpdatedAt || null,
                // Trade result (win/loss)
                result: s.result || null,
                resultText: s.resultText || null,
                resultPrice: s.resultPrice || null,
                resultAt: s.resultAt || null,
                hasLevels: entry > 0 && target > 0,
                createdAt: s.createdAt,
                expiresAt: s.expiresAt,
            };
        });

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);
        const topSignals = scored.slice(0, Math.max(1, Math.min(200, parseInt(limit, 10) || 20)));

        // Mark best signal
        if (topSignals.length > 0) {
            topSignals[0].isBestSetup = true;
        }

        res.json({
            success: true,
            count: topSignals.length,
            signals: topSignals,
            meta: {
                minConfidence: MIN_CONF,
                scoring: 'Confidence 60% + Risk/Reward 40% (v1)',
                updatedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('[Signals API] Error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch signals' });
    }
});

module.exports = router;
