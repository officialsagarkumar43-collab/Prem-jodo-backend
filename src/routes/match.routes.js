import { Router } from 'express';
import {
    swipeUser,
    getMatches,
    getDiscoveryFeed,
    getWhoLikedYouFeed,
    getWhoLikedYouCount,
    unmatchUser,
    rewindSwipe,
    getRecentMatchesAdmin,
    getMatchByIdAdmin,
    dissolveMatchAdmin
} from '../controllers/match.controller.js';
import { verifyJWT, verifyAdmin } from '../middlewares/auth.middleware.js';

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

// ==========================================
// Admin Matching Management Routes (Requires verifyAdmin, No Sockets)
// ==========================================
router.get('/admin/recent', verifyAdmin, getRecentMatchesAdmin);
router.get('/admin/matches/:id', verifyAdmin, getMatchByIdAdmin);
router.delete('/admin/matches/:id', verifyAdmin, dissolveMatchAdmin);

export default router;


