const requireAdmin = require('../middleware/adminMiddleware');
// Discord Integration Routes
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const auth = require('../middleware/authMiddleware');
const User = require('../models/User');
const discordService = require('../services/discordService');
const { EmbedBuilder } = require('discord.js');

// Generate link token for connecting Discord
router.post('/generate-link', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Generate a unique link token
        const linkToken = crypto.randomBytes(32).toString('hex');

        // Store token with expiration (24 hours)
        user.discordLinkToken = linkToken;
        user.discordLinkTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await user.save();

        res.json({
            success: true,
            linkToken,
            instructions: 'Use /link <token> command in a DM with the Nexus Signal bot on Discord',
            expiresIn: '24 hours'
        });
    } catch (error) {
        console.error('Error generating Discord link:', error);
        res.status(500).json({ error: 'Failed to generate link' });
    }
});

// Get Discord connection status
router.get('/status', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select(
            'discordUserId discordUsername discordLinkedAt discordNotifications'
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            connected: !!user.discordUserId,
            username: user.discordUsername,
            linkedAt: user.discordLinkedAt,
            notifications: user.discordNotifications || {
                economicEvents: true,
                whaleAlerts: true,
                dailySummary: true,
                mlPredictions: true,
                priceAlerts: true
            }
        });
    } catch (error) {
        console.error('Error getting Discord status:', error);
        res.status(500).json({ error: 'Failed to get status' });
    }
});

// Unlink Discord account
router.post('/unlink', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!user.discordUserId) {
            return res.status(400).json({ error: 'No Discord account linked' });
        }

        // Send goodbye message before unlinking
        if (discordService.isBotActive()) {
            try {
                const client = discordService.getBot();
                const discordUser = await client.users.fetch(user.discordUserId);

                const embed = new EmbedBuilder()
                    .setTitle('👋 Account Unlinked')
                    .setColor(0xffa500)
                    .setDescription('Your Nexus Signal account has been disconnected. You will no longer receive notifications.')
                    .setFooter({ text: 'You can link again anytime from the app settings' });

                await discordUser.send({ embeds: [embed] });
            } catch (dmError) {
                console.log('[Discord] Could not send unlink DM:', dmError.message);
            }
        }

        // Clear Discord data
        user.discordUserId = null;
        user.discordUsername = null;
        user.discordLinkedAt = null;
        await user.save();

        res.json({
            success: true,
            message: 'Discord account unlinked successfully'
        });
    } catch (error) {
        console.error('Error unlinking Discord:', error);
        res.status(500).json({ error: 'Failed to unlink account' });
    }
});

// Update notification preferences
router.put('/notifications', auth, async (req, res) => {
    try {
        const { economicEvents, whaleAlerts, dailySummary, mlPredictions, priceAlerts } = req.body;

        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update preferences
        user.discordNotifications = {
            economicEvents: economicEvents !== undefined ? economicEvents : true,
            whaleAlerts: whaleAlerts !== undefined ? whaleAlerts : true,
            dailySummary: dailySummary !== undefined ? dailySummary : true,
            mlPredictions: mlPredictions !== undefined ? mlPredictions : true,
            priceAlerts: priceAlerts !== undefined ? priceAlerts : true
        };

        await user.save();

        res.json({
            success: true,
            notifications: user.discordNotifications
        });
    } catch (error) {
        console.error('Error updating Discord notification preferences:', error);
        res.status(500).json({ error: 'Failed to update preferences' });
    }
});

