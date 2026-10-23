import mongoose from 'mongoose';
import { Match } from '../models/Match.js';
import { User } from '../models/User.js';
import { Profile } from '../models/Profile.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { MATCH_STATUS, SWIPE_ACTION, HTTP_STATUS } from '../constants/index.js';
import { emitToUser } from '../sockets/index.js';
import { CacheService } from '../services/cache.service.js';


export const swipeUser = asyncHandler(async (req, res) => {
  const senderId = req.user._id;
  const { receiverId, action } = req.body;

  if (senderId.toString() === receiverId?.toString()) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'You cannot swipe on yourself');
  }

  const sender = await User.findById(senderId);
  if (!sender) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Sender user not found');
  }

  // 1. Check daily swipe limit if user does not have unlimited swipes
  const perks = sender.subscription?.perks || {};
  const isUnlimitedSwipes = Boolean(perks.unlimitedSwipes);
  const dailySwipeLimit = perks.dailySwipeLimit !== undefined ? perks.dailySwipeLimit : 50;

  if (!isUnlimitedSwipes) {
    const now = new Date();
    const lastReset = sender.subscription?.lastSwipeResetAt
      ? new Date(sender.subscription.lastSwipeResetAt)
      : new Date(0);
    const isNewDay = now.toDateString() !== lastReset.toDateString();

    if (isNewDay) {
      sender.subscription.swipesUsedToday = 0;
      sender.subscription.lastSwipeResetAt = now;
    }

    const usedToday = sender.subscription.swipesUsedToday || 0;
    if (usedToday >= dailySwipeLimit) {
      throw new ApiError(
        HTTP_STATUS.TOO_MANY_REQUESTS,
        `Daily swipe limit of ${dailySwipeLimit} reached. Upgrade your plan for unlimited swipes or check back tomorrow!`
      );
    }

    sender.subscription.swipesUsedToday = usedToday + 1;
  }

  // 2. If action is SUPERLIKE, verify credit balance and deduct credit
  if (action === SWIPE_ACTION.SUPERLIKE) {
    const availableSuperLikes = sender.subscription?.superLikesRemaining || 0;
    if (availableSuperLikes <= 0) {
      throw new ApiError(
        HTTP_STATUS.BAD_REQUEST,
        'You have 0 Super Likes remaining. Please purchase a Super Likes pack from Add-ons or upgrade your membership.'
      );
    }

    // Deduct from planSuperLikesRemaining first, then addonSuperLikesRemaining
    if ((sender.subscription.planSuperLikesRemaining || 0) > 0) {
      sender.subscription.planSuperLikesRemaining -= 1;
    } else {
      sender.subscription.addonSuperLikesRemaining = Math.max(
        0,
        (sender.subscription.addonSuperLikesRemaining || 0) - 1
      );
    }
    sender.subscription.superLikesRemaining =
      (sender.subscription.planSuperLikesRemaining || 0) +
      (sender.subscription.addonSuperLikesRemaining || 0);

    // Real-time socket event to update client balance
    emitToUser(senderId.toString(), 'superlike_used', {
      superLikesRemaining: sender.subscription.superLikesRemaining,
      planSuperLikesRemaining: sender.subscription.planSuperLikesRemaining,
      addonSuperLikesRemaining: sender.subscription.addonSuperLikesRemaining,
      receiverId,
      timestamp: new Date().toISOString()
    });
  }

  await sender.save();

  emitToUser(senderId.toString(), 'membership_updated', {
    subscription: sender.subscription,
    swipesUsedToday: sender.subscription.swipesUsedToday,
    swipesRemainingToday: isUnlimitedSwipes
      ? 'unlimited'
      : Math.max(0, dailySwipeLimit - (sender.subscription.swipesUsedToday || 0)),
    dailySwipeLimit: isUnlimitedSwipes ? null : dailySwipeLimit,
    timestamp: new Date().toISOString()
  });

  // Check if target user has already liked sender
  const reverseMatch = await Match.findOne({
    sender: receiverId,
    receiver: senderId,
    action: { $in: [SWIPE_ACTION.LIKE, SWIPE_ACTION.SUPERLIKE] }
  });

  const isMutual = !!reverseMatch && (action === SWIPE_ACTION.LIKE || action === SWIPE_ACTION.SUPERLIKE);

  // Upsert or create swipe record
  const match = await Match.findOneAndUpdate(
    { sender: senderId, receiver: receiverId },
    {
      $set: {
        action,
        status: isMutual ? MATCH_STATUS.ACCEPTED : MATCH_STATUS.PENDING,
        isMutualMatch: isMutual
      }
    },
    { new: true, upsert: true }
  );

  let conversation = null;
  let senderProfile = null;
  let receiverProfile = null;

  // If mutual match, update the reverse match record and initialize a conversation
  if (isMutual) {
    reverseMatch.status = MATCH_STATUS.ACCEPTED;
    reverseMatch.isMutualMatch = true;
    await reverseMatch.save();

    // Create or find conversation
        // Create or find conversation safely without MongoDB findAndModify $all conflicts
    conversation = await Conversation.findOne({
      participants: { $all: [senderId, receiverId] }
    }).populate('participants', 'fullName email isVerified lastActive');

    if (!conversation) {
      const createdConv = await Conversation.create({
        participants: [senderId, receiverId]
      });
      conversation = await Conversation.findById(createdConv._id).populate('participants', 'fullName email isVerified lastActive');
    }

    // Fetch user details and profiles for real-time match presentation
    const [senderUser, receiverUser, sProf, rProf] = await Promise.all([
      User.findById(senderId).select('fullName email isVerified lastActive avatar photo'),
      User.findById(receiverId).select('fullName email isVerified lastActive avatar photo'),
      Profile.findOne({ user: senderId }).populate('user', 'fullName email isVerified lastActive'),
      Profile.findOne({ user: receiverId }).populate('user', 'fullName email isVerified lastActive')
    ]);
    senderProfile = sProf;
    receiverProfile = rProf;

    const senderName = senderUser?.fullName || senderProfile?.fullName || senderProfile?.firstName || 'User';
    const receiverName = receiverUser?.fullName || receiverProfile?.fullName || receiverProfile?.firstName || 'User';
    const senderPhoto = senderProfile?.photos?.[0]?.url || senderProfile?.photos?.[0] || senderProfile?.avatar || senderUser?.avatar || senderUser?.photo || '';
    const receiverPhoto = receiverProfile?.photos?.[0]?.url || receiverProfile?.photos?.[0] || receiverProfile?.avatar || receiverUser?.avatar || receiverUser?.photo || '';

    // Real-time socket event emission to both users with rich profile data
    const matchDataForSender = {
      match,
      partner: receiverProfile || { user: receiverUser || { _id: receiverId, fullName: receiverName } },
      partnerProfile: receiverProfile,
      userName: receiverName,
      userAvatar: receiverPhoto,
      partnerUserId: receiverId,
      conversation,
      isMutualMatch: true,
      matchedAt: new Date()
    };

    const matchDataForReceiver = {
      match: reverseMatch,
      partner: senderProfile || { user: senderUser || { _id: senderId, fullName: senderName } },
      partnerProfile: senderProfile,
      userName: senderName,
      userAvatar: senderPhoto,
      partnerUserId: senderId,
      conversation,
      isMutualMatch: true,
      matchedAt: new Date()
    };

    // 1. Emit mutual match popup event to both users
    emitToUser(senderId, 'new_match', matchDataForSender);
    emitToUser(receiverId, 'new_match', matchDataForReceiver);

    // 2. Emit recent matches list update event so matches carousel updates live
    emitToUser(senderId, 'recent_matches_updated', matchDataForSender);
    emitToUser(receiverId, 'recent_matches_updated', matchDataForReceiver);

    // 3. Emit new conversation to both users so chat tab updates live
    emitToUser(senderId, 'new_conversation', conversation);
    emitToUser(receiverId, 'new_conversation', conversation);
  } else if (action === SWIPE_ACTION.LIKE || action === SWIPE_ACTION.SUPERLIKE) {
    // Notify receiver about a new incoming like/superlike in real time
    emitToUser(receiverId, 'swipe_received', {
      senderId,
      action,
      createdAt: new Date()
    });
  }

  // Invalidate feed, see-who-likes, match list, and conversation caches for both users in Redis/Memory
  await Promise.all([
    CacheService.delByPattern(`feed:${senderId}:*`),
    CacheService.delByPattern(`see_who_likes:${senderId}:*`),
    CacheService.delByPattern(`see_who_likes:${receiverId}:*`),
    CacheService.del(`matches:${senderId}`),
    CacheService.del(`matches:${receiverId}`),
    CacheService.del(`conversations:${senderId}`),
    CacheService.delByPattern(`conversations:${senderId}*`),
    CacheService.del(`conversations:${receiverId}`),
    CacheService.delByPattern(`conversations:${receiverId}*`)
  ]);

  const remainingToday = isUnlimitedSwipes
    ? 'unlimited'
    : Math.max(0, dailySwipeLimit - (sender.subscription?.swipesUsedToday || 0));

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        match,
        isMutualMatch: isMutual,
        conversation,
        partnerProfile: isMutual ? receiverProfile : null,
        superLikesRemaining: sender.subscription?.superLikesRemaining,
        swipesUsedToday: sender.subscription?.swipesUsedToday,
        swipesRemainingToday: remainingToday,
        dailySwipeLimit: isUnlimitedSwipes ? null : dailySwipeLimit,
        unlimitedSwipes: isUnlimitedSwipes
      },
      isMutual ? "It's a Match! 🎉" : 'Swipe recorded'
    )
  );
});

