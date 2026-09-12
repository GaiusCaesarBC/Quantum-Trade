const { scoreSignal } = require('../utils/signalPresentation');
// services/telegramBot.js — Nexus Signal AI Telegram Bot
// Synced with /signals page. Same data, same sorting, same quality gate.

const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const Prediction = require('../models/Prediction');

const SITE = 'https://www.nexussignal.ai';
const MIN_CONFIDENCE = 65;
let bot = null;
let channelId = null;
let groupId = null;
let lastPostedSignals = new Set();

// Rate limiting
let postsThisHour = 0;
const MAX_POSTS_PER_HOUR = 4;
function canPost() { return postsThisHour < MAX_POSTS_PER_HOUR; }

// ─── Escape MarkdownV2 special chars ──────────────────────
function esc(text) {
    return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Escape for inside MarkdownV2 link URLs — only ) and \ need escaping
function escUrl(text) {
    return String(text).replace(/[)\\]/g, '\\$&');
}

// ─── Fetch signals from the clean /signals API endpoint ───
// Same data as frontend /signals page — single source of truth
async function getQualifiedSignals(limit = 20) {
    try {
        const axios = require('axios');
        const API_URL = process.env.API_URL || 'http://localhost:5000/api';
        const res = await axios.get(`${API_URL}/predictions/signals?limit=${limit}&status=active`, { timeout: 10000 });

        if (res.data?.success && res.data?.signals) {
            return res.data.signals.map(s => ({
                ...s,
                long: s.direction === 'LONG'
            }));
        }
        return [];
    } catch (e) {
        // Fallback: query DB directly if API call fails (e.g., during startup)
        try {
            const now = new Date();
            const signals = await Prediction.find({
                confidence: { $gte: MIN_CONFIDENCE },
                status: 'pending', user: null, isPublic: true,
                expiresAt: { $gt: now }
            }).sort({ confidence: -1 }).limit(limit).lean();

            return signals.map(s => {
                const sym = s.symbol?.split(':')[0]?.replace(/USDT|USD/i, '') || s.symbol;
                const conf = Math.min(95, Math.round(s.confidence || 0));
                const long = s.direction === 'UP';
                return {
                    id: s._id, symbol: sym, direction: long ? 'LONG' : 'SHORT', long,
                    confidence: conf, tier: conf >= 70 ? 'Strong Setup' : 'Moderate Setup',
                    ...scoreSignal(s), createdAt: s.createdAt
                };
            }).sort((a, b) => b.score - a.score);
        } catch (dbErr) {
            console.error('[TGBot] Both API and DB failed:', dbErr.message);
            return [];
        }
    }
}

// ─── Get all-time stats (matches website) ────────────────
async function getRecentStats() {
    try {
        const systemQuery = { user: null, isPublic: true };
        const total = await Prediction.countDocuments(systemQuery);
        const winners = await Prediction.countDocuments({ ...systemQuery, result: 'win' });
        const losers = await Prediction.countDocuments({ ...systemQuery, result: 'loss' });
        const active = await Prediction.countDocuments({ ...systemQuery, status: 'pending', expiresAt: { $gt: new Date() } });
        const closed = winners + losers;
        const winRate = closed > 0 ? Math.round((winners / closed) * 100) : 0;

        return { total, winners, losers, active, winRate };
    } catch (e) {
        return { total: 0, winners: 0, losers: 0, active: 0, winRate: 0 };
    }
}

// ─── Fetch top winning trades ─────────────────────────────
async function getTopWins(limit = 5) {
    try {
        const wins = await Prediction.find({
            user: null, isPublic: true,
            result: 'win',
            resultText: { $exists: true },
            entryPrice: { $gt: 0 },
            resultPrice: { $gt: 0 },
        }).sort({ resultAt: -1 }).limit(50).lean();

        // Calculate profit % (direction-aware) and sort by highest gain
        return wins.map(w => {
            const isLong = w.direction === 'UP';
            const rawPct = ((w.resultPrice - w.entryPrice) / w.entryPrice) * 100;
            const pct = isLong ? rawPct : -rawPct;
            const sym = w.symbol?.split(':')[0]?.replace(/USDT|USD/i, '') || w.symbol;
            return { symbol: sym, direction: isLong ? 'LONG' : 'SHORT', pct, resultText: w.resultText, resultAt: w.resultAt };
        })
        .filter(w => w.pct > 0)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, limit);
    } catch (e) {
        console.error('[TGBot] getTopWins error:', e.message);
        return [];
    }
}

