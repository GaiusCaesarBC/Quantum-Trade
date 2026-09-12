const { verifyChallengeToken } = require('../utils/authTokens');
// server/routes/twoFactorRoutes.js - Two-Factor Authentication Routes

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/authMiddleware');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');

// Constants
const CODE_EXPIRY_MINUTES = 5;
const MAX_CODES_PER_WINDOW = 5;
const RATE_LIMIT_WINDOW_MINUTES = 15;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const BACKUP_CODES_COUNT = 10;

// ============ HELPER FUNCTIONS ============

/**
 * Generate a random verification code
 */
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Generate backup codes
 */
function generateBackupCodes(count = BACKUP_CODES_COUNT) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        // Generate 8-character alphanumeric codes
        codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
    }
    return codes;
}

/**
 * Hash backup codes for storage
 */
async function hashBackupCodes(codes) {
    const salt = await bcrypt.genSalt(10);
    return Promise.all(codes.map(code => bcrypt.hash(code, salt)));
}

/**
 * Check if user is rate limited
 */
function isRateLimited(user) {
    if (!user.twoFactor.codesSentResetAt) return false;

    const resetTime = new Date(user.twoFactor.codesSentResetAt);
    const now = new Date();

    // If window has passed, reset
    if (now > resetTime) {
        return false;
    }

    // Check if max codes sent
    return user.twoFactor.codesSentCount >= MAX_CODES_PER_WINDOW;
}

/**
 * Check if user is locked out
 */
function isLockedOut(user) {
    if (!user.twoFactor.lockedUntil) return false;
    return new Date() < new Date(user.twoFactor.lockedUntil);
}

/**
 * Cookie options helper
 */
function getCookieOptions() {
    const isProduction = process.env.NODE_ENV === 'production';
    return {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'None' : 'Lax',
        maxAge: 3600000,
        path: '/'
    };
}

// ============ SETUP ROUTES ============

/**
 * @route   GET /api/2fa/status
 * @desc    Get current 2FA status
 * @access  Private
 */
router.get('/status', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('twoFactor email');

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        res.json({
            success: true,
            twoFactor: {
                enabled: user.twoFactor?.enabled || false,
                method: user.twoFactor?.method || null,
                phone: user.twoFactor?.phone ?
                    `***-***-${user.twoFactor.phone.slice(-4)}` : null,
                phoneVerified: user.twoFactor?.phoneVerified || false,
                hasBackupCodes: (user.twoFactor?.backupCodes?.length || 0) > 0,
                enabledAt: user.twoFactor?.enabledAt || null
            },
            smsAvailable: smsService.isAvailable()
        });
    } catch (error) {
        console.error('[2FA] Status error:', error);
        res.status(500).json({ success: false, error: 'Failed to get 2FA status' });
    }
});

/**
 * @route   POST /api/2fa/setup/init
 * @desc    Initialize 2FA setup - send verification code
 * @access  Private
 */
router.post('/setup/init', auth, [
    body('method').isIn(['email', 'sms', 'both']).withMessage('Invalid method'),
    body('phone').optional().isMobilePhone().withMessage('Invalid phone number')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
        const { method, phone } = req.body;
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Check if already enabled
        if (user.twoFactor?.enabled) {
            return res.status(400).json({
                success: false,
                error: '2FA is already enabled. Disable it first to change settings.'
            });
        }

        // If SMS method, validate phone
        if ((method === 'sms' || method === 'both') && !phone) {
            return res.status(400).json({
                success: false,
                error: 'Phone number required for SMS verification'
            });
        }

        // Check if SMS service is available
        if ((method === 'sms' || method === 'both') && !smsService.isAvailable()) {
            return res.status(400).json({
                success: false,
                error: 'SMS service is not available'
            });
        }

        // Check rate limiting
        if (isRateLimited(user)) {
            const resetTime = new Date(user.twoFactor.codesSentResetAt);
            const minutesLeft = Math.ceil((resetTime - new Date()) / 60000);
            return res.status(429).json({
                success: false,
                error: `Too many requests. Please wait ${minutesLeft} minutes.`
            });
        }

        // Generate verification code
        const code = generateCode();
        const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

        // Initialize twoFactor if needed
        if (!user.twoFactor) {
            user.twoFactor = {};
        }

        // Store pending verification
        user.twoFactor.pendingCode = await bcrypt.hash(code, 10);
        user.twoFactor.pendingCodeExpires = expiresAt;
        user.twoFactor.pendingMethod = method;
        user.twoFactor.pendingPhone = phone || null;

        // Update rate limiting
        const windowEnd = new Date(Date.now() + RATE_LIMIT_WINDOW_MINUTES * 60 * 1000);
        if (!user.twoFactor.codesSentResetAt || new Date() > new Date(user.twoFactor.codesSentResetAt)) {
            user.twoFactor.codesSentCount = 1;
            user.twoFactor.codesSentResetAt = windowEnd;
        } else {
            user.twoFactor.codesSentCount += 1;
        }
        user.twoFactor.lastCodeSent = new Date();

        await user.save();

        // Send code based on method
        try {
            if (method === 'email') {
                await emailService.send2FACode(user.email, code, user.username);
            } else if (method === 'sms') {
                await smsService.send2FACode(phone, code);
            } else if (method === 'both') {
                // Send to email first, SMS for verification
                await emailService.send2FACode(user.email, code, user.username);
            }

            console.log(`[2FA] Setup code sent to user ${user.username} via ${method}`);

            res.json({
                success: true,
                message: `Verification code sent via ${method === 'email' ? 'email' : method === 'sms' ? 'SMS' : 'email'}`,
                expiresIn: CODE_EXPIRY_MINUTES * 60,
                method
            });
        } catch (sendError) {
            console.error('[2FA] Error sending code:', sendError);
            res.status(500).json({
                success: false,
                error: `Failed to send verification code: ${sendError.message}`
            });
        }
    } catch (error) {
        console.error('[2FA] Setup init error:', error);
        res.status(500).json({ success: false, error: 'Failed to initialize 2FA setup' });
    }
});

