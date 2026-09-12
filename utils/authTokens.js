const jwt = require('jsonwebtoken');

function verifyAccessToken(token) {
    const claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (claims.purpose !== 'access' || !claims.user?.id) {
        throw new Error('Access token required');
    }
    return claims;
}

function verifyChallengeToken(token) {
    const claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (claims.purpose !== '2fa_verification' || !claims.user?.id) {
        throw new Error('Two-factor challenge required');
    }
    return claims;
}

function requestToken(req) {
    const bearer = req.header('Authorization');
    return (bearer?.startsWith('Bearer ') ? bearer.slice(7) : null)
        || req.header('x-auth-token') || req.cookies?.token;
}

module.exports = { verifyAccessToken, verifyChallengeToken, requestToken };
