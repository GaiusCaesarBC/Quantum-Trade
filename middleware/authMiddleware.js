// server/middleware/authMiddleware.js
const { verifyAccessToken, requestToken } = require('../utils/authTokens');
const User = require('../models/User');

module.exports = async (req, res, next) => {
    const token = requestToken(req);

    if (!token) {
        console.log("[AuthMiddleware] No token found in cookies or headers.");
        return res.status(401).json({ msg: 'No token, authorization denied' });
    }

    try {
        // Validate JWT_SECRET exists
        if (!process.env.JWT_SECRET) {
            console.error("[AuthMiddleware] JWT_SECRET not configured");
            return res.status(500).json({ msg: 'Server configuration error' });
        }

        // 2. Verify token
        const decoded = verifyAccessToken(token);
        // Note: Removed token logging for security

        // 3. Attach user to request
        req.user = await User.findById(decoded.user.id).select('-password');

        if (!req.user) {
            console.log("[AuthMiddleware] User not found for token ID:", decoded.user.id);
            return res.status(401).json({ msg: 'Authorization denied: User not found' });
        }

        // User authenticated successfully
        next();
    } catch (err) {
        console.error("[AuthMiddleware] Token verification failed:", err.message);
        res.clearCookie('token', { 
            path: '/', 
            httpOnly: true, 
            sameSite: 'Lax', 
            secure: process.env.NODE_ENV === 'production' 
        });
        res.status(401).json({ msg: 'Token is not valid' });
    }
};