/**
 * @route   POST /api/2fa/setup/verify
 * @desc    Verify code and complete 2FA setup
 * @access  Private
 */
router.post('/setup/verify', auth, [
    body('code').isLength({ min: 6, max: 8 }).withMessage('Invalid code format')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
        const { code } = req.body;
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Check if there's a pending setup
        if (!user.twoFactor?.pendingCode) {
            return res.status(400).json({
                success: false,
                error: 'No pending 2FA setup. Please start the setup process again.'
            });
        }

        // Check if code expired
        if (new Date() > new Date(user.twoFactor.pendingCodeExpires)) {
            user.twoFactor.pendingCode = null;
            user.twoFactor.pendingCodeExpires = null;
            await user.save();
            return res.status(400).json({
                success: false,
                error: 'Verification code has expired. Please request a new code.'
            });
        }

        // Verify code
        const isValidCode = await bcrypt.compare(code.toString(), user.twoFactor.pendingCode);

        if (!isValidCode) {
            return res.status(400).json({
                success: false,
                error: 'Invalid verification code'
            });
        }

        // Generate backup codes
        const backupCodes = generateBackupCodes();
        const hashedBackupCodes = await hashBackupCodes(backupCodes);

        // Enable 2FA
        user.twoFactor.enabled = true;
        user.twoFactor.method = user.twoFactor.pendingMethod;
        user.twoFactor.phone = user.twoFactor.pendingPhone;
        user.twoFactor.phoneVerified = user.twoFactor.pendingMethod === 'sms' || user.twoFactor.pendingMethod === 'both';
        user.twoFactor.backupCodes = hashedBackupCodes;
        user.twoFactor.backupCodesGeneratedAt = new Date();
        user.twoFactor.enabledAt = new Date();

        // Clear pending data
        user.twoFactor.pendingCode = null;
        user.twoFactor.pendingCodeExpires = null;
        user.twoFactor.pendingMethod = null;
        user.twoFactor.pendingPhone = null;
        user.twoFactor.failedAttempts = 0;

        await user.save();

        // Send notifications
        try {
            await emailService.send2FAEnabledNotification(user.email, user.username, user.twoFactor.method);
            await emailService.sendBackupCodes(user.email, user.username, backupCodes);
        } catch (notifyError) {
            console.error('[2FA] Error sending notifications:', notifyError);
        }

        console.log(`[2FA] Enabled for user ${user.username} (method: ${user.twoFactor.method})`);

        res.json({
            success: true,
            message: 'Two-Factor Authentication enabled successfully!',
            backupCodes,
            method: user.twoFactor.method
        });
    } catch (error) {
        console.error('[2FA] Setup verify error:', error);
        res.status(500).json({ success: false, error: 'Failed to verify 2FA setup' });
    }
});

/**
 * @route   POST /api/2fa/disable
 * @desc    Disable 2FA (requires password confirmation)
 * @access  Private
 */
router.post('/disable', auth, [
    body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
        const { password } = req.body;
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Verify password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(400).json({ success: false, error: 'Invalid password' });
        }

        // Disable 2FA
        user.twoFactor = {
            enabled: false,
            method: null,
            phone: null,
            phoneVerified: false,
            pendingCode: null,
            pendingCodeExpires: null,
            pendingMethod: null,
            pendingPhone: null,
            backupCodes: [],
            backupCodesGeneratedAt: null,
            lastCodeSent: null,
            codesSentCount: 0,
            codesSentResetAt: null,
            failedAttempts: 0,
            lockedUntil: null,
            enabledAt: null
        };

        await user.save();

        console.log(`[2FA] Disabled for user ${user.username}`);

        res.json({
            success: true,
            message: 'Two-Factor Authentication has been disabled'
        });
    } catch (error) {
        console.error('[2FA] Disable error:', error);
        res.status(500).json({ success: false, error: 'Failed to disable 2FA' });
    }
});

