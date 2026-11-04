import { Router } from 'express';
import { verifyJWT, verifyAdmin } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  createUserAdmin,
  getAllUsersAdmin,
  getUserByIdAdmin,
  updateUserAdmin,
  deleteUserAdmin
} from '../controllers/user.controller.js';
import {
  createUserAdminSchema,
  updateUserAdminSchema
} from '../validations/user.validation.js';
import {
  getAllTransactionsAdmin,
  getTransactionByIdAdmin
} from '../controllers/membership.controller.js';

const router = Router();

// Protect all admin routes with JWT and Admin role check
router.use(verifyJWT, verifyAdmin);

// ==========================================
// Admin Users Management
// ==========================================
router.get('/users', getAllUsersAdmin);
router.post('/users', validate(createUserAdminSchema), createUserAdmin);
router.get('/users/:id', getUserByIdAdmin);
router.put('/users/:id', validate(updateUserAdminSchema), updateUserAdmin);
router.patch('/users/:id', validate(updateUserAdminSchema), updateUserAdmin);
router.delete('/users/:id', deleteUserAdmin);

// ==========================================
// Admin Transactions / Payments Management
// ==========================================
router.get('/transactions', getAllTransactionsAdmin);
router.get('/transactions/:id', getTransactionByIdAdmin);
router.get('/payments', getAllTransactionsAdmin);
router.get('/payments/:id', getTransactionByIdAdmin);

export default router;

