import crypto from 'crypto';
import mongoose from 'mongoose';
import { BattleRoom } from '../models/BattleRoom.js';
import { BattleTransaction } from '../models/BattleTransaction.js';
import { Wallet } from '../models/Wallet.js';
import { User } from '../models/User.js';
import { Profile } from '../models/Profile.js';
import { ApiError } from '../utils/ApiError.js';

export const STAKE_PRIZE_MAP = {
  10: 18,
  20: 36,
  30: 54,
  40: 72,
  50: 90,
  100: 180
};

export const ALLOWED_STAKES = Object.keys(STAKE_PRIZE_MAP).map(Number);

export class BattleService {
  /**
   * Helper: Run work function within a MongoDB Session & ACID Transaction when supported,
   * with automatic graceful fallback for standalone MongoDB instances without replica sets.
   */
  static async runInTransaction(workFn) {
    let session = null;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
      const result = await workFn(session);
      await session.commitTransaction();
      return result;
    } catch (err) {
      if (session) {
        try {
          await session.abortTransaction();
        } catch (_) { }
      }
      // If standalone Mongo instance (no replica set configured), execute without session
      if (err.message && (err.message.includes('replica set') || err.message.includes('Transaction numbers are only allowed'))) {
        return await workFn(null);
      }
      throw err;
    } finally {
      if (session) {
        session.endSession();
      }
    }
  }

  /**
   * Helper: Resolve User by ObjectId, string ID, Profile ID, email, phone, or object
   */
  static async resolveUser(rawUserId, userDetails = null, autoCreate = false) {
    if (!rawUserId) return null;
    if (typeof rawUserId === 'object' && rawUserId._id && rawUserId.fullName !== undefined) {
      return rawUserId;
    }
    let cleanId = typeof rawUserId === 'object'
      ? (rawUserId._id || rawUserId.id || rawUserId.userId)?.toString()
      : rawUserId.toString();
    if (!cleanId || cleanId === '[object Object]') return null;
    cleanId = cleanId.trim();

    const strippedId = cleanId.replace(/^(usr_|conv_|chat_|match_)/, '');

    // 1. Try finding User by stripped ObjectId or cleanId
    if (mongoose.isValidObjectId(strippedId)) {
      const user = await User.findById(strippedId);
      if (user) return user;
    }
    if (mongoose.isValidObjectId(cleanId) && cleanId !== strippedId) {
      const user = await User.findById(cleanId);
      if (user) return user;
    }

    // 2. Try finding User via Profile ID
    if (mongoose.isValidObjectId(strippedId) || mongoose.isValidObjectId(cleanId)) {
      const targetProfileId = mongoose.isValidObjectId(strippedId) ? strippedId : cleanId;
      const profile = await Profile.findById(targetProfileId).catch(() => null);
      if (profile && profile.user) {
        const user = await User.findById(profile.user).catch(() => null);
        if (user) return user;
      }
    }

    // 3. Try finding User by email, phone, googleId
    const user = await User.findOne({
      $or: [
        { email: cleanId.toLowerCase() },
        { email: strippedId.toLowerCase() },
        { phoneNumber: cleanId },
        { phoneNumber: strippedId },
        { googleId: cleanId },
        { googleId: strippedId }
      ]
    }).catch(() => null);
    if (user) return user;

    // 4. Fallback: Only create if explicitly requested (e.g. dev/testing)
    if (autoCreate) {
      try {
        const name = userDetails?.name || userDetails?.fullName || 'Player';
        const avatar = userDetails?.avatar || '';
        const fallbackEmail = `player_${strippedId.slice(-8) || Date.now()}@premjodo.battle`;
        return await User.create({
          _id: mongoose.isValidObjectId(strippedId) ? strippedId : new mongoose.Types.ObjectId(),
          fullName: name,
          email: fallbackEmail,
          avatar,
          isOnboarded: true,
          isVerified: true
        });
      } catch (err) {
        return await User.findById(strippedId).catch(() => null);
      }
    }

    return null;
  }

  /**
   * Helper: Generate a collision-free cryptographically unique room code (e.g. LUDO-A8B9C1)
   */
  static async generateUniqueRoomCode() {
    let roomId = '';
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 25) {
      const code = crypto.randomBytes(3).toString('hex').toUpperCase();
      roomId = `LUDO-${code}`;

      if (mongoose.connection && mongoose.connection.readyState === 1) {
        const existing = await BattleRoom.findOne({ roomId }).select('_id').lean().catch(() => null);
        if (!existing) {
          isUnique = true;
        }
      } else {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      roomId = `LUDO-${Date.now().toString(36).toUpperCase()}`;
    }

    return roomId;
  }

  /**
   * Helper: Get or atomically create user wallet with race-condition safe upsert
   */
  static async getOrCreateWallet(userIdOrUser, session = null) {
    let uId = null;
    if (typeof userIdOrUser === 'object' && userIdOrUser?._id) {
      uId = userIdOrUser._id;
    } else {
      const user = await this.resolveUser(userIdOrUser, null, false);
      if (user) {
        uId = user._id;
      } else {
        const candidate = typeof userIdOrUser === 'object' ? (userIdOrUser?.id || userIdOrUser?.userId) : userIdOrUser;
        const strId = candidate?.toString()?.replace(/^(usr_|conv_|chat_|match_)/, '');
        if (mongoose.isValidObjectId(strId)) {
          uId = strId;
        }
      }
    }

    if (!uId) {
      throw new ApiError(404, 'User not found for wallet operation');
    }

    let wallet = await Wallet.findOneAndUpdate(
      { user: uId },
      {
        $setOnInsert: {
          user: uId,
          balance: 100, // Initial welcome balance
          depositBalance: 0,
          winningBalance: 0,
          bonusBalance: 100
        }
      },
      { upsert: true, new: true, session: session || null }
    );

    return wallet;
  }

  /**
   * Helper: Atomically deduct stake from wallet with prioritized balances & idempotency reference
   */
  static async deductStakeFromWallet(walletUser, stakeAmount, roomId, battleRoomId = null, session = null) {
    const numStake = Number(stakeAmount);
    if (!walletUser || numStake <= 0) return false;

    const user = await this.resolveUser(walletUser, null, false);
    if (!user) throw new ApiError(404, 'User not found for stake deduction');

    const cleanUserIdStr = user._id.toString();
    const stakeRefId = `BATTLE_STAKE_${roomId}_${cleanUserIdStr}`;

    // IDEMPOTENCY GUARD: Check if stake already deducted for this room and user
    const existingTx = await BattleTransaction.findOne({ referenceId: stakeRefId }).session(session || null);
    if (existingTx) {
      console.log(`[deductStakeFromWallet] Stake already deducted for user ${cleanUserIdStr} in room ${roomId} (Tx: ${existingTx._id})`);
      return true;
    }

    const wallet = await this.getOrCreateWallet(user, session);
    if (!wallet) throw new ApiError(404, 'Wallet not found');

    if ((wallet.balance || 0) < numStake) {
      throw new ApiError(400, `Insufficient wallet balance. You need ₹${numStake} to enter.`);
    }

    let rem = numStake;
    let depDeduct = 0;
    let winDeduct = 0;
    let bonDeduct = 0;

    if (rem > 0 && (wallet.depositBalance || 0) > 0) {
      depDeduct = Math.min(wallet.depositBalance, rem);
      rem -= depDeduct;
    }
    if (rem > 0 && (wallet.winningBalance || 0) > 0) {
      winDeduct = Math.min(wallet.winningBalance, rem);
      rem -= winDeduct;
    }
    if (rem > 0 && (wallet.bonusBalance || 0) > 0) {
      bonDeduct = Math.min(wallet.bonusBalance, rem);
      rem -= bonDeduct;
    }

    if (rem > 0) {
      throw new ApiError(400, `Insufficient usable balance to deduct ₹${numStake}.`);
    }

    // Atomic conditional update on wallet balance
    const updatedWallet = await Wallet.findOneAndUpdate(
      {
        _id: wallet._id,
        depositBalance: { $gte: depDeduct },
        winningBalance: { $gte: winDeduct },
        bonusBalance: { $gte: bonDeduct },
        balance: { $gte: numStake }
      },
      {
        $inc: {
          depositBalance: -depDeduct,
          winningBalance: -winDeduct,
          bonusBalance: -bonDeduct,
          balance: -numStake,
          totalStakeSpent: numStake
        }
      },
      { new: true, session: session || null }
    );

    if (!updatedWallet) {
      throw new ApiError(400, `Insufficient wallet balance or concurrent transaction detected. Failed to deduct ₹${numStake}.`);
    }

    try {
      await BattleTransaction.create(
        [
          {
            user: user._id,
            wallet: wallet._id,
            roomId,
            battleRoom: battleRoomId,
            type: 'stake_entry',
            referenceId: stakeRefId,
            amount: numStake,
            balanceAfter: updatedWallet.balance,
            status: 'completed',
            description: `Entry Stake for Battle (Room: ${roomId})`
          }
        ],
        { session: session || null }
      );
    } catch (txErr) {
      if (txErr.code === 11000) {
        console.warn(`[deductStakeFromWallet] Duplicate stake transaction guard triggered for ${stakeRefId}`);
        return true;
      }
      throw txErr;
    }

    return true;
  }

  /**
   * Get user wallet details & battle stats
   */
  static async getWalletDetails(userId) {
    const user = await this.resolveUser(userId, null, false);
    if (!user) throw new ApiError(404, 'User not found');

    const wallet = await this.getOrCreateWallet(user);

    const transactions = await BattleTransaction.find({ user: user._id })
      .sort({ createdAt: -1 })
      .limit(25);

    return {
      balance: wallet.balance ?? 100,
      depositBalance: wallet.depositBalance || 0,
      winningBalance: wallet.winningBalance || 0,
      bonusBalance: wallet.bonusBalance || 0,
      totalDeposited: wallet.totalDeposited || 0,
      totalWithdrawn: wallet.totalWithdrawn || 0,
      totalWon: wallet.totalWon || 0,
      upiId: wallet.upiId || '',
      stats: user.battleStats || {
        matchesPlayed: 0,
        matchesWon: 0,
        matchesLost: 0,
        totalEarnings: 0,
        winRate: 0
      },
      transactions
    };
  }

  /**
   * Add / Deposit money to wallet with atomic conditional update & idempotency reference
   */
  static async addMoney(userId, amount, description = 'Wallet Recharge', paymentRef = null) {
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
      throw new ApiError(400, 'Invalid deposit amount');
    }

    const user = await this.resolveUser(userId, null, false);
    if (!user) throw new ApiError(404, 'User not found');

    const wallet = await this.getOrCreateWallet(user);
    const depositRefId = paymentRef || `BATTLE_DEPOSIT_${new mongoose.Types.ObjectId()}`;

    return await this.runInTransaction(async (session) => {
      const updatedWallet = await Wallet.findOneAndUpdate(
        { _id: wallet._id },
        {
          $inc: {
            depositBalance: numAmount,
            balance: numAmount,
            totalDeposited: numAmount
          }
        },
        { new: true, session: session || null }
      );

      const transaction = await BattleTransaction.create(
        [
          {
            user: user._id,
            wallet: wallet._id,
            type: 'deposit',
            referenceId: depositRefId,
            amount: numAmount,
            balanceAfter: updatedWallet.balance,
            status: 'completed',
            description
          }
        ],
        { session: session || null }
      );

      return {
        balance: updatedWallet.balance,
        depositBalance: updatedWallet.depositBalance,
        transaction: transaction[0] || transaction
      };
    });
  }

  /**
   * Withdraw money from wallet against winningBalance
   */
  static async withdrawMoney(userId, amount, upiId = '') {
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
      throw new ApiError(400, 'Invalid withdrawal amount');
    }

    const user = await this.resolveUser(userId, null, false);
    if (!user) throw new ApiError(404, 'User not found');

    const wallet = await this.getOrCreateWallet(user);

    // Real-money standard: Withdrawals are processed strictly against winningBalance
    if ((wallet.winningBalance || 0) < numAmount) {
      throw new ApiError(400, `Insufficient winning balance for withdrawal. Available: ₹${wallet.winningBalance || 0}`);
    }

    const withdrawRefId = `BATTLE_WITHDRAW_${new mongoose.Types.ObjectId()}`;

    return await this.runInTransaction(async (session) => {
      const updatedWallet = await Wallet.findOneAndUpdate(
        {
          _id: wallet._id,
          winningBalance: { $gte: numAmount }
        },
        {
          $inc: {
            winningBalance: -numAmount,
            balance: -numAmount,
            totalWithdrawn: numAmount
          },
          $set: {
            upiId: upiId ? upiId.trim() : wallet.upiId
          }
        },
        { new: true, session: session || null }
      );

      if (!updatedWallet) {
        throw new ApiError(400, 'Insufficient winning balance or concurrent withdrawal detected.');
      }

      const transaction = await BattleTransaction.create(
        [
          {
            user: user._id,
            wallet: wallet._id,
            type: 'withdrawal',
            referenceId: withdrawRefId,
            amount: numAmount,
            balanceAfter: updatedWallet.balance,
            status: 'completed',
            description: `Withdrawal to UPI: ${upiId || wallet.upiId || 'Direct Transfer'}`,
            metadata: { upiId }
          }
        ],
        { session: session || null }
      );

      return {
        balance: updatedWallet.balance,
        winningBalance: updatedWallet.winningBalance,
        transaction: transaction[0] || transaction
      };
    });
  }

  /**
   * Check if user is eligible to create a new battle
   */
  static async canCreateBattle(userId) {
    const user = await this.resolveUser(userId, null, false);
    if (!user) {
      return {
        canCreate: true,
        canCreateBattle: true,
        hasWaitingRoom: false,
        activeRoomId: null,
        activeRoom: null,
        message: 'No active waiting battle found'
      };
    }

    const cleanUserIdStr = user._id.toString();

    const existingWaitingRoom = await BattleRoom.findOne({
      $or: [
        { creator: user._id },
        { 'players.userId': cleanUserIdStr },
        { 'players.user': user._id }
      ],
      status: { $in: ['waiting', 'ready'] }
    }).select('_id roomId roomType stakeAmount prizeAmount maxPlayers status createdAt');

    if (existingWaitingRoom) {
      return {
        canCreate: false,
        canCreateBattle: false,
        hasWaitingRoom: true,
        activeRoomId: existingWaitingRoom.roomId,
        activeRoom: {
          id: existingWaitingRoom._id,
          roomId: existingWaitingRoom.roomId,
          roomCode: existingWaitingRoom.roomId,
          stakeAmount: existingWaitingRoom.stakeAmount,
          prizeAmount: existingWaitingRoom.prizeAmount,
          status: existingWaitingRoom.status,
          createdAt: existingWaitingRoom.createdAt
        },
        message: `You already have an active battle room (${existingWaitingRoom.roomId}) waiting for an opponent. You cannot create another battle until it is completed or cancelled.`
      };
    }

    return {
      canCreate: true,
      canCreateBattle: true,
      hasWaitingRoom: false,
      activeRoomId: null,
      activeRoom: null,
      message: 'You are eligible to create a new battle.'
    };
  }

  /**
   * Create a new custom or direct battle room
   */
  static async createBattleRoom(userId, userDetails, { stakeAmount = 50, roomType = 'custom', customCode = null, challengeTargetUserId = null } = {}) {
    const stake = Number(stakeAmount);
    if (!ALLOWED_STAKES.includes(stake)) {
      throw new ApiError(400, `Invalid stake amount. Allowed stakes are: ₹${ALLOWED_STAKES.join(', ₹')}`);
    }
    const prize = STAKE_PRIZE_MAP[stake];

    const user = await this.resolveUser(userId, userDetails, false);
    if (!user) throw new ApiError(404, 'User not found');

    const cleanUserIdStr = user._id.toString();

    // Check if user already has an active waiting room
    const existingWaitingRoom = await BattleRoom.findOne({
      $or: [
        { creator: user._id },
        { 'players.userId': cleanUserIdStr },
        { 'players.user': user._id }
      ],
      status: { $in: ['waiting', 'ready'] }
    });

    if (existingWaitingRoom) {
      const normalizedCustomCode = customCode ? customCode.toString().trim().toUpperCase() : null;
      if (normalizedCustomCode && existingWaitingRoom.roomId === normalizedCustomCode) {
        return existingWaitingRoom;
      }
      throw new ApiError(
        400,
        `You already have an active battle room (${existingWaitingRoom.roomId}). Complete or cancel it first.`
      );
    }

    const wallet = await this.getOrCreateWallet(user);
    if ((wallet.balance || 0) < stake) {
      throw new ApiError(400, `Insufficient wallet balance. You need ₹${stake} to enter this battle.`);
    }

    let room;
    let attempts = 0;
    let finalRoomId = customCode ? customCode.trim().toUpperCase() : await this.generateUniqueRoomCode();

    while (!room && attempts < 5) {
      try {
        room = await BattleRoom.create({
          roomId: finalRoomId,
          roomType,
          stakeAmount: stake,
          prizeAmount: prize,
          creator: user._id,
          challengeTargetUserId: challengeTargetUserId ? challengeTargetUserId.toString().trim() : null,
          players: [
            {
              user: user._id,
              userId: user._id.toString(),
              name: userDetails?.name || user.fullName || 'Host',
              avatar: userDetails?.avatar || user.avatar || '',
              color: 'red',
              pawnPositions: [-1, -1, -1, -1],
              score: 0,
              pawnsInHome: 0,
              isHost: true,
              isReady: true,
              hasLeft: false,
              missedTurns: 0
            }
          ],
          currentTurnIndex: 0,
          currentTurnPlayerId: user._id.toString(),
          status: 'waiting'
        });
      } catch (err) {
        if (err.code === 11000 && !customCode && attempts < 4) {
          finalRoomId = await this.generateUniqueRoomCode();
          attempts++;
        } else if (err.code === 11000 && customCode) {
          throw new ApiError(409, `Room code ${customCode} is already in use. Please try a different code.`);
        } else {
          throw err;
        }
      }
    }

    // For direct challenges (challengeTargetUserId present), do NOT deduct stake yet;
    // Both stakes are deducted atomically when opponent accepts the challenge.
    // For custom public rooms/automatch, deduct host stake upfront.
    if (!challengeTargetUserId) {
      await this.deductStakeFromWallet(wallet, stake, room.roomId, room._id);
    }

    return room;
  }

  /**
   * Join an existing battle room (Atomic Stake Deductions & Target Verification)
   */
  static async joinBattleRoom(userId, userDetails, roomId) {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    const room = await BattleRoom.findOne({ roomId: cleanRoomId });

    if (!room) throw new ApiError(404, 'Battle room not found');

    if (room.status === 'completed' || room.status === 'cancelled') {
      throw new ApiError(400, 'This battle has already concluded or was cancelled.');
    }

    const user = await this.resolveUser(userId, userDetails, false);
    if (!user) throw new ApiError(404, 'User not found');

    const strUserId = user._id.toString();
    const rawUserIdStr = userId ? (typeof userId === 'object' ? (userId._id || userId.id || userId.userId)?.toString() : userId.toString()) : '';

    // Enforce target player restriction if direct challenge
    if (room.challengeTargetUserId) {
      const cleanTarget = room.challengeTargetUserId.toString().trim().toLowerCase();
      const cleanAttempt = strUserId.toLowerCase();
      const cleanRaw = rawUserIdStr.toLowerCase();
      if (cleanAttempt !== cleanTarget && cleanRaw !== cleanTarget) {
        throw new ApiError(403, 'You are not authorized to join this direct challenge.');
      }
    }

    // Check if user is already in the room
    const existingIndex = room.players.findIndex(
      p => p.userId === strUserId || (p.user && p.user.toString() === strUserId) || (rawUserIdStr && p.userId === rawUserIdStr)
    );
    if (existingIndex !== -1) {
      return { room, isRejoining: true };
    }

    if (room.players.length >= room.maxPlayers) {
      throw new ApiError(400, 'This room is already full.');
    }

    return await this.runInTransaction(async (session) => {
      // 1. If direct challenge where creator stake was postponed until acceptance, deduct creator stake now
      if (room.challengeTargetUserId && room.creator) {
        const creatorUser = await this.resolveUser(room.creator, null, false);
        if (creatorUser) {
          const creatorCleanId = creatorUser._id.toString();
          const creatorStakeRef = `BATTLE_STAKE_${cleanRoomId}_${creatorCleanId}`;
          const existingCreatorTx = await BattleTransaction.findOne({ referenceId: creatorStakeRef }).session(session || null);
          if (!existingCreatorTx) {
            await this.deductStakeFromWallet(creatorUser, room.stakeAmount, room.roomId, room._id, session);
          }
        }
      }

      // 2. Deduct entry stake upfront from joining player
      await this.deductStakeFromWallet(user, room.stakeAmount, room.roomId, room._id, session);

      // Assign player color
      const colors = ['red', 'yellow', 'green', 'blue'];
      const usedColors = room.players.map(p => p.color);
      const assignedColor = colors.find(c => !usedColors.includes(c)) || (room.players[0]?.color === 'red' ? 'yellow' : 'red');

      room.players.push({
        user: user._id,
        userId: strUserId,
        name: userDetails?.name || user.fullName || 'Challenger',
        avatar: userDetails?.avatar || user.avatar || '',
        color: assignedColor,
        pawnPositions: [-1, -1, -1, -1],
        score: 0,
        pawnsInHome: 0,
        isHost: false,
        isReady: true,
        hasLeft: false,
        missedTurns: 0
      });

      if (room.players.length >= room.maxPlayers) {
        room.status = 'playing';
        room.startedAt = new Date();
        room.currentTurnIndex = 0;
        room.currentTurnPlayerId = room.players[0].userId;
      }
      await room.save({ session: session || null });

      return { room, isRejoining: false };
    });
  }

  /**
   * Finalize battle outcome (Atomic Real-Money Prize Credit & Stats in Transaction)
   */
  static async finalizeMatchOutcome(roomId, winnerUserId, reason = 'normal') {
    const cleanRoomId = (roomId || '').toString().trim().toUpperCase();
    if (!cleanRoomId) throw new ApiError(400, 'Room ID required');

    const roomDoc = await BattleRoom.findOne({ roomId: cleanRoomId });
    if (!roomDoc) throw new ApiError(404, `Battle room ${cleanRoomId} not found`);

    if (roomDoc.status === 'completed' && roomDoc.isEnded) {
      return roomDoc;
    }

    const cleanWinnerId = (winnerUserId || '').toString().trim().replace(/^(usr_|conv_|chat_|match_)/, '');
    const getPId = (p) => String(p?.userId || p?.user?._id || p?.user || p?._id || p?.id || '').trim().replace(/^(usr_|conv_|chat_|match_)/, '');

    const winnerPlayer = roomDoc.players.find(p => {
      const pUid = getPId(p);
      return cleanWinnerId && (pUid === cleanWinnerId || p.userId === cleanWinnerId || String(p.user) === cleanWinnerId);
    });

    if (!winnerPlayer) {
      console.error(`❌ [finalizeMatchOutcome] Winner ${winnerUserId} not found in room ${cleanRoomId} players!`);
      return roomDoc;
    }

    const loserPlayer = roomDoc.players.find(p => getPId(p) !== getPId(winnerPlayer));
    const winRefId = `BATTLE_WIN_${cleanRoomId}`;

    return await this.runInTransaction(async (session) => {
      // Check if prize transaction already recorded (Idempotency)
      const existingWinTx = await BattleTransaction.findOne({ referenceId: winRefId }).session(session || null);

      let winnerUser = await this.resolveUser(winnerPlayer.user || winnerPlayer.userId, null, false);
      let winnerWallet = winnerUser ? await this.getOrCreateWallet(winnerUser, session) : null;

      if (!existingWinTx && winnerWallet) {
        // Atomic prize credit to winning balance
        const updatedWinnerWallet = await Wallet.findOneAndUpdate(
          { _id: winnerWallet._id },
          {
            $inc: {
              winningBalance: roomDoc.prizeAmount,
              totalWon: roomDoc.prizeAmount,
              balance: roomDoc.prizeAmount
            }
          },
          { new: true, session: session || null }
        );

        // Update winner stats
        if (winnerUser) {
          const stats = winnerUser.battleStats || { matchesPlayed: 0, matchesWon: 0, matchesLost: 0, totalEarnings: 0, winRate: 0 };
          stats.matchesPlayed = (stats.matchesPlayed || 0) + 1;
          stats.matchesWon = (stats.matchesWon || 0) + 1;
          stats.totalEarnings = (stats.totalEarnings || 0) + roomDoc.prizeAmount;
          stats.winRate = Math.round((stats.matchesWon / stats.matchesPlayed) * 100);
          winnerUser.battleStats = stats;
          await winnerUser.save({ session: session || null });
        }

        try {
          await BattleTransaction.create(
            [
              {
                user: winnerPlayer.user || (winnerUser ? winnerUser._id : winnerWallet.user),
                wallet: winnerWallet._id,
                roomId: cleanRoomId,
                battleRoom: roomDoc._id,
                type: 'prize_win',
                referenceId: winRefId,
                amount: roomDoc.prizeAmount,
                balanceAfter: updatedWinnerWallet ? updatedWinnerWallet.balance : (winnerWallet.balance + roomDoc.prizeAmount),
                status: 'completed',
                description: `Won Ludo Battle Prize (+₹${roomDoc.prizeAmount}) (Room: ${cleanRoomId}) - Reason: ${reason}`
              }
            ],
            { session: session || null }
          );
        } catch (txErr) {
          if (txErr.code === 11000) {
            console.warn(`[finalizeMatchOutcome] Duplicate prize transaction guard triggered for ${winRefId}`);
          } else {
            throw txErr;
          }
        }
      }

      // Update loser stats
      if (loserPlayer) {
        const loserUser = await this.resolveUser(loserPlayer.user || loserPlayer.userId, null, false);
        if (loserUser) {
          const lStats = loserUser.battleStats || { matchesPlayed: 0, matchesWon: 0, matchesLost: 0, totalEarnings: 0, winRate: 0 };
          lStats.matchesPlayed = (lStats.matchesPlayed || 0) + 1;
          lStats.matchesLost = (lStats.matchesLost || 0) + 1;
          lStats.winRate = Math.round((lStats.matchesWon / lStats.matchesPlayed) * 100);
          loserUser.battleStats = lStats;
          await loserUser.save({ session: session || null });
        }
      }

      // Mark room completed in DB only AFTER financial operations succeed
      const finalizedRoom = await BattleRoom.findOneAndUpdate(
        { roomId: cleanRoomId },
        {
          $set: {
            status: 'completed',
            isEnded: true,
            endedAt: new Date(),
            winner: {
              user: winnerPlayer.user || (winnerUser ? winnerUser._id : null),
              userId: winnerPlayer.userId || getPId(winnerPlayer),
              name: winnerPlayer.name,
              avatar: winnerPlayer.avatar || '',
              color: winnerPlayer.color,
              prizeWon: roomDoc.prizeAmount
            }
          }
        },
        { new: true, session: session || null }
      );

      return finalizedRoom || roomDoc;
    });
  }

  /**
   * Forfeit or leave battle room
   */
  static async forfeitBattleRoom(roomId, userId) {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    const room = await BattleRoom.findOne({ roomId: cleanRoomId });
    if (!room) throw new ApiError(404, 'Battle room not found');
    if (room.status === 'completed' || room.status === 'cancelled') {
      return room;
    }

    const cleanUserId = userId ? String(userId).trim().replace(/^(usr_|conv_|chat_|match_)/, '') : '';
    const getPId = (p) => String(p?.userId || p?.user?._id || p?.user || p?._id || p?.id || '').trim().replace(/^(usr_|conv_|chat_|match_)/, '');

    const opponent = room.players.find(p => getPId(p) !== cleanUserId);

    if (room.players.length >= 2 && opponent) {
      return await this.finalizeMatchOutcome(cleanRoomId, opponent.userId || opponent.user || getPId(opponent), 'opponent_forfeited');
    } else {
      return await this.refundAndCancelRoom(cleanRoomId, 'player_left');
    }
  }

  /**
   * Cancel battle room & refund entry stakes atomically with idempotency reference
   */
  static async refundAndCancelRoom(roomId, reason = 'cancelled') {
    const cleanRoomId = (roomId || '').toString().trim().toUpperCase();
    if (!cleanRoomId) return null;

    const room = await BattleRoom.findOne({ roomId: cleanRoomId });
    if (!room) return null;
    if (room.status === 'cancelled' && room.isEnded) return room;

    const stake = Number(room.stakeAmount) || 0;

    return await this.runInTransaction(async (session) => {
      // Refund each player who actually had their stake deducted
      if (stake > 0 && room.players && room.players.length > 0) {
        for (const p of room.players) {
          const pUid = p.userId || p.user?._id || p.user;
          const cleanPUid = String(pUid).trim().replace(/^(usr_|conv_|chat_|match_)/, '');
          const refundRefId = `BATTLE_REFUND_${cleanRoomId}_${cleanPUid}`;
          const stakeRefId = `BATTLE_STAKE_${cleanRoomId}_${cleanPUid}`;

          const stakeTx = await BattleTransaction.findOne({ referenceId: stakeRefId }).session(session || null);
          const existingRefundTx = await BattleTransaction.findOne({ referenceId: refundRefId }).session(session || null);

          if (stakeTx && !existingRefundTx) {
            const user = await this.resolveUser(p.user || p.userId, null, false);
            if (user) {
              const wallet = await this.getOrCreateWallet(user, session);
              const updatedWallet = await Wallet.findOneAndUpdate(
                { _id: wallet._id },
                {
                  $inc: {
                    depositBalance: stake,
                    balance: stake
                  }
                },
                { new: true, session: session || null }
              );

              try {
                await BattleTransaction.create(
                  [
                    {
                      user: user._id,
                      wallet: wallet._id,
                      roomId: cleanRoomId,
                      battleRoom: room._id,
                      type: 'stake_refund',
                      referenceId: refundRefId,
                      amount: stake,
                      balanceAfter: updatedWallet ? updatedWallet.balance : (wallet.balance + stake),
                      status: 'completed',
                      description: `Refunded Stake for Cancelled Battle (Room: ${cleanRoomId}) - Reason: ${reason}`
                    }
                  ],
                  { session: session || null }
                );
              } catch (txErr) {
                if (txErr.code === 11000) {
                  console.warn(`[refundAndCancelRoom] Duplicate refund transaction guard triggered for ${refundRefId}`);
                } else {
                  throw txErr;
                }
              }
            }
          }
        }
      }

      const updatedRoom = await BattleRoom.findOneAndUpdate(
        { roomId: cleanRoomId },
        {
          $set: {
            status: 'cancelled',
            isEnded: true,
            endedAt: new Date()
          }
        },
        { new: true, session: session || null }
      );

      return updatedRoom || room;
    });
  }

  /**
   * Cancel an open/waiting battle room
   */
  static async cancelBattleRoom(roomId, userId = null) {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    return await this.refundAndCancelRoom(cleanRoomId, 'host_cancelled');
  }

  /**
   * Get Active Automatch Waiting Rooms
   */
  static async getLiveAutoMatch(currentUserId) {
    const cleanUserId = currentUserId ? String(currentUserId).trim().replace(/^(usr_|conv_|chat_|match_)/, '') : '';

    const dbRooms = await BattleRoom.find({
      status: 'waiting',
      roomType: 'automatch'
    })
      .populate('creator', 'fullName avatar photos')
      .populate('players.user', 'fullName avatar photos')
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const formatted = [];
    const seenCodes = new Set();

    for (const r of dbRooms) {
      const code = (r.roomId || '').toUpperCase();
      if (!code || seenCodes.has(code)) continue;
      seenCodes.add(code);

      const hostPlayer = r.players?.[0] || {};
      const hostUser = r.creator || hostPlayer.user || {};
      const hostUserIdStr = (hostPlayer.userId || hostUser._id || hostUser.id || '').toString();
      const cleanHostId = hostUserIdStr.replace(/^(usr_|conv_|chat_|match_)/, '');

      const isUserCreated = Boolean(cleanUserId && (cleanHostId === cleanUserId || (r.creator && r.creator._id?.toString() === cleanUserId)));

      formatted.push({
        id: r._id.toString(),
        _id: r._id.toString(),
        roomId: code,
        roomCode: code,
        hostUserId: hostUserIdStr,
        hostName: hostPlayer.name || hostUser.fullName || 'Host',
        hostAvatar: hostPlayer.avatar || hostUser.avatar || '',
        hostCity: hostUser.city || 'Arena',
        stake: r.stakeAmount || 50,
        stakeAmount: r.stakeAmount || 50,
        prize: r.prizeAmount || 90,
        prizeAmount: r.prizeAmount || 90,
        playerCount: r.maxPlayers || 2,
        maxPlayers: r.maxPlayers || 2,
        currentSlots: r.players?.length || 1,
        createdAt: r.createdAt ? new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Active Now',
        status: (r.status || 'WAITING').toUpperCase(),
        isUserCreated,
        roomType: 'automatch'
      });
    }

    return formatted;
  }

  /**
   * Get custom rooms created specifically via Custom Room Code
   */
  static async getOpenRooms(currentUserId) {
    const dbRooms = await BattleRoom.find({
      status: { $in: ['waiting', 'ready'] }
    })
      .populate('creator', 'fullName avatar photos')
      .populate('players.user', 'fullName avatar photos')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const formattedRooms = [];
    const seenRoomCodes = new Set();

    for (const r of dbRooms) {
      const code = (r.roomId || r.customCode || '').toUpperCase();
      if (!code || seenRoomCodes.has(code)) continue;
      seenRoomCodes.add(code);

      const hostPlayer = r.players?.[0] || {};
      const hostUser = r.creator || hostPlayer.user || {};
      const hostUserIdStr = (hostPlayer.userId || hostUser._id || hostUser.id || '').toString();
      const cleanHostId = hostUserIdStr.replace(/^(usr_|conv_|chat_|match_)/, '');
      const isUserCreated = Boolean(currentUserId && (cleanHostId === currentUserId || (r.creator && r.creator._id?.toString() === currentUserId)));

      formattedRooms.push({
        id: r._id.toString(),
        _id: r._id.toString(),
        roomId: code,
        roomCode: code,
        hostUserId: hostUserIdStr,
        hostName: hostPlayer.name || hostUser.fullName || 'Host',
        hostAvatar: hostPlayer.avatar || hostUser.avatar || '',
        hostCity: hostUser.city || 'Arena',
        stake: r.stakeAmount || 50,
        stakeAmount: r.stakeAmount || 50,
        prize: r.prizeAmount || 90,
        prizeAmount: r.prizeAmount || 90,
        playerCount: r.maxPlayers || 2,
        maxPlayers: r.maxPlayers || 2,
        currentSlots: r.players?.length || 1,
        createdAt: r.createdAt ? new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Active Now',
        status: (r.status || 'WAITING').toUpperCase(),
        isUserCreated
      });
    }

    return formattedRooms;
  }

  /**
   * Get Online Players List
   */
  static async getOnlinePlayers(currentUserId) {
    let query = {};
    if (currentUserId) {
      const cleanUserId = String(currentUserId).trim().replace(/^(usr_|conv_|chat_|match_)/, '');
      if (cleanUserId && mongoose.Types.ObjectId.isValid(cleanUserId)) {
        query._id = { $ne: new mongoose.Types.ObjectId(cleanUserId) };
      }
    }

    const users = await User.find(query)
      .select('fullName avatar battleStats lastActive email phoneNumber')
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(50)
      .lean()
      .catch(() => []);

    const userIds = users.map(u => u._id);
    const profiles = await Profile.find({
      user: { $in: userIds }
    })
      .select('user fullName name photos location dateOfBirth isOnline gender')
      .lean()
      .catch(() => []);

    const profileMap = new Map();
    profiles.forEach(p => {
      if (p.user) profileMap.set(p.user.toString(), p);
    });

    const result = [];
    const seenUserIds = new Set();

    for (const u of users) {
      const uid = u._id.toString();
      if (seenUserIds.has(uid)) continue;
      seenUserIds.add(uid);

      const prof = profileMap.get(uid);

      let photo = '';
      if (prof?.photos && Array.isArray(prof.photos) && prof.photos.length > 0) {
        const primary = prof.photos.find(p => p.isPrimary && p.url);
        photo = primary?.url || prof.photos[0]?.url || (typeof prof.photos[0] === 'string' ? prof.photos[0] : '');
      }
      if (!photo || typeof photo !== 'string' || !photo.startsWith('http')) {
        photo = (u.avatar && typeof u.avatar === 'string' && u.avatar.startsWith('http'))
          ? u.avatar
          : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300';
      }

      const name = (u.fullName && u.fullName.trim()) ||
        (prof?.fullName && prof.fullName.trim()) ||
        (prof?.name && prof.name.trim()) ||
        (u.email ? u.email.split('@')[0] : 'Online Player');

      const city = prof?.location?.city || prof?.location?.state || 'India';

      let age = 24;
      if (prof?.dateOfBirth) {
        const dob = new Date(prof.dateOfBirth);
        if (!isNaN(dob.getTime())) {
          age = Math.max(18, Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000)));
        }
      }

      const winRateNum = u.battleStats?.winRate || 0;
      const matchesWonNum = u.battleStats?.matchesWon || 0;
      const totalEarningsNum = u.battleStats?.totalEarnings || 0;

      result.push({
        id: uid,
        userId: uid,
        _id: uid,
        name,
        fullName: name,
        avatar: photo,
        photo,
        city,
        location: city,
        age,
        winRate: `${winRateNum}%`,
        totalWins: matchesWonNum,
        matchesWon: matchesWonNum,
        totalEarned: `₹${totalEarningsNum}`,
        totalWon: `₹${totalEarningsNum}`,
        badge: matchesWonNum > 50 ? 'Ludo Master' : 'Pro Battler',
        status: 'Online Now',
        isMatch: true,
        isOnline: true
      });
    }

    return result;
  }

  /**
   * Get Top Earners Leaderboard
   */
  static async getLeaderboard(limit = 20) {
    const numLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    const users = await User.find({})
      .select('fullName avatar battleStats lastActive email phone')
      .sort({
        'battleStats.totalEarnings': -1,
        'battleStats.matchesWon': -1,
        createdAt: -1
      })
      .limit(numLimit)
      .lean()
      .catch(() => []);

    const userIds = users.map(u => u._id);

    const [profiles, wallets] = await Promise.all([
      Profile.find({ user: { $in: userIds } })
        .select('user fullName name photos location age gender')
        .lean()
        .catch(() => []),
      Wallet.find({ user: { $in: userIds } })
        .select('user winningBalance totalWon balance')
        .lean()
        .catch(() => [])
    ]);

    const profileMap = new Map();
    profiles.forEach(p => {
      if (p.user) profileMap.set(p.user.toString(), p);
    });

    const walletMap = new Map();
    wallets.forEach(w => {
      if (w.user) walletMap.set(w.user.toString(), w);
    });

    const leaderboard = [];
    const seenUserIds = new Set();

    for (const u of users) {
      const uid = u._id.toString();
      if (seenUserIds.has(uid)) continue;
      seenUserIds.add(uid);

      const prof = profileMap.get(uid);
      const wall = walletMap.get(uid);

      const photo =
        prof?.photos?.[0]?.url ||
        prof?.photos?.[0] ||
        u.avatar ||
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300';
      const name = prof?.fullName || prof?.name || u.fullName || u.name || 'Player';
      const city = prof?.location?.city || prof?.location?.state || 'India';

      const earningsNum = Math.max(
        u.battleStats?.totalEarnings || 0,
        wall?.totalWon || 0,
        wall?.winningBalance || 0
      );
      const matchesWonNum = u.battleStats?.matchesWon || 0;
      const matchesPlayedNum = Math.max(u.battleStats?.matchesPlayed || 0, matchesWonNum);
      const calculatedWinRate = matchesPlayedNum > 0
        ? Math.round((matchesWonNum / matchesPlayedNum) * 100)
        : (u.battleStats?.winRate || 0);

      leaderboard.push({
        id: uid,
        _id: uid,
        userId: uid,
        rank: 0,
        name,
        fullName: name,
        avatar: photo,
        photo,
        city,
        location: city,
        earnings: earningsNum,
        totalEarnings: earningsNum,
        totalWon: '₹' + earningsNum.toLocaleString('en-IN'),
        totalEarned: '₹' + earningsNum.toLocaleString('en-IN'),
        matchesWon: matchesWonNum,
        matchesPlayed: matchesPlayedNum,
        winRate: `${calculatedWinRate}%`,
        winRateNumber: calculatedWinRate,
        badge: 'Battler'
      });
    }

    // Sort by earnings descending, then matches won descending
    leaderboard.sort((a, b) => {
      if ((b.earnings || 0) !== (a.earnings || 0)) {
        return (b.earnings || 0) - (a.earnings || 0);
      }
      if ((b.matchesWon || 0) !== (a.matchesWon || 0)) {
        return (b.matchesWon || 0) - (a.matchesWon || 0);
      }
      return (b.matchesPlayed || 0) - (a.matchesPlayed || 0);
    });

    leaderboard.forEach((item, index) => {
      item.rank = index + 1;
      if (index === 0) item.badge = '👑 Grand Champion';
      else if (index === 1) item.badge = '🥈 Master';
      else if (index === 2) item.badge = '🥉 Legend';
      else if (index < 10) item.badge = '⭐ Elite Battler';
      else item.badge = 'Pro Battler';
    });

    return leaderboard.slice(0, numLimit);
  }
}
