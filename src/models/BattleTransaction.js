import mongoose from 'mongoose';

const battleTransactionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Wallet',
      index: true
    },
    roomId: {
      type: String,
      index: true,
      default: null
    },
    battleRoom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BattleRoom',
      default: null
    },
    type: {
      type: String,
      enum: ['stake_entry', 'prize_win', 'stake_refund', 'deposit', 'withdrawal', 'bonus'],
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    balanceAfter: {
      type: Number,
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'completed'
    },
    description: {
      type: String,
      default: ''
    },
    referenceId: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

battleTransactionSchema.index({ user: 1, createdAt: -1 });
battleTransactionSchema.index({ roomId: 1, type: 1 });

export const BattleTransaction = mongoose.model('BattleTransaction', battleTransactionSchema);
