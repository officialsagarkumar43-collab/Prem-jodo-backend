import { Router } from 'express';
import { verifyJWT, verifyAdmin } from '../middlewares/auth.middleware.js';
import {
  getAdminDashboardOverview,
  getUserStatusCountAdmin
} from '../controllers/dashboard.controller.js';

const router = Router();

// Protect all dashboard routes with JWT and Admin privilege verification
router.use(verifyJWT, verifyAdmin);

/**
 * @route   GET /api/v1/dashboard
 * @route   GET /api/v1/dashboard/overview
 * @desc    Get complete admin dashboard analytics (Top metrics, Trajectory chart, Revenue chart, Demographics, User status)
 * @access  Admin, Owner
 */
router.get('/', getAdminDashboardOverview);
router.get('/overview', getAdminDashboardOverview);

/**
 * @route   GET /api/v1/dashboard/user-status
 * @route   GET /api/v1/dashboard/online-users
 * @desc    Get real-time online/offline user counts for admin
 * @access  Admin, Owner
 */
router.get('/user-status', getUserStatusCountAdmin);
router.get('/online-users', getUserStatusCountAdmin);

export default router;

