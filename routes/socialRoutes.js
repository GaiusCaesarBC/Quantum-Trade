const requireAdmin = require('../middleware/adminMiddleware');
const { verifyAccessToken } = require('../utils/authTokens');
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const auth = require('../middleware/authMiddleware');
const User = require('../models/User');
const Gamification = require('../models/Gamification');
const PaperTradingAccount = require('../models/PaperTradingAccount');
const BrokerageConnection = require('../models/BrokerageConnection');
const CopyTrade = require('../models/CopyTrade');
const CopiedPrediction = require('../models/CopiedPrediction');
const { updateUserStats, updateAllUserStats } = require('../services/statsService');
const NotificationService = require('../services/notificationService');

// Sanitize string values for MongoDB queries (NoSQL injection prevention)
const sanitizeQueryString = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    return value;
};

// ============ OPTIONAL AUTH MIDDLEWARE ============
const optionalAuth = (req, res, next) => {
    const token = req.cookies?.token || req.header('x-auth-token');
    
    if (!token) {
        return next();
    }

    try {
        const decoded = verifyAccessToken(token);
        req.user = decoded.user;
        next();
    } catch (err) {
        next();
    }
};

// ============ HELPER: Get date range for time period ============
const getDateRangeForPeriod = (period) => {
    const now = new Date();
    let startDate;

    switch (period) {
        case 'today':
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            break;
        case 'week':
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 7);
            break;
        case 'month':
            startDate = new Date(now);
            startDate.setMonth(now.getMonth() - 1);
            break;
        case 'all':
        default:
            startDate = null;
            break;
    }

    return startDate;
};

// ============ CURRENT USER STATS ============
// @route   GET /api/social/me/stats
// @desc    Get current user's stats
// @access  Private
router.get('/me/stats', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id)
            .select('username profile stats gamification social vault');

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            username: user.username,
            displayName: user.profile?.displayName || user.username,
            avatar: user.profile?.avatar || '',
            stats: {
                totalReturnPercent: user.stats?.totalReturnPercent || 0,
                winRate: user.stats?.winRate || 0,
                totalTrades: user.stats?.totalTrades || 0,
                currentStreak: user.stats?.currentStreak || 0,
                longestStreak: user.stats?.longestStreak || 0,
                avgTradeReturn: user.stats?.avgTradeReturn || 0,
                bestTrade: user.stats?.bestTrade || 0,
                worstTrade: user.stats?.worstTrade || 0
            },
            gamification: {
                level: user.gamification?.level || 1,
                xp: user.gamification?.xp || 0,
                title: user.gamification?.title || 'Rookie Trader',
                nexusCoins: user.gamification?.nexusCoins || 0
            },
            social: {
                followersCount: user.social?.followersCount || 0,
                followingCount: user.social?.followingCount || 0
            },
            vault: {
               // 🔥 NEW: Vault equipped items
equippedBadges: user.vault?.equippedBadges || [],
equippedBorder: user.vault?.equippedBorder || 'border-bronze',
equippedTheme: user.vault?.equippedTheme || 'default',
            }
        });
    } catch (error) {
        console.error('[Social] Error fetching user stats:', error);
        res.status(500).json({ error: 'Failed to fetch user stats' });
    }
});

