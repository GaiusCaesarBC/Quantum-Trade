const { verifyAccessToken } = require('../utils/authTokens');
// server/routes/postRoutes.js - Social Posts/Feed Routes

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/authMiddleware');

// Use existing Post model
const Post = require('../models/Post');

// Rate limiter for social interactions (reactions, bookmarks, comments)
const socialInteractionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 interactions per minute
    message: { error: 'Too many interactions, please slow down' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter for general post operations
const postLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute
    message: { error: 'Too many requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false
});

// @route   GET /api/posts
// @desc    Get social feed posts
// @access  Public (with optional auth for like status)
router.get('/', postLimiter, async (req, res) => {
    try {
        const { limit = 10, skip = 0, type } = req.query;
        
        // Use visibility field (not isPublic) - matches Post model
        const query = { 
            visibility: 'public',
            deleted: { $ne: true }
        };
        if (type) {
            query.type = type;
        }

        const posts = await Post.find(query)
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .populate('user', 'username profile gamification')
            .populate('comments.user', 'username profile')
            .lean();

        // Try to get user ID from token if provided (optional auth)
        let userId = null;
        try {
            const token = req.header('Authorization')?.replace('Bearer ', '') || req.header('x-auth-token');
            if (token) {
                const jwt = require('jsonwebtoken');
                const decoded = verifyAccessToken(token);
                userId = decoded.user?.id || decoded.id;
            }
        } catch (e) { /* No valid token, that's fine */ }

        // Add reaction/bookmark status for current user (if authenticated)
        const postsWithStatus = posts.map(post => {
            // Get user's reaction
            let userReaction = null;
            if (userId && post.reactions) {
                for (const [type, users] of Object.entries(post.reactions)) {
                    if (users?.some(id => id.toString() === userId)) {
                        userReaction = type;
                        break;
                    }
                }
            }

            // Calculate reaction counts
            const reactionCounts = post.reactions ? {
                like: post.reactions.like?.length || 0,
                rocket: post.reactions.rocket?.length || 0,
                fire: post.reactions.fire?.length || 0,
                diamond: post.reactions.diamond?.length || 0,
                bull: post.reactions.bull?.length || 0,
                bear: post.reactions.bear?.length || 0,
                money: post.reactions.money?.length || 0
            } : { like: post.likesCount || 0 };

            return {
                ...post,
                isLiked: userId ? post.likes?.some(id => id.toString() === userId) : false,
                userReaction,
                reactionCounts,
                totalReactions: Object.values(reactionCounts).reduce((a, b) => a + b, 0),
                isBookmarked: userId ? post.bookmarkedBy?.some(id => id.toString() === userId) : false,
                bookmarkCount: post.bookmarkedBy?.length || 0
            };
        });

        res.json({
            success: true,
            posts: postsWithStatus,
            hasMore: posts.length === parseInt(limit)
        });
    } catch (error) {
        console.error('[Posts] Get feed error:', error);
        res.status(500).json({ error: 'Failed to get posts' });
    }
});

