import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ENV } from '../config/env.js';
import { CacheService } from '../services/cache.service.js';
import { USER_ROLES } from '../constants/index.js';

export const verifyJWT = asyncHandler(async (req, res, next) => {
  const token =
    req.cookies?.accessToken ||
    req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    throw new ApiError(401, 'Unauthorized request. No token provided.');
  }

  // Check if token has been invalidated via logout
  const isBlacklisted = await CacheService.get(`blacklist_${token}`);
  if (isBlacklisted) {
    throw new ApiError(401, 'Token has been invalidated / logged out. Please login again.');
  }

  try {
    const decodedToken = jwt.verify(token, ENV.JWT_ACCESS_SECRET);
    const user = await User.findById(decodedToken?._id).select('-password -refreshToken -subscription');

    if (!user) {
      throw new ApiError(401, 'Invalid Access Token');
    }

    req.user = user;
    next();
  } catch (error) {
    throw new ApiError(401, error?.message || 'Invalid or expired Access Token');
  }
});

// Middleware to verify Administrator or Owner privileges
export const verifyAdmin = (req, res, next) => {
  const allowedRoles = [USER_ROLES.ADMIN, USER_ROLES.OWNER];
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    throw new ApiError(403, 'Access denied. Administrator or Owner privileges required.');
  }
  next();
};

export const verifyAdminOrOwner = verifyAdmin;

// Middleware to verify Owner-only privileges
export const verifyOwner = (req, res, next) => {
  if (!req.user || req.user.role !== USER_ROLES.OWNER) {
    throw new ApiError(403, 'Access denied. Owner privileges required.');
  }
  next();
};

