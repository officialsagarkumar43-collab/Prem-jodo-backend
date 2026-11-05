import mongoose from 'mongoose';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { Payment } from '../models/Payment.js';
import { Match } from '../models/Match.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { CacheService } from '../services/cache.service.js';
import { deleteUploadedFile } from '../middlewares/upload.middleware.js';
import { runInTransaction } from '../utils/transaction.js';
import {
  HTTP_STATUS,
  LOOKING_FOR_OPTIONS,
  INTEREST_OPTIONS,
  USER_ROLES,
  MEMBERSHIP_TIERS,
  SUBSCRIPTION_STATUS
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
    CacheService.delByPattern('feed:*'),
    CacheService.delByPattern('see_who_likes:*')
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

// ==========================================
// Admin Controllers: User Management
// ==========================================

/**
 * 1. Admin: Create a new user
 * Admin only
 */
export const createUserAdmin = asyncHandler(async (req, res) => {
  const {
    fullName = '',
    email,
    phoneNumber,
    password,
    role = USER_ROLES.USER,
    isActive = true,
    isVerified = true,
    isFaceVerification = false,
    isOnboarded = false,
    subscriptionPlan = MEMBERSHIP_TIERS.FREE,
    // Profile details (optional)
    gender,
    bio = '',
    lookingFor = 'Long-term partner',
    interestedIn,
    birthday,
    dateOfBirth,
    religion = '',
    education = '',
    city = '',
    state = '',
    country = 'India'
  } = req.body;

  if (!email || !email.trim()) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Email is required');
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Check existing user by email
  const existingEmailUser = await User.findOne({ email: normalizedEmail });
  if (existingEmailUser) {
    throw new ApiError(HTTP_STATUS.CONFLICT, `User with email "${normalizedEmail}" already exists`);
  }

  // Check existing user by phone if provided
  if (phoneNumber && phoneNumber.trim()) {
    const existingPhoneUser = await User.findOne({ phoneNumber: phoneNumber.trim() });
    if (existingPhoneUser) {
      throw new ApiError(HTTP_STATUS.CONFLICT, `User with phone number "${phoneNumber.trim()}" already exists`);
    }
  }

  // Non-owner admin cannot create admin or owner accounts
  const isOwner = req.user?.role === USER_ROLES.OWNER;
  if (!isOwner && role && role !== USER_ROLES.USER) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Access denied. Only owner can create admin accounts.');
  }

  const userDoc = new User({
    fullName: fullName.trim(),
    email: normalizedEmail,
    phoneNumber: phoneNumber?.trim() || undefined,
    password: password || undefined,
    role: role || USER_ROLES.USER,
    isActive: Boolean(isActive),
    isVerified: Boolean(isVerified),
    isFaceVerification: Boolean(isFaceVerification),
    isOnboarded: Boolean(isOnboarded || gender),
    subscription: {
      plan: subscriptionPlan || MEMBERSHIP_TIERS.FREE,
      planName: subscriptionPlan ? `Prem Jodo ${subscriptionPlan.charAt(0).toUpperCase() + subscriptionPlan.slice(1)}` : 'Prem Jodo Free',
      status: subscriptionPlan && subscriptionPlan !== MEMBERSHIP_TIERS.FREE ? SUBSCRIPTION_STATUS.ACTIVE : SUBSCRIPTION_STATUS.PENDING
    }
  });

  await userDoc.save();

  // Create Profile if gender or any profile details are provided
  let parsedDob = dateOfBirth;
  if (!parsedDob && birthday?.year && birthday?.month && birthday?.day) {
    parsedDob = new Date(birthday.year, birthday.month - 1, birthday.day);
  }

  const profileDoc = await Profile.create({
    user: userDoc._id,
    gender: gender || undefined,
    bio: bio || '',
    lookingFor: lookingFor || 'Long-term partner',
    interestedIn: interestedIn ? (Array.isArray(interestedIn) ? interestedIn : [interestedIn]) : undefined,
    birthday: birthday || undefined,
    dateOfBirth: parsedDob || undefined,
    religion: religion || '',
    education: education || '',
    location: {
      type: 'Point',
      coordinates: [0, 0],
      city: city || '',
      state: state || '',
      country: country || 'India'
    }
  });

  const responseUser = userDoc.toObject();
  delete responseUser.password;
  delete responseUser.refreshToken;

  return res.status(HTTP_STATUS.CREATED).json(
    new ApiResponse(
      HTTP_STATUS.CREATED,
      { user: responseUser, profile: profileDoc },
      'User created successfully by admin'
    )
  );
});

/**
 * 2. Admin: Get all users with filters, search, and pagination
 * Admin only
 */