export const getMatches = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const cacheKey = `matches:${userId}`;

  const enrichedMatches = await CacheService.remember(cacheKey, 60, async () => {
    const matches = await Match.find({
      $or: [{ sender: userId }, { receiver: userId }],
      isMutualMatch: true,
      status: MATCH_STATUS.ACCEPTED
    })
      .populate('sender', 'fullName email isVerified lastActive')
      .populate('receiver', 'fullName email isVerified lastActive')
      .sort({ updatedAt: -1 });

    // Filter out corrupted/orphaned matches where sender or receiver was deleted
    const validMatches = matches.filter((m) => m.sender && m.receiver);

    // Asynchronously cleanup any orphaned matches so they don't corrupt DB
    const orphanMatches = matches.filter((m) => !m.sender || !m.receiver);
    if (orphanMatches.length > 0) {
      Match.deleteMany({ _id: { $in: orphanMatches.map((m) => m._id) } }).catch((e) => {
        console.error('Error cleaning orphan matches:', e.message);
      });
    }

    // Extract all matched partner user IDs to attach profiles
    const partnerUserIds = validMatches
      .map((m) => {
        const sId = m.sender?._id ? m.sender._id.toString() : m.sender?.toString();
        const isSender = sId === userId.toString();
        const partner = isSender ? m.receiver : m.sender;
        return partner?._id || partner;
      })
      .filter(Boolean);

    const profiles = await Profile.find({ user: { $in: partnerUserIds } }).populate(
      'user',
      'fullName email isVerified lastActive'
    );

    const profileMap = new Map();
    profiles.forEach((p) => {
      const pUserId = p.user?._id ? p.user._id.toString() : p.user?.toString();
      if (pUserId) {
        profileMap.set(pUserId, p);
      }
    });

    return validMatches
      .map((m) => {
        const sId = m.sender?._id ? m.sender._id.toString() : m.sender?.toString();
        const isSender = sId === userId.toString();
        const partner = isSender ? m.receiver : m.sender;
        const partnerIdStr = partner?._id ? partner._id.toString() : partner?.toString();
        const partnerProfile = partnerIdStr ? profileMap.get(partnerIdStr) || null : null;

        if (!partner) return null;

        return {
          _id: m._id,
          match: m,
          partner,
          partnerUserId: partnerIdStr,
          partnerProfile,
          matchedAt: m.updatedAt,
          isMutualMatch: m.isMutualMatch,
          action: m.action
        };
      })
      .filter(Boolean);
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, enrichedMatches, 'Matches retrieved successfully')
  );
});

