import { Router } from 'express';
import {
  getMembershipPlans,
  getMembershipAddons,
  getMySubscription,
  createMembershipOrder,
  verifyMembershipPayment,
  activateProfileBoost,
  cancelSubscription,
  handleRazorpayWebhook,
  getAllPlansAdmin,
  createPlanAdmin,
  updatePlanAdmin,
  deletePlanAdmin,
  getAllAddonsAdmin,
  createAddonAdmin,
  updateAddonAdmin,
  deleteAddonAdmin
} from '../controllers/membership.controller.js';
import { verifyJWT, verifyAdmin } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  createOrderSchema,
  verifyPaymentSchema,
  cancelSubscriptionSchema,
  createPlanAdminSchema,
  updatePlanAdminSchema,
  createAddonAdminSchema,
  updateAddonAdminSchema
} from '../validations/membership.validation.js';

const router = Router();

// ==========================================
// Public Routes
// ==========================================
router.get('/plans', getMembershipPlans);
router.get('/addons', getMembershipAddons);
router.post('/webhook', handleRazorpayWebhook);
router.post('/razorpay/webhook', handleRazorpayWebhook);

// ==========================================
// Protected User Routes (Require Authentication)
// ==========================================
router.use(verifyJWT);

router.get('/my-subscription', getMySubscription);
router.post('/create-order', validate(createOrderSchema), createMembershipOrder);
router.post('/verify-payment', validate(verifyPaymentSchema), verifyMembershipPayment);
router.post('/activate-boost', activateProfileBoost);
router.post('/cancel', validate(cancelSubscriptionSchema), cancelSubscription);

// ==========================================
// Admin Routes (Require Admin Role)
// ==========================================
// Plans Management
router.get('/admin/plans', verifyAdmin, getAllPlansAdmin);
router.post('/admin/plans', verifyAdmin, validate(createPlanAdminSchema), createPlanAdmin);
router.put('/admin/plans/:id', verifyAdmin, validate(updatePlanAdminSchema), updatePlanAdmin);
router.patch('/admin/plans/:id', verifyAdmin, validate(updatePlanAdminSchema), updatePlanAdmin);
router.delete('/admin/plans/:id', verifyAdmin, deletePlanAdmin);

// Addons Management
router.get('/admin/addons', verifyAdmin, getAllAddonsAdmin);
router.post('/admin/addons', verifyAdmin, validate(createAddonAdminSchema), createAddonAdmin);
router.put('/admin/addons/:id', verifyAdmin, validate(updateAddonAdminSchema), updateAddonAdmin);
router.patch('/admin/addons/:id', verifyAdmin, validate(updateAddonAdminSchema), updateAddonAdmin);
router.delete('/admin/addons/:id', verifyAdmin, deleteAddonAdmin);

export default router;

