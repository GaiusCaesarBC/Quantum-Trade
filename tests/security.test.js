const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'isolated-regression-test-secret-not-for-deployment';
const { verifyAccessToken, verifyChallengeToken } = require('../utils/authTokens');
const User = require('../models/User');
const auth = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/adminMiddleware');

function response() { return { code: 200, status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; }, clearCookie() {} }; }
test('challenge, expired, and legacy JWTs cannot authorize requests', async () => {
    for (const claims of [{ user: { id: '123' }, purpose: '2fa_verification' }, { user: { id: '123' } },
        { user: { id: '123' }, purpose: 'access', exp: 1 }]) {
        const token = jwt.sign(claims, process.env.JWT_SECRET);
        assert.throws(() => verifyAccessToken(token));
        const res = response(); let passed = false;
        await auth({ header: n => n === 'Authorization' ? `Bearer ${token}` : undefined }, res, () => { passed = true; });
        assert.equal(passed, false); assert.equal(res.code, 401);
    }
});
test('access JWT authorizes only a user that still exists', async () => {
    const original = User.findById;
    const token = jwt.sign({ user: { id: '123' }, purpose: 'access' }, process.env.JWT_SECRET);
    try {
        for (const exists of [true, false]) {
            User.findById = () => ({ select: async () => exists ? { id: '123' } : null });
            const res = response(); let passed = false;
            await auth({ header: n => n === 'x-auth-token' ? token : undefined }, res, () => { passed = true; });
            assert.equal(passed, exists);
        }
    } finally { User.findById = original; }
});
test('2FA verifier accepts the issuer purpose and rejects access tokens', () => {
    const challenge = jwt.sign({ user: { id: '123' }, purpose: '2fa_verification' }, process.env.JWT_SECRET);
    assert.equal(verifyChallengeToken(challenge).user.id, '123');
    assert.throws(() => verifyChallengeToken(jwt.sign({ user: { id: '123' }, purpose: 'access' }, process.env.JWT_SECRET)));
});
test('admin rights depend on server allowlist, not a request-supplied role', () => {
    process.env.ADMIN_USER_IDS = 'abc';
    for (const [user, expected] of [[undefined, false], [{ id: 'other', role: 'admin' }, false], [{ id: 'abc' }, true]]) {
        const res = response(); let passed = false;
        requireAdmin({ user }, res, () => { passed = true; });
        assert.equal(passed, expected);
    }
    delete process.env.ADMIN_USER_IDS;
    const res = response(); requireAdmin({ user: { id: 'abc' } }, res, () => assert.fail('empty allowlist'));
    assert.equal(res.code, 403);
});
