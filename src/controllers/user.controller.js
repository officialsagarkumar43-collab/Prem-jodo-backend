import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { CacheService } from '../services/cache.service.js';
import { deleteUploadedFile } from '../middlewares/upload.middleware.js';
import { runInTransaction } from '../utils/transaction.js';
import {
  HTTP_STATUS,
  LOOKING_FOR_OPTIONS,
  INTEREST_OPTIONS
} from '../constants/index.js';

// Helper to extract relative path from full URLs (e.g. http://localhost:5000/uploads/... -> /uploads/...)
const normalizePhotoUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      const parsed = new URL(rawUrl);
      return parsed.pathname;
    }
  } catch {
    // Ignore URL parse error
  }
  return rawUrl.trim();
};

export const upsertProfile = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { fullName, birthday, dateOfBirth, photos, existingPhotos, ...restData } = req.body;

  // Parse Date of Birth if birthday object is provided
  let parsedDob = dateOfBirth;
  if (!parsedDob && birthday?.year && birthday?.month && birthday?.day) {
    parsedDob = new Date(birthday.year, birthday.month - 1, birthday.day);
  }

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
      // Neither new files nor photo inputs provided: keep existing photos in DB
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

  // Deduplicate by URL while preserving the first-seen order
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
      deleteUploadedFile(cleanOldUrl).catch((err) => {
        console.warn(`[upsertProfile] Failed to delete removed photo ${cleanOldUrl}:`, err.message);
      });
    }
  }

  const profilePayload = {
    ...restData,
    ...(birthday ? { birthday } : {}),
    ...(parsedDob ? { dateOfBirth: parsedDob } : {}),
    photos: finalPhotos,
    user: userId
  };

  // Perform multi-collection update using Mongoose Session Transaction
  const { updatedUser, profile } = await runInTransaction(async (session) => {
    let userDoc = req.user;
    if (fullName !== undefined) {
      userDoc = await User.findByIdAndUpdate(
        userId,
        { $set: { fullName: fullName.trim() } },
        { new: true, session }
      ).select('-password -refreshToken');
    }

    const profileDoc = await Profile.findOneAndUpdate(
      { user: userId },
      { $set: profilePayload },
      { new: true, upsert: true, runValidators: true, session }
    ).populate('user', 'fullName email isVerified isFaceVerification lastActive');

    return { updatedUser: userDoc, profile: profileDoc };
  });

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
    return await Profile.findOne({ user: userId }).populate('user', 'fullName isVerified isFaceVerification lastActive');
  });

  if (!profile) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Profile not found');
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, profile, 'Profile retrieved successfully')
  );
});

export const uploadPhotos = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  if (!req.files || req.files.length === 0) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Please upload at least one image file');
  }

  const newPhotos = req.files.map((file) => ({
    url: file.fileUrl,
    isPrimary: false
  }));

  const profile = await Profile.findOneAndUpdate(
    { user: userId },
    {
      $push: { photos: { $each: newPhotos } }
    },
    { new: true, upsert: true }
  );

  if (profile.photos.length > 0 && !profile.photos.some((p) => p.isPrimary)) {
    profile.photos[0].isPrimary = true;
    await profile.save();
  }

  await CacheService.del(`profile:${userId.toString()}`);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      { profile, addedPhotos: newPhotos },
      'Photos uploaded and optimized successfully'
    )
  );
});

export const deletePhoto = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { photoId, photoUrl } = req.body;

  if (!photoId && !photoUrl) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'photoId or photoUrl is required to delete a photo');
  }

  const profile = await Profile.findOne({ user: userId });
  if (!profile) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Profile not found');
  }

  const targetPhoto = profile.photos.find(
    (p) => (photoId && p._id.toString() === photoId) || (photoUrl && p.url === photoUrl)
  );

  if (!targetPhoto) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Photo not found on user profile');
  }

  // Remove photo from profile
  profile.photos = profile.photos.filter((p) => p._id.toString() !== targetPhoto._id.toString());

  // If deleted photo was primary and others remain, set first as primary
  if (targetPhoto.isPrimary && profile.photos.length > 0) {
    profile.photos[0].isPrimary = true;
  }

  await profile.save();

  // Delete file from disk
  if (targetPhoto.url) {
    await deleteUploadedFile(targetPhoto.url);
  }

  await CacheService.del(`profile:${userId.toString()}`);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { profile }, 'Photo deleted successfully')
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
