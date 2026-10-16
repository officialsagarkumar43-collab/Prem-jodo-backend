import { Router } from 'express';
import {
    swipeUser,
    getMatches,
    getDiscoveryFeed,
    getWhoLikedYouFeed,
    getWhoLikedYouCount,
    unmatchUser,
    rewindSwipe
} from '../controllers/match.controller.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(verifyJWT);

router.post('/swipe', swipeUser);
router.post('/rewind', rewindSwipe);
router.get('/list', getMatches);
router.get('/feed', getDiscoveryFeed);

// See who liked you feed endpoints (same response format & functionality as /feed)
router.get('/who-liked-you/count', getWhoLikedYouCount);
router.get('/see-who-liked-you', getWhoLikedYouFeed);

// Unmatch endpoints
router.delete('/unmatch/:id', unmatchUser);
router.post('/unmatch/:id', unmatchUser);
router.post('/unmatch', unmatchUser);
router.delete('/:id', unmatchUser);

export default router;


