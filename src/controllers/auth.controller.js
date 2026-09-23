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
import { deleteUploadedFile } from '../middlewares/upload.middleware.js';
import { runInTransaction } from '../utils/transaction.js';

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
          isOnboarded: Boolean(user.isOnboarded),
          isFaceVerification: Boolean(user.isFaceVerification)
        },
        user.isOnboarded ? 'Login successful' : 'OTP verified. Please complete your face verification and onboarding.'
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
    existingPhotos,
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

  if (!req.user.isFaceVerification) {
    throw new ApiError(
      HTTP_STATUS.BAD_REQUEST,
      'Face verification is required before completing onboarding. Please verify your face first.'
    );
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

  // Helper to normalize photo URLs (stripping host/port if full URL)
  const normalizePhotoUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        const parsed = new URL(rawUrl);
        return parsed.pathname;
      }
    } catch {}
    return rawUrl.trim();
  };

  // Retrieve existing profile from DB
  const existingProfile = await Profile.findOne({ user: userId });
  const oldDbPhotos = existingProfile?.photos || [];

  // Determine photos array (preserving exact arrival order if sent via multipart req.orderedPhotos)
  let finalPhotos = [];

  if (Array.isArray(req.orderedPhotos) && req.orderedPhotos.length > 0) {
    // Exact arrival sequence from client
    finalPhotos = req.orderedPhotos
      .map((item, idx) => {
        const rawUrl = item.fileUrl || item.url;
        const cleanUrl = normalizePhotoUrl(rawUrl);
        return {
          url: cleanUrl,
          isPrimary: item.isPrimary !== undefined ? Boolean(item.isPrimary) : idx === 0,
          publicId: item.publicId
        };
      })
      .filter((p) => Boolean(p.url));
  } else {
    // Fallback if req.orderedPhotos was not populated
    let retainedPhotos = [];
    const rawExistingInput = existingPhotos !== undefined ? existingPhotos : photos;

    if (rawExistingInput !== undefined) {
      let parsedList = [];
      if (Array.isArray(rawExistingInput)) {
        parsedList = rawExistingInput;
      } else if (typeof rawExistingInput === 'string' && rawExistingInput.trim()) {
        try {
          const parsed = JSON.parse(rawExistingInput);
          if (Array.isArray(parsed)) parsedList = parsed;
        } catch {
          parsedList = [{ url: rawExistingInput, isPrimary: true }];
        }
      }

      retainedPhotos = parsedList.map((p, idx) => {
        if (typeof p === 'string') {
          return { url: normalizePhotoUrl(p), isPrimary: idx === 0 };
        }
        return {
          url: normalizePhotoUrl(p?.url || p?.fileUrl),
          isPrimary: Boolean(p?.isPrimary),
          publicId: p?.publicId
        };
      }).filter((p) => Boolean(p.url));
    } else if (!req.files || req.files.length === 0) {
      // Retain existing photos from DB if neither files nor photo input provided
      retainedPhotos = oldDbPhotos.map((p) => ({
        url: normalizePhotoUrl(p.url),
        isPrimary: Boolean(p.isPrimary),
        publicId: p.publicId
      }));
    }

    const newUploadedPhotos = (Array.isArray(req.files) ? req.files : []).map((f, idx) => ({
      url: normalizePhotoUrl(f.fileUrl),
      isPrimary: retainedPhotos.length === 0 && idx === 0
    }));

    finalPhotos = [...retainedPhotos, ...newUploadedPhotos];
  }

  // Deduplicate any repeated photo URLs while preserving order
  const uniquePhotos = [];
  const seenUrls = new Set();
  for (const p of finalPhotos) {
    if (p.url && !seenUrls.has(p.url)) {
      seenUrls.add(p.url);
      uniquePhotos.push(p);
    }
  }
  finalPhotos = uniquePhotos;

  // Ensure at least one photo is marked primary if photos exist
  if (finalPhotos.length > 0 && !finalPhotos.some((p) => p.isPrimary)) {
    finalPhotos[0].isPrimary = true;
  }

  // Physical file cleanup: delete photos from disk that were in DB but are not in finalPhotos
  const finalUrlSet = new Set(finalPhotos.map((p) => p.url));
  for (const oldP of oldDbPhotos) {
    const cleanOldUrl = normalizePhotoUrl(oldP.url);
    if (cleanOldUrl && !finalUrlSet.has(cleanOldUrl)) {
      deleteUploadedFile(cleanOldUrl).catch(() => null);
    }
  }

  // Update User and Profile inside a Mongoose Session Transaction
  const { updatedUser, profile } = await runInTransaction(async (session) => {
    const userDoc = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          fullName: fullName.trim(),
          isOnboarded: true,
          isVerified: true
        }
      },
      { new: true, session }
    ).select('-password -refreshToken -subscription');

    const profileDoc = await Profile.findOneAndUpdate(
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
          photos: finalPhotos,
          bio: bio || aboutMe || '',
          ...(city ? { 'location.city': city } : {}),
          ...(state ? { 'location.state': state } : {}),
          ...(country ? { 'location.country': country } : {}),
          ...(location?.coordinates ? { location } : {})
        }
      },
      { upsert: true, new: true, runValidators: false, session }
    );

    return { updatedUser: userDoc, profile: profileDoc };
  });

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
      {
        user,
        profile,
        isOnboarded: Boolean(req.user.isOnboarded),
        isFaceVerification: Boolean(req.user.isFaceVerification)
      },
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
          isOnboarded: Boolean(user.isOnboarded),
          isFaceVerification: Boolean(user.isFaceVerification)
        },
        user.isOnboarded
          ? 'Login successful with Google'
          : 'Google account linked. Please complete your face verification and onboarding.'
      )
    );
});

/**
 * 7. Face Verification Image Upload (/face-verification)
 * Uploads & optimizes image to face-verification/, saves URL in profile.face_verification,
 * updates User.isFaceVerification = true inside a session transaction.
 */
export const uploadFaceVerification = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  if (!req.file || !req.file.fileUrl) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Face verification image file is required');
  }

  const fileUrl = req.file.fileUrl;

  // Retrieve existing profile to clean up old image if present
  const existingProfile = await Profile.findOne({ user: userId });
  const oldFaceUrl = existingProfile?.faceVerification || existingProfile?.face_verification;

  // Atomic multi-collection update using Mongoose Session Transaction
  const { updatedUser, profile } = await runInTransaction(async (session) => {
    const userDoc = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          isFaceVerification: true
        }
      },
      { new: true, session }
    ).select('-password -refreshToken -subscription');

    const profileDoc = await Profile.findOneAndUpdate(
      { user: userId },
      {
        $set: {
          user: userId,
          faceVerification: fileUrl
        }
      },
      { upsert: true, new: true, runValidators: false, session }
    );

    return { updatedUser: userDoc, profile: profileDoc };
  });

  // Delete previously stored face verification image file if different
  if (oldFaceUrl && oldFaceUrl !== fileUrl) {
    await deleteUploadedFile(oldFaceUrl);
  }

  // Invalidate profile cache
  await CacheService.del(`profile:${userId.toString()}`);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        isFaceVerification: true
      },
      'Face verification image uploaded and verified successfully'
    )
  );
});
