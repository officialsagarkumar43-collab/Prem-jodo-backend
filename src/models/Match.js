import mongoose from 'mongoose';
import { MATCH_STATUS, SWIPE_ACTION } from '../constants/index.js';

const matchSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    action: {
      type: String,
      enum: Object.values(SWIPE_ACTION),
      default: SWIPE_ACTION.LIKE
    },
    status: {
      type: String,
      enum: Object.values(MATCH_STATUS),
      default: MATCH_STATUS.PENDING,
      index: true
    },
    isMutualMatch: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

// Compound index to prevent duplicate swipes/match records between two users
matchSchema.index({ sender: 1, receiver: 1 }, { unique: true });

export const Match = mongoose.model('Match', matchSchema);