export const getDiscoveryFeed = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const limit = parseInt(req.query.limit, 10) || 30;
  const page = parseInt(req.query.page, 10) || 1;
  const cacheKey = `feed:${userId}:${page}:${limit}`;

  const feed = await CacheService.remember(cacheKey, 120, async () => {
    // 1. Get current user profile to check preferences
    const userProfile = await Profile.findOne({ user: userId });

    // 2. Get all users that current user has already swiped on
    const swipedUserIds = await Match.find({ sender: userId }).distinct('receiver');
    const excludedUserIds = [userId, ...swipedUserIds];

    // 3. Build query based on preferences
    const query = {
      user: { $nin: excludedUserIds }
    };

    // Gender filter based on interestedIn preference
    if (userProfile?.interestedIn && userProfile.interestedIn.length > 0) {
      const genderFilters = [];
      if (userProfile.interestedIn.includes('men')) genderFilters.push('male');
      if (userProfile.interestedIn.includes('women')) genderFilters.push('female');
      if (userProfile.interestedIn.includes('everyone')) {
        genderFilters.push('male', 'female', 'other');
      }
      if (genderFilters.length > 0) {
        query.gender = { $in: genderFilters };
      }
    }

    // 4. Housekeeping: Expire any active boosts whose 24h window has ended
    await Profile.updateMany(
      { isBoosted: true, boostExpiresAt: { $lt: new Date() } },
      { $set: { isBoosted: false } }
    );

    // 5. Fetch incoming SuperLikes sent to this user (pending swipe from current user)
    const incomingSuperLikes = await Match.find({
      receiver: userId,
      action: SWIPE_ACTION.SUPERLIKE,
      status: MATCH_STATUS.PENDING
    }).select('sender createdAt');

    const superLikeMap = new Map();
    const superLikeUserIds = [];
    incomingSuperLikes.forEach((m) => {
      if (m.sender) {
        const sId = m.sender.toString();
        // Only if current user hasn't already swiped on them
        if (!excludedUserIds.some((ex) => ex.toString() === sId)) {
          superLikeMap.set(sId, m);
          superLikeUserIds.push(m.sender);
        }
      }
    });

    // 6. Fetch profiles with priority:
    // Priority 1: Users who SuperLiked current user
    // Priority 2: Actively Boosted profiles (isBoosted: true)
    // Priority 3: Regular profiles
    const skip = (page - 1) * limit;
    let profiles = [];

    if (superLikeUserIds.length > 0 && page === 1) {
      // Fetch incoming superlike profiles matching user preferences
      const superLikeProfiles = await Profile.find({
        ...query,
        user: { $in: superLikeUserIds }
      })
        .populate('user', 'fullName email isVerified lastActive isOnboarded')
        .sort({ isBoosted: -1, updatedAt: -1 });

      const remainingLimit = limit - superLikeProfiles.length;
      let otherProfiles = [];

      if (remainingLimit > 0) {
        otherProfiles = await Profile.find({
          ...query,
          user: { $nin: [...excludedUserIds, ...superLikeUserIds] }
        })
          .populate('user', 'fullName email isVerified lastActive isOnboarded')
          .sort({ isBoosted: -1, updatedAt: -1, createdAt: -1 })
          .limit(remainingLimit);
      }

      profiles = [...superLikeProfiles, ...otherProfiles];
    } else if (superLikeUserIds.length > 0 && page > 1) {
      const superLikeCount = await Profile.countDocuments({
        ...query,
        user: { $in: superLikeUserIds }
      });
      const adjustedSkip = Math.max(0, skip - superLikeCount);

      profiles = await Profile.find({
        ...query,
        user: { $nin: [...excludedUserIds, ...superLikeUserIds] }
      })
        .populate('user', 'fullName email isVerified lastActive isOnboarded')
        .sort({ isBoosted: -1, updatedAt: -1, createdAt: -1 })
        .skip(adjustedSkip)
        .limit(limit);
    } else {
      profiles = await Profile.find(query)
        .populate('user', 'fullName email isVerified lastActive isOnboarded')
        .sort({ isBoosted: -1, updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit);
    }

    // 7. Format profiles for frontend card stack
    return profiles
      .filter((p) => p.user) // Filter out any orphan profiles
      .map((p) => {
        // Calculate age from dateOfBirth or birthday
        let age = null;
        if (p.dateOfBirth) {
          const diff = Date.now() - new Date(p.dateOfBirth).getTime();
          age = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
        } else if (p.birthday?.year) {
          age = new Date().getFullYear() - p.birthday.year;
        }

        // Format primary photo
        const primaryPhoto =
          p.photos?.find((photo) => photo.isPrimary)?.url ||
          p.photos?.[0]?.url ||
          p.photos?.[0] ||
          '';

        const candidateUserId = p.user._id ? p.user._id.toString() : p.user.toString();
        const superLikeMatch = superLikeMap.get(candidateUserId);
        const hasSuperLiked = Boolean(superLikeMatch);

        const isCurrentlyBoosted = Boolean(
          p.isBoosted && p.boostExpiresAt && new Date(p.boostExpiresAt) > new Date()
        );

        // Determine feed mode / origin
        let mode = 'normal';
        if (hasSuperLiked && isCurrentlyBoosted) {
          mode = 'superlike_boost';
        } else if (hasSuperLiked) {
          mode = 'superlike';
        } else if (isCurrentlyBoosted) {
          mode = 'boost';
        }

        return {
          _id: p.user._id,
          userId: p.user._id,
          profileId: p._id,
          fullName: p.user.fullName || 'Member',
          age: age || 24,
          gender: p.gender,
          bio: p.bio || '',
          lookingFor: p.lookingFor || 'Relationship',
          interests: p.interests || [],
          religion: p.religion || '',
          education: p.education || '',
          city: p.location?.city || '',
          state: p.location?.state || '',
          distance: Math.floor(Math.random() * 15) + 2, // Approximate distance in km
          photos: p.photos || [],
          primaryPhoto,
          isVerified: p.user.isVerified || false,

          // Profile Boost mode indicators
          isBoosted: isCurrentlyBoosted,
          isBoost: isCurrentlyBoosted,
          boostMode: isCurrentlyBoosted,
          boostExpiresAt: isCurrentlyBoosted ? p.boostExpiresAt : null,

          // Superlike indicators
          isSuperLike: hasSuperLiked,
          hasSuperLiked: hasSuperLiked,
          isSuperLiked: hasSuperLiked,
          superLikedAt: superLikeMatch?.createdAt || null,

          // Composite / origin attributes
          mode,
          source: mode,
          feedSource: mode,
          isSuperLikeOrBoost: Boolean(hasSuperLiked || isCurrentlyBoosted),

          lastActive: p.user.lastActive
        };
      });
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, feed, 'Discovery feed retrieved successfully')
  );
});