// ============ ENHANCED LEADERBOARD ============
// @route   GET /api/social/leaderboard
// @desc    Get top traders with filtering and sorting options
// @access  Public
router.get('/leaderboard', async (req, res) => {
    try {
        const {
            period = 'all',      // today, week, month, all
            limit = 100,
            sortBy = 'totalReturnPercent'  // totalReturnPercent, winRate, currentStreak, xp, totalTrades
        } = req.query;

        // Get start date for time period filtering
        const startDate = getDateRangeForPeriod(period);
        const isTimePeriod = period !== 'all' && startDate;

        // Build query - show public profiles OR profiles with no isPublic field
        let query = {
            $or: [
                { 'profile.isPublic': true },
                { 'profile.isPublic': { $exists: false } }
            ]
        };

        // Fetch all users with relevant fields
        const users = await User.find(query)
            .select('username profile stats gamification social vault createdAt')
            .limit(500); // Get more users initially, we'll filter and sort after calculating period stats

        // Fetch paper trading accounts with orders and positions for live calculations
        const userIds = users.map(u => u._id);
        const paperAccounts = await PaperTradingAccount.find({ user: { $in: userIds } })
            .select('user totalTrades winningTrades losingTrades winRate totalProfitLossPercent orders currentStreak portfolioValue initialBalance cashBalance positions totalRefillAmount');

        // Create a map of userId -> paper trading stats (calculated based on time period)
        const paperStatsMap = {};

        paperAccounts.forEach(account => {
            const userId = account.user.toString();

            if (isTimePeriod) {
                // Calculate stats for the specific time period from orders
                const ordersInPeriod = (account.orders || []).filter(order => {
                    // Only count sell orders (completed trades with P/L)
                    if (order.side !== 'sell' && order.side !== 'cover') return false;
                    const orderDate = new Date(order.createdAt);
                    return orderDate >= startDate;
                });

                const totalTrades = ordersInPeriod.length;
                const winningTrades = ordersInPeriod.filter(o => (o.profitLoss || 0) > 0).length;
                const losingTrades = ordersInPeriod.filter(o => (o.profitLoss || 0) < 0).length;
                const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

                // Calculate total P/L for the period
                const totalProfitLoss = ordersInPeriod.reduce((sum, o) => sum + (o.profitLoss || 0), 0);
                // Calculate return % based on initial balance
                const initialBalance = account.initialBalance || 100000;
                const totalReturnPercent = (totalProfitLoss / initialBalance) * 100;

                // Calculate current streak within period
                let currentStreak = 0;
                const sortedOrders = ordersInPeriod.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                for (const order of sortedOrders) {
                    if ((order.profitLoss || 0) > 0) {
                        currentStreak++;
                    } else {
                        break;
                    }
                }

                paperStatsMap[userId] = {
                    totalTrades,
                    winRate,
                    winningTrades,
                    losingTrades,
                    totalReturnPercent,
                    currentStreak,
                    hasActivity: totalTrades > 0
                };
            } else {
                // Recalculate all-time return live from positions + cash
                // instead of relying on stale stored totalProfitLossPercent
                const initialBalance = account.initialBalance || 100000;
                const cashBalance = account.cashBalance ?? initialBalance;
                const totalRefillAmount = account.totalRefillAmount || 0;

                // Sum up current value of all open positions
                let positionsValue = 0;
                if (account.positions && account.positions.length > 0) {
                    for (const pos of account.positions) {
                        if (pos.isLiquidated) continue;
                        const quantity = pos.quantity || 0;
                        const avgPrice = pos.averagePrice || 0;
                        const curPrice = pos.currentPrice || avgPrice;
                        const leverage = pos.leverage || 1;
                        const margin = quantity * avgPrice / leverage;

                        let pnl;
                        if (pos.positionType === 'short') {
                            pnl = (avgPrice - curPrice) * quantity;
                        } else {
                            pnl = (curPrice - avgPrice) * quantity;
                        }
                        if (leverage > 1) pnl = pnl * leverage;

                        const currentValue = Math.max(0, margin + pnl);
                        positionsValue += currentValue;
                    }
                }

                const portfolioValue = cashBalance + positionsValue;
                const totalPL = portfolioValue - initialBalance - totalRefillAmount;
                const totalReturnPercent = initialBalance > 0 ? (totalPL / initialBalance) * 100 : 0;

                paperStatsMap[userId] = {
                    totalTrades: account.totalTrades || 0,
                    winRate: account.winRate || 0,
                    winningTrades: account.winningTrades || 0,
                    losingTrades: account.losingTrades || 0,
                    totalReturnPercent,
                    currentStreak: account.currentStreak || 0,
                    hasActivity: (account.totalTrades || 0) > 0
                };
            }
        });

        // Map to leaderboard format with calculated stats
        let leaderboard = users.map(user => {
            const paperStats = paperStatsMap[user._id.toString()] || {
                totalTrades: 0,
                winRate: 0,
                totalReturnPercent: 0,
                currentStreak: 0,
                hasActivity: false
            };

            return {
                // Identity
                userId: user._id,
                username: user.username,
                displayName: user.profile?.displayName || user.username || 'Anonymous Trader',
                avatar: user.profile?.avatar || '',
                badges: user.profile?.badges || [],

                // Stats from paper trading (period-specific or all-time)
                totalReturn: paperStats.totalReturnPercent,
                winRate: paperStats.winRate,
                totalTrades: paperStats.totalTrades,
                currentStreak: paperStats.currentStreak,
                longestStreak: user.stats?.longestStreak || 0,
                avgTradeReturn: user.stats?.avgTradeReturn || 0,
                hasActivity: paperStats.hasActivity,

                // Gamification (always all-time)
                level: user.gamification?.level || 1,
                xp: user.gamification?.xp || 0,
                title: user.gamification?.title || 'Rookie Trader',

                // Social
                followersCount: user.social?.followersCount || 0,
                followingCount: user.social?.followingCount || 0,

                // Vault equipped items
                equippedBadges: user.vault?.equippedBadges || [],
                equippedBorder: user.vault?.equippedBorder || 'border-bronze',
                equippedTheme: user.vault?.equippedTheme || 'default',

                // Meta
                memberSince: user.createdAt
            };
        });

        // For time periods, only show users who had activity in that period
        if (isTimePeriod) {
            leaderboard = leaderboard.filter(entry => entry.hasActivity);
        }

        // Sort based on the requested field
        const sortFieldMap = {
            'totalReturnPercent': 'totalReturn',
            'returns': 'totalReturn',
            'winRate': 'winRate',
            'accuracy': 'winRate',
            'currentStreak': 'currentStreak',
            'streak': 'currentStreak',
            'xp': 'xp',
            'totalTrades': 'totalTrades',
            'trades': 'totalTrades'
        };
        const sortField = sortFieldMap[sortBy] || 'totalReturn';

        leaderboard.sort((a, b) => (b[sortField] || 0) - (a[sortField] || 0));

        // Apply limit and add ranks
        leaderboard = leaderboard.slice(0, parseInt(limit)).map((entry, index) => ({
            ...entry,
            rank: index + 1
        }));

        // Return with metadata
        res.json(leaderboard);

    } catch (error) {
        console.error('[Social] Error fetching leaderboard:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

// ============ LEADERBOARD STATS (for header display) ============
// @route   GET /api/social/leaderboard/stats
// @desc    Get leaderboard statistics
// @access  Public
router.get('/leaderboard/stats', async (req, res) => {
    try {
        const totalTraders = await User.countDocuments({
            $or: [
                { 'profile.isPublic': true },
                { 'profile.isPublic': { $exists: false } }
            ]
        });

        const activeToday = await User.countDocuments({
            'stats.lastTradeDate': { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
        });

        const topPerformer = await User.findOne({
            $or: [
                { 'profile.isPublic': true },
                { 'profile.isPublic': { $exists: false } }
            ]
        })
        .sort({ 'stats.totalReturnPercent': -1 })
        .select('username profile.displayName stats.totalReturnPercent');

        res.json({
            totalTraders,
            activeToday,
            topPerformer: topPerformer ? {
                username: topPerformer.username,
                displayName: topPerformer.profile?.displayName || topPerformer.username,
                totalReturn: topPerformer.stats?.totalReturnPercent || 0
            } : null
        });

    } catch (error) {
        console.error('[Social] Error fetching leaderboard stats:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard stats' });
    }
});

// ============ PROFILE ============
// @route   GET /api/social/profile/:userId
// @desc    Get user profile
// @access  Public (but respects privacy settings)
router.get('/profile/:userId', optionalAuth, async (req, res) => {
    try {
        const user = await User.findById(req.params.userId)
            .select('username profile stats achievements gamification social vault createdAt isFounder')
            .populate('social.followers', 'username profile.displayName profile.avatar')
            .populate('social.following', 'username profile.displayName profile.avatar');

        if (!user) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const isOwnProfile = req.user && req.user.id === req.params.userId;
        const isPublic = user.profile?.isPublic ?? true;

        if (!isPublic && !isOwnProfile) {
            return res.status(403).json({ 
                error: 'This profile is private',
                isPrivate: true 
            });
        }

        // 🔥 FIXED: Get achievements from all possible sources
        let achievements = [];
        
        // Source 1: Check User.achievements array (direct on user model)
        if (user.achievements && user.achievements.length > 0) {
            achievements = user.achievements;
            console.log(`[Profile] Found ${achievements.length} achievements in User.achievements`);
        }
        
        // Source 2: Check User.gamification.achievements (embedded in user)
        if (achievements.length === 0 && user.gamification?.achievements?.length > 0) {
            achievements = user.gamification.achievements.map(ach => ({
                achievementId: ach.id || ach.achievementId,
                id: ach.id || ach.achievementId,
                name: ach.name,
                description: ach.description,
                icon: ach.icon,
                xpReward: ach.points || ach.xpReward || 0,
                points: ach.points || ach.xpReward || 0,
                rarity: ach.rarity || 'common',
                earnedAt: ach.unlockedAt || ach.earnedAt
            }));
            console.log(`[Profile] Found ${achievements.length} achievements in User.gamification.achievements`);
        }
        
        // Source 3: Check separate Gamification document
        let gamificationData = null;
        try {
            const gamificationDoc = await Gamification.findOne({ user: user._id });
            if (gamificationDoc) {
                gamificationData = gamificationDoc;
                
                if (achievements.length === 0 && gamificationDoc.achievements && gamificationDoc.achievements.length > 0) {
                    achievements = gamificationDoc.achievements.map(ach => ({
                        achievementId: ach.id || ach.achievementId,
                        id: ach.id || ach.achievementId,
                        name: ach.name,
                        description: ach.description,
                        icon: ach.icon,
                        xpReward: ach.points || ach.xpReward || 0,
                        points: ach.points || ach.xpReward || 0,
                        rarity: ach.rarity || 'common',
                        earnedAt: ach.unlockedAt || ach.earnedAt
                    }));
                    console.log(`[Profile] Found ${achievements.length} achievements in Gamification document`);
                }
            }
        } catch (gamErr) {
            console.error('[Profile] Could not fetch Gamification document:', gamErr.message);
        }

        // 🔥 GET REAL PREDICTION STATS FROM PREDICTION MODEL
        let predictionStats = {
            predictionsCreated: 0,
            correctPredictions: 0,
            predictionAccuracy: 0
        };
        
        try {
            const Prediction = require('../models/Prediction');
            
            // 🔥 Check for prediction reset date (only count predictions after this date)
            const predictionResetDate = gamificationData?.predictionResetDate || null;
            const dateFilter = predictionResetDate ? { createdAt: { $gte: predictionResetDate } } : {};
            
            const totalPredictions = await Prediction.countDocuments({ 
                user: user._id,
                ...dateFilter
            });
            const correctPredictions = await Prediction.countDocuments({ 
                user: user._id, 
                status: 'correct',
                ...dateFilter
            });
            const resolvedPredictions = await Prediction.countDocuments({
                user: user._id,
                status: { $in: ['correct', 'incorrect'] },
                ...dateFilter
            });
            
            const accuracy = resolvedPredictions > 0 
                ? Math.round((correctPredictions / resolvedPredictions) * 100)
                : 0;
            
            predictionStats = {
                predictionsCreated: totalPredictions,
                correctPredictions: correctPredictions,
                predictionAccuracy: accuracy
            };
        } catch (predError) {
            console.warn('[Profile] Could not fetch prediction stats:', predError.message);
        }

        // 🔥 MERGE stats from User.stats AND Gamification.stats
        const mergedStats = {
            totalReturnPercent: user.stats?.totalReturnPercent || 0,
            winRate: user.stats?.winRate || gamificationData?.stats?.winRate || 0,
            totalTrades: user.stats?.totalTrades || gamificationData?.stats?.totalTrades || 0,
            currentStreak: gamificationData?.loginStreak || user.stats?.currentStreak || gamificationData?.profitStreak || 0,
            longestStreak: gamificationData?.maxLoginStreak || user.stats?.longestStreak || gamificationData?.maxProfitStreak || 0,
            bestTrade: user.stats?.bestTrade || gamificationData?.stats?.biggestWinPercent || 0,
            rank: user.stats?.rank || 0,
            // 🔥 USE REAL PREDICTION STATS
            totalPredictions: predictionStats.predictionsCreated,
            correctPredictions: predictionStats.correctPredictions,
            predictionAccuracy: predictionStats.predictionAccuracy,
            profitStreak: gamificationData?.profitStreak || 0,
            lossStreak: gamificationData?.lossStreak || 0,
            loginStreak: gamificationData?.loginStreak || 0
        };

        // 🔥 AUTO-FIX: Recalculate level from XP if out of sync
        let finalLevel = gamificationData?.level || user.gamification?.level || 1;
        let finalXp = gamificationData?.xp || user.gamification?.xp || 0;
        let finalRank = gamificationData?.rank || user.gamification?.rank || 'Rookie Trader';
        
        const correctLevel = Math.floor(finalXp / 1000) + 1;
        
        if (correctLevel !== finalLevel && gamificationData) {
            console.log(`[Profile] Auto-fixing level: ${finalLevel} → ${correctLevel} (XP: ${finalXp})`);
            finalLevel = correctLevel;
            
            // Update rank based on level
            const getRankForLevel = (level) => {
                if (level >= 100) return 'Wall Street Titan';
                if (level >= 75) return 'Market Mogul';
                if (level >= 50) return 'Trading Legend';
                if (level >= 40) return 'Master Trader';
                if (level >= 30) return 'Expert Trader';
                if (level >= 20) return 'Veteran Trader';
                if (level >= 15) return 'Advanced Trader';
                if (level >= 10) return 'Skilled Trader';
                if (level >= 5) return 'Apprentice Trader';
                if (level >= 2) return 'Novice Trader';
                return 'Rookie Trader';
            };
            finalRank = getRankForLevel(correctLevel);
            
            // Save the fix to database
            gamificationData.level = correctLevel;
            gamificationData.rank = finalRank;
            await gamificationData.save();
        }
        
        // 🔥 PRIORITIZE Gamification document over User.gamification (which is often stale)
        const mergedGamification = {
            level: finalLevel,
            xp: finalXp,
            totalXpEarned: finalXp,  // Add this for profile page
            title: finalRank,
            rank: finalRank,
            nexusCoins: gamificationData?.nexusCoins || user.gamification?.nexusCoins || 0,
            totalEarned: gamificationData?.totalEarned || 0,
            loginStreak: gamificationData?.loginStreak || 0,
            profitStreak: gamificationData?.profitStreak || 0,
            stats: gamificationData?.stats || user.gamification?.stats || {},
            achievementsCount: achievements.length,
            // Add XP bounds for progress bar
            xpForCurrentLevel: (finalLevel - 1) * 1000,
            xpForNextLevel: finalLevel * 1000
        };

        console.log(`[Profile] Gamification for ${user.username}: Level ${mergedGamification.level}, Title: ${mergedGamification.title}`);

        res.json({
            userId: user._id,
            _id: user._id,
            username: user.username,
            profile: user.profile,
            stats: mergedStats,
            achievements: achievements,
            gamification: mergedGamification,
            social: {
                followersCount: user.social?.followersCount || 0,
                followingCount: user.social?.followingCount || 0,
                followers: user.social?.followers || [],
                following: user.social?.following || []
            },
            vault: {
                equippedBadges: user.vault?.equippedBadges || [],
                equippedBorder: user.vault?.equippedBorder || 'border-bronze',
                equippedTheme: user.vault?.equippedTheme || 'default'
            },
            isFounder: user.isFounder || false,
            date: user.createdAt,
            isOwnProfile: isOwnProfile
        });
    } catch (error) {
        console.error('[Social] Error fetching profile:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});


// @route   GET /api/social/suggested
// @desc    Get suggested users to follow
// @access  Private
router.get('/suggested', auth, async (req, res) => {
    try {
        const { limit = 5 } = req.query;
        
        const currentUser = await User.findById(req.user.id).select('social.following');
        const followingIds = currentUser?.social?.following || [];
        
        // Find users the current user doesn't follow
        const suggestedUsers = await User.find({
            _id: { $ne: req.user.id, $nin: followingIds },
            'profile.isPublic': { $ne: false }
        })
        .select('username profile social.followersCount vault')
        .sort({ 'social.followersCount': -1 })
        .limit(parseInt(limit));

        const results = suggestedUsers.map(user => ({
            id: user._id,
            name: user.profile?.displayName || user.username,
            username: user.username,
            avatar: user.profile?.avatar || '',
            mutuals: 0,
            equippedBorder: user.vault?.equippedBorder || 'border-bronze',
            equippedTheme: user.vault?.equippedTheme || 'default'
        }));

        res.json(results);
    } catch (error) {
        console.error('[Social] Suggested users error:', error);
        res.status(500).json({ error: 'Failed to fetch suggestions' });
    }
});



// @route   GET /api/social/profile/username/:username
// @desc    Get user profile by username
// @access  Public (but respects privacy settings)
router.get('/profile/username/:username', optionalAuth, async (req, res) => {
    try {
        // Sanitize username for MongoDB query (NoSQL injection prevention)
        const sanitizedUsername = sanitizeQueryString(req.params.username);
        if (!sanitizedUsername) {
            return res.status(400).json({ error: 'Invalid username format' });
        }

        const user = await User.findOne({ username: sanitizedUsername })
            .select('username profile stats achievements gamification social vault createdAt isFounder')
            .populate('social.followers', 'username profile.displayName profile.avatar')
            .populate('social.following', 'username profile.displayName profile.avatar');

        if (!user) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const isOwnProfile = req.user && req.user.id === user._id.toString();
        const isPublic = user.profile?.isPublic ?? true;

        if (!isPublic && !isOwnProfile) {
            return res.status(403).json({ 
                error: 'This profile is private',
                isPrivate: true 
            });
        }

        // 🔥 FIXED: Get achievements from all possible sources
        let achievements = [];
        
        // Source 1: Check User.achievements array (direct on user model)
        if (user.achievements && user.achievements.length > 0) {
            achievements = user.achievements;
            console.log(`[Profile] Found ${achievements.length} achievements in User.achievements`);
        }
        
        // Source 2: Check User.gamification.achievements (embedded in user)
        if (achievements.length === 0 && user.gamification?.achievements?.length > 0) {
            achievements = user.gamification.achievements.map(ach => ({
                achievementId: ach.id || ach.achievementId,
                id: ach.id || ach.achievementId,
                name: ach.name,
                description: ach.description,
                icon: ach.icon,
                xpReward: ach.points || ach.xpReward || 0,
                points: ach.points || ach.xpReward || 0,
                rarity: ach.rarity || 'common',
                earnedAt: ach.unlockedAt || ach.earnedAt
            }));
            console.log(`[Profile] Found ${achievements.length} achievements in User.gamification.achievements`);
        }
        
        // Source 3: Check separate Gamification document
        let gamificationData = null;
        try {
            const gamificationDoc = await Gamification.findOne({ user: user._id });
            if (gamificationDoc) {
                gamificationData = gamificationDoc;
                
                // Get achievements from Gamification doc if we don't have them yet
                if (achievements.length === 0 && gamificationDoc.achievements && gamificationDoc.achievements.length > 0) {
                    achievements = gamificationDoc.achievements.map(ach => ({
                        achievementId: ach.id || ach.achievementId,
                        id: ach.id || ach.achievementId,
                        name: ach.name,
                        description: ach.description,
                        icon: ach.icon,
                        xpReward: ach.points || ach.xpReward || 0,
                        points: ach.points || ach.xpReward || 0,
                        rarity: ach.rarity || 'common',
                        earnedAt: ach.unlockedAt || ach.earnedAt
                    }));
                    console.log(`[Profile] Found ${achievements.length} achievements in Gamification document`);
                }
            }
        } catch (gamErr) {
            console.error('[Profile] Could not fetch Gamification document:', gamErr.message);
        }
        
        console.log(`[Profile] Total achievements for ${user.username}: ${achievements.length}`);

        // 🔥 GET REAL PREDICTION STATS FROM PREDICTION MODEL (like gamificationRoutes does)
        let predictionStats = {
            predictionsCreated: 0,
            correctPredictions: 0,
            predictionAccuracy: 0
        };
        
        try {
            const Prediction = require('../models/Prediction');
            
            // 🔥 Check for prediction reset date (only count predictions after this date)
            const predictionResetDate = gamificationData?.predictionResetDate || null;
            const dateFilter = predictionResetDate ? { createdAt: { $gte: predictionResetDate } } : {};
            
            console.log(`[Profile] Prediction reset date for ${user.username}:`, predictionResetDate || 'None (counting all)');
            
            const totalPredictions = await Prediction.countDocuments({ 
                user: user._id,
                ...dateFilter
            });
            const correctPredictions = await Prediction.countDocuments({ 
                user: user._id, 
                status: 'correct',
                ...dateFilter
            });
            const resolvedPredictions = await Prediction.countDocuments({
                user: user._id,
                status: { $in: ['correct', 'incorrect'] },
                ...dateFilter
            });
            
            const accuracy = resolvedPredictions > 0 
                ? Math.round((correctPredictions / resolvedPredictions) * 100)
                : 0;
            
            predictionStats = {
                predictionsCreated: totalPredictions,
                correctPredictions: correctPredictions,
                predictionAccuracy: accuracy
            };
            
            console.log(`[Profile] Real prediction stats for ${user.username}:`, predictionStats);
        } catch (predError) {
            console.warn('[Profile] Could not fetch prediction stats:', predError.message);
        }

        // 🔥 FETCH PAPER TRADING STATS
        let paperTradingStats = {
            portfolioValue: 100000,
            totalProfitLossPercent: 0,
            totalTrades: 0,
            winRate: 0
        };

        try {
            const paperAccount = await PaperTradingAccount.findOne({ user: user._id });
            if (paperAccount) {
                paperTradingStats = {
                    portfolioValue: paperAccount.portfolioValue || 100000,
                    totalProfitLossPercent: paperAccount.totalProfitLossPercent || 0,
                    totalTrades: paperAccount.totalTrades || 0,
                    winRate: paperAccount.winRate || 0,
                    winningTrades: paperAccount.winningTrades || 0,
                    losingTrades: paperAccount.losingTrades || 0
                };
                console.log(`[Profile] Paper trading stats for ${user.username}: ${paperTradingStats.totalProfitLossPercent.toFixed(2)}% return`);
            }
        } catch (ptError) {
            console.warn('[Profile] Could not fetch paper trading stats:', ptError.message);
        }

        // 🔥 FETCH BROKERAGE/REAL PORTFOLIO STATS
        let brokerageStats = {
            totalValue: 0,
            totalCostBasis: 0,
            returnPercent: 0,
            connectionCount: 0,
            hasConnections: false
        };

        try {
            const brokerageConnections = await BrokerageConnection.find({
                user: user._id,
                status: 'active'
            });

            if (brokerageConnections.length > 0) {
                let totalValue = 0;

                brokerageConnections.forEach(conn => {
                    totalValue += conn.cachedPortfolio?.totalValue || 0;
                });

                // Use BrokeragePortfolioHistory for accurate return calculation
                // (holdings don't carry costBasis, so value-vs-value always = 0%)
                let returnPercent = 0;
                try {
                    const BrokeragePortfolioHistory = require('../models/BrokeragePortfolioHistory');
                    const history = await BrokeragePortfolioHistory.findOne({ user: user._id });
                    if (history && history.initialValue > 0) {
                        history.currentValue = totalValue;
                        history.calculateGainLoss();
                        returnPercent = history.totalGainPercent || 0;
                    }
                } catch (e) {
                    console.warn('[Profile] Could not fetch portfolio history:', e.message);
                }

                brokerageStats = {
                    totalValue: totalValue,
                    returnPercent: returnPercent,
                    connectionCount: brokerageConnections.length,
                    hasConnections: true
                };
                console.log(`[Profile] Brokerage stats for ${user.username}: $${totalValue.toFixed(2)} (${returnPercent.toFixed(2)}% return) across ${brokerageConnections.length} connections`);
            }
        } catch (brokError) {
            console.warn('[Profile] Could not fetch brokerage stats:', brokError.message);
        }

        // 🔥 MERGE stats from User.stats AND Gamification.stats
        const mergedStats = {
            // From User.stats
            totalReturnPercent: user.stats?.totalReturnPercent || 0,
            winRate: user.stats?.winRate || gamificationData?.stats?.winRate || 0,
            totalTrades: user.stats?.totalTrades || gamificationData?.stats?.totalTrades || 0,
            currentStreak: gamificationData?.loginStreak || user.stats?.currentStreak || gamificationData?.profitStreak || 0,
            longestStreak: gamificationData?.maxLoginStreak || user.stats?.longestStreak || gamificationData?.maxProfitStreak || 0,
            bestTrade: user.stats?.bestTrade || gamificationData?.stats?.biggestWinPercent || 0,
            worstTrade: user.stats?.worstTrade || 0,
            avgTradeReturn: user.stats?.avgTradeReturn || 0,
            rank: user.stats?.rank || 0,
            
            // 🔥 USE REAL PREDICTION STATS FROM PREDICTION MODEL
            totalPredictions: predictionStats.predictionsCreated,
            correctPredictions: predictionStats.correctPredictions,
            predictionAccuracy: predictionStats.predictionAccuracy,
            
            // Profit/loss streaks
            profitStreak: gamificationData?.profitStreak || 0,
            lossStreak: gamificationData?.lossStreak || 0,
            loginStreak: gamificationData?.loginStreak || 0,
            maxProfitStreak: gamificationData?.maxProfitStreak || 0,
            maxLossStreak: gamificationData?.maxLossStreak || 0
        };

        // 🔥 MERGE gamification data - PRIORITIZE Gamification document over User.gamification
        const mergedGamification = {
            // Level & XP - prefer Gamification doc (where real data is)
            level: gamificationData?.level || user.gamification?.level || 1,
            xp: gamificationData?.xp || user.gamification?.xp || 0,
            
            // Title/Rank - prefer Gamification doc
            title: gamificationData?.rank || user.gamification?.title || 'Rookie Trader',
            rank: gamificationData?.rank || user.gamification?.rank || 'Rookie Trader',
            
            // Coins
            nexusCoins: gamificationData?.nexusCoins || user.gamification?.nexusCoins || 0,
            totalEarned: gamificationData?.totalEarned || 0,
            
            // Streaks — check both Gamification doc AND User.gamification (login streak lives on User)
            loginStreak: user.gamification?.loginStreak || gamificationData?.loginStreak || 0,
            profitStreak: gamificationData?.profitStreak || user.gamification?.profitStreak || 0,
            maxLoginStreak: user.gamification?.maxLoginStreak || gamificationData?.maxLoginStreak || 0,
            maxProfitStreak: gamificationData?.maxProfitStreak || user.gamification?.maxProfitStreak || 0,
            
            // Stats object
            stats: gamificationData?.stats || user.gamification?.stats || {},
            
            // Achievements count
            achievementsCount: achievements.length
        };

        console.log(`[Profile] Gamification data for ${user.username}: Level ${mergedGamification.level}, XP ${mergedGamification.xp}, Title: ${mergedGamification.title}`);

        res.json({
            userId: user._id,
            _id: user._id,
            username: user.username,
            profile: user.profile,
            stats: mergedStats, // 🔥 Use merged stats
            achievements: achievements,
            gamification: mergedGamification, // 🔥 Use merged gamification
            social: {
                followersCount: user.social?.followersCount || 0,
                followingCount: user.social?.followingCount || 0,
                followers: user.social?.followers || [],
                following: user.social?.following || []
            },
            // 🔥 Include vault data for badges and borders
            vault: {
                equippedBadges: user.vault?.equippedBadges || [],
                equippedBorder: user.vault?.equippedBorder || 'border-bronze',
                equippedTheme: user.vault?.equippedTheme || 'default'
            },
            // 🔥 Paper trading stats
            paperTrading: paperTradingStats,
            // 🔥 Brokerage/Real portfolio stats
            brokerage: brokerageStats,
            isFounder: user.isFounder || false,
            date: user.createdAt,
            isOwnProfile: isOwnProfile
        });
    } catch (error) {
        console.error('[Social] Error fetching profile by username:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});


// ============ FOLLOW/UNFOLLOW ============
// @route   POST /api/social/follow/:userId
// @desc    Follow a user
// @access  Private
router.post('/follow/:userId', auth, async (req, res) => {
    try {
        const targetUserId = req.params.userId;
        const currentUserId = req.user.id;

        if (targetUserId === currentUserId) {
            return res.status(400).json({ error: 'Cannot follow yourself' });
        }

        const [currentUser, targetUser] = await Promise.all([
            User.findById(currentUserId),
            User.findById(targetUserId)
        ]);

        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (currentUser.social.following.includes(targetUserId)) {
            return res.status(400).json({ error: 'Already following this user' });
        }

        currentUser.social.following.push(targetUserId);
        currentUser.social.followingCount++;
        targetUser.social.followers.push(currentUserId);
        targetUser.social.followersCount++;

        await Promise.all([currentUser.save(), targetUser.save()]);

        await NotificationService.createFollowNotification(
            targetUserId,
            currentUser
        );

        // Check achievements after following
        try {
            const GamificationService = require('../services/gamificationService');
            await GamificationService.awardXP(currentUserId, 10, `Followed ${targetUser.username}`);
            await GamificationService.checkAchievements(currentUserId);
        } catch (e) { console.error('[Social] Achievement check error:', e.message); }

        res.json({ success: true, message: 'Successfully followed user' });
    } catch (error) {
        console.error('[Social] Error following user:', error);
        res.status(500).json({ error: 'Failed to follow user' });
    }
});

// @route   POST /api/social/unfollow/:userId
// @desc    Unfollow a user
// @access  Private
router.post('/unfollow/:userId', auth, async (req, res) => {
    try {
        const targetUserId = req.params.userId;
        const currentUserId = req.user.id;

        const [currentUser, targetUser] = await Promise.all([
            User.findById(currentUserId),
            User.findById(targetUserId)
        ]);

        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        currentUser.social.following = currentUser.social.following.filter(
            id => id.toString() !== targetUserId
        );
        currentUser.social.followingCount = Math.max(0, currentUser.social.followingCount - 1);
        
        targetUser.social.followers = targetUser.social.followers.filter(
            id => id.toString() !== currentUserId
        );
        targetUser.social.followersCount = Math.max(0, targetUser.social.followersCount - 1);

        await Promise.all([currentUser.save(), targetUser.save()]);

        res.json({ success: true, message: 'Successfully unfollowed user' });
    } catch (error) {
        console.error('[Social] Error unfollowing user:', error);
        res.status(500).json({ error: 'Failed to unfollow user' });
    }
});

// ============ PROFILE SETTINGS ============
// @route   PUT /api/social/profile
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

        res.json({ success: true, profile: user.profile });
    } catch (error) {
        console.error('[Social] Error updating profile:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// ============ SEARCH ============
// @route   GET /api/social/search
// @desc    Search for users
// @access  Public
router.get('/search', async (req, res) => {
    try {
        let { q } = req.query;

        // Fix type confusion: q could be an array if multiple q params are passed
        if (Array.isArray(q)) {
            q = q[0];
        }

        if (!q || typeof q !== 'string' || q.length < 2) {
            return res.status(400).json({ error: 'Search query too short' });
        }

        const users = await User.find({
            $or: [
                { 'profile.displayName': { $regex: q, $options: 'i' } },
                { username: { $regex: q, $options: 'i' } }
            ]
        })
        .select('username profile stats gamification social vault')
        .limit(20);

        const results = users.map(user => ({
            userId: user._id,
            username: user.username,
            displayName: user.profile?.displayName || user.username,
            avatar: user.profile?.avatar || '',
            totalReturn: user.stats?.totalReturnPercent || 0,
            winRate: user.stats?.winRate || 0,
            totalTrades: user.stats?.totalTrades || 0,
            currentStreak: user.stats?.currentStreak || 0,
            level: user.gamification?.level || 1,
            xp: user.gamification?.xp || 0,
            followersCount: user.social?.followersCount || 0,
            badges: user.profile?.badges || [],
           // 🔥 NEW: Include vault data
            equippedBadges: user.vault?.equippedBadges || [],
            equippedBorder: user.vault?.equippedBorder || 'border-bronze',
            equippedTheme: user.vault?.equippedTheme || 'default'
        }));

        res.json(results);
    } catch (error) {
        console.error('[Social] Error searching users:', error);
        res.status(500).json({ error: 'Failed to search users' });
    }
});

// ============ COPY TRADING ============

// @route   GET /api/social/copy/traders
// @desc    Get list of traders the user is copying
// @access  Private
router.get('/copy/traders', auth, async (req, res) => {
    try {
        const copyTrades = await CopyTrade.getCopiedTraders(req.user.id);

        const traders = copyTrades.map(ct => ({
            copyTradeId: ct._id,
            trader: {
                userId: ct.trader._id,
                username: ct.trader.username,
                displayName: ct.trader.profile?.displayName || ct.trader.username,
                avatar: ct.trader.profile?.avatar || '',
                winRate: ct.trader.stats?.winRate || 0,
                totalTrades: ct.trader.stats?.totalTrades || 0,
                level: ct.trader.gamification?.level || 1
            },
            settings: ct.settings,
            stats: {
                totalCopiedTrades: ct.stats.totalCopiedTrades,
                successfulTrades: ct.stats.successfulTrades,
                failedTrades: ct.stats.failedTrades,
                totalProfitLoss: ct.stats.totalProfitLoss,
                totalProfitLossPercent: ct.stats.totalProfitLossPercent,
                winRate: ct.stats.totalCopiedTrades > 0
                    ? (ct.stats.successfulTrades / ct.stats.totalCopiedTrades) * 100
                    : 0,
                lastCopiedAt: ct.stats.lastCopiedAt
            },
            status: ct.status,
            createdAt: ct.createdAt
        }));

        res.json({ success: true, traders });
    } catch (error) {
        console.error('[Social] Error fetching copied traders:', error);
        res.status(500).json({ error: 'Failed to fetch copied traders' });
    }
});

// @route   GET /api/social/copy/copiers
// @desc    Get list of users copying the current user
// @access  Private
router.get('/copy/copiers', auth, async (req, res) => {
    try {
        const copyTrades = await CopyTrade.getCopiers(req.user.id);

        const copiers = copyTrades.map(ct => ({
            copier: {
                userId: ct.copier._id,
                username: ct.copier.username,
                displayName: ct.copier.profile?.displayName || ct.copier.username,
                avatar: ct.copier.profile?.avatar || ''
            },
            stats: {
                totalCopiedTrades: ct.stats.totalCopiedTrades,
                lastCopiedAt: ct.stats.lastCopiedAt
            },
            status: ct.status,
            createdAt: ct.createdAt
        }));

        res.json({
            success: true,
            copiers,
            totalCopiers: copiers.length
        });
    } catch (error) {
        console.error('[Social] Error fetching copiers:', error);
        res.status(500).json({ error: 'Failed to fetch copiers' });
    }
});

// @route   GET /api/social/copy/active
// @desc    Get active copied predictions
// @access  Private
router.get('/copy/active', auth, async (req, res) => {
    try {
        const activeCopies = await CopiedPrediction.getActiveCopies(req.user.id);

        const copies = activeCopies.map(cp => ({
            copyId: cp._id,
            trader: {
                userId: cp.trader._id,
                username: cp.trader.username,
                displayName: cp.trader.profile?.displayName || cp.trader.username,
                avatar: cp.trader.profile?.avatar || ''
            },
            prediction: {
                symbol: cp.copyDetails.symbol,
                assetType: cp.copyDetails.assetType,
                direction: cp.copyDetails.direction,
                entryPrice: cp.copyDetails.entryPrice,
                targetPrice: cp.copyDetails.targetPrice,
                confidence: cp.copyDetails.confidence,
                signalStrength: cp.copyDetails.signalStrength
            },
            allocation: cp.allocationDetails,
            status: cp.status,
            createdAt: cp.createdAt
        }));

        res.json({ success: true, copies });
    } catch (error) {
        console.error('[Social] Error fetching active copies:', error);
        res.status(500).json({ error: 'Failed to fetch active copies' });
    }
});

// @route   GET /api/social/copy/history
// @desc    Get copy trading history
// @access  Private
router.get('/copy/history', auth, async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const history = await CopiedPrediction.getCopyHistory(req.user.id, parseInt(limit));

        const copies = history.map(cp => ({
            copyId: cp._id,
            trader: {
                userId: cp.trader._id,
                username: cp.trader.username,
                displayName: cp.trader.profile?.displayName || cp.trader.username
            },
            symbol: cp.copyDetails.symbol,
            direction: cp.copyDetails.direction,
            outcome: cp.outcome,
            status: cp.status,
            createdAt: cp.createdAt
        }));

        res.json({ success: true, copies });
    } catch (error) {
        console.error('[Social] Error fetching copy history:', error);
        res.status(500).json({ error: 'Failed to fetch copy history' });
    }
});

// @route   GET /api/social/copy/stats
// @desc    Get overall copy trading stats for the user
// @access  Private
router.get('/copy/stats', auth, async (req, res) => {
    try {
        const stats = await CopiedPrediction.getCopierStats(req.user.id);
        const tradersCount = await CopyTrade.countDocuments({
            copier: req.user.id,
            status: 'active'
        });

        res.json({
            success: true,
            stats: {
                ...stats,
                activeTraders: tradersCount
            }
        });
    } catch (error) {
        console.error('[Social] Error fetching copy stats:', error);
        res.status(500).json({ error: 'Failed to fetch copy stats' });
    }
});

// @route   GET /api/social/copy/check/:userId
// @desc    Check if currently copying a user
// @access  Private
router.get('/copy/check/:userId', auth, async (req, res) => {
    try {
        const copyTrade = await CopyTrade.getCopyRelationship(req.user.id, req.params.userId);

        if (!copyTrade) {
            return res.json({ isCopying: false });
        }

        res.json({
            isCopying: copyTrade.status === 'active',
            isPaused: copyTrade.status === 'paused',
            copyTradeId: copyTrade._id,
            settings: copyTrade.settings,
            stats: copyTrade.stats,
            status: copyTrade.status
        });
    } catch (error) {
        console.error('[Social] Error checking copy status:', error);
        res.status(500).json({ error: 'Failed to check copy status' });
    }
});

// @route   POST /api/social/copy/:userId
// @desc    Start copy trading a user
// @access  Private
router.post('/copy/:userId', auth, async (req, res) => {
    try {
        const targetUserId = req.params.userId;
        const currentUserId = req.user.id;

        if (targetUserId === currentUserId) {
            return res.status(400).json({ error: 'Cannot copy trade yourself' });
        }

        // Check if already copying
        const existingCopy = await CopyTrade.findOne({
            copier: currentUserId,
            trader: targetUserId
        });

        if (existingCopy && existingCopy.status !== 'stopped') {
            return res.status(400).json({
                error: 'Already copying this trader',
                copyTradeId: existingCopy._id
            });
        }

        const targetUser = await User.findById(targetUserId)
            .select('username profile stats gamification');

        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get settings from request body or use defaults
        const settings = {
            allocationPercent: req.body.allocationPercent || 10,
            maxAmountPerTrade: req.body.maxAmountPerTrade || 1000,
            maxActiveTrades: req.body.maxActiveTrades || 10,
            copyAssetTypes: req.body.copyAssetTypes || { stocks: true, crypto: true, dex: false },
            minConfidence: req.body.minConfidence || 60,
            minSignalStrength: req.body.minSignalStrength || 'moderate',
            copyDirections: req.body.copyDirections || { up: true, down: true },
            enableStopLoss: req.body.enableStopLoss ?? true,
            stopLossPercent: req.body.stopLossPercent || 10,
            enableTakeProfit: req.body.enableTakeProfit ?? false,
            takeProfitPercent: req.body.takeProfitPercent || 20,
            notifyOnCopy: req.body.notifyOnCopy ?? true
        };

        // Create or reactivate copy trade
        let copyTrade;
        if (existingCopy) {
            // Reactivate stopped copy trade
            existingCopy.status = 'active';
            existingCopy.settings = settings;
            existingCopy.statusReason = null;
            existingCopy.stoppedAt = null;
            await existingCopy.save();
            copyTrade = existingCopy;
        } else {
            copyTrade = await CopyTrade.create({
                copier: currentUserId,
                trader: targetUserId,
                settings,
                status: 'active'
            });
        }

        // Update social arrays on both users
        await Promise.all([
            User.findByIdAndUpdate(currentUserId, {
                $addToSet: { 'social.copying': targetUserId }
            }),
            User.findByIdAndUpdate(targetUserId, {
                $addToSet: { 'social.copiedBy': currentUserId }
            })
        ]);

        // Send notification to the trader
        await NotificationService.createNotification(
            targetUserId,
            'copy_started',
            'New Copier',
            `${(await User.findById(currentUserId)).username} started copying your trades!`,
            { copierId: currentUserId }
        );

        console.log(`[CopyTrade] ${currentUserId} started copying ${targetUserId}`);

        res.json({
            success: true,
            message: 'Successfully started copy trading!',
            copyTrade: {
                id: copyTrade._id,
                trader: {
                    username: targetUser.username,
                    displayName: targetUser.profile?.displayName || targetUser.username,
                    avatar: targetUser.profile?.avatar || '',
                    winRate: targetUser.stats?.winRate || 0,
                    level: targetUser.gamification?.level || 1
                },
                settings: copyTrade.settings
            }
        });
    } catch (error) {
        console.error('[Social] Error setting up copy trading:', error);
        res.status(500).json({ error: 'Failed to set up copy trading' });
    }
});

// @route   PUT /api/social/copy/:userId
// @desc    Update copy trading settings
// @access  Private
router.put('/copy/:userId', auth, async (req, res) => {
    try {
        const copyTrade = await CopyTrade.findOne({
            copier: req.user.id,
            trader: req.params.userId,
            status: { $in: ['active', 'paused'] }
        });

        if (!copyTrade) {
            return res.status(404).json({ error: 'Copy trade relationship not found' });
        }

        // Update settings
        const allowedSettings = [
            'allocationPercent', 'maxAmountPerTrade', 'maxActiveTrades',
            'copyAssetTypes', 'minConfidence', 'minSignalStrength',
            'copyDirections', 'enableStopLoss', 'stopLossPercent',
            'enableTakeProfit', 'takeProfitPercent', 'notifyOnCopy'
        ];

        for (const key of allowedSettings) {
            if (req.body[key] !== undefined) {
                copyTrade.settings[key] = req.body[key];
            }
        }

        await copyTrade.save();

        res.json({
            success: true,
            message: 'Copy trading settings updated',
            settings: copyTrade.settings
        });
    } catch (error) {
        console.error('[Social] Error updating copy settings:', error);
        res.status(500).json({ error: 'Failed to update copy settings' });
    }
});

// @route   POST /api/social/copy/:userId/pause
// @desc    Pause copy trading
// @access  Private
router.post('/copy/:userId/pause', auth, async (req, res) => {
    try {
        const copyTrade = await CopyTrade.findOne({
            copier: req.user.id,
            trader: req.params.userId,
            status: 'active'
        });

        if (!copyTrade) {
            return res.status(404).json({ error: 'Active copy trade not found' });
        }

        await copyTrade.pause(req.body.reason || 'Manual pause');

        res.json({
            success: true,
            message: 'Copy trading paused',
            status: 'paused'
        });
    } catch (error) {
        console.error('[Social] Error pausing copy trading:', error);
        res.status(500).json({ error: 'Failed to pause copy trading' });
    }
});

// @route   POST /api/social/copy/:userId/resume
// @desc    Resume copy trading
// @access  Private
router.post('/copy/:userId/resume', auth, async (req, res) => {
    try {
        const copyTrade = await CopyTrade.findOne({
            copier: req.user.id,
            trader: req.params.userId,
            status: 'paused'
        });

        if (!copyTrade) {
            return res.status(404).json({ error: 'Paused copy trade not found' });
        }

        await copyTrade.resume();

        res.json({
            success: true,
            message: 'Copy trading resumed',
            status: 'active'
        });
    } catch (error) {
        console.error('[Social] Error resuming copy trading:', error);
        res.status(500).json({ error: 'Failed to resume copy trading' });
    }
});

// @route   DELETE /api/social/copy/:userId
// @desc    Stop copy trading a user
// @access  Private
router.delete('/copy/:userId', auth, async (req, res) => {
    try {
        const copyTrade = await CopyTrade.findOne({
            copier: req.user.id,
            trader: req.params.userId,
            status: { $in: ['active', 'paused'] }
        });

        if (!copyTrade) {
            return res.status(404).json({ error: 'Copy trade not found' });
        }

        await copyTrade.stop(req.body.reason || 'Manual stop');

        // Update social arrays
        await Promise.all([
            User.findByIdAndUpdate(req.user.id, {
                $pull: { 'social.copying': req.params.userId }
            }),
            User.findByIdAndUpdate(req.params.userId, {
                $pull: { 'social.copiedBy': req.user.id }
            })
        ]);

        // Cancel any pending copied predictions
        await CopiedPrediction.updateMany(
            {
                copyTrade: copyTrade._id,
                status: { $in: ['pending', 'active'] }
            },
            {
                status: 'cancelled',
                'outcome.closeReason': 'copy_stopped'
            }
        );

        console.log(`[CopyTrade] ${req.user.id} stopped copying ${req.params.userId}`);

        res.json({
            success: true,
            message: 'Copy trading stopped',
            stats: {
                totalCopiedTrades: copyTrade.stats.totalCopiedTrades,
                successfulTrades: copyTrade.stats.successfulTrades,
                totalProfitLoss: copyTrade.stats.totalProfitLoss
            }
        });
    } catch (error) {
        console.error('[Social] Error stopping copy trading:', error);
        res.status(500).json({ error: 'Failed to stop copy trading' });
    }
});

// @route   GET /api/social/copy/top-traders
// @desc    Get top traders available to copy (by performance)
// @access  Public
router.get('/copy/top-traders', async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        // Get users with good stats who have public profiles
        const topTraders = await User.find({
            $or: [
                { 'profile.isPublic': true },
                { 'profile.isPublic': { $exists: false } }
            ],
            'stats.totalTrades': { $gte: 10 },
            'stats.winRate': { $gte: 50 }
        })
        .select('username profile stats gamification social vault')
        .sort({ 'stats.winRate': -1, 'stats.totalReturnPercent': -1 })
        .limit(parseInt(limit));

        // Get copier counts for each trader
        const traderIds = topTraders.map(t => t._id);
        const copierCounts = await CopyTrade.aggregate([
            { $match: { trader: { $in: traderIds }, status: 'active' } },
            { $group: { _id: '$trader', count: { $sum: 1 } } }
        ]);

        const copierCountMap = {};
        copierCounts.forEach(c => {
            copierCountMap[c._id.toString()] = c.count;
        });

        const traders = topTraders.map(t => ({
            userId: t._id,
            username: t.username,
            displayName: t.profile?.displayName || t.username,
            avatar: t.profile?.avatar || '',
            stats: {
                winRate: t.stats?.winRate || 0,
                totalReturnPercent: t.stats?.totalReturnPercent || 0,
                totalTrades: t.stats?.totalTrades || 0,
                currentStreak: t.stats?.currentStreak || 0
            },
            level: t.gamification?.level || 1,
            followersCount: t.social?.followersCount || 0,
            copiersCount: copierCountMap[t._id.toString()] || 0,
            equippedBorder: t.vault?.equippedBorder || 'border-bronze'
        }));

        res.json({ success: true, traders });
    } catch (error) {
        console.error('[Social] Error fetching top traders:', error);
        res.status(500).json({ error: 'Failed to fetch top traders' });
    }
});

// ============ ADMIN ENDPOINTS ============

// Migration: Set display names and public profiles
router.post('/admin/migrate-profiles', auth, requireAdmin, async (req, res) => {
    try {
        const users = await User.find({});
        let updated = 0;
        
        for (const user of users) {
            let needsUpdate = false;
            
            if (!user.profile.displayName) {
                user.profile.displayName = user.username;
                needsUpdate = true;
            }
            
            if (user.profile.isPublic === undefined) {
                user.profile.isPublic = true;
                needsUpdate = true;
            }
            
            if (user.profile.showPortfolio === undefined) {
                user.profile.showPortfolio = true;
                needsUpdate = true;
            }
            
            if (needsUpdate) {
                await user.save();
                updated++;
            }
        }
        
        console.log(`[Migration] Updated ${updated} user profiles`);
        
        res.json({ 
            success: true, 
            message: `Migration complete! Updated ${updated} profiles`,
            total: users.length
        });
    } catch (error) {
        console.error('[Migration] Error:', error);
        res.status(500).json({ error: 'Migration failed', details: error.message });
    }
});

// Migration: Initialize gamification for all users
router.post('/admin/migrate-gamification', auth, requireAdmin, async (req, res) => {
    try {
        const users = await User.find({});
        let updated = 0;
        
        for (const user of users) {
            let needsUpdate = false;
            
            // Initialize gamification if not present
            if (!user.gamification) {
                user.gamification = {
                    xp: 0,
                    level: 1,
                    title: 'Rookie Trader',
                    achievements: [],
                    badges: []
                };
                needsUpdate = true;
            }
            
            // Initialize streak fields in stats if not present
            if (user.stats && user.stats.currentStreak === undefined) {
                user.stats.currentStreak = 0;
                user.stats.bestStreak = 0;
                needsUpdate = true;
            }
            
            if (needsUpdate) {
                await user.save();
                updated++;
            }
        }
        
        console.log(`[Migration] Initialized gamification for ${updated} users`);
        
        res.json({ 
            success: true, 
            message: `Gamification migration complete! Updated ${updated} users`,
            total: users.length
        });
    } catch (error) {
        console.error('[Migration] Error:', error);
        res.status(500).json({ error: 'Migration failed', details: error.message });
    }
});

// Migration: Initialize vault for all users
router.post('/admin/migrate-vault', auth, requireAdmin, async (req, res) => {
    try {
        const users = await User.find({});
        let updated = 0;
        
        for (const user of users) {
            let needsUpdate = false;
            
            // Initialize vault if not present
            if (!user.vault) {
                user.vault = {
                    ownedItems: [],
                    equippedBadges: [],
                    equippedBorder: null,
                    equippedTheme: null,
                    activePerks: []
                };
                needsUpdate = true;
            }
            
            if (needsUpdate) {
                await user.save();
                updated++;
            }
        }
        
        console.log(`[Migration] Initialized vault for ${updated} users`);
        
        res.json({ 
            success: true, 
            message: `Vault migration complete! Updated ${updated} users`,
            total: users.length
        });
    } catch (error) {
        console.error('[Migration] Error:', error);
        res.status(500).json({ error: 'Migration failed', details: error.message });
    }
});

// Update all user stats
router.post('/admin/update-stats', auth, requireAdmin, async (req, res) => {
    try {
        await updateAllUserStats();
        res.json({ 
            success: true, 
            message: 'All user stats updated successfully from portfolio data' 
        });
    } catch (error) {
        console.error('[Admin] Error updating stats:', error);
        res.status(500).json({ error: 'Failed to update stats', details: error.message });
    }
});

// Update single user's stats
router.post('/admin/update-stats/:userId', auth, requireAdmin, async (req, res) => {
    try {
        await updateUserStats(req.params.userId);
        res.json({ 
            success: true, 
            message: `User ${req.params.userId} stats updated successfully` 
        });
    } catch (error) {
        console.error('[Admin] Error updating user stats:', error);
        res.status(500).json({ error: 'Failed to update user stats', details: error.message });
    }
});

// 🔥 DEBUG: Check where achievements are stored for a user
router.get('/debug/achievements/:username', auth, requireAdmin, async (req, res) => {
    try {
        // Sanitize username for MongoDB query (NoSQL injection prevention)
        const sanitizedUsername = sanitizeQueryString(req.params.username);
        if (!sanitizedUsername) {
            return res.json({ error: 'Invalid username format' });
        }

        // Find user
        const user = await User.findOne({ username: sanitizedUsername });
        if (!user) {
            return res.json({ error: 'User not found' });
        }
        
        // Find separate gamification doc
        let gamificationDoc = null;
        try {
            gamificationDoc = await Gamification.findOne({ user: user._id });
        } catch (e) {
            console.log('No separate Gamification collection');
        }
        
        res.json({
            username: user.username,
            userId: user._id,
            
            // Check User.achievements array
            userAchievements: {
                location: 'User.achievements',
                exists: !!user.achievements,
                count: user.achievements?.length || 0,
                sample: user.achievements?.slice(0, 3) || []
            },
            
            // Check User.gamification.achievements (embedded)
            embeddedGamificationAchievements: {
                location: 'User.gamification.achievements',
                exists: !!(user.gamification?.achievements),
                count: user.gamification?.achievements?.length || 0,
                sample: user.gamification?.achievements?.slice(0, 3) || []
            },
            
            // Check separate Gamification document
            separateGamificationDoc: {
                location: 'Gamification collection (separate document)',
                exists: !!gamificationDoc,
                docId: gamificationDoc?._id || null,
                count: gamificationDoc?.achievements?.length || 0,
                sample: gamificationDoc?.achievements?.slice(0, 3) || []
            },
            
            // Summary
            summary: {
                totalAchievementsFound: 
                    (user.achievements?.length || 0) + 
                    (user.gamification?.achievements?.length || 0) + 
                    (gamificationDoc?.achievements?.length || 0),
                recommendedSource: 
                    user.achievements?.length > 0 ? 'User.achievements' :
                    user.gamification?.achievements?.length > 0 ? 'User.gamification.achievements' :
                    gamificationDoc?.achievements?.length > 0 ? 'Gamification document' :
                    'NO ACHIEVEMENTS FOUND'
            }
        });
    } catch (error) {
        console.error('[Debug] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;