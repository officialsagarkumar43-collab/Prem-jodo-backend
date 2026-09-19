import mongoose from 'mongoose';
import dns from 'dns';

// Fallback to Google and Cloudflare DNS to prevent ECONNREFUSED on SRV queries
try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {
  // Ignore if already set or not supported in environment
}

const connectDB = async (retryCount = 0) => {
  const maxRetries = 5;
  try {
    const mongoUri = process.env.MONGO_URI;

    const connectionInstance = await mongoose.connect(mongoUri, {
      dbName: process.env.DB_NAME,
      autoIndex: true,
      serverSelectionTimeoutMS: 8000
    });

    console.log(`\n🍃 MongoDB Connected! DB HOST: ${connectionInstance.connection.host}`);
    console.log(`🍃 Connected to Database: ${connectionInstance.connection.name}`);
  } catch (error) {
    console.error(`MongoDB Connection Error (Attempt ${retryCount + 1}/${maxRetries}):`, error.message);
    if (retryCount < maxRetries) {
      console.log(`⏳ Retrying MongoDB connection in 3 seconds...`);
      await new Promise(res => setTimeout(res, 3000));
      return connectDB(retryCount + 1);
    }
    console.error('❌ Could not connect to MongoDB after multiple attempts. If using MongoDB Atlas, please check your internet connection and verify your IP is whitelisted in Atlas Network Access (0.0.0.0/0).');
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB connection lost. Attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
  console.log('MongoDB reconnected successfully.');
});

export default connectDB;
