import mongoose from 'mongoose';
import connectDB from '../src/config/db.js';
import { User } from '../src/models/User.js';
import { USER_ROLES } from '../src/constants/index.js';
import dotenv from 'dotenv';
dotenv.config();

const run = async () => {
  const args = process.argv.slice(2);
  const email = args[0] || 'owner@premjodo.com';
  const password = args[1] || 'Owner@123456';
  const roleInput = (args[2] || USER_ROLES.OWNER).toLowerCase();
  const fullName = args[3] || (roleInput === USER_ROLES.OWNER ? 'Company Owner' : 'System Admin');

  if (![USER_ROLES.ADMIN, USER_ROLES.OWNER].includes(roleInput)) {
    console.error(`❌ Invalid role: "${roleInput}". Allowed roles are: "${USER_ROLES.ADMIN}", "${USER_ROLES.OWNER}"`);
    process.exit(1);
  }

  console.log(`Connecting to database...`);
  await connectDB();

  try {
    const normalizedEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail }).select('+password');

    if (user) {
      console.log(`Found existing user with email: ${normalizedEmail}`);
      user.fullName = fullName || user.fullName;
      user.password = password; // Will be hashed via pre-save hook
      user.role = roleInput;
      user.isActive = true;
      user.isVerified = true;
      await user.save();
      console.log(`✅ Successfully updated user "${normalizedEmail}" to role: "${roleInput}"!`);
    } else {
      console.log(`Creating new ${roleInput} account for: ${normalizedEmail}...`);
      user = new User({
        fullName,
        email: normalizedEmail,
        password, // Will be hashed via pre-save hook
        role: roleInput,
        isActive: true,
        isVerified: true,
        isOnboarded: true
      });
      await user.save();
      console.log(`✅ Successfully created new ${roleInput} account!`);
    }

    console.log(`\n==========================================`);
    console.log(`Credentials:`);
    console.log(`Email:    ${normalizedEmail}`);
    console.log(`Password: ${password}`);
    console.log(`Role:     ${roleInput}`);
    console.log(`API URL:  POST /api/v1/auth/admin/login`);
    console.log(`==========================================\n`);
  } catch (err) {
    console.error('❌ Error creating/updating admin/owner:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

run();