// @route   POST /api/posts
// @desc    Create a new post
// @access  Private
router.post('/', postLimiter, auth, async (req, res) => {
    try {
        const { content, type = 'text', metadata } = req.body;

        if (!content || content.trim().length === 0) {
            return res.status(400).json({ error: 'Content is required' });
        }

        if (content.length > 500) {
            return res.status(400).json({ error: 'Content too long (max 500 characters)' });
        }

        const post = new Post({
            user: req.user.id,
            content: content.trim(),
            type,
            visibility: 'public',
            metadata: metadata || {}
        });

        await post.save();
        
        // Populate user info for response
        await post.populate('user', 'username profile.displayName profile.avatar');

        console.log(`[Posts] User ${req.user.id} created ${type} post`);

        res.status(201).json({
            success: true,
            post
        });
    } catch (error) {
        console.error('[Posts] Create error:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

// @route   POST /api/posts/:id/like
// @desc    Like/Unlike a post
// @access  Private
router.post('/:id/like', socialInteractionLimiter, auth, async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const userId = req.user.id;
        const alreadyLiked = post.likes.some(id => id.toString() === userId);

        if (alreadyLiked) {
            // Unlike
            post.likes = post.likes.filter(id => id.toString() !== userId);
            post.likesCount = Math.max(0, post.likesCount - 1);
        } else {
            // Like
            post.likes.push(userId);
            post.likesCount += 1;
        }

        await post.save();

        res.json({
            success: true,
            liked: !alreadyLiked,
            likesCount: post.likesCount
        });
    } catch (error) {
        console.error('[Posts] Like error:', error);
        res.status(500).json({ error: 'Failed to like post' });
    }
});

// @route   POST /api/posts/:id/comment
// @desc    Add a comment to a post
// @access  Private
router.post('/:id/comment', socialInteractionLimiter, auth, async (req, res) => {
    try {
        const { content } = req.body;

        if (!content || content.trim().length === 0) {
            return res.status(400).json({ error: 'Comment content is required' });
        }

        if (content.length > 200) {
            return res.status(400).json({ error: 'Comment too long (max 200 characters)' });
        }

        const post = await Post.findById(req.params.id);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        post.comments.push({
            user: req.user.id,
            content: content.trim()
        });
        post.commentsCount += 1;

        await post.save();

        // Get the newly added comment with user info
        await post.populate('comments.user', 'username profile.displayName profile.avatar');
        const newComment = post.comments[post.comments.length - 1];

        res.json({
            success: true,
            comment: newComment,
            commentsCount: post.commentsCount
        });
    } catch (error) {
        console.error('[Posts] Comment error:', error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// @route   POST /api/posts/:id/react
// @desc    Add/remove a reaction to a post
// @access  Private
router.post('/:id/react', socialInteractionLimiter, auth, async (req, res) => {
    try {
        const { reaction } = req.body;
        const validReactions = ['like', 'rocket', 'fire', 'diamond', 'bull', 'bear', 'money'];

        if (!reaction || !validReactions.includes(reaction)) {
            return res.status(400).json({ error: 'Invalid reaction type' });
        }

        const post = await Post.findById(req.params.id);

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const userId = req.user.id;

        // Initialize reactions if not exists
        if (!post.reactions) {
            post.reactions = { like: [], rocket: [], fire: [], diamond: [], bull: [], bear: [], money: [] };
        }

        // Check if user already has this reaction
        const hasReaction = post.reactions[reaction]?.some(id => id.toString() === userId);

        // Remove user from all reactions first (can only have one reaction per post)
        for (const type of validReactions) {
            if (post.reactions[type]) {
                post.reactions[type] = post.reactions[type].filter(id => id.toString() !== userId);
            }
        }

        let added = false;
        if (!hasReaction) {
            // Add the new reaction
            post.reactions[reaction].push(userId);
            added = true;
        }

        // Update legacy likes count for compatibility
        post.likesCount = post.reactions.like?.length || 0;

        await post.save();

        // Calculate reaction counts
        const reactionCounts = {};
        for (const type of validReactions) {
            reactionCounts[type] = post.reactions[type]?.length || 0;
        }

        res.json({
            success: true,
            added,
            reaction: added ? reaction : null,
            reactionCounts,
            totalReactions: Object.values(reactionCounts).reduce((a, b) => a + b, 0)
        });
    } catch (error) {
        console.error('[Posts] React error:', error);
        res.status(500).json({ error: 'Failed to react to post' });
    }
});

// @route   POST /api/posts/:id/bookmark
// @desc    Bookmark/unbookmark a post
// @access  Private
router.post('/:id/bookmark', socialInteractionLimiter, auth, async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const userId = req.user.id;

        // Initialize bookmarkedBy if not exists
        if (!post.bookmarkedBy) {
            post.bookmarkedBy = [];
        }

        const isBookmarked = post.bookmarkedBy.some(id => id.toString() === userId);

        if (isBookmarked) {
            // Remove bookmark
            post.bookmarkedBy = post.bookmarkedBy.filter(id => id.toString() !== userId);
        } else {
            // Add bookmark
            post.bookmarkedBy.push(userId);
        }

        await post.save();

        res.json({
            success: true,
            bookmarked: !isBookmarked,
            bookmarkCount: post.bookmarkedBy.length
        });
    } catch (error) {
        console.error('[Posts] Bookmark error:', error);
        res.status(500).json({ error: 'Failed to bookmark post' });
    }
});

// @route   GET /api/posts/bookmarks
// @desc    Get user's bookmarked posts
// @access  Private
router.get('/bookmarks', socialInteractionLimiter, auth, async (req, res) => {
    try {
        const { limit = 10, skip = 0 } = req.query;

        const posts = await Post.find({
            bookmarkedBy: req.user.id,
            deleted: { $ne: true }
        })
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .populate('user', 'username profile gamification')
            .lean();

        // Add bookmark status
        const postsWithStatus = posts.map(post => ({
            ...post,
            isBookmarked: true,
            userReaction: post.reactions ?
                Object.keys(post.reactions).find(type =>
                    post.reactions[type]?.some(id => id.toString() === req.user.id)
                ) : null
        }));

        res.json({
            success: true,
            posts: postsWithStatus,
            hasMore: posts.length === parseInt(limit)
        });
    } catch (error) {
        console.error('[Posts] Get bookmarks error:', error);
        res.status(500).json({ error: 'Failed to get bookmarks' });
    }
});

// @route   DELETE /api/posts/:id
// @desc    Delete a post
// @access  Private (owner only)
router.delete('/:id', postLimiter, auth, async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (post.user.toString() !== req.user.id) {
            return res.status(403).json({ error: 'Not authorized to delete this post' });
        }

        await post.deleteOne();

        res.json({
            success: true,
            message: 'Post deleted'
        });
    } catch (error) {
        console.error('[Posts] Delete error:', error);
        res.status(500).json({ error: 'Failed to delete post' });
    }
});

// @route   GET /api/posts/detail/:id
// @desc    Get a single post by ID
// @access  Public (with optional auth for like/bookmark status)
router.get('/detail/:id', postLimiter, async (req, res) => {
    try {
        const post = await Post.findById(req.params.id)
            .populate('user', 'username profile gamification')
            .populate('comments.user', 'username profile')
            .lean();

        if (!post || post.deleted) {
            return res.status(404).json({ error: 'Post not found' });
        }

        res.json(post);
    } catch (error) {
        console.error('[Posts] Get by ID error:', error.message);
        res.status(500).json({ error: 'Failed to fetch post' });
    }
});

// @route   GET /api/posts/user/:userId
// @desc    Get posts by a specific user
// @access  Private
router.get('/user/:userId', postLimiter, auth, async (req, res) => {
    try {
        const { limit = 10, skip = 0 } = req.query;
        
        const posts = await Post.find({ 
            user: req.params.userId,
            visibility: 'public',
            deleted: { $ne: true }
        })
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .populate('user', 'username profile.displayName profile.avatar')
            .lean();

        res.json({
            success: true,
            posts,
            hasMore: posts.length === parseInt(limit)
        });
    } catch (error) {
        console.error('[Posts] Get user posts error:', error);
        res.status(500).json({ error: 'Failed to get posts' });
    }
});

// @route   GET /api/posts/my
// @desc    Get current user's posts
// @access  Private
router.get('/my', postLimiter, auth, async (req, res) => {
    try {
        const { limit = 10, skip = 0 } = req.query;
        
        const posts = await Post.find({ user: req.user.id })
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .populate('user', 'username profile.displayName profile.avatar')
            .lean();

        res.json({
            success: true,
            posts,
            hasMore: posts.length === parseInt(limit)
        });
    } catch (error) {
        console.error('[Posts] Get my posts error:', error);
        res.status(500).json({ error: 'Failed to get posts' });
    }
});

module.exports = router;