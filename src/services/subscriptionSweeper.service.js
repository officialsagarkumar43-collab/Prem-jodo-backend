import cron from 'node-cron';
import { User } from '../models/User.js';
import { Profile } from '../models/Profile.js';
import { SUBSCRIPTION_STATUS, MEMBERSHIP_TIERS } from '../constants/index.js';
import { CacheService } from './cache.service.js';
import { emitToUser } from '../sockets/index.js';

let cronTask = null;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Helper to check and refill plan quota on-demand (used by getMySubscription and Cron)
 * Preserves purchased addon credits intact while resetting plan quotas!
 */
export const checkAndRefillUserQuotas = (user) => {
  if (!user || !user.subscription || user.subscription.status !== SUBSCRIPTION_STATUS.ACTIVE) {
    return false;
  }

  let isModified = false;
  const now = Date.now();

  // 1. Normalize superLikes fields if needed
  const weeklySuperLikesQuota = user.subscription.perks?.superLikesPerWeek || 0;
  if (user.subscription.planSuperLikesRemaining === undefined) {
    const currentTotal = user.subscription.superLikesRemaining ?? weeklySuperLikesQuota;
    if (currentTotal >= weeklySuperLikesQuota) {
      user.subscription.planSuperLikesRemaining = weeklySuperLikesQuota;
      user.subscription.addonSuperLikesRemaining = currentTotal - weeklySuperLikesQuota;
    } else {
      user.subscription.planSuperLikesRemaining = currentTotal;
      user.subscription.addonSuperLikesRemaining = 0;
    }
    isModified = true;
  }
  if (user.subscription.addonSuperLikesRemaining === undefined) {
    user.subscription.addonSuperLikesRemaining = 0;
    isModified = true;
  }

  // Check 7-day weekly superlikes refill
  if (weeklySuperLikesQuota > 0) {
    const lastSuperLikesRefill =
      user.subscription.lastSuperLikesRefillAt ||
      user.subscription.startDate ||
      user.createdAt ||
      new Date();
    const elapsedSuperLikes = now - new Date(lastSuperLikesRefill).getTime();

    if (elapsedSuperLikes >= SEVEN_DAYS_MS) {
      user.subscription.planSuperLikesRemaining = weeklySuperLikesQuota;
      user.subscription.superLikesRemaining =
        weeklySuperLikesQuota + (user.subscription.addonSuperLikesRemaining || 0);
      user.subscription.lastSuperLikesRefillAt = new Date();
      isModified = true;
    }
  }

  // 2. Normalize boosts fields if needed
  const monthlyBoostsQuota = user.subscription.perks?.profileBoostPerMonth || 0;
  if (user.subscription.planBoostsRemaining === undefined) {
    const currentTotal = user.subscription.boostsRemaining ?? monthlyBoostsQuota;
    if (currentTotal >= monthlyBoostsQuota) {
      user.subscription.planBoostsRemaining = monthlyBoostsQuota;
      user.subscription.addonBoostsRemaining = currentTotal - monthlyBoostsQuota;
    } else {
      user.subscription.planBoostsRemaining = currentTotal;
      user.subscription.addonBoostsRemaining = 0;
    }
    isModified = true;
  }
  if (user.subscription.addonBoostsRemaining === undefined) {
    user.subscription.addonBoostsRemaining = 0;
    isModified = true;
  }

  // Check 30-day monthly profile boost refill
  if (monthlyBoostsQuota > 0) {
    const lastBoostsRefill =
      user.subscription.lastBoostsRefillAt ||
      user.subscription.startDate ||
      user.createdAt ||
      new Date();
    const elapsedBoosts = now - new Date(lastBoostsRefill).getTime();

    if (elapsedBoosts >= THIRTY_DAYS_MS) {
      user.subscription.planBoostsRemaining = monthlyBoostsQuota;
      user.subscription.boostsRemaining =
        monthlyBoostsQuota + (user.subscription.addonBoostsRemaining || 0);
      user.subscription.lastBoostsRefillAt = new Date();
      isModified = true;
    }
  }

  return isModified;
};

/**
 * 1. Check & Expire Subscriptions past their endDate
 */
