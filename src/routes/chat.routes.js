import { Router } from 'express';
import {
  getConversations,
  getOrCreateConversation,
  getMessages,
  sendMessage,
  markMessagesAsRead,
  getAgoraToken,
  clearConversationMessages
} from '../controllers/chat.controller.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(verifyJWT);

// Agora RTC Token for Voice / Video Calls
router.get('/agora-token', getAgoraToken);
router.post('/agora-token', getAgoraToken);
router.get('/agora/token', getAgoraToken);
router.post('/agora/token', getAgoraToken);

// Conversations endpoints
router.get('/conversations', getConversations);
router.post('/conversations', getOrCreateConversation);

// Messages endpoints
router.get('/conversations/:conversationId/messages', getMessages);
router.post('/conversations/:conversationId/messages', sendMessage);
router.delete('/conversations/:conversationId/messages', clearConversationMessages);
router.delete('/conversations/:conversationId/clear', clearConversationMessages);
router.post('/conversations/:conversationId/clear', clearConversationMessages);
router.patch('/conversations/:conversationId/read', markMessagesAsRead);

router.get('/:conversationId/messages', getMessages);
router.post('/:conversationId/messages', sendMessage);
router.delete('/:conversationId/messages', clearConversationMessages);
router.delete('/:conversationId/clear', clearConversationMessages);
router.post('/:conversationId/clear', clearConversationMessages);
router.patch('/:conversationId/read', markMessagesAsRead);

export default router;
