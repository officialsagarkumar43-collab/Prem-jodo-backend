import { z } from 'zod';
import { BILLING_CYCLES } from '../constants/index.js';

export const createOrderSchema = z.object({
  body: z
    .object({
      type: z.string().optional().default('subscription'),
      plan: z.string().optional(),
      addon: z.string().optional(),
      addonId: z.string().optional(),
      addonSlug: z.string().optional(),
      billingCycle: z
        .enum([BILLING_CYCLES.MONTHLY, BILLING_CYCLES.ANNUAL, 'one_time'])
        .optional()
        .default(BILLING_CYCLES.MONTHLY),
      paymentMethod: z.string().optional().default('Razorpay'),
      customerPhone: z.string().optional(),
      customerName: z.string().optional(),
      customerEmail: z.string().email().optional(),
      returnUrl: z.string().url().optional()
    })
    .refine(
      (data) => {
        const isAddon =
          data.type?.toLowerCase() === 'addon' ||
          data.type?.toLowerCase() === 'addons' ||
          Boolean(data.addon || data.addonId || data.addonSlug);
        if (isAddon) {
          return Boolean(data.addon || data.addonId || data.addonSlug || data.plan);
        }
        return Boolean(data.plan);
      },
      {
        message: 'Plan reference is required for subscriptions, or addon reference for addons'
      }
    )
});

export const verifyPaymentSchema = z.object({
  body: z
    .object({
      orderId: z.string().optional(),
      order_id: z.string().optional(),
      razorpay_order_id: z.string().optional(),
      paymentId: z.string().optional(),
      payment_id: z.string().optional(),
      razorpay_payment_id: z.string().optional(),
      signature: z.string().optional(),
      razorpay_signature: z.string().optional(),
      paymentMethod: z.string().optional(),
      payment_method: z.string().optional(),
      orderNumber: z.string().optional(),
      plan: z.string().optional(),
      billingCycle: z.enum([BILLING_CYCLES.MONTHLY, BILLING_CYCLES.ANNUAL]).optional()
    })
    .refine(
      (data) => data.orderId || data.order_id || data.razorpay_order_id,
      {
        message: 'Order ID (razorpay_order_id or orderId) is required to verify payment'
      }
    )
});

export const cancelSubscriptionSchema = z.object({
  body: z
    .object({
      orderId: z.string().optional(),
      order_id: z.string().optional(),
      paymentId: z.string().optional(),
      payment_id: z.string().optional(),
      reason: z.string().optional(),
      note: z.string().optional()
    })
    .optional()
});

const planPricingSchema = z.object({
  pricePerMonth: z.number().min(0, 'Price per month must be >= 0'),
  totalAmount: z.number().min(0, 'Total amount must be >= 0'),
  discountPercent: z.number().min(0).max(100).optional().default(0),
  durationDays: z.number().min(1).default(30)
});

export const createPlanAdminSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Plan name must be at least 2 characters'),
    slug: z.string().min(2, 'Plan slug must be at least 2 characters'),
    subtitle: z.string().optional(),
    tag: z.string().nullable().optional(),
    isMostPopular: z.boolean().optional().default(false),
    description: z.string().optional(),
    themeColor: z.string().optional(),
    icon: z.string().optional(),
    pricing: z.object({
      monthly: planPricingSchema,
      annual: planPricingSchema
    }),
    features: z.array(z.string()).default([]),
    perks: z
      .object({
        unlimitedSwipes: z.boolean().optional(),
        dailySwipeLimit: z.number().min(0).optional(),
        rewindAllowed: z.boolean().optional(),
        superLikesPerWeek: z.number().optional(),
        passportLocation: z.boolean().optional(),
        seeWhoLikedYou: z.boolean().optional(),
        profileBoostPerMonth: z.number().optional(),
        priorityLikes: z.boolean().optional(),
        messageBeforeMatch: z.boolean().optional(),
        vipBadge: z.boolean().optional()
      })
      .optional(),
    isActive: z.boolean().optional().default(true),
    displayOrder: z.number().optional().default(0)
  })
});

export const updatePlanAdminSchema = z.object({
  body: z.object({
    name: z.string().min(2).optional(),
    slug: z.string().min(2).optional(),
    subtitle: z.string().optional(),
    tag: z.string().nullable().optional(),
    isMostPopular: z.boolean().optional(),
    description: z.string().optional(),
    themeColor: z.string().optional(),
    icon: z.string().optional(),
    pricing: z
      .object({
        monthly: planPricingSchema.optional(),
        annual: planPricingSchema.optional()
      })
      .optional(),
    features: z.array(z.string()).optional(),
    perks: z
      .object({
        unlimitedSwipes: z.boolean().optional(),
        dailySwipeLimit: z.number().min(0).optional(),
        rewindAllowed: z.boolean().optional(),
        superLikesPerWeek: z.number().optional(),
        passportLocation: z.boolean().optional(),
        seeWhoLikedYou: z.boolean().optional(),
        profileBoostPerMonth: z.number().optional(),
        priorityLikes: z.boolean().optional(),
        messageBeforeMatch: z.boolean().optional(),
        vipBadge: z.boolean().optional()
      })
      .optional(),
    isActive: z.boolean().optional(),
    displayOrder: z.number().optional()
  })
});

export const createAddonAdminSchema = z.object({
  body: z.object({
    name: z.string({ required_error: 'Addon name is required' }).min(2),
    slug: z.string({ required_error: 'Addon slug is required' }).min(2),
    type: z.enum(['super_likes', 'profile_boost', 'credits', 'custom']),
    price: z.number({ required_error: 'Price is required' }).min(0),
    originalPrice: z.number().optional().default(0),
    discountPercent: z.number().min(0).max(100).optional().default(0),
    quantity: z.number().min(1).default(1),
    durationMinutes: z.number().optional().default(0),
    description: z.string().optional().default(''),
    tag: z.string().nullable().optional(),
    icon: z.string().optional().default('Heart'),
    isActive: z.boolean().optional().default(true),
    displayOrder: z.number().optional().default(0)
  })
});

export const updateAddonAdminSchema = z.object({
  body: z.object({
    name: z.string().min(2).optional(),
    slug: z.string().min(2).optional(),
    type: z.enum(['super_likes', 'profile_boost', 'credits', 'custom']).optional(),
    price: z.number().min(0).optional(),
    originalPrice: z.number().optional(),
    discountPercent: z.number().min(0).max(100).optional(),
    quantity: z.number().min(1).optional(),
    durationMinutes: z.number().optional(),
    description: z.string().optional(),
    tag: z.string().nullable().optional(),
    icon: z.string().optional(),
    isActive: z.boolean().optional(),
    displayOrder: z.number().optional()
  })
});
