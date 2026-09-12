// server/routes/authRoutes.js - UPDATED WITH AVATAR UPLOAD AND TOKEN FIX

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/authMiddleware');
const { upload, cloudinary } = require('../config/cloudinaryConfig');
const { strictBotProtection } = require('../middleware/botProtection');
const { PLAN_LIMITS } = require('../middleware/subscriptionMiddleware');
const NotificationService = require('../services/notificationService');

// ✅ Cookie settings that work for BOTH localhost and production
const getCookieOptions = () => {
    const isProduction = process.env.NODE_ENV === 'production';

    return {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'None' : 'Lax',
        maxAge: 3600000,
        path: '/'
    };
};

// Sanitize string values for MongoDB queries (NoSQL injection prevention)
const sanitizeQueryString = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    return value;
};

// @route   GET api/auth/me
router.get('/me', auth, async (req, res) => {
    console.log(`[Auth Route /me] Request received for user ID from token: ${req.user.id}`);
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) {
            console.log(`[Auth Route /me] User not found in DB for ID: ${req.user.id}`);
            return res.status(404).json({ msg: 'User not found' });
        }
        console.log(`[Auth Route /me] Successfully fetched user: ${user.email}`);

        // Get user's subscription plan and limits
        const userPlan = user.subscription?.status || 'free';
        const planLimits = PLAN_LIMITS[userPlan] || PLAN_LIMITS.free;

        // Return user with subscription info
        res.json({
            ...user.toObject(),
            subscription: {
                ...user.subscription?.toObject?.() || user.subscription || {},
                status: userPlan,
                planLimits: planLimits
            }
        });
    } catch (err) {
        console.error('[Auth Route /me] Server error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/register
router.post(
    '/register',
    strictBotProtection,
    [
        body('email', 'Please include a valid email').isEmail().normalizeEmail(),
        body('password', 'Password must be 8 or more characters').isLength({ min: 8 }),
        body('username', 'Username must be 3-20 characters with letters, numbers, and underscores only')
            .notEmpty()
            .isLength({ min: 3, max: 20 })
            .matches(/^[a-zA-Z0-9_]+$/)
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log('[Auth Route /register] Validation errors:', errors.array());
            return res.status(400).json({ errors: errors.array() });
        }
        const { email, password, username } = req.body;
        try {
            // Sanitize inputs for MongoDB queries (NoSQL injection prevention)
            const sanitizedEmail = sanitizeQueryString(email);
            const sanitizedUsername = sanitizeQueryString(username);
            if (!sanitizedEmail || !sanitizedUsername) {
                return res.status(400).json({ msg: 'Invalid input format' });
            }

            let user = await User.findOne({ email: sanitizedEmail });
            if (user) {
                console.log(`[Auth Route /register] Registration failed: User with email ${sanitizedEmail} already exists.`);
                return res.status(400).json({ msg: 'User already exists' });
            }
            let userByUsername = await User.findOne({ username: sanitizedUsername });
            if (userByUsername) {
                console.log(`[Auth Route /register] Registration failed: Username ${sanitizedUsername} already taken.`);
                return res.status(400).json({ msg: 'Username already taken' });
            }
            user = new User({ email, password, username });
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(password, salt);
            await user.save();
            console.log(`[Auth Route /register] New user created: ${user.email} (Username: ${user.username})`);

            const payload = { user: { id: user.id }, purpose: 'access' };
           jwt.sign(
    payload,
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
    async (err, token) => {
        if (err) {
            console.error('[Auth Route /login] JWT signing error:', err.message);
            throw err;
        }
        
        // ✅ CHECK DAILY LOGIN STREAK
        let dailyBonus = null;
        try {
            const loginResult = await user.checkLoginStreak();
            console.log('[Login] Daily login check:', loginResult);
            
            if (loginResult.isNewDay) {
                // Award XP for daily login
                if (loginResult.bonusXp > 0) {
                    await user.addXp(loginResult.bonusXp, 'daily_login');
                }
                
                dailyBonus = {
                    streak: loginResult.streak,
                    maxStreak: loginResult.maxStreak,
                    xpEarned: loginResult.bonusXp,
                    coinsEarned: loginResult.bonusCoins,
                    message: `Day ${loginResult.streak} login streak! 🔥`
                };
                
                console.log(`[Login] Daily bonus awarded to ${user.username}:`, dailyBonus);

                // Send login streak notification
                try {
                    await NotificationService.createLoginStreakNotification(
                        user._id,
                        loginResult.streak,
                        loginResult.bonusXp
                    );
                } catch (notifError) {
                    console.error('[Login] Error sending streak notification:', notifError.message);
                }
            }
        } catch (streakError) {
            console.error('[Login] Error checking streak:', streakError);
            // Don't fail login if streak check fails
        }
        
        const cookieOptions = getCookieOptions();
        res.cookie('token', token, cookieOptions);
        console.log('[Auth Route /login] Cookie set with options:', cookieOptions);
        
        res.json({ 
            success: true, 
            msg: "Logged in successfully",
            token: token,
            user: {
                id: user.id,
                email: user.email,
                username: user.username
            },
            dailyBonus: dailyBonus  // ✅ Include daily bonus in response
        });
        
        console.log(`[Auth Route /login] Login successful for ${email}. HttpOnly cookie issued.`);
    }
);
        } catch (err) {
            console.error('[Auth Route /register] Server error during registration:', err.message);
            res.status(500).send('Server error');
        }
    }
);

// POST /api/gamification/daily-login
router.post('/daily-login', auth, async (req, res) => {
    try {
        console.log('[Daily Login] Checking for user:', req.user.id);
        
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Check login streak
        const result = await user.checkLoginStreak();
        console.log('[Daily Login] Streak result:', result);
        
        // Award XP if new day
        if (result.isNewDay && result.bonusXp > 0) {
            await user.addXp(result.bonusXp, 'daily_login');

            // Send login streak notification
            try {
                await NotificationService.createLoginStreakNotification(
                    user._id,
                    result.streak,
                    result.bonusXp
                );
            } catch (notifError) {
                console.error('[Daily Login] Error sending streak notification:', notifError.message);
            }
        }

        // Refresh user data
        await user.save();
        
        res.json({
            success: true,
            streak: result.streak,
            maxStreak: result.maxStreak,
            isNewDay: result.isNewDay,
            bonusXp: result.bonusXp || 0,
            bonusCoins: result.bonusCoins || 0,
            gamification: {
                xp: user.gamification.xp,
                totalXpEarned: user.gamification.totalXpEarned,
                level: user.gamification.level,
                title: user.gamification.title,
                nexusCoins: user.gamification.nexusCoins,
                loginStreak: user.gamification.loginStreak
            }
        });
        
    } catch (error) {
        console.error('[Daily Login] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   POST api/auth/login
router.post(
    '/login',
    strictBotProtection,
    [
        body('email', 'Please include a valid email').isEmail().normalizeEmail(),
        body('password', 'Password is required').exists().isLength({ min: 1 })
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log('[Auth Route /login] Validation errors:', errors.array());
            return res.status(400).json({ errors: errors.array() });
        }
        const { email, password } = req.body;
        try {
            // Sanitize email for MongoDB query (NoSQL injection prevention)
            const sanitizedEmail = sanitizeQueryString(email);
            if (!sanitizedEmail) {
                return res.status(400).json({ msg: 'Invalid Credentials' });
            }

            let user = await User.findOne({ email: sanitizedEmail });
            if (!user) {
                console.log('[Auth Route /login] Login failed: User not found for email:', sanitizedEmail);
                return res.status(400).json({ msg: 'Invalid Credentials' });
            }
            console.log('[Auth Route /login] User found. Email:', user.email);
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                console.log('[Auth Route /login] Login failed: Password mismatch for user:', user.email);
                return res.status(400).json({ msg: 'Invalid Credentials' });
            }
            console.log('[Auth Route /login] Password matched for user:', user.email);

            // ✅ CHECK IF 2FA IS ENABLED
            if (user.twoFactor && user.twoFactor.enabled) {
                console.log(`[Auth Route /login] 2FA enabled for user: ${user.email}, method: ${user.twoFactor.method}`);

                // Check if account is locked from failed 2FA attempts
                if (user.twoFactor.lockedUntil && user.twoFactor.lockedUntil > new Date()) {
                    const minutesLeft = Math.ceil((user.twoFactor.lockedUntil - new Date()) / 60000);
                    return res.status(429).json({
                        msg: `Account temporarily locked. Try again in ${minutesLeft} minutes.`
                    });
                }

                // Generate temporary token for 2FA verification (short-lived, 10 minutes)
                const tempPayload = {
                    user: { id: user.id },
                    purpose: '2fa_verification',
                    exp: Math.floor(Date.now() / 1000) + (10 * 60) // 10 minutes
                };

                const tempToken = jwt.sign(tempPayload, process.env.JWT_SECRET);

                // Return 2FA required response (don't issue full token yet)
                return res.json({
                    success: true,
                    requires2FA: true,
                    tempToken: tempToken,
                    method: user.twoFactor.method,
                    email: user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Masked email
                    phone: user.twoFactor.phone ? user.twoFactor.phone.replace(/(.{3})(.*)(.{4})/, '$1****$3') : null, // Masked phone
                    msg: '2FA verification required'
                });
            }

            // ✅ NO 2FA - Proceed with normal login

            // ✅ CHECK LOGIN STREAK on every login
            let dailyBonus = null;
            try {
                const loginResult = await user.checkLoginStreak();
                console.log('[Auth Route /login] Login streak check:', loginResult);

                if (loginResult.isNewDay) {
                    // Award daily login XP
                    if (loginResult.bonusXp > 0) {
                        try {
                            await user.addXp(loginResult.bonusXp, 'daily_login');
                            console.log(`[Auth Route /login] Awarded ${loginResult.bonusXp} XP for daily login (streak: ${loginResult.streak})`);
                        } catch (xpErr) {
                            console.error('[Auth Route /login] Error awarding XP:', xpErr.message);
                        }
                    }

                    dailyBonus = {
                        isNewDay: true,
                        streak: loginResult.streak,
                        maxStreak: loginResult.maxStreak,
                        bonusXp: loginResult.bonusXp || 0,
                        bonusCoins: loginResult.bonusCoins || 0
                    };

                    // Send login streak notification
                    try {
                        await NotificationService.createLoginStreakNotification(
                            user._id,
                            loginResult.streak,
                            loginResult.bonusXp || 0
                        );
                    } catch (notifError) {
                        console.error('[Auth Route /login] Error sending streak notification:', notifError.message);
                    }
                } else {
                    dailyBonus = {
                        isNewDay: false,
                        streak: loginResult.streak,
                        maxStreak: loginResult.maxStreak
                    };
                }
            } catch (streakError) {
                console.error('[Auth Route /login] Streak check error:', streakError.message);
            }

            const payload = { user: { id: user.id }, purpose: 'access' };
            jwt.sign(
                payload,
                process.env.JWT_SECRET,
                { expiresIn: '1h' },
                (err, token) => {
                    if (err) {
                        console.error('[Auth Route /login] JWT signing error:', err.message);
                        throw err;
                    }
                    const cookieOptions = getCookieOptions();
                    res.cookie('token', token, cookieOptions);
                    console.log('[Auth Route /login] Cookie set with options:', cookieOptions);

                    // ✅ FIXED: Return token in response body!
                    res.json({
                        success: true,
                        msg: "Logged in successfully",
                        token: token,
                        user: {
                            id: user.id,
                            email: user.email,
                            username: user.username
                        },
                        dailyBonus: dailyBonus
                    });

                    console.log(`[Auth Route /login] Login successful for ${email}. HttpOnly cookie issued. Streak: ${dailyBonus?.streak || 0}`);
                }
            );
        } catch (err) {
            console.error('[Auth Route /login] Server error during login:', err.message);
            res.status(500).send('Server error');
        }
    }
);

// @route   POST api/auth/logout
router.post('/logout', auth, (req, res) => {
    const cookieOptions = getCookieOptions();
    res.clearCookie('token', cookieOptions);
    res.json({ msg: 'Logged out successfully' });
    console.log(`[Auth Route /logout] User ${req.user?.id || 'unknown'} logged out. HttpOnly cookie cleared.`);
});

// 🆕 @route   POST api/auth/upload-avatar
// 🆕 @desc    Upload profile picture
// 🆕 @access  Private
router.post('/upload-avatar', auth, upload.single('avatar'), async (req, res) => {
    try {
        console.log(`[Auth Route /upload-avatar] Upload request from user: ${req.user.id}`);
        
        if (!req.file) {
            console.log('[Auth Route /upload-avatar] No file uploaded');
            return res.status(400).json({ msg: 'No file uploaded' });
        }

        const user = await User.findById(req.user.id);
        
        if (!user) {
            console.log(`[Auth Route /upload-avatar] User not found: ${req.user.id}`);
            return res.status(404).json({ msg: 'User not found' });
        }

        // If user already has an avatar, delete the old one from Cloudinary
        if (user.profile.avatar) {
            try {
                // Extract public_id from the Cloudinary URL
                const urlParts = user.profile.avatar.split('/');
                const publicIdWithExt = urlParts[urlParts.length - 1];
                const publicId = 'nexussignal-avatars/' + publicIdWithExt.split('.')[0];
                
                await cloudinary.uploader.destroy(publicId);
                console.log(`[Auth Route /upload-avatar] Deleted old avatar: ${publicId}`);
            } catch (deleteError) {
                console.error('[Auth Route /upload-avatar] Error deleting old avatar:', deleteError);
                // Continue anyway - old image stays in Cloudinary but gets replaced
            }
        }

        // Update user's avatar URL (Cloudinary returns the URL in req.file.path)
        user.profile.avatar = req.file.path;
        await user.save();

        console.log(`[Auth Route /upload-avatar] Avatar uploaded successfully: ${req.file.path}`);

        res.json({
            success: true,
            msg: 'Avatar uploaded successfully',
            avatarUrl: req.file.path
        });
    } catch (error) {
        console.error('[Auth Route /upload-avatar] Error uploading avatar:', error);
        res.status(500).json({ msg: 'Server error uploading avatar' });
    }
});

// 🆕 @route   DELETE api/auth/delete-avatar
// 🆕 @desc    Delete profile picture
// 🆕 @access  Private
router.delete('/delete-avatar', auth, async (req, res) => {
    try {
        console.log(`[Auth Route /delete-avatar] Delete request from user: ${req.user.id}`);
        
        const user = await User.findById(req.user.id);
        
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        if (!user.profile.avatar) {
            return res.status(400).json({ msg: 'No avatar to delete' });
        }

        // Delete from Cloudinary
        try {
            const urlParts = user.profile.avatar.split('/');
            const publicIdWithExt = urlParts[urlParts.length - 1];
            const publicId = 'nexussignal-avatars/' + publicIdWithExt.split('.')[0];
            
            await cloudinary.uploader.destroy(publicId);
            console.log(`[Auth Route /delete-avatar] Deleted avatar: ${publicId}`);
        } catch (deleteError) {
            console.error('[Auth Route /delete-avatar] Error deleting from Cloudinary:', deleteError);
        }

        // Remove avatar URL from user
        user.profile.avatar = '';
        await user.save();

        res.json({
            success: true,
            msg: 'Avatar deleted successfully'
        });
    } catch (error) {
        console.error('[Auth Route /delete-avatar] Error deleting avatar:', error);
        res.status(500).json({ msg: 'Server error deleting avatar' });
    }
});

// @route   PUT api/auth/update-profile
router.put('/update-profile', auth, async (req, res) => {
    console.log(`[Auth Route /update-profile] Request received for user ID: ${req.user.id}`);
    const { username, email, currentPassword, newPassword, notifications, appPreferences } = req.body;

    try {
        let user = await User.findById(req.user.id);

        if (!user) {
            console.log(`[Auth Route /update-profile] User not found for ID: ${req.user.id}`);
            return res.status(404).json({ msg: 'User not found' });
        }

        // Update basic profile fields if provided
        if (username !== undefined) user.username = username;
        if (email !== undefined) {
            // Sanitize email for MongoDB query (NoSQL injection prevention)
            const sanitizedEmail = sanitizeQueryString(email);
            if (sanitizedEmail && sanitizedEmail !== user.email && await User.findOne({ email: sanitizedEmail })) {
                return res.status(400).json({ msg: 'Email already in use' });
            }
            user.email = sanitizedEmail || email;
        }

        // Update nested settings fields
        if (notifications !== undefined) user.notifications = notifications;
        if (appPreferences !== undefined) user.appPreferences = appPreferences;

        // Handle password change if newPassword is provided
        if (newPassword) {
            if (!currentPassword) {
                return res.status(400).json({ msg: 'Current password is required to change password.' });
            }

            const isMatch = await bcrypt.compare(currentPassword, user.password);
            if (!isMatch) {
                return res.status(400).json({ msg: 'Current password is incorrect.' });
            }

            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(newPassword, salt);
            console.log(`[Auth Route /update-profile] Password updated for user: ${user.email}`);
        }

        await user.save();

        const updatedUser = await User.findById(req.user.id).select('-password');
        console.log(`[Auth Route /update-profile] Successfully updated user: ${updatedUser.email}`);
        res.json({ msg: 'Settings updated successfully', user: updatedUser });

    } catch (err) {
        console.error('[Auth Route /update-profile] Server error:', err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;