import { Router } from 'express';
import {
  getMembershipPlans,
  getMySubscription,
  createMembershipOrder,
  verifyMembershipPayment,
  cancelSubscription,
  handleRazorpayWebhook,
  getAllPlansAdmin,
  createPlanAdmin,
  updatePlanAdmin,
  deletePlanAdmin
} from '../controllers/membership.controller.js';
import { verifyJWT, verifyAdmin } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  createOrderSchema,
  verifyPaymentSchema,
  cancelSubscriptionSchema,
  createPlanAdminSchema,
  updatePlanAdminSchema
} from '../validations/membership.validation.js';

const router = Router();

// ==========================================
// Public Routes
// ==========================================
router.get('/plans', getMembershipPlans);
router.post('/webhook', handleRazorpayWebhook);
router.post('/razorpay/webhook', handleRazorpayWebhook);

// ==========================================
// Protected User Routes (Require Authentication)
// ==========================================
router.use(verifyJWT);

router.get('/my-subscription', getMySubscription);
router.post('/create-order', validate(createOrderSchema), createMembershipOrder);
router.post('/verify-payment', validate(verifyPaymentSchema), verifyMembershipPayment);
router.post('/cancel', validate(cancelSubscriptionSchema), cancelSubscription);

// ==========================================
// Admin Routes (Require Admin Role)
// ==========================================
router.get('/admin/plans', verifyAdmin, getAllPlansAdmin);
router.post('/admin/plans', verifyAdmin, validate(createPlanAdminSchema), createPlanAdmin);
router.put('/admin/plans/:id', verifyAdmin, validate(updatePlanAdminSchema), updatePlanAdmin);
router.patch('/admin/plans/:id', verifyAdmin, validate(updatePlanAdminSchema), updatePlanAdmin);
router.delete('/admin/plans/:id', verifyAdmin, deletePlanAdmin);

export default router;
