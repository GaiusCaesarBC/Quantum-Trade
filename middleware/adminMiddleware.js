// Use immutable Mongo user IDs from server configuration, never request fields.
module.exports = function requireAdmin(req, res, next) {
    const admins = (process.env.ADMIN_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!req.user?.id || !admins.includes(String(req.user.id))) {
        return res.status(403).json({ error: 'Administrator access required' });
    }
    next();
};
