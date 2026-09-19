import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { Profile } from '../models/Profile.js';
import { Otp } from '../models/Otp.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendOtpEmail } from '../utils/sendEmail.js';
import { HTTP_STATUS } from '../constants/index.js';
import { ENV } from '../config/env.js';
import { CacheService } from '../services/cache.service.js';

// Helper to generate access & refresh tokens safely and efficiently
export const generateAccessAndRefreshTokens = async (userOrId) => {
  let user = null;

  if (userOrId && typeof userOrId === 'object' && userOrId.email && userOrId._id) {
    user = userOrId;
  } else {
    const id = userOrId?._id || userOrId;
    user = await User.findById(id);
    if (!user) throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  const accessToken = typeof user.generateAccessToken === 'function'
    ? user.generateAccessToken()
    : jwt.sign(
      {
        _id: user._id,
        email: user.email,
        role: user.role || 'user'
      },
      ENV.JWT_ACCESS_SECRET,
      {
        expiresIn: ENV.JWT_ACCESS_EXPIRY
      }
    );

  const refreshToken = typeof user.generateRefreshToken === 'function'
    ? user.generateRefreshToken()
    : jwt.sign(
      {
        _id: user._id
      },
      ENV.JWT_REFRESH_SECRET,
      {
        expiresIn: ENV.JWT_REFRESH_EXPIRY
      }
    );

  await User.updateOne({ _id: user._id }, { $set: { refreshToken } });

  return { accessToken, refreshToken };
};

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict'
};

/**
 * 1. Send OTP to user's Email (Ultra-fast async dispatch)
 */
export const sendOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Email is required');
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Generate 6-digit numeric OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Save or replace existing OTP in DB
  await Otp.findOneAndUpdate(
    { email: normalizedEmail },
    { otp, expiresAt },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Send OTP email in background without blocking HTTP response latency
  sendOtpEmail(normalizedEmail, otp).catch((err) => {
    console.error('Failed to send OTP email asynchronously:', err);
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      { email: normalizedEmail },
      'OTP sent successfully to your email'
    )
  );
});

/**
 * 2. Verify OTP & Authenticate (Login or Start Registration)
 * Lean & Ultra-fast response: returns only token, refreshToken, expiresIn, isOnboarded
 */
export const verifyOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Email and OTP are required');
  }

  const normalizedEmail = email.toLowerCase().trim();
  const trimmedOtp = otp.toString().trim();

  // Atomic find and delete OTP in a single query
  const otpRecord = await Otp.findOneAndDelete({ email: normalizedEmail });
  if (!otpRecord) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'OTP expired or not requested. Please request a new OTP.');
  }

  if (otpRecord.otp !== trimmedOtp) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid OTP');
  }

  // Find or create user
  let user = await User.findOne({ email: normalizedEmail });

  if (!user) {
    user = await User.create({
      email: normalizedEmail,
      fullName: '',
      isOnboarded: false,
      isVerified: true
    });
  }

  const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user);

  const expiresIn = ENV.JWT_ACCESS_EXPIRY;

  return res
    .status(HTTP_STATUS.OK)
    .cookie('accessToken', accessToken, cookieOptions)
    .cookie('refreshToken', refreshToken, cookieOptions)
    .json(
      new ApiResponse(
        HTTP_STATUS.OK,
        {
          token: accessToken,
          accessToken,
          refreshToken,
          expiresIn,
          isOnboarded: Boolean(user.isOnboarded)
        },
        user.isOnboarded ? 'Login successful' : 'OTP verified. Please complete your onboarding.'
      )
    );
});

/**
 * 3. Complete Onboarding Profile (/onboarding)
 */
export const completeOnboarding = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const {
    fullName,
    birthday,
    dateOfBirth,
    gender,
    showGenderOnProfile,
    interestedIn,
    interests,
    lookingFor,
    religion,
    education,
    photos,
    bio,
    aboutMe,
    location,
    city,
    state,
    country
  } = req.body;

  if (!fullName) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Full name is required');
  }

  if (!gender) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Gender is required');
  }

  // Calculate or parse date of birth
  let parsedDob = dateOfBirth;
  if (!parsedDob && birthday) {
    const { year, month, day } = birthday;
    if (year && month && day) {
      parsedDob = new Date(year, month - 1, day);
    }
  }

  if (!parsedDob) {
    parsedDob = new Date('2000-01-01');
  }

  // Format photos array
  let formattedPhotos = [];
  if (Array.isArray(photos)) {
    formattedPhotos = photos.map((p, idx) =>
      typeof p === 'string'
        ? { url: p, isPrimary: idx === 0 }
        : { url: p.url, isPrimary: p.isPrimary || idx === 0, publicId: p.publicId }
    );
  }

  // Update User
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        fullName: fullName.trim(),
        isOnboarded: true,
        isVerified: true
      }
    },
    { new: true }
  ).select('-password -refreshToken -subscription');

  // Upsert Profile
  const profile = await Profile.findOneAndUpdate(
    { user: userId },
    {
      $set: {
        user: userId,
        gender: gender.toLowerCase(),
        showGenderOnProfile: showGenderOnProfile !== undefined ? showGenderOnProfile : true,
        dateOfBirth: parsedDob,
        birthday: birthday || {
          month: parsedDob.getMonth() + 1,
          day: parsedDob.getDate(),
          year: parsedDob.getFullYear()
        },
        interestedIn: interestedIn,
        interests: Array.isArray(interests) ? interests : [],
        lookingFor: lookingFor || 'Long-term partner',
        religion: religion || '',
        education: education || '',
        partnerPreferences: {
          maxDistanceKm: req.body.maxDistanceKm || req.body.partnerPreferences?.maxDistanceKm || 50
        },
        photos: formattedPhotos,
        bio: bio || aboutMe || '',
        ...(city ? { 'location.city': city } : {}),
        ...(state ? { 'location.state': state } : {}),
        ...(country ? { 'location.country': country } : {}),
        ...(location?.coordinates ? { location } : {})
      }
    },
    { upsert: true, new: true, runValidators: false }
  );

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      { user: updatedUser, profile },
      'Onboarding completed successfully! Welcome to Prem Jodo'
    )
  );
});

