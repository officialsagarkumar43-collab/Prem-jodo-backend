import mongoose from 'mongoose';

const walletSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    // Total usable balance = depositBalance + winningBalance + bonusBalance
    balance: {
      type: Number,
      min: [0, 'Wallet balance cannot be negative']
    },
    depositBalance: {
      type: Number,
      default: 0,
      min: 0
    },
    winningBalance: {
      type: Number,
      default: 0,
      min: 0
    },
    bonusBalance: {
      type: Number,
      min: 0
    },
    totalDeposited: {
      type: Number,
      default: 0
    },
    totalWithdrawn: {
      type: Number,
      default: 0
    },
    totalWon: {
      type: Number,
      default: 0
    },
    totalStakeSpent: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'INR'
    },
    upiId: {
      type: String,
      trim: true,
      default: ''
    },
    isLocked: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

// Method to safely recalculate total balance
walletSchema.methods.syncBalance = function () {
  this.balance = (this.depositBalance || 0) + (this.winningBalance || 0) + (this.bonusBalance || 0);
  return this.balance;
};

export const Wallet = mongoose.model('Wallet', walletSchema);
