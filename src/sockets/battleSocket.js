import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { LudoEngine } from '../services/ludoEngine.service.js';
import { BattleService } from '../services/battle.service.js';
import { BattleRoom } from '../models/BattleRoom.js';
import { BattleTransaction } from '../models/BattleTransaction.js';
import { CacheService } from '../services/cache.service.js';
import { ENV } from '../config/env.js';

// =============================================================================
// PRODUCTION IN-MEMORY STORAGE & REAL-TIME STATE
// =============================================================================
const activeBattleRooms = new Map(); // roomId -> RoomState
const userToActiveRoomMap = new Map(); // cleanUserId -> roomId (O(1) Instant Lookup)
const automatchQueues = new Map(); // stake -> Map<cleanUserId, { socketId, userId, name, avatar, stake, joinedAt }>
const turnTimers = new Map(); // roomId -> NodeJS.Timeout
const reconnectTimers = new Map(); // `${roomId}_${userId}` -> NodeJS.Timeout
const userActiveSockets = new Map(); // cleanUserId -> Set<socketId>
const roomPersistenceQueues = new Map(); // roomId -> Promise (Sequential async DB queue)
const roomActionQueues = new Map(); // roomId -> Promise (Sequential in-memory action mutex)

const TURN_DURATION_MS = 20000; // 20 seconds per turn
const RECONNECT_GRACE_PERIOD_MS = 25000; // 25 seconds grace period for network drops
const ROOM_INACTIVITY_TTL_MS = 30 * 60 * 1000; // 30 minutes TTL for stale completed rooms

// =============================================================================
// HELPER UTILITIES
// =============================================================================

/**
 * Sequential Execution Mutex per Room to prevent concurrent action race conditions
 */
const executeRoomAction = (roomId, actionFn) => {
  const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
  if (!rId) return Promise.resolve();

  const previousAction = roomActionQueues.get(rId) || Promise.resolve();
  const nextAction = previousAction
    .catch(() => { })
    .then(() => actionFn());

  roomActionQueues.set(rId, nextAction);

  nextAction
    .finally(() => {
      if (roomActionQueues.get(rId) === nextAction) {
        roomActionQueues.delete(rId);
      }
    })
    .catch(() => { });

  return nextAction;
};

/**
 * Get clean normalized player ID
 */
const getPlayerCleanId = (p) => {
  if (!p) return '';
  const raw = typeof p === 'object' ? (p.userId || p.user?._id || p.user || p._id || p.id || '') : p;
  return String(raw).trim().replace(/^(usr_|conv_|chat_|match_)/, '');
};

/**
 * Generate cryptographically secure collision-resistant room code (281+ Trillion combinations)
 */