/**
 * @route   POST /api/2fa/regenerate-backup-codes
 * @desc    Generate new backup codes
 * @access  Private
 */
router.post('/regenerate-backup-codes', auth, [
    body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
        const { password } = req.body;
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (!user.twoFactor?.enabled) {
            return res.status(400).json({ success: false, error: '2FA is not enabled' });
        }

        // Verify password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(400).json({ success: false, error: 'Invalid password' });
        }

        // Generate new backup codes
        const backupCodes = generateBackupCodes();
        const hashedBackupCodes = await hashBackupCodes(backupCodes);

        user.twoFactor.backupCodes = hashedBackupCodes;
        user.twoFactor.backupCodesGeneratedAt = new Date();

        await user.save();

        // Send backup codes via email
        try {
            await emailService.sendBackupCodes(user.email, user.username, backupCodes);
        } catch (emailError) {
            console.error('[2FA] Error sending backup codes email:', emailError);
        }

        console.log(`[2FA] Backup codes regenerated for user ${user.username}`);

        res.json({
            success: true,
            message: 'New backup codes generated',
            backupCodes
        });
    } catch (error) {
        console.error('[2FA] Regenerate codes error:', error);
        res.status(500).json({ success: false, error: 'Failed to regenerate backup codes' });
    }
});

// ============ LOGIN VERIFICATION ROUTES ============

/**
 * @route   POST /api/2fa/send-login-code
 * @desc    Send 2FA code during login
 * @access  Public (with temp token)
 */
router.post('/send-login-code', async (req, res) => {
    try {
        const { tempToken, method } = req.body;

        if (!tempToken) {
            return res.status(400).json({ success: false, error: 'Temporary token required' });
        }

        // Verify temp token
        let decoded;
        try {
            decoded = verifyChallengeToken(tempToken);
        } catch (err) {
            return res.status(401).json({ success: false, error: 'Invalid or expired token' });
        }

        if (decoded.purpose !== '2fa_verification') {
            return res.status(400).json({ success: false, error: 'Invalid token type' });
        }

        const user = await User.findById(decoded.user.id);

        if (!user || !user.twoFactor?.enabled) {
            return res.status(400).json({ success: false, error: '2FA not enabled for this user' });
        }

        // Check rate limiting
        if (isRateLimited(user)) {
            const resetTime = new Date(user.twoFactor.codesSentResetAt);
            const minutesLeft = Math.ceil((resetTime - new Date()) / 60000);
            return res.status(429).json({
                success: false,
                error: `Too many requests. Please wait ${minutesLeft} minutes.`
            });
        }

        // Check lockout
        if (isLockedOut(user)) {
            const unlockTime = new Date(user.twoFactor.lockedUntil);
            const minutesLeft = Math.ceil((unlockTime - new Date()) / 60000);
            return res.status(429).json({
                success: false,
                error: `Account temporarily locked. Please wait ${minutesLeft} minutes.`
            });
        }

        // Determine which method to use
        const sendMethod = method || user.twoFactor.method;

        // Generate and store code
        const code = generateCode();
        const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

        user.twoFactor.pendingCode = await bcrypt.hash(code, 10);
        user.twoFactor.pendingCodeExpires = expiresAt;

        // Update rate limiting
        const windowEnd = new Date(Date.now() + RATE_LIMIT_WINDOW_MINUTES * 60 * 1000);
        if (!user.twoFactor.codesSentResetAt || new Date() > new Date(user.twoFactor.codesSentResetAt)) {
            user.twoFactor.codesSentCount = 1;
            user.twoFactor.codesSentResetAt = windowEnd;
        } else {
            user.twoFactor.codesSentCount += 1;
        }
        user.twoFactor.lastCodeSent = new Date();

        await user.save();

        // Send code
        try {
            if (sendMethod === 'email' || sendMethod === 'both') {
                await emailService.send2FACode(user.email, code, user.username);
            }
            if (sendMethod === 'sms' && user.twoFactor.phone) {
                await smsService.send2FACode(user.twoFactor.phone, code);
            }

            res.json({
                success: true,
                message: `Verification code sent via ${sendMethod}`,
                expiresIn: CODE_EXPIRY_MINUTES * 60
            });
        } catch (sendError) {
            console.error('[2FA] Error sending login code:', sendError);
            res.status(500).json({ success: false, error: 'Failed to send verification code' });
        }
    } catch (error) {
        console.error('[2FA] Send login code error:', error);
        res.status(500).json({ success: false, error: 'Failed to send verification code' });
    }
});

