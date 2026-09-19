import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { USER_ROLES, MEMBERSHIP_TIERS, BILLING_CYCLES, SUBSCRIPTION_STATUS } from '../constants/index.js';
import { ENV } from '../config/env.js';

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    phoneNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true
    },
    password: {
      type: String,
      default: null
    },
    role: {
      type: String,
      enum: Object.values(USER_ROLES),
      default: USER_ROLES.USER
    },
    isOnboarded: {
      type: Boolean,
      default: false
    },
    isVerified: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true
    },
    googleId: {
      type: String,
      sparse: true,
      index: true
    },
    avatar: {
      type: String,
      default: ''
    },
    subscription: {
      plan: {
        type: String,
        enum: Object.values(MEMBERSHIP_TIERS),
        default: MEMBERSHIP_TIERS.FREE
      },
      planName: {
        type: String,
        default: 'Prem Jodo Free'
      },
      billingCycle: {
        type: String,
        enum: Object.values(BILLING_CYCLES),
        default: BILLING_CYCLES.MONTHLY
      },
      amount: {
        type: Number,
        default: 0
      },
      currency: {
        type: String,
        default: 'INR'
      },
      status: {
        type: String,
        enum: Object.values(SUBSCRIPTION_STATUS),
        default: SUBSCRIPTION_STATUS.PENDING
      },
      startDate: {
        type: Date,
        default: Date.now
      },
      endDate: {
        type: Date,
        default: null
      },
      autoRenew: {
        type: Boolean,
        default: false
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
      boostsRemaining: {
        type: Number,
        default: 0
      },
      superLikesRemaining: {
        type: Number,
        default: 0
      }
    },
    refreshToken: {
      type: String,
      default: null,
      select: false
    },
    battleStats: {
      matchesPlayed: {
        type: Number,
        default: 0
      },
      matchesWon: {
        type: Number,
        default: 0
      },
      matchesLost: {
        type: Number,
        default: 0
      },
      totalEarnings: {
        type: Number,
        default: 0
      },
      winRate: {
        type: Number,
        default: 0
      }
    },
    lastActive: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.password;
        delete ret.refreshToken;
        return ret;
      }
    },
    toObject: {
      transform: function (doc, ret) {
        delete ret.password;
        delete ret.refreshToken;
        return ret;
      }
    }
  }
);

// Hash password before saving if provided
userSchema.pre('save', async function (next) {
  if (!this.password || !this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Compare password method
userSchema.methods.isPasswordCorrect = async function (password) {
  if (!this.password) return false;
  return await bcrypt.compare(password, this.password);
};

// Generate Access Token
userSchema.methods.generateAccessToken = function () {
  return jwt.sign(
    {
      _id: this._id,
      email: this.email,
      role: this.role
    },
    ENV.JWT_ACCESS_SECRET,
    {
      expiresIn: ENV.JWT_ACCESS_EXPIRY
    }
  );
};

// Generate Refresh Token
userSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    {
      _id: this._id
    },
    ENV.JWT_REFRESH_SECRET,
    {
      expiresIn: ENV.JWT_REFRESH_EXPIRY
    }
  );
};

export const User = mongoose.model('User', userSchema);
