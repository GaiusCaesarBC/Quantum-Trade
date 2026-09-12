// server/services/backtestEngine.js - Multi-Source Backtesting Engine
// Supports: Yahoo Finance, Alpha Vantage Pro, CoinGecko, Gecko Terminal
const axios = require('axios');
const { sanitizeSymbol } = require('../utils/symbolValidation');

// Common crypto symbols mapping to CoinGecko IDs
const CRYPTO_ID_MAP = {
    'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'XRP': 'ripple',
    'ADA': 'cardano', 'DOGE': 'dogecoin', 'DOT': 'polkadot', 'MATIC': 'matic-network',
    'LINK': 'chainlink', 'AVAX': 'avalanche-2', 'UNI': 'uniswap', 'ATOM': 'cosmos',
    'LTC': 'litecoin', 'BCH': 'bitcoin-cash', 'NEAR': 'near', 'APT': 'aptos',
    'ARB': 'arbitrum', 'OP': 'optimism', 'INJ': 'injective-protocol', 'SUI': 'sui',
    'SHIB': 'shiba-inu', 'PEPE': 'pepe', 'BONK': 'bonk', 'WIF': 'dogwifcoin',
    'FET': 'fetch-ai', 'RENDER': 'render-token', 'FIL': 'filecoin', 'ICP': 'internet-computer',
    'AAVE': 'aave', 'MKR': 'maker', 'CRV': 'curve-dao-token', 'SNX': 'synthetix-network-token',
    'RNDR': 'render-token', 'IMX': 'immutable-x', 'SAND': 'the-sandbox', 'MANA': 'decentraland',
    'TRX': 'tron', 'ETC': 'ethereum-classic', 'XLM': 'stellar', 'ALGO': 'algorand',
    'VET': 'vechain', 'HBAR': 'hedera-hashgraph', 'FTM': 'fantom', 'EGLD': 'elrond-erd-2'
};

class BacktestEngine {
    constructor(options = {}) {
        this.commissionRate = options.commissionRate ?? 0.001; // 0.1% per trade
        this.slippage = options.slippage ?? 0.0005; // 0.05% slippage
        this.alphaVantageKey = process.env.ALPHA_VANTAGE_API_KEY;
        this.coingeckoKey = process.env.COINGECKO_API_KEY;
    }

    // Detect if symbol is crypto
    isCrypto(symbol) {
        const cleanSymbol = symbol.toUpperCase().replace('-USD', '').replace('USDT', '').replace('USD', '');
        return CRYPTO_ID_MAP[cleanSymbol] ||
               symbol.includes('-USD') ||
               symbol.includes('USDT') ||
               /^(BTC|ETH|SOL|XRP|ADA|DOGE|DOT|MATIC|LINK|AVAX)/.test(cleanSymbol);
    }

    // Get CoinGecko ID from symbol (validates to prevent SSRF)
    getCoinGeckoId(symbol) {
        // Validate first to prevent SSRF
        const validatedSymbol = sanitizeSymbol(symbol);
        const cleanSymbol = validatedSymbol.replace('-USD', '').replace('USDT', '').replace('USD', '');
        return CRYPTO_ID_MAP[cleanSymbol] || cleanSymbol.toLowerCase();
    }

    // ============ DATA FETCHING - MULTI SOURCE ============

    async fetchHistoricalData(symbol, startDate, endDate) {
        // Validate symbol to prevent SSRF attacks
        const cleanSymbol = sanitizeSymbol(symbol);
        const isCrypto = this.isCrypto(cleanSymbol);

        console.log(`[Backtest] Fetching data for ${cleanSymbol} (${isCrypto ? 'CRYPTO' : 'STOCK'})`);

        if (isCrypto) {
            return this.fetchCryptoData(cleanSymbol, startDate, endDate);
        } else {
            return this.fetchStockData(cleanSymbol, startDate, endDate);
        }
    }

    // Fetch stock data with fallbacks
    async fetchStockData(symbol, startDate, endDate) {
        const sources = [
            () => this.fetchFromYahoo(symbol, startDate, endDate),
            () => this.fetchFromAlphaVantage(symbol, startDate, endDate)
        ];

        for (const fetchFn of sources) {
            try {
                const data = await fetchFn();
                if (data && data.length >= 30) {
                    console.log(`[Backtest] Got ${data.length} data points for ${symbol}`);
                    return data;
                }
            } catch (error) {
                console.log('[Backtest] Source failed for %s:', symbol, error.message);
            }
        }

        throw new Error('No data available for ' + symbol + ' from any source');
    }

