const auth = require('./middleware/authMiddleware');
const requireAdmin = require('./middleware/adminMiddleware');
// server/app.js - Updated with Portfolio, Predictions, Chat, Alerts, and PATTERN Routes

require('dotenv').config();

// Structured logging
const logger = require('./utils/logger');
const { requestLogger, errorLogger } = require('./middleware/requestLogger');

// Debug logging only in development
if (process.env.NODE_ENV !== 'production') {
    logger.info('MONGODB_URI: ' + (process.env.MONGODB_URI ? 'FOUND' : 'MISSING'));
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
// These routes are registered before the general API middleware.
const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many administrative requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false,
});
const journalRoutes = require('./routes/journalRoutes');
const screenerRoutes = require('./routes/screenerRoutes');
const opportunitiesRoutes = require('./routes/opportunitiesRoutes');
const heatmapRoutes = require('./routes/heatmapRoutes');
const gamificationRoutes = require('./routes/gamificationRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const vaultRoutes = require('./routes/vaultRoutes');
const whaleRoutes = require('./routes/whaleRoutes');
const searchRoutes = require('./routes/searchRoutes');
const publicStatsRoutes = require('./routes/publicStats');
const postRoutes = require('./routes/postRoutes'); // ✅ NEW - Posts/Social Feed
const stripeRoutes = require('./routes/stripeRoutes'); // 💳 Stripe Payments

// ============================================
// STRIPE WEBHOOK - MUST BE BEFORE ANY BODY PARSING MIDDLEWARE
// ============================================
const User = require('./models/User');
const { PLAN_LIMITS } = require('./middleware/subscriptionMiddleware');

// Price mapping function for webhook - uses env vars with hardcoded fallbacks
const getPlanFromPriceId = (priceId) => {
    // Environment variable mapping (preferred)
    const envMapping = {
        [process.env.STRIPE_PRICE_STARTER]: 'starter',
        [process.env.STRIPE_PRICE_PRO]: 'pro',
        [process.env.STRIPE_PRICE_PREMIUM]: 'premium',
        [process.env.STRIPE_PRICE_ELITE]: 'elite'
    };

    // Hardcoded LIVE price IDs as fallback (must match Stripe dashboard)
    const hardcodedMapping = {
        // Monthly
        'price_1SfTvNCd6gxWUimRapg2v7zC': 'starter',
        'price_1SfTxUCd6gxWUimRfpe40Nr2': 'pro',
        'price_1SfU0WCd6gxWUimRjjA8XnFr': 'premium',
        'price_1SfU1VCd6gxWUimReOuVaFb4': 'elite',
        // Yearly
        'price_1SfTvNCd6gxWUimR5g3pUz9g': 'starter',
        'price_1SfTxUCd6gxWUimRDKXxf5B9': 'pro',
        'price_1SfU0WCd6gxWUimRj1tdL545': 'premium',
        'price_1SfU1VCd6gxWUimR0tUeO70P': 'elite'
    };

    // Try env mapping first, then hardcoded
    let plan = envMapping[priceId] || hardcodedMapping[priceId];

    if (!plan) {
        console.log(`[Stripe Webhook] ⚠️ Unknown price ID: ${priceId}`);
        console.log(`[Stripe Webhook] Env vars: STARTER=${process.env.STRIPE_PRICE_STARTER}, PRO=${process.env.STRIPE_PRICE_PRO}`);
        plan = 'starter'; // Default fallback
    }

    console.log(`[Stripe Webhook] Price ${priceId} → Plan: ${plan}`);
    return plan;
};

const getStripeId = (value) => (typeof value === 'string' ? value : value?.id);

const getCustomerFromStripe = async (customerOrId) => {
    if (!customerOrId) return null;
    if (typeof customerOrId === 'object') return customerOrId;
    return stripe.customers.retrieve(customerOrId);
};

const findUserForStripeSubscription = async (subscription, options = {}) => {
    const customerId = getStripeId(subscription.customer) || getStripeId(options.customer);
    const directUserId = options.userId || subscription.metadata?.userId;
    let customer = options.customer || null;
    let user = null;

    if (subscription.id) {
        user = await User.findOne({ 'subscription.stripeSubscriptionId': subscription.id });
    }

    if (!user && customerId) {
        user = await User.findOne({ 'subscription.stripeCustomerId': customerId });
    }

    if (!user && directUserId && mongoose.Types.ObjectId.isValid(directUserId)) {
        user = await User.findById(directUserId);
    }

    if (!user && customerId) {
        try {
            customer = await getCustomerFromStripe(customer || customerId);
            const metadataUserId = customer.metadata?.userId;

            if (metadataUserId && mongoose.Types.ObjectId.isValid(metadataUserId)) {
                user = await User.findById(metadataUserId);
            }

            if (!user && customer.email) {
                const escapedEmail = customer.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                user = await User.findOne({ email: new RegExp(`^${escapedEmail}$`, 'i') });
            }
        } catch (stripeErr) {
            console.error(`[Stripe Webhook] Error retrieving customer ${customerId}: ${stripeErr.message}`);
        }
    }

    return { user, customer, customerId };
};

const syncStripeSubscriptionToMongo = async (subscription, options = {}) => {
    if (!subscription?.id) {
        throw new Error('Cannot sync Stripe subscription without an id');
    }

    const activeStatuses = new Set(['active', 'trialing']);
    if (!activeStatuses.has(subscription.status)) {
        console.log(`[Stripe Webhook] Subscription ${subscription.id} is ${subscription.status}; not granting paid access yet.`);
        return null;
    }

    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (!priceId) {
        throw new Error(`Subscription ${subscription.id} has no price ID`);
    }

    const plan = getPlanFromPriceId(priceId);
    const { user, customerId } = await findUserForStripeSubscription(subscription, options);

    if (!user) {
        throw new Error(`No Mongo user found for Stripe subscription ${subscription.id} / customer ${getStripeId(subscription.customer)}`);
    }

    const updatedUser = await User.findByIdAndUpdate(
        user._id,
        {
            $set: {
                'subscription.status': plan,
                'subscription.stripeCustomerId': customerId || getStripeId(subscription.customer),
                'subscription.stripeSubscriptionId': subscription.id,
                'subscription.stripePriceId': priceId,
                'subscription.currentPeriodStart': new Date(subscription.current_period_start * 1000),
                'subscription.currentPeriodEnd': new Date(subscription.current_period_end * 1000),
                'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end
            }
        },
        { new: true }
    );

    console.log(`[Stripe Webhook] Synced subscription ${subscription.id} to user ${updatedUser._id}: ${plan}`);

    try {
        const { syncPremiumRole } = require('./services/discordService');
        await syncPremiumRole(updatedUser._id);
    } catch (discordErr) {
        console.error('[Stripe Webhook] Discord role sync error:', discordErr.message);
    }

    return updatedUser;
};

const clearStripeSubscriptionInMongo = async (subscription) => {
    const { user } = await findUserForStripeSubscription(subscription);

    if (!user) {
        throw new Error(`No Mongo user found for canceled Stripe subscription ${subscription.id}`);
    }

    user.subscription.status = 'free';
    user.subscription.stripeSubscriptionId = null;
    user.subscription.currentPeriodEnd = null;
    await user.save();

    console.log(`[Stripe Webhook] Canceled subscription ${subscription.id} for user ${user._id}`);

    try {
        const { syncPremiumRole } = require('./services/discordService');
        await syncPremiumRole(user._id);
    } catch (discordErr) {
        console.error('[Stripe Webhook] Discord role removal error:', discordErr.message);
    }

    return user;
};

// Rate limiter for Stripe webhook (lenient - Stripe retries on failure)
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // Allow 100 webhook calls per minute
    message: { error: 'Too many webhook requests' }
});

