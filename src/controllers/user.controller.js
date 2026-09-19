import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { CacheService } from '../services/cache.service.js';
import {
  HTTP_STATUS,
  LOOKING_FOR_OPTIONS,
  INTEREST_OPTIONS
} from '../constants/index.js';

export const upsertProfile = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { fullName, birthday, dateOfBirth, ...restData } = req.body;

  // 1. Update User if fullName is provided
  let updatedUser = req.user;
  if (fullName !== undefined) {
    updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: { fullName: fullName.trim() } },
      { new: true }
    ).select('-password -refreshToken');
  }

  // 2. Parse Date of Birth if birthday object is provided
  let parsedDob = dateOfBirth;
  if (!parsedDob && birthday?.year && birthday?.month && birthday?.day) {
    parsedDob = new Date(birthday.year, birthday.month - 1, birthday.day);
  }

  const profilePayload = {
    ...restData,
    ...(birthday ? { birthday } : {}),
    ...(parsedDob ? { dateOfBirth: parsedDob } : {}),
    user: userId
  };

  // 3. Upsert Profile
  const profile = await Profile.findOneAndUpdate(
    { user: userId },
    { $set: profilePayload },
    { new: true, upsert: true, runValidators: true }
  ).populate('user', 'fullName email isVerified lastActive');

  // Invalidate user profile and feed caches in Redis/Memory
  await Promise.all([
    CacheService.del(`profile:${userId.toString()}`),
    CacheService.delByPattern('feed:*')
  ]);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      { user: updatedUser, profile },
      'Profile updated successfully'
    )
  );
});

export const getProfileById = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const cacheKey = `profile:${userId}`;
  const profile = await CacheService.remember(cacheKey, 600, async () => {
    return await Profile.findOne({ user: userId }).populate('user', 'fullName isVerified lastActive');
  });

  if (!profile) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Profile not found');
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, profile, 'Profile retrieved successfully')
  );
});


export const getLookingForOptions = asyncHandler(async (req, res) => {
  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      LOOKING_FOR_OPTIONS,
      'Looking for options retrieved successfully'
    )
  );
});

export const getInterestOptions = asyncHandler(async (req, res) => {
  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      INTEREST_OPTIONS,
      'Interests retrieved successfully'
    )
  );
});
