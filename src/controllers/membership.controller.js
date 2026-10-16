import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Profile } from '../models/Profile.js';
import { Payment } from '../models/Payment.js';
import { Plan } from '../models/Plan.js';
import { Addon } from '../models/Addon.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  MEMBERSHIP_TIERS,
  BILLING_CYCLES,
  SUBSCRIPTION_STATUS,
  PAYMENT_STATUS,
  REFUND_POLICY,
  DEFAULT_PLANS_SEED,
  ADDON_TYPES,
  DEFAULT_ADDONS_SEED,
  HTTP_STATUS
} from '../constants/index.js';
import { ENV } from '../config/env.js';
import { emitToUser } from '../sockets/index.js';
import { CacheService } from '../services/cache.service.js';
import { paymentService } from '../services/payment.service.js';
import { checkAndRefillUserQuotas } from '../services/subscriptionSweeper.service.js';

/**
 * Helper to ensure default plans are seeded into MongoDB if collection is empty
 */
const ensureInitialPlansSeeded = async () => {
  const count = await Plan.countDocuments();
  if (count === 0) {
    await Plan.insertMany(DEFAULT_PLANS_SEED);
  }
};

/**
 * Helper to ensure default addons are seeded into MongoDB if collection is empty
 */
const ensureInitialAddonsSeeded = async () => {
  const count = await Addon.countDocuments();
  if (count === 0) {
    await Addon.insertMany(DEFAULT_ADDONS_SEED);
  }
};

/**
 * Helper to find a plan by ID or Slug
 */
const findPlanByReference = async (planRef) => {
  if (!planRef) return null;
  if (mongoose.isValidObjectId(planRef)) {
    const plan = await Plan.findById(planRef);
    if (plan) return plan;
  }
  return await Plan.findOne({ slug: planRef.toString().toLowerCase().trim() });
};

/**
 * Helper to find an addon by ID or Slug
 */
const findAddonByReference = async (addonRef) => {
  if (!addonRef) return null;
  if (mongoose.isValidObjectId(addonRef)) {
    const addon = await Addon.findById(addonRef);
    if (addon) return addon;
  }
  return await Addon.findOne({ slug: addonRef.toString().toLowerCase().trim() });
};

/**
 * Helper to generate a 10-digit unique numeric order number
 */
export const generate10DigitOrderNumber = () => {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
};

// ==========================================
// USER ENDPOINTS
// ==========================================

/**
 * 1. Get all Active Membership Plans Catalog (and Addons)
 * Public endpoint
 */
export const getMembershipPlans = asyncHandler(async (req, res) => {
  await Promise.all([ensureInitialPlansSeeded(), ensureInitialAddonsSeeded()]);

  const [plans, addons] = await Promise.all([
    Plan.find({ isActive: true }).sort({ displayOrder: 1, createdAt: 1 }),
    Addon.find({ isActive: true }).sort({ displayOrder: 1, createdAt: 1 })
  ]);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        plans,
        addons,
        refundPolicy: {
          maxRefundDays: REFUND_POLICY.MAX_REFUND_DAYS,
          maxRefundHours: REFUND_POLICY.MAX_REFUND_HOURS,
          description: `Full refund is available within ${REFUND_POLICY.MAX_REFUND_DAYS} days (${REFUND_POLICY.MAX_REFUND_HOURS} hours) of purchase upon cancellation.`
        },
        billingCycles: [
          {
            id: BILLING_CYCLES.MONTHLY,
            label: 'Monthly Billing',
            discount: null
          },
          {
            id: BILLING_CYCLES.ANNUAL,
            label: 'Annual Billing',
            discount: 'SAVE 33%'
          }
        ]
      },
      'Membership plans retrieved successfully'
    )
  );
});

/**
 * 1b. Get all Active Add-ons Catalog (Super Likes & Boosts)
 * Public endpoint
 */
export const getMembershipAddons = asyncHandler(async (req, res) => {
  await ensureInitialAddonsSeeded();

  const addons = await Addon.find({ isActive: true }).sort({ displayOrder: 1, createdAt: 1 });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        addons,
        types: ADDON_TYPES
      },
      'Membership addons retrieved successfully'
    )
  );
});

/**
 * 2. Get User's Active Subscription & Membership Status
 * Protected endpoint
 */
export const getMySubscription = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const user = await User.findById(userId).select('subscription fullName email phoneNumber');
  if (!user) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  // Check if active subscription has expired
  if (user.subscription && user.subscription.status === SUBSCRIPTION_STATUS.ACTIVE) {
    if (user.subscription.endDate && new Date() > new Date(user.subscription.endDate)) {
      user.subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
      user.subscription.plan = MEMBERSHIP_TIERS.FREE;
      user.subscription.planName = 'Prem Jodo Free';
      user.subscription.perks = {
        unlimitedSwipes: false,
        rewindAllowed: false,
        superLikesPerWeek: 0,
        passportLocation: false,
        seeWhoLikedYou: false,
        profileBoostPerMonth: 0,
        priorityLikes: false,
        messageBeforeMatch: false,
        vipBadge: false
      };
      user.subscription.boostsRemaining = 0;
      user.subscription.planBoostsRemaining = 0;
      user.subscription.addonBoostsRemaining = 0;
      user.subscription.superLikesRemaining = 0;
      user.subscription.planSuperLikesRemaining = 0;
      user.subscription.addonSuperLikesRemaining = 0;
      await user.save();

      // Clear boosted profile state on membership expiration
      await Profile.findOneAndUpdate(
        { user: userId },
        { $set: { isBoosted: false, boostExpiresAt: null } }
      );
    } else {
      // Check for weekly superlikes (7 days) and monthly profile boost (30 days) refill on-demand
      const isRefilled = checkAndRefillUserQuotas(user);
      if (isRefilled) {
        await user.save();
      }
    }
  }

  // Check refund eligibility status
  let isEligibleForRefund = false;
  let hoursRemainingForRefund = 0;
  if (user.subscription && user.subscription.status === SUBSCRIPTION_STATUS.ACTIVE) {
    const activationDate = user.subscription.startDate || user.updatedAt || new Date();
    const elapsedHours = (Date.now() - new Date(activationDate).getTime()) / (1000 * 60 * 60);
    isEligibleForRefund = elapsedHours <= REFUND_POLICY.MAX_REFUND_HOURS;
    hoursRemainingForRefund = Math.max(0, Math.round(REFUND_POLICY.MAX_REFUND_HOURS - elapsedHours));
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        subscription: user.subscription,
        isVip: !!user.subscription?.perks?.vipBadge,
        refundEligibility: {
          isEligible: isEligibleForRefund,
          hoursRemaining: hoursRemainingForRefund,
          policyHours: REFUND_POLICY.MAX_REFUND_HOURS
        }
      },
      'Subscription details retrieved successfully'
    )
  );
});