// Stripe webhook endpoint - raw body parser applied inline
app.post('/api/stripe/webhook',
    webhookLimiter,
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const sig = req.headers['stripe-signature'];
        console.log(`[Stripe Webhook] Received webhook request`);
        console.log(`[Stripe Webhook] Signature: ${sig ? 'present' : 'MISSING'}`);
        console.log(`[Stripe Webhook] Body type: ${typeof req.body}, isBuffer: ${Buffer.isBuffer(req.body)}`);
        console.log(`[Stripe Webhook] Secret configured: ${process.env.STRIPE_WEBHOOK_SECRET ? 'yes' : 'NO'}`);

        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );
            console.log(`[Stripe Webhook] ✅ Signature verified! Event type: ${event.type}`);
        } catch (err) {
            console.error('Webhook signature verification failed:', err.message);
            return res.status(400).json({ error: 'Webhook signature verification failed' });
        }

        // Handle the event
        try {
            switch (event.type) {
                case 'checkout.session.completed': {
                    const session = event.data.object;
                    const subscriptionId = session.subscription;

                    console.log(`[Stripe Webhook] checkout.session.completed for user ${session.metadata?.userId}`);
                    console.log(`[Stripe Webhook] Subscription ID: ${subscriptionId}`);

                    if (!subscriptionId) {
                        console.log('[Stripe Webhook] Checkout session has no subscription; skipping subscription sync.');
                        break;
                    }

                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    await syncStripeSubscriptionToMongo(subscription, {
                        userId: session.metadata?.userId || session.client_reference_id,
                        customer: session.customer
                    });
                    break;
                }

                case 'customer.subscription.created':
                case 'customer.subscription.updated': {
                    const subscription = event.data.object;
                    console.log(`[Stripe Webhook] ${event.type} for customer ${getStripeId(subscription.customer)}, subscription ${subscription.id}`);
                    await syncStripeSubscriptionToMongo(subscription);
                    break;
                }

                case 'customer.subscription.deleted': {
                    const subscription = event.data.object;
                    console.log(`[Stripe Webhook] customer.subscription.deleted for customer ${getStripeId(subscription.customer)}`);
                    await clearStripeSubscriptionInMongo(subscription);
                    break;
                }

                case 'invoice.payment_succeeded': {
                    const invoice = event.data.object;
                    const subscriptionId = getStripeId(invoice.subscription);

                    console.log(`[Stripe Webhook] invoice.payment_succeeded for customer ${getStripeId(invoice.customer)}, subscription ${subscriptionId}`);

                    if (!subscriptionId) {
                        console.log('[Stripe Webhook] Paid invoice has no subscription; skipping subscription sync.');
                        break;
                    }

                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    await syncStripeSubscriptionToMongo(subscription, {
                        customer: invoice.customer
                    });
                    break;
                }

                case 'invoice.payment_failed': {
                    const invoice = event.data.object;
                    const customerId = invoice.customer;
                    console.log(`[Stripe Webhook] Payment failed for customer ${customerId}`);
                    // Could notify user or mark subscription as past_due
                    break;
                }

                default:
                    console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
            }
        } catch (handlerError) {
            console.error(`[Stripe Webhook] Error handling event:`, handlerError);
            return res.status(500).json({ error: 'Webhook handler failed' });
        }

        res.json({ received: true });
    }
);

