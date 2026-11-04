import { z } from 'zod';
import { USER_ROLES, MEMBERSHIP_TIERS } from '../constants/index.js';

export const createUserAdminSchema = z.object({
  body: z.object({
    email: z
      .string({ required_error: 'Email is required' })
      .email('Please provide a valid email address'),
    fullName: z.string().optional().default(''),
    phoneNumber: z.string().optional(),
    password: z.string().min(6, 'Password must be at least 6 characters').optional(),
    role: z.enum(Object.values(USER_ROLES)).optional().default(USER_ROLES.USER),
    isActive: z.boolean().optional().default(true),
    isVerified: z.boolean().optional().default(true),
    isFaceVerification: z.boolean().optional().default(false),
    isOnboarded: z.boolean().optional().default(false),
    subscriptionPlan: z.enum(Object.values(MEMBERSHIP_TIERS)).optional().default(MEMBERSHIP_TIERS.FREE),
    // Profile details (optional)
    gender: z.enum(['male', 'female', 'other']).optional(),
    bio: z.string().max(500).optional().default(''),
    lookingFor: z.string().optional(),
    interestedIn: z.union([z.array(z.string()), z.string()]).optional(),
    birthday: z
      .object({
        month: z.number().optional(),
        day: z.number().optional(),
        year: z.number().optional()
      })
      .optional(),
    dateOfBirth: z.union([z.string(), z.date()]).optional(),
    religion: z.string().optional(),
    education: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional().default('India')
  })
});

export const updateUserAdminSchema = z.object({
  body: z.object({
    fullName: z.string().optional(),
    email: z.string().email('Please provide a valid email address').optional(),
    phoneNumber: z.string().optional(),
    password: z.string().min(6, 'Password must be at least 6 characters').optional(),
    role: z.enum(Object.values(USER_ROLES)).optional(),
    isActive: z.boolean().optional(),
    isVerified: z.boolean().optional(),
    isFaceVerification: z.boolean().optional(),
    isOnboarded: z.boolean().optional(),
    subscriptionPlan: z.enum(Object.values(MEMBERSHIP_TIERS)).optional(),
    subscriptionStatus: z.string().optional(),
    // Profile details
    gender: z.enum(['male', 'female', 'other']).optional(),
    bio: z.string().max(500).optional(),
    lookingFor: z.string().optional(),
    interestedIn: z.union([z.array(z.string()), z.string()]).optional(),
    birthday: z
      .object({
        month: z.number().optional(),
        day: z.number().optional(),
        year: z.number().optional()
      })
      .optional(),
    dateOfBirth: z.union([z.string(), z.date()]).optional(),
    religion: z.string().optional(),
    education: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional()
  })
});

