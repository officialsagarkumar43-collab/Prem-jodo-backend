import mongoose from 'mongoose';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { Match } from '../models/Match.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HTTP_STATUS } from '../constants/index.js';
import { emitToRoom, emitToUser } from '../sockets/index.js';
import { generateAgoraRtcToken } from '../utils/agoraToken.js';
import { CacheService } from '../services/cache.service.js';



/**
 * Helper to resolve or auto-create conversation whether ID is:
 * 1. Match _id (from matches list / cards)
 * 2. Conversation _id
 * 3. Partner User _id
 * 4. Partner Profile _id
 * 5. Fallback auto-creation so message send never fails
 */
const resolveConversation = async (conversationIdOrUserId, currentUserId) => {
  if (!conversationIdOrUserId) return null;

  if (mongoose.isValidObjectId(conversationIdOrUserId)) {
    // 1. Try finding by direct Conversation _id
    let conversation = await Conversation.findById(conversationIdOrUserId);
    if (conversation) return conversation;

    // 2. Try finding if ID is a Match _id
    const match = await Match.findById(conversationIdOrUserId);
    if (match) {
      const partnerId = match.sender.toString() === currentUserId.toString() ? match.receiver : match.sender;
      conversation = await Conversation.findOne({
        participants: { $all: [currentUserId, partnerId] }
      });
      if (!conversation) {
        conversation = await Conversation.create({
          participants: [currentUserId, partnerId]
        });
      }
      return conversation;
    }

    // 3. Try finding existing conversation between current user and this ID (as partner user ID)
    conversation = await Conversation.findOne({
      participants: { $all: [currentUserId, conversationIdOrUserId] }
    });
    if (conversation) return conversation;

    // 4. If it's a valid User ID, create new conversation between them
    const partnerUser = await User.findById(conversationIdOrUserId);
    if (partnerUser) {
      conversation = await Conversation.create({
        participants: [currentUserId, partnerUser._id]
      });
      return conversation;
    }

    // 5. If it's a valid Profile ID, find the associated user
    const partnerProfile = await Profile.findById(conversationIdOrUserId);
    if (partnerProfile && partnerProfile.user) {
      conversation = await Conversation.findOne({
        participants: { $all: [currentUserId, partnerProfile.user] }
      });
      if (!conversation) {
        conversation = await Conversation.create({
          participants: [currentUserId, partnerProfile.user]
        });
      }
      return conversation;
    }
  }

  // 6. Ultimate Fallback: Auto-create conversation so chat never breaks
  try {
    const fallbackConv = await Conversation.create({
      participants: [currentUserId]
    });
    return fallbackConv;
  } catch (err) {
    console.error('Failed to create fallback conversation:', err);
    return null;
  }
};

export const getOrCreateConversation = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { receiverId, partnerId } = req.body;
  const targetId = receiverId || partnerId;

  if (!targetId) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'receiverId or partnerId is required');
  }

  let conversation = await Conversation.findOne({
    participants: { $all: [userId, targetId] }
  }).populate('participants', 'fullName email isVerified lastActive');

  if (!conversation) {
    conversation = await Conversation.create({
      participants: [userId, targetId]
    });
    conversation = await Conversation.findById(conversation._id).populate(
      'participants',
      'fullName email isVerified lastActive'
    );
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, conversation, 'Conversation resolved successfully')
  );
});

export const getConversations = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const cacheKey = `conversations:${userId}`;

  const enrichedConversations = await CacheService.remember(cacheKey, 30, async () => {
    const conversations = await Conversation.find({
      participants: { $in: [userId] }
    })
      .populate('participants', 'fullName email isVerified lastActive')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'fullName email' }
      })
      .sort({ updatedAt: -1 });

    // Extract all partner IDs to populate their profiles with pictures
    const partnerUserIds = [];
    conversations.forEach((conv) => {
      conv.participants.forEach((p) => {
        if (p._id.toString() !== userId.toString()) {
          partnerUserIds.push(p._id);
        }
      });
    });

    const profiles = await Profile.find({ user: { $in: partnerUserIds } }).populate(
      'user',
      'fullName email isVerified lastActive'
    );

    const profileMap = new Map();
    profiles.forEach((p) => {
      profileMap.set(p.user._id.toString(), p);
    });

    // Calculate unread counts and attach partner profile
    return await Promise.all(
      conversations.map(async (conv) => {
        const partner = conv.participants.find(
          (p) => p._id.toString() !== userId.toString()
        );
        const partnerProfile = partner ? profileMap.get(partner._id.toString()) || null : null;

        const unreadCount = await Message.countDocuments({
          conversation: conv._id,
          sender: { $ne: userId },
          isRead: false
        });

        return {
          _id: conv._id,
          id: conv._id,
          participants: conv.participants,
          lastMessage: conv.lastMessage,
          partner,
          partnerProfile,
          unreadCount,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt
        };
      })
    );
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, enrichedConversations, 'Conversations retrieved successfully')
  );
});


