const express = require('express');
const router = express.Router();

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { check, validationResult } = require('express-validator');
const User = require('../models/User');
const auth = require('../middleware/authMiddleware'); // Ensure this path is correct

// Sanitize string values for MongoDB queries (NoSQL injection prevention)
const sanitizeQueryString = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    return value;
};

// Keep legacy URLs on the same login/2FA implementation.
const authRoutes = require('./authRoutes');
router.post('/login', (req, res, next) => authRoutes(req, res, next));
router.post('/register', (req, res, next) => authRoutes(req, res, next));

// @route   GET api/users/me
// @desc    Get authenticated user (for token validation)
// @access  Private
// This route now uses '/me' path to match common frontend convention
router.get('/me', auth, async (req, res) => {
    try {
        console.log(`[DEBUG AUTH] Fetching user profile for ID: ${req.user.id}`);
        const user = await User.findById(req.user.id).select('-password'); // -password means don't return the password hash
        if (!user) {
            console.warn(`[DEBUG AUTH] User ID ${req.user.id} not found during '/me' request.`);
            return res.status(404).json({ msg: 'User not found' });
        }
        res.json(user);
    } catch (err) {
        console.error('Server Error in /api/users/me:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/users/me/full
// @desc    Get authenticated user's full profile data
// @access  Private
router.get('/me/full', auth, async (req, res) => {
    try {
        console.log(`[User Routes /me/full] Fetching full profile for user ID: ${req.user.id}`);
        const user = await User.findById(req.user.id)
            .select('-password')
            .populate('social.followers', 'username profile.avatar profile.displayName')
            .populate('social.following', 'username profile.avatar profile.displayName');

        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        res.json(user);
    } catch (err) {
        console.error('[User Routes /me/full] Server error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/users/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, async (req, res) => {
    try {
        const { displayName, bio, isPublic, showPortfolio } = req.body;
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (displayName !== undefined) user.profile.displayName = displayName;
        if (bio !== undefined) user.profile.bio = bio;
        if (isPublic !== undefined) user.profile.isPublic = isPublic;
        if (showPortfolio !== undefined) user.profile.showPortfolio = showPortfolio;

        await user.save();
        console.log(`[User Routes /profile] Profile updated for user: ${user.username}`);

        res.json({ success: true, profile: user.profile });
    } catch (error) {
        console.error('[User Routes /profile] Error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});


// @route   GET /api/auth/settings
// @desc    Get all user profile and settings data
// @access  Private (requires authentication token)
router.get('/settings', auth, async (req, res) => {
    try {
        console.log(`[DEBUG Settings] Fetching settings for user ID: ${req.user.id}`);
        const user = await User.findById(req.user.id).select('-password'); // Exclude password
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        // Return all relevant user data, including new settings fields
        const settingsData = {
            id: user.id,
            username: user.username,
            email: user.email,
            registrationDate: user.date, // Assuming 'date' field for registration
            notifications: user.notifications || { email: true, push: false, dailySummary: true },
            appPreferences: user.appPreferences || { theme: 'dark', defaultView: 'dashboard', refreshInterval: 5 },
            subscriptionStatus: user.subscriptionStatus || 'Free'
        };

        res.json(settingsData);
    } catch (err) {
        console.error('[SERVER ERROR] GET /api/auth/settings:', err.message);
        res.status(500).send('Server Error fetching settings');
    }
});

// @route   PUT /api/auth/settings
// @desc    Update user profile and settings data
// @access  Private (requires authentication token)
router.put('/settings', auth, [
    // Optional: Add validation for incoming fields
    check('username', 'Username is required').optional().not().isEmpty(),
    check('email', 'Please include a valid email').optional().isEmail(),
    check('newPassword', 'Please enter a password with 6 or more characters').optional().isLength({ min: 6 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[DEBUG Settings] Validation errors for settings update:', errors.array());
        return res.status(400).json({ errors: errors.array() });
    }

    // currentPassword is needed to verify before changing password
    const { username, email, currentPassword, newPassword, notifications, appPreferences } = req.body;
    console.log(`[DEBUG Settings] Update request for user ID: ${req.user.id}, body:`, req.body);

    try {
        let user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        // Update Username
        if (username && user.username !== username) {
            // Sanitize username for MongoDB query (NoSQL injection prevention)
            const sanitizedUsername = sanitizeQueryString(username);
            if (!sanitizedUsername) {
                return res.status(400).json({ msg: 'Invalid username format' });
            }
            const existingUserWithUsername = await User.findOne({ username: sanitizedUsername });
            if (existingUserWithUsername && existingUserWithUsername.id.toString() !== user.id.toString()) {
                return res.status(400).json({ msg: 'Username already taken' });
            }
            user.username = sanitizedUsername;
            console.log(`[DEBUG Settings] Username updated for ${user.email}`);
        }

        // Update Email
        if (email && user.email !== email) {
            // Sanitize email for MongoDB query (NoSQL injection prevention)
            const sanitizedEmail = sanitizeQueryString(email);
            if (!sanitizedEmail) {
                return res.status(400).json({ msg: 'Invalid email format' });
            }
            const existingUserWithEmail = await User.findOne({ email: sanitizedEmail });
            if (existingUserWithEmail && existingUserWithEmail.id.toString() !== user.id.toString()) {
                return res.status(400).json({ msg: 'Email already in use' });
            }
            user.email = sanitizedEmail;
            console.log(`[DEBUG Settings] Email updated for ${user.username}`);
        }

        // Update Password
        if (currentPassword && newPassword) {
            const isMatch = await bcrypt.compare(currentPassword, user.password);
            if (!isMatch) {
                return res.status(401).json({ msg: 'Current password incorrect' });
            }
            if (newPassword.length < 6) { // Re-check length just in case
                return res.status(400).json({ msg: 'New password must be 6 or more characters' });
            }
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(newPassword, salt);
            console.log(`[DEBUG Settings] Password updated for ${user.username}`);
        } else if (newPassword && !currentPassword) {
            return res.status(400).json({ msg: 'Current password is required to change password' });
        }

        // Update Notification Preferences (merge incoming with existing)
        if (notifications && typeof notifications === 'object') {
            user.notifications = { ...(user.notifications || {}), ...notifications };
            console.log(`[DEBUG Settings] Notifications updated for ${user.username}:`, user.notifications);
        }

        // Update Application Preferences (merge incoming with existing)
        if (appPreferences && typeof appPreferences === 'object') {
            user.appPreferences = { ...(user.appPreferences || {}), ...appPreferences };
            console.log(`[DEBUG Settings] App preferences updated for ${user.username}:`, user.appPreferences);
        }

        await user.save();
        console.log(`[DEBUG Settings] User settings saved for user ID: ${req.user.id}`);
        // Return updated user data (excluding password)
        res.json({ msg: 'Settings updated successfully', user: {
            id: user.id,
            username: user.username,
            email: user.email,
            date: user.date,
            notifications: user.notifications,
            appPreferences: user.appPreferences,
            subscriptionStatus: user.subscriptionStatus
        }});
    } catch (err) {
        console.error('[SERVER ERROR] PUT /api/auth/settings:', err.message);
        res.status(500).send('Server Error updating settings');
    }
});


module.exports = router;