// ============================================
// PLAID WEBHOOK - MUST BE BEFORE ANY BODY PARSING MIDDLEWARE
// Signature verification requires raw body access
// ============================================
const BrokerageConnection = require('./models/BrokerageConnection');
const plaidService = require('./services/plaidService');

app.post('/api/brokerage/plaid/webhook',
    webhookLimiter,
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        console.log(`[Plaid Webhook] Received webhook request`);

        const plaidVerification = req.headers['plaid-verification'];
        const rawBody = req.body.toString('utf8');

        // Verify webhook signature (skip in development/sandbox if header not present)
        if (plaidVerification) {
            try {
                await plaidService.verifyWebhookSignature(rawBody, plaidVerification);
                console.log(`[Plaid Webhook] ✅ Signature verified!`);
            } catch (verifyError) {
                console.error(`[Plaid Webhook] ❌ Signature verification failed:`, verifyError.message);
                return res.status(401).json({ error: 'Webhook signature verification failed' });
            }
        } else if (process.env.PLAID_ENV === 'production') {
            // In production, require signature verification
            console.error(`[Plaid Webhook] ❌ Missing Plaid-Verification header in production`);
            return res.status(401).json({ error: 'Missing webhook signature' });
        } else {
            console.log(`[Plaid Webhook] ⚠️ Skipping signature verification (sandbox mode)`);
        }

        // Parse the body
        let body;
        try {
            body = JSON.parse(rawBody);
        } catch (parseError) {
            console.error(`[Plaid Webhook] Failed to parse body:`, parseError.message);
            return res.status(400).json({ error: 'Invalid JSON body' });
        }

        const { webhook_type, webhook_code, item_id, error } = body;
        console.log(`[Plaid Webhook] Type: ${webhook_type}, Code: ${webhook_code}, Item: ${item_id}`);

        try {
            // Find the connection by Plaid item ID
            const connection = await BrokerageConnection.findOne({ 'plaid.itemId': item_id });

            if (!connection) {
                console.log(`[Plaid Webhook] No connection found for item: ${item_id}`);
                return res.json({ received: true });
            }

            switch (webhook_type) {
                case 'HOLDINGS':
                    if (webhook_code === 'DEFAULT_UPDATE') {
                        console.log(`[Plaid Webhook] Holdings updated for ${connection.name}`);
                        try {
                            const accessToken = connection.getPlaidAccessToken();
                            const holdings = await plaidService.getHoldings(accessToken);
                            const portfolioData = {
                                holdings: holdings.holdings.map(h => ({
                                    symbol: h.symbol,
                                    name: h.name,
                                    quantity: h.quantity,
                                    price: h.price,
                                    value: h.value,
                                    costBasis: h.costBasis,
                                    type: h.type
                                })),
                                totalValue: holdings.accounts.reduce((sum, acc) => sum + acc.totalValue, 0)
                            };
                            await connection.updateCache(portfolioData);
                            console.log(`[Plaid Webhook] Holdings synced for ${connection.name}`);
                        } catch (syncErr) {
                            console.error(`[Plaid Webhook] Error syncing holdings:`, syncErr.message);
                        }
                    }
                    break;

                case 'INVESTMENTS_TRANSACTIONS':
                    if (webhook_code === 'DEFAULT_UPDATE') {
                        console.log(`[Plaid Webhook] New transactions for ${connection.name}`);
                    }
                    break;

                case 'ITEM':
                    if (webhook_code === 'ERROR') {
                        console.error(`[Plaid Webhook] Item error for ${connection.name}:`, error);
                        await connection.setError(error?.error_message || 'Connection error');
                    } else if (webhook_code === 'PENDING_EXPIRATION') {
                        console.log(`[Plaid Webhook] Connection expiring soon for ${connection.name}`);
                        await connection.setError('Connection will expire soon - please re-authenticate');
                    } else if (webhook_code === 'USER_PERMISSION_REVOKED') {
                        console.log(`[Plaid Webhook] User revoked access for ${connection.name}`);
                        connection.status = 'disconnected';
                        connection.lastError = 'Access was revoked';
                        await connection.save();
                    }
                    break;

                default:
                    console.log(`[Plaid Webhook] Unhandled webhook type: ${webhook_type}`);
            }

            res.json({ received: true });

        } catch (handlerError) {
            console.error('[Plaid Webhook] Error processing webhook:', handlerError);
            // Still return 200 to prevent Plaid from retrying
            res.json({ received: true, error: handlerError.message });
        }
    }
);