/**
 * See Who Liked You Feed
 * Returns cards of users who sent LIKE or SUPERLIKE to current user.
 * Structure, fields, and functionality match getDiscoveryFeed exactly.
 */
export const getWhoLikedYouFeed = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const limit = parseInt(req.query.limit, 10) || 30;
  const page = parseInt(req.query.page, 10) || 1;
  const includeSwiped = req.query.includeSwiped === 'true' || req.query.all === 'true';
  const ignorePreferences = req.query.ignorePreferences === 'true' || req.query.allGenders === 'true';
  const actionFilter = req.query.action; // 'like' | 'superlike' | undefined

  const cacheKey = `see_who_likes:${userId}:${page}:${limit}:${includeSwiped}:${ignorePreferences}:${actionFilter || 'all'}`;

  const feed = await CacheService.remember(cacheKey, 60, async () => {
    // 1. Get current user profile to check preferences
    const userProfile = await Profile.findOne({ user: userId });

    // 2. Build gender filters if preferences apply
    let genderFilters = [];
    if (req.query.gender) {
      genderFilters = [req.query.gender];
    } else if (!ignorePreferences && userProfile?.interestedIn && userProfile.interestedIn.length > 0) {
      if (userProfile.interestedIn.includes('men')) genderFilters.push('male');
      if (userProfile.interestedIn.includes('women')) genderFilters.push('female');
      if (userProfile.interestedIn.includes('everyone')) {
        genderFilters.push('male', 'female', 'other');
      }
    }

    // 3. Housekeeping: Expire any active boosts whose 24h window has ended
    await Profile.updateMany(
      { isBoosted: true, boostExpiresAt: { $lt: new Date() } },
      { $set: { isBoosted: false } }
    );

    // 4. Determine excluded sender IDs (users already swiped on by current user, unless includeSwiped is true)
    let excludedSenderIds = [userId];
    if (!includeSwiped) {
      const swipedUserIds = await Match.find({ sender: userId }).distinct('receiver');
      excludedSenderIds = [...excludedSenderIds, ...swipedUserIds];
    }
    const excludedObjectIds = excludedSenderIds
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id.toString()));

    // 5. Actions to include (either filtered or default to both LIKE and SUPERLIKE)
    const validActions =
      actionFilter && Object.values(SWIPE_ACTION).includes(actionFilter)
        ? [actionFilter]
        : [SWIPE_ACTION.LIKE, SWIPE_ACTION.SUPERLIKE];

    // 6. Aggregation pipeline for efficient DB-level joining, filtering, prioritizing, and pagination
    const skip = (page - 1) * limit;
    const matchStage = {
      receiver: new mongoose.Types.ObjectId(userId.toString()),
      action: { $in: validActions },
      status: { $ne: MATCH_STATUS.BLOCKED },
      ...(excludedObjectIds.length > 0 ? { sender: { $nin: excludedObjectIds } } : {})
    };

    const pipeline = [
      { $match: matchStage },
      {
        $lookup: {
          from: 'profiles',
          localField: 'sender',
          foreignField: 'user',
          as: 'profile'
        }
      },
      { $unwind: '$profile' },
      {
        $lookup: {
          from: 'users',
          localField: 'sender',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' }
    ];

    if (genderFilters.length > 0) {
      pipeline.push({
        $match: { 'profile.gender': { $in: genderFilters } }
      });
    }

    // Sorting priorities:
    // Priority 1: SuperLikes (someone who SuperLiked current user)
    // Priority 2: Currently boosted profiles (isBoosted: true and boost active)
    // Priority 3: Most recently liked (createdAt: -1)
    pipeline.push(
      {
        $addFields: {
          isSuperLikeRank: {
            $cond: [{ $eq: ['$action', SWIPE_ACTION.SUPERLIKE] }, 1, 0]
          },
          isBoostedRank: {
            $cond: [
              {
                $and: [
                  { $eq: ['$profile.isBoosted', true] },
                  { $gt: ['$profile.boostExpiresAt', new Date()] }
                ]
              },
              1,
              0
            ]
          }
        }
      },
      {
        $sort: {
          isSuperLikeRank: -1,
          isBoostedRank: -1,
          createdAt: -1
        }
      },
      { $skip: skip },
      { $limit: limit }
    );

    const results = await Match.aggregate(pipeline);

    // 7. Format profiles matching getDiscoveryFeed schema exactly
    return results
      .filter((item) => item.user && item.profile)
      .map((item) => {
        const p = item.profile;
        const u = item.user;

        // Calculate age from dateOfBirth or birthday
        let age = null;
        if (p.dateOfBirth) {
          const diff = Date.now() - new Date(p.dateOfBirth).getTime();
          age = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
        } else if (p.birthday?.year) {
          age = new Date().getFullYear() - p.birthday.year;
        }

        // Format primary photo
        const primaryPhoto =
          p.photos?.find((photo) => photo.isPrimary)?.url ||
          p.photos?.[0]?.url ||
          p.photos?.[0] ||
          '';

        const hasSuperLiked = item.action === SWIPE_ACTION.SUPERLIKE;
        const isCurrentlyBoosted = Boolean(
          p.isBoosted && p.boostExpiresAt && new Date(p.boostExpiresAt) > new Date()
        );

        // Determine feed mode / origin
        let mode = 'normal';
        if (hasSuperLiked && isCurrentlyBoosted) {
          mode = 'superlike_boost';
        } else if (hasSuperLiked) {
          mode = 'superlike';
        } else if (isCurrentlyBoosted) {
          mode = 'boost';
        }

        return {
          _id: u._id,
          userId: u._id,
          profileId: p._id,
          fullName: u.fullName || 'Member',
          age: age || 24,
          gender: p.gender,
          bio: p.bio || '',
          lookingFor: p.lookingFor || 'Relationship',
          interests: p.interests || [],
          religion: p.religion || '',
          education: p.education || '',
          city: p.location?.city || '',
          state: p.location?.state || '',
          distance: Math.floor(Math.random() * 15) + 2, // Approximate distance in km
          photos: p.photos || [],
          primaryPhoto,
          isVerified: u.isVerified || false,

          // Profile Boost mode indicators
          isBoosted: isCurrentlyBoosted,
          isBoost: isCurrentlyBoosted,
          boostMode: isCurrentlyBoosted,
          boostExpiresAt: isCurrentlyBoosted ? p.boostExpiresAt : null,

          // Superlike indicators
          isSuperLike: hasSuperLiked,
          hasSuperLiked: hasSuperLiked,
          isSuperLiked: hasSuperLiked,
          superLikedAt: hasSuperLiked ? item.createdAt : null,

          // Composite / origin attributes
          mode,
          source: mode,
          feedSource: mode,
          isSuperLikeOrBoost: Boolean(hasSuperLiked || isCurrentlyBoosted),

          // Who-liked-you specific attributes
          likedAt: item.createdAt,
          likeAction: item.action,
          swipeAction: item.action,
          matchId: item._id,
          likeStatus: item.status || MATCH_STATUS.PENDING,
          isMutualMatch: item.isMutualMatch || false,

          lastActive: u.lastActive
        };
      });
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, feed, 'Users who liked you retrieved successfully')
  );
});