    // Fetch crypto data with fallbacks
    async fetchCryptoData(symbol, startDate, endDate) {
        const cleanSymbol = symbol.replace('-USD', '').replace('USDT', '').replace('USD', '');
        const isMajor = !!CRYPTO_ID_MAP[cleanSymbol.toUpperCase()];

        // For major coins (BTC, ETH, etc.) skip GeckoTerminal entirely.
        // GeckoTerminal returns DEX pool data for "BTC" search results — wrapped
        // BTC variants and DEX pair swap prices — which are NOT Bitcoin spot price
        // and can produce garbage signals. CoinGecko + Yahoo are reliable for majors.
        const sources = isMajor
            ? [
                { name: 'coingecko', fn: () => this.fetchFromCoinGecko(cleanSymbol, startDate, endDate) },
                { name: 'yahoo',     fn: () => this.fetchFromYahoo(`${cleanSymbol}-USD`, startDate, endDate) }
            ]
            : [
                { name: 'coingecko', fn: () => this.fetchFromCoinGecko(cleanSymbol, startDate, endDate) },
                { name: 'yahoo',     fn: () => this.fetchFromYahoo(`${cleanSymbol}-USD`, startDate, endDate) },
                { name: 'gecko-terminal', fn: () => this.fetchFromGeckoTerminal(cleanSymbol, startDate, endDate) }
            ];

        for (const { name, fn } of sources) {
            try {
                const data = await fn();
                if (data && data.length >= 30) {
                    console.log(`[Backtest] Got ${data.length} data points for ${symbol} from ${name}`);
                    return data;
                }
                console.log(`[Backtest] ${name} returned only ${data?.length || 0} points for ${symbol}, trying next source`);
            } catch (error) {
                console.log(`[Backtest] ${name} failed for ${symbol}:`, error.message);
            }
        }

        throw new Error('No data available for ' + symbol + ' from any source');
    }

