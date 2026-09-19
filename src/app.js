import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import rootRouter from './routes/index.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { ApiError } from './utils/ApiError.js';
import { ENV } from './config/env.js';
import { getRedisStatus } from './config/redis.js';


const app = express();

// Security Middlewares
app.use(helmet());

// Dynamic CORS configuration for local dev and production
const allowedOrigins = [
  ENV.CLIENT_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://192.168.0.21:3000',
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, postman)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive in development
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  })
);

// Global Rate Limiter (Disabled in development for unlimited requests)
if (ENV.NODE_ENV === 'production') {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10000, // Generous limit in production
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      statusCode: 429,
      message: 'Too many requests from this IP, please try again after 15 minutes.'
    }
  });
  app.use('/api', limiter);
}

// Request Parsing & Logging
app.use(
  express.json({
    limit: '16kb',
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);
app.use(express.urlencoded({ extended: true, limit: '16kb' }));
app.use(cookieParser());
app.use(morgan(ENV.NODE_ENV === 'development' ? 'dev' : 'combined'));

// Static files (Uploads preview)
app.use('/uploads', express.static('uploads'));

// Health check endpoint
app.get('/health', (req, res) => {

  const redis = getRedisStatus();
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Prem Jodo Backend Service',
    redis: {
      enabled: redis.enabled,
      connected: redis.ready,
      status: redis.status
    }
  });
});


// API Root Route
app.use('/api/v1', rootRouter);

// 404 Route Handler
app.use((req, res, next) => {
  next(new ApiError(404, `Route ${req.originalUrl} not found`));
});

// Centralized Error Handling Middleware
app.use(errorHandler);

export { app };
