import mongoose from 'mongoose';
import { MEMBERSHIP_TIERS, BILLING_CYCLES, PAYMENT_STATUS } from '../constants/index.js';

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    orderNumber: {
      type: String,
      index: true
    },
    paymentMethod: {
      type: String,
      default: 'Razorpay'
    },
    razorpayOrderId: {
      type: String,
      default: null,
      index: true
    },
    razorpayPaymentId: {
      type: String,
      default: null,
      index: true
    },
    razorpaySignature: {
      type: String,
      default: null
    },
    razorpayRefundId: {
      type: String,
      default: null,
      index: true
    },
    paymentId: {
      type: String,
      default: null,
      index: true
    },
    signature: {
      type: String,
      default: null
    },
    amount: {
      type: Number,
      required: true
    },
    amountInPaise: {
      type: Number,
      required: true
    },
    currency: {
      type: String,
      default: 'INR'
    },
    plan: {
      type: String,
      enum: Object.values(MEMBERSHIP_TIERS),
      required: true
    },
    billingCycle: {
      type: String,
      enum: Object.values(BILLING_CYCLES),
      default: BILLING_CYCLES.MONTHLY
    },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.CREATED,
      index: true
    },
    receipt: {
      type: String,
      required: true
    },
    subscription: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    // Refund Tracking Fields
    refundId: {
      type: String,
      default: null,
      index: true
    },
    refundAmount: {
      type: Number,
      default: null
    },
    refundStatus: {
      type: String,
      default: null
    },
    refundArn: {
      type: String,
      default: null
    },
    refundedAt: {
      type: Date,
      default: null
    },
    refundReason: {
      type: String,
      default: null
    },
    notes: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    failureReason: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true
  }
);

paymentSchema.index({ user: 1, createdAt: -1 });

export const Payment = mongoose.model('Payment', paymentSchema);
