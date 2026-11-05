import { Router } from 'express';
import { verifyJWT, optionalJWT, verifyAdmin } from '../middlewares/auth.middleware.js';
import {
  getTicketCategories,
  createTicket,
  getMyTickets,
  getTicketById,
  replyTicket,
  getAllTicketsAdmin,
  getTicketByIdAdmin,
  replyTicketAdmin,
  updateTicketStatusAdmin
} from '../controllers/ticket.controller.js';

const router = Router();

// 1. Categories route (Public / Optional Auth)
router.get('/categories', optionalJWT, getTicketCategories);

// ==========================================
// Admin Support Ticket Management Routes (Requires verifyAdmin)
// ==========================================
router.get('/admin', verifyJWT, verifyAdmin, getAllTicketsAdmin);
router.get('/admin/:id', verifyJWT, verifyAdmin, getTicketByIdAdmin);
router.post('/admin/:id/reply', verifyJWT, verifyAdmin, replyTicketAdmin);
router.patch('/admin/:id/status', verifyJWT, verifyAdmin, updateTicketStatusAdmin);

// ==========================================
// Support Ticket Routes (Registered Members & Unregistered Guests)
// ==========================================
// Create Ticket: Login optional (works for both registered users and unregistered guests)
router.post('/', optionalJWT, createTicket);

// My Tickets: Only for logged-in users
router.get('/my-tickets', verifyJWT, getMyTickets);

// Single Ticket Thread & Reply (Login optional: registered or guest)
router.get('/:id', optionalJWT, getTicketById);
router.post('/:id/reply', optionalJWT, replyTicket);

export default router;

