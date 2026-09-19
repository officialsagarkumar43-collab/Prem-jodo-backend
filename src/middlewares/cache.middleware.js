import { CacheService } from '../services/cache.service.js';

/**
 * Express Middleware to cache API responses
 * @param {number} ttlSeconds Time-to-live in seconds (default: 300 / 5 minutes)
 * @param {Function} [customKeyGenerator] Optional custom cache key generator (req) => string
 */
export const cacheResponse = (ttlSeconds = 300, customKeyGenerator = null) => {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    const cacheKey = customKeyGenerator
      ? customKeyGenerator(req)
      : `api:cache:${req.originalUrl || req.url}`;

    try {
      const cachedData = await CacheService.get(cacheKey);

      if (cachedData !== null && cachedData !== undefined) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(cachedData);
      }

      res.setHeader('X-Cache', 'MISS');

      // Intercept res.json to cache response body
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Cache only successful 2xx responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          CacheService.set(cacheKey, body, ttlSeconds).catch((err) => {
            console.warn(`[CacheMiddleware] Failed to cache response for ${cacheKey}:`, err.message);
          });
        }
        return originalJson(body);
      };

      next();
    } catch (error) {
      console.warn(`[CacheMiddleware] Error in cache middleware for ${cacheKey}:`, error.message);
      next();
    }
  };
};