// --- Database Connection Setup ---
const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGODB_URI);
        logger.info(`MongoDB Connected: ${conn.connection.host}`);
        
        // ✅ START ALERT CHECKER AFTER DB CONNECTION
        const { startAlertChecker } = require('./services/alertChecker');
        startAlertChecker();
        
        // ✅ START PREDICTION CHECKER - ENABLED!
        const { startPredictionChecker } = require('./services/predictionChecker');
        startPredictionChecker();

        // ✅ START AUTOMATED SIGNAL GENERATOR (hourly scans of top stocks + crypto)
        const { startSignalGenerator } = require('./services/signalGenerator');
        startSignalGenerator();

        // Historical records are immutable; migrations run separately after review.
        const { startSignalResultChecker } = require('./services/signalResultChecker');
        startSignalResultChecker();

        // TELEGRAM BOT — Conversion funnel (teases signals, posts results, drives to website)
        try {
            const { initializeTelegramBot } = require('./services/telegramBot');
            initializeTelegramBot();
        } catch (tgErr) {
            console.error('[TGBot] ❌ Failed to initialize:', tgErr.message);
        }

        // X (TWITTER) AUTO-POSTER — Same signals as website + Telegram
        const { startXPoster, testXPost } = require('./services/xPosterService');
        startXPoster();

        // X test endpoint (temporary — remove after testing)
        app.post('/api/test-x-post', adminLimiter, auth, requireAdmin, async (req, res) => {
            try {
                const result = await testXPost();
                res.json({ success: !!result, result: result || 'failed — check Render logs' });
            } catch (e) {
                res.json({ success: false, error: e.message });
            }
        });

        // Signal checker diagnostic endpoint
        app.get('/api/admin/checker-status', adminLimiter, auth, requireAdmin, async (req, res) => {
            try {
                const { getCheckerStats, runCheckCycle } = require('./services/signalResultChecker');
                const Prediction = require('./models/Prediction');

                const stats = getCheckerStats();

                // Get sample of pending signals
                const pendingSignals = await Prediction.find({
                    status: 'pending',
                    result: null,
                    entryPrice: { $exists: true, $ne: null },
                    expiresAt: { $gt: new Date() }
                }).limit(5).select('symbol assetType entryPrice livePrice livePriceUpdatedAt stopLoss').lean();

                // Count signals that would be checked
                const totalPending = await Prediction.countDocuments({
                    status: 'pending',
                    result: null,
                    entryPrice: { $exists: true, $ne: null },
                    expiresAt: { $gt: new Date() }
                });

                res.json({
                    success: true,
                    checkerStats: stats,
                    totalPendingSignals: totalPending,
                    sampleSignals: pendingSignals.map(s => ({
                        symbol: s.symbol,
                        assetType: s.assetType,
                        entryPrice: s.entryPrice,
                        livePrice: s.livePrice,
                        livePriceUpdatedAt: s.livePriceUpdatedAt,
                        stopLoss: s.stopLoss,
                        priceAge: s.livePriceUpdatedAt ? `${Math.round((Date.now() - new Date(s.livePriceUpdatedAt).getTime()) / 60000)} min ago` : 'never'
                    }))
                });
            } catch (e) {
                res.json({ success: false, error: e.message });
            }
        });

        // Manually trigger checker cycle
        app.post('/api/admin/run-checker', adminLimiter, auth, requireAdmin, async (req, res) => {
            try {
                const { runCheckCycle, getCheckerStats } = require('./services/signalResultChecker');
                console.log('[Admin] Manually triggering signal checker...');
                await runCheckCycle();
                const stats = getCheckerStats();
                res.json({ success: true, message: 'Check cycle completed', stats });
            } catch (e) {
                res.json({ success: false, error: e.message });
            }
        });

        // Admin: expire stale predictions that are still "pending" past their expiresAt or older than 14 days
        app.get('/api/admin/expire-stale', adminLimiter, auth, requireAdmin, async (req, res) => {
    return res.status(410).json({ error: 'Historical cleanup is disabled. Use a reviewed offline migration.' });
});

        // Admin: clean up bad signals (broken SL/TP levels or blown-past SL)
        app.get('/api/admin/cleanup-bad-signals', adminLimiter, auth, requireAdmin, async (req, res) => {
    return res.status(410).json({ error: 'Historical cleanup is disabled. Use a reviewed offline migration.' });
});

        // Admin: Check subscription status for a user (by email or userId)
        app.get('/api/admin/subscription-status', adminLimiter, auth, requireAdmin, async (req, res) => {
            try {
                const { email, userId } = req.query;
                if (!email && !userId) {
                    return res.status(400).json({ error: 'Provide email or userId query param' });
                }

                const query = email ? { email } : { _id: userId };
                const user = await User.findOne(query).select('email username subscription createdAt');

                if (!user) {
                    return res.json({ found: false, message: 'User not found' });
                }

                // Check Stripe subscription if customerId exists
                let stripeData = null;
                if (user.subscription?.stripeCustomerId) {
                    try {
                        const customer = await stripe.customers.retrieve(user.subscription.stripeCustomerId);
                        const subscriptions = await stripe.subscriptions.list({
                            customer: user.subscription.stripeCustomerId,
                            limit: 5
                        });
                        stripeData = {
                            customer: {
                                id: customer.id,
                                email: customer.email,
                                created: new Date(customer.created * 1000)
                            },
                            subscriptions: subscriptions.data.map(s => ({
                                id: s.id,
                                status: s.status,
                                priceId: s.items.data[0]?.price?.id,
                                currentPeriodEnd: new Date(s.current_period_end * 1000),
                                cancelAtPeriodEnd: s.cancel_at_period_end
                            }))
                        };
                    } catch (stripeErr) {
                        stripeData = { error: stripeErr.message };
                    }
                }

                res.json({
                    found: true,
                    user: {
                        id: user._id,
                        email: user.email,
                        username: user.username,
                        createdAt: user.createdAt
                    },
                    subscription: user.subscription,
                    stripeData,
                    envCheck: {
                        webhookSecretConfigured: !!process.env.STRIPE_WEBHOOK_SECRET,
                        priceStarterConfigured: !!process.env.STRIPE_PRICE_STARTER,
                        priceProConfigured: !!process.env.STRIPE_PRICE_PRO
                    }
                });
            } catch (e) {
                res.json({ success: false, error: e.message });
            }
        });

        // Admin: Manually sync subscription from Stripe (fix missed webhooks)
        // Supports both GET (browser-friendly) and POST
        app.get('/api/admin/sync-subscription', adminLimiter, auth, requireAdmin, async (req, res) => {
            const { email, userId } = req.query;
            return handleSyncSubscription(email, userId, res);
        });
        app.post('/api/admin/sync-subscription', adminLimiter, auth, requireAdmin, async (req, res) => {
            const { email, userId } = req.body;
            return handleSyncSubscription(email, userId, res);
        });

        async function handleSyncSubscription(email, userId, res) {
            try {
                if (!email && !userId) {
                    return res.status(400).json({ error: 'Provide email or userId in body' });
                }

                const query = email ? { email } : { _id: userId };
                const user = await User.findOne(query);

                if (!user) {
                    return res.json({ success: false, error: 'User not found' });
                }

                // Find or get Stripe customer
                let customerId = user.subscription?.stripeCustomerId;
                if (!customerId) {
                    // Try to find by email
                    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
                    if (customers.data.length > 0) {
                        customerId = customers.data[0].id;
                    }
                }

                if (!customerId) {
                    return res.json({ success: false, error: 'No Stripe customer found for this user' });
                }

                // Get active subscriptions
                const subscriptions = await stripe.subscriptions.list({
                    customer: customerId,
                    status: 'active',
                    limit: 1
                });

                if (subscriptions.data.length === 0) {
                    // Check for trialing or past_due
                    const allSubs = await stripe.subscriptions.list({
                        customer: customerId,
                        limit: 5
                    });

                    if (allSubs.data.length === 0) {
                        return res.json({ success: false, error: 'No subscriptions found in Stripe' });
                    }

                    // Use the most recent subscription
                    const latestSub = allSubs.data[0];
                    if (latestSub.status === 'canceled' || latestSub.status === 'incomplete_expired') {
                        user.subscription = {
                            ...user.subscription,
                            status: 'free',
                            stripeCustomerId: customerId
                        };
                        await user.save();
                        return res.json({ success: true, message: 'Subscription is canceled, set to free', subscription: user.subscription });
                    }
                }

                const subscription = subscriptions.data[0] || (await stripe.subscriptions.list({ customer: customerId, limit: 1 })).data[0];

                if (!subscription) {
                    return res.json({ success: false, error: 'No subscription found' });
                }

                const priceId = subscription.items.data[0].price.id;
                const plan = getPlanFromPriceId(priceId);

                // Update user subscription
                const oldStatus = user.subscription?.status;
                user.subscription = {
                    status: plan,
                    stripeSubscriptionId: subscription.id,
                    stripeCustomerId: customerId,
                    stripePriceId: priceId,
                    currentPeriodStart: new Date(subscription.current_period_start * 1000),
                    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
                    cancelAtPeriodEnd: subscription.cancel_at_period_end,
                    trialUsed: user.subscription?.trialUsed || false,
                    trialEndsAt: user.subscription?.trialEndsAt || null
                };
                await user.save();

                console.log(`[Admin] Synced subscription for ${user.email}: ${oldStatus} → ${plan}`);

                res.json({
                    success: true,
                    message: `Subscription synced: ${oldStatus || 'none'} → ${plan}`,
                    subscription: user.subscription
                });
            } catch (e) {
                console.error('[Admin] Sync subscription error:', e);
                res.json({ success: false, error: e.message });
            }
        }

        // Manual signal generation trigger (for debugging)
        app.post('/api/trigger-signals', adminLimiter, auth, requireAdmin, async (req, res) => {
            try {
                const { runCycle } = require('./services/signalGenerator');
                res.json({ success: true, message: 'Signal cycle triggered — check logs' });
                runCycle(); // Run async, don't await
            } catch (e) {
                res.json({ success: false, error: e.message });
            }
        });

        // ✅ INITIALIZE DISCORD BOT
        const { initializeBot: initializeDiscordBot } = require('./services/discordService');
        initializeDiscordBot();

        // ✅ INITIALIZE DISCORD NOTIFICATION SCHEDULERS
        const { initializeSchedulers: initializeDiscordSchedulers } = require('./services/discordScheduler');
        // Delay scheduler start to ensure bot is fully initialized (after Telegram)
        setTimeout(() => initializeDiscordSchedulers(), 7000);

        // ✅ START WEBSOCKET PRICE SERVICE (Real-time price streaming)
        const { startWebSocketService } = require('./services/websocketPriceService');
        startWebSocketService();
        logger.info('✅ WebSocket Price Service started');

    } catch (error) {
        logger.error(`MongoDB Connection Error: ${error.message}`);
    }
};

