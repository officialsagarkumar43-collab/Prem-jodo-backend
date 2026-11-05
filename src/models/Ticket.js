import mongoose from 'mongoose';
import { TICKET_STATUS, TICKET_CATEGORIES } from '../constants/index.js';

const ticketMessageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    senderRole: {
      type: String,
      enum: ['user', 'guest', 'admin', 'owner'],
      required: true
    },
    senderName: {
      type: String,
      required: true,
      trim: true
    },
    senderEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null
    },
    senderAvatar: {
      type: String,
      default: null
    },
    message: {
      type: String,
      required: true,
      trim: true
    },
    attachments: [
      {
        type: String,
        trim: true
      }
    ],
    isInternalNote: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: true }
);

const ticketSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      uppercase: true,
      trim: true
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    isGuest: {
      type: Boolean,
      default: false,
      index: true
    },
    guestInfo: {
      fullName: { type: String, trim: true, default: null },
      email: { type: String, trim: true, lowercase: true, default: null },
      phoneNumber: { type: String, trim: true, default: null }
    },
    category: {
      type: String,
      enum: Object.values(TICKET_CATEGORIES),
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: Object.values(TICKET_STATUS),
      default: TICKET_STATUS.OPEN,
      index: true
    },
    description: {
      type: String,
      required: true,
      trim: true
    },
    messages: [ticketMessageSchema],
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    resolvedByName: {
      type: String,
      default: null
    },
    resolvedAt: {
      type: Date,
      default: null
    },
    resolutionNote: {
      type: String,
      default: null
    },
    lastRepliedAt: {
      type: Date,
      default: Date.now,
      index: true
    },
    lastRepliedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    lastRepliedByName: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Pre-validate hook to generate sequential TCK-501 format ticket IDs
ticketSchema.pre('validate', async function (next) {
  if (this.isNew && !this.ticketId) {
    try {
      const lastTicket = await mongoose
        .model('Ticket')
        .findOne({}, { ticketId: 1 })
        .sort({ createdAt: -1 })
        .lean();

      let nextNum = 501;
      if (lastTicket?.ticketId) {
        const match = lastTicket.ticketId.match(/\d+/);
        if (match) {
          nextNum = parseInt(match[0], 10) + 1;
        }
      }
      this.ticketId = `TCK-${nextNum}`;
    } catch (err) {
      // Fallback timestamp-based ID in case of concurrent lookup
      this.ticketId = `TCK-${Date.now().toString().slice(-6)}`;
    }
  }
  next();
});

// Indexes for high performance querying on admin tickets portal
ticketSchema.index({ status: 1, createdAt: -1 });
ticketSchema.index({ category: 1, createdAt: -1 });
ticketSchema.index({ user: 1, createdAt: -1 });

export const Ticket = mongoose.model('Ticket', ticketSchema);