export const checkAndExpireSubscriptions = async () => {
  try {
    const now = new Date();

    // Find all active subscriptions that have passed their expiration date
    const expiredUsers = await User.find({
      'subscription.status': SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.endDate': { $ne: null, $lt: now }
    }).select('_id subscription');

    if (!expiredUsers || expiredUsers.length === 0) {
      return 0;
    }

    const userIds = expiredUsers.map((u) => u._id);

    // Batch update all expired users to FREE tier and reset credits & perks
    await User.updateMany(
      { _id: { $in: userIds } },
      {
        $set: {
          'subscription.status': SUBSCRIPTION_STATUS.EXPIRED,
          'subscription.plan': MEMBERSHIP_TIERS.FREE,
          'subscription.planName': 'Prem Jodo Free',
          'subscription.autoRenew': false,
          'subscription.boostsRemaining': 0,
          'subscription.planBoostsRemaining': 0,
          'subscription.addonBoostsRemaining': 0,
          'subscription.superLikesRemaining': 0,
          'subscription.planSuperLikesRemaining': 0,
          'subscription.addonSuperLikesRemaining': 0,
          'subscription.perks': {
            unlimitedSwipes: false,
            rewindAllowed: false,
            superLikesPerWeek: 0,
            passportLocation: false,
            seeWhoLikedYou: false,
            profileBoostPerMonth: 0,
            priorityLikes: false,
            messageBeforeMatch: false,
            vipBadge: false
          }
        }
      }
    );

    // Reset boosted status for these users on their profiles
    await Profile.updateMany(
      { user: { $in: userIds } },
      { $set: { isBoosted: false, boostExpiresAt: null } }
    );

    // Invalidate caches and notify online users
    for (const u of expiredUsers) {
      const uStr = u._id.toString();
      CacheService.del(`user:${uStr}`).catch(() => { });
      CacheService.del(`profile:${uStr}`).catch(() => { });
      CacheService.delByPattern('feed:*').catch(() => { });

      emitToUser(uStr, 'subscription_expired', {
        status: SUBSCRIPTION_STATUS.EXPIRED,
        message: 'Your membership subscription has expired.',
        timestamp: now.toISOString()
      });

      emitToUser(uStr, 'membership_updated', {
        status: SUBSCRIPTION_STATUS.EXPIRED,
        plan: MEMBERSHIP_TIERS.FREE,
        boostsRemaining: 0,
        superLikesRemaining: 0,
        timestamp: now.toISOString()
      });
    }

    console.log(`⏰ [Subscription Cron] Successfully expired ${expiredUsers.length} subscription(s).`);
    return expiredUsers.length;
  } catch (err) {
    console.error('❌ [Subscription Cron Error]:', err.message);
    return 0;
  }
};

/**
 * 2. Check & Expire Profile Boosts past their 24h duration
 */
export const checkAndExpireBoosts = async () => {
  try {
    const now = new Date();
    const result = await Profile.updateMany(
      { isBoosted: true, boostExpiresAt: { $ne: null, $lt: now } },
      { $set: { isBoosted: false, boostExpiresAt: null } }
    );

    if (result.modifiedCount > 0) {
      console.log(`🚀 [Boost Cron] Expired ${result.modifiedCount} profile boost(s).`);
      await CacheService.delByPattern('feed:*').catch(() => { });
    }

    return result.modifiedCount;
  } catch (err) {
    console.error('❌ [Boost Cron Error]:', err.message);
    return 0;
  }
};

/**
 * 3. Weekly Reset for Super Likes (Every 7 days from last refill)
 * Resets planSuperLikesRemaining to plan perks (e.g. 5 or 10),
 * keeping any purchased addonSuperLikesRemaining intact!
 */
export const checkAndResetWeeklySuperLikes = async () => {
  try {
    const now = Date.now();

    // Find all active subscribers with superLikesPerWeek > 0
    const activeSubscribers = await User.find({
      'subscription.status': SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.perks.superLikesPerWeek': { $gt: 0 }
    });

    if (!activeSubscribers || activeSubscribers.length === 0) {
      return 0;
    }

    let refilledCount = 0;

    for (const user of activeSubscribers) {
      const lastRefill =
        user.subscription.lastSuperLikesRefillAt ||
        user.subscription.startDate ||
        user.createdAt ||
        new Date();
      const elapsed = now - new Date(lastRefill).getTime();

      if (elapsed >= SEVEN_DAYS_MS) {
        const weeklyQuota = user.subscription.perks.superLikesPerWeek || 0;
        user.subscription.planSuperLikesRemaining = weeklyQuota;
        const addonCount = user.subscription.addonSuperLikesRemaining || 0;
        user.subscription.superLikesRemaining = weeklyQuota + addonCount;
        user.subscription.lastSuperLikesRefillAt = new Date();
        await user.save();

        refilledCount++;

        const uStr = user._id.toString();
        CacheService.del(`user:${uStr}`).catch(() => { });
        emitToUser(uStr, 'superlikes_refilled', {
          superLikesRemaining: user.subscription.superLikesRemaining,
          planSuperLikesRemaining: user.subscription.planSuperLikesRemaining,
          addonSuperLikesRemaining: user.subscription.addonSuperLikesRemaining,
          refilledCount: weeklyQuota,
          timestamp: new Date().toISOString()
        });
        emitToUser(uStr, 'membership_updated', {
          subscription: user.subscription,
          timestamp: new Date().toISOString()
        });
      }
    }

    if (refilledCount > 0) {
      console.log(`⚡ [Weekly SuperLikes Cron] Successfully reset and refilled Super Likes for ${refilledCount} user(s).`);
    }

    return refilledCount;
  } catch (err) {
    console.error('❌ [Weekly SuperLikes Cron Error]:', err.message);
    return 0;
  }
};

