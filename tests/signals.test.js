const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { presentSignal, scoreSignal, signalViewer } = require('../utils/signalPresentation');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const Backtest = require('../services/backtestEngine');
const source = fs.readFileSync(require.resolve('../services/signalResultChecker'), 'utf8');
function checker(database = {}) {
    const ctx = { module: { exports: {} }, console: { log() {}, warn() {}, error() {} }, process: { env: {} },
        setTimeout: fn => { fn(); }, require: name => name.includes('models/Prediction') ? database : name.includes('telegramBot') ? { postResult: async () => {} }
            : name.includes('discordService') ? { postSignalResultToDiscord: async () => {} } : {}, };
    vm.runInNewContext(source, ctx);
    return { ctx, ...ctx.module.exports };
}
const signal = { _id: 'example', user: null, symbol: 'TEST', direction: 'UP', confidence: 80,
    entryPrice: 100, stopLoss: 95, takeProfit1: 103, takeProfit2: 108, takeProfit3: 112, targetPrice: 110 };
test('public previews cannot leak existing or newly added price fields', () => {
    const input = { ...signal, secretNewPrice: 999, analysis: { entry: 100 } };
    const preview = presentSignal(input, false);
    for (const k of ['entryPrice','stopLoss','takeProfit1','takeProfit2','takeProfit3','targetPrice','secretNewPrice','analysis','riskReward']) assert.equal(preview[k], undefined);
    assert.equal(preview.levelsLocked, true);
    assert.equal(presentSignal(input, true).entryPrice, 100);
    assert.equal(preview.score, scoreSignal(input).score);
});
test('expired and free subscriptions get previews; valid paid accounts get levels', async () => {
    const original = User.findById;
    process.env.JWT_SECRET = 'isolated-signal-tests';
    const token = jwt.sign({ user: { id: 'user' }, purpose: 'access' }, process.env.JWT_SECRET);
    try {
        for (const [subscription, paid] of [[{ status: 'free' }, false],
            [{ status: 'pro', currentPeriodEnd: new Date(0) }, false],
            [{ status: 'starter', currentPeriodEnd: new Date(Date.now() + 60000) }, true]]) {
            User.findById = async () => ({ subscription });
            let body;
            const res = { json: value => { body = value; } };
            await signalViewer({ header: n => n === 'Authorization' ? `Bearer ${token}` : undefined }, res, () => {});
            res.json([signal]); assert.equal(body[0].levelsLocked, !paid);
        }
    } finally { User.findById = original; }
});
test('large gaps still count as stop losses in both directions', () => {
    const { checkResult } = checker();
    for (const p of [94, 80, 50]) assert.equal(checkResult(signal, p).result, 'loss');
    assert.equal(checkResult({ ...signal, direction: 'DOWN', stopLoss: 105 }, 125).result, 'loss');
    assert.equal(checkResult(signal, NaN), null);
    assert.equal(checkResult(signal, -1), null);
});
test('checker visits over 100 records and atomically restricts system transitions', async () => {
    let visited = 0, expired = false;
    const database = {
        find(query) { assert.equal(query.user, null); return { sort() { return this; }, cursor() { return (async function* () { for (let i=0;i<105;i++) yield { ...signal, _id: String(i) }; })(); } }; },
        async findOneAndUpdate(query, update) { assert.equal(query.status, 'pending'); assert.equal(query.user, null); visited++; return { ...signal, ...update.$set }; },
        async updateMany(query) { assert.equal(query.user, null); expired = true; }
    };
    const c = checker(database);
    // No service connections; stub only the price acquisition boundary.
    vm.runInContext('getLivePrice = async () => 100', c.ctx);
    await c.runCheckCycle(); assert.equal(visited, 105); assert.equal(expired, true);
});
test('backtest executes completed signals at next open and accounts for both fees', () => {
    const engine = new Backtest({ commissionRate: 0.001, slippage: 0 });
    const bars = [100, 100, 100.15].map((open,i)=>({date:new Date(2026,0,i+1), open,close:open}));
    const result = engine.simulateTrades(bars, [{signal:'buy'}, {signal:'sell'}, {signal:'hold'}], 10000);
    const sell = result.trades.find(t=>t.type==='sell');
    assert.equal(result.trades[0].date, bars[1].date);
    assert.ok(sell.profit < 0);
    assert.ok(Math.abs(sell.profit - (result.finalValue - 10000)) < 1e-8);
    assert.equal(engine.calculateMetrics(result,bars,10000).winRate,0);
    assert.equal(result.equityCurve.at(-1).value,result.finalValue);
});
test('a final-bar buy signal is never executed retroactively', () => {
    const result = new Backtest({commissionRate:0,slippage:0}).simulateTrades(
        [{date:new Date(),open:100,close:100}], [{signal:'buy'}], 1000);
    assert.equal(result.trades.length,0); assert.equal(result.finalValue,1000);
});
