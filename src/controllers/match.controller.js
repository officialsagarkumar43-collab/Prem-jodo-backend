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

  // Invalidate feed and match list caches for both users in Redis/Memory
  await Promise.all([
    CacheService.delByPattern(`feed:${senderId}:*`),
    CacheService.del(`matches:${senderId}`),
    CacheService.del(`matches:${receiverId}`)
  ]);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        match,
        isMutualMatch: isMutual,
        conversation,
        partnerProfile: isMutual ? receiverProfile : null
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

    // Extract all matched partner user IDs to attach profiles
    const partnerUserIds = matches.map((m) =>
      m.sender._id.toString() === userId.toString() ? m.receiver._id : m.sender._id
    );

    const profiles = await Profile.find({ user: { $in: partnerUserIds } }).populate(
      'user',
      'fullName email isVerified lastActive'
    );

    const profileMap = new Map();
    profiles.forEach((p) => {
      profileMap.set(p.user._id.toString(), p);
    });

    return matches.map((m) => {
      const isSender = m.sender._id.toString() === userId.toString();
      const partner = isSender ? m.receiver : m.sender;
      const partnerProfile = profileMap.get(partner._id.toString()) || null;

      return {
        _id: m._id,
        match: m,
        partner,
        partnerProfile,
        matchedAt: m.updatedAt,
        isMutualMatch: m.isMutualMatch,
        action: m.action
      };
    });
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

    // 4. Fetch profiles with populated user details
    const skip = (page - 1) * limit;

    const profiles = await Profile.find(query)
      .populate('user', 'fullName email isVerified lastActive isOnboarded')
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // 5. Format profiles for frontend card stack
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
        const primaryPhoto = p.photos?.find((photo) => photo.isPrimary)?.url || p.photos?.[0]?.url || '';

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
          lastActive: p.user.lastActive
        };
      });
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, feed, 'Discovery feed retrieved successfully')
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
      partnerUserId = matchRecord.sender.toString() === userId.toString() ? matchRecord.receiver : matchRecord.sender;
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
    partnerUserId = matchRecord.sender.toString() === userId.toString() ? matchRecord.receiver : matchRecord.sender;
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
