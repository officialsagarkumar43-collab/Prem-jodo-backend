import { getRedisClient, isRedisReady } from '../config/redis.js';
import { ENV } from '../config/env.js';

// In-memory fallback storage with TTL support
const memoryCache = new Map();

const isExpired = (item) => {
  if (!item || !item.expiresAt) return false;
  return Date.now() > item.expiresAt;
};

// Periodic garbage collection for in-memory cache to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of memoryCache.entries()) {
    if (item.expiresAt && now > item.expiresAt) {
      memoryCache.delete(key);
    }
  }
}, 60000).unref();

export class CacheService {
  /**
   * Get cached item by key
   */
  static async get(key) {
    if (!key) return null;

    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        const data = await client.get(key);
        if (!data) return null;
        try {
          return JSON.parse(data);
        } catch {
          return data;
        }
      }
    } catch (err) {
      console.warn(`[CacheService] Redis get error for "${key}":`, err.message);
    }

    // Fallback: In-memory
    const memoryItem = memoryCache.get(key);
    if (!memoryItem) return null;

    if (isExpired(memoryItem)) {
      memoryCache.delete(key);
      return null;
    }
    return memoryItem.value;
  }

  /**
   * Set cached item with TTL in seconds
   */
  static async set(key, value, ttlSeconds = ENV.REDIS_DEFAULT_TTL) {
    if (!key || value === undefined) return false;

    const serialized = typeof value === 'object' ? JSON.stringify(value) : value;

    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        if (ttlSeconds && ttlSeconds > 0) {
          await client.set(key, serialized, 'EX', ttlSeconds);
        } else {
          await client.set(key, serialized);
        }
        return true;
      }
    } catch (err) {
      console.warn(`[CacheService] Redis set error for "${key}":`, err.message);
    }

    // Fallback: In-memory
    memoryCache.set(key, {
      value,
      expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null
    });
    return true;
  }

  /**
   * Delete a key from cache
   */
  static async del(key) {
    if (!key) return false;

    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        await client.del(key);
      }
    } catch (err) {
      console.warn(`[CacheService] Redis del error for "${key}":`, err.message);
    }

    memoryCache.delete(key);
    return true;
  }

  /**
   * Delete multiple keys matching a pattern (e.g. "cache:profile:*")
   */
  static async delByPattern(pattern) {
    if (!pattern) return 0;

    let deletedCount = 0;

    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        const stream = client.scanStream({
          match: pattern,
          count: 100
        });

        const keysToDelete = [];
        for await (const resultKeys of stream) {
          if (resultKeys.length) {
            keysToDelete.push(...resultKeys);
          }
        }

        if (keysToDelete.length > 0) {
          // Chunk deletes in batches of 100 to avoid blocking Redis
          for (let i = 0; i < keysToDelete.length; i += 100) {
            const chunk = keysToDelete.slice(i, i + 100);
            await client.del(...chunk);
            deletedCount += chunk.length;
          }
        }
      }
    } catch (err) {
      console.warn(`[CacheService] Redis delByPattern error for "${pattern}":`, err.message);
    }

    // Memory fallback regex matching
    try {
      const regexPattern = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      for (const key of memoryCache.keys()) {
        if (regexPattern.test(key)) {
          memoryCache.delete(key);
          deletedCount++;
        }
      }
    } catch (err) {
      console.warn(`[CacheService] Memory delByPattern error for "${pattern}":`, err.message);
    }

    return deletedCount;
  }

  /**
   * Cache-aside helper: Fetch from cache or compute & store
   */
  static async remember(key, ttlSeconds, fetchFn) {
    const cached = await this.get(key);
    if (cached !== null && cached !== undefined) {
      return cached;
    }

    const fresh = await fetchFn();
    if (fresh !== null && fresh !== undefined) {
      await this.set(key, fresh, ttlSeconds);
    }
    return fresh;
  }

  /**
   * Check if a key exists
   */
  static async has(key) {
    if (!key) return false;

    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        const exists = await client.exists(key);
        return exists === 1;
      }
    } catch (err) {
      console.warn(`[CacheService] Redis exists error for "${key}":`, err.message);
    }

    const item = memoryCache.get(key);
    if (!item) return false;
    if (isExpired(item)) {
      memoryCache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Set Operations: Add members to a set (useful for online presence, tags)
   */
  static async sadd(key, ...members) {
    if (!key || members.length === 0) return 0;
    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        return await client.sadd(key, ...members);
      }
    } catch (err) {
      console.warn(`[CacheService] Redis sadd error for "${key}":`, err.message);
    }

    let set = memoryCache.get(key)?.value;
    if (!(set instanceof Set)) {
      set = new Set();
      memoryCache.set(key, { value: set, expiresAt: null });
    }
    members.forEach((m) => set.add(m.toString()));
    return members.length;
  }

  /**
   * Set Operations: Remove members from a set
   */
  static async srem(key, ...members) {
    if (!key || members.length === 0) return 0;
    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        return await client.srem(key, ...members);
      }
    } catch (err) {
      console.warn(`[CacheService] Redis srem error for "${key}":`, err.message);
    }

    const set = memoryCache.get(key)?.value;
    if (set instanceof Set) {
      members.forEach((m) => set.delete(m.toString()));
    }
    return members.length;
  }

  /**
   * Set Operations: Get all members of a set
   */
  static async smembers(key) {
    if (!key) return [];
    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        return await client.smembers(key);
      }
    } catch (err) {
      console.warn(`[CacheService] Redis smembers error for "${key}":`, err.message);
    }

    const set = memoryCache.get(key)?.value;
    if (set instanceof Set) {
      return Array.from(set);
    }
    return [];
  }

  /**
   * List Operations: Atomic push to end of list with optional max length trim & TTL
   */
  static async rpushTrim(key, value, maxLength = 50, ttlSeconds = 3600) {
    if (!key || value === undefined) return false;
    const serialized = typeof value === 'object' ? JSON.stringify(value) : value;

    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        const pipeline = client.pipeline();
        pipeline.rpush(key, serialized);
        if (maxLength > 0) {
          pipeline.ltrim(key, -maxLength, -1);
        }
        if (ttlSeconds > 0) {
          pipeline.expire(key, ttlSeconds);
        }
        await pipeline.exec();
        return true;
      }
    } catch (err) {
      console.warn(`[CacheService] Redis rpushTrim error for "${key}":`, err.message);
    }

    // Memory fallback
    let list = memoryCache.get(key)?.value;
    if (!Array.isArray(list)) {
      list = [];
      memoryCache.set(key, { value: list, expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null });
    }
    list.push(value);
    if (maxLength > 0 && list.length > maxLength) {
      list.splice(0, list.length - maxLength);
    }
    return true;
  }

  /**
   * List Operations: Get range of elements from list
   */
  static async lrange(key, start = 0, stop = -1) {
    if (!key) return [];
    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        const items = await client.lrange(key, start, stop);
        return (items || []).map((item) => {
          try {
            return JSON.parse(item);
          } catch {
            return item;
          }
        });
      }
    } catch (err) {
      console.warn(`[CacheService] Redis lrange error for "${key}":`, err.message);
    }

    const item = memoryCache.get(key);
    if (!item || !Array.isArray(item.value)) return [];
    if (isExpired(item)) {
      memoryCache.delete(key);
      return [];
    }
    const list = item.value;
    const effectiveStop = stop === -1 ? list.length : stop + 1;
    return list.slice(start, effectiveStop);
  }

  /**
   * Flush all application cache
   */
  static async flush() {
    try {
      if (isRedisReady()) {
        const client = getRedisClient();
        await client.flushdb();
      }
    } catch (err) {
      console.warn('[CacheService] Redis flushdb error:', err.message);
    }
    memoryCache.clear();
    return true;
  }
}
