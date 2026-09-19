import { Router } from 'express';
import { swipeUser, getMatches, getDiscoveryFeed, unmatchUser } from '../controllers/match.controller.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(verifyJWT);

router.post('/swipe', swipeUser);
router.get('/list', getMatches);
router.get('/feed', getDiscoveryFeed);

// Unmatch endpoints
router.delete('/unmatch/:id', unmatchUser);
router.post('/unmatch/:id', unmatchUser);
router.post('/unmatch', unmatchUser);
router.delete('/:id', unmatchUser);

export default router;