// Connect to Database immediately when app loads
connectDB();

// --- CORS Setup ---
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5000',
    'http://localhost:3000/', // ✅ Added with trailing slash
    'http://localhost:5000/', // ✅ Added with trailing slash
    'https://www.nexussignal.ai',
    'https://nexussignal.ai',
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or Postman)
        if (!origin) return callback(null, true);
        
        // Allow all localhost origins in development
        if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) {
            return callback(null, true);
        }
        
        // Check allowed origins list
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            logger.warn(`CORS Blocked: ${origin}`);
            callback(new Error('Not allowed by CORS'), false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token'],
}));
app.options('*', cors());

// --- Rate Limiting ---
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: { error: 'Too many login attempts, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: { error: 'Too many requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- Middleware ---
// Security headers with Content Security Policy
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "https://api.stripe.com", "https://*.polygon.io", "https://*.finnhub.io", "wss://*.finnhub.io"],
            frameSrc: ["'self'", "https://js.stripe.com"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
        }
    },
    crossOriginEmbedderPolicy: false // Required for loading external resources
}));

// --- JSON parsing ---
// Note: Stripe webhook is handled BEFORE this middleware in app.js
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// Cookie parser for reading cookies (used for refresh tokens)
// Note: This API uses stateless JWT authentication via Authorization headers,
// not cookie-based sessions. CSRF protection is not required because:
// 1. Authentication tokens are sent in headers, not automatically with requests
// 2. API endpoints require valid JWT tokens that attackers cannot forge
// 3. CORS restricts cross-origin requests to whitelisted domains
app.use(cookieParser());

