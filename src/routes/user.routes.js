import { Router } from 'express';
import {
  upsertProfile,
  getProfileById,
  getLookingForOptions,
  getInterestOptions,
  uploadPhotos,
  reorderPhotos,
  deletePhoto
} from '../controllers/user.controller.js';
import { getWhoLikedYouFeed, getWhoLikedYouCount } from '../controllers/match.controller.js';
import { uploadFaceVerification } from '../controllers/auth.controller.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import {
  uploadSingleImage,
  uploadMultipleImages
} from '../middlewares/upload.middleware.js';

const router = Router();

// Public metadata routes (cached for 1 hour)
router.get('/looking-for-options', cacheResponse(3600), getLookingForOptions);
router.get('/interests', cacheResponse(3600), getInterestOptions);

// Protected routes
router.use(verifyJWT);

router
  .route('/profile')
  .post(upsertProfile)
  .put(upsertProfile);
router.route('/profile/:userId').get(getProfileById);

// Photo upload, reordering & deletion endpoints with Sharp image optimization
router.post('/photos', uploadMultipleImages('photos', 'photos', 6), uploadPhotos);
router.put('/photos/reorder', reorderPhotos);
router.delete('/photos', deletePhoto);

// Face verification endpoint alias under /users as well
router.post(
  '/face-verification',
  uploadSingleImage('face-verification', 'image'),
  uploadFaceVerification
);

// See who liked you endpoints alias under /users as well
router.get('/see-who-like-u/count', getWhoLikedYouCount);
router.get('/see-who-likes-u/count', getWhoLikedYouCount);
router.get('/who-liked-you/count', getWhoLikedYouCount);
router.get('/see-who-like-u', getWhoLikedYouFeed);
router.get('/see-who-likes-u', getWhoLikedYouFeed);
router.get('/see-who-liked-you', getWhoLikedYouFeed);
router.get('/who-liked-you', getWhoLikedYouFeed);

export default router;
