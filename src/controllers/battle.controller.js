import { getIO } from '../sockets/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { BattleService, STAKE_PRIZE_MAP, ALLOWED_STAKES } from '../services/battle.service.js';
import { BattleRoom } from '../models/BattleRoom.js';

/**
 * @desc Get User's Battle Wallet Details & Stats
 * @route GET /api/v1/battle/wallet
 */
export const getWalletDetails = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const walletData = await BattleService.getWalletDetails(userId);
  return res.status(200).json(new ApiResponse(200, walletData, 'Wallet details fetched successfully'));
});

/**
 * @desc Add money to battle wallet
 * @route POST /api/v1/battle/wallet/add-money
 */
export const addMoneyToWallet = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { amount, description, paymentRef } = req.body;
  const result = await BattleService.addMoney(userId, amount, description, paymentRef);
  return res.status(200).json(new ApiResponse(200, result, 'Money added to wallet successfully'));
});

/**
 * @desc Withdraw money from battle wallet (processed against winningBalance)
 * @route POST /api/v1/battle/wallet/withdraw
 */
export const withdrawMoneyFromWallet = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { amount, upiId } = req.body;
  const result = await BattleService.withdrawMoney(userId, amount, upiId);
  return res.status(200).json(new ApiResponse(200, result, 'Withdrawal request submitted successfully'));
});

/**
 * @desc Generate a unique server-side Battle Room Code with validated stake & prize
 * @route POST /api/v1/battle/rooms/generate-code or GET /api/v1/battle/rooms/generate-code
 */
export const generateRoomCode = asyncHandler(async (req, res) => {
  let stake = Number(req.body?.stakeAmount || req.query?.stakeAmount) || 50;
  if (!ALLOWED_STAKES.includes(stake)) {
    stake = 50;
  }
  const prize = STAKE_PRIZE_MAP[stake] || 90;
  const roomId = await BattleService.generateUniqueRoomCode();

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        roomId,
        roomCode: roomId,
        stakeAmount: stake,
        prizeAmount: prize,
        allowedStakes: ALLOWED_STAKES
      },
      'Unique Battle Room Code generated successfully'
    )
  );
});

/**
 * @desc Create a custom Battle Room
 * @route POST /api/v1/battle/rooms/create
 */
export const createCustomRoom = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { stakeAmount, roomType = 'custom', customCode, challengeTargetUserId } = req.body;

  const room = await BattleService.createBattleRoom(
    userId,
    { name: req.user.fullName, avatar: req.user.avatar },
    { stakeAmount, roomType, customCode, challengeTargetUserId }
  );

  try {
    const ioInstance = getIO();
    if (ioInstance) {
      const lobbyRoom = {
        id: room._id || room.roomId,
        _id: room._id || room.roomId,
        roomId: room.roomId,
        roomCode: room.roomId,
        hostUserId: userId.toString(),
        hostName: req.user.fullName || 'Host',
        hostAvatar: req.user.avatar || '',
        hostCity: req.user.city || 'Arena',
        stake: Number(room.stakeAmount || 50),
        stakeAmount: Number(room.stakeAmount || 50),
        prize: Number(room.prizeAmount || 90),
        prizeAmount: Number(room.prizeAmount || 90),
        playerCount: Number(room.maxPlayers || 2),
        maxPlayers: Number(room.maxPlayers || 2),
        currentSlots: room.players?.length || 1,
        players: room.players || [],
        createdAt: 'Active Now',
        status: (room.status || 'WAITING').toUpperCase(),
        isUserCreated: true,
        roomType: room.roomType || 'custom'
      };

      // Canonical event for lobby updates matching battleSocket.js
      ioInstance.of('/battle').emit('battle:lobby_room_created', lobbyRoom);
      ioInstance.emit('battle:lobby_room_created', lobbyRoom);
    }
  } catch (e) {
    console.warn('Socket broadcast error on createCustomRoom:', e?.message);
  }

  return res.status(201).json(new ApiResponse(201, room, 'Battle room created successfully'));
});

/**
 * @desc Join a Battle Room by Room Code
 * @route POST /api/v1/battle/rooms/join
 */
