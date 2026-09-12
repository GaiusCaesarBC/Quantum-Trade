// server/models/Prediction.js - Track AI Predictions and Accuracy
// UPDATED: Flexible indicators schema + shared prediction tracking

const mongoose = require('mongoose');

const PredictionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false,
        default: null,
        index: true
    },
    symbol: {
        type: String,
        required: true,
        uppercase: true,
        index: true
    },
    assetType: {
        type: String,
        enum: ['stock', 'crypto', 'dex'],
        default: 'stock'
    },
    // DEX token specific info
    dexInfo: {
        network: String,      // 'bsc', 'eth', 'solana', etc.
        poolAddress: String,  // GeckoTerminal pool address
        contractAddress: String // Token contract address
    },
    // Prediction data at time of creation
    currentPrice: {
        type: Number,
        required: true
    },
    targetPrice: {
        type: Number,
        required: true
    },

    // ═══════════════════════════════════════════════════════════
    // LOCKED TRADING LEVELS - Set at creation, NEVER change
    // These are the actual trade entry/exit points users should follow
    // ═══════════════════════════════════════════════════════════
    entryPrice: {
        type: Number,
        default: null  // Locked at signal creation
    },
    stopLoss: {
        type: Number,
        default: null  // Locked at signal creation
    },
    takeProfit1: {
        type: Number,
        default: null  // Conservative target (40% of range)
    },
    takeProfit2: {
        type: Number,
        default: null  // Main target (100% of range = targetPrice)
    },
    takeProfit3: {
        type: Number,
        default: null  // Extended target (150% of range)
    },

    // Live price tracking (this one DOES update)
    livePrice: {
        type: Number,
        default: null
    },
    livePriceUpdatedAt: {
        type: Date,
        default: null
    },

    // ═══════════════════════════════════════════════════════════
    // TRADE RESULT - Set when signal closes (hits TP or SL)
    // ═══════════════════════════════════════════════════════════
    result: {
        type: String,
        enum: ['win', 'loss', null],
        default: null
    },
    resultText: {
        type: String,  // 'TP1 Hit', 'TP2 Hit', 'TP3 Hit', 'SL Hit', 'Expired'
        default: null
    },
    resultPrice: {
        type: Number,  // Price when result was determined
        default: null
    },
    resultAt: {
        type: Date,    // When the result was recorded
        default: null
    },

    direction: {
        type: String,
        enum: ['UP', 'DOWN', 'NEUTRAL'],
        required: true
    },
    // Signal strength from ML model
    signalStrength: {
        type: String,
        enum: ['strong', 'moderate', 'weak'],
        default: 'moderate'
    },
    isActionable: {
        type: Boolean,
        default: true
    },
    priceChange: {
        type: Number,
        required: true
    },
    priceChangePercent: {
        type: Number,
        required: true
    },
    confidence: {
        type: Number,
        required: true,
        min: 0,
        max: 100
    },
    timeframe: {
        type: Number, // Number of days
        required: true,
        default: 7
    },
    
    // ✅ FLEXIBLE INDICATORS SCHEMA - accepts any indicator format
    // Format: { "RSI": { value: 45.2, signal: "BUY" }, "MACD": { value: 1.5, signal: "SELL" }, ... }
    indicators: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    
    // Analysis message
    analysis: {
        trend: String,
        volatility: String,
        riskLevel: String,
        message: String
    },
    
    // Timestamps
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    expiresAt: {
        type: Date,
        required: true,
        index: true
    },
    
    // Outcome tracking
    outcome: {
        actualPrice: Number,
        actualChange: Number,
        actualChangePercent: Number,
        wasCorrect: Boolean,
        accuracy: Number, // How close was the prediction (%)
        checkedAt: Date
    },
    status: {
        type: String,
        enum: ['pending', 'correct', 'incorrect', 'expired'],
        default: 'pending',
        index: true
    },
    
    // ✅ TTL CLEANUP: Set this field to auto-delete the document at that time
    // For invalid predictions, set to 24 hours from creation
    // For completed predictions, can optionally set to 30 days after expiry
    deleteAfter: {
        type: Date,
        default: null // null = never auto-delete
    },
    
    // ✅ SHARED PREDICTION TRACKING
    viewers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    viewCount: {
        type: Number,
        default: 1
    },
    
    // For social features
    isPublic: {
        type: Boolean,
        default: true
    },
    // X (Twitter) posting state
    xPosted: { type: Boolean, default: false },
    xPostedAt: { type: Date, default: null },
    xPostId: { type: String, default: null },
    xResultPosted: { type: Boolean, default: false },
    xResultPostedAt: { type: Date, default: null },
    xResultPostId: { type: String, default: null },
    likes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    likesCount: {
        type: Number,
        default: 0
    },
    comments: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        text: String,
        createdAt: { type: Date, default: Date.now }
    }]
});

