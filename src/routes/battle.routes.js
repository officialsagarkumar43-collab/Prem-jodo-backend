import { Router } from 'express';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import {
  getWalletDetails,
  addMoneyToWallet,
  withdrawMoneyFromWallet,
  generateRoomCode,
  createCustomRoom,
  joinRoomByCode,
  getRoomDetails,
  getOpenRooms,
  getLiveAutoMatch,
  getLeaderboard,
  getBattleHistory,
  forfeitRoom,
  cancelBattleRoom,
  canCreateBattle
} from '../controllers/battle.controller.js';

const router = Router();

// Public / Semi-public
router.get('/leaderboard', getLeaderboard);

// Protected routes (Require Authentication)
router.use(verifyJWT);

// Battle Creation Eligibility Check
router.get('/can-create-battle', canCreateBattle);


// Wallet Endpoints
router.get('/wallet', getWalletDetails);
router.post('/wallet/add-money', addMoneyToWallet);
router.post('/wallet/withdraw', withdrawMoneyFromWallet);

// Live AutoMatch Dedicated Endpoints
router.get('/live-automatch', getLiveAutoMatch);
router.get('/live_automatch', getLiveAutoMatch);

// Room & Match Endpoints (Custom Room Code)
router.get('/rooms', getOpenRooms);
router.get('/rooms/generate-code', generateRoomCode);
router.post('/rooms/generate-code', generateRoomCode);
router.post('/rooms/create', createCustomRoom);
router.post('/rooms/join', joinRoomByCode);
router.post('/rooms/cancel', cancelBattleRoom);
router.post('/cancel', cancelBattleRoom);
router.get('/rooms/:roomId', getRoomDetails);
router.post('/rooms/:roomId/forfeit', forfeitRoom);
router.post('/rooms/:roomId/leave', forfeitRoom);
router.post('/rooms/:roomId/cancel', cancelBattleRoom);
router.delete('/rooms/:roomId', cancelBattleRoom);

// Match History
router.get('/history', getBattleHistory);

export default router;
