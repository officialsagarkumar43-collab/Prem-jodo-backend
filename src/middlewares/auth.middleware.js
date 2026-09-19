import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ENV } from '../config/env.js';
import { CacheService } from '../services/cache.service.js';

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

export const verifyAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    throw new ApiError(403, 'Access denied. Administrator privileges required.');
  }
  next();
};