// Compound indexes for common queries
PredictionSchema.index({ user: 1, createdAt: -1 });
PredictionSchema.index({ symbol: 1, createdAt: -1 });
PredictionSchema.index({ status: 1, expiresAt: 1 });
PredictionSchema.index({ user: 1, status: 1 });
// ✅ NEW: Index for finding active shared predictions
PredictionSchema.index({ symbol: 1, status: 1, expiresAt: 1 });
PredictionSchema.index({ viewCount: -1, createdAt: -1 });

// ✅ TTL Index: Auto-delete expired predictions after 24 hours
// This will automatically remove documents where:
// - status is 'expired' AND deleteAfter has passed
PredictionSchema.index({ deleteAfter: 1 }, { expireAfterSeconds: 0 });

// ═══════════════════════════════════════════════════════════
// PRE-SAVE VALIDATION - Prevent garbage SL/TP values
// ═══════════════════════════════════════════════════════════
PredictionSchema.pre('save', function(next) {
    // Only validate if we have trading levels set
    if (this.entryPrice && this.stopLoss) {
        const entry = this.entryPrice;
        const sl = this.stopLoss;
        const tp1 = this.takeProfit1;
        const tp2 = this.takeProfit2;
        const tp3 = this.takeProfit3;
        const isLong = this.direction === 'UP';

        // 1. All prices must be positive
        if (entry <= 0 || sl <= 0) {
            return next(new Error(`Invalid prices: entry=${entry}, sl=${sl}`));
        }
        if ((tp1 && tp1 <= 0) || (tp2 && tp2 <= 0) || (tp3 && tp3 <= 0)) {
            return next(new Error(`Negative take profit values: tp1=${tp1}, tp2=${tp2}, tp3=${tp3}`));
        }

        // 2. SL must be within 20% of entry (sanity check)
        const slDistance = Math.abs(sl - entry) / entry;
        if (slDistance > 0.20) {
            return next(new Error(`Stop loss too far from entry: ${(slDistance * 100).toFixed(1)}% (max 20%)`));
        }

        // 3. Direction sanity: LONG = SL below entry, SHORT = SL above entry
        if (isLong && sl >= entry) {
            return next(new Error(`LONG signal but SL (${sl}) >= entry (${entry})`));
        }
        if (!isLong && sl <= entry) {
            return next(new Error(`SHORT signal but SL (${sl}) <= entry (${entry})`));
        }

        // 4. TP order sanity: LONG = TPs above entry, SHORT = TPs below entry
        if (isLong) {
            if ((tp1 && tp1 <= entry) || (tp2 && tp2 <= entry) || (tp3 && tp3 <= entry)) {
                return next(new Error(`LONG signal but TP below entry`));
            }
        } else {
            if ((tp1 && tp1 >= entry) || (tp2 && tp2 >= entry) || (tp3 && tp3 >= entry)) {
                return next(new Error(`SHORT signal but TP above entry`));
            }
        }
    }

    next();
});

// Method to check if prediction has expired
PredictionSchema.methods.isExpired = function() {
    return Date.now() > this.expiresAt;
};

