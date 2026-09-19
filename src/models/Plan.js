import mongoose from 'mongoose';

const planPricingSchema = new mongoose.Schema(
  {
    pricePerMonth: {
      type: Number,
      required: true,
      min: 0
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0
    },
    discountPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    durationDays: {
      type: Number,
      required: true,
      default: 30
    }
  },
  { _id: false }
);

const planSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Plan name is required'],
      trim: true,
      index: true
    },
    slug: {
      type: String,
      required: [true, 'Plan slug/identifier is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    subtitle: {
      type: String,
      default: '',
      trim: true
    },
    tag: {
      type: String,
      default: null,
      trim: true
    },
    isMostPopular: {
      type: Boolean,
      default: false
    },
    description: {
      type: String,
      default: '',
      trim: true
    },
    themeColor: {
      type: String,
      default: '#EC4899'
    },
    icon: {
      type: String,
      default: 'Zap'
    },
    pricing: {
      monthly: {
        type: planPricingSchema,
        required: true
      },
      annual: {
        type: planPricingSchema,
        required: true
      }
    },
    features: {
      type: [String],
      default: []
    },
    perks: {
      unlimitedSwipes: { type: Boolean, default: false },
      rewindAllowed: { type: Boolean, default: false },
      superLikesPerWeek: { type: Number, default: 0 },
      passportLocation: { type: Boolean, default: false },
      seeWhoLikedYou: { type: Boolean, default: false },
      profileBoostPerMonth: { type: Number, default: 0 },
      priorityLikes: { type: Boolean, default: false },
      messageBeforeMatch: { type: Boolean, default: false },
      vipBadge: { type: Boolean, default: false }
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    displayOrder: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

planSchema.index({ isActive: 1, displayOrder: 1 });

export const Plan = mongoose.model('Plan', planSchema);