// ─── Message Builders ─────────────────────────────────────

function buildSignalsMessage(signals) {
    if (signals.length === 0) {
        return `No high\\-confidence signals right now\\. Check back soon\\.`;
    }

    const best = signals[0];
    const rest = signals.slice(1, 3);

    let msg = `🔥 *BEST SETUP RIGHT NOW*\n\n`;
    msg += `*${esc(best.symbol)}* — ${best.long ? '📈' : '📉'} *${esc(best.direction)}*\n`;
    msg += `${esc(String(best.confidence))}% — ${esc(best.tier)}\n\n`;

    if (rest.length > 0) {
        msg += `📊 *More Signals:*\n`;
        for (const s of rest) {
            msg += `${s.long ? '📈' : '📉'} *${esc(s.symbol)}* ${esc(s.direction)} — ${esc(String(s.confidence))}% ${esc(s.tier)}\n`;
        }
        msg += `\n`;
    }

    msg += `👉 [View full trade setups \\(entry, SL, TP\\)](${escUrl(SITE)}/signals)`;
    return msg;
}

function buildTeaserMessage(signal) {
    const dir = signal.long ? '📈' : '📉';
    const tier = signal.confidence >= 70 ? 'Strong Setup' : 'Moderate Setup';
    return `🚨 *AI SIGNAL — ${esc(signal.symbol)}*\n\n${dir} *${esc(signal.direction)}*\n${esc(String(signal.confidence))}% — ${esc(tier)}\n\nFull trade levels inside\\.\n\n👉 [View signal](${escUrl(SITE)}/signals)`;
}

function buildResultMessage(signal, isWin, movePct) {
    const dir = signal.direction === 'UP' ? 'LONG' : 'SHORT';
    const sym = signal.symbol?.split(':')[0]?.replace(/USDT|USD/i, '') || signal.symbol;
    const icon = isWin ? '✅' : '❌';
    const result = isWin ? 'TARGET HIT' : 'STOP LOSS HIT';
    const pct = `${movePct >= 0 ? '+' : ''}${movePct.toFixed(1)}%`;
    return `${icon} *RESULT — ${esc(sym)} ${esc(dir)}*\n\n${esc(result)} \\(${esc(pct)}\\)\n\nEvery signal tracked\\. No edits\\.\n\n👉 [See all signals](${escUrl(SITE)}/signals)`;
}

function buildDailyRecap(stats) {
    return `📊 *TODAY'S SIGNALS*\n\n${esc(String(stats.total))} signals generated\n${esc(String(stats.winners))} winners\n${esc(String(stats.losers))} stopped out\n${esc(String(stats.active))} still active\n\nWin rate: *${esc(String(stats.winRate))}%*\n\nEvery signal tracked\\. No deletions\\.\n\n👉 [View all](${escUrl(SITE)}/signals)`;
}

function buildTopWinsMessage(wins, stats) {
    if (!wins.length) return `No verified wins yet\\. Results will appear here as signals hit targets\\.`;

    const best = wins[0];
    const rest = wins.slice(1);

    let msg = `🏆 *VERIFIED RESULTS*\n_Every trade tracked\\. No hiding\\._\n\n`;

    // Featured top trade
    msg += `🔥 *TOP TRADE*\n`;
    msg += `*${esc(best.symbol)}* ${best.direction === 'LONG' ? '📈' : '📉'} ${esc(best.direction)}\n`;
    msg += `*\\+${esc(best.pct.toFixed(1))}%* — ${esc(best.resultText)}\n\n`;

    // Other wins
    if (rest.length) {
        msg += `✅ *More Winners:*\n`;
        for (const w of rest) {
            msg += `${w.direction === 'LONG' ? '📈' : '📉'} *${esc(w.symbol)}* \\+${esc(w.pct.toFixed(1))}% — ${esc(w.resultText)}\n`;
        }
        msg += `\n`;
    }

    // Stats
    if (stats) {
        msg += `📊 ${esc(String(stats.total))} tracked \\| ${esc(String(stats.winners))} winners \\| *${esc(String(stats.winRate))}% win rate*\n\n`;
    }

    msg += `👉 [See all results](${escUrl(SITE)}/signals)`;
    return msg;
}

