import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Profile } from '../models/Profile.js';
import { Match } from '../models/Match.js';
import { Payment } from '../models/Payment.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  HTTP_STATUS,
  USER_ROLES,
  MATCH_STATUS,
  PAYMENT_STATUS
} from '../constants/index.js';
import { getOnlineUserIds, getAdminOnlineUserStats } from '../sockets/index.js';

/**
 * Format currency in Indian numbering format (e.g. ₹1,845,600)
 */
const formatCurrencyINR = (amount = 0) => {
  return `₹${Number(amount || 0).toLocaleString('en-IN')}`;
};

/**
 * Format currency short in Lakhs/Crores (e.g. ₹18.4L, ₹7.3L)
 */
const formatLakhsINR = (amount = 0) => {
  const num = Number(amount || 0);
  if (num >= 10000000) return `₹${(num / 10000000).toFixed(1)}Cr`;
  if (num >= 100000) return `₹${(num / 100000).toFixed(1)}L`;
  if (num >= 1000) return `₹${(num / 1000).toFixed(1)}k`;
  return `₹${num}`;
};

/**
 * Calculate percentage change and trend string
 */
const calculateTrend = (current = 0, previous = 0) => {
  if (previous === 0) {
    if (current === 0) return { trend: '0%', isPositive: true, rawPercent: 0 };
    return { trend: '+100%', isPositive: true, rawPercent: 100 };
  }
  const diff = current - previous;
  const percent = Math.round((diff / previous) * 1000) / 10; // 1 decimal place
  const sign = percent >= 0 ? '+' : '';
  return {
    trend: `${sign}${percent}%`,
    isPositive: percent >= 0,
    rawPercent: percent
  };
};

/**
 * Admin: Get Complete Dashboard Overview & Analytics
 * Matches the Admin UI:
 * 1. Top Cards: Total Registered Profiles, Active Matches & Connections, Monthly Platform Revenue
 * 2. Profile & Match Trajectory (Last 6 months monthly trend)
 * 3. Subscription Revenue (Last 6 months monthly INR revenue with VIP and Gold breakdown)
 * 4. Community Demographics (User distribution across religious communities)
 */
