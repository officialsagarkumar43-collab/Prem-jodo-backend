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

export default router;
