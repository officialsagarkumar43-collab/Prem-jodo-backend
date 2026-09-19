# Prem Jodo Backend 💍❤️

Backend API service for **Prem Jodo** (Matchmaking, Matrimony, and Dating Platform) built with **Node.js, Express, MongoDB (Mongoose), and Socket.IO**.

---

## 📁 Folder Structure

```
premjodo-backend/
├── .env.example            # Environment variables template
├── .gitignore              # Git ignore rules
├── package.json            # Project dependencies & scripts
├── README.md               # Project documentation
├── server.js               # HTTP & Socket.IO entry point
└── src/
    ├── app.js              # Express app configuration & middleware pipeline
    ├── config/             # Database & environment configurations
    │   ├── db.js           # Mongoose MongoDB connection
    │   └── env.js          # Environment variables helper
    ├── constants/          # Application enums & constants
    │   └── index.js
    ├── controllers/        # Request handling logic
    │   ├── auth.controller.js
    │   ├── user.controller.js
    │   ├── match.controller.js
    │   └── chat.controller.js
    ├── middlewares/        # Express middlewares
    │   ├── auth.middleware.js       # JWT authentication & verification
    │   ├── error.middleware.js      # Centralized error handler
    │   ├── validate.middleware.js   # Zod request validation
    │   └── upload.middleware.js     # Multer file upload handler
    ├── models/             # Mongoose schemas & indexes
    │   ├── User.js         # Authentication, password hashing, JWT methods
    │   ├── Profile.js      # Geospatial 2dsphere location, preferences, photos
    │   ├── Match.js        # Swipes (like/pass/superlike) & mutual matches
    │   ├── Conversation.js # Chat thread metadata
    │   ├── Message.js      # Chat messages & media
    │   └── Notification.js # In-app notifications
    ├── routes/             # Express API endpoints
    │   ├── index.js        # Root v1 route aggregator
    │   ├── auth.routes.js  # /api/v1/auth
    │   ├── user.routes.js  # /api/v1/users
    │   ├── match.routes.js # /api/v1/matches
    │   └── chat.routes.js  # /api/v1/chat
    ├── sockets/            # Real-time WebSockets with Socket.IO
    │   └── index.js        # Online presence & chat events
    ├── utils/              # Helper utilities
    │   ├── ApiError.js     # Custom standardized error class
    │   ├── ApiResponse.js  # Unified JSON response wrapper
    │   └── asyncHandler.js # Async route wrapper
    └── validations/        # Zod validation schemas
        └── auth.validation.js
```

---

## 🚀 Getting Started

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [MongoDB](https://www.mongodb.com/) (Local instance or MongoDB Atlas URI)

### 2. Installation
```bash
npm install
```

### 3. Setup Environment Variables
Create a `.env` file in the root directory:
```bash
cp .env.example .env
```
Update your `.env` with your MongoDB connection string and JWT secrets.

### 4. Run Development Server
```bash
npm run dev
```

---

## 🌐 API Overview

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/health` | Server health check | No |
| `POST` | `/api/v1/auth/register` | Register a new user | No |
| `POST` | `/api/v1/auth/login` | Log in and receive JWT tokens | No |
| `POST` | `/api/v1/auth/logout` | Clear auth tokens | Yes |
| `GET` | `/api/v1/auth/me` | Fetch authenticated user & profile | Yes |
| `POST` | `/api/v1/users/profile` | Create/Update user profile & preferences | Yes |
| `GET` | `/api/v1/users/profile/:userId` | Get profile by user ID | Yes |
| `POST` | `/api/v1/matches/swipe` | Swipe on a profile (like/pass/superlike) | Yes |
| `GET` | `/api/v1/matches/list` | Get mutual matches | Yes |
| `GET` | `/api/v1/chat/conversations` | Get user conversations | Yes |
| `GET` | `/api/v1/chat/conversations/:id/messages` | Get messages in a conversation | Yes |
| `POST` | `/api/v1/chat/conversations/:id/messages` | Send a message | Yes |