function buildWelcome() {
    return `👋 *Welcome to Nexus Signal AI*\n\nAI\\-powered trade signals for stocks \\& crypto — tracked and validated\\.\n\nNo fake wins\\. No deleted trades\\.\n\nGet started below 👇`;
}

// ─── Keyboards ────────────────────────────────────────────
const startKeyboard = { reply_markup: { inline_keyboard: [
    [{ text: '🔓 View Live Signals', url: `${SITE}/signals` }],
    [{ text: '🚀 Start Free Trial', url: `${SITE}/pricing` }],
    [{ text: '📊 Today\'s Results', callback_data: 'results' }],
]}};

const signalsKeyboard = { reply_markup: { inline_keyboard: [
    [{ text: '📊 View All Signals', url: `${SITE}/signals` }],
]}};

// ─── Commands ─────────────────────────────────────────────
function setupCommands() {
    if (!bot) return;

    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, buildWelcome(), { parse_mode: 'MarkdownV2', ...startKeyboard })
            .catch(e => console.log('[TGBot] start error:', e.message));
    });

    // /signals — Top 3 from the SAME data as the website
    bot.onText(/\/signals/, async (msg) => {
        const signals = await getQualifiedSignals(20);
        bot.sendMessage(msg.chat.id, buildSignalsMessage(signals), { parse_mode: 'MarkdownV2', ...signalsKeyboard })
            .catch(e => console.log('[TGBot] signals error:', e.message));
    });

    bot.onText(/\/pricing/, (msg) => {
        bot.sendMessage(msg.chat.id, `Unlock full AI signals, trade levels, and tracking\\.\n\n*7\\-day free trial available\\.*`, {
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [[{ text: '🚀 View Plans', url: `${SITE}/pricing` }]] }
        }).catch(e => console.log('[TGBot] pricing error:', e.message));
    });

    bot.onText(/\/results/, async (msg) => {
        const [stats, wins] = await Promise.all([getRecentStats(), getTopWins(5)]);
        bot.sendMessage(msg.chat.id, buildTopWinsMessage(wins, stats), {
            parse_mode: 'MarkdownV2', ...signalsKeyboard
        }).catch(e => console.log('[TGBot] results error:', e.message));
    });

    bot.onText(/\/wins/, async (msg) => {
        const [stats, wins] = await Promise.all([getRecentStats(), getTopWins(5)]);
        bot.sendMessage(msg.chat.id, buildTopWinsMessage(wins, stats), {
            parse_mode: 'MarkdownV2', ...signalsKeyboard
        }).catch(e => console.log('[TGBot] wins error:', e.message));
    });

    bot.on('callback_query', async (query) => {
        // X post approval callbacks
        if (query.data?.startsWith('xapprove:') || query.data?.startsWith('xreject:')) {
            try {
                const { handleApprovalCallback } = require('./xPosterService');
                await handleApprovalCallback(query);
            } catch (e) { console.error('[TGBot] X approval error:', e.message); }
            return;
        }

        if (query.data === 'results') {
            const [stats, wins] = await Promise.all([getRecentStats(), getTopWins(5)]);
            bot.answerCallbackQuery(query.id);
            bot.sendMessage(query.message.chat.id, buildTopWinsMessage(wins, stats), {
                parse_mode: 'MarkdownV2', ...signalsKeyboard
            }).catch(e => console.log('[TGBot] callback error:', e.message));
        }
    });

    console.log('[TGBot] Commands: /start, /signals, /pricing, /results, /wins');
}

// ─── Channel Posts (event-driven) ─────────────────────────

// Send to all configured destinations (channel + group)
async function sendToAll(text, options = {}) {
    const targets = [channelId, groupId].filter(Boolean);
    if (targets.length === 0) { console.log('[TGBot] No targets configured'); return; }
    for (const target of targets) {
        try {
            await bot.sendMessage(target, text, options);
            console.log(`[TGBot] ✅ Sent to ${target}`);
        } catch (e) {
            console.error(`[TGBot] ❌ Send error (${target}):`, e.message);
        }
    }
}

