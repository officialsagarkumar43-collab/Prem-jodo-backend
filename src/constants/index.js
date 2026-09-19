export const USER_ROLES = {
  USER: 'user',
  ADMIN: 'admin',
  MODERATOR: 'moderator'
};

export const GENDER = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other'
};

export const MATCH_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  BLOCKED: 'blocked'
};

export const SWIPE_ACTION = {
  LIKE: 'like',
  PASS: 'pass',
  SUPERLIKE: 'superlike'
};

export const NOTIFICATION_TYPES = {
  MATCH_REQUEST: 'match_request',
  MATCH_ACCEPTED: 'match_accepted',
  NEW_MESSAGE: 'new_message',
  PROFILE_VIEW: 'profile_view',
  SYSTEM: 'system'
};

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500
};

export const LOOKING_FOR_OPTIONS = [
  {
    value: 'long_term_partner',
    label: 'Long-term partner',
    emoji: '💘',
    description: 'Looking for a committed long-term partner'
  },
  {
    value: 'long_term_open_to_short',
    label: 'Long-term, open to short',
    emoji: '🤩',
    description: 'Seeking long-term, but open to casual'
  },
  {
    value: 'short_term_open_to_long',
    label: 'Short-term, open to long',
    emoji: '🥂',
    description: 'Seeking short-term, but open to long-term'
  },
  {
    value: 'short_term_fun',
    label: 'Short-term fun',
    emoji: '🎉',
    description: 'Here for fun dates and good times'
  },
  {
    value: 'new_friends',
    label: 'New friends',
    emoji: '👋',
    description: 'Looking to expand friend circle'
  },
  {
    value: 'still_figuring_it_out',
    label: 'Still figuring it out',
    emoji: '🧐',
    description: 'Open to seeing where things go'
  }
];

export const INTEREST_OPTIONS = [
  { value: 'coding', label: 'Coding' },
  { value: 'design', label: 'Design' },
  { value: 'coffee', label: 'Coffee' },
  { value: 'photography', label: 'Photography' },
  { value: 'road_trips', label: 'Road Trips' },
  { value: 'music', label: 'Music' },
  { value: 'fitness', label: 'Fitness' },
  { value: 'movies', label: 'Movies' },
  { value: 'foodie', label: 'Foodie' },
  { value: 'travel', label: 'Travel' },
  { value: 'art', label: 'Art' },
  { value: 'gaming', label: 'Gaming' },
  { value: 'yoga', label: 'Yoga' },
  { value: 'books', label: 'Books' },
  { value: 'anime', label: 'Anime' },
  { value: 'startups', label: 'Startups' }
];

export const MEMBERSHIP_TIERS = {
  FREE: 'free',
  PLUS: 'plus',
  GOLD: 'gold',
  PLATINUM: 'platinum'
};

export const BILLING_CYCLES = {
  MONTHLY: 'monthly',
  ANNUAL: 'annual'
};

export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  PENDING: 'pending'
};

export const PAYMENT_STATUS = {
  CREATED: 'created',
  CAPTURED: 'captured',
  FAILED: 'failed',
  REFUND_PENDING: 'refund_pending',
  REFUNDED: 'refunded'
};

export const REFUND_POLICY = {
  MAX_REFUND_DAYS: 2,
  MAX_REFUND_HOURS: 48
};

export const DEFAULT_PLANS_SEED = [
  {
    slug: 'plus',
    name: 'Prem Jodo Plus',
    subtitle: 'Essential',
    tag: null,
    isMostPopular: false,
    description: 'Supercharge your discovery with unlimited swipes & rewind.',
    themeColor: '#EC4899',
    icon: 'Zap',
    pricing: {
      monthly: {
        pricePerMonth: 50,
        totalAmount: 50,
        discountPercent: 0,
        durationDays: 30
      },
      annual: {
        pricePerMonth: 199,
        totalAmount: 2388,
        discountPercent: 33,
        durationDays: 365
      }
    },
    features: [
      'Unlimited Swipes every day',
      'Rewind your accidental left swipes',
      '5 Free Super Likes per week',
      'Passport to swipe singles anywhere in India',
      'No advertisement distractions'
    ],
    perks: {
      unlimitedSwipes: true,
      rewindAllowed: true,
      superLikesPerWeek: 5,
      passportLocation: true,
      seeWhoLikedYou: false,
      profileBoostPerMonth: 0,
      priorityLikes: false,
      messageBeforeMatch: false,
      vipBadge: false
    },
    isActive: true,
    displayOrder: 1
  },
  {
    slug: 'gold',
    name: 'Prem Jodo Gold',
    subtitle: 'Most Popular',
    tag: 'MOST POPULAR',
    isMostPopular: true,
    description: 'See who likes you instantly and match without waiting.',
    themeColor: '#F59E0B',
    icon: 'Crown',
    pricing: {
      monthly: {
        pricePerMonth: 599,
        totalAmount: 599,
        discountPercent: 0,
        durationDays: 30
      },
      annual: {
        pricePerMonth: 399,
        totalAmount: 4788,
        discountPercent: 33,
        durationDays: 365
      }
    },
    features: [
      'See Who Liked You before swiping',
      '1 Free Profile Boost per month (10x views)',
      'Curated daily Top Picks matching your vibe',
      'Unlimited Swipes & Rewinds',
      '5 Free Super Likes every week'
    ],
    perks: {
      unlimitedSwipes: true,
      rewindAllowed: true,
      superLikesPerWeek: 5,
      passportLocation: true,
      seeWhoLikedYou: true,
      profileBoostPerMonth: 1,
      priorityLikes: false,
      messageBeforeMatch: false,
      vipBadge: false
    },
    isActive: true,
    displayOrder: 2
  },
  {
    slug: 'platinum',
    name: 'Prem Jodo Platinum',
    subtitle: 'VIP Dating',
    tag: 'VIP DATING',
    isMostPopular: false,
    description: 'Priority placement, VIP badge, and direct note before match.',
    themeColor: '#8B5CF6',
    icon: 'Sparkles',
    pricing: {
      monthly: {
        pricePerMonth: 999,
        totalAmount: 999,
        discountPercent: 0,
        durationDays: 30
      },
      annual: {
        pricePerMonth: 669,
        totalAmount: 8028,
        discountPercent: 33,
        durationDays: 365
      }
    },
    features: [
      'Priority Likes — Be seen first by everyone you like',
      'Message Before Match — Add a personal note to Super Likes',
      'Exclusive VIP Profile badge',
      'See Who Liked You instantly',
      '2 Free Profile Boosts per month'
    ],
    perks: {
      unlimitedSwipes: true,
      rewindAllowed: true,
      superLikesPerWeek: 10,
      passportLocation: true,
      seeWhoLikedYou: true,
      profileBoostPerMonth: 2,
      priorityLikes: true,
      messageBeforeMatch: true,
      vipBadge: true
    },
    isActive: true,
    displayOrder: 3
  }
];