export const getAllUsersAdmin = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const {
    search,
    role,
    isActive,
    isVerified,
    isFaceVerification,
    plan,
    startDate,
    endDate,
    sortBy = 'createdAt',
    order = 'desc'
  } = req.query;

  // Role visibility:
  // - Admin (non-owner) ko ONLY 'user' role ka data dikhega
  // - Owner ko 'owner' role ka NAHI dikhega, baki sabhi roles (user, admin, etc.) ka dikhega
  const isOwner = req.user?.role === USER_ROLES.OWNER;
  const filter = {};

  if (!isOwner) {
    filter.role = USER_ROLES.USER;
  } else if (role && role !== 'all') {
    const requestedRole = role.toLowerCase();
    if (requestedRole === USER_ROLES.OWNER) {
      filter.role = { $in: [] };
    } else {
      filter.role = requestedRole;
    }
  } else {
    filter.role = { $ne: USER_ROLES.OWNER };
  }

  if (isActive !== undefined && isActive !== 'all') {
    filter.isActive = isActive === 'true' || isActive === true;
  }

  if (isVerified !== undefined && isVerified !== 'all') {
    filter.isVerified = isVerified === 'true' || isVerified === true;
  }

  if (isFaceVerification !== undefined && isFaceVerification !== 'all') {
    filter.isFaceVerification = isFaceVerification === 'true' || isFaceVerification === true;
  }

  if (plan && plan !== 'all') {
    filter['subscription.plan'] = plan.toLowerCase();
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) {
      filter.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  if (search && search.trim()) {
    const s = search.trim();
    filter.$or = [
      { fullName: { $regex: s, $options: 'i' } },
      { email: { $regex: s, $options: 'i' } },
      { phoneNumber: { $regex: s, $options: 'i' } }
    ];
  }

  const sortOrder = order === 'asc' ? 1 : -1;

  const [users, total, statsAgg] = await Promise.all([
    User.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .select('-password -refreshToken')
      .lean(),
    User.countDocuments(filter),
    User.aggregate([
      {
        $match: !isOwner
          ? { role: USER_ROLES.USER }
          : { role: { $ne: USER_ROLES.OWNER } }
      },
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          activeUsers: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
          verifiedUsers: { $sum: { $cond: [{ $eq: ['$isVerified', true] }, 1, 0] } },
          faceVerifiedUsers: { $sum: { $cond: [{ $eq: ['$isFaceVerification', true] }, 1, 0] } },
          premiumUsers: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$subscription.plan', MEMBERSHIP_TIERS.FREE] },
                    { $eq: ['$subscription.status', SUBSCRIPTION_STATUS.ACTIVE] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ])
  ]);

  // Fetch profiles for users
  const userIds = users.map((u) => u._id);
  const profiles = await Profile.find({ user: { $in: userIds } })
    .select('user gender photos city state dateOfBirth lookingFor bio')
    .lean();
  const profileMap = new Map(profiles.map((p) => [p.user.toString(), p]));

  const usersWithProfiles = users.map((user) => ({
    ...user,
    profile: profileMap.get(user._id.toString()) || null
  }));

  const totalPages = Math.ceil(total / limit) || 0;

  const summary = statsAgg[0] || {
    totalUsers: total,
    activeUsers: 0,
    verifiedUsers: 0,
    faceVerifiedUsers: 0,
    premiumUsers: 0
  };
  delete summary._id;

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        users: usersWithProfiles,
        summary,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      },
      'Users retrieved successfully'
    )
  );
});

/**
 * 3. Admin: Get single user by ID, email, or phone
 * Admin only
 */
export const getUserByIdAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  let userQuery;
  if (mongoose.isValidObjectId(id)) {
    userQuery = { _id: id };
  } else {
    userQuery = {
      $or: [
        { email: id.toLowerCase().trim() },
        { phoneNumber: id.trim() }
      ]
    };
  }

  const user = await User.findOne(userQuery).select('-password -refreshToken').lean();
  if (!user) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  const isOwner = req.user?.role === USER_ROLES.OWNER;
  // Owner role account is never visible
  if (user.role === USER_ROLES.OWNER) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  // Non-owner admin can only view regular users
  if (!isOwner && user.role !== USER_ROLES.USER) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  const [profile, recentPayments] = await Promise.all([
    Profile.findOne({ user: user._id }).lean(),
    Payment.find({ user: user._id }).sort({ createdAt: -1 }).limit(10).lean()
  ]);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        user: {
          ...user,
          profile: profile || null,
          recentPayments: recentPayments || []
        }
      },
      'User details retrieved successfully'
    )
  );
});

/**
 * 4. Admin: Update user details & status
 * Admin only
 */
