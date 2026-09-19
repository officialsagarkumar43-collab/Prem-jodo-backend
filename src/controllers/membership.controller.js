import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Profile } from '../models/Profile.js';
import { Payment } from '../models/Payment.js';
import { Plan } from '../models/Plan.js';
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
  HTTP_STATUS
} from '../constants/index.js';
import { ENV } from '../config/env.js';
import { emitToUser } from '../sockets/index.js';
import { CacheService } from '../services/cache.service.js';
import { paymentService } from '../services/payment.service.js';

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
 * Helper to generate a 10-digit unique numeric order number
 */
export const generate10DigitOrderNumber = () => {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
};

// ==========================================
// USER ENDPOINTS
// ==========================================

/**
 * 1. Get all Active Membership Plans Catalog
 * Public endpoint
 */
export const getMembershipPlans = asyncHandler(async (req, res) => {
  await ensureInitialPlansSeeded();

  const plans = await Plan.find({ isActive: true }).sort({ displayOrder: 1, createdAt: 1 });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        plans,
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
      await user.save();
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
 * 3. Create Razorpay Payment Order
 * Protected endpoint
 */
export const createMembershipOrder = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const {
    plan: planRef,
    billingCycle = BILLING_CYCLES.MONTHLY,
    paymentMethod = 'Razorpay',
    customerPhone,
    customerName,
    customerEmail
  } = req.body;

  await ensureInitialPlansSeeded();

  const planDoc = await findPlanByReference(planRef);
  if (!planDoc || !planDoc.isActive) {
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

  // User details for Razorpay checkout prefill
  const userPhone = customerPhone || req.user.phoneNumber || '';
  const userName = customerName || req.user.fullName || 'Prem Jodo User';
  const userEmail = customerEmail || req.user.email || '';

  const orderNote = `Prem Jodo ${planDoc.name} (${billingCycle})`;

  // Call dedicated PaymentService (Razorpay)
  const rzpOrderResult = await paymentService.createOrder({
    orderAmount: amountInRupees,
    orderCurrency: 'INR',
    receipt,
    notes: {
      userId: userId.toString(),
      userEmail,
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
    plan: planDoc.slug,
    billingCycle,
    status: PAYMENT_STATUS.CREATED,
    receipt,
    notes: {
      userEmail,
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
    boostsRemaining: perks.profileBoostPerMonth || 0,
    superLikesRemaining: perks.superLikesPerWeek || 0
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
  const { reason, note } = req.body || {};

  const user = await User.findById(userId);
  if (!user || !user.subscription || user.subscription.status !== SUBSCRIPTION_STATUS.ACTIVE) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'No active subscription found to cancel');
  }

  // Find the captured payment associated with this user
  const payment = await Payment.findOne({
    user: userId,
    status: PAYMENT_STATUS.CAPTURED
  }).sort({ createdAt: -1 });

  // Determine activation timestamp and elapsed duration
  const activationDate = payment?.createdAt || user.subscription.startDate || new Date();
  const elapsedMs = Date.now() - new Date(activationDate).getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  const isEligibleForRefund = elapsedHours <= REFUND_POLICY.MAX_REFUND_HOURS; // 48 hours

  const uStr = userId.toString();

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
    user.subscription.superLikesRemaining = 0;
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
    const paymentMethod = paymentEntity.method || 'Razorpay';

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
                boostsRemaining: perks.profileBoostPerMonth || 0,
                superLikesRemaining: perks.superLikesPerWeek || 0
              }
            }
          });

          // Invalidate Redis Caches
          const uStr = payment.user.toString();
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