// Method to calculate outcome
PredictionSchema.methods.calculateOutcome = async function(currentPrice) {
    if (this.status !== 'pending' || !this.user) {
        return; // Already checked
    }

    const actualChange = currentPrice - this.currentPrice;
    // Prevent division by zero
    const actualChangePercent = this.currentPrice > 0
        ? ((currentPrice - this.currentPrice) / this.currentPrice) * 100
        : 0;

    // Determine if prediction was correct
    let wasCorrect = false;
    if (this.direction === 'UP' && actualChange > 0) {
        wasCorrect = true;
    } else if (this.direction === 'DOWN' && actualChange < 0) {
        wasCorrect = true;
    }

    // Calculate accuracy (how close to the predicted price)
    // FIXED: Handle cases where price overshoots target (should be 100%+, not 0%)
    const targetMovement = this.targetPrice - this.currentPrice; // Expected movement
    const actualMovement = currentPrice - this.currentPrice;     // Actual movement
    
    let accuracy = 0;
    
    if (Math.abs(targetMovement) > 0) {
        if (this.direction === 'UP') {
            if (actualMovement >= targetMovement) {
                // Price met or exceeded target - 100% accurate (or more)
                accuracy = 100;
            } else if (actualMovement > 0) {
                // Moving in right direction but hasn't reached target
                accuracy = (actualMovement / targetMovement) * 100;
            } else {
                // Moving in wrong direction
                accuracy = 0;
            }
        } else if (this.direction === 'DOWN') {
            if (actualMovement <= targetMovement) {
                // Price met or exceeded target (went down more than expected)
                accuracy = 100;
            } else if (actualMovement < 0) {
                // Moving in right direction but hasn't reached target
                accuracy = (actualMovement / targetMovement) * 100;
            } else {
                // Moving in wrong direction
                accuracy = 0;
            }
        }
    }

    this.outcome = {
        actualPrice: currentPrice,
        actualChange,
        actualChangePercent,
        wasCorrect,
        accuracy: Math.round(Math.min(100, Math.max(0, accuracy)) * 100) / 100,
        checkedAt: Date.now()
    };

    this.status = wasCorrect ? 'correct' : 'incorrect';
    
    await this.save();
    return this.outcome;
};

// Static method to get user's prediction accuracy
PredictionSchema.statics.getUserAccuracy = async function(userId) {
    const predictions = await this.find({
        user: userId,
        status: { $in: ['correct', 'incorrect'] }
    });

    if (predictions.length === 0) {
        return {
            totalPredictions: 0,
            correctPredictions: 0,
            accuracy: 0,
            avgConfidence: 0
        };
    }

    const correctPredictions = predictions.filter(p => p.status === 'correct').length;
    const accuracy = (correctPredictions / predictions.length) * 100;
    const avgConfidence = predictions.reduce((sum, p) => sum + p.confidence, 0) / predictions.length;

    return {
        totalPredictions: predictions.length,
        correctPredictions,
        accuracy: Math.round(accuracy * 100) / 100,
        avgConfidence: Math.round(avgConfidence * 100) / 100
    };
};

// Static method to get overall platform accuracy
// Only counts actionable predictions (excludes NEUTRAL and weak signals)
PredictionSchema.statics.getPlatformAccuracy = async function() {
    // Only count system signals (matches Live Signal Feed stats)
    const total = await this.countDocuments({ user: null, isPublic: true });
    const wins = await this.countDocuments({ user: null, isPublic: true, result: 'win' });
    const losses = await this.countDocuments({ user: null, isPublic: true, result: 'loss' });
    const closed = wins + losses;
    const accuracy = closed > 0 ? (wins / closed) * 100 : 0;

    return {
        totalPredictions: total,
        correctPredictions: wins,
        accuracy: Math.round(accuracy * 100) / 100
    };
};

// Static method to get trending predictions (most liked)
PredictionSchema.statics.getTrending = async function(limit = 10) {
    return this.find({ isPublic: true, status: 'pending' })
        .sort({ likesCount: -1, createdAt: -1 })
        .limit(limit)
        .populate('user', 'username profile.displayName profile.avatar');
};

// ✅ NEW: Get active shared predictions
PredictionSchema.statics.getActivePredictions = async function(limit = 20) {
    return this.find({ 
        status: 'pending',
        expiresAt: { $gt: new Date() }
    })
    .sort({ viewCount: -1, createdAt: -1 })
    .limit(limit)
    .populate('user', 'username profile.displayName profile.avatar');
};

// ✅ NEW: Find active prediction for symbol
PredictionSchema.statics.findActiveBySymbol = async function(symbol, timeframe = null) {
    const query = {
        symbol: symbol.toUpperCase(),
        status: 'pending',
        expiresAt: { $gt: new Date() }
    };
    
    if (timeframe) {
        query.timeframe = timeframe;
    }
    
    return this.findOne(query).sort({ createdAt: -1 });
};

module.exports = mongoose.model('Prediction', PredictionSchema);