    // Yahoo Finance - Stocks & Major Crypto
    async fetchFromYahoo(symbol, startDate, endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        const period1 = Math.floor(start.getTime() / 1000);
        const period2 = Math.floor(end.getTime() / 1000);

        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`,
            {
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            }
        );

        const result = response.data?.chart?.result?.[0];
        if (!result || !result.timestamp) {
            throw new Error(`No Yahoo data for ${symbol}`);
        }

        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0];
        const adjClose = result.indicators.adjclose?.[0]?.adjclose || quotes.close;

        const data = [];
        for (let i = 0; i < timestamps.length; i++) {
            if (quotes.close[i] && quotes.open[i] && quotes.high[i] && quotes.low[i]) {
                data.push({
                    date: new Date(timestamps[i] * 1000),
                    open: quotes.open[i],
                    high: quotes.high[i],
                    low: quotes.low[i],
                    close: quotes.close[i],
                    adjClose: adjClose[i] || quotes.close[i],
                    volume: quotes.volume[i] || 0
                });
            }
        }

        return data;
    }

    // Alpha Vantage Pro - Stocks, Forex, Crypto
    async fetchFromAlphaVantage(symbol, startDate, endDate) {
        if (!this.alphaVantageKey) {
            throw new Error('Alpha Vantage API key not configured');
        }

        const response = await axios.get(
            `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${this.alphaVantageKey}`,
            { timeout: 30000 }
        );

        const timeSeries = response.data['Time Series (Daily)'];
        if (!timeSeries) {
            throw new Error(`No Alpha Vantage data for ${symbol}`);
        }

        const start = new Date(startDate);
        const end = new Date(endDate);

        const data = Object.entries(timeSeries)
            .filter(([dateStr]) => {
                const date = new Date(dateStr);
                return date >= start && date <= end;
            })
            .map(([dateStr, values]) => ({
                date: new Date(dateStr),
                open: parseFloat(values['1. open']),
                high: parseFloat(values['2. high']),
                low: parseFloat(values['3. low']),
                close: parseFloat(values['4. close']),
                adjClose: parseFloat(values['5. adjusted close']),
                volume: parseInt(values['6. volume']) || 0
            }))
            .sort((a, b) => a.date - b.date);

        return data;
    }

    // CoinGecko - Comprehensive Crypto
    async fetchFromCoinGecko(symbol, startDate, endDate) {
        const coinId = this.getCoinGeckoId(symbol);
        const start = new Date(startDate);
        const end = new Date(endDate);
        const fromTimestamp = Math.floor(start.getTime() / 1000);
        const toTimestamp = Math.floor(end.getTime() / 1000);

        const headers = this.coingeckoKey
            ? { 'x-cg-pro-api-key': this.coingeckoKey }
            : {};

        const baseUrl = this.coingeckoKey
            ? 'https://pro-api.coingecko.com/api/v3'
            : 'https://api.coingecko.com/api/v3';

        const response = await axios.get(
            `${baseUrl}/coins/${coinId}/market_chart/range?vs_currency=usd&from=${fromTimestamp}&to=${toTimestamp}`,
            { timeout: 30000, headers }
        );

        const { prices, total_volumes } = response.data;
        if (!prices || prices.length === 0) {
            throw new Error(`No CoinGecko data for ${coinId}`);
        }

        // Group by day and create OHLC data
        const dailyData = new Map();

        prices.forEach(([timestamp, price], index) => {
            const date = new Date(timestamp);
            const dateKey = date.toISOString().split('T')[0];

            if (!dailyData.has(dateKey)) {
                dailyData.set(dateKey, {
                    date: new Date(dateKey),
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: total_volumes[index]?.[1] || 0
                });
            } else {
                const day = dailyData.get(dateKey);
                day.high = Math.max(day.high, price);
                day.low = Math.min(day.low, price);
                day.close = price;
                day.volume = total_volumes[index]?.[1] || day.volume;
            }
        });

        return Array.from(dailyData.values())
            .sort((a, b) => a.date - b.date)
            .map(d => ({ ...d, adjClose: d.close }));
    }

    // Gecko Terminal - DeFi & DEX Tokens
    async fetchFromGeckoTerminal(symbol, startDate, endDate) {
        // First search for the token to get pool address
        const searchResponse = await axios.get(
            `https://api.geckoterminal.com/api/v2/search/pools?query=${symbol}`,
            { timeout: 15000 }
        );

        const pools = searchResponse.data?.data;
        if (!pools || pools.length === 0) {
            throw new Error(`No Gecko Terminal pools for ${symbol}`);
        }

        // Get the most liquid pool
        const pool = pools[0];
        const network = pool.relationships?.network?.data?.id || 'eth';
        const poolAddress = pool.attributes?.address;

        if (!poolAddress) {
            throw new Error(`No pool address for ${symbol}`);
        }

        // Fetch OHLCV data
        const response = await axios.get(
            `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/day?limit=365`,
            { timeout: 15000 }
        );

        const ohlcvData = response.data?.data?.attributes?.ohlcv_list;
        if (!ohlcvData || ohlcvData.length === 0) {
            throw new Error(`No Gecko Terminal OHLCV data for ${symbol}`);
        }

        const start = new Date(startDate);
        const end = new Date(endDate);