const generateSecureRoomCode = () => {
  return `LUDO-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
};

/**
 * Generate cryptographically secure 1-6 dice value
 */
const rollFairDice = () => {
  return crypto.randomInt(1, 7);
};

/**
 * Mutate room state version and lastActivityAt timestamp atomically
 */
const touchRoom = (room) => {
  if (!room) return;
  room.stateVersion = (room.stateVersion || 0) + 1;
  room.lastActivityAt = Date.now();
};

/**
 * Rotate and issue a fresh turnToken to invalidate any in-flight delayed callbacks
 */
const rotateTurnToken = (room) => {
  if (!room) return '';
  room.turnToken = crypto.randomUUID();
  return room.turnToken;
};

/**
 * Standardize and centralize Room State structure with State Versioning
 */
const createRoomState = (roomDoc, overrides = {}) => {
  const players = (roomDoc.players || []).map((p) => ({
    userId: getPlayerCleanId(p),
    user: p.user || p._id || p.userId,
    name: p.name || 'Player',
    avatar: p.avatar || '',
    color: p.color || 'red',
    pawnPositions: Array.isArray(p.pawnPositions) && p.pawnPositions.length === 4 ? [...p.pawnPositions] : [-1, -1, -1, -1],
    score: p.score || 0,
    pawnsInHome: p.pawnsInHome || 0,
    missedTurns: p.missedTurns || 0
  }));

  return {
    roomId: (roomDoc.roomId || '').toString().trim().toUpperCase(),
    stakeAmount: Number(roomDoc.stakeAmount) || 50,
    prizeAmount: Number(roomDoc.prizeAmount) || 90,
    maxPlayers: Number(roomDoc.maxPlayers) || 2,
    challengeTargetUserId: roomDoc.challengeTargetUserId ? getPlayerCleanId(roomDoc.challengeTargetUserId) : null,
    players,
    currentTurnIndex: Number(roomDoc.currentTurnIndex) || 0,
    currentTurnPlayerId: getPlayerCleanId(roomDoc.currentTurnPlayerId || players[0]?.userId),
    hasRolledDice: Boolean(roomDoc.hasRolledDice),
    currentDiceValue: roomDoc.currentDiceValue || null,
    isProcessingMove: false,
    isEnded: Boolean(roomDoc.isEnded || roomDoc.status === 'completed' || roomDoc.status === 'cancelled'),
    turnDeadline: roomDoc.turnDeadline || null,
    turnToken: crypto.randomUUID(),
    stateVersion: Number(roomDoc.stateVersion) || 1,
    status: roomDoc.status || 'waiting',
    startedAt: roomDoc.startedAt || null,
    endedAt: roomDoc.endedAt || null,
    lastActivityAt: roomDoc.lastActivityAt ? new Date(roomDoc.lastActivityAt).getTime() : Date.now(),
    winner: roomDoc.winner || null,
    ...overrides
  };
};

/**
 * Format clean, safe room state payload for clients
 */
const roomDocSafe = (r) => ({
  roomId: r.roomId,
  players: r.players,
  status: r.status,
  stakeAmount: r.stakeAmount,
  prizeAmount: r.prizeAmount,
  maxPlayers: r.maxPlayers,
  currentTurnPlayerId: r.currentTurnPlayerId,
  currentTurnIndex: r.currentTurnIndex,
  hasRolledDice: r.hasRolledDice,
  currentDiceValue: r.currentDiceValue,
  isProcessingMove: r.isProcessingMove,
  isEnded: r.isEnded,
  turnDeadline: r.turnDeadline,
  startedAt: r.startedAt,
  lastActivityAt: r.lastActivityAt,
  stateVersion: r.stateVersion
});

export const initializeBattleSocket = (io) => {
  // Guard against duplicate initialization
  if (io.__battleSocketInitialized) {
    return io.__battleNamespace;
  }
  io.__battleSocketInitialized = true;

  // Single Authoritative Namespace for Battle
  const battleNamespace = io.of('/battle');
  io.__battleNamespace = battleNamespace;

  // ===========================================================================
  // 1. MANDATORY JWT AUTHENTICATION MIDDLEWARE (Strict Zero-Trust)
  // ===========================================================================
  battleNamespace.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
        socket.handshake.query?.token;

      if (!token) {
        return next(new Error('Authentication failed: Missing JWT access token'));
      }

      const decoded = jwt.verify(token, ENV.JWT_ACCESS_SECRET);
      const authenticatedId = getPlayerCleanId(decoded?._id || decoded?.id || decoded?.userId);

      if (!authenticatedId) {
        return next(new Error('Authentication failed: Invalid user ID in token'));
      }

      socket.userId = authenticatedId;
      next();
    } catch (err) {
      console.warn(`[BattleSocket Auth] Connection rejected for socket ${socket.id}:`, err.message);
      return next(new Error(`Authentication failed: ${err.message}`));
    }
  });

  // ===========================================================================
  // 2. BROADCAST DISPATCHER (Strictly /battle Namespace Only - Zero Duplicates)
  // ===========================================================================

  const emitToBattleRoom = (roomId, event, data) => {
    if (!roomId) return;
    const rId = roomId.toString().trim().toUpperCase();
    battleNamespace.to(rId).emit(event, data);
  };

  const emitToUser = (targetUserId, event, data) => {
    if (!targetUserId) return;
    const cleanId = getPlayerCleanId(targetUserId);
    battleNamespace.to(`battle_user_${cleanId}`).emit(event, data);
  };

  const emitLobbyUpdate = (event, payload) => {
    battleNamespace.emit(event, payload);
  };

  // ===========================================================================
  // 3. PERSISTENCE QUEUE WITH IMMUTABLE SNAPSHOTS & SEQUENTIAL WRITES
  // ===========================================================================

  const persistRoomState = (roomState) => {
    if (!roomState || !roomState.roomId) return Promise.resolve();
    const rId = roomState.roomId;

    // Create an immutable deep snapshot of the room state at this exact moment
    const snapshot = structuredClone(roomState);

    const previousPromise = roomPersistenceQueues.get(rId) || Promise.resolve();
    const currentTask = previousPromise
      .catch(() => { })
      .then(async () => {
        // 1. Authoritative MongoDB write first with State Version Guard
        const updateDoc = {
          $set: {
            players: snapshot.players,
            currentTurnIndex: snapshot.currentTurnIndex,
            currentTurnPlayerId: snapshot.currentTurnPlayerId,
            hasRolledDice: snapshot.hasRolledDice,
            currentDiceValue: snapshot.currentDiceValue,
            status: snapshot.status,
            isEnded: Boolean(snapshot.isEnded),
            turnDeadline: snapshot.turnDeadline || null,
            startedAt: snapshot.startedAt || null,
            endedAt: snapshot.endedAt || null,
            lastActivityAt: snapshot.lastActivityAt ? new Date(snapshot.lastActivityAt) : new Date(),
            stateVersion: snapshot.stateVersion,
            updatedAt: new Date()
          }
        };

        if (snapshot.winner) {
          updateDoc.$set.winner = snapshot.winner;
        } else {
          updateDoc.$unset = { winner: 1 };
        }

        const result = await BattleRoom.updateOne(
          {
            roomId: rId,
            $or: [
              { stateVersion: { $lte: snapshot.stateVersion } },
              { stateVersion: { $exists: false } }
            ]
          },
          updateDoc
        );

        if (result && result.matchedCount === 0) {
          console.warn(`[BattleSocket] Persistence skipped for ${rId}, stateVersion=${snapshot.stateVersion}`);
          return;
        }

        // 2. Sync Redis cache snapshot only after successful Mongo write
        await CacheService.set(`battle:room:${rId}`, snapshot, 7200);
      })
      .catch((err) => {
        console.warn(`[BattleSocket] Error persisting room ${rId}:`, err.message);
      });

    roomPersistenceQueues.set(rId, currentTask);
    return currentTask;
  };

  // ===========================================================================
  // 4. TIMER & CLEANUP MANAGEMENT
  // ===========================================================================

  const clearRoomTimers = (roomId) => {
    const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
    if (!rId) return;

    if (turnTimers.has(rId)) {
      clearTimeout(turnTimers.get(rId));
      turnTimers.delete(rId);
    }
  };

  const clearReconnectTimer = (roomId, userId) => {
    const key = `${roomId}_${getPlayerCleanId(userId)}`;
    if (reconnectTimers.has(key)) {
      clearTimeout(reconnectTimers.get(key));
      reconnectTimers.delete(key);
    }
  };

  const clearRoomReconnectTimers = (roomOrRoomId) => {
    const rId = typeof roomOrRoomId === 'object' ? roomOrRoomId?.roomId : roomOrRoomId;
    const room = typeof roomOrRoomId === 'object' ? roomOrRoomId : activeBattleRooms.get(rId);
    if (!rId) return;

    if (room?.players) {
      for (const player of room.players) {
        clearReconnectTimer(rId, getPlayerCleanId(player));
      }
    }
  };

  const handleTurnTimeout = async (roomId) => {
    return executeRoomAction(roomId, async () => {
      const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
      const room = activeBattleRooms.get(rId);
      if (!room || room.status !== 'playing' || room.isEnded) return;

      const currentPlayer = room.players[room.currentTurnIndex];
      if (!currentPlayer) return;

      currentPlayer.missedTurns = (currentPlayer.missedTurns || 0) + 1;
      touchRoom(room);
      console.log(`⚠️ [Turn Timeout] Room: ${rId}, Player: ${currentPlayer.name} missed turn (${currentPlayer.missedTurns}/3)`);

      emitToBattleRoom(rId, 'battle:turn_missed', {
        roomId: rId,
        userId: currentPlayer.userId,
        missedTurns: currentPlayer.missedTurns,
        maxMissedTurns: 3
      });

      // 3 consecutive missed turns = forfeit match, award win to opponent
      if (currentPlayer.missedTurns >= 3) {
        console.log(`❌ [Battle Timeout Forfeit] Player ${currentPlayer.name} reached 3 missed turns in Room ${rId}`);
        const cUid = getPlayerCleanId(currentPlayer);
        const opponent = room.players.find((p) => getPlayerCleanId(p) !== cUid);
        if (opponent) {
          await settleGameEndInternal(rId, opponent.userId, 'timeout_forfeit');
          return;
        }
      }

      // Pass turn to next player
      advanceTurn(rId, false);
    });
  };

  const startTurnTimer = (roomId, existingDeadline = null) => {
    const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
    if (!rId) return;

    clearRoomTimers(rId);

    const room = activeBattleRooms.get(rId);
    if (!room || room.status !== 'playing' || room.isEnded) return;

    let deadline;
    let remainingMs;

    if (existingDeadline) {
      deadline = new Date(existingDeadline);
      remainingMs = deadline.getTime() - Date.now();
      if (remainingMs <= 0) {
        console.warn(`[startTurnTimer] Turn deadline already expired for ${rId}, processing timeout immediately.`);
        handleTurnTimeout(rId);
        return;
      }
    } else {
      deadline = new Date(Date.now() + TURN_DURATION_MS);
      remainingMs = TURN_DURATION_MS;
    }

    room.turnDeadline = deadline;
    touchRoom(room);

    emitToBattleRoom(rId, 'battle:timer_tick', {
      roomId: rId,
      duration: Math.ceil(remainingMs / 1000),
      deadline: deadline.toISOString(),
      currentTurnPlayerId: room.currentTurnPlayerId
    });

    const token = rotateTurnToken(room);
    const timer = setTimeout(() => {
      const currentRoom = activeBattleRooms.get(rId);
      if (!currentRoom || currentRoom.turnToken !== token || currentRoom.status !== 'playing' || currentRoom.isEnded) {
        return;
      }
      handleTurnTimeout(rId);
    }, remainingMs);

    turnTimers.set(rId, timer);
  };

  const advanceTurn = (roomId, isExtraTurn = false) => {
    const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
    const room = activeBattleRooms.get(rId);
    if (!room || room.status !== 'playing' || room.isEnded) return;
    if (!room.players || room.players.length < 2) return;

    room.hasRolledDice = false;
    room.currentDiceValue = null;
    room.isProcessingMove = false;
    touchRoom(room);
    rotateTurnToken(room);

    if (!isExtraTurn) {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    }

    const nextPlayer = room.players[room.currentTurnIndex];
    if (nextPlayer) {
      room.currentTurnPlayerId = nextPlayer.userId;
    }

    emitToBattleRoom(rId, 'battle:turn_changed', {
      roomId: rId,
      currentTurnIndex: room.currentTurnIndex,
      currentTurnPlayerId: room.currentTurnPlayerId,
      player: {
        userId: nextPlayer?.userId,
        name: nextPlayer?.name,
        color: nextPlayer?.color
      },
      isExtraTurn
    });

    startTurnTimer(rId);
    persistRoomState(room);
  };

  /**
   * Internal Settlement Execution (Invoked directly when ALREADY inside executeRoomAction)
   */
  const settleGameEndInternal = async (roomId, winnerUserId, reason = 'win') => {
    const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
    clearRoomTimers(rId);

    let room = activeBattleRooms.get(rId);
    if (!room) {
      const cached = await CacheService.get(`battle:room:${rId}`);
      if (cached) {
        room = createRoomState(cached);
      } else {
        const dbRoom = await BattleRoom.findOne({ roomId: rId });
        if (dbRoom) room = createRoomState(dbRoom);
      }
    }

    // In-memory atomic guard
    if (!room || room.status === 'completed' || room.status === 'settling' || room.isEnded) {
      return;
    }

    const cleanWinnerId = getPlayerCleanId(winnerUserId);
    // Strict exact winner verification
    const winner = room.players.find((p) => getPlayerCleanId(p) === cleanWinnerId);
    if (!winner) {
      console.error(`❌ [settleGameEndInternal] Invalid winner ID ${cleanWinnerId} for room ${rId}. Winner must be an active room player.`);
      return;
    }

    // DB-level atomic state claim (Claims if in playing, waiting, ready, or previous failed settlement)
    const claimedDbRoom = await BattleRoom.findOneAndUpdate(
      { roomId: rId, status: { $in: ['playing', 'waiting', 'ready', 'settlement_failed'] } },
      { $set: { status: 'settling', updatedAt: new Date() } },
      { new: true }
    );

    if (!claimedDbRoom) {
      return;
    }

    room.status = 'settling';
    room.winner = {
      userId: winner.userId || cleanWinnerId,
      name: winner.name || 'Winner',
      color: winner.color || 'red',
      avatar: winner.avatar || ''
    };
    touchRoom(room);

    const finalWinnerId = winner.userId || cleanWinnerId;
    console.log(`🏆 [Battle Game End] Room: ${rId}, Winner: ${winner.name} (${finalWinnerId}), Reason: ${reason}`);

    // Persist finalized match outcome to DB & credit prize to winner
    try {
      await BattleService.finalizeMatchOutcome(rId, finalWinnerId, reason);
      room.status = 'completed';
      room.isEnded = true;
      room.endedAt = new Date();

      const gameOverData = {
        roomId: rId,
        winner: {
          userId: finalWinnerId,
          name: winner?.name,
          color: winner?.color,
          avatar: winner?.avatar,
          prizeWon: room.prizeAmount
        },
        prizeAmount: room.prizeAmount,
        reason,
        endedAt: room.endedAt.toISOString()
      };

      // Emit game_over strictly AFTER successful DB settlement
      emitToBattleRoom(rId, 'battle:game_over', gameOverData);

      // Parallel wallet updates to all participants
      await Promise.allSettled(
        room.players.map(async (p) => {
          const pUid = getPlayerCleanId(p);
          if (!pUid) return;
          clearReconnectTimer(rId, pUid);
          userToActiveRoomMap.delete(pUid);

          const wDetails = await BattleService.getWalletDetails(pUid).catch(() => null);
          if (wDetails) {
            emitToUser(pUid, 'battle:wallet_updated', { wallet: wDetails });
          }
        })
      );
    } catch (err) {
      console.error('❌ Error finalizing battle settlement in DB:', err);
      room.status = 'settlement_failed';
      // Do NOT set isEnded = true on failure so sweeper does not purge un-settled room
      emitToBattleRoom(rId, 'battle:error', { message: 'Settlement processing error. Support notified.' });
    }

    await persistRoomState(room);

    // Clean up memory only after persistence queue settles and if successfully ended
    if (room.isEnded) {
      const pendingQueue = roomPersistenceQueues.get(rId) || Promise.resolve();
      pendingQueue.finally(() => {
        setTimeout(() => {
          activeBattleRooms.delete(rId);
          roomPersistenceQueues.delete(rId);
          CacheService.del(`battle:room:${rId}`).catch(() => { });
        }, 5000);
      });
    }
  };

  /**
   * Handle Match Conclusion & Guaranteed Atomic Settlement (External wrapper with mutex queue)
   */
  const handleGameEnd = async (roomId, winnerUserId, reason = 'win') => {
    return executeRoomAction(roomId, () => settleGameEndInternal(roomId, winnerUserId, reason));
  };

  // ===========================================================================
  // 5. PERIODIC MEMORY SWEEPER & SETTLEMENT RETRY (Only purges cleanly completed rooms)
  // ===========================================================================
  const sweepInterval = setInterval(async () => {
    const now = Date.now();
    for (const [roomId, room] of activeBattleRooms.entries()) {
      // Auto-retry any transient settlement failures
      if (room.status === 'settlement_failed' && !room.isEnded) {
        console.log(`🔄 [Sweeper Retry] Retrying failed settlement for room: ${roomId}`);
        const winnerId = room.winner?.userId;
        if (winnerId) {
          handleGameEnd(roomId, winnerId, 'settlement_retry');
        }
        continue;
      }

      // Purge only cleanly completed or expired rooms (Never purge unsettled rooms)
      if (
        (room.status === 'completed' && room.isEnded) ||
        (room.status === 'cancelled') ||
        (room.status !== 'settlement_failed' && room.status !== 'settling' && now - (room.lastActivityAt || now) > ROOM_INACTIVITY_TTL_MS)
      ) {
        console.log(`🧹 [Sweeper] Purging stale room from memory: ${roomId}`);
        clearRoomTimers(roomId);
        clearRoomReconnectTimers(room || roomId);
        if (room.players) {
          room.players.forEach((p) => userToActiveRoomMap.delete(getPlayerCleanId(p)));
        }
        activeBattleRooms.delete(roomId);
        roomPersistenceQueues.delete(roomId);
      }
    }

    for (const [stake, queue] of automatchQueues.entries()) {
      if (!queue || queue.size === 0) {
        automatchQueues.delete(stake);
      }
    }
  }, 5 * 60 * 1000);

  if (typeof sweepInterval.unref === 'function') {
    sweepInterval.unref();
  }

  /**
   * Startup Recovery: Automatically recover any rooms left in 'settling' or 'playing' status after a crash
   */
  const runStartupRecovery = async () => {
    try {
      // 1. Recover stuck settling rooms
      const stuckRooms = await BattleRoom.find({ status: 'settling' });
      for (const r of stuckRooms) {
        const winRefId = `BATTLE_WIN_${r.roomId}`;
        const existingWinTx = await BattleTransaction.findOne({ referenceId: winRefId });

        if (existingWinTx) {
          console.log(`🛠️ [Startup Recovery] Room ${r.roomId} was already settled in wallet. Marking completed.`);
          r.status = 'completed';
          r.isEnded = true;
          r.endedAt = r.endedAt || new Date();
          await r.save();
        } else if (r.winner?.userId) {
          console.log(`🛠️ [Startup Recovery] Retrying settlement for stuck room ${r.roomId}`);
          try {
            await BattleService.finalizeMatchOutcome(r.roomId, r.winner.userId, 'startup_recovery');
            const refreshed = await BattleRoom.findOne({ roomId: r.roomId });
            if (refreshed) {
              refreshed.status = 'completed';
              refreshed.isEnded = true;
              refreshed.endedAt = refreshed.endedAt || new Date();
              await refreshed.save();
            }
          } catch (settleErr) {
            console.error(`❌ [Startup Recovery] Settlement retry failed for ${r.roomId}:`, settleErr.message);
            await BattleRoom.updateOne(
              { roomId: r.roomId, status: 'settling' },
              { $set: { status: 'settlement_failed', updatedAt: new Date() } }
            );
          }
        } else {
          console.log(`🛠️ [Startup Recovery] Marking room ${r.roomId} as settlement_failed for sweeper retry.`);
          r.status = 'settlement_failed';
          await r.save();
        }
      }

      // 2. Recover active 'playing' rooms across server restarts
      const activePlayingRooms = await BattleRoom.find({ status: 'playing', isEnded: { $ne: true } });
      const now = Date.now();
      for (const r of activePlayingRooms) {
        console.log(`🛠️ [Startup Recovery] Hydrating active playing room ${r.roomId}`);
        const roomState = createRoomState(r, { status: 'playing' });

        // Repair player-turn synchronization if corrupted
        if (roomState.players && roomState.players.length > 0) {
          if (roomState.currentTurnIndex >= roomState.players.length || roomState.currentTurnIndex < 0) {
            roomState.currentTurnIndex = 0;
          }
          const currentP = roomState.players[roomState.currentTurnIndex];
          if (currentP) {
            roomState.currentTurnPlayerId = currentP.userId;
          }
        }

        activeBattleRooms.set(r.roomId, roomState);
        roomState.players.forEach((p) => {
          const uid = getPlayerCleanId(p);
          if (uid) userToActiveRoomMap.set(uid, r.roomId);
        });

        // Inspect turnDeadline and restore timer
        const deadlineTime = r.turnDeadline ? new Date(r.turnDeadline).getTime() : 0;
        if (deadlineTime && deadlineTime <= now) {
          console.log(`⚠️ [Startup Recovery] Turn deadline expired during restart for room ${r.roomId}, processing timeout.`);
          handleTurnTimeout(r.roomId);
        } else {
          if (!deadlineTime) {
            console.warn(`[Startup Recovery] Missing turnDeadline for ${r.roomId}; starting fresh turn timer`);
          }
          startTurnTimer(r.roomId, r.turnDeadline);
        }
      }
    } catch (err) {
      console.warn('⚠️ [Startup Recovery] Error running startup recovery:', err.message);
    }
  };

  runStartupRecovery();

  // ===========================================================================
  // 6. CORE SOCKET HANDLERS
  // ===========================================================================
  const setupBattleHandlers = (socket) => {
    if (socket.__battleInitialized) return;
    socket.__battleInitialized = true;

    console.log(`⚔️ [Battle Socket Connected] ID: ${socket.id}, User: ${socket.userId}`);

    /**
     * User registration with Idempotent Guard & O(1) Active Room Lookup
     */
    const handleBattleUserJoin = () => {
      const cleanId = socket.userId;
      if (!cleanId) return;

      if (socket.rooms.has(`battle_user_${cleanId}`)) {
        return;
      }

      if (!userActiveSockets.has(cleanId)) {
        userActiveSockets.set(cleanId, new Set());
      }
      userActiveSockets.get(cleanId).add(socket.id);

      socket.join(cleanId);
      socket.join(`user_${cleanId}`);
      socket.join(`battle_user_${cleanId}`);

      // O(1) instant active room lookup
      const activeRoomId = userToActiveRoomMap.get(cleanId);
      if (activeRoomId) {
        const room = activeBattleRooms.get(activeRoomId);
        if (room && room.status === 'playing') {
          clearReconnectTimer(activeRoomId, cleanId);
          socket.join(activeRoomId);
          emitToBattleRoom(activeRoomId, 'battle:player_reconnected', {
            roomId: activeRoomId,
            userId: cleanId,
            message: 'Player reconnected'
          });
        }
      }

      // Send live online players list strictly once
      BattleService.getOnlinePlayers(cleanId)
        .then((players) => {
          socket.emit('battle:online_players', { success: true, players, data: players, count: players.length });
        })
        .catch(() => { });
    };

    socket.on('battle:register', handleBattleUserJoin);

    // Auto-register upon verified connection
    handleBattleUserJoin();

    // ==========================================
    // AUTOMATCH MATCHMAKING (With Rollback Safety)
    // ==========================================
    socket.on('battle:join_automatch', async (data) => {
      let createdRoomId = null;
      try {
        const { name, avatar, stakeAmount = 50 } = data || {};
        const effectiveUserId = socket.userId;
        const stake = Number(stakeAmount);
        const MIN_STAKE = 10;
        const MAX_STAKE = 50000;

        if (!Number.isInteger(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
          return socket.emit('battle:error', { message: `Invalid stake amount. Must be an integer between ₹${MIN_STAKE} and ₹${MAX_STAKE}` });
        }

        socket.join(`battle_user_${effectiveUserId}`);

        if (!automatchQueues.has(stake)) {
          automatchQueues.set(stake, new Map());
        }

        const queue = automatchQueues.get(stake);
        queue.delete(effectiveUserId);

        console.log(`🎮 [AutoMatch Search] User: ${name || effectiveUserId} joined Queue for ₹${stake} stake`);

        // Iterate queue to find first online candidate
        let opponent = null;
        for (const [candidateId, candidate] of queue.entries()) {
          queue.delete(candidateId);
          const isCandidateOnline = userActiveSockets.has(candidateId) && userActiveSockets.get(candidateId).size > 0;
          if (isCandidateOnline && candidateId !== effectiveUserId) {
            opponent = candidate;
            break;
          }
        }

        if (opponent) {
          const roomId = generateSecureRoomCode();

          try {
            // Deduct User 1 entry fee on backend
            const hostRoom = await BattleService.createBattleRoom(opponent.userId, opponent, {
              stakeAmount: stake,
              roomType: 'automatch',
              customCode: roomId
            });
            createdRoomId = hostRoom.roomId;

            // Deduct User 2 entry fee on backend
            const joinRes = await BattleService.joinBattleRoom(effectiveUserId, { name, avatar }, createdRoomId);
            const roomDoc = joinRes.room;
            const roomState = createRoomState(roomDoc, { status: 'playing' });

            activeBattleRooms.set(createdRoomId, roomState);
            userToActiveRoomMap.set(opponent.userId, createdRoomId);
            userToActiveRoomMap.set(effectiveUserId, createdRoomId);

            socket.join(createdRoomId);
            battleNamespace.in(`battle_user_${opponent.userId}`).socketsJoin(createdRoomId);

            const matchData = {
              roomId: createdRoomId,
              stakeAmount: roomState.stakeAmount,
              prizeAmount: roomState.prizeAmount,
              players: roomState.players,
              currentTurnPlayerId: roomState.players[0].userId,
              status: 'playing',
              message: 'Opponent matched! Game is starting!'
            };

            emitToBattleRoom(createdRoomId, 'battle:game_start', matchData);
            startTurnTimer(createdRoomId);
            persistRoomState(roomState);
          } catch (matchErr) {
            console.error('❌ Matchmaking Join/Create Error, initiating rollback & requeue:', matchErr);
            if (createdRoomId) {
              await BattleService.refundAndCancelRoom(createdRoomId, 'automatch_failed').catch(() => { });
            }
            // Re-queue opponent back to matchmaking queue so search isn't lost
            if (opponent) {
              queue.set(opponent.userId, opponent);
              emitToUser(opponent.userId, 'battle:searching_opponent', { stake, message: 'Matchmaking reconnecting...' });
            }
            // Re-queue initiating user
            queue.set(effectiveUserId, {
              socketId: socket.id,
              userId: effectiveUserId,
              name,
              avatar,
              stake,
              joinedAt: Date.now()
            });
            socket.emit('battle:searching_opponent', { stake, message: 'Matchmaking reconnecting...' });
          }
        } else {
          queue.set(effectiveUserId, {
            socketId: socket.id,
            userId: effectiveUserId,
            name,
            avatar,
            stake,
            joinedAt: Date.now()
          });
          socket.emit('battle:searching_opponent', { stake, message: 'Searching for an online challenger...' });
        }
      } catch (err) {
        console.error('❌ AutoMatch Error:', err);
        socket.emit('battle:error', { message: err.message || 'Matchmaking error' });
      }
    });

    socket.on('battle:cancel_automatch', ({ stakeAmount = 50 }) => {
      const effectiveUserId = socket.userId;
      const stake = Number(stakeAmount) || 50;
      const queue = automatchQueues.get(stake);
      if (queue && effectiveUserId) {
        queue.delete(effectiveUserId);
        console.log(`❌ [AutoMatch Cancelled] User: ${effectiveUserId} left ₹${stake} queue`);
      }
      socket.emit('battle:automatch_cancelled', { success: true });
    });

    // ==========================================
    // CUSTOM ROOMS & DIRECT CHALLENGE
    // ==========================================
    socket.on('battle:create_room', async (data, callback) => {
      try {
        const { userDetails, stakeAmount = 50, customCode, targetUserId, opponentUserId, opponent } = data || {};
        const effectiveUserId = socket.userId;

        let roomDoc = null;
        const normalizedCode = customCode ? customCode.toString().trim().toUpperCase() : null;

        if (normalizedCode) {
          const existingActive = activeBattleRooms.get(normalizedCode);
          if (existingActive) {
            const isCreator = getPlayerCleanId(existingActive.creator || existingActive.players?.[0]?.userId) === effectiveUserId;
            if (!isCreator) {
              throw new Error('This room code belongs to another player');
            }
            const resp = { success: true, room: roomDocSafe(existingActive), roomId: normalizedCode };
            if (typeof callback === 'function') callback(resp);
            return socket.emit('battle:room_created', resp);
          }

          roomDoc = await BattleRoom.findOne({ roomId: normalizedCode, status: { $in: ['waiting', 'ready'] } });
          if (roomDoc && getPlayerCleanId(roomDoc.creator) !== effectiveUserId) {
            throw new Error('This room code belongs to another player');
          }
        }

        const targetOpponentId = targetUserId || opponentUserId || opponent?.userId || opponent?._id || opponent?.id;
        const cleanTargetId = targetOpponentId ? getPlayerCleanId(targetOpponentId) : null;

        if (!roomDoc) {
          roomDoc = await BattleService.createBattleRoom(effectiveUserId, userDetails, {
            stakeAmount,
            roomType: 'custom',
            customCode: normalizedCode || generateSecureRoomCode(),
            challengeTargetUserId: cleanTargetId
          });
        }

        socket.join(roomDoc.roomId);
        socket.join(`battle_user_${effectiveUserId}`);

        const roomState = createRoomState(roomDoc, { status: 'waiting' });
        activeBattleRooms.set(roomDoc.roomId, roomState);
        userToActiveRoomMap.set(effectiveUserId, roomDoc.roomId);

        const resp = { success: true, room: roomDocSafe(roomState), roomId: roomDoc.roomId };
        if (typeof callback === 'function') callback(resp);
        socket.emit('battle:room_created', resp);

        // Lobby broadcast
        const lobbyRoom = {
          id: roomDoc._id || roomDoc.roomId,
          roomId: roomDoc.roomId,
          roomCode: roomDoc.roomId,
          hostUserId: effectiveUserId,
          hostName: userDetails?.name || 'Host',
          hostAvatar: userDetails?.avatar || '',
          hostCity: userDetails?.city || 'Arena',
          stake: Number(stakeAmount || 50),
          playerCount: roomDoc.players?.length || 1,
          maxPlayers: Number(roomDoc.maxPlayers || 2),
          currentSlots: roomDoc.players?.length || 1,
          prize: Number(roomDoc.prizeAmount || 90),
          createdAt: 'Active Now',
          status: 'WAITING',
          isUserCreated: true
        };
        emitLobbyUpdate('battle:lobby_room_created', lobbyRoom);

        if (cleanTargetId && cleanTargetId !== effectiveUserId) {
          const hostP = roomState.players.find((p) => getPlayerCleanId(p) === effectiveUserId) || roomState.players[0];
          const challengePayload = {
            challenger: {
              userId: effectiveUserId,
              name: hostP?.name || userDetails?.name || 'Challenger',
              avatar: hostP?.avatar || userDetails?.avatar || ''
            },
            targetUserId: cleanTargetId,
            stakeAmount: roomDoc.stakeAmount,
            prizeAmount: roomDoc.prizeAmount,
            roomId: roomDoc.roomId,
            timestamp: new Date().toISOString()
          };
          emitToUser(cleanTargetId, 'battle:incoming_challenge', challengePayload);
        }
      } catch (err) {
        console.error('❌ Error creating battle room:', err);
        const errResp = { success: false, message: err.message };
        if (typeof callback === 'function') callback(errResp);
        socket.emit('battle:error', errResp);
      }
    });

    socket.on('battle:join_room', async (data, callback) => {
      try {
        const { userDetails, roomId } = data || {};
        const effectiveUserId = socket.userId;
        if (!roomId) throw new Error('Room ID required');

        const normalizedRoom = roomId.toString().trim().toUpperCase();
        const { room } = await BattleService.joinBattleRoom(effectiveUserId, userDetails, normalizedRoom);

        socket.join(room.roomId);
        socket.join(`battle_user_${effectiveUserId}`);

        const maxPlayers = room.maxPlayers || 2;
        const isGameReady = room.players.length >= maxPlayers;
        const roomState = createRoomState(room, { status: isGameReady ? 'playing' : room.status });

        activeBattleRooms.set(room.roomId, roomState);
        room.players.forEach((p) => {
          const pUid = getPlayerCleanId(p);
          if (pUid) userToActiveRoomMap.set(pUid, room.roomId);
        });

        const currentSlots = roomState.players.length;

        emitToBattleRoom(room.roomId, 'battle:player_joined', {
          roomId: room.roomId,
          players: roomState.players,
          maxPlayers,
          currentSlots,
          joinedPlayer: { userId: effectiveUserId, ...userDetails }
        });

        // Start game when all slots are full
        if (isGameReady && room.status === 'playing') {
          console.log(`🚀 [Battle Ready] All ${maxPlayers} players joined room ${room.roomId}! Starting match.`);

          const startPayload = {
            roomId: room.roomId,
            stakeAmount: roomState.stakeAmount,
            prizeAmount: roomState.prizeAmount,
            players: roomState.players,
            maxPlayers,
            currentTurnPlayerId: roomState.currentTurnPlayerId || roomState.players[0].userId,
            status: 'playing',
            message: 'All players joined! Battle is starting!'
          };

          emitToBattleRoom(room.roomId, 'battle:game_start', startPayload);
          startTurnTimer(room.roomId);
          persistRoomState(roomState);
        }

        const resp = { success: true, room: roomDocSafe(roomState), roomId: room.roomId };
        if (typeof callback === 'function') callback(resp);
        socket.emit('battle:room_joined', resp);
      } catch (err) {
        console.error('❌ Error joining battle room:', err);
        const errResp = { success: false, message: err.message };
        if (typeof callback === 'function') callback(errResp);
        socket.emit('battle:error', errResp);
      }
    });

    socket.on('battle:challenge_player', async (data, callback) => {
      try {
        const { targetUserId, opponentUserId, opponent, challenger, stakeAmount, customCode, roomId: clientRoomId } = data || {};
        const targetId = getPlayerCleanId(targetUserId || opponentUserId || opponent?.userId || opponent?._id || opponent?.id);
        const effectiveUserId = socket.userId;

        if (!targetId) return;

        // Prevent self-challenge
        if (targetId === effectiveUserId) {
          const errResp = { success: false, message: 'You cannot challenge yourself' };
          if (typeof callback === 'function') callback(errResp);
          return socket.emit('battle:error', errResp);
        }

        const stake = Number(stakeAmount) || 50;
        const prize = Math.floor(stake * 1.8);
        const roomId = clientRoomId || (customCode ? customCode.toUpperCase() : generateSecureRoomCode());

        // Create the room upfront so accept_challenge always finds it
        let roomDoc = await BattleRoom.findOne({ roomId });
        if (!roomDoc) {
          roomDoc = await BattleService.createBattleRoom(effectiveUserId, challenger, {
            stakeAmount: stake,
            roomType: 'custom',
            customCode: roomId,
            challengeTargetUserId: targetId
          });
        }

        socket.join(roomDoc.roomId);
        socket.join(`battle_user_${effectiveUserId}`);

        const roomState = createRoomState(roomDoc, { status: 'waiting' });
        activeBattleRooms.set(roomDoc.roomId, roomState);
        userToActiveRoomMap.set(effectiveUserId, roomDoc.roomId);

        const hostP = roomState.players.find((p) => getPlayerCleanId(p) === effectiveUserId) || roomState.players[0];
        const payload = {
          challenger: {
            userId: effectiveUserId,
            name: hostP?.name || challenger?.name || 'Challenger',
            avatar: hostP?.avatar || challenger?.avatar || ''
          },
          targetUserId: targetId,
          stakeAmount: roomDoc.stakeAmount,
          prizeAmount: roomDoc.prizeAmount,
          roomId: roomDoc.roomId,
          timestamp: new Date().toISOString()
        };

        emitToUser(targetId, 'battle:incoming_challenge', payload);
        socket.emit('battle:challenge_sent', payload);

        if (typeof callback === 'function') {
          callback({ success: true, roomId: roomDoc.roomId, payload });
        }
      } catch (err) {
        console.error('❌ Error in battle:challenge_player:', err);
        if (typeof callback === 'function') callback({ success: false, message: err.message });
      }
    });

    // Synchronized accept_challenge with strict target verification and player count check
    socket.on('battle:accept_challenge', async (data, callback) => {
      try {
        const { roomId, userDetails } = data || {};
        const effectiveUserId = socket.userId;
        const normalizedRoom = roomId ? roomId.toString().trim().toUpperCase() : '';
        if (!normalizedRoom) throw new Error('Room ID required');

        // Check if room has target player authorization
        let cachedRoom = activeBattleRooms.get(normalizedRoom);
        if (!cachedRoom) {
          const dbR = await BattleRoom.findOne({ roomId: normalizedRoom });
          if (dbR) cachedRoom = createRoomState(dbR);
        }

        if (cachedRoom?.challengeTargetUserId) {
          const cleanTarget = getPlayerCleanId(cachedRoom.challengeTargetUserId);
          if (cleanTarget && cleanTarget !== effectiveUserId) {
            throw new Error('You are not authorized to accept this challenge');
          }
        }

        // Authorize and join DB room FIRST before joining socket channels
        const { room } = await BattleService.joinBattleRoom(effectiveUserId, userDetails, normalizedRoom);

        socket.join(normalizedRoom);
        socket.join(`battle_user_${effectiveUserId}`);

        const isGameReady = room.players.length >= (room.maxPlayers || 2);
        const roomState = createRoomState(room, { status: isGameReady ? 'playing' : 'waiting' });

        activeBattleRooms.set(normalizedRoom, roomState);
        room.players.forEach((p) => {
          const pUid = getPlayerCleanId(p);
          if (pUid) userToActiveRoomMap.set(pUid, normalizedRoom);
        });

        // Derive authoritative challenger ID and joining opponent from room state
        const challengerPlayer = room.players.find((p) => p.isHost || getPlayerCleanId(p) !== effectiveUserId) || room.players[0];
        const authoritativeChallengerId = getPlayerCleanId(challengerPlayer?.userId || room.creator);
        const joiningOpponent = room.players.find((p) => getPlayerCleanId(p) === effectiveUserId) || userDetails;

        const payload = {
          roomId: normalizedRoom,
          opponent: joiningOpponent,
          challengerUserId: authoritativeChallengerId,
          room: roomDocSafe(roomState),
          status: roomState.status,
          isReady: isGameReady
        };

        if (isGameReady) {
          emitToBattleRoom(normalizedRoom, 'battle:game_start', payload);
          startTurnTimer(normalizedRoom);
        } else {
          emitToBattleRoom(normalizedRoom, 'battle:player_joined', payload);
        }

        persistRoomState(roomState);

        if (typeof callback === 'function') callback({ success: true, room: roomDocSafe(roomState) });
      } catch (err) {
        console.error('❌ Error in battle:accept_challenge:', err);
        if (typeof callback === 'function') callback({ success: false, message: err.message });
      }
    });

    socket.on('battle:reject_challenge', async (data, callback) => {
      try {
        const { roomId, reason = 'declined' } = typeof data === 'object' ? data : { roomId: data };
        const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
        const effectiveUserId = socket.userId;
        if (!rId) throw new Error('Room ID required');

        let room = activeBattleRooms.get(rId);
        if (!room) {
          const dbR = await BattleRoom.findOne({ roomId: rId });
          if (dbR) room = createRoomState(dbR);
        }

        if (!room) throw new Error('Room not found');
        if (room.status !== 'waiting') throw new Error('Cannot reject a battle room that is not waiting');

        const cleanTargetId = getPlayerCleanId(room.challengeTargetUserId);
        const hostPlayer = room.players?.find((p) => p.isHost) || room.players?.[0];
        const cleanCreatorId = getPlayerCleanId(room.creator || hostPlayer?.userId);

        // Security check: Only intended target or room creator can reject/cancel challenge
        if (cleanTargetId && effectiveUserId !== cleanTargetId && effectiveUserId !== cleanCreatorId) {
          throw new Error('You are not authorized to reject this challenge');
        }

        // Strictly await refund; if refund throws an error, do NOT cancel the room locally
        await BattleService.refundAndCancelRoom(rId, `challenge_${reason}`);

        room.status = 'cancelled';
        room.isEnded = true;

        activeBattleRooms.delete(rId);
        if (cleanCreatorId) userToActiveRoomMap.delete(cleanCreatorId);
        if (cleanTargetId) userToActiveRoomMap.delete(cleanTargetId);

        emitToBattleRoom(rId, 'battle:challenge_rejected', { roomId: rId, reason, rejectedBy: effectiveUserId });
        if (cleanCreatorId) {
          emitToUser(cleanCreatorId, 'battle:challenge_rejected', { roomId: rId, reason, rejectedBy: effectiveUserId });
        }

        if (typeof callback === 'function') callback({ success: true, roomId: rId });
      } catch (err) {
        console.warn('⚠️ [Battle] Error in reject_challenge:', err.message);
        if (typeof callback === 'function') callback({ success: false, message: err.message });
        socket.emit('battle:error', { message: err.message });
      }
    });

    // ==========================================
    // GAMEPLAY ENGINE: SECURE SERVER-SIDE DICE ROLL & MOVE PAWN
    // ==========================================
    socket.on('battle:roll_dice', async (data) => {
      const { roomId } = data || {};
      const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
      if (!rId) return;

      return executeRoomAction(rId, async () => {
        try {
          const effectiveUserId = socket.userId;
          const room = activeBattleRooms.get(rId);

          if (!room) return socket.emit('battle:error', { message: 'Room not active' });
          if (room.status !== 'playing' || room.isEnded) return socket.emit('battle:error', { message: 'Game is not in playing state' });

          const currentPlayer = room.players[room.currentTurnIndex];
          if (!currentPlayer || getPlayerCleanId(currentPlayer) !== effectiveUserId) {
            return socket.emit('battle:error', { message: 'Not your turn!' });
          }

          if (room.hasRolledDice || room.isProcessingMove) {
            return socket.emit('battle:error', { message: 'Dice already rolled or move in progress' });
          }

          // Clear turn timer immediately upon successful roll to prevent timer races
          clearRoomTimers(rId);

          const diceValue = rollFairDice();
          room.hasRolledDice = true;
          room.currentDiceValue = diceValue;
          touchRoom(room);
          currentPlayer.missedTurns = 0;

          // Persist immediately after dice state mutation
          persistRoomState(room);

          const validMoves = LudoEngine.getValidMoves(currentPlayer, diceValue);
          const canMoveAny = validMoves.some((m) => m.canMove);

          console.log(`🎲 [Dice Roll] Room: ${rId}, Player: ${currentPlayer.name} rolled ${diceValue}. Movable: ${canMoveAny}`);

          emitToBattleRoom(rId, 'battle:dice_rolled', {
            roomId: rId,
            userId: currentPlayer.userId,
            playerIndex: room.currentTurnIndex,
            diceValue,
            validMoves,
            canMoveAny
          });

          // If no pawn can move, auto pass turn safely with turnToken validation
          if (!canMoveAny) {
            room.isProcessingMove = true;
            const token = rotateTurnToken(room);
            setTimeout(() => {
              executeRoomAction(rId, async () => {
                const currentRoom = activeBattleRooms.get(rId);
                if (
                  currentRoom &&
                  currentRoom.turnToken === token &&
                  currentRoom.status === 'playing' &&
                  !currentRoom.isEnded
                ) {
                  advanceTurn(rId, false);
                }
              });
            }, 1200);
          }
        } catch (err) {
          console.error('❌ Error rolling dice:', err);
          const room = activeBattleRooms.get(rId);
          if (room && room.status === 'playing' && !room.isEnded && !turnTimers.has(rId)) {
            startTurnTimer(rId, room.turnDeadline);
          }
        }
      });
    });

    socket.on('battle:move_pawn', async (data) => {
      const { roomId, pawnIndex } = data || {};
      const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
      if (!rId) return;

      return executeRoomAction(rId, async () => {
        let room = null;
        try {
          const effectiveUserId = socket.userId;
          room = activeBattleRooms.get(rId);

          if (!room || room.status !== 'playing' || room.isEnded) return;

          const pIdx = Number(pawnIndex);
          if (!Number.isInteger(pIdx) || pIdx < 0 || pIdx > 3) {
            return socket.emit('battle:error', { message: 'Invalid pawn index (must be 0-3)' });
          }

          const currentPlayer = room.players[room.currentTurnIndex];
          if (!currentPlayer || getPlayerCleanId(currentPlayer) !== effectiveUserId) {
            return socket.emit('battle:error', { message: 'Not your turn!' });
          }

          if (!room.hasRolledDice || !room.currentDiceValue) {
            return socket.emit('battle:error', { message: 'Must roll dice first!' });
          }

          if (room.isProcessingMove) {
            return socket.emit('battle:error', { message: 'Move is already processing' });
          }

          room.isProcessingMove = true;
          const diceValue = room.currentDiceValue;
          const moveResult = LudoEngine.executeMove(room, room.currentTurnIndex, pIdx, diceValue);

          if (!moveResult.success) {
            room.isProcessingMove = false;
            return socket.emit('battle:error', { message: moveResult.message });
          }

          touchRoom(room);
          // Persist immediately after successful move mutation
          persistRoomState(room);

          console.log(`♟️ [Pawn Move] Room: ${rId}, Player: ${currentPlayer.name}, Pawn: ${pIdx}, Cut: ${moveResult.isCut}, ExtraTurn: ${moveResult.grantExtraTurn}`);

          emitToBattleRoom(rId, 'battle:pawn_moved', {
            roomId: rId,
            moveResult,
            players: room.players
          });

          if (moveResult.hasWon) {
            await settleGameEndInternal(rId, currentPlayer.userId, 'normal_win');
            return;
          }

          const token = rotateTurnToken(room);
          setTimeout(() => {
            executeRoomAction(rId, async () => {
              const currentRoom = activeBattleRooms.get(rId);
              if (
                currentRoom &&
                currentRoom.turnToken === token &&
                currentRoom.status === 'playing' &&
                !currentRoom.isEnded
              ) {
                advanceTurn(rId, moveResult.grantExtraTurn);
              }
            });
          }, 600);
        } catch (err) {
          console.error('❌ Error moving pawn:', err);
          if (room) room.isProcessingMove = false;
        }
      });
    });

    // ==========================================
    // CHAT & EMOJI (With Room Membership & Authenticated Sender Validation)
    // ==========================================
    socket.on('battle:send_emoji', ({ roomId, emoji }) => {
      const senderId = socket.userId;
      const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
      const room = activeBattleRooms.get(rId);

      if (!room) {
        return socket.emit('battle:error', { message: 'Room not found' });
      }

      const sender = room.players?.find((p) => getPlayerCleanId(p) === senderId);
      if (!sender) {
        return socket.emit('battle:error', { message: 'You are not a participant in this room' });
      }

      if (typeof emoji !== 'string' || emoji.trim().length === 0 || emoji.length > 20) {
        return socket.emit('battle:error', { message: 'Invalid emoji format' });
      }

      const senderName = sender.name || 'Player';
      emitToBattleRoom(rId, 'battle:emoji_received', { userId: senderId, emoji: emoji.trim(), name: senderName, timestamp: new Date() });
    });

    socket.on('battle:send_chat', async ({ roomId, message }) => {
      const senderId = socket.userId;
      const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
      const room = activeBattleRooms.get(rId);

      if (!room) {
        return socket.emit('battle:error', { message: 'Room not found' });
      }

      const sender = room.players?.find((p) => getPlayerCleanId(p) === senderId);
      if (!sender) {
        return socket.emit('battle:error', { message: 'You are not a participant in this room' });
      }

      if (typeof message !== 'string' || message.trim().length === 0 || message.length > 500) {
        return socket.emit('battle:error', { message: 'Message length must be between 1 and 500 characters' });
      }

      const senderName = sender.name || 'Player';
      const chatPayload = { userId: senderId, message: message.trim(), name: senderName, timestamp: new Date().toISOString() };
      emitToBattleRoom(rId, 'battle:chat_received', chatPayload);

      // Persist last 50 chat messages atomically in Redis list buffer
      try {
        await CacheService.rpushTrim(`battle:chat:${rId}`, chatPayload, 50, 3600);
      } catch (err) {
        console.warn(`[BattleChat] Failed to persist chat for ${rId}:`, err.message);
      }
    });

    socket.on('battle:sync_state', async ({ roomId }, callback) => {
      const rId = roomId ? roomId.toString().trim().toUpperCase() : '';
      const effectiveUserId = socket.userId;
      let room = activeBattleRooms.get(rId);

      if (!room && rId) {
        const cached = await CacheService.get(`battle:room:${rId}`);
        if (cached) {
          room = createRoomState(cached);
          rotateTurnToken(room);
        } else {
          const dbRoom = await BattleRoom.findOne({ roomId: rId });
          if (dbRoom) room = createRoomState(dbRoom);
        }

        if (room) {
          activeBattleRooms.set(rId, room);
          room.players?.forEach((p) => {
            const uid = getPlayerCleanId(p);
            if (uid) userToActiveRoomMap.set(uid, rId);
          });
          if (room.status === 'playing' && !turnTimers.has(rId) && !room.isEnded) {
            startTurnTimer(rId, room.turnDeadline);
          }
        }
      }

      if (!room) {
        const errResp = { success: false, message: 'Room not found' };
        if (typeof callback === 'function') callback(errResp);
        return socket.emit('battle:error', errResp);
      }

      // Membership authorization check
      const isParticipant = room.players?.some((p) => getPlayerCleanId(p) === effectiveUserId);
      if (!isParticipant) {
        const errResp = { success: false, message: 'You are not a participant in this room' };
        if (typeof callback === 'function') callback(errResp);
        return socket.emit('battle:error', errResp);
      }

      socket.join(rId);
      socket.join(`battle_user_${effectiveUserId}`);

      const data = { success: true, room: roomDocSafe(room) };
      if (typeof callback === 'function') callback(data);
      socket.emit('battle:state_synced', data);
    });

    /**
     * Unified Safe Forfeit / Leave Handler
     */
    const handleForfeitOrLeave = async (data, callback) => {
      const rawRoomId = typeof data === 'string' ? data : (data?.roomId || data?.roomCode || data?.code || '');
      const roomId = rawRoomId.toString().trim().toUpperCase();

      return executeRoomAction(roomId, async () => {
        try {
          const cleanUserId = getPlayerCleanId(typeof data === 'object' ? data?.userId : socket.userId) || socket.userId;

          if (!roomId || !cleanUserId) {
            if (typeof callback === 'function') callback({ success: false, message: 'Room ID required' });
            return;
          }

          console.log(`🚪 [Battle Leave / Forfeit Event] Room: ${roomId}, Action by: ${cleanUserId}`);

          let room = activeBattleRooms.get(roomId);
          if (!room) {
            const dbRoom = await BattleRoom.findOne({ roomId });
            if (dbRoom) room = createRoomState(dbRoom);
          }

          if (!room || room.status === 'completed' || room.status === 'cancelled' || room.isEnded) {
            if (typeof callback === 'function') callback({ success: true, message: 'Room already finished' });
            return;
          }

          const playersList = room.players || [];
          if (playersList.length === 0) {
            if (typeof callback === 'function') callback({ success: true, message: 'No players in room' });
            return;
          }

          const leavingPlayer = playersList.find((p) => getPlayerCleanId(p) === cleanUserId);
          const winningOpponent = playersList.find((p) => getPlayerCleanId(p) !== cleanUserId);

          if (!leavingPlayer) {
            console.warn(`⚠️ [Forfeit Rejected] User ${cleanUserId} is not in room ${roomId}`);
            if (typeof callback === 'function') {
              callback({ success: false, message: 'You are not an active player in this room' });
            }
            return;
          }

          const leaveData = {
            roomId,
            userId: getPlayerCleanId(leavingPlayer),
            opponentId: winningOpponent ? getPlayerCleanId(winningOpponent) : '',
            timestamp: new Date().toISOString()
          };

          emitToBattleRoom(roomId, 'battle:player_left', leaveData);

          // CASE 1: In-game forfeit -> Opponent WINS!
          if (playersList.length >= 2 && winningOpponent) {
            const winId = winningOpponent.userId;
            console.log(`🏆 [Battle Forfeit Outcome] Room: ${roomId} -> WINNER: ${winningOpponent.name} (${winId}) | FORFEITED BY: ${leavingPlayer?.name}`);
            await settleGameEndInternal(roomId, winId, 'opponent_forfeited');
          }
          // CASE 2: Single host leaving lobby -> Refund stake
          else if (room.status === 'waiting' || playersList.length <= 1) {
            console.log(`↩️ [Battle Cancelled / Refunded] Room: ${roomId}`);
            await BattleService.refundAndCancelRoom(roomId, 'creator_left');
            room.status = 'cancelled';
            room.isEnded = true;

            const cancelPayload = {
              id: room._id?.toString() || roomId,
              roomId,
              roomCode: roomId,
              status: 'CANCELLED',
              reason: 'host_left',
              timestamp: new Date().toISOString()
            };

            clearRoomTimers(roomId);
            clearRoomReconnectTimers(room || roomId);
            emitToBattleRoom(roomId, 'battle:room_cancelled', cancelPayload);
            emitLobbyUpdate('battle:lobby_room_removed', cancelPayload);
            activeBattleRooms.delete(roomId);
            userToActiveRoomMap.delete(cleanUserId);
          }

          if (typeof callback === 'function') {
            callback({ success: true, message: 'Room left/forfeited successfully', data: leaveData });
          }
        } catch (err) {
          console.error('❌ Error handling player forfeit/leave:', err);
          if (typeof callback === 'function') {
            callback({ success: false, error: err?.message });
          }
        }
      });
    };

    /**
     * Dedicated Cancel Battle Room Handler (Serialized via executeRoomAction)
     */
    const handleCancelBattleRoom = async (data, callback) => {
      const rawRoomId = typeof data === 'string' ? data : (data?.roomId || data?.roomCode || data?.code || '');
      const roomId = rawRoomId.toString().trim().toUpperCase();

      return executeRoomAction(roomId, async () => {
        try {
          const rawUserId = socket.userId;

          if (!roomId || !rawUserId) {
            if (typeof callback === 'function') callback({ success: false, message: 'Room ID & Auth required' });
            return;
          }

          console.log(`🚫 [Cancel Battle Room Socket Event] Room: ${roomId}, Initiator: ${rawUserId}`);

          let currentActive = activeBattleRooms.get(roomId);
          if (currentActive && currentActive.status === 'playing' && !currentActive.isEnded) {
            throw new Error('Cannot cancel an active playing game. Please forfeit instead.');
          }

          const room = await BattleService.cancelBattleRoom(roomId, rawUserId);
          if (currentActive) {
            currentActive.status = 'cancelled';
            currentActive.isEnded = true;
          }

          clearRoomTimers(roomId);
          clearRoomReconnectTimers(room || roomId);
          activeBattleRooms.delete(roomId);
          userToActiveRoomMap.delete(rawUserId);

          const cancelPayload = {
            id: room?._id?.toString() || roomId,
            roomId,
            roomCode: roomId,
            status: 'CANCELLED',
            reason: 'host_cancelled',
            timestamp: new Date().toISOString()
          };

          emitToBattleRoom(roomId, 'battle:room_cancelled', cancelPayload);
          emitLobbyUpdate('battle:lobby_room_removed', cancelPayload);

          const resp = { success: true, message: 'Battle room cancelled successfully', roomId, data: cancelPayload };
          if (typeof callback === 'function') callback(resp);
          socket.emit('battle:room_cancelled_ack', resp);
        } catch (err) {
          console.error('❌ Error in handleCancelBattleRoom:', err);
          const errResp = { success: false, message: err?.message || 'Error cancelling battle room' };
          if (typeof callback === 'function') callback(errResp);
          socket.emit('battle:error', errResp);
        }
      });
    };

    const handleGetOnlinePlayers = async (data, callback) => {
      try {
        const reqUserId = socket.userId;
        const players = await BattleService.getOnlinePlayers(reqUserId);
        const payload = { success: true, players, data: players, count: players.length };

        socket.emit('battle:online_players', payload);
        if (typeof callback === 'function') callback(payload);
      } catch (err) {
        console.warn('⚠️ [Socket] Error fetching online players:', err?.message);
        if (typeof callback === 'function') {
          callback({ success: false, error: err?.message, players: [], data: [], count: 0 });
        }
      }
    };

    // Single canonical event listeners
    socket.on('battle:cancel_room', handleCancelBattleRoom);
    socket.on('battle:forfeit', handleForfeitOrLeave);
    socket.on('battle:get_online_players', handleGetOnlinePlayers);

    // ==========================================
    // DISCONNECT HANDLER (Grace Period & O(1) Active Room Lookup)
    // ==========================================
    socket.on('disconnect', () => {
      console.log(`🔌 [Battle Socket Disconnected] ID: ${socket.id}`);

      const uId = socket.userId;
      if (!uId) return;

      // 1. Remove from all automatch queues
      for (const queue of automatchQueues.values()) {
        queue.delete(uId);
      }

      // 2. Track user active socket pool
      if (userActiveSockets.has(uId)) {
        const socketsSet = userActiveSockets.get(uId);
        socketsSet.delete(socket.id);

        if (socketsSet.size === 0) {
          userActiveSockets.delete(uId);

          // User has zero active connections. Lookup active room in O(1)
          const activeRoomId = userToActiveRoomMap.get(uId);
          if (activeRoomId) {
            const room = activeBattleRooms.get(activeRoomId);
            if (room && room.status === 'playing' && !room.isEnded) {
              console.log(`⏱️ [Disconnect Grace Period Started] Room: ${activeRoomId}, User: ${uId} (${RECONNECT_GRACE_PERIOD_MS / 1000}s)`);

              emitToBattleRoom(activeRoomId, 'battle:player_disconnected', {
                roomId: activeRoomId,
                userId: uId,
                gracePeriodSeconds: RECONNECT_GRACE_PERIOD_MS / 1000,
                message: 'Player disconnected. Waiting for reconnection...'
              });

              const key = `${activeRoomId}_${uId}`;
              clearReconnectTimer(activeRoomId, uId);

              const timer = setTimeout(async () => {
                reconnectTimers.delete(key);
                const currentRoom = activeBattleRooms.get(activeRoomId);
                if (currentRoom && currentRoom.status === 'playing' && !currentRoom.isEnded) {
                  console.log(`❌ [Grace Period Expired - Auto Forfeit] Room: ${activeRoomId}, User: ${uId}`);
                  await handleForfeitOrLeave({ roomId: activeRoomId, userId: uId });
                }
              }, RECONNECT_GRACE_PERIOD_MS);

              reconnectTimers.set(key, timer);
            }
          }
        }
      }
    });
  };

  // Dedicated /battle namespace handler ONLY
  battleNamespace.on('connection', (socket) => {
    setupBattleHandlers(socket);
  });

  return battleNamespace;
};
