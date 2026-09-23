import mongoose from 'mongoose';

/**
 * Execute multiple database operations inside a MongoDB Mongoose transaction session.
 * Automatically commits on success and aborts (rolls back) on error.
 * Gracefully handles standalone MongoDB setups where replica set transactions aren't supported.
 *
 * @param {Function} callback - Async function that receives (session) and performs DB operations
 * @returns {Promise<any>} - Result returned by the callback
 */
export const runInTransaction = async (callback) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await callback(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    // If standalone MongoDB instance without replica set, retry without session transaction
    if (
      error?.message?.includes('Transactions are not supported') ||
      error?.message?.includes('replica set') ||
      error?.code === 20
    ) {
      console.warn('[runInTransaction] Transactions not supported on this MongoDB instance. Running directly.');
      return await callback(null);
    }
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};
