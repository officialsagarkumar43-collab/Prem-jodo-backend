import { Router } from 'express';
import {
  sendOtp,
  verifyOtp,
  googleLogin,
  completeOnboarding,
  logoutUser,
  getCurrentUser
} from '../controllers/auth.controller.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  sendOtpSchema,
  verifyOtpSchema,
  googleLoginSchema,
  onboardingSchema
} from '../validations/auth.validation.js';

const router = Router();

// Public Authentication routes
router.post('/send-otp', validate(sendOtpSchema), sendOtp);
router.post('/verify-otp', validate(verifyOtpSchema), verifyOtp);
router.post('/google', validate(googleLoginSchema), googleLogin);

// Protected routes
router.post('/onboarding', verifyJWT, validate(onboardingSchema), completeOnboarding);
router.post('/logout', verifyJWT, logoutUser);
router.get('/me', verifyJWT, getCurrentUser);

export default router;