/**
 * See Who Liked You Count
 * Returns total count of incoming pending likes (useful for badges / counters)
 */
export const getWhoLikedYouCount = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const includeSwiped = req.query.includeSwiped === 'true' || req.query.all === 'true';
  const actionFilter = req.query.action;

  let excludedSenderIds = [userId];
  if (!includeSwiped) {
    const swipedUserIds = await Match.find({ sender: userId }).distinct('receiver');
    excludedSenderIds = [...excludedSenderIds, ...swipedUserIds];
  }

  const validActions =
    actionFilter && Object.values(SWIPE_ACTION).includes(actionFilter)
      ? [actionFilter]
      : [SWIPE_ACTION.LIKE, SWIPE_ACTION.SUPERLIKE];

  const count = await Match.countDocuments({
    receiver: userId,
    action: { $in: validActions },
    status: { $ne: MATCH_STATUS.BLOCKED },
    sender: { $nin: excludedSenderIds }
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { count }, 'Likes count retrieved successfully')
  );
});


export const unmatchUser = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const targetId =
    req.params.id ||
    req.params.partnerId ||
    req.body.partnerId ||
    req.body.targetUserId ||
    req.body.userId ||
    req.body.matchId ||
    req.body.conversationId ||
    req.body.id;

  if (!targetId) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Partner ID or Match ID is required');
  }

  let partnerUserId = null;
  let matchRecord = null;

  if (mongoose.isValidObjectId(targetId)) {
    matchRecord = await Match.findById(targetId);
    if (matchRecord) {
      partnerUserId = matchRecord.sender?.toString() === userId.toString() ? matchRecord.receiver : matchRecord.sender;
    } else {
      const convRecord = await Conversation.findById(targetId);
      if (convRecord && Array.isArray(convRecord.participants)) {
        partnerUserId = convRecord.participants.find((p) => p.toString() !== userId.toString());
      } else {
        const user = await User.findById(targetId);
        if (user) {
          partnerUserId = user._id;
        } else {
          const profile = await Profile.findById(targetId);
          if (profile && profile.user) {
            partnerUserId = profile.user;
          }
        }
      }
    }
  }

  if (!partnerUserId && matchRecord) {
    partnerUserId = matchRecord.sender?.toString() === userId.toString() ? matchRecord.receiver : matchRecord.sender;
  }

  if (partnerUserId) {
    const pStr = partnerUserId.toString();
    const uStr = userId.toString();

    // 1. Delete all match records between the two users from MongoDB
    await Match.deleteMany({
      $or: [
        { sender: userId, receiver: partnerUserId },
        { sender: partnerUserId, receiver: userId }
      ]
    });

    // 2. Find and delete all conversations and their messages from MongoDB
    const conversations = await Conversation.find({
      participants: { $all: [userId, partnerUserId] }
    });

    for (const conv of conversations) {
      await Message.deleteMany({ conversation: conv._id });
      await Conversation.findByIdAndDelete(conv._id);
      await CacheService.del(`messages:${conv._id.toString()}`);
    }

    // 3. Invalidate Redis Caches
    await Promise.all([
      CacheService.del(`matches:${uStr}`),
      CacheService.del(`matches:${pStr}`),
      CacheService.delByPattern(`feed:${uStr}:*`),
      CacheService.delByPattern(`feed:${pStr}:*`),
      CacheService.delByPattern(`see_who_likes:${uStr}:*`),
      CacheService.delByPattern(`see_who_likes:${pStr}:*`),
      CacheService.del(`conversations:${uStr}`),
      CacheService.del(`conversations:${pStr}`)
    ]);

    // 4. Real-time socket events
    emitToUser(pStr, 'user_unmatched', {
      unmatcherId: uStr,
      partnerId: uStr,
      timestamp: new Date().toISOString()
    });
    emitToUser(uStr, 'user_unmatched', {
      unmatcherId: uStr,
      partnerId: pStr,
      timestamp: new Date().toISOString()
    });
    emitToUser(pStr, 'recent_matches_updated', {
      unmatched: true,
      partnerUserId: uStr
    });
    emitToUser(uStr, 'recent_matches_updated', {
      unmatched: true,
      partnerUserId: pStr
    });
  } else if (matchRecord) {
    await Match.findByIdAndDelete(matchRecord._id);
    await CacheService.del(`matches:${userId.toString()}`);
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { success: true }, 'Unmatched successfully')
  );
});

