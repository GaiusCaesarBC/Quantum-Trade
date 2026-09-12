const { verifyAccessToken, requestToken } = require('./authTokens');
const User = require('../models/User');
const { getEffectivePlan } = require('../middleware/subscriptionMiddleware');

// Deliberately uses only the two measured inputs. No invented volume/momentum.
function scoreSignal(signal) {
    const confidence = Math.max(0, Math.min(100, Number(signal.confidence) || 0));
    const entry = Number(signal.entryPrice || signal.currentPrice);
    const stop = Number(signal.stopLoss);
    const target = Number(signal.takeProfit2 || signal.targetPrice);
    const risk = Math.abs(entry - stop);
    const rr = [entry, stop, target].every(Number.isFinite) && risk > 0
        ? Math.abs(target - entry) / risk : 0;
    return { score: Number((6 * confidence / 100 + 4 * Math.min(rr / 3, 1)).toFixed(1)),
        scoreVersion: 'confidence-risk-reward-v1', riskReward: Number(rr.toFixed(2)) };
}

function presentSignal(signal, paid) {
    const scored = { ...signal, ...scoreSignal(signal) };
    if (paid) return { ...scored, levelsLocked: false };
    // An allowlist prevents new price fields from accidentally bypassing the paywall.
    const fields = ['_id','id','symbol','asset','direction','confidence','tier','assetType',
        'signalStrength','status','result','resultText','createdAt','expiresAt','isBestSetup',
        'score','scoreVersion'];
    return { ...Object.fromEntries(fields.filter(k => scored[k] !== undefined).map(k => [k, scored[k]])), levelsLocked: true };
}

async function signalViewer(req, res, next) {
    let paid = false;
    try {
        const token = requestToken(req);
        if (token) {
            const claims = verifyAccessToken(token);
            const user = await User.findById(claims.user.id);
            if (user) paid = ['starter','pro','premium','elite'].includes(getEffectivePlan(user).plan);
        }
    } catch (_) { /* Unauthenticated requests get the public preview. */ }
    const json = res.json.bind(res);
    res.json = body => json(Array.isArray(body) ? body.map(s => presentSignal(s, paid))
        : body?.signals ? { ...body, signals: body.signals.map(s => presentSignal(s, paid)) }
        : body?.trades ? { ...body, trades: body.trades.map(s => presentSignal(s, paid || ['win','loss'].includes(s.result))) } : body);
    next();
}
module.exports = { scoreSignal, presentSignal, signalViewer };