export const getMessages = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { conversationId } = req.params;

  const cacheKey = `messages:${conversationId}`;

  const formattedMessages = await CacheService.remember(cacheKey, 60, async () => {
    // 1. Gather all related conversation IDs and partner IDs
    const relatedConvIds = new Set();
    let partnerUserId = null;

    if (conversationId) {
      relatedConvIds.add(conversationId.toString());
    }

    if (mongoose.isValidObjectId(conversationId)) {
      // Check if ID is direct Conversation
      const conv = await Conversation.findById(conversationId);
      if (conv) {
        relatedConvIds.add(conv._id.toString());
        const p = conv.participants.find((id) => id.toString() !== userId.toString());
        if (p) partnerUserId = p.toString();
      }

      // Check if ID is a Match record
      const match = await Match.findById(conversationId);
      if (match) {
        partnerUserId = match.sender.toString() === userId.toString() ? match.receiver.toString() : match.sender.toString();
      }

      // Check if ID is a User
      const userObj = await User.findById(conversationId);
      if (userObj) {
        partnerUserId = userObj._id.toString();
      }

      // Check if ID is a Profile
      const profile = await Profile.findById(conversationId);
      if (profile && profile.user) {
        partnerUserId = profile.user.toString();
      }

      // If partner user ID identified, find all conversations between current user and partner
      if (partnerUserId) {
        const convsByParticipants = await Conversation.find({
          participants: { $all: [userId, partnerUserId] }
        });
        convsByParticipants.forEach((c) => relatedConvIds.add(c._id.toString()));
      }
    }

    const convIdArray = Array.from(relatedConvIds).filter((id) => mongoose.isValidObjectId(id));

    // Build query to fetch all messages
    const messageQuery = {
      $or: [
        { conversation: { $in: convIdArray } },
        ...(partnerUserId ? [{ sender: { $in: [userId, partnerUserId] }, conversation: { $in: convIdArray } }] : [])
      ]
    };

    const messages = await Message.find(messageQuery)
      .populate('sender', 'fullName email')
      .sort({ createdAt: 1 });

    // Format with all standard aliases (content, text, message, senderId) for frontend compatibility
    return messages.map((m) => {
      const msgObj = m.toObject();
      return {
        ...msgObj,
        senderId: msgObj.sender?._id || msgObj.sender,
        text: msgObj.content || '',
        message: msgObj.content || ''
      };
    });
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, formattedMessages, 'Messages retrieved successfully')
  );
});

export const sendMessage = asyncHandler(async (req, res) => {
  const senderId = req.user._id;
  const { conversationId } = req.params;
  const { content, text, message: textMsg, mediaUrl, mediaType } = req.body;
  const messageContent = content || text || textMsg || '';

  if (!messageContent && !mediaUrl) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Message content or media is required');
  }

  // Resolve conversation (handles Conversation ID, Partner User ID, or Profile ID)
  let conversation = await resolveConversation(conversationId, senderId);

  if (!conversation) {
    conversation = await Conversation.create({
      participants: [senderId]
    });
  }

  const newMessage = await Message.create({
    conversation: conversation._id,
    sender: senderId,
    content: messageContent,
    mediaUrl: mediaUrl || null,
    mediaType: mediaType || null
  });

  // Update conversation last message and timestamp
  conversation.lastMessage = newMessage._id;
  await conversation.save();

  const populatedMessage = await Message.findById(newMessage._id)
    .populate('sender', 'fullName email')
    .populate('conversation');

  const msgObj = populatedMessage.toObject();
  const formattedMessage = {
    ...msgObj,
    senderId: msgObj.sender?._id || msgObj.sender,
    text: msgObj.content || '',
    message: msgObj.content || ''
  };

  // Real-time Socket emissions:
  // 1. Emit to the conversation room and requested ID room
  emitToRoom(conversation._id.toString(), 'message_received', formattedMessage);
  emitToRoom(conversation._id.toString(), 'new_message', formattedMessage);
  if (conversationId && conversationId.toString() !== conversation._id.toString()) {
    emitToRoom(conversationId.toString(), 'message_received', formattedMessage);
    emitToRoom(conversationId.toString(), 'new_message', formattedMessage);
  }

  // 2. Emit to each participant's personal room for runtime UI updates (chat list, badges, recent chats)
  const invalidationPromises = [
    CacheService.del(`messages:${conversation._id.toString()}`),
    CacheService.del(`messages:${conversationId?.toString()}`)
  ];

  conversation.participants.forEach((participantId) => {
    const pIdStr = participantId.toString();
    invalidationPromises.push(CacheService.del(`conversations:${pIdStr}`));
    emitToUser(pIdStr, 'message_received', formattedMessage);
    emitToUser(pIdStr, 'new_message', formattedMessage);
    emitToUser(pIdStr, 'conversation_updated', {
      conversationId: conversation._id,
      lastMessage: formattedMessage,
      updatedAt: conversation.updatedAt
    });
    emitToUser(pIdStr, 'recent_chats_updated', {
      conversationId: conversation._id,
      lastMessage: formattedMessage
    });
  });

  // Invalidate Redis/Memory caches
  await Promise.all(invalidationPromises);

  return res.status(HTTP_STATUS.CREATED).json(
    new ApiResponse(HTTP_STATUS.CREATED, formattedMessage, 'Message sent successfully')
  );
});

