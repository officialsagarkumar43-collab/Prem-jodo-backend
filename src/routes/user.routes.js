import { Router } from 'express';
import {
  upsertProfile,
  getProfileById,
  getLookingForOptions,
  getInterestOptions
} from '../controllers/user.controller.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';

const router = Router();

// Public metadata routes (cached for 1 hour)
router.get('/looking-for-options', cacheResponse(3600), getLookingForOptions);
router.get('/interests', cacheResponse(3600), getInterestOptions);


// Protected routes
router.use(verifyJWT);

router.route('/profile').post(upsertProfile).put(upsertProfile);
router.route('/profile/:userId').get(getProfileById);

export default router;