async function postSignalTeaser(signal) {
    if (!bot) { console.log('[TGBot] Skipping teaser — bot is null'); return; }
    if (!channelId && !groupId) { console.log('[TGBot] Skipping teaser — no channel/group ID set'); return; }
    if (!canPost()) { console.log('[TGBot] Skipping teaser — rate limit'); return; }
    const conf = Math.min(95, Math.round(signal.confidence || 0));
    if (conf < MIN_CONFIDENCE) return;
    if (lastPostedSignals.has(signal._id?.toString())) return;

    const sym = signal.symbol?.split(':')[0]?.replace(/USDT|USD/i, '') || signal.symbol;
    const long = signal.direction === 'UP';

    try {
        await sendToAll(buildTeaserMessage({ symbol: sym, direction: long ? 'LONG' : 'SHORT', long, confidence: conf }), {
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [[{ text: '🔓 View Full Signal', url: `${SITE}/signals` }]] }
        });
        lastPostedSignals.add(signal._id?.toString());
        postsThisHour++;
        console.log(`[TGBot] Posted: ${sym} ${long ? 'LONG' : 'SHORT'} ${conf}%`);
    } catch (e) {
        console.error('[TGBot] Post error:', e.message);
    }
}

async function postResult(signal, isWin, movePct) {
    if (!bot || (!channelId && !groupId) || !canPost()) return;
    try {
        await sendToAll(buildResultMessage(signal, isWin, movePct), {
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [[{ text: '📊 View All Results', url: `${SITE}/signals` }]] }
        });
        postsThisHour++;
    } catch (e) {
        console.error('[TGBot] Result error:', e.message);
    }
}

async function postDailyRecap() {
    if (!bot || (!channelId && !groupId)) return;
    try {
        const [stats, wins] = await Promise.all([getRecentStats(), getTopWins(5)]);
        if (stats.total === 0) return;

        // Send daily stats
        await sendToAll(buildDailyRecap(stats), {
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [
                [{ text: '🔓 View All Signals', url: `${SITE}/signals` }],
                [{ text: '🚀 Start Free Trial', url: `${SITE}/pricing` }],
            ]}
        });

        // Send top wins separately (if any)
        if (wins.length > 0) {
            await sendToAll(buildTopWinsMessage(wins, stats), {
                parse_mode: 'MarkdownV2',
                reply_markup: { inline_keyboard: [
                    [{ text: '📊 View All Results', url: `${SITE}/signals` }],
                ]}
            });
        }

        console.log(`[TGBot] Daily recap: ${stats.total} signals, ${stats.winRate}% win rate, ${wins.length} top wins`);
    } catch (e) {
        console.error('[TGBot] Recap error:', e.message);
    }
}

// ─── Initialize ───────────────────────────────────────────
function initializeTelegramBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    channelId = process.env.TELEGRAM_CHANNEL_ID;
    groupId = process.env.TELEGRAM_GROUP_ID;

    if (!token) {
        console.log('[TGBot] TELEGRAM_BOT_TOKEN not set — disabled');
        return;
    }

    try {
        bot = new TelegramBot(token, { polling: true });

        let authFails = 0;
        bot.on('polling_error', (error) => {
            if (error.message?.includes('401')) {
                authFails++;
                if (authFails === 1) console.error('[TGBot] ❌ Invalid token (401). Stopping.');
                if (authFails >= 3) { bot.stopPolling(); bot = null; }
                return;
            }
            if (!error.message?.includes('409')) console.error('[TGBot] Error:', error.message);
        });

        setupCommands();

        // Share bot instance with X poster for approval DMs
        try { const { setTelegramBot } = require('./xPosterService'); setTelegramBot(bot); } catch (e) {}

        cron.schedule('0 * * * *', () => { postsThisHour = 0; });
        cron.schedule('0 21 * * *', postDailyRecap);
        cron.schedule('0 */6 * * *', () => { lastPostedSignals.clear(); });

        console.log(`[TGBot] ✅ Initialized${channelId ? ` | channel: ${channelId}` : ''}${groupId ? ` | group: ${groupId}` : ''}`);
    } catch (error) {
        console.error('[TGBot] Init failed:', error.message);
    }
}

module.exports = { initializeTelegramBot, postSignalTeaser, postResult, postDailyRecap };
