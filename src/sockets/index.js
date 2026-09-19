import { Server } from "socket.io";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { Match } from "../models/Match.js";
import { Profile } from "../models/Profile.js";
import { CacheService } from "../services/cache.service.js";
import { initializeBattleSocket } from "./battleSocket.js";

let io = null;

const parseUserId = (u) => {
  if (!u) return null;
  if (typeof u === "object") {
    const id = u._id || u.id || u.userId;
    return id ? id.toString().trim().replace(/^(usr_|conv_|chat_|match_)/, "") : null;
  }
  const str = u.toString().trim().replace(/^(usr_|conv_|chat_|match_)/, "");
  return (str && str !== "[object Object]") ? str : null;
};

const onlineUsers = new Map();
const recentlyProcessedMessages = new Set();

const resolveConversation = async (conversationIdOrUserId, currentUserId, toUserId) => {
  const cleanCurrentId = parseUserId(currentUserId);
  const cleanToId = parseUserId(toUserId);
  const cleanTargetId = parseUserId(conversationIdOrUserId);

  if (cleanTargetId && mongoose.isValidObjectId(cleanTargetId)) {
    let conversation = await Conversation.findById(cleanTargetId);
    if (conversation) {
      let needsSave = false;
      if (cleanCurrentId && !conversation.participants.some(p => p.toString() === cleanCurrentId)) {
        conversation.participants.push(cleanCurrentId);
        needsSave = true;
      }
      if (cleanToId && !conversation.participants.some(p => p.toString() === cleanToId)) {
        conversation.participants.push(cleanToId);
        needsSave = true;
      }
      if (needsSave) await conversation.save();
      return conversation;
    }

    const match = await Match.findById(cleanTargetId);
    if (match) {
      const p1 = match.sender.toString();
      const p2 = match.receiver.toString();
      let conv = await Conversation.findOne({ participants: { $all: [p1, p2] } });
      if (!conv) {
        conv = await Conversation.create({ participants: [p1, p2] });
      }
      return conv;
    }

    if (cleanCurrentId) {
      let conv = await Conversation.findOne({ participants: { $all: [cleanCurrentId, cleanTargetId] } });
      if (conv) return conv;
    }

    const partnerUser = await User.findById(cleanTargetId).catch(() => null);
    if (partnerUser && cleanCurrentId) {
      let conv = await Conversation.findOne({ participants: { $all: [cleanCurrentId, partnerUser._id.toString()] } });
      if (!conv) {
        conv = await Conversation.create({ participants: [cleanCurrentId, partnerUser._id.toString()] });
      }
      return conv;
    }
  }

  if (cleanCurrentId && cleanToId) {
    let conv = await Conversation.findOne({ participants: { $all: [cleanCurrentId, cleanToId] } });
    if (conv) return conv;
    conv = await Conversation.create({ participants: [cleanCurrentId, cleanToId] });
    return conv;
  }

  return null;
};