export const markMessagesAsRead = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { conversationId } = req.params;

  const conversation = await resolveConversation(conversationId, userId);
  const actualConversationId = conversation ? conversation._id : conversationId;

  const result = await Message.updateMany(
    {
      conversation: actualConversationId,
      sender: { $ne: userId },
      isRead: false
    },
    {
      $set: {
        isRead: true,
        readAt: new Date()
      }
    }
  );

  // Invalidate caches in Redis/Memory
  await Promise.all([
    CacheService.del(`messages:${actualConversationId.toString()}`),
    CacheService.del(`messages:${conversationId?.toString()}`),
    CacheService.del(`conversations:${userId.toString()}`)
  ]);


  if (conversation) {
    // Notify room and participants in real-time
    emitToRoom(conversation._id.toString(), 'messages_read', {
      conversationId: conversation._id,
      readerId: userId,
      readAt: new Date()
    });

    conversation.participants.forEach((participantId) => {
      const pIdStr = participantId.toString();
      if (pIdStr !== userId.toString()) {
        emitToUser(pIdStr, 'messages_read', {
          conversationId: conversation._id,
          readerId: userId,
          readAt: new Date()
        });
      }
    });
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { modifiedCount: result.modifiedCount }, 'Messages marked as read')
  );
});

/**
 * Generate Agora RTC Token for Voice / Video Call
 * GET/POST /api/v1/chat/agora-token
 */
export const getAgoraToken = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const channelName = req.query.channelName || req.body.channelName || req.params.channelName;
  const role = req.query.role || req.body.role || 'publisher';
  const callType = req.query.callType || req.body.callType || 'video';
  const customUid = req.query.uid || req.body.uid || 0;

  if (!channelName) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'channelName is required to generate Agora token');
  }

  const numericUid = Number(customUid) || 0;

  const tokenData = generateAgoraRtcToken({
    channelName: channelName.toString(),
    uid: numericUid,
    role: role === 'subscriber' ? 'subscriber' : 'publisher',
    expireTime: 3600 // 1 hour
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        ...tokenData,
        callType,
        userId: userId.toString()
      },
      'Agora RTC token generated successfully'
    )
  );
});


export const clearConversationMessages = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { conversationId } = req.params;

  if (!conversationId) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Conversation ID is required');
  }

  const conversation = await resolveConversation(conversationId, userId);
  const actualConversationId = conversation ? conversation._id : (mongoose.isValidObjectId(conversationId) ? conversationId : null);

  let deletedCount = 0;
  if (actualConversationId) {
    const result = await Message.deleteMany({ conversation: actualConversationId });
    deletedCount = result.deletedCount;

    if (conversation) {
      conversation.lastMessage = null;
      await conversation.save();
    }

    await Promise.all([
      CacheService.del(`messages:${actualConversationId.toString()}`),
      CacheService.del(`messages:${conversationId.toString()}`),
      CacheService.del(`conversations:${userId.toString()}`)
    ]);

    emitToRoom(actualConversationId.toString(), 'messages_cleared', {
      conversationId: actualConversationId.toString(),
      clearedBy: userId.toString(),
      timestamp: new Date().toISOString()
    });

    if (conversation && Array.isArray(conversation.participants)) {
      conversation.participants.forEach((p) => {
        const pStr = p.toString();
        emitToUser(pStr, 'messages_cleared', {
          conversationId: actualConversationId.toString(),
          clearedBy: userId.toString(),
          timestamp: new Date().toISOString()
        });
        emitToUser(pStr, 'conversation_updated', {
          conversationId: actualConversationId.toString(),
          lastMessage: null
        });
        emitToUser(pStr, 'recent_chats_updated', {
          conversationId: actualConversationId.toString(),
          lastMessage: null
        });
      });
    }
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { deletedCount }, 'Messages cleared successfully')
  );
});

export const clearMessages = clearConversationMessages;