/**
 * 4. Logout User
 */
export const logoutUser = asyncHandler(async (req, res) => {
  const token =
    req.cookies?.accessToken ||
    req.header('Authorization')?.replace('Bearer ', '');

  if (token) {
    try {
      const decoded = jwt.decode(token);
      const remainingSeconds = decoded?.exp
        ? Math.max(decoded.exp - Math.floor(Date.now() / 1000), 60)
        : 86400;
      await CacheService.set(`blacklist_${token}`, 'true', remainingSeconds);
    } catch {
      await CacheService.set(`blacklist_${token}`, 'true', 86400);
    }
  }

  await User.findByIdAndUpdate(
    req.user._id,
    { $set: { refreshToken: null } },
    { new: true }
  );

  return res
    .status(HTTP_STATUS.OK)
    .clearCookie('accessToken', cookieOptions)
    .clearCookie('refreshToken', cookieOptions)
    .json(new ApiResponse(HTTP_STATUS.OK, {}, 'User logged out successfully'));
});

/**
 * 5. Get Current User & Profile
 */
export const getCurrentUser = asyncHandler(async (req, res) => {
  const profile = await Profile.findOne({ user: req.user._id });
  const user = req.user.toObject ? req.user.toObject() : { ...req.user };
  delete user.subscription;

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      { user, profile, isOnboarded: req.user.isOnboarded },
      'Current user fetched successfully'
    )
  );
});

/**
 * 6. Google OAuth Authentication (Login or Register)
 */
export const googleLogin = asyncHandler(async (req, res) => {
  const {
    idToken,
    credential,
    token,
    email: rawEmail,
    googleId: rawGoogleId
  } = req.body;

  let email = rawEmail;
  let googleId = rawGoogleId;

  const tokenToVerify = idToken || credential || token;

  if (tokenToVerify) {
    try {
      if (String(tokenToVerify).startsWith('ya29.')) {
        const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: 'Bearer ' + tokenToVerify }
        });
        if (googleRes.ok) {
          const payload = await googleRes.json();
          if (payload.email) {
            email = payload.email;
            googleId = googleId || payload.sub;
          }
        }
      } else {
        const googleRes = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + tokenToVerify);
        if (googleRes.ok) {
          const payload = await googleRes.json();
          if (payload.email) {
            email = payload.email;
            googleId = googleId || payload.sub;
          }
        }
      }
    } catch (err) {
      console.warn('Google token verification note:', err.message);
    }
  }

  if (!email) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Valid email or Google token is required');
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Find user by email
  let user = await User.findOne({ email: normalizedEmail });
  let isNewUser = false;

  if (!user) {
    try {
      user = await User.create({
        email: normalizedEmail,
        fullName: '',
        googleId: googleId || undefined,
        isOnboarded: false,
        isVerified: true
      });
      isNewUser = true;
    } catch (createErr) {
      if (createErr.code === 11000) {
        user = await User.findOne({ email: normalizedEmail });
      } else {
        throw createErr;
      }
    }
  } else {
    let shouldSave = false;
    if (googleId && !user.googleId) {
      user.googleId = googleId;
      shouldSave = true;
    }
    if (!user.isVerified) {
      user.isVerified = true;
      shouldSave = true;
    }
    if (shouldSave) {
      await user.save({ validateBeforeSave: false });
    }
  }

  // Generate auth tokens safely
  const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user);
  const expiresIn = ENV.JWT_ACCESS_EXPIRY;

  return res
    .status(HTTP_STATUS.OK)
    .cookie('accessToken', accessToken, cookieOptions)
    .cookie('refreshToken', refreshToken, cookieOptions)
    .json(
      new ApiResponse(
        HTTP_STATUS.OK,
        {
          token: accessToken,
          accessToken,
          refreshToken,
          expiresIn,
          isOnboarded: Boolean(user.isOnboarded)
        },
        user.isOnboarded
          ? 'Login successful with Google'
          : 'Google account linked. Please complete your onboarding.'
      )
    );
});