/**
 * @route   POST /api/2fa/verify-login
 * @desc    Verify 2FA code and complete login
 * @access  Public (with temp token)
 */
router.post('/verify-login', async (req, res) => {
    try {
        const { tempToken, code } = req.body;

        if (!tempToken || !code) {
            return res.status(400).json({ success: false, error: 'Token and code required' });
        }

        // Verify temp token
        let decoded;
        try {
            decoded = verifyChallengeToken(tempToken);
        } catch (err) {
            return res.status(401).json({ success: false, error: 'Invalid or expired token' });
        }

        if (decoded.purpose !== '2fa_verification') {
            return res.status(400).json({ success: false, error: 'Invalid token type' });
        }

        const user = await User.findById(decoded.user.id);

        if (!user || !user.twoFactor?.enabled) {
            return res.status(400).json({ success: false, error: '2FA not enabled for this user' });
        }

        // Check lockout
        if (isLockedOut(user)) {
            const unlockTime = new Date(user.twoFactor.lockedUntil);
            const minutesLeft = Math.ceil((unlockTime - new Date()) / 60000);
            return res.status(429).json({
                success: false,
                error: `Account temporarily locked. Please wait ${minutesLeft} minutes.`
            });
        }

        // Check if code exists and is not expired
        if (!user.twoFactor.pendingCode) {
            return res.status(400).json({
                success: false,
                error: 'No verification code pending. Please request a new code.'
            });
        }

        if (new Date() > new Date(user.twoFactor.pendingCodeExpires)) {
            user.twoFactor.pendingCode = null;
            user.twoFactor.pendingCodeExpires = null;
            await user.save();
            return res.status(400).json({
                success: false,
                error: 'Verification code has expired. Please request a new code.'
            });
        }

        // Try to verify as regular code first
        let isValidCode = await bcrypt.compare(code.toString(), user.twoFactor.pendingCode);

        // If not valid, check backup codes
        if (!isValidCode && user.twoFactor.backupCodes?.length > 0) {
            for (let i = 0; i < user.twoFactor.backupCodes.length; i++) {
                const isBackupCode = await bcrypt.compare(code.toString().toUpperCase(), user.twoFactor.backupCodes[i]);
                if (isBackupCode) {
                    isValidCode = true;
                    // Remove used backup code
                    user.twoFactor.backupCodes.splice(i, 1);
                    console.log(`[2FA] Backup code used by ${user.username}, ${user.twoFactor.backupCodes.length} remaining`);
                    break;
                }
            }
        }

        if (!isValidCode) {
            // Increment failed attempts
            user.twoFactor.failedAttempts = (user.twoFactor.failedAttempts || 0) + 1;

            // Check if should lock
            if (user.twoFactor.failedAttempts >= MAX_FAILED_ATTEMPTS) {
                user.twoFactor.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
                user.twoFactor.failedAttempts = 0;
                await user.save();
                return res.status(429).json({
                    success: false,
                    error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`
                });
            }

            await user.save();
            return res.status(400).json({
                success: false,
                error: 'Invalid verification code',
                attemptsRemaining: MAX_FAILED_ATTEMPTS - user.twoFactor.failedAttempts
            });
        }

        // Code is valid - complete login
        user.twoFactor.pendingCode = null;
        user.twoFactor.pendingCodeExpires = null;
        user.twoFactor.failedAttempts = 0;

        // ✅ CHECK LOGIN STREAK on 2FA login completion
        let dailyBonus = null;
        try {
            const loginResult = await user.checkLoginStreak();
            console.log('[2FA] Login streak check:', loginResult);

            if (loginResult.isNewDay) {
                dailyBonus = {
                    isNewDay: true,
                    streak: loginResult.streak,
                    maxStreak: loginResult.maxStreak,
                    bonusXp: loginResult.bonusXp || 0,
                    bonusCoins: loginResult.bonusCoins || 0
                };
            } else {
                dailyBonus = {
                    isNewDay: false,
                    streak: loginResult.streak,
                    maxStreak: loginResult.maxStreak
                };
            }
        } catch (streakError) {
            console.error('[2FA] Streak check error:', streakError.message);
        }

        await user.save();

        // Generate full JWT
        const payload = { user: { id: user.id }, purpose: 'access' };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

        // Set cookie
        const cookieOptions = getCookieOptions();
        res.cookie('token', token, cookieOptions);

        console.log(`[2FA] Login verified for user ${user.username}. Streak: ${dailyBonus?.streak || 0}`);

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                email: user.email,
                username: user.username
            },
            dailyBonus: dailyBonus
        });
    } catch (error) {
        console.error('[2FA] Verify login error:', error);
        res.status(500).json({ success: false, error: 'Failed to verify code' });
    }
});

module.exports = router;