export const initializeSocket = (server, clientUrl) => {
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => callback(null, true),
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  io.on("connection", (socket) => {
    console.log("⚡ Socket connected: " + socket.id);

    const handleUserJoin = async (userId) => {
      const strUserId = parseUserId(userId);
      if (!strUserId) return;
      socket.join(strUserId);
      socket.join("user_" + strUserId);

      if (!onlineUsers.has(strUserId)) {
        onlineUsers.set(strUserId, new Set());
      }
      onlineUsers.get(strUserId).add(socket.id);

      await CacheService.sadd("online_users", strUserId).catch(() => {});

      io.emit("user_online", { userId: strUserId, status: "online" });
      const cleanUsers = Array.from(onlineUsers.keys()).filter(id => id && id !== "[object Object]");
      socket.emit("online_users", cleanUsers);
      console.log("🟢 User " + strUserId + " joined personal room. Total online: " + onlineUsers.size);
    };

    socket.on("setup", handleUserJoin);
    socket.on("join_user", handleUserJoin);
    socket.on("addUser", handleUserJoin);
    socket.on("add_user", handleUserJoin);
    socket.on("register", handleUserJoin);
    socket.on("register_user", handleUserJoin);
    socket.on("identity", handleUserJoin);
    socket.on("user_connected", handleUserJoin);

    const handleJoinChat = (room) => {
      if (!room) return;
      const strRoom = room.toString();
      const cleanRoom = parseUserId(room) || strRoom.replace(/^conv_/, "");
      socket.join(strRoom);
      if (cleanRoom && cleanRoom !== strRoom) socket.join(cleanRoom);
      console.log("💬 Socket " + socket.id + " joined room: " + strRoom + " / " + cleanRoom);
    };

    socket.on("join_chat", handleJoinChat);
    socket.on("joinChat", handleJoinChat);
    socket.on("join_conversation", handleJoinChat);
    socket.on("joinConversation", handleJoinChat);
    socket.on("join_room", handleJoinChat);
    socket.on("joinRoom", handleJoinChat);
    socket.on("join", (room) => {
      if (!room) return;
      handleUserJoin(room);
      handleJoinChat(room);
    });

    const handleLeaveChat = (room) => {
      if (!room) return;
      const strRoom = room.toString();
      const cleanRoom = parseUserId(room) || strRoom.replace(/^conv_/, "");
      socket.leave(strRoom);
      if (cleanRoom) socket.leave(cleanRoom);
    };

    socket.on("leave_chat", handleLeaveChat);
    socket.on("leaveChat", handleLeaveChat);
    socket.on("leave_room", handleLeaveChat);

    socket.on("typing", ({ conversationId, receiverId, user }) => {
      const cleanConv = parseUserId(conversationId);
      const cleanRec = parseUserId(receiverId);
      if (conversationId) socket.to(conversationId.toString()).emit("typing", { conversationId, user });
      if (cleanConv && cleanConv !== conversationId?.toString()) socket.to(cleanConv).emit("typing", { conversationId, user });
      if (cleanRec) socket.to(cleanRec).emit("typing", { conversationId, user });
    });

    socket.on("stop_typing", ({ conversationId, receiverId, user }) => {
      const cleanConv = parseUserId(conversationId);
      const cleanRec = parseUserId(receiverId);
      if (conversationId) socket.to(conversationId.toString()).emit("stop_typing", { conversationId, user });
      if (cleanConv && cleanConv !== conversationId?.toString()) socket.to(cleanConv).emit("stop_typing", { conversationId, user });
      if (cleanRec) socket.to(cleanRec).emit("stop_typing", { conversationId, user });
    });

    socket.on("mark_read", async ({ conversationId, readerId, senderId }) => {
      try {
        const cleanConv = parseUserId(conversationId);
        const cleanReader = parseUserId(readerId);
        const cleanSender = parseUserId(senderId);

        if (cleanConv && mongoose.isValidObjectId(cleanConv)) {
          await Message.updateMany(
            { conversation: cleanConv, sender: { $ne: cleanReader } },
            { $set: { status: "read", isRead: true, read: true } }
          ).catch(() => {});
        }

        const payload = { conversationId: cleanConv || conversationId, readerId: cleanReader };
        if (conversationId) socket.to(conversationId.toString()).emit("messages_read", payload);
        if (cleanConv) socket.to(cleanConv).emit("messages_read", payload);
        if (cleanSender) socket.to(cleanSender).emit("messages_read", payload);
      } catch (e) {
        console.warn("mark_read error:", e);
      }
    });

    const handleSocketSendMessage = async (data, callback) => {
      try {
        if (!data) return;
        const {
          conversationId,
          chatId,
          roomId,
          senderId,
          sender,
          receiverId,
          receiver,
          recipientId,
          content,
          text,
          message,
          mediaUrl,
          mediaType
        } = data;

        const messageContent = (content || text || message || "").trim();
        const fromUserId = parseUserId(senderId || sender);
        const toUserId = parseUserId(receiverId || receiver || recipientId);
        const targetConvId = conversationId || chatId || roomId;

        if (!fromUserId || (!messageContent && !mediaUrl)) {
          if (typeof callback === "function") callback({ success: false, message: "Invalid payload" });
          return;
        }

        const dedupeKey = `${fromUserId}_${targetConvId || toUserId}_${messageContent}_${mediaUrl || ""}`;
        if (recentlyProcessedMessages.has(dedupeKey)) {
          console.log("⚡ [Socket Dedupe] Ignored duplicate event: " + dedupeKey);
          if (typeof callback === "function") callback({ success: true, duplicated: true });
          return;
        }
        recentlyProcessedMessages.add(dedupeKey);
        setTimeout(() => recentlyProcessedMessages.delete(dedupeKey), 3000);

        let conversation = await resolveConversation(targetConvId, fromUserId, toUserId);
        if (!conversation && toUserId) {
          conversation = await resolveConversation(toUserId, fromUserId, toUserId);
        }
        if (!conversation) {
          const participants = [fromUserId];
          if (toUserId && toUserId !== fromUserId) participants.push(toUserId);
          conversation = await Conversation.create({ participants });
        }

        const newMessage = await Message.create({
          conversation: conversation._id,
          sender: fromUserId,
          content: messageContent,
          mediaUrl: mediaUrl || null,
          mediaType: mediaType || null,
          status: "delivered"
        });

        conversation.lastMessage = newMessage._id;
        await conversation.save();

        const [senderUser, senderProfile] = await Promise.all([
          User.findById(fromUserId).select("fullName email avatar photo").catch(() => null),
          Profile.findOne({ user: fromUserId }).select("photos avatar fullName firstName bio age location").catch(() => null)
        ]);

        const senderPhoto = senderProfile?.photos?.[0]?.url || senderProfile?.photos?.[0] || senderProfile?.avatar || senderUser?.avatar || senderUser?.photo || "";
        const senderName = senderUser?.fullName || senderProfile?.fullName || senderProfile?.firstName || "Match Partner";

        const formattedMessage = {
          _id: newMessage._id.toString(),
          id: newMessage._id.toString(),
          conversationId: conversation._id.toString(),
          conversation: conversation._id.toString(),
          senderId: fromUserId,
          sender: {
            _id: fromUserId,
            id: fromUserId,
            fullName: senderName,
            name: senderName,
            avatar: senderPhoto,
            photo: senderPhoto,
          },
          senderName,
          senderPhoto,
          partnerName: senderName,
          partnerPhoto: senderPhoto,
          content: messageContent,
          text: messageContent,
          message: messageContent,
          mediaUrl: newMessage.mediaUrl || mediaUrl || null,
          mediaType: newMessage.mediaType || mediaType || (mediaUrl ? 'audio' : null),
          duration: data.duration || null,
          unread: true,
          createdAt: newMessage.createdAt || new Date().toISOString()
        };

        const convStr = conversation._id.toString();
        io.to(convStr).emit("message_received", formattedMessage);
        io.to(convStr).emit("new_message", formattedMessage);
        io.to("conv_" + convStr).emit("message_received", formattedMessage);
        io.to("conv_" + convStr).emit("new_message", formattedMessage);

        if (targetConvId && targetConvId.toString() !== convStr) {
          io.to(targetConvId.toString()).emit("message_received", formattedMessage);
          io.to(targetConvId.toString()).emit("new_message", formattedMessage);
        }

        const invalidationPromises = [
          CacheService.del("messages:" + convStr),
          CacheService.del("messages:" + targetConvId)
        ];

        const participantSet = new Set();
        if (conversation && Array.isArray(conversation.participants)) {
          conversation.participants.forEach(p => {
            const parsed = parseUserId(p);
            if (parsed) participantSet.add(parsed);
          });
        }
        if (toUserId) participantSet.add(toUserId);
        if (fromUserId) participantSet.add(fromUserId);

        participantSet.forEach((pIdStr) => {
          invalidationPromises.push(CacheService.del("conversations:" + pIdStr));
          emitToUser(pIdStr, "message_received", formattedMessage);
          emitToUser(pIdStr, "new_message", formattedMessage);
          emitToUser(pIdStr, "new_match", {
            conversationId: convStr,
            conversation: convStr,
            partnerUserId: fromUserId,
            userName: senderName,
            userAvatar: senderPhoto,
            lastMessage: messageContent,
            lastMessageTime: newMessage.createdAt,
            unread: true
          });
          emitToUser(pIdStr, "conversation_updated", {
            conversationId: convStr,
            conversation: convStr,
            lastMessage: formattedMessage,
            unread: true,
            updatedAt: conversation.updatedAt
          });
          emitToUser(pIdStr, "recent_chats_updated", {
            conversationId: convStr,
            conversation: convStr,
            lastMessage: formattedMessage
          });
        });

        await Promise.all(invalidationPromises).catch(() => {});
        console.log("💬 [Socket Live Message Broadcasted] From: " + fromUserId + " (" + senderName + ") -> To: " + Array.from(participantSet).join(", ") + ", Conv: " + convStr);

        if (typeof callback === "function") {
          callback({ success: true, data: formattedMessage });
        }
      } catch (err) {
        console.error("❌ Error handling socket message:", err);
        if (typeof callback === "function") {
          callback({ success: false, error: err.message });
        }
      }
    };

    socket.on("send_message", handleSocketSendMessage);
    socket.on("sendMessage", handleSocketSendMessage);

    socket.on("new_message", (newMessageReceived) => {
      if (!newMessageReceived) return;
      const conversationId = newMessageReceived.conversation?._id || newMessageReceived.conversation;
      if (conversationId) {
        io.to(conversationId.toString()).emit("message_received", newMessageReceived);
      }
      const participants = newMessageReceived.conversation?.participants;
      if (Array.isArray(participants)) {
        participants.forEach((user) => {
          const participantId = parseUserId(user);
          if (participantId) {
            io.to(participantId).emit("message_received", newMessageReceived);
            io.to(participantId).emit("conversation_updated", { conversationId, lastMessage: newMessageReceived });
          }
        });
      }
    });

    // Call signaling
    socket.on("call:initiate", (callData) => {
      const { channelName, receiverId, callerId, callerName, callerAvatar, callType = "video", conversationId } = callData || {};
      if (!receiverId || !channelName) return;
      socket.join(channelName.toString());
      const payload = {
        channelName: channelName.toString(),
        receiverId: receiverId.toString(),
        callerId: callerId ? callerId.toString() : socket.id,
        callerName: callerName || "User",
        callerAvatar: callerAvatar || "",
        callType,
        conversationId,
        timestamp: new Date().toISOString()
      };
      io.to(receiverId.toString()).emit("call:incoming", payload);
      io.to(receiverId.toString()).emit("incoming_call", payload);
    });
    socket.on("call_user", (data) => socket.emit("call:initiate", data));
    socket.on("call:accept", (data) => {
      const { channelName, callerId, receiverId, callType } = data || {};
      if (!channelName) return;
      socket.join(channelName.toString());
      const payload = { channelName: channelName.toString(), callerId: callerId?.toString(), receiverId: receiverId?.toString(), callType: callType || "video", acceptedAt: new Date().toISOString() };
      if (callerId) { io.to(callerId.toString()).emit("call:accepted", payload); io.to(callerId.toString()).emit("call_accepted", payload); }
      if (receiverId) io.to(receiverId.toString()).emit("call:accepted", payload);
      io.to(channelName.toString()).emit("call:connected", payload);
    });
    socket.on("call:reject", (data) => {
      const { channelName, callerId, receiverId, reason = "declined" } = data || {};
      const payload = { channelName: channelName?.toString(), callerId: callerId?.toString(), receiverId: receiverId?.toString(), reason, rejectedAt: new Date().toISOString() };
      if (callerId) { io.to(callerId.toString()).emit("call:rejected", payload); io.to(callerId.toString()).emit("call_rejected", payload); }
    });
    socket.on("call:end", (data) => {
      const { channelName, callerId, receiverId, partnerId, reason = "ended" } = data || {};
      const payload = { channelName: channelName?.toString(), reason, endedAt: new Date().toISOString() };
      if (channelName) { io.to(channelName.toString()).emit("call:ended", payload); io.to(channelName.toString()).emit("call_ended", payload); }
      if (callerId) io.to(callerId.toString()).emit("call:ended", payload);
      if (receiverId) io.to(receiverId.toString()).emit("call:ended", payload);
      if (partnerId) io.to(partnerId.toString()).emit("call:ended", payload);
    });
    socket.on("call:toggle_media", (data) => {
      const { channelName, partnerId, isMuted, isVideoOff, userId } = data || {};
      const payload = { channelName, userId: userId?.toString(), isMuted, isVideoOff };
      if (channelName) socket.to(channelName.toString()).emit("call:media_toggled", payload);
      if (partnerId) io.to(partnerId.toString()).emit("call:media_toggled", payload);
    });
    socket.on("call:busy", (data) => {
      const { callerId, channelName } = data || {};
      if (callerId) { io.to(callerId.toString()).emit("call:busy", { channelName, reason: "busy" }); io.to(callerId.toString()).emit("call:rejected", { channelName, reason: "busy" }); }
    });

    socket.on("disconnect", async () => {
      for (const [userId, sockets] of onlineUsers.entries()) {
        if (sockets.has(socket.id)) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            onlineUsers.delete(userId);
            await CacheService.srem("online_users", userId).catch(() => {});
            const offlineTime = new Date();
            const isoTime = offlineTime.toISOString();
            io.emit("user_offline", { userId, status: "offline", lastSeen: isoTime, timestamp: isoTime });
            try { User.findByIdAndUpdate(userId, { lastActive: offlineTime }).exec().catch(() => {}); } catch (err) {}
          }
        }
      }
    });
  });

  // Initialize Dedicated Battle Socket Layer
  initializeBattleSocket(io);

  return io;
};

export const getIO = () => io;

export const emitToUser = (userId, event, data) => {
  if (!io || !userId) return;
  const strId = parseUserId(userId) || userId.toString();
  io.to(strId).emit(event, data);
  io.to("user_" + strId).emit(event, data);
};

export const emitToUsers = (userIds = [], event, data) => {
  if (!io || !Array.isArray(userIds)) return;
  userIds.forEach(userId => { if (userId) emitToUser(userId, event, data); });
};

export const emitToRoom = (roomId, event, data) => {
  if (!io || !roomId) return;
  const strRoom = roomId.toString();
  io.to(strRoom).emit(event, data);
  const clean = parseUserId(strRoom);
  if (clean && clean !== strRoom) io.to(clean).emit(event, data);
};