/**
 * 4. Monthly Reset for Profile Boosts (Every 30 days from last refill)
 * Resets planBoostsRemaining to plan perks (e.g. 1 or 2),
 * keeping any purchased addonBoostsRemaining intact!
 */
export const checkAndResetMonthlyBoosts = async () => {
  try {
    const now = Date.now();

    // Find all active subscribers with profileBoostPerMonth > 0
    const activeSubscribers = await User.find({
      'subscription.status': SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.perks.profileBoostPerMonth': { $gt: 0 }
    });

    if (!activeSubscribers || activeSubscribers.length === 0) {
      return 0;
    }

    let refilledCount = 0;

    for (const user of activeSubscribers) {
      const lastRefill =
        user.subscription.lastBoostsRefillAt ||
        user.subscription.startDate ||
        user.createdAt ||
        new Date();
      const elapsed = now - new Date(lastRefill).getTime();

      if (elapsed >= THIRTY_DAYS_MS) {
        const monthlyQuota = user.subscription.perks.profileBoostPerMonth || 0;
        user.subscription.planBoostsRemaining = monthlyQuota;
        const addonCount = user.subscription.addonBoostsRemaining || 0;
        user.subscription.boostsRemaining = monthlyQuota + addonCount;
        user.subscription.lastBoostsRefillAt = new Date();
        await user.save();

        refilledCount++;

        const uStr = user._id.toString();
        CacheService.del(`user:${uStr}`).catch(() => { });
        emitToUser(uStr, 'boosts_refilled', {
          boostsRemaining: user.subscription.boostsRemaining,
          planBoostsRemaining: user.subscription.planBoostsRemaining,
          addonBoostsRemaining: user.subscription.addonBoostsRemaining,
          refilledCount: monthlyQuota,
          timestamp: new Date().toISOString()
        });
        emitToUser(uStr, 'membership_updated', {
          subscription: user.subscription,
          timestamp: new Date().toISOString()
        });
      }
    }

    if (refilledCount > 0) {
      console.log(`🚀 [Monthly Boost Cron] Successfully reset and refilled Profile Boosts for ${refilledCount} user(s).`);
    }

    return refilledCount;
  } catch (err) {
    console.error('❌ [Monthly Boost Cron Error]:', err.message);
    return 0;
  }
};

/**
 * 5. Start Periodic Subscription, Boosts & Refills Cron Job
 * Default expression: Every 15 minutes
 */
export const startSubscriptionCron = (cronExpression = '*/15 * * * *') => {
  if (cronTask) {
    cronTask.stop();
  }

  // Initial immediate run on boot so any expired items or refills are resolved instantly
  checkAndExpireSubscriptions();
  checkAndExpireBoosts();
  checkAndResetWeeklySuperLikes();
  checkAndResetMonthlyBoosts();

  // Schedule recurring cron job using node-cron
  cronTask = cron.schedule(cronExpression, async () => {
    console.log('⏰ [Cron Job] Running scheduled subscription expiry & credit reset sweeps...');
    await checkAndExpireSubscriptions();
    await checkAndExpireBoosts();
    await checkAndResetWeeklySuperLikes();
    await checkAndResetMonthlyBoosts();
  });

  console.log(`⏱️ [Subscription Cron] Scheduled with cron expression: "${cronExpression}"`);
};

/**
 * 6. Stop Cron on server shutdown
 */
export const stopSubscriptionCron = () => {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log('🛑 [Subscription Cron] Stopped.');
  }
};

// Aliases for seamless compatibility
export const startSubscriptionSweeper = startSubscriptionCron;
export const stopSubscriptionSweeper = stopSubscriptionCron;

