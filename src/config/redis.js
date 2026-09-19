import Redis from 'ioredis';
import { ENV } from './env.js';

let redisClient = null;
let isReady = false;
let hasLoggedConnectionError = false;

/**
 * Initialize Redis client with resilient connection logic and graceful fallback
 */
export const initializeRedis = () => {
  if (!ENV.REDIS_ENABLED) {
    console.log('ℹ️ Redis is disabled via REDIS_ENABLED=false');
    return null;
  }

  if (redisClient) {
    return redisClient;
  }

  try {
    const redisOptions = {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      retryStrategy(times) {
        if (times > 5) {
          if (!hasLoggedConnectionError) {
            console.warn('⚠️ Redis unreachable after multiple retries. Using in-memory fallback.');
            hasLoggedConnectionError = true;
          }
          return null; // Stop auto-reconnection spam
        }
        return Math.min(times * 200, 2000);
      }
    };

    if (ENV.REDIS_PASSWORD) {
      redisOptions.password = ENV.REDIS_PASSWORD;
    }

    if (ENV.REDIS_URL && ENV.REDIS_URL.startsWith('redis')) {
      redisClient = new Redis(ENV.REDIS_URL, redisOptions);
    } else {
      redisClient = new Redis({
        host: ENV.REDIS_HOST,
        port: ENV.REDIS_PORT,
        ...redisOptions
      });
    }

    redisClient.on('connect', () => {
      hasLoggedConnectionError = false;
      console.log('🔌 Redis connecting...');
    });

    redisClient.on('ready', () => {
      isReady = true;
      hasLoggedConnectionError = false;
      console.log(`🚀 Redis Client Connected successfully on ${ENV.REDIS_URL || `${ENV.REDIS_HOST}:${ENV.REDIS_PORT}`}`);
    });

    redisClient.on('error', (err) => {
      isReady = false;
      if (!hasLoggedConnectionError) {
        console.warn(`⚠️ Redis Connection Issue: ${err.message}. Operating in fallback mode.`);
        hasLoggedConnectionError = true;
      }
    });

    redisClient.on('close', () => {
      isReady = false;
    });

    redisClient.on('reconnecting', () => {
      isReady = false;
    });

    return redisClient;
  } catch (error) {
    console.warn('⚠️ Failed to initialize Redis client:', error.message);
    isReady = false;
    return null;
  }
};

/**
 * Returns whether Redis is connected and ready to receive commands
 */
export const isRedisReady = () => {
  return isReady && redisClient && redisClient.status === 'ready';
};

/**
 * Get the active Redis client instance
 */
export const getRedisClient = () => {
  if (!redisClient && ENV.REDIS_ENABLED) {
    return initializeRedis();
  }
  return redisClient;
};

/**
 * Health status helper
 */
export const getRedisStatus = () => {
  return {
    enabled: ENV.REDIS_ENABLED,
    ready: isRedisReady(),
    status: redisClient ? redisClient.status : 'disconnected',
    host: ENV.REDIS_URL || `${ENV.REDIS_HOST}:${ENV.REDIS_PORT}`
  };
};

/**
 * Gracefully disconnect Redis on server shutdown
 */
export const disconnectRedis = async () => {
  if (redisClient) {
    try {
      await redisClient.quit();
      console.log('🛑 Redis connection closed gracefully');
    } catch (e) {
      redisClient.disconnect();
    }
  }
};
