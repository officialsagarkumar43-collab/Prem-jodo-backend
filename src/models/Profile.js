import mongoose from 'mongoose';
import { GENDER } from '../constants/index.js';

const profileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other']
    },
    showGenderOnProfile: {
      type: Boolean,
      default: true
    },
    dateOfBirth: {
      type: Date
    },
    birthday: {
      month: { type: Number },
      day: { type: Number },
      year: { type: Number }
    },

    interestedIn: {
      type: [String],
      enum: ['men', 'women', 'everyone']
    },

    lookingFor: {
      type: String,
      default: 'Long-term partner'
    },
    bio: {
      type: String,
      maxlength: 500,
      default: ''
    },
    photos: [
      {
        url: { type: String, required: true },
        isPrimary: { type: Boolean, default: false },
        publicId: { type: String }
      }
    ],
    faceVerification: {
      type: String,
      default: ''
    },
    // Location with GeoJSON Point for nearby matchmaking
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0]
      },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      country: { type: String, default: 'India' }
    },
    // Partner Preferences for Matching Distance Radius
    partnerPreferences: {
      maxDistanceKm: { type: Number, default: 50 }
    },
    religion: {
      type: String,
      default: ''
    },
    education: {
      type: String,
      default: ''
    },
    // Interests
    interests: [{ type: String }]
  },
  {
    timestamps: true
  }
);

// 2dsphere index for location-based geospatial querying
profileSchema.index({ location: '2dsphere' });

export const Profile = mongoose.model('Profile', profileSchema);