        return ohlcvData
            .filter(([timestamp]) => {
                const date = new Date(timestamp * 1000);
                return date >= start && date <= end;
            })
            .map(([timestamp, open, high, low, close, volume]) => ({
                date: new Date(timestamp * 1000),
                open: parseFloat(open),
                high: parseFloat(high),
                low: parseFloat(low),
                close: parseFloat(close),
                adjClose: parseFloat(close),
                volume: parseFloat(volume) || 0
            }))
            .sort((a, b) => a.date - b.date);
    }

    // ============ TECHNICAL INDICATORS ============

    calculateIndicators(data, params = {}) {
        const indicators = {
            sma: {},
            ema: {},
            rsi: [],
            macd: { line: [], signal: [], histogram: [] },
            bollinger: { upper: [], middle: [], lower: [] },
            atr: []
        };

        const closes = data.map(d => d.close);

        // Simple Moving Averages
        [10, 20, 50, 200].forEach(period => {
            indicators.sma[period] = this.calculateSMA(closes, period);
        });

        // Exponential Moving Averages
        [12, 26].forEach(period => {
            indicators.ema[period] = this.calculateEMA(closes, period);
        });

        // RSI
        indicators.rsi = this.calculateRSI(closes, params.rsiPeriod || 14);

        // MACD
        indicators.macd = this.calculateMACD(closes, 12, 26, 9);

        // Bollinger Bands
        indicators.bollinger = this.calculateBollingerBands(closes, params.bbPeriod || 20, params.bbStdDev || 2);

        // ATR
        indicators.atr = this.calculateATR(data, 14);

        return indicators;
    }

    calculateSMA(data, period) {
        const sma = [];
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                sma.push(null);
            } else {
                const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
                sma.push(sum / period);
            }
        }
        return sma;
    }

    calculateEMA(data, period) {
        const ema = [];
        const multiplier = 2 / (period + 1);

        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                ema.push(null);
            } else if (i === period - 1) {
                const sum = data.slice(0, period).reduce((a, b) => a + b, 0);
                ema.push(sum / period);
            } else {
                ema.push((data[i] - ema[i - 1]) * multiplier + ema[i - 1]);
            }
        }
        return ema;
    }

    calculateRSI(data, period = 14) {
        const rsi = [];
        const gains = [];
        const losses = [];

        for (let i = 1; i < data.length; i++) {
            const change = data[i] - data[i - 1];
            gains.push(change > 0 ? change : 0);
            losses.push(change < 0 ? Math.abs(change) : 0);
        }

        for (let i = 0; i < data.length; i++) {
            if (i < period) {
                rsi.push(null);
            } else {
                const avgGain = gains.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
                const avgLoss = losses.slice(i - period, i).reduce((a, b) => a + b, 0) / period;

                if (avgLoss === 0) {
                    rsi.push(100);
                } else {
                    const rs = avgGain / avgLoss;
                    rsi.push(100 - (100 / (1 + rs)));
                }
            }
        }
        return rsi;
    }

    calculateMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        const emaFast = this.calculateEMA(data, fastPeriod);
        const emaSlow = this.calculateEMA(data, slowPeriod);

        const macdLine = emaFast.map((fast, i) => {
            if (fast === null || emaSlow[i] === null) return null;
            return fast - emaSlow[i];
        });

        const validMacd = macdLine.filter(v => v !== null);
        const signalLine = this.calculateEMA(validMacd, signalPeriod);
        const paddedSignal = new Array(macdLine.length - signalLine.length).fill(null).concat(signalLine);

        const histogram = macdLine.map((macd, i) => {
            if (macd === null || paddedSignal[i] === null) return null;
            return macd - paddedSignal[i];
        });

        return { line: macdLine, signal: paddedSignal, histogram };
    }

    calculateBollingerBands(data, period = 20, stdDev = 2) {
        const sma = this.calculateSMA(data, period);
        const upper = [];
        const lower = [];

        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                upper.push(null);
                lower.push(null);
            } else {
                const slice = data.slice(i - period + 1, i + 1);
                const mean = sma[i];
                const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
                const std = Math.sqrt(variance);
                upper.push(mean + stdDev * std);
                lower.push(mean - stdDev * std);
            }
        }

        return { upper, middle: sma, lower };
    }

    calculateATR(data, period = 14) {
        const tr = [];
        for (let i = 0; i < data.length; i++) {
            if (i === 0) {
                tr.push(data[i].high - data[i].low);
            } else {
                const hl = data[i].high - data[i].low;
                const hc = Math.abs(data[i].high - data[i - 1].close);
                const lc = Math.abs(data[i].low - data[i - 1].close);
                tr.push(Math.max(hl, hc, lc));
            }
        }
        return this.calculateSMA(tr, period);
    }

    // ============ TRADING STRATEGIES ============

    executeStrategy(strategy, data, indicators, params) {
        switch (strategy) {
            case 'ma-crossover':
                return this.maCrossoverStrategy(data, indicators, params);
            case 'rsi-reversal':
                return this.rsiReversalStrategy(data, indicators, params);
            case 'macd-crossover':
                return this.macdCrossoverStrategy(data, indicators, params);
            case 'bollinger-bands':
                return this.bollingerBandsStrategy(data, indicators, params);
            case 'breakout':
                return this.breakoutStrategy(data, indicators, params);
            case 'mean-reversion':
                return this.meanReversionStrategy(data, indicators, params);
            default:
                throw new Error(`Unknown strategy: ${strategy}`);
        }
    }

    maCrossoverStrategy(data, indicators, params = {}) {
        const fastPeriod = params.fastPeriod || 10;
        const slowPeriod = params.slowPeriod || 30;
        const fastMA = this.calculateSMA(data.map(d => d.close), fastPeriod);
        const slowMA = this.calculateSMA(data.map(d => d.close), slowPeriod);

        const signals = [{ signal: 'hold', reason: 'Initial' }];
        let initialized = false;

        for (let i = 1; i < data.length; i++) {
            const f = fastMA[i], s = slowMA[i];
            const fp = fastMA[i - 1], sp = slowMA[i - 1];

            if (f === null || s === null) {
                signals.push({ signal: 'hold', reason: 'Waiting for MA' });
                continue;
            }

            // First bar where both MAs are valid — establish initial position
            // (avoids missing the entry when fast is already above slow at warmup end)
            if (!initialized) {
                initialized = true;
                if (f > s) {
                    signals.push({ signal: 'buy', reason: 'Fast MA above Slow MA — initial entry' });
                } else {
                    signals.push({ signal: 'hold', reason: 'Fast MA below Slow MA at warmup' });
                }
                continue;
            }

            if (fp === null || sp === null) {
                signals.push({ signal: 'hold', reason: 'Waiting for prior MA' });
            } else if (fp <= sp && f > s) {
                signals.push({ signal: 'buy', reason: 'Fast MA crossed above Slow MA' });
            } else if (fp >= sp && f < s) {
                signals.push({ signal: 'sell', reason: 'Fast MA crossed below Slow MA' });
            } else {
                signals.push({ signal: 'hold', reason: 'No crossover' });
            }
        }
        return signals;
    }

    rsiReversalStrategy(data, indicators, params = {}) {
        const oversold = params.oversold || 30;
        const overbought = params.overbought || 70;
        const rsi = indicators.rsi;

        const signals = [];
        for (let i = 0; i < data.length; i++) {
            if (rsi[i] === null) {
                signals.push({ signal: 'hold', reason: 'Waiting for RSI' });
            } else if (rsi[i] < oversold) {
                signals.push({ signal: 'buy', reason: `RSI oversold at ${rsi[i].toFixed(1)}` });
            } else if (rsi[i] > overbought) {
                signals.push({ signal: 'sell', reason: `RSI overbought at ${rsi[i].toFixed(1)}` });
            } else {
                signals.push({ signal: 'hold', reason: `RSI neutral at ${rsi[i].toFixed(1)}` });
            }
        }
        return signals;
    }

    macdCrossoverStrategy(data, indicators, params = {}) {
        const { line, signal } = indicators.macd;
        const signals = [{ signal: 'hold', reason: 'Initial' }];
        let initialized = false;

        for (let i = 1; i < data.length; i++) {
            const l = line[i], sg = signal[i];
            const lp = line[i - 1], sgp = signal[i - 1];

            if (l === null || sg === null) {
                signals.push({ signal: 'hold', reason: 'Waiting for MACD' });
                continue;
            }

            // Initial-state entry
            if (!initialized) {
                initialized = true;
                if (l > sg) {
                    signals.push({ signal: 'buy', reason: 'MACD line above signal — initial entry' });
                } else {
                    signals.push({ signal: 'hold', reason: 'MACD below signal at warmup' });
                }
                continue;
            }

            if (lp === null || sgp === null) {
                signals.push({ signal: 'hold', reason: 'Waiting for prior MACD' });
            } else if (lp <= sgp && l > sg) {
                signals.push({ signal: 'buy', reason: 'MACD bullish crossover' });
            } else if (lp >= sgp && l < sg) {
                signals.push({ signal: 'sell', reason: 'MACD bearish crossover' });
            } else {
                signals.push({ signal: 'hold', reason: 'No MACD crossover' });
            }
        }
        return signals;
    }

    bollingerBandsStrategy(data, indicators, params = {}) {
        const { upper, lower } = indicators.bollinger;
        const signals = [];

        for (let i = 0; i < data.length; i++) {
            if (upper[i] === null || lower[i] === null) {
                signals.push({ signal: 'hold', reason: 'Waiting for Bollinger Bands' });
            } else if (data[i].close < lower[i]) {
                signals.push({ signal: 'buy', reason: 'Price below lower band' });
            } else if (data[i].close > upper[i]) {
                signals.push({ signal: 'sell', reason: 'Price above upper band' });
            } else {
                signals.push({ signal: 'hold', reason: 'Price within bands' });
            }
        }
        return signals;
    }

    breakoutStrategy(data, indicators, params = {}) {
        const lookback = params.lookbackPeriod || 20;
        const threshold = params.breakoutThreshold || 1.02;
        const signals = [];

        for (let i = 0; i < data.length; i++) {
            if (i < lookback) {
                signals.push({ signal: 'hold', reason: 'Waiting for lookback period' });
            } else {
                const recentHigh = Math.max(...data.slice(i - lookback, i).map(d => d.high));
                const recentLow = Math.min(...data.slice(i - lookback, i).map(d => d.low));

                if (data[i].close > recentHigh * threshold) {
                    signals.push({ signal: 'buy', reason: `Breakout above ${recentHigh.toFixed(2)}` });
                } else if (data[i].close < recentLow / threshold) {
                    signals.push({ signal: 'sell', reason: `Breakdown below ${recentLow.toFixed(2)}` });
                } else {
                    signals.push({ signal: 'hold', reason: 'No breakout' });
                }
            }
        }
        return signals;
    }

    meanReversionStrategy(data, indicators, params = {}) {
        const period = params.period || 20;
        const stdDevs = params.stdDevs || 2;
        const sma = indicators.sma[period] || this.calculateSMA(data.map(d => d.close), period);
        const signals = [];

        for (let i = 0; i < data.length; i++) {
            if (sma[i] === null) {
                signals.push({ signal: 'hold', reason: 'Waiting for SMA' });
            } else {
                const deviation = (data[i].close - sma[i]) / sma[i];
                const threshold = stdDevs * 0.02;

                if (deviation < -threshold) {
                    signals.push({ signal: 'buy', reason: `Price ${(deviation * 100).toFixed(1)}% below mean` });
                } else if (deviation > threshold) {
                    signals.push({ signal: 'sell', reason: `Price ${(deviation * 100).toFixed(1)}% above mean` });
                } else {
                    signals.push({ signal: 'hold', reason: 'Price near mean' });
                }
            }
        }
        return signals;
    }

    // ============ BACKTEST EXECUTION ============

    async runBacktest(options) {
        const {
            symbol,
            strategy,
            startDate,
            endDate,
            initialCapital = 10000,
            parameters = {}
        } = options;

        console.log(`[Backtest] Running ${strategy} on ${symbol} from ${startDate} to ${endDate}`);

        // Fetch historical data (auto-detects stock vs crypto)
        const data = await this.fetchHistoricalData(symbol, startDate, endDate);

        if (data.length < 50) {
            throw new Error(`Insufficient data for backtesting (got ${data.length}, need at least 50 data points)`);
        }

        // Sanity check: log the price range so we can spot garbage data sources
        const closes = data.map(d => d.close).filter(c => typeof c === 'number' && !isNaN(c));
        const firstClose = closes[0];
        const lastClose = closes[closes.length - 1];
        const minClose = Math.min(...closes);
        const maxClose = Math.max(...closes);
        console.log(`[Backtest] ${symbol} price range: first=$${firstClose?.toFixed(2)}, last=$${lastClose?.toFixed(2)}, min=$${minClose?.toFixed(2)}, max=$${maxClose?.toFixed(2)}, validCloses=${closes.length}/${data.length}`);

        // Calculate indicators
        const indicators = this.calculateIndicators(data, parameters);

        // Execute strategy
        const signals = this.executeStrategy(strategy, data, indicators, parameters);

        // Debug: count signal types so we can diagnose 0-trade cases
        const sigCounts = { buy: 0, sell: 0, hold: 0, other: 0 };
        signals.forEach(s => {
            if (s?.signal === 'buy') sigCounts.buy++;
            else if (s?.signal === 'sell') sigCounts.sell++;
            else if (s?.signal === 'hold') sigCounts.hold++;
            else sigCounts.other++;
        });
        console.log(`[Backtest] Signals for ${strategy} on ${symbol}: buy=${sigCounts.buy}, sell=${sigCounts.sell}, hold=${sigCounts.hold}, dataPoints=${data.length}`);

        // Simulate trades
        const simulation = this.simulateTrades(data, signals, initialCapital);

        // Calculate performance metrics
        const metrics = this.calculateMetrics(simulation, data, initialCapital);

        // Generate monthly performance
        const monthlyPerformance = this.calculateMonthlyPerformance(simulation.trades, data);

        console.log(`[Backtest] Completed: ${metrics.totalReturnPercent}% return, ${metrics.totalTrades} trades`);

        return {
            results: metrics,
            trades: simulation.trades,
            equityCurve: simulation.equityCurve,
            monthlyPerformance,
            dataPoints: data.length
        };
    }

    simulateTrades(data, signals, initialCapital) {
        if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error('Invalid initial capital');
        if (![this.commissionRate, this.slippage].every(x => Number.isFinite(x) && x >= 0 && x < 1)) throw new Error('Invalid execution costs');
        let cash = initialCapital;
        let position = null;
        const trades = [], equityCurve = [];
        const closePosition = (price, date, reason) => {
            const executionPrice = price * (1 - this.slippage);
            const proceeds = position.shares * executionPrice * (1 - this.commissionRate);
            const profit = proceeds - position.costBasis;
            cash += proceeds;
            trades.push({ date, type: 'sell', price: executionPrice, shares: position.shares,
                value: proceeds, signal: reason, profit, profitPercent: profit / position.costBasis * 100,
                portfolioValue: cash });
            position = null;
        };
        for (let i = 0; i < data.length; i++) {
            const bar = data[i];
            if (!Number.isFinite(bar.close) || bar.close <= 0) throw new Error('Invalid historical close');
            // A signal from a completed bar can execute only at the NEXT open.
            const signal = i > 0 ? signals[i - 1] : null;
            if (signal?.signal === 'buy' && !position) {
                if (!Number.isFinite(bar.open) || bar.open <= 0) throw new Error('Historical open required for execution');
                const executionPrice = bar.open * (1 + this.slippage);
                const shares = Math.floor(cash / (executionPrice * (1 + this.commissionRate)));
                if (shares > 0) {
                    const costBasis = shares * executionPrice * (1 + this.commissionRate);
                    cash -= costBasis;
                    position = { shares, costBasis, entryPrice: executionPrice };
                    trades.push({ date: bar.date, type: 'buy', price: executionPrice, shares,
                        value: costBasis, signal: signal.reason, portfolioValue: cash + shares * bar.close });
                }
            } else if (signal?.signal === 'sell' && position) {
                if (!Number.isFinite(bar.open) || bar.open <= 0) throw new Error('Historical open required for execution');
                closePosition(bar.open, bar.date, signal.reason);
            }
            equityCurve.push({ date: bar.date, value: cash + (position ? position.shares * bar.close : 0),
                benchmark: bar.close / data[0].close * initialCapital });
        }
        // Explicit terminal liquidation, including both sides' costs in net P&L.
        if (position) {
            const last = data[data.length - 1];
            closePosition(last.close, last.date, 'End of backtest liquidation');
            equityCurve[equityCurve.length - 1].value = cash;
        }
        return { trades, equityCurve, finalValue: cash };
    }

    calculateMetrics(simulation, data, initialCapital) {
        const { trades, equityCurve, finalValue } = simulation;

        const totalReturn = finalValue - initialCapital;
        const totalReturnPercent = (totalReturn / initialCapital) * 100;

        // Annualized return
        const days = (data[data.length - 1].date - data[0].date) / (1000 * 60 * 60 * 24);
        const years = days / 365;
        const annualizedReturn = years > 0 ? (Math.pow(finalValue / initialCapital, 1 / years) - 1) * 100 : 0;

        // Trade statistics
        const sellTrades = trades.filter(t => t.type === 'sell');
        const profitableTrades = sellTrades.filter(t => t.profit > 0);
        const losingTrades = sellTrades.filter(t => t.profit <= 0);

        const winRate = sellTrades.length > 0 ? (profitableTrades.length / sellTrades.length) * 100 : 0;

        const avgWin = profitableTrades.length > 0
            ? profitableTrades.reduce((sum, t) => sum + t.profitPercent, 0) / profitableTrades.length
            : 0;
        const avgLoss = losingTrades.length > 0
            ? losingTrades.reduce((sum, t) => sum + t.profitPercent, 0) / losingTrades.length
            : 0;

        const largestWin = profitableTrades.length > 0
            ? Math.max(...profitableTrades.map(t => t.profitPercent))
            : 0;
        const largestLoss = losingTrades.length > 0
            ? Math.min(...losingTrades.map(t => t.profitPercent))
            : 0;

        // Profit factor
        const totalGains = profitableTrades.reduce((sum, t) => sum + t.profit, 0);
        const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
        const profitFactor = totalLosses > 0 ? totalGains / totalLosses : totalGains > 0 ? Infinity : 0;

        // Drawdown
        let maxValue = initialCapital;
        let maxDrawdown = 0;
        let maxDrawdownPercent = 0;

        for (const point of equityCurve) {
            if (point.value > maxValue) maxValue = point.value;
            const drawdown = maxValue - point.value;
            const drawdownPercent = (drawdown / maxValue) * 100;
            if (drawdownPercent > maxDrawdownPercent) {
                maxDrawdown = drawdown;
                maxDrawdownPercent = drawdownPercent;
            }
        }

        // Volatility
        const returns = [];
        for (let i = 1; i < equityCurve.length; i++) {
            returns.push((equityCurve[i].value / equityCurve[i - 1].value) - 1);
        }
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;

        // Sharpe Ratio
        const riskFreeRate = 0.02;
        const excessReturn = (annualizedReturn / 100) - riskFreeRate;
        const sharpeRatio = volatility > 0 ? (excessReturn / (volatility / 100)) : 0;

        // Calmar Ratio
        const calmarRatio = maxDrawdownPercent > 0 ? annualizedReturn / maxDrawdownPercent : 0;

        return {
            finalValue: Math.round(finalValue * 100) / 100,
            totalReturn: Math.round(totalReturn * 100) / 100,
            totalReturnPercent: Math.round(totalReturnPercent * 100) / 100,
            annualizedReturn: Math.round(annualizedReturn * 100) / 100,
            sharpeRatio: Math.round(sharpeRatio * 100) / 100,
            maxDrawdown: Math.round(maxDrawdown * 100) / 100,
            maxDrawdownPercent: Math.round(maxDrawdownPercent * 100) / 100,
            winRate: Math.round(winRate * 100) / 100,
            totalTrades: sellTrades.length,
            profitableTrades: profitableTrades.length,
            losingTrades: losingTrades.length,
            averageWin: Math.round(avgWin * 100) / 100,
            averageLoss: Math.round(avgLoss * 100) / 100,
            largestWin: Math.round(largestWin * 100) / 100,
            largestLoss: Math.round(largestLoss * 100) / 100,
            profitFactor: profitFactor === Infinity ? 999 : Math.round(profitFactor * 100) / 100,
            volatility: Math.round(volatility * 100) / 100,
            calmarRatio: Math.round(calmarRatio * 100) / 100
        };
    }

    calculateMonthlyPerformance(trades, data) {
        const monthly = {};

        for (const trade of trades) {
            if (trade.type !== 'sell') continue;
            const key = `${trade.date.getFullYear()}-${String(trade.date.getMonth() + 1).padStart(2, '0')}`;
            if (!monthly[key]) {
                monthly[key] = { trades: 0, returns: [] };
            }
            monthly[key].trades++;
            monthly[key].returns.push(trade.profitPercent);
        }

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        return Object.entries(monthly).map(([key, stats]) => {
            const [year, month] = key.split('-');
            return {
                month: monthNames[parseInt(month) - 1],
                year: parseInt(year),
                return: Math.round(stats.returns.reduce((a, b) => a + b, 0) * 100) / 100,
                trades: stats.trades,
                winRate: Math.round((stats.returns.filter(r => r > 0).length / stats.returns.length) * 100)
            };
        }).sort((a, b) => {
            if (a.year !== b.year) return a.year - b.year;
            return monthNames.indexOf(a.month) - monthNames.indexOf(b.month);
        });
    }
}

module.exports = BacktestEngine;
