import http from 'http';
import { app } from './src/app.js';
import connectDB from './src/config/db.js';
import { initializeRedis, disconnectRedis } from './src/config/redis.js';
import { initializeSocket } from './src/sockets/index.js';
import { ENV } from './src/config/env.js';
import dns from 'dns';

dns.setDefaultResultOrder('ipv4first');

const server = http.createServer(app);

// Initialize Socket.io
initializeSocket(server, ENV.CLIENT_URL);


// Initialize Redis Client
initializeRedis();

// Connect to Database & Start Server
connectDB()
  .then(() => {
    server.listen(ENV.PORT, () => {
      console.log(`🚀 Prem Jodo Backend Server is running at: http://localhost:${ENV.PORT}`);
      console.log(`📡 Environment: ${ENV.NODE_ENV}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server due to MongoDB connection error:', err);
    process.exit(1);
  });

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  await disconnectRedis();
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));