// Send test notification
router.post('/test', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!user.discordUserId) {
            return res.status(400).json({ error: 'No Discord account linked' });
        }

        if (!discordService.isBotActive()) {
            return res.status(503).json({ error: 'Discord bot is not available' });
        }

        try {
            const client = discordService.getBot();
            const discordUser = await client.users.fetch(user.discordUserId);

            const embed = new EmbedBuilder()
                .setTitle('🎉 Test Notification')
                .setColor(0x00ff00)
                .setDescription('Congratulations! Your Nexus Signal Discord notifications are working perfectly!')
                .setFooter({ text: 'This is a test message sent from your account settings' })
                .setTimestamp();

            await discordUser.send({ embeds: [embed] });

            res.json({ success: true, message: 'Test notification sent!' });
        } catch (dmError) {
            console.error('[Discord] Error sending test DM:', dmError.message);
            res.status(500).json({ error: 'Failed to send test notification. Make sure your DMs are open.' });
        }
    } catch (error) {
        console.error('Error sending Discord test notification:', error);
        res.status(500).json({ error: 'Failed to send test notification' });
    }
});

// Get bot info and invite link (public)
router.get('/bot-info', (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const isActive = discordService.isBotActive();

    // Discord bot invite link with required permissions
    // Permissions: Send Messages, Embed Links, Read Message History
    const permissions = '2147485696'; // Decimal for required permissions
    const inviteLink = clientId
        ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`
        : null;

    res.json({
        clientId: clientId || null,
        inviteLink,
        isActive,
        features: [
            'Slash commands (/predict, /price, /link)',
            'ML Prediction alerts',
            'Whale alerts',
            'Daily market summaries',
            'Economic event reminders',
            'Price alerts'
        ]
    });
});

// Get linked servers (admin endpoint for debugging)
router.get('/servers', auth, async (req, res) => {
    try {
        // Only return server count, not full list for privacy
        const servers = discordService.getLinkedServers();

        res.json({
            success: true,
            count: servers.length,
            isActive: discordService.isBotActive()
        });
    } catch (error) {
        console.error('Error getting Discord servers:', error);
        res.status(500).json({ error: 'Failed to get servers' });
    }
});

// Test signal post to Discord (admin/dev only)
router.post('/test-signal', auth, requireAdmin, async (req, res) => {
    try {
        const { postNewSignalToDiscord, isBotActive } = discordService;

        if (!isBotActive()) {
            return res.status(503).json({ success: false, error: 'Discord bot is not connected' });
        }

        // Post a test signal
        await postNewSignalToDiscord({
            symbol: 'TEST',
            direction: 'UP',
            confidence: 82,
            entryPrice: 100,
            stopLoss: 95,
            takeProfit1: 103,
            takeProfit2: 108,
            takeProfit3: 112,
            targetPrice: 112,
            currentPrice: 100
        });

        res.json({ success: true, message: 'Test signal posted to Discord' });
    } catch (error) {
        console.error('Discord test error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test result post to Discord
router.post('/test-result', auth, requireAdmin, async (req, res) => {
    try {
        const { postSignalResultToDiscord, isBotActive } = discordService;

        if (!isBotActive()) {
            return res.status(503).json({ success: false, error: 'Discord bot is not connected' });
        }

        await postSignalResultToDiscord({
            symbol: 'TEST',
            direction: 'UP',
            entryPrice: 100,
            resultPrice: 108,
            currentPrice: 108,
            resultText: 'TP2 Hit',
            livePrice: 108
        }, 'win');

        res.json({ success: true, message: 'Test result posted to Discord' });
    } catch (error) {
        console.error('Discord test error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check bot status
router.get('/bot-status', auth, async (req, res) => {
    const { isBotActive, getBot } = discordService;
    const bot = getBot();
    res.json({
        active: isBotActive(),
        username: bot?.user?.tag || null,
        guilds: bot?.guilds?.cache?.size || 0,
        signalChannelId: process.env.DISCORD_SIGNAL_CHANNEL_ID || 'NOT SET',
        resultsChannelId: process.env.DISCORD_RESULTS_CHANNEL_ID || 'NOT SET',
        guildId: process.env.DISCORD_GUILD_ID || 'NOT SET',
        premiumRoleId: process.env.DISCORD_PREMIUM_ROLE_ID || 'NOT SET'
    });
});

module.exports = router;
