
// server/models/BrokerageConnection.js - Brokerage Connection Model
const mongoose = require('mongoose');
const crypto = require('crypto');

// Encryption key from environment (should be 32 bytes for AES-256)
const ENCRYPTION_KEY = process.env.BROKERAGE_ENCRYPTION_KEY;
function encryptionKey() {
    if (!/^[a-fA-F0-9]{64}$/.test(ENCRYPTION_KEY || '')) {
        throw new Error('BROKERAGE_ENCRYPTION_KEY must be a persistent 32-byte hex key');
    }
    return Buffer.from(ENCRYPTION_KEY, 'hex');
}
if (process.env.NODE_ENV === 'production') encryptionKey();
const IV_LENGTH = 16;

/**
 * Encrypt sensitive data
 */
function encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = encryptionKey();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt sensitive data
 */
function decrypt(text) {
    if (!text) return null;
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const key = encryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

const brokerageConnectionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // Brokerage type
    type: {
        type: String,
        enum: ['kraken', 'robinhood', 'webull', 'schwab', 'plaid', 'manual'],
        required: true
    },
    // Display name for this connection
    name: {
        type: String,
        required: true
    },
    // Institution info (for Plaid connections)
    institution: {
        id: String,
        name: String,
        logo: String,
        primaryColor: String
    },
    // Encrypted credentials for direct API (Kraken)
    credentials: {
        apiKey: String,      // Encrypted
        apiSecret: String    // Encrypted
    },
    // Plaid-specific fields
    plaid: {
        accessToken: String, // Encrypted
        itemId: String
    },
    // Connection status
    status: {
        type: String,
        enum: ['active', 'error', 'disconnected', 'pending'],
        default: 'pending'
    },
    // Last error message
    lastError: String,
    // Last sync time
    lastSync: Date,
    // Cached portfolio data (using Mixed for flexibility)
    cachedPortfolio: {
        type: mongoose.Schema.Types.Mixed,
        default: { holdings: [], totalValue: 0, lastUpdated: null }
    }
}, {
    timestamps: true
});

// Index for user queries
brokerageConnectionSchema.index({ user: 1, type: 1 });

// Encrypt credentials before saving
brokerageConnectionSchema.pre('save', function(next) {
    // Encrypt API credentials
    if (this.isModified('credentials.apiKey') && this.credentials?.apiKey) {
        if (!this.credentials.apiKey.includes(':')) {
            this.credentials.apiKey = encrypt(this.credentials.apiKey);
        }
    }
    if (this.isModified('credentials.apiSecret') && this.credentials?.apiSecret) {
        if (!this.credentials.apiSecret.includes(':')) {
            this.credentials.apiSecret = encrypt(this.credentials.apiSecret);
        }
    }

    // Encrypt Plaid access token
    if (this.isModified('plaid.accessToken') && this.plaid?.accessToken) {
        if (!this.plaid.accessToken.includes(':')) {
            this.plaid.accessToken = encrypt(this.plaid.accessToken);
        }
    }

    next();
});

// Methods to get decrypted credentials
brokerageConnectionSchema.methods.getApiKey = function() {
    return decrypt(this.credentials?.apiKey);
};

brokerageConnectionSchema.methods.getApiSecret = function() {
    return decrypt(this.credentials?.apiSecret);
};

brokerageConnectionSchema.methods.getPlaidAccessToken = function() {
    return decrypt(this.plaid?.accessToken);
};

// Virtual for connection age
brokerageConnectionSchema.virtual('connectionAge').get(function() {
    return Date.now() - this.createdAt;
});

// Method to update cached portfolio
brokerageConnectionSchema.methods.updateCache = async function(portfolioData) {
    this.cachedPortfolio = {
        holdings: portfolioData.holdings || [],
        totalValue: portfolioData.totalValue || 0,
        lastUpdated: new Date()
    };
    this.lastSync = new Date();
    this.status = 'active';
    this.lastError = null;
    await this.save();
};

// Method to set error state
brokerageConnectionSchema.methods.setError = async function(errorMessage) {
    this.status = 'error';
    this.lastError = errorMessage;
    await this.save();
};

// Static method to get all connections for a user
brokerageConnectionSchema.statics.getByUser = function(userId) {
    return this.find({ user: userId }).sort({ createdAt: -1 });
};

// Static method to get active connections for a user
brokerageConnectionSchema.statics.getActiveByUser = function(userId) {
    return this.find({ user: userId, status: 'active' }).sort({ createdAt: -1 });
};

const BrokerageConnection = mongoose.model('BrokerageConnection', brokerageConnectionSchema);

module.exports = BrokerageConnection;
