import mongoose from 'mongoose';

const playerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false
    },
    userId: {
      type: String,
      required: true,
      index: true
    },
    name: {
      type: String,
      default: 'Player'
    },
    avatar: {
      type: String,
      default: ''
    },
    color: {
      type: String,
      enum: ['red', 'green', 'yellow', 'blue'],
      required: true
    },
    // 4 pawns: -1 means in base/yard, 0..51 is global track, 52..56 home path, 57 is home
    pawnPositions: {
      type: [Number],
      default: [-1, -1, -1, -1]
    },
    score: {
      type: Number,
      default: 0
    },
    pawnsInHome: {
      type: Number,
      default: 0
    },
    isHost: {
      type: Boolean,
      default: false
    },
    isReady: {
      type: Boolean,
      default: false
    },
    hasLeft: {
      type: Boolean,
      default: false
    },
    missedTurns: {
      type: Number,
      default: 0
    }
  },
  { _id: false }
);

const moveSchema = new mongoose.Schema(
  {
    playerIndex: Number,
    playerId: String,
    diceValue: Number,
    pawnIndex: Number,
    fromPos: Number,
    toPos: Number,
    isCut: Boolean,
    isHomeEntry: Boolean,
    timestamp: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const battleRoomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true
    },
    roomType: {
      type: String,
      enum: ['custom', 'automatch', 'direct_challenge'],
      default: 'custom'
    },
    gameType: {
      type: String,
      default: 'ludo_1v1'
    },
    stakeAmount: {
      type: Number,
      required: true,
      default: 50
    },
    prizeAmount: {
      type: Number,
      required: true,
      default: 90
    },
    maxPlayers: {
      type: Number,
      default: 2
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    challengeTargetUserId: {
      type: String,
      default: null,
      index: true
    },
    players: [playerSchema],
    currentTurnIndex: {
      type: Number,
      default: 0
    },
    currentTurnPlayerId: {
      type: String,
      default: null
    },
    currentDiceValue: {
      type: Number,
      default: null
    },
    hasRolledDice: {
      type: Boolean,
      default: false
    },
    turnDeadline: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: ['waiting', 'ready', 'playing', 'settling', 'settlement_failed', 'completed', 'cancelled', 'abandoned'],
      default: 'waiting',
      index: true
    },
    stateVersion: {
      type: Number,
      default: 1
    },
    winner: {
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      userId: String,
      name: String,
      avatar: String,
      color: String,
      prizeWon: Number
    },
    moves: [moveSchema],
    startedAt: {
      type: Date,
      default: null
    },
    endedAt: {
      type: Date,
      default: null
    },
    isEnded: {
      type: Boolean,
      default: false,
      index: true
    },
    lastActivityAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

export const BattleRoom = mongoose.model('BattleRoom', battleRoomSchema);