export const updateUserAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid User ID');
  }

  const user = await User.findById(id);
  if (!user) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  // Owner accounts cannot be modified via admin user APIs
  if (user.role === USER_ROLES.OWNER) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Owner account cannot be modified');
  }

  // Non-owner admin can only update regular user accounts
  const isOwner = req.user?.role === USER_ROLES.OWNER;
  if (!isOwner && user.role !== USER_ROLES.USER) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Access denied. You can only update regular user accounts.');
  }

  // Non-owner admin cannot escalate someone to admin or owner
  if (!isOwner && req.body.role && req.body.role !== USER_ROLES.USER) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Access denied. Only owner can change user roles.');
  }

  const {
    fullName,
    email,
    phoneNumber,
    password,
    role,
    isActive,
    isVerified,
    isFaceVerification,
    isOnboarded,
    subscriptionPlan,
    subscriptionStatus,
    // Profile details
    gender,
    bio,
    lookingFor,
    interestedIn,
    birthday,
    dateOfBirth,
    religion,
    education,
    city,
    state
  } = req.body;

  if (email && email.toLowerCase().trim() !== user.email) {
    const existing = await User.findOne({ email: email.toLowerCase().trim(), _id: { $ne: id } });
    if (existing) {
      throw new ApiError(HTTP_STATUS.CONFLICT, `Email "${email}" is already used by another account`);
    }
    user.email = email.toLowerCase().trim();
  }

  if (phoneNumber !== undefined && phoneNumber !== user.phoneNumber) {
    if (phoneNumber && phoneNumber.trim()) {
      const existingPhone = await User.findOne({ phoneNumber: phoneNumber.trim(), _id: { $ne: id } });
      if (existingPhone) {
        throw new ApiError(HTTP_STATUS.CONFLICT, `Phone number "${phoneNumber}" is already used by another account`);
      }
      user.phoneNumber = phoneNumber.trim();
    } else {
      user.phoneNumber = undefined;
    }
  }

  if (fullName !== undefined) user.fullName = fullName.trim();
  if (role !== undefined) user.role = role;
  if (isActive !== undefined) user.isActive = Boolean(isActive);
  if (isVerified !== undefined) user.isVerified = Boolean(isVerified);
  if (isFaceVerification !== undefined) user.isFaceVerification = Boolean(isFaceVerification);
  if (isOnboarded !== undefined) user.isOnboarded = Boolean(isOnboarded);
  if (password && password.trim()) user.password = password.trim();

  if (subscriptionPlan !== undefined) {
    user.subscription.plan = subscriptionPlan;
    user.subscription.planName = `Prem Jodo ${subscriptionPlan.charAt(0).toUpperCase() + subscriptionPlan.slice(1)}`;
  }
  if (subscriptionStatus !== undefined) {
    user.subscription.status = subscriptionStatus;
  }

  await user.save();

  // Invalidate cache
  await CacheService.del(`profile:${id.toString()}`);

  // Update profile if profile fields provided
  let profileDoc = await Profile.findOne({ user: id });
  const profileUpdates = {};
  if (gender !== undefined) profileUpdates.gender = gender;
  if (bio !== undefined) profileUpdates.bio = bio;
  if (lookingFor !== undefined) profileUpdates.lookingFor = lookingFor;
  if (interestedIn !== undefined) {
    profileUpdates.interestedIn = Array.isArray(interestedIn) ? interestedIn : [interestedIn];
  }
  if (birthday !== undefined) profileUpdates.birthday = birthday;
  if (dateOfBirth !== undefined) profileUpdates.dateOfBirth = dateOfBirth;
  if (religion !== undefined) profileUpdates.religion = religion;
  if (education !== undefined) profileUpdates.education = education;
  if (city !== undefined) profileUpdates['location.city'] = city;
  if (state !== undefined) profileUpdates['location.state'] = state;

  if (Object.keys(profileUpdates).length > 0) {
    profileDoc = await Profile.findOneAndUpdate(
      { user: id },
      { $set: profileUpdates },
      { new: true, upsert: true, runValidators: true }
    );
  }

  const updatedUser = user.toObject();
  delete updatedUser.password;
  delete updatedUser.refreshToken;

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      { user: updatedUser, profile: profileDoc },
      'User updated successfully by admin'
    )
  );
});

/**
 * 5. Admin: Delete a user
 * Admin only
 */
export const deleteUserAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid User ID');
  }

  const user = await User.findById(id);
  if (!user) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  // Non-owner admin can only delete regular user accounts
  const isOwner = req.user?.role === USER_ROLES.OWNER;
  if (!isOwner && user.role !== USER_ROLES.USER) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Access denied. You can only delete regular user accounts.');
  }

  // Prevent deleting owner accounts
  if (user.role === USER_ROLES.OWNER) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Owner accounts cannot be deleted');
  }

  await Promise.all([
    User.findByIdAndDelete(id),
    Profile.findOneAndDelete({ user: id }),
    Match.deleteMany({ $or: [{ sender: id }, { receiver: id }] }),
    CacheService.del(`profile:${id}`)
  ]);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { id }, 'User and profile deleted successfully by admin')
  );
});