/**
 * 3. Create Razorpay Payment Order (Plans or Add-ons)
 * Protected endpoint
 */
export const createMembershipOrder = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const {
    type = 'subscription',
    plan: planRef,
    addon: addonRef,
    addonId,
    addonSlug,
    billingCycle = BILLING_CYCLES.MONTHLY,
    paymentMethod = 'Razorpay',
    customerPhone,
    customerName,
    customerEmail
  } = req.body;

  // User details for Razorpay checkout prefill
  const userPhone = customerPhone || req.user.phoneNumber || '';
  const userName = customerName || req.user.fullName || 'Prem Jodo User';
  const userEmail = customerEmail || req.user.email || '';

  const isAddonOrder =
    type?.toLowerCase() === 'addon' ||
    type?.toLowerCase() === 'addons' ||
    Boolean(addonRef || addonId || addonSlug);

  // ----------------------------------------------------
  // Branch A: Explicit Add-on Order
  // ----------------------------------------------------
  if (isAddonOrder) {
    await ensureInitialAddonsSeeded();
    const targetAddonRef = addonRef || addonSlug || addonId || planRef;
    const addonDoc = await findAddonByReference(targetAddonRef);
    if (!addonDoc || !addonDoc.isActive) {
      throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid or inactive addon: ${targetAddonRef}`);
    }

    const amountInRupees = addonDoc.price;
    const amountInPaise = Math.round(amountInRupees * 100);
    const orderNumber = generate10DigitOrderNumber();
    const receipt = `pj_add_${orderNumber}`.slice(0, 40);
    const orderNote = `Prem Jodo Addon: ${addonDoc.name}`;

    const rzpOrderResult = await paymentService.createOrder({
      orderAmount: amountInRupees,
      orderCurrency: 'INR',
      receipt,
      notes: {
        userId: userId.toString(),
        userEmail,
        type: 'addon',
        addonSlug: addonDoc.slug,
        addonName: addonDoc.name,
        addonType: addonDoc.type,
        quantity: addonDoc.quantity,
        orderNumber,
        description: orderNote
      }
    });

    const payment = await Payment.create({
      user: userId,
      orderId: rzpOrderResult.orderId,
      razorpayOrderId: rzpOrderResult.orderId,
      orderNumber,
      paymentMethod,
      amount: amountInRupees,
      amountInPaise,
      currency: 'INR',
      type: 'addon',
      plan: addonDoc.slug,
      addon: addonDoc._id,
      addonDetails: {
        slug: addonDoc.slug,
        name: addonDoc.name,
        type: addonDoc.type,
        quantity: addonDoc.quantity,
        durationMinutes: addonDoc.durationMinutes || 0,
        price: addonDoc.price
      },
      billingCycle: 'one_time',
      status: PAYMENT_STATUS.CREATED,
      receipt,
      notes: {
        userEmail,
        type: 'addon',
        addonName: addonDoc.name,
        addonId: addonDoc._id.toString(),
        addonSlug: addonDoc.slug,
        orderNumber,
        paymentMethod
      }
    });

    return res.status(HTTP_STATUS.CREATED).json(
      new ApiResponse(
        HTTP_STATUS.CREATED,
        {
          orderId: rzpOrderResult.orderId,
          razorpayOrderId: rzpOrderResult.orderId,
          keyId: paymentService.keyId || ENV.RAZORPAY_KEY_ID,
          orderNumber,
          paymentMethod,
          amount: amountInRupees,
          amountInPaise,
          currency: 'INR',
          type: 'addon',
          addon: addonDoc.slug,
          addonId: addonDoc._id,
          addonName: addonDoc.name,
          addonType: addonDoc.type,
          quantity: addonDoc.quantity,
          receipt,
          paymentId: payment._id,
          user: {
            name: userName,
            email: userEmail,
            contact: userPhone
          }
        },
        'Razorpay addon order created successfully'
      )
    );
  }

  // ----------------------------------------------------
  // Branch B: Subscription Plan Order (with Addon fallback)
  // ----------------------------------------------------
  await ensureInitialPlansSeeded();

  let planDoc = await findPlanByReference(planRef);

  // Fallback: If planRef doesn't match a Plan, check if it matches an Addon!
  if (!planDoc) {
    await ensureInitialAddonsSeeded();
    const fallbackAddon = await findAddonByReference(planRef);
    if (fallbackAddon && fallbackAddon.isActive) {
      const amountInRupees = fallbackAddon.price;
      const amountInPaise = Math.round(amountInRupees * 100);
      const orderNumber = generate10DigitOrderNumber();
      const receipt = `pj_add_${orderNumber}`.slice(0, 40);
      const orderNote = `Prem Jodo Addon: ${fallbackAddon.name}`;

      const rzpOrderResult = await paymentService.createOrder({
        orderAmount: amountInRupees,
        orderCurrency: 'INR',
        receipt,
        notes: {
          userId: userId.toString(),
          userEmail,
          type: 'addon',
          addonSlug: fallbackAddon.slug,
          addonName: fallbackAddon.name,
          addonType: fallbackAddon.type,
          quantity: fallbackAddon.quantity,
          orderNumber,
          description: orderNote
        }
      });

      const payment = await Payment.create({
        user: userId,
        orderId: rzpOrderResult.orderId,
        razorpayOrderId: rzpOrderResult.orderId,
        orderNumber,
        paymentMethod,
        amount: amountInRupees,
        amountInPaise,
        currency: 'INR',
        type: 'addon',
        plan: fallbackAddon.slug,
        addon: fallbackAddon._id,
        addonDetails: {
          slug: fallbackAddon.slug,
          name: fallbackAddon.name,
          type: fallbackAddon.type,
          quantity: fallbackAddon.quantity,
          durationMinutes: fallbackAddon.durationMinutes || 0,
          price: fallbackAddon.price
        },
        billingCycle: 'one_time',
        status: PAYMENT_STATUS.CREATED,
        receipt,
        notes: {
          userEmail,
          type: 'addon',
          addonName: fallbackAddon.name,
          addonId: fallbackAddon._id.toString(),
          addonSlug: fallbackAddon.slug,
          orderNumber,
          paymentMethod
        }
      });

      return res.status(HTTP_STATUS.CREATED).json(
        new ApiResponse(
          HTTP_STATUS.CREATED,
          {
            orderId: rzpOrderResult.orderId,
            razorpayOrderId: rzpOrderResult.orderId,
            keyId: paymentService.keyId || ENV.RAZORPAY_KEY_ID,
            orderNumber,
            paymentMethod,
            amount: amountInRupees,
            amountInPaise,
            currency: 'INR',
            type: 'addon',
            addon: fallbackAddon.slug,
            addonId: fallbackAddon._id,
            addonName: fallbackAddon.name,
            addonType: fallbackAddon.type,
            quantity: fallbackAddon.quantity,
            receipt,
            paymentId: payment._id,
            user: {
              name: userName,
              email: userEmail,
              contact: userPhone
            }
          },
          'Razorpay addon order created successfully'
        )
      );
    }

    throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid or inactive plan: ${planRef}`);
  }

  const pricingConfig = planDoc.pricing[billingCycle];
  if (!pricingConfig) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid billing cycle: ${billingCycle}`);
  }

  const amountInRupees = pricingConfig.totalAmount;
  const amountInPaise = Math.round(amountInRupees * 100);
  const orderNumber = generate10DigitOrderNumber();
  const receipt = `pj_${orderNumber}`.slice(0, 40);

  const orderNote = `Prem Jodo ${planDoc.name} (${billingCycle})`;

  // Call dedicated PaymentService (Razorpay)
  const rzpOrderResult = await paymentService.createOrder({
    orderAmount: amountInRupees,
    orderCurrency: 'INR',
    receipt,
    notes: {
      userId: userId.toString(),
      userEmail,
      type: 'subscription',
      planSlug: planDoc.slug,
      planName: planDoc.name,
      billingCycle,
      orderNumber,
      description: orderNote
    }
  });

  // Create payment record in database
  const payment = await Payment.create({
    user: userId,
    orderId: rzpOrderResult.orderId,
    razorpayOrderId: rzpOrderResult.orderId,
    orderNumber,
    paymentMethod,
    amount: amountInRupees,
    amountInPaise,
    currency: 'INR',
    type: 'subscription',
    plan: planDoc.slug,
    billingCycle,
    status: PAYMENT_STATUS.CREATED,
    receipt,
    notes: {
      userEmail,
      type: 'subscription',
      planName: planDoc.name,
      planId: planDoc._id.toString(),
      orderNumber,
      paymentMethod
    }
  });

  return res.status(HTTP_STATUS.CREATED).json(
    new ApiResponse(
      HTTP_STATUS.CREATED,
      {
        orderId: rzpOrderResult.orderId,
        razorpayOrderId: rzpOrderResult.orderId,
        keyId: paymentService.keyId || ENV.RAZORPAY_KEY_ID,
        orderNumber,
        paymentMethod,
        amount: amountInRupees,
        amountInPaise,
        currency: 'INR',
        type: 'subscription',
        plan: planDoc.slug,
        planId: planDoc._id,
        planName: planDoc.name,
        billingCycle,
        receipt,
        paymentId: payment._id,
        user: {
          name: userName,
          email: userEmail,
          contact: userPhone
        }
      },
      'Razorpay payment order created successfully'
    )
  );
});

/**
 * 4. Verify Razorpay Payment & Activate Subscription
 * Protected endpoint
 */
export const verifyMembershipPayment = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const orderId = req.body.razorpay_order_id || req.body.orderId || req.body.order_id;
  const paymentId =
    req.body.razorpay_payment_id ||
    req.body.paymentId ||
    req.body.payment_id;
  const signature = req.body.razorpay_signature || req.body.signature;

  if (!orderId) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Order ID is required for payment verification');
  }

  // Find payment record
  const payment = await Payment.findOne({
    $or: [{ orderId }, { razorpayOrderId: orderId }]
  });

  if (!payment) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Payment order not found in database');
  }

  // If already captured, return immediately
  if (payment.status === PAYMENT_STATUS.CAPTURED) {
    const user = await User.findById(userId).select('subscription fullName email');
    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        HTTP_STATUS.OK,
        {
          user,
          subscription: user?.subscription,
          payment: {
            orderId: payment.orderId,
            razorpayOrderId: payment.razorpayOrderId || payment.orderId,
            orderNumber: payment.orderNumber,
            paymentId: payment.paymentId || payment.razorpayPaymentId,
            status: payment.status
          }
        },
        'Payment already verified and subscription is active'
      )
    );
  }

  // 1. Verify Razorpay Signature if provided
  let isSignatureValid = false;
  if (signature && paymentId) {
    isSignatureValid = paymentService.verifyPaymentSignature({
      orderId,
      paymentId,
      signature
    });

    if (!isSignatureValid) {
      payment.status = PAYMENT_STATUS.FAILED;
      payment.failureReason = 'Razorpay payment signature verification failed';
      await payment.save();
      throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid payment signature');
    }
  }

  // 2. Query Razorpay API for order / payment status confirmation
  let rzpPayment = null;
  let isGatewayPaid = false;

  if (paymentService.isConfigured) {
    try {
      if (paymentId) {
        rzpPayment = await paymentService.getPayment(paymentId);
        if (rzpPayment && (rzpPayment.status === 'captured' || rzpPayment.status === 'authorized')) {
          isGatewayPaid = true;
        }
      }

      if (!isGatewayPaid) {
        const orderDetails = await paymentService.getOrder(orderId);
        if (orderDetails && orderDetails.status === 'paid') {
          isGatewayPaid = true;
        }
      }
    } catch (err) {
      console.warn(`Payment gateway status check warning for order ${orderId}:`, err.message);
    }
  } else {
    // Development fallback when credentials are not configured
    isGatewayPaid = true;
  }

  const isPaid = isSignatureValid || isGatewayPaid;

  if (!isPaid) {
    payment.status = PAYMENT_STATUS.FAILED;
    payment.failureReason = 'Payment status not paid or failed on Razorpay gateway';
    await payment.save();
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Payment is not completed or has failed');
  }

  // Extract payment details
  const actualPaymentId = paymentId || rzpPayment?.id || `pay_${orderId}_${Date.now()}`;
  const actualPaymentMethod = rzpPayment?.method || payment.paymentMethod || 'Razorpay';

  // Check if this payment is for an Add-on
  const isAddonPayment =
    payment.type === 'addon' ||
    Boolean(payment.addon) ||
    payment.notes?.type === 'addon';

  if (isAddonPayment) {
    const addonDoc = await findAddonByReference(
      payment.addon || payment.notes?.addonSlug || payment.plan
    );
    const addonType =
      addonDoc?.type ||
      payment.addonDetails?.type ||
      (payment.plan?.includes('boost') ? ADDON_TYPES.PROFILE_BOOST : ADDON_TYPES.SUPER_LIKES);
    const quantity = addonDoc?.quantity || payment.addonDetails?.quantity || 1;

    const incQuery = {};
    if (addonType === ADDON_TYPES.PROFILE_BOOST || addonType === 'profile_boost') {
      incQuery['subscription.boostsRemaining'] = quantity;
      incQuery['subscription.addonBoostsRemaining'] = quantity;
    } else {
      incQuery['subscription.superLikesRemaining'] = quantity;
      incQuery['subscription.addonSuperLikesRemaining'] = quantity;
    }

    // Update Payment record
    payment.status = PAYMENT_STATUS.CAPTURED;
    payment.paymentId = actualPaymentId;
    payment.razorpayPaymentId = actualPaymentId;
    payment.razorpayOrderId = orderId;
    if (signature) {
      payment.signature = signature;
      payment.razorpaySignature = signature;
    }
    payment.paymentMethod = actualPaymentMethod;
    await payment.save();

    // Update User Model with additional credits
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $inc: incQuery },
      { new: true }
    ).select('-password -refreshToken');

    // Invalidate Redis Caches
    const uStr = userId.toString();
    await Promise.all([
      CacheService.del(`user:${uStr}`),
      CacheService.del(`profile:${uStr}`),
      CacheService.delByPattern(`feed:*`)
    ]);

    // Real-time socket event emission to client
    emitToUser(uStr, 'addon_purchased', {
      type: 'addon',
      addon: addonDoc || payment.addonDetails,
      addonType,
      quantityAdded: quantity,
      boostsRemaining: updatedUser?.subscription?.boostsRemaining || 0,
      superLikesRemaining: updatedUser?.subscription?.superLikesRemaining || 0,
      timestamp: new Date().toISOString()
    });

    emitToUser(uStr, 'membership_updated', {
      subscription: updatedUser?.subscription,
      membership: updatedUser?.subscription,
      timestamp: new Date().toISOString()
    });

    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        HTTP_STATUS.OK,
        {
          type: 'addon',
          user: updatedUser,
          subscription: updatedUser?.subscription,
          boostsRemaining: updatedUser?.subscription?.boostsRemaining || 0,
          superLikesRemaining: updatedUser?.subscription?.superLikesRemaining || 0,
          addon: addonDoc || payment.addonDetails,
          quantityAdded: quantity,
          payment: {
            orderId: payment.orderId,
            razorpayOrderId: payment.razorpayOrderId || payment.orderId,
            orderNumber: payment.orderNumber,
            paymentId: payment.paymentId,
            razorpayPaymentId: payment.razorpayPaymentId,
            paymentMethod: payment.paymentMethod,
            amount: payment.amount,
            status: payment.status
          }
        },
        'Addon payment verified and credits added successfully'
      )
    );
  }

  // Find plan from database
  const planDoc = await findPlanByReference(payment.plan);
  const billingCycle = payment.billingCycle;
  const pricingConfig =
    planDoc?.pricing[billingCycle] ||
    planDoc?.pricing[BILLING_CYCLES.MONTHLY] || { durationDays: 30 };

  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + pricingConfig.durationDays * 24 * 60 * 60 * 1000);

  const perks = planDoc?.perks || {
    unlimitedSwipes: false,
    rewindAllowed: false,
    superLikesPerWeek: 0,
    passportLocation: false,
    seeWhoLikedYou: false,
    profileBoostPerMonth: 0,
    priorityLikes: false,
    messageBeforeMatch: false,
    vipBadge: false
  };

  // Fetch existing user to preserve any already purchased addon credits
  const existingUser = await User.findById(userId);
  const existingAddonSuperLikes = existingUser?.subscription?.addonSuperLikesRemaining || 0;
  const existingAddonBoosts = existingUser?.subscription?.addonBoostsRemaining || 0;

  const planSuperLikes = perks.superLikesPerWeek || 0;
  const planBoosts = perks.profileBoostPerMonth || 0;

  const subscriptionData = {
    plan: planDoc ? planDoc.slug : payment.plan,
    planName: planDoc ? planDoc.name : payment.plan,
    billingCycle,
    amount: payment.amount,
    currency: payment.currency,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    startDate,
    endDate,
    autoRenew: true,
    perks,
    planBoostsRemaining: planBoosts,
    addonBoostsRemaining: existingAddonBoosts,
    boostsRemaining: planBoosts + existingAddonBoosts,
    lastBoostsRefillAt: new Date(),
    planSuperLikesRemaining: planSuperLikes,
    addonSuperLikesRemaining: existingAddonSuperLikes,
    superLikesRemaining: planSuperLikes + existingAddonSuperLikes,
    lastSuperLikesRefillAt: new Date()
  };

  // Update Payment record
  payment.status = PAYMENT_STATUS.CAPTURED;
  payment.paymentId = actualPaymentId;
  payment.razorpayPaymentId = actualPaymentId;
  payment.razorpayOrderId = orderId;
  if (signature) {
    payment.signature = signature;
    payment.razorpaySignature = signature;
  }
  payment.paymentMethod = actualPaymentMethod;
  await payment.save();

  // Update User Model directly with active subscription
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        subscription: subscriptionData
      }
    },
    { new: true }
  ).select('-password -refreshToken');

  // Invalidate Redis Caches
  const uStr = userId.toString();
  await Promise.all([
    CacheService.del(`user:${uStr}`),
    CacheService.del(`profile:${uStr}`),
    CacheService.delByPattern(`feed:*`)
  ]);

  // Real-time socket event emission to client
  emitToUser(uStr, 'membership_updated', {
    subscription: updatedUser.subscription,
    membership: updatedUser.subscription,
    planDetails: planDoc,
    timestamp: new Date().toISOString()
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        user: updatedUser,
        subscription: updatedUser.subscription,
        payment: {
          orderId: payment.orderId,
          razorpayOrderId: payment.razorpayOrderId || payment.orderId,
          orderNumber: payment.orderNumber,
          paymentId: payment.paymentId,
          razorpayPaymentId: payment.razorpayPaymentId,
          paymentMethod: payment.paymentMethod,
          amount: payment.amount,
          status: payment.status
        },
        planDetails: planDoc
      },
      'Payment verified successfully'
    )
  );
});

/**
 * 5. Cancel Membership with 2-Day Refund Condition
 * Protected endpoint
 * Policy:
 *  - <= 2 days (48 hours): Full refund initiated via Razorpay and membership reverted immediately to Free tier.
 *  - > 2 days (48 hours): Auto-renewal cancelled, retain perks until end of billing cycle, no refund.
 */
export const cancelSubscription = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { orderId, order_id, paymentId, payment_id, reason, note } = req.body || {};

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  const targetOrderId = orderId || order_id;
  const targetPaymentId = paymentId || payment_id;

  let paymentQuery = { user: userId, status: PAYMENT_STATUS.CAPTURED };
  if (targetOrderId) {
    paymentQuery = {
      user: userId,
      status: PAYMENT_STATUS.CAPTURED,
      $or: [{ orderId: targetOrderId }, { razorpayOrderId: targetOrderId }]
    };
  } else if (targetPaymentId) {
    paymentQuery = {
      user: userId,
      status: PAYMENT_STATUS.CAPTURED,
      $or: [{ paymentId: targetPaymentId }, { razorpayPaymentId: targetPaymentId }]
    };
  }

  const payment = await Payment.findOne(paymentQuery).sort({ createdAt: -1 });
  if (!payment) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'No captured payment found to cancel or refund');
  }

  const uStr = userId.toString();

  // Determine activation timestamp and elapsed duration
  const activationDate = payment.createdAt || user.subscription?.startDate || new Date();
  const elapsedMs = Date.now() - new Date(activationDate).getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  const isEligibleForRefund = elapsedHours <= REFUND_POLICY.MAX_REFUND_HOURS; // 48 hours

  const isAddonPayment =
    payment.type === 'addon' ||
    Boolean(payment.addon) ||
    payment.notes?.type === 'addon';

  // ==========================================
  // BRANCH 1: CANCEL / REFUND ADD-ON
  // (Only remove this addon's quantity from credits, keep plan intact)
  // ==========================================
  if (isAddonPayment) {
    if (!isEligibleForRefund) {
      throw new ApiError(
        HTTP_STATUS.BAD_REQUEST,
        `Addon refund is only applicable within ${REFUND_POLICY.MAX_REFUND_DAYS} days (48 hours) of purchase. Elapsed time: ${Math.round(elapsedHours)} hours.`
      );
    }

    const addonDoc = await findAddonByReference(
      payment.addon || payment.notes?.addonSlug || payment.plan
    );
    const addonType =
      addonDoc?.type ||
      payment.addonDetails?.type ||
      (payment.plan?.includes('boost') ? ADDON_TYPES.PROFILE_BOOST : ADDON_TYPES.SUPER_LIKES);
    const quantityToRemove = addonDoc?.quantity || payment.addonDetails?.quantity || 1;

    const refundId = `ref_${payment.orderId}_${Date.now()}`;
    const refundNote = reason || note || `Addon ${payment.plan} cancelled within 2-day refund policy window`;
    const targetRzpPaymentId = payment.razorpayPaymentId || payment.paymentId;

    let refundResult = null;
    try {
      if (targetRzpPaymentId && paymentService.isConfigured) {
        refundResult = await paymentService.initiateRefund({
          paymentId: targetRzpPaymentId,
          refundAmount: payment.amount,
          refundNote,
          refundSpeed: 'normal'
        });
      }

      payment.status = PAYMENT_STATUS.REFUNDED;
      payment.refundId = refundResult?.refundId || refundId;
      payment.razorpayRefundId = refundResult?.refundId || null;
      payment.refundAmount = payment.amount;
      payment.refundStatus = refundResult?.refundStatus || 'SUCCESS';
      payment.refundArn = refundResult?.refundArn || null;
      payment.refundedAt = new Date();
      payment.refundReason = refundNote;
      await payment.save();
    } catch (err) {
      console.error('❌ Razorpay Refund Error:', err.message);
      payment.status = PAYMENT_STATUS.REFUND_PENDING;
      payment.refundId = refundId;
      payment.refundReason = `Refund processing pending: ${err.message}`;
      await payment.save();
    }

    // Deduct ONLY this addon's quantity from user's remaining addon credits
    if (addonType === ADDON_TYPES.PROFILE_BOOST || addonType === 'profile_boost') {
      user.subscription.addonBoostsRemaining = Math.max(
        0,
        (user.subscription.addonBoostsRemaining || 0) - quantityToRemove
      );
      user.subscription.boostsRemaining = Math.max(
        0,
        (user.subscription.planBoostsRemaining || 0) + user.subscription.addonBoostsRemaining
      );
    } else {
      user.subscription.addonSuperLikesRemaining = Math.max(
        0,
        (user.subscription.addonSuperLikesRemaining || 0) - quantityToRemove
      );
      user.subscription.superLikesRemaining = Math.max(
        0,
        (user.subscription.planSuperLikesRemaining || 0) + user.subscription.addonSuperLikesRemaining
      );
    }
    await user.save();

    await Promise.all([
      CacheService.del(`user:${uStr}`),
      CacheService.del(`profile:${uStr}`),
      CacheService.delByPattern(`feed:*`)
    ]);

    emitToUser(uStr, 'addon_cancelled', {
      orderId: payment.orderId,
      addon: addonDoc || payment.addonDetails,
      removedCredits: quantityToRemove,
      boostsRemaining: user.subscription.boostsRemaining,
      superLikesRemaining: user.subscription.superLikesRemaining,
      refundAmount: payment.amount,
      timestamp: new Date().toISOString()
    });

    emitToUser(uStr, 'membership_updated', {
      subscription: user.subscription,
      membership: user.subscription,
      timestamp: new Date().toISOString()
    });

    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        HTTP_STATUS.OK,
        {
          type: 'addon',
          refunded: true,
          refundAmount: payment.amount,
          removedCredits: quantityToRemove,
          boostsRemaining: user.subscription.boostsRemaining,
          superLikesRemaining: user.subscription.superLikesRemaining,
          payment: {
            orderId: payment.orderId,
            status: payment.status,
            refundId: payment.refundId,
            refundArn: payment.refundArn
          }
        },
        `Add-on cancelled successfully. ${quantityToRemove} credits removed and full refund of ₹${payment.amount} initiated.`
      )
    );
  }

  // ==========================================
  // BRANCH 2: CANCEL MEMBERSHIP PLAN
  // ==========================================
  if (!user.subscription || user.subscription.status !== SUBSCRIPTION_STATUS.ACTIVE) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'No active subscription found to cancel');
  }

  // CASE 1: Eligible for Refund (Within 2 Days)
  if (isEligibleForRefund && payment && payment.amount > 0) {
    const refundId = `ref_${payment.orderId}_${Date.now()}`;
    const refundNote = reason || note || 'Membership cancelled within 2-day refund policy window';
    const targetPaymentId = payment.razorpayPaymentId || payment.paymentId;

    let refundResult = null;
    try {
      if (targetPaymentId) {
        refundResult = await paymentService.initiateRefund({
          paymentId: targetPaymentId,
          refundAmount: payment.amount,
          refundNote,
          refundSpeed: 'normal'
        });
      }

      // Update payment record with refund information
      payment.status = PAYMENT_STATUS.REFUNDED;
      payment.refundId = refundResult?.refundId || refundId;
      payment.razorpayRefundId = refundResult?.refundId || null;
      payment.refundAmount = payment.amount;
      payment.refundStatus = refundResult?.refundStatus || 'SUCCESS';
      payment.refundArn = refundResult?.refundArn || null;
      payment.refundedAt = new Date();
      payment.refundReason = refundNote;
      await payment.save();
    } catch (err) {
      console.error('❌ Razorpay Refund Error:', err.message);
      // Mark as refund pending for manual or webhook reconciliation
      payment.status = PAYMENT_STATUS.REFUND_PENDING;
      payment.refundId = refundId;
      payment.refundReason = `Refund processing pending: ${err.message}`;
      await payment.save();
    }

    // Revert user to FREE tier immediately since refunded
    user.subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
    user.subscription.plan = MEMBERSHIP_TIERS.FREE;
    user.subscription.planName = 'Prem Jodo Free';
    user.subscription.autoRenew = false;
    user.subscription.endDate = new Date();
    user.subscription.perks = {
      unlimitedSwipes: false,
      rewindAllowed: false,
      superLikesPerWeek: 0,
      passportLocation: false,
      seeWhoLikedYou: false,
      profileBoostPerMonth: 0,
      priorityLikes: false,
      messageBeforeMatch: false,
      vipBadge: false
    };
    user.subscription.boostsRemaining = 0;
    user.subscription.planBoostsRemaining = 0;
    user.subscription.addonBoostsRemaining = 0;
    user.subscription.superLikesRemaining = 0;
    user.subscription.planSuperLikesRemaining = 0;
    user.subscription.addonSuperLikesRemaining = 0;
    await user.save();

    // Invalidate Redis Caches
    await Promise.all([
      CacheService.del(`user:${uStr}`),
      CacheService.del(`profile:${uStr}`),
      CacheService.delByPattern(`feed:*`)
    ]);

    // Emit Realtime Socket Event
    emitToUser(uStr, 'membership_cancelled', {
      subscription: user.subscription,
      refund: {
        isEligible: true,
        refunded: true,
        refundAmount: payment.amount,
        refundId: payment.refundId || refundId,
        refundStatus: payment.status
      },
      message: 'Your membership has been cancelled and full refund has been initiated (within 2-day policy).'
    });

    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        HTTP_STATUS.OK,
        {
          subscription: user.subscription,
          refund: {
            isEligible: true,
            refunded: true,
            refundAmount: payment.amount,
            refundId: payment.refundId || refundId,
            refundStatus: payment.status,
            refundArn: payment.refundArn,
            refundedAt: payment.refundedAt || new Date()
          }
        },
        'Membership cancelled successfully. Full refund has been initiated to your original payment method (within 2-day refund policy).'
      )
    );
  }

  // CASE 2: Not eligible for refund (After 2 Days)
  user.subscription.autoRenew = false;
  user.subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
  await user.save();

  // Invalidate Redis Caches
  await Promise.all([
    CacheService.del(`user:${uStr}`),
    CacheService.del(`profile:${uStr}`)
  ]);

  // Emit Realtime Socket Event
  emitToUser(uStr, 'membership_cancelled', {
    subscription: user.subscription,
    refund: {
      isEligible: false,
      refunded: false,
      reason: `Refund policy window (${REFUND_POLICY.MAX_REFUND_DAYS} days) has expired.`
    },
    message: 'Subscription auto-renew stopped. Perks will remain active until the end of your billing cycle.'
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        subscription: user.subscription,
        refund: {
          isEligible: false,
          refunded: false,
          reason: `Refund is only applicable within ${REFUND_POLICY.MAX_REFUND_DAYS} days (48 hours) of purchase. Elapsed time: ${Math.round(elapsedHours)} hours.`
        }
      },
      `Subscription auto-renew cancelled. You will retain membership perks until ${new Date(user.subscription.endDate).toLocaleDateString()}. Refund is not applicable after 2 days of purchase.`
    )
  );
});

/**
 * 6. Razorpay Webhook Handler
 * Public webhook endpoint called asynchronously by Razorpay servers
 */
export const handleRazorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'] || req.headers['x-webhook-signature'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  // Webhook signature verification
  const isValid = paymentService.verifyWebhookSignature({
    signature,
    rawBody
  });

  if (!isValid && paymentService.isConfigured) {
    console.error('❌ Razorpay Webhook verification failed: Invalid signature');
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid Razorpay webhook signature');
  }

  const payload = req.body || {};
  const event = payload.event || '';
  const eventData = payload.payload || {};

  console.log(`📩 Razorpay Webhook received event: ${event}`);

  // 1. Handle Payment Captured / Order Paid
  if (event === 'payment.captured' || event === 'order.paid') {
    const paymentEntity = eventData.payment?.entity || {};
    const orderEntity = eventData.order?.entity || {};
    const orderId = paymentEntity.order_id || orderEntity.id || payload.order_id;
    const rzpPaymentId = paymentEntity.id || payload.payment_id;
    const paymentMethod = paymentEntity.method;

    if (orderId) {
      const payment = await Payment.findOne({
        $or: [{ orderId }, { razorpayOrderId: orderId }]
      });

      if (payment && payment.status !== PAYMENT_STATUS.CAPTURED) {
        payment.status = PAYMENT_STATUS.CAPTURED;
        payment.razorpayPaymentId = rzpPaymentId;
        payment.paymentId = rzpPaymentId;
        payment.paymentMethod = paymentMethod;
        if (signature) {
          payment.signature = signature;
          payment.razorpaySignature = signature;
        }
        await payment.save();

        if (payment.user) {
          const uStr = payment.user.toString();
          const isAddonPayment =
            payment.type === 'addon' ||
            Boolean(payment.addon) ||
            payment.notes?.type === 'addon';

          if (isAddonPayment) {
            const addonDoc = await findAddonByReference(
              payment.addon || payment.notes?.addonSlug || payment.plan
            );
            const addonType =
              addonDoc?.type ||
              payment.addonDetails?.type ||
              (payment.plan?.includes('boost') ? ADDON_TYPES.PROFILE_BOOST : ADDON_TYPES.SUPER_LIKES);
            const quantity = addonDoc?.quantity || payment.addonDetails?.quantity || 1;

            const incQuery = {};
            if (addonType === ADDON_TYPES.PROFILE_BOOST || addonType === 'profile_boost') {
              incQuery['subscription.boostsRemaining'] = quantity;
              incQuery['subscription.addonBoostsRemaining'] = quantity;
            } else {
              incQuery['subscription.superLikesRemaining'] = quantity;
              incQuery['subscription.addonSuperLikesRemaining'] = quantity;
            }

            const updatedUser = await User.findByIdAndUpdate(
              payment.user,
              { $inc: incQuery },
              { new: true }
            );

            await Promise.all([
              CacheService.del(`user:${uStr}`),
              CacheService.del(`profile:${uStr}`),
              CacheService.delByPattern(`feed:*`)
            ]);

            emitToUser(uStr, 'addon_purchased', {
              type: 'addon',
              addon: addonDoc || payment.addonDetails,
              addonType,
              quantityAdded: quantity,
              boostsRemaining: updatedUser?.subscription?.boostsRemaining || 0,
              superLikesRemaining: updatedUser?.subscription?.superLikesRemaining || 0,
              timestamp: new Date().toISOString()
            });

            emitToUser(uStr, 'membership_updated', {
              status: 'active',
              orderId,
              subscription: updatedUser?.subscription,
              timestamp: new Date().toISOString()
            });
          } else {
            const planDoc = await findPlanByReference(payment.plan);
            const billingCycle = payment.billingCycle;
            const pricingConfig =
              planDoc?.pricing[billingCycle] ||
              planDoc?.pricing[BILLING_CYCLES.MONTHLY] || { durationDays: 30 };

            const startDate = new Date();
            const endDate = new Date(
              startDate.getTime() + pricingConfig.durationDays * 24 * 60 * 60 * 1000
            );
            const perks = planDoc?.perks || {
              unlimitedSwipes: false,
              rewindAllowed: false,
              superLikesPerWeek: 0,
              passportLocation: false,
              seeWhoLikedYou: false,
              profileBoostPerMonth: 0,
              priorityLikes: false,
              messageBeforeMatch: false,
              vipBadge: false
            };

            const existingUser = await User.findById(payment.user);
            const existingAddonSuperLikes =
              existingUser?.subscription?.addonSuperLikesRemaining || 0;
            const existingAddonBoosts =
              existingUser?.subscription?.addonBoostsRemaining || 0;

            const planSuperLikes = perks.superLikesPerWeek || 0;
            const planBoosts = perks.profileBoostPerMonth || 0;

            await User.findByIdAndUpdate(payment.user, {
              $set: {
                subscription: {
                  plan: planDoc ? planDoc.slug : payment.plan,
                  planName: planDoc ? planDoc.name : payment.plan,
                  billingCycle,
                  amount: payment.amount,
                  currency: payment.currency,
                  status: SUBSCRIPTION_STATUS.ACTIVE,
                  startDate,
                  endDate,
                  autoRenew: true,
                  perks,
                  planBoostsRemaining: planBoosts,
                  addonBoostsRemaining: existingAddonBoosts,
                  boostsRemaining: planBoosts + existingAddonBoosts,
                  lastBoostsRefillAt: new Date(),
                  planSuperLikesRemaining: planSuperLikes,
                  addonSuperLikesRemaining: existingAddonSuperLikes,
                  superLikesRemaining: planSuperLikes + existingAddonSuperLikes,
                  lastSuperLikesRefillAt: new Date()
                }
              }
            });

            // Invalidate Redis Caches
            await Promise.all([
              CacheService.del(`user:${uStr}`),
              CacheService.del(`profile:${uStr}`),
              CacheService.delByPattern(`feed:*`)
            ]);

            emitToUser(uStr, 'membership_updated', {
              status: 'active',
              orderId,
              plan: payment.plan,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    }
  }

  // 2. Handle Payment Failed
  else if (event === 'payment.failed') {
    const paymentEntity = eventData.payment?.entity || {};
    const orderId = paymentEntity.order_id || payload.order_id;
    const failureReason =
      paymentEntity.error_description ||
      paymentEntity.error_reason ||
      'Payment failed at Razorpay gateway';

    if (orderId) {
      const payment = await Payment.findOne({
        $or: [{ orderId }, { razorpayOrderId: orderId }]
      });

      if (payment && payment.status !== PAYMENT_STATUS.CAPTURED) {
        payment.status = PAYMENT_STATUS.FAILED;
        payment.failureReason = failureReason;
        await payment.save();
      }
    }
  }

  // 3. Handle Refund Processed / Refund Created
  else if (event === 'refund.processed' || event === 'refund.created') {
    const refundEntity = eventData.refund?.entity || {};
    const paymentEntity = eventData.payment?.entity || {};
    const paymentId = refundEntity.payment_id || paymentEntity.id;

    if (paymentId) {
      const payment = await Payment.findOne({
        $or: [{ paymentId }, { razorpayPaymentId: paymentId }]
      });

      if (payment) {
        payment.status = PAYMENT_STATUS.REFUNDED;
        payment.refundStatus = 'SUCCESS';
        payment.refundArn = refundEntity.acquirer_data?.arn || payment.refundArn;
        payment.razorpayRefundId = refundEntity.id || payment.razorpayRefundId;
        payment.refundedAt = new Date();
        await payment.save();
      }
    }
  }

  // 4. Handle Refund Failed
  else if (event === 'refund.failed') {
    const refundEntity = eventData.refund?.entity || {};
    const paymentEntity = eventData.payment?.entity || {};
    const paymentId = refundEntity.payment_id || paymentEntity.id;

    if (paymentId) {
      const payment = await Payment.findOne({
        $or: [{ paymentId }, { razorpayPaymentId: paymentId }]
      });

      if (payment) {
        payment.refundStatus = 'FAILED';
        payment.failureReason = 'Refund failed on Razorpay gateway';
        await payment.save();
      }
    }
  }

  return res.status(HTTP_STATUS.OK).json({ status: 'OK', message: 'Webhook processed' });
});

// ==========================================
// ADMIN ENDPOINTS (Manage Plans Dynamically)
// ==========================================

/**
 * 7. Admin: Get all Plans (Active + Inactive)
 */
export const getAllPlansAdmin = asyncHandler(async (req, res) => {
  await ensureInitialPlansSeeded();
  const plans = await Plan.find().sort({ displayOrder: 1, createdAt: 1 });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, plans, 'All membership plans retrieved successfully')
  );
});

/**
 * 8. Admin: Create a new Plan
 */
export const createPlanAdmin = asyncHandler(async (req, res) => {
  const { slug, name } = req.body;

  const existingPlan = await Plan.findOne({ slug: slug.toLowerCase().trim() });
  if (existingPlan) {
    throw new ApiError(HTTP_STATUS.CONFLICT, `Plan with slug "${slug}" already exists`);
  }

  const plan = await Plan.create({
    ...req.body,
    slug: slug.toLowerCase().trim()
  });

  return res.status(HTTP_STATUS.CREATED).json(
    new ApiResponse(HTTP_STATUS.CREATED, plan, `Plan "${name}" created successfully`)
  );
});

/**
 * 9. Admin: Update an existing Plan
 */
export const updatePlanAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid Plan ID');
  }

  const updatedPlan = await Plan.findByIdAndUpdate(
    id,
    { $set: req.body },
    { new: true, runValidators: true }
  );

  if (!updatedPlan) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Plan not found');
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, updatedPlan, 'Plan updated successfully')
  );
});

/**
 * 10. Admin: Delete a Plan
 */
export const deletePlanAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid Plan ID');
  }

  const deletedPlan = await Plan.findByIdAndDelete(id);
  if (!deletedPlan) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Plan not found');
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { id }, 'Plan deleted successfully')
  );
});

// ==========================================
// PROFILE BOOST ACTIVATION (Use 1 Boost Credit)
// ==========================================

/**
 * 11. Activate Profile Boost (Consumes 1 Boost Credit for 30 minutes)
 * Protected endpoint
 */
export const activateProfileBoost = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
  }

  const currentBoosts = user.subscription?.boostsRemaining || 0;
  if (currentBoosts <= 0) {
    throw new ApiError(
      HTTP_STATUS.BAD_REQUEST,
      'You have 0 boosts remaining. Please purchase a profile boost pack from Add-ons.'
    );
  }

  // Decrement boost credit: consume planBoostsRemaining first, then addonBoostsRemaining
  if ((user.subscription.planBoostsRemaining || 0) > 0) {
    user.subscription.planBoostsRemaining -= 1;
  } else {
    user.subscription.addonBoostsRemaining = Math.max(
      0,
      (user.subscription.addonBoostsRemaining || 0) - 1
    );
  }
  user.subscription.boostsRemaining =
    (user.subscription.planBoostsRemaining || 0) +
    (user.subscription.addonBoostsRemaining || 0);
  await user.save();

  // Boost profile for 24 hours
  const boostDurationMs = 24 * 60 * 60 * 1000;
  const boostExpiresAt = new Date(Date.now() + boostDurationMs);

  const updatedProfile = await Profile.findOneAndUpdate(
    { user: userId },
    {
      $set: {
        isBoosted: true,
        boostExpiresAt
      }
    },
    { new: true, upsert: true }
  );

  // Invalidate Redis Caches
  const uStr = userId.toString();
  await Promise.all([
    CacheService.del(`user:${uStr}`),
    CacheService.del(`profile:${uStr}`),
    CacheService.delByPattern(`feed:*`)
  ]);

  // Real-time socket notification
  emitToUser(uStr, 'boost_activated', {
    isBoosted: true,
    boostExpiresAt,
    boostsRemaining: user.subscription.boostsRemaining,
    durationHours: 24,
    durationMinutes: 1440,
    timestamp: new Date().toISOString()
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        isBoosted: true,
        boostExpiresAt,
        boostsRemaining: user.subscription.boostsRemaining,
        durationHours: 24,
        durationMinutes: 1440,
        profile: updatedProfile
      },
      'Profile Boost activated successfully! You are now top profile in your area for 24 hours.'
    )
  );
});

// ==========================================
// ADMIN ENDPOINTS (Manage Add-ons Dynamically)
// ==========================================

/**
 * 12. Admin: Get all Addons (Active + Inactive)
 */
export const getAllAddonsAdmin = asyncHandler(async (req, res) => {
  await ensureInitialAddonsSeeded();
  const addons = await Addon.find().sort({ displayOrder: 1, createdAt: 1 });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, addons, 'All addons retrieved successfully')
  );
});

/**
 * 13. Admin: Create a new Addon
 */
export const createAddonAdmin = asyncHandler(async (req, res) => {
  const { slug, name } = req.body;

  const existingAddon = await Addon.findOne({ slug: slug.toLowerCase().trim() });
  if (existingAddon) {
    throw new ApiError(HTTP_STATUS.CONFLICT, `Addon with slug "${slug}" already exists`);
  }

  const addon = await Addon.create({
    ...req.body,
    slug: slug.toLowerCase().trim()
  });

  return res.status(HTTP_STATUS.CREATED).json(
    new ApiResponse(HTTP_STATUS.CREATED, addon, `Addon "${name}" created successfully`)
  );
});

/**
 * 14. Admin: Update an existing Addon
 */
export const updateAddonAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid Addon ID');
  }

  const updatedAddon = await Addon.findByIdAndUpdate(
    id,
    { $set: req.body },
    { new: true, runValidators: true }
  );

  if (!updatedAddon) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Addon not found');
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, updatedAddon, 'Addon updated successfully')
  );
});

/**
 * 15. Admin: Delete an Addon
 */
export const deleteAddonAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid Addon ID');
  }

  const deletedAddon = await Addon.findByIdAndDelete(id);
  if (!deletedAddon) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Addon not found');
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, { id }, 'Addon deleted successfully')
  );
});