app.use(mongoSanitize());
app.use(xss());
app.use(hpp());

// Request logging - adds request ID and logs all HTTP requests
app.use(requestLogger);

// Apply rate limiting
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/users/login', authLimiter);
app.use('/api/users/register', authLimiter);
app.use('/api/', apiLimiter);

// --- ROUTE IMPORTS ---
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const dashboardRoutes = require('./routes/dashboard');
const stockRoutes = require('./routes/stockRoutes');
const cryptoRoutes = require('./routes/cryptoRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const marketDataRoutes = require('./routes/marketDataRoutes');
const watchlistRoutes = require('./routes/watchlistRoutes');
const predictionsRoutes = require('./routes/predictionsRoutes');
const chatRoutes = require('./routes/chatRoutes');
const newsRoutes = require('./routes/newsRoutes');
const socialRoutes = require('./routes/socialRoutes');
const feedRoutes = require('./routes/feedRoutes');
const sentimentRoutes = require('./routes/sentimentRoutes');
const portfolioHistoryRoutes = require('./routes/portfolioHistoryRoutes');
const aiInsightsRoutes = require('./routes/aiInsightsRoutes')
const chartRoutes = require('./routes/chartRoutes');
const calculatorRoutes = require('./routes/calculatorRoutes'); 
const paperTradingRoutes = require('./routes/paperTradingRoutes');
const alertRoutes = require('./routes/alertRoutes'); // ✅ ADDED - Price Alerts System
const patternRoutes = require('./routes/patternRoutes'); // ✅ ADDED - AI Pattern Recognition
const statsRoutes = require('./routes/statsRoutes'); // ✅ ADDED - Platform Stats for Landing Page
const onboardingRoutes = require('./routes/onboardingRoutes'); // ✅ ADDED - Onboarding Flow
const leaderboardRoutes = require('./routes/leaderboardRoutes')
const walletRoutes = require('./routes/walletRoutes'); // Wallet Connection
const brokerageRoutes = require('./routes/brokerageRoutes'); // Brokerage Connections (Kraken, Plaid)
const twoFactorRoutes = require('./routes/twoFactorRoutes'); // Two-Factor Authentication
const earningsRoutes = require('./routes/earningsRoutes'); // Earnings Calendar
const financialsRoutes = require('./routes/financialsRoutes'); // Company Financials
const marketReportsRoutes = require('./routes/marketReportsRoutes'); // AI Market Reports
const sectorRotationRoutes = require('./routes/sectorRotationRoutes'); // Sector Rotation
const economicCalendarRoutes = require('./routes/economicCalendarRoutes'); // Economic Calendar
const technicalIndicatorsRoutes = require('./routes/technicalIndicatorsRoutes'); // Technical Indicators
const telegramRoutes = require('./routes/telegramRoutes'); // Telegram Bot Notifications
const discordRoutes = require('./routes/discordRoutes'); // Discord Bot Notifications
const backtestRoutes = require('./routes/apibacktestRoutes'); // 📊 Strategy Backtesting (Elite)
const livePriceRoutes = require('./routes/livePriceRoutes'); // 📈 Live Price SSE Streaming
const transactionsRoutes = require('./routes/transactionsRoutes'); // 💰 Recent Transactions
const pushRoutes = require('./routes/pushRoutes'); // 🔔 Web Push Notifications

// Basic root route for health check
app.get('/', (req, res) => res.send('API is running...'));

// Comprehensive health check endpoint for monitoring
app.get('/health', async (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        checks: {}
    };

    // Check MongoDB connection
    try {
        const mongoose = require('mongoose');
        if (mongoose.connection.readyState === 1) {
            health.checks.database = { status: 'connected' };
        } else {
            health.checks.database = { status: 'disconnected' };
            health.status = 'degraded';
        }
    } catch (err) {
        health.checks.database = { status: 'error', message: err.message };
        health.status = 'unhealthy';
    }

    // Check memory usage
    const memUsage = process.memoryUsage();
    health.checks.memory = {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
    };

    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
});

