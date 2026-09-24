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



export const upsertProfile = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { fullName, birthday, dateOfBirth, photos, ...restData } = req.body;

  // Parse Date of Birth if birthday object is provided
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

  // Parse order from req.body if provided (e.g. order: [2, 0, 1] or order: "2,0,1")
  let order = req.body.order ?? req.body.photoOrder ?? req.body.sortOrder ?? req.body.orders;
  if (typeof order === 'string') {
    try {
      order = JSON.parse(order);
    } catch {
      if (order.includes(',')) {
        order = order.split(',').map((x) => x.trim());
      } else if (!isNaN(order)) {
        order = [Number(order)];
      }
    }
  }

  // Primary image preferences
  const primaryIndex = req.body.primaryIndex !== undefined ? Number(req.body.primaryIndex) : -1;
  const setAsPrimary = req.body.isPrimary === true || req.body.isPrimary === 'true';

  let newPhotos = req.files.map((file, idx) => ({
    url: file.fileUrl,
    isPrimary: primaryIndex === idx || (setAsPrimary && idx === 0)
  }));

  // If order array of indices is provided, sort newPhotos accordingly
  if (Array.isArray(order) && order.length > 0) {
    if (order.every((x) => typeof x === 'number' || (!isNaN(x) && typeof x === 'string'))) {
      const numericOrder = order.map(Number);
      const orderedNewPhotos = [];
      const usedIndices = new Set();

      for (const idx of numericOrder) {
        if (idx >= 0 && idx < newPhotos.length && !usedIndices.has(idx)) {
          orderedNewPhotos.push(newPhotos[idx]);
          usedIndices.add(idx);
        }
      }

      // Append any unmentioned uploaded photos in their original order
      newPhotos.forEach((photo, idx) => {
        if (!usedIndices.has(idx)) {
          orderedNewPhotos.push(photo);
        }
      });

      newPhotos = orderedNewPhotos;
    }
  }

  const profile = await Profile.findOneAndUpdate(
    { user: userId },
    {
      $push: { photos: { $each: newPhotos } }
    },
    { new: true, upsert: true }
  );

  // If primary was set on a new photo, reset existing photos primary flag
  if (newPhotos.some((p) => p.isPrimary)) {
    const primaryUrl = newPhotos.find((p) => p.isPrimary).url;
    profile.photos.forEach((p) => {
      p.isPrimary = p.url === primaryUrl;
    });
    await profile.save({ validateBeforeSave: false });
  } else if (profile.photos.length > 0 && !profile.photos.some((p) => p.isPrimary)) {
    profile.photos[0].isPrimary = true;
    await profile.save({ validateBeforeSave: false });
  }

  await CacheService.del(`profile:${userId.toString()}`);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      { profile, addedPhotos: newPhotos },
      'Photos uploaded and sorted successfully'
    )
  );
});

export const reorderPhotos = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { photoIds, photoUrls, photos } = req.body;

  const profile = await Profile.findOne({ user: userId });
  if (!profile) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Profile not found');
  }

  if (Array.isArray(photos) && photos.length > 0) {
    const existingMap = new Map(profile.photos.map((p) => [p._id.toString(), p]));
    const urlMap = new Map(profile.photos.map((p) => [p.url, p]));

    const reordered = [];
    for (const item of photos) {
      const match =
        (item._id && existingMap.get(item._id.toString())) ||
        (item.photoId && existingMap.get(item.photoId.toString())) ||
        (item.url && urlMap.get(item.url));

      if (match) {
        if (item.isPrimary !== undefined) {
          match.isPrimary = Boolean(item.isPrimary);
        }
        reordered.push(match);
      }
    }

    if (reordered.length > 0) {
      for (const p of profile.photos) {
        if (!reordered.some((r) => r._id.toString() === p._id.toString())) {
          reordered.push(p);
        }
      }
      profile.photos = reordered;
    }
  } else if (Array.isArray(photoIds) && photoIds.length > 0) {
    const idMap = new Map(profile.photos.map((p) => [p._id.toString(), p]));
    const reordered = [];
    for (const id of photoIds) {
      if (idMap.has(id.toString())) {
        reordered.push(idMap.get(id.toString()));
      }
    }
    for (const p of profile.photos) {
      if (!reordered.some((r) => r._id.toString() === p._id.toString())) {
        reordered.push(p);
      }
    }
    profile.photos = reordered;
  } else if (Array.isArray(photoUrls) && photoUrls.length > 0) {
    const urlMap = new Map(profile.photos.map((p) => [p.url, p]));
    const reordered = [];
    for (const url of photoUrls) {
      if (urlMap.has(url)) {
        reordered.push(urlMap.get(url));
      }
    }
    for (const p of profile.photos) {
      if (!reordered.some((r) => r.url === p.url)) {
        reordered.push(p);
      }
    }
    profile.photos = reordered;
  } else {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'photoIds, photoUrls, or photos array is required for reordering');
  }

  // Ensure at least one photo is primary
  if (profile.photos.length > 0 && !profile.photos.some((p) => p.isPrimary)) {
    profile.photos[0].isPrimary = true;
  }

  await profile.save({ validateBeforeSave: false });
  await CacheService.del(`profile:${userId.toString()}`);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { profile }, 'Photos reordered successfully')
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
