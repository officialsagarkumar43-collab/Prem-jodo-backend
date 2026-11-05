import dotenv from 'dotenv';
dotenv.config();
import connectDB from './src/config/db.js';
import { Match } from './src/models/Match.js';
import { MATCH_STATUS } from './src/constants/index.js';

await connectDB();
const filter = {
  status: MATCH_STATUS.ACCEPTED,
  isMutualMatch: true,
  $expr: { $lt: ['$sender', '$receiver'] }
};
const count = await Match.countDocuments(filter);
const matches = await Match.find(filter).populate('sender', 'fullName email').populate('receiver', 'fullName email').lean();
console.log('Total count:', count);
console.log('Matches length:', matches.length);
matches.forEach(m => {
  console.log('ID:', m._id, 'sender:', m.sender, 'receiver:', m.receiver);
});
process.exit(0);