// --- ROUTE MOUNTING (with /api prefix) ---
app.use('/api/auth', authRoutes);
app.use('/api/auth', onboardingRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/stocks', stockRoutes);
app.use('/api/crypto', cryptoRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/market-data', marketDataRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/predictions', predictionsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/screener', screenerRoutes);
app.use('/api/opportunities', opportunitiesRoutes); // 🎯 Opportunity Engine
app.use('/api/heatmap', heatmapRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/sentiment', sentimentRoutes);
app.use('/api/portfolio', portfolioHistoryRoutes);
app.use('/api/portfolio', aiInsightsRoutes);
app.use('/api/chart', chartRoutes);
app.use('/api/live-price', livePriceRoutes); // 📈 Live Price SSE Streaming
app.use('/api/calculators', calculatorRoutes); 
app.use('/api/paper-trading', paperTradingRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/gamification', onboardingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/patterns', patternRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api', statsRoutes);
app.use('/api/whale', whaleRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/public', publicStatsRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/posts', postRoutes); // ✅ NEW - Posts/Social Feed
app.use('/api/wallet', walletRoutes); // Wallet Connection
app.use('/api/brokerage', brokerageRoutes); // Brokerage Connections (Kraken, Plaid)
app.use('/api/2fa', twoFactorRoutes); // Two-Factor Authentication
app.use('/api/stripe', stripeRoutes); // 💳 Stripe Payments & Subscriptions
app.use('/api/earnings', earningsRoutes); // 📅 Earnings Calendar
app.use('/api/financials', financialsRoutes); // 📊 Company Financials
app.use('/api/market-reports', marketReportsRoutes); // 📈 AI Market Reports
app.use('/api/sector-rotation', sectorRotationRoutes); // 🔄 Sector Rotation
app.use('/api/economic-calendar', economicCalendarRoutes); // 📅 Economic Calendar
app.use('/api/indicators', technicalIndicatorsRoutes); // 📊 Technical Indicators
app.use('/api/telegram', telegramRoutes); // 📱 Telegram Bot Notifications
app.use('/api/discord', discordRoutes); // 🎮 Discord Bot Notifications
app.use('/api', backtestRoutes); // 📊 Strategy Backtesting (Elite) - mounts /backtest, /backtests
app.use('/api/transactions', transactionsRoutes); // 💰 Recent Transactions
app.use('/api/push', pushRoutes); // 🔔 Web Push Notifications

// ============================================
// ROUTES WITHOUT /api PREFIX 
// (For frontend components that call without /api)
// ============================================
app.use('/vault', vaultRoutes);
app.use('/predictions', predictionsRoutes);
app.use('/leaderboard', leaderboardRoutes);
app.use('/heatmap', heatmapRoutes);
app.use('/screener', screenerRoutes);
app.use('/public', publicStatsRoutes);
app.use('/posts', postRoutes);

// --- Error Logging Middleware ---
app.use(errorLogger);

// --- Global Error Handler ---
app.use((err, req, res, next) => {
    // Log error details prominently for debugging
    console.error(`[ERROR] ${req.method} ${req.path} - ${err.message}`);
    if (err.stack) console.error(err.stack);

    res.status(err.statusCode || 500).json({
        success: false,
        error: process.env.NODE_ENV === 'production'
            ? 'Server Error'
            : err.message || 'Server Error',
        requestId: req.requestId
    });
});

module.exports = app;