export const getAdminDashboardOverview = asyncHandler(async (req, res) => {
  const isOwner = req.user?.role === USER_ROLES.OWNER;
  const userRoleFilter = isOwner
    ? { role: { $ne: USER_ROLES.OWNER } }
    : { role: USER_ROLES.USER };

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  // Current Month Start and End
  const startOfThisMonth = new Date(currentYear, currentMonth, 1);
  const endOfThisMonth = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59, 999);

  // Previous Month Start and End
  const startOfLastMonth = new Date(currentYear, currentMonth - 1, 1);
  const endOfLastMonth = new Date(currentYear, currentMonth, 0, 23, 59, 59, 999);

  // 1. Total Registered Profiles (All-time, this month, last month)
  const [
    totalRegisteredProfiles,
    profilesThisMonth,
    profilesLastMonth
  ] = await Promise.all([
    User.countDocuments(userRoleFilter),
    User.countDocuments({
      ...userRoleFilter,
      createdAt: { $gte: startOfThisMonth, $lte: endOfThisMonth }
    }),
    User.countDocuments({
      ...userRoleFilter,
      createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
    })
  ]);

  const profileTrend = calculateTrend(profilesThisMonth, profilesLastMonth);

  // 2. Active Matches & Connections
  const baseMatchFilter = {
    status: MATCH_STATUS.ACCEPTED,
    isMutualMatch: true,
    $expr: { $lt: ['$sender', '$receiver'] }
  };

  const [
    totalActiveMatches,
    matchesThisMonth,
    matchesLastMonth
  ] = await Promise.all([
    Match.countDocuments(baseMatchFilter),
    Match.countDocuments({
      ...baseMatchFilter,
      createdAt: { $gte: startOfThisMonth, $lte: endOfThisMonth }
    }),
    Match.countDocuments({
      ...baseMatchFilter,
      createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
    })
  ]);

  const matchTrend = calculateTrend(matchesThisMonth, matchesLastMonth);

  // 3. Monthly Platform Revenue
  const baseRevenueFilter = {
    status: PAYMENT_STATUS.CAPTURED
  };

  const [revenueThisMonthAgg, revenueLastMonthAgg] = await Promise.all([
    Payment.aggregate([
      {
        $match: {
          ...baseRevenueFilter,
          createdAt: { $gte: startOfThisMonth, $lte: endOfThisMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' }
        }
      }
    ]),
    Payment.aggregate([
      {
        $match: {
          ...baseRevenueFilter,
          createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' }
        }
      }
    ])
  ]);

  const currentMonthRevenue = revenueThisMonthAgg[0]?.totalAmount || 0;
  const lastMonthRevenue = revenueLastMonthAgg[0]?.totalAmount || 0;
  const revenueTrend = calculateTrend(currentMonthRevenue, lastMonthRevenue);

  // 4. Generate Past 6 Months Windows for Trajectory & Revenue Charts
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const past6Months = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(currentYear, currentMonth - i, 1);
    const mYear = d.getFullYear();
    const mIdx = d.getMonth();
    const mStart = new Date(mYear, mIdx, 1);
    const mEnd = new Date(mYear, mIdx + 1, 0, 23, 59, 59, 999);
    past6Months.push({
      key: `${mYear}-${String(mIdx + 1).padStart(2, '0')}`,
      month: monthNames[mIdx],
      year: mYear,
      monthYear: `${monthNames[mIdx]} ${mYear}`,
      start: mStart,
      end: mEnd
    });
  }

  const rangeStart = past6Months[0].start;
  const rangeEnd = past6Months[past6Months.length - 1].end;

  // Aggregate monthly profile registrations
  const monthlyProfilesAgg = await User.aggregate([
    {
      $match: {
        ...userRoleFilter,
        createdAt: { $gte: rangeStart, $lte: rangeEnd }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' }
        },
        count: { $sum: 1 }
      }
    }
  ]);

  const profileMap = new Map();
  monthlyProfilesAgg.forEach((item) => {
    const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
    profileMap.set(key, item.count);
  });

  // Aggregate monthly active matches
  const monthlyMatchesAgg = await Match.aggregate([
    {
      $match: {
        ...baseMatchFilter,
        createdAt: { $gte: rangeStart, $lte: rangeEnd }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' }
        },
        count: { $sum: 1 }
      }
    }
  ]);

  const matchMap = new Map();
  monthlyMatchesAgg.forEach((item) => {
    const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
    matchMap.set(key, item.count);
  });

  // Aggregate monthly subscription revenue
  const monthlyRevenueAgg = await Payment.aggregate([
    {
      $match: {
        ...baseRevenueFilter,
        createdAt: { $gte: rangeStart, $lte: rangeEnd }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' }
        },
        revenue: { $sum: '$amount' }
      }
    }
  ]);

  const revenueMap = new Map();
  monthlyRevenueAgg.forEach((item) => {
    const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
    revenueMap.set(key, item.revenue);
  });

  // Build Profile & Match Trajectory list
  const trajectory = past6Months.map((m) => {
    const profiles = profileMap.get(m.key) || 0;
    const matches = matchMap.get(m.key) || 0;
    return {
      month: m.month,
      year: m.year,
      monthYear: m.monthYear,
      profiles,
      matches
    };
  });

  // Build Subscription Revenue bar chart list
  const subscriptionRevenue = past6Months.map((m) => {
    const rev = revenueMap.get(m.key) || 0;
    return {
      month: m.month,
      year: m.year,
      monthYear: m.monthYear,
      revenue: rev,
      formattedRevenue: formatCurrencyINR(rev),
      shortRevenue: formatLakhsINR(rev)
    };
  });

  // 5. Community Demographics (Religious distribution)
  const demographicsAgg = await Profile.aggregate([
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'userDoc'
      }
    },
    { $unwind: '$userDoc' },
    {
      $match: isOwner
        ? { 'userDoc.role': { $ne: USER_ROLES.OWNER } }
        : { 'userDoc.role': USER_ROLES.USER }
    },
    {
      $group: {
        _id: {
          $ifNull: ['$religion', 'Other']
        },
        count: { $sum: 1 }
      }
    }
  ]);

  let totalDemographicsProfiles = 0;
  const rawCommunityCounts = {
    Hindu: 0,
    Muslim: 0,
    Sikh: 0,
    Christian: 0,
    'Jain/Other': 0
  };

  demographicsAgg.forEach((item) => {
    const rawName = (item._id || '').toString().trim();
    const count = item.count || 0;
    totalDemographicsProfiles += count;

    const lower = rawName.toLowerCase();
    if (lower.includes('hindu')) {
      rawCommunityCounts.Hindu += count;
    } else if (lower.includes('muslim') || lower.includes('islam')) {
      rawCommunityCounts.Muslim += count;
    } else if (lower.includes('sikh')) {
      rawCommunityCounts.Sikh += count;
    } else if (lower.includes('christian')) {
      rawCommunityCounts.Christian += count;
    } else {
      rawCommunityCounts['Jain/Other'] += count;
    }
  });

  // Map to structured community list matching UI
  const communityOrder = [
    { key: 'Hindu', name: 'Hindu', color: '#E11D48' },
    { key: 'Muslim', name: 'Muslim', color: '#10B981' },
    { key: 'Sikh', name: 'Sikh', color: '#F59E0B' },
    { key: 'Christian', name: 'Christian', color: '#6366F1' },
    { key: 'Jain/Other', name: 'Jain/Other', color: '#EC4899' }
  ];

  const communityDemographics = communityOrder.map((c) => {
    const count = rawCommunityCounts[c.key] || 0;
    const percentage = totalDemographicsProfiles > 0
      ? Math.round((count / totalDemographicsProfiles) * 100)
      : 0;

    return {
      community: c.name,
      count,
      percentage,
      formattedLabel: `${count.toLocaleString('en-IN')} (${percentage}%)`,
      color: c.color
    };
  });

  // 6. Online / Offline User Stats
  const onlineStats = await getAdminOnlineUserStats(userRoleFilter);

  // Final Response JSON
  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        overviewCards: {
          totalRegisteredProfiles: {
            count: totalRegisteredProfiles,
            formattedCount: totalRegisteredProfiles.toLocaleString('en-IN'),
            label: 'Total Registered Profiles',
            trend: profileTrend.trend,
            trendPeriod: 'vs last month',
            isPositive: profileTrend.isPositive
          },
          activeMatches: {
            count: totalActiveMatches,
            formattedCount: totalActiveMatches.toLocaleString('en-IN'),
            label: 'Active Matches & Connections',
            trend: matchTrend.trend,
            trendPeriod: 'vs last month',
            isPositive: matchTrend.isPositive
          },
          monthlyPlatformRevenue: {
            amount: currentMonthRevenue,
            formattedAmount: formatCurrencyINR(currentMonthRevenue),
            shortAmount: formatLakhsINR(currentMonthRevenue),
            label: 'Monthly Platform Revenue',
            trend: revenueTrend.trend,
            trendPeriod: 'vs last month',
            isPositive: revenueTrend.isPositive
          }
        },
        userStatus: onlineStats,
        profileMatchTrajectory: {
          title: 'Profile & Match Trajectory',
          subtitle: 'Monthly registrations vs active matches formed',
          data: trajectory
        },
        subscriptionRevenue: {
          title: 'Subscription Revenue',
          subtitle: 'Monthly INR revenue from VIP and Gold packages',
          trendBadge: `${revenueTrend.trend} Vs Prev Month`,
          isPositive: revenueTrend.isPositive,
          data: subscriptionRevenue
        },
        communityDemographics: {
          title: 'Community Demographics',
          subtitle: 'User distribution across religious communities',
          totalProfiles: totalDemographicsProfiles,
          data: communityDemographics
        }
      },
      'Admin dashboard details retrieved successfully'
    )
  );
});

/**
 * Admin: Get Real-time Online & Offline Users Count
 * @route GET /api/v1/dashboard/user-status
 */
export const getUserStatusCountAdmin = asyncHandler(async (req, res) => {
  const isOwner = req.user?.role === USER_ROLES.OWNER;
  const userRoleFilter = isOwner
    ? { role: { $ne: USER_ROLES.OWNER } }
    : { role: USER_ROLES.USER };

  const stats = await getAdminOnlineUserStats(userRoleFilter);

  let onlineUsersList = undefined;
  if (req.query.includeUsers === 'true') {
    const onlineIds = getOnlineUserIds();
    onlineUsersList = await User.find({ ...userRoleFilter, _id: { $in: onlineIds } })
      .select('fullName email phoneNumber role lastActive')
      .lean();
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        ...stats,
        onlineUsers: onlineUsersList
      },
      'User online/offline status count retrieved successfully'
    )
  );
});

