import { Router } from 'express';
import {
  sendOtp,
  verifyOtp,
  googleLogin,
  completeOnboarding,
  logoutUser,
  getCurrentUser,
  uploadFaceVerification,
  adminLogin,
  changePassword,
  updateAdminProfile
} from '../controllers/auth.controller.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { uploadSingleImage, uploadProfileMedia } from '../middlewares/upload.middleware.js';
import {
  sendOtpSchema,
  verifyOtpSchema,
  googleLoginSchema,
  onboardingSchema,
  adminLoginSchema,
  changePasswordSchema,
  updateAdminProfileSchema
} from '../validations/auth.validation.js';

const router = Router();

// Public Authentication routes
router.post('/send-otp', validate(sendOtpSchema), sendOtp);
router.post('/verify-otp', validate(verifyOtpSchema), verifyOtp);
router.post('/google', validate(googleLoginSchema), googleLogin);
router.post('/admin-login', validate(adminLoginSchema), adminLogin);

// Protected routes
router.post(
  '/face-verification',
  verifyJWT,
  uploadSingleImage('face-verification', 'image'),
  uploadFaceVerification
);
router.post(
  '/onboarding',
  verifyJWT,
  uploadProfileMedia('profiles'),
  validate(onboardingSchema),
  completeOnboarding
);
router.post('/admin/change-password', verifyJWT, validate(changePasswordSchema), changePassword);
router.put('/admin/update-profile', verifyJWT, validate(updateAdminProfileSchema), updateAdminProfile);
router.patch('/admin/update-profile', verifyJWT, validate(updateAdminProfileSchema), updateAdminProfile);
router.post('/admin/update-profile', verifyJWT, validate(updateAdminProfileSchema), updateAdminProfile);
router.put('/admin/profile', verifyJWT, validate(updateAdminProfileSchema), updateAdminProfile);
router.patch('/admin/profile', verifyJWT, validate(updateAdminProfileSchema), updateAdminProfile);
router.post('/admin/profile', verifyJWT, validate(updateAdminProfileSchema), updateAdminProfile);
router.post('/logout', verifyJWT, logoutUser);
router.get('/me', verifyJWT, getCurrentUser);

export default router;
