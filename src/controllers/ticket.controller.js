import mongoose from 'mongoose';
import { Ticket } from '../models/Ticket.js';
import { User } from '../models/User.js';
import { Profile } from '../models/Profile.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendTicketReplyEmail } from '../utils/sendEmail.js';
import {
  HTTP_STATUS,
  USER_ROLES,
  TICKET_STATUS,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_CONFIG
} from '../constants/index.js';

/**
 * Format category label for readable display
 */
const getCategoryLabel = (categoryKey) => {
  const found = TICKET_CATEGORY_CONFIG.find((c) => c.key === categoryKey);
  return found ? found.name : categoryKey;
};

/**
 * 1. Get Support Ticket Categories (According to UI Image 3)
 * @route GET /api/v1/tickets/categories
 */
export const getTicketCategories = asyncHandler(async (req, res) => {
  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      TICKET_CATEGORY_CONFIG,
      'Support ticket categories retrieved successfully'
    )
  );
});

/**
 * 2. Candidate / User / Guest: Create Support Ticket
 * Supports both registered logged-in users and unregistered guests
 * @route POST /api/v1/tickets
 */
export const createTicket = asyncHandler(async (req, res) => {
  const {
    category,
    description,
    attachments,
    name,
    fullName,
    email,
    phone,
    phoneNumber
  } = req.body;

  if (!category || !Object.values(TICKET_CATEGORIES).includes(category)) {
    throw new ApiError(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid category. Must be one of: ${Object.values(TICKET_CATEGORIES).join(', ')}`
    );
  }

  if (!description || !description.trim()) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Description is required');
  }

  let ticketUserId = null;
  let isGuest = true;
  let guestInfo = null;
  let senderName = 'Guest';
  let senderEmail = null;
  let senderAvatar = null;
  let senderRole = 'guest';

  // Check if logged in user
  if (req.user?._id) {
    ticketUserId = req.user._id;
    isGuest = false;
    const sender = await User.findById(req.user._id).select('fullName email avatar role').lean();
    senderName = sender?.fullName || 'User';
    senderEmail = sender?.email || null;
    senderAvatar = sender?.avatar || null;
    senderRole = sender?.role || 'user';
  } else {
    // Unregistered guest user
    const resolvedName = (fullName || name || '').trim();
    const resolvedEmail = (email || '').trim().toLowerCase();
    const resolvedPhone = (phoneNumber || phone || '').trim();

    if (!resolvedName) {
      throw new ApiError(
        HTTP_STATUS.BAD_REQUEST,
        'Name is required for unregistered users to submit a support ticket'
      );
    }

    if (!resolvedEmail) {
      throw new ApiError(
        HTTP_STATUS.BAD_REQUEST,
        'Email address is required for unregistered users so we can reply via email'
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(resolvedEmail)) {
      throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Please provide a valid email address');
    }

    isGuest = true;
    guestInfo = {
      fullName: resolvedName,
      email: resolvedEmail,
      phoneNumber: resolvedPhone || null
    };
    senderName = resolvedName;
    senderEmail = resolvedEmail;
    senderRole = 'guest';
  }

  const initialMessage = {
    sender: ticketUserId,
    senderRole,
    senderName,
    senderEmail,
    senderAvatar,
    message: description.trim(),
    attachments: Array.isArray(attachments) ? attachments : [],
    isInternalNote: false,
    createdAt: new Date()
  };

  const ticket = await Ticket.create({
    user: ticketUserId,
    isGuest,
    guestInfo,
    category,
    status: TICKET_STATUS.OPEN,
    description: description.trim(),
    messages: [initialMessage],
    lastRepliedAt: new Date(),
    lastRepliedBy: ticketUserId,
    lastRepliedByName: senderName
  });

  return res.status(HTTP_STATUS.CREATED).json(
    new ApiResponse(
      HTTP_STATUS.CREATED,
      ticket,
      isGuest
        ? 'Support ticket submitted successfully. Our team will review and reply to your email.'
        : 'Support ticket created successfully'
    )
  );
});

/**
 * 3. Candidate / User: Get My Submitted Tickets
 * @route GET /api/v1/tickets/my-tickets
 */
export const getMyTickets = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const skip = (page - 1) * limit;

  const { status, category } = req.query;

  const filter = { user: req.user._id };
  if (status && status !== 'all') {
    filter.status = status;
  }
  if (category && category !== 'all') {
    filter.category = category;
  }

  const [tickets, total] = await Promise.all([
    Ticket.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-messages.isInternalNote')
      .lean(),
    Ticket.countDocuments(filter)
  ]);

  // Clean internal notes from user view
  const sanitizedTickets = tickets.map((t) => ({
    ...t,
    categoryLabel: getCategoryLabel(t.category),
    messages: (t.messages || []).filter((m) => !m.isInternalNote)
  }));

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        tickets: sanitizedTickets,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1,
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        }
      },
      'My tickets retrieved successfully'
    )
  );
});

/**
 * 4. Candidate / User: Get Single Ticket Thread
 * @route GET /api/v1/tickets/:id
 */
export const getTicketById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  let ticket;
  if (mongoose.isValidObjectId(id)) {
    ticket = await Ticket.findById(id).lean();
  } else {
    ticket = await Ticket.findOne({ ticketId: id.toUpperCase() }).lean();
  }

  if (!ticket) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Support ticket not found');
  }

  // Regular user can only view their own ticket
  const isAdminOrOwner = [USER_ROLES.ADMIN, USER_ROLES.OWNER].includes(req.user?.role);
  if (!isAdminOrOwner && ticket.user.toString() !== req.user._id.toString()) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Access denied. You can only view your own tickets.');
  }

  // Filter out internal notes for non-admin users
  const visibleMessages = isAdminOrOwner
    ? ticket.messages || []
    : (ticket.messages || []).filter((m) => !m.isInternalNote);

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        ...ticket,
        categoryLabel: getCategoryLabel(ticket.category),
        messages: visibleMessages
      },
      'Ticket details retrieved successfully'
    )
  );
});

/**
 * 5. Candidate / User: Reply to Ticket
 * @route POST /api/v1/tickets/:id/reply
 */
export const replyTicket = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { message, attachments } = req.body;

  if (!message || !message.trim()) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Message content is required');
  }

  let ticket;
  if (mongoose.isValidObjectId(id)) {
    ticket = await Ticket.findById(id);
  } else {
    ticket = await Ticket.findOne({ ticketId: id.toUpperCase() });
  }

  if (!ticket) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Support ticket not found');
  }

  const isAdminOrOwner = [USER_ROLES.ADMIN, USER_ROLES.OWNER].includes(req.user?.role);
  if (!isAdminOrOwner && ticket.user.toString() !== req.user._id.toString()) {
    throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Access denied. You can only reply to your own tickets.');
  }

  const sender = await User.findById(req.user._id).select('fullName email avatar').lean();

  const replyMessage = {
    sender: req.user._id,
    senderRole: req.user.role || 'user',
    senderName: sender?.fullName || 'User',
    senderAvatar: sender?.avatar || null,
    message: message.trim(),
    attachments: Array.isArray(attachments) ? attachments : [],
    isInternalNote: false,
    createdAt: new Date()
  };

  ticket.messages.push(replyMessage);
  ticket.lastRepliedAt = new Date();
  ticket.lastRepliedBy = req.user._id;
  ticket.lastRepliedByName = sender?.fullName || 'User';

  // If user replies to a resolved/closed ticket, reopen it
  if (!isAdminOrOwner && [TICKET_STATUS.RESOLVED, TICKET_STATUS.CLOSED].includes(ticket.status)) {
    ticket.status = TICKET_STATUS.OPEN;
  }

  await ticket.save();

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(HTTP_STATUS.OK, ticket, 'Reply posted successfully')
  );
});

// =========================================================================
// Admin Support Ticket Management Controllers (Requires verifyAdmin)
// =========================================================================

/**
 * 6. Admin: Get All Tickets with Search, Filter & Summary Stats
 * @route GET /api/v1/tickets/admin
 */
export const getAllTicketsAdmin = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const skip = (page - 1) * limit;

  const { search, status, category, userType, isGuest } = req.query;

  const filter = {};

  if (status && status !== 'all') {
    filter.status = status;
  }

  if (category && category !== 'all') {
    filter.category = category;
  }

  // Filter separately by Registered vs Unregistered/Guest users
  if (userType === 'registered' || isGuest === 'false') {
    filter.isGuest = false;
  } else if (userType === 'guest' || userType === 'unregistered' || isGuest === 'true') {
    filter.isGuest = true;
  }

  // Search across Ticket ID, Subject, Candidate Name, or Email
  if (search && search.trim()) {
    const s = search.trim();
    const matchingUsers = await User.find({
      $or: [
        { fullName: { $regex: s, $options: 'i' } },
        { email: { $regex: s, $options: 'i' } },
        { phoneNumber: { $regex: s, $options: 'i' } }
      ]
    }).select('_id');

    const userIds = matchingUsers.map((u) => u._id);

    filter.$or = [
      { ticketId: { $regex: s, $options: 'i' } },
      { description: { $regex: s, $options: 'i' } },
      { user: { $in: userIds } },
      { 'guestInfo.fullName': { $regex: s, $options: 'i' } },
      { 'guestInfo.email': { $regex: s, $options: 'i' } },
      { 'guestInfo.phoneNumber': { $regex: s, $options: 'i' } }
    ];
  }

  // 1. Fetch tickets with pagination and candidate population
  const [tickets, total] = await Promise.all([
    Ticket.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'fullName email phoneNumber role subscription')
      .populate('resolvedBy', 'fullName email')
      .lean(),
    Ticket.countDocuments(filter)
  ]);

  // 2. Fetch candidate profiles for photos and badges
  const candidateUserIds = tickets.map((t) => t.user?._id).filter(Boolean);
  const candidateProfiles = await Profile.find({ user: { $in: candidateUserIds } })
    .select('user photos gender')
    .lean();
  const profileMap = new Map(candidateProfiles.map((p) => [p.user.toString(), p]));

  // 3. Overview Summary Stats Cards (Matching Image 2 top bar + user separation)
  const [
    allTimeRecorded,
    requiresAttention,
    underActiveInvestigation,
    successfullyClosed,
    totalRegisteredTickets,
    totalGuestTickets
  ] = await Promise.all([
    Ticket.countDocuments({}),
    Ticket.countDocuments({ status: TICKET_STATUS.OPEN }),
    Ticket.countDocuments({ status: TICKET_STATUS.IN_PROGRESS }),
    Ticket.countDocuments({
      status: { $in: [TICKET_STATUS.RESOLVED, TICKET_STATUS.CLOSED] }
    }),
    Ticket.countDocuments({ isGuest: false }),
    Ticket.countDocuments({ isGuest: true })
  ]);

  const summaryStats = {
    allTimeRecorded: {
      count: allTimeRecorded,
      label: 'All-time recorded',
      status: 'all'
    },
    requiresAttention: {
      count: requiresAttention,
      label: 'Requires attention',
      status: TICKET_STATUS.OPEN
    },
    underActiveInvestigation: {
      count: underActiveInvestigation,
      label: 'Under active investigation',
      status: TICKET_STATUS.IN_PROGRESS
    },
    successfullyClosed: {
      count: successfullyClosed,
      label: 'Successfully closed',
      status: TICKET_STATUS.RESOLVED
    },
    registeredTickets: {
      count: totalRegisteredTickets,
      label: 'Registered Member Tickets',
      userType: 'registered'
    },
    guestTickets: {
      count: totalGuestTickets,
      label: 'Unregistered Guest Tickets',
      userType: 'guest'
    }
  };

  // 4. Format tickets for table view (Matching Image 2)
  const formattedTickets = tickets.map((t) => {
    let candidateData;
    if (t.isGuest) {
      candidateData = {
        _id: null,
        fullName: t.guestInfo?.fullName || 'Guest User',
        email: t.guestInfo?.email || '',
        phoneNumber: t.guestInfo?.phoneNumber || '',
        plan: 'Unregistered User',
        photo: null,
        isGuest: true,
        candidateCode: 'GUEST'
      };
    } else {
      const candidate = t.user || {};
      const profile = profileMap.get(candidate._id ? candidate._id.toString() : '');
      const primaryPhoto =
        profile?.photos?.find((p) => p.isPrimary)?.url ||
        profile?.photos?.[0]?.url ||
        candidate.avatar ||
        null;

      const planTier = candidate.subscription?.plan || 'Free Member';

      candidateData = {
        _id: candidate._id || null,
        fullName: candidate.fullName || 'Candidate',
        email: candidate.email || '',
        phoneNumber: candidate.phoneNumber || '',
        plan: planTier,
        photo: primaryPhoto,
        isGuest: false,
        candidateCode: `USR-${(candidate._id || '').toString().slice(-4).toUpperCase()}`
      };
    }

    return {
      _id: t._id,
      ticketId: t.ticketId,
      description: t.description,
      category: t.category,
      categoryLabel: getCategoryLabel(t.category),
      status: t.status,
      isGuest: Boolean(t.isGuest),
      candidate: candidateData,
      resolvedBy: t.resolvedByName
        ? {
          _id: t.resolvedBy?._id || t.resolvedBy,
          name: t.resolvedByName
        }
        : null,
      resolvedAt: t.resolvedAt,
      messageCount: t.messages?.length || 0,
      lastRepliedAt: t.lastRepliedAt || t.updatedAt,
      lastRepliedByName: t.lastRepliedByName || null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    };
  });

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        summary: summaryStats,
        tickets: formattedTickets,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1,
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        }
      },
      'Admin tickets retrieved successfully'
    )
  );
});

/**
 * 7. Admin: Get Single Ticket Detail with Full Message Thread
 * @route GET /api/v1/tickets/admin/:id
 */
export const getTicketByIdAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  let ticket;
  if (mongoose.isValidObjectId(id)) {
    ticket = await Ticket.findById(id)
      .populate('user', 'fullName email phoneNumber role subscription avatar')
      .populate('resolvedBy', 'fullName email')
      .lean();
  } else {
    ticket = await Ticket.findOne({ ticketId: id.toUpperCase() })
      .populate('user', 'fullName email phoneNumber role subscription avatar')
      .populate('resolvedBy', 'fullName email')
      .lean();
  }

  if (!ticket) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Support ticket not found');
  }

  let candidateData;
  if (ticket.isGuest) {
    candidateData = {
      _id: null,
      fullName: ticket.guestInfo?.fullName || 'Guest User',
      email: ticket.guestInfo?.email || '',
      phoneNumber: ticket.guestInfo?.phoneNumber || '',
      plan: 'Unregistered User',
      photo: null,
      isGuest: true,
      candidateCode: 'GUEST'
    };
  } else {
    const candidate = ticket.user || {};
    const profile = await Profile.findOne({ user: candidate._id })
      .select('photos gender location')
      .lean();

    const primaryPhoto =
      profile?.photos?.find((p) => p.isPrimary)?.url ||
      profile?.photos?.[0]?.url ||
      candidate.avatar ||
      null;

    candidateData = {
      _id: candidate._id || null,
      fullName: candidate.fullName || 'Candidate',
      email: candidate.email || '',
      phoneNumber: candidate.phoneNumber || '',
      plan: candidate.subscription?.plan || 'Free Member',
      photo: primaryPhoto,
      isGuest: false,
      candidateCode: `USR-${(candidate._id || '').toString().slice(-4).toUpperCase()}`
    };
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        ...ticket,
        categoryLabel: getCategoryLabel(ticket.category),
        candidate: candidateData,
        resolvedByName: ticket.resolvedByName || (ticket.resolvedBy ? ticket.resolvedBy.fullName : null)
      },
      'Ticket details retrieved successfully'
    )
  );
});

/**
 * 8. Admin: Reply to Ticket and optionally update status
 * @route POST /api/v1/tickets/admin/:id/reply
 */
export const replyTicketAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { message, status, isInternalNote, attachments, resolutionNote } = req.body;

  if (!message || !message.trim()) {
    throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Reply message is required');
  }

  let ticket;
  if (mongoose.isValidObjectId(id)) {
    ticket = await Ticket.findById(id);
  } else {
    ticket = await Ticket.findOne({ ticketId: id.toUpperCase() });
  }

  if (!ticket) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Support ticket not found');
  }

  const adminUser = await User.findById(req.user._id).select('fullName email').lean();
  const adminName = adminUser?.fullName || 'Support Admin';

  const replyMessage = {
    sender: req.user._id,
    senderRole: req.user.role || 'admin',
    senderName: adminName,
    senderAvatar: req.user.avatar || null,
    message: message.trim(),
    attachments: Array.isArray(attachments) ? attachments : [],
    isInternalNote: Boolean(isInternalNote),
    createdAt: new Date()
  };

  ticket.messages.push(replyMessage);
  ticket.lastRepliedAt = new Date();
  ticket.lastRepliedBy = req.user._id;
  ticket.lastRepliedByName = adminName;

  // If status is passed or updated to resolved/closed, save resolver name
  if (status && Object.values(TICKET_STATUS).includes(status)) {
    ticket.status = status;
    if (status === TICKET_STATUS.RESOLVED || status === TICKET_STATUS.CLOSED) {
      ticket.resolvedBy = req.user._id;
      ticket.resolvedByName = adminName;
      ticket.resolvedAt = new Date();
      if (resolutionNote) ticket.resolutionNote = resolutionNote.trim();
    }
  }

  await ticket.save();

  // Send email to customer (Sent in BOTH cases: Registered Member and Unregistered Guest)
  if (!isInternalNote) {
    let recipientEmail = null;
    let recipientName = null;

    if (ticket.isGuest) {
      recipientEmail = ticket.guestInfo?.email;
      recipientName = ticket.guestInfo?.fullName;
    } else if (ticket.user) {
      const ticketUser = await User.findById(ticket.user).select('fullName email').lean();
      recipientEmail = ticketUser?.email;
      recipientName = ticketUser?.fullName;
    }

    if (recipientEmail) {
      sendTicketReplyEmail({
        to: recipientEmail,
        recipientName: recipientName || 'Member',
        ticketId: ticket.ticketId,
        ticketSubject: getCategoryLabel(ticket.category),
        userDescription: ticket.description,
        replyMessage: message.trim(),
        status: ticket.status
      }).catch((err) => {
        console.warn('⚠️ Could not send ticket reply email:', err.message);
      });
    }
  }

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      ticket,
      'Admin reply sent and email notification dispatched successfully'
    )
  );
});

/**
 * 9. Admin: Update Ticket Status & Save Resolver Details
 * @route PATCH /api/v1/tickets/admin/:id/status
 */
export const updateTicketStatusAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, resolutionNote } = req.body;

  if (!status || !Object.values(TICKET_STATUS).includes(status)) {
    throw new ApiError(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid status. Must be one of: ${Object.values(TICKET_STATUS).join(', ')}`
    );
  }

  let ticket;
  if (mongoose.isValidObjectId(id)) {
    ticket = await Ticket.findById(id);
  } else {
    ticket = await Ticket.findOne({ ticketId: id.toUpperCase() });
  }

  if (!ticket) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Support ticket not found');
  }

  const adminUser = await User.findById(req.user._id).select('fullName email').lean();
  const adminName = adminUser?.fullName || 'Support Admin';

  ticket.status = status;

  // Whenever ticket is marked Resolved or Closed, save resolvedBy & resolvedByName!
  if (status === TICKET_STATUS.RESOLVED || status === TICKET_STATUS.CLOSED) {
    ticket.resolvedBy = req.user._id;
    ticket.resolvedByName = adminName;
    ticket.resolvedAt = new Date();
    if (resolutionNote) ticket.resolutionNote = resolutionNote.trim();

    // Send resolution email to customer (Both registered and unregistered)
    let recipientEmail = null;
    let recipientName = null;

    if (ticket.isGuest) {
      recipientEmail = ticket.guestInfo?.email;
      recipientName = ticket.guestInfo?.fullName;
    } else if (ticket.user) {
      const ticketUser = await User.findById(ticket.user).select('fullName email').lean();
      recipientEmail = ticketUser?.email;
      recipientName = ticketUser?.fullName;
    }

    if (recipientEmail) {
      sendTicketReplyEmail({
        to: recipientEmail,
        recipientName: recipientName || 'Member',
        ticketId: ticket.ticketId,
        ticketSubject: getCategoryLabel(ticket.category),
        userDescription: ticket.description,
        replyMessage:
          resolutionNote ||
          `Your support ticket #${ticket.ticketId} has been successfully resolved. If you have any further questions, feel free to reply directly to this email.`,
        status: ticket.status
      }).catch((err) => {
        console.warn('⚠️ Could not send ticket status email:', err.message);
      });
    }
  } else {
    // If ticket is reopened to Open or In Progress
    ticket.resolvedBy = null;
    ticket.resolvedByName = null;
    ticket.resolvedAt = null;
  }

  await ticket.save();

  return res.status(HTTP_STATUS.OK).json(
    new ApiResponse(
      HTTP_STATUS.OK,
      {
        ticketId: ticket.ticketId,
        status: ticket.status,
        resolvedBy: ticket.resolvedBy,
        resolvedByName: ticket.resolvedByName,
        resolvedAt: ticket.resolvedAt
      },
      `Ticket status updated to ${status} successfully`
    )
  );
});
