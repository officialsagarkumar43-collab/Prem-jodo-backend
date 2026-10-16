import mongoose from 'mongoose';
import { ADDON_TYPES } from '../constants/index.js';

const addonSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Addon name is required'],
      trim: true
    },
    slug: {
      type: String,
      required: [true, 'Addon slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    type: {
      type: String,
      enum: Object.values(ADDON_TYPES),
      required: [true, 'Addon type is required'],
      index: true
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: 0
    },
    originalPrice: {
      type: Number,
      default: 0,
      min: 0
    },
    discountPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    quantity: {
      type: Number,
      required: true,
      default: 1,
      min: 1
    },
    durationMinutes: {
      type: Number,
      default: 0
    },
    description: {
      type: String,
      default: '',
      trim: true
    },
    tag: {
      type: String,
      default: null,
      trim: true
    },
    icon: {
      type: String,
      default: 'Heart'
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

addonSchema.index({ isActive: 1, displayOrder: 1 });

export const Addon = mongoose.model('Addon', addonSchema);