export const joinRoomByCode = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const roomId = req.body?.roomId || req.body?.roomCode || req.body?.code;

  if (!roomId) {
    throw new ApiError(400, 'Room code is required');
  }

  const result = await BattleService.joinBattleRoom(
    userId,
    { name: req.user.fullName, avatar: req.user.avatar },
    roomId
  );

  const { room, isRejoining } = result;

  try {
    const ioInstance = getIO();
    if (ioInstance && !isRejoining) {
      const rId = room.roomId.toUpperCase();
      const maxPlayers = room.maxPlayers || 2;
      const isGameReady = room.players.length >= maxPlayers;

      const playerJoinedData = {
        roomId: rId,
        players: room.players,
        maxPlayers,
        currentSlots: room.players.length,
        joinedPlayer: {
          userId: userId.toString(),
          name: req.user.fullName || 'Player',
          avatar: req.user.avatar || ''
        }
      };

      ioInstance.of('/battle').to(rId).emit('battle:player_joined', playerJoinedData);
      ioInstance.to(rId).emit('battle:player_joined', playerJoinedData);

      if (isGameReady) {
        const gameStartData = {
          roomId: rId,
          stakeAmount: room.stakeAmount,
          prizeAmount: room.prizeAmount,
          players: room.players,
          maxPlayers,
          currentTurnPlayerId: room.currentTurnPlayerId || room.players[0]?.userId,
          status: 'playing',
          message: 'All players joined! Battle is starting!'
        };

        ioInstance.of('/battle').to(rId).emit('battle:game_start', gameStartData);
        ioInstance.to(rId).emit('battle:game_start', gameStartData);
      }
    }
  } catch (e) {
    console.warn('Socket broadcast warning on joinRoomByCode:', e?.message);
  }

  return res.status(200).json(new ApiResponse(200, result, 'Joined battle room successfully'));
});

/**
 * @desc Get details of a single battle room
 * @route GET /api/v1/battle/rooms/:roomId
 */
export const getRoomDetails = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const room = await BattleRoom.findOne({ roomId: roomId.toUpperCase() })
    .populate('players.user', 'fullName avatar')
    .populate('winner.user', 'fullName avatar');

  if (!room) {
    throw new ApiError(404, 'Battle room not found');
  }

  return res.status(200).json(new ApiResponse(200, room, 'Room details fetched'));
});

/**
 * @desc Get Dedicated Live AutoMatch Rooms
 * @route GET /api/v1/battle/live-automatch or /api/v1/battle/live_automatch
 */
export const getLiveAutoMatch = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const autoMatchRooms = await BattleService.getLiveAutoMatch(userId);
  return res.status(200).json(new ApiResponse(200, autoMatchRooms, 'Live AutoMatch rooms fetched successfully'));
});

/**
 * @desc Get Custom Rooms (created via Custom Room Code)
 * @route GET /api/v1/battle/rooms
 */
export const getOpenRooms = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const rooms = await BattleService.getOpenRooms(userId);
  return res.status(200).json(new ApiResponse(200, rooms, 'Custom rooms fetched successfully'));
});

/**
 * @desc Get Live Online Battlers for 1v1 challenge
 * @route GET /api/v1/battle/online-players
 */
export const getLiveOnlinePlayers = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const players = await BattleService.getOnlinePlayers(userId);
  return res.status(200).json(new ApiResponse(200, players, 'Online players fetched successfully'));
});

/**
 * @desc Get Top Earners Leaderboard
 * @route GET /api/v1/battle/leaderboard
 */
export const getLeaderboard = asyncHandler(async (req, res) => {
  const leaderboard = await BattleService.getLeaderboard(20);
  return res.status(200).json(new ApiResponse(200, leaderboard, 'Leaderboard fetched successfully'));
});

/**
 * @desc Get user's battle history
 * @route GET /api/v1/battle/history
 */
export const getBattleHistory = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const history = await BattleRoom.find({
    'players.userId': userId.toString(),
    status: { $in: ['completed', 'cancelled', 'abandoned'] }
  })
    .sort({ endedAt: -1, createdAt: -1 })
    .limit(30);

  return res.status(200).json(new ApiResponse(200, history, 'Battle history fetched successfully'));
});