export const rewindSwipe = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { targetUserId } = req.body;

  if (!targetUserId) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'targetUserId is required for rewind');
  }

  const user = await User.findById(userId);
  const isVip = user?.subscription?.status === 'active' || user?.role === 'admin';
  const rewindAllowed = Boolean(user?.subscription?.perks?.rewindAllowed || isVip);

  // Find the swipe where current user was sender
  const lastMatch = await Match.findOne({ sender: userId, receiver: targetUserId });
  if (lastMatch) {
    // If it was a mutual match and had a conversation, delete the conversation
    if (lastMatch.isMutualMatch) {
      const conv = await Conversation.findOne({
        participants: { $all: [userId, targetUserId] }
      });
      if (conv) {
        await Message.deleteMany({ conversation: conv._id });
        await Conversation.findByIdAndDelete(conv._id);
        await CacheService.del(`messages:${conv._id.toString()}`);
      }
    }

    // Delete the user's swipe
    await Match.findByIdAndDelete(lastMatch._id);

    // If reverse match exists, revert status to PENDING and isMutualMatch to false
    await Match.updateMany(
      { sender: targetUserId, receiver: userId },
      { $set: { status: MATCH_STATUS.PENDING, isMutualMatch: false } }
    );

    // Restore 1 swipe if user has daily swipe tracking
    if (user && user.subscription?.swipesUsedToday > 0) {
      user.subscription.swipesUsedToday = Math.max(0, user.subscription.swipesUsedToday - 1);
      await user.save();
    }
  }

  // Clear caches
  const uStr = userId.toString();
  await Promise.all([
    CacheService.del(`matches:${uStr}`),
    CacheService.delByPattern(`feed:${uStr}:*`),
    CacheService.delByPattern(`see_who_likes:${uStr}:*`),
    CacheService.del(`conversations:${uStr}`)
  ]);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      { success: true, targetUserId, rewindAllowed },
      'Swipe rewound successfully'
    )
  );
});