/**
 * Helper to broadcast room cancellation & removal across all socket namespaces & rooms
 */
export const broadcastRoomCancellation = (roomId, roomDoc = null, reason = 'cancelled') => {
  try {
    const ioInstance = getIO();
    if (!ioInstance) return;

    const rId = (roomId || '').toString().trim().toUpperCase();
    const payload = {
      id: roomDoc?._id?.toString() || rId,
      _id: roomDoc?._id?.toString() || rId,
      roomId: rId,
      roomCode: rId,
      status: 'CANCELLED',
      reason,
      timestamp: new Date().toISOString()
    };

    // Canonical events matching battleSocket.js:
    // 1. Notify lobby to remove room
    ioInstance.of('/battle').emit('battle:lobby_room_removed', payload);
    ioInstance.emit('battle:lobby_room_removed', payload);

    // 2. Notify room subscribers that room was cancelled
    ioInstance.of('/battle').to(rId).emit('battle:room_cancelled', payload);
    ioInstance.to(rId).emit('battle:room_cancelled', payload);
  } catch (e) {
    console.warn('Socket broadcast error on broadcastRoomCancellation:', e?.message);
  }
};

/**
 * @desc Cancel a battle room (Removes from Live AutoMatch / Lobby immediately)
 * @route POST /api/v1/battle/rooms/:roomId/cancel or POST /api/v1/battle/rooms/cancel or DELETE /api/v1/battle/rooms/:roomId
 */
export const cancelBattleRoom = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const roomId = req.params?.roomId || req.body?.roomId || req.body?.roomCode || req.body?.code;

  if (!roomId) {
    throw new ApiError(400, 'Room ID / code is required');
  }

  const room = await BattleService.cancelBattleRoom(roomId, userId);

  // Broadcast cancellation socket event to remove from opponents' screens and live automatch
  broadcastRoomCancellation(roomId, room, 'host_cancelled');

  return res.status(200).json(
    new ApiResponse(200, { roomId: room.roomId, status: room.status }, 'Battle room cancelled successfully')
  );
});

/**
 * @desc Forfeit / Leave battle room
 * @route POST /api/v1/battle/rooms/:roomId/forfeit or POST /api/v1/battle/rooms/:roomId/leave
 */
export const forfeitRoom = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const roomId = req.params?.roomId || req.body?.roomId || req.body?.roomCode || req.body?.code;

  if (!roomId) {
    throw new ApiError(400, 'Room ID / code is required');
  }

  const result = await BattleService.forfeitBattleRoom(roomId, userId);

  try {
    const ioInstance = getIO();
    if (ioInstance) {
      const rId = roomId.toUpperCase();
      const payload = {
        roomId: rId,
        userId: userId.toString(),
        timestamp: new Date().toISOString()
      };

      ioInstance.of('/battle').to(rId).emit('battle:player_left', payload);
      ioInstance.to(rId).emit('battle:player_left', payload);

      if (result?.winner) {
        const gameOverPayload = {
          roomId: rId,
          winner: result.winner,
          prizeAmount: result.prizeAmount,
          reason: 'opponent_forfeited',
          endedAt: result.endedAt ? new Date(result.endedAt).toISOString() : new Date().toISOString()
        };
        ioInstance.of('/battle').to(rId).emit('battle:game_over', gameOverPayload);
        ioInstance.to(rId).emit('battle:game_over', gameOverPayload);
      }
    }
  } catch (e) {
    console.warn('Socket emit warning on forfeitRoom:', e?.message);
  }

  // Also broadcast room removal if it was cancelled
  if (result?.status === 'cancelled') {
    broadcastRoomCancellation(roomId, result, 'player_left');
  }

  return res.status(200).json(new ApiResponse(200, result, 'Battle room forfeited / exited successfully'));
});

/**
 * @desc Check if the authenticated user can create a new battle
 * @route GET /api/v1/battle/can-create-battle or /api/v1/battle/cancreatebattle
 */
export const canCreateBattle = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const result = await BattleService.canCreateBattle(userId);
  return res.status(200).json(
    new ApiResponse(200, result, result.message)
  );
});
