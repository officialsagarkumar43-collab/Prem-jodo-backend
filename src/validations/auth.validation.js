import { z } from 'zod';

export const sendOtpSchema = z.object({
  body: z.object({
    email: z.string().email('Please enter a valid email address')
  })
});

export const verifyOtpSchema = z.object({
  body: z.object({
    email: z.string().email('Please enter a valid email address'),
    otp: z.string().min(4, 'OTP must be at least 4 digits')
  })
});

export const onboardingSchema = z.object({
  body: z.object({
    fullName: z.string().min(1, 'Full name is required'),
    gender: z.string().min(1, 'Gender is required'),
    birthday: z
      .union([
        z.string(),
        z.object({
          month: z.union([z.number(), z.string()]).optional(),
          day: z.union([z.number(), z.string()]).optional(),
          year: z.union([z.number(), z.string()]).optional()
        })
      ])
      .optional(),
    dateOfBirth: z.union([z.string(), z.date()]).optional(),
    showGenderOnProfile: z.union([z.boolean(), z.string()]).optional(),
    interestedIn: z.union([z.array(z.string()), z.string()]).optional(),
    interests: z.union([z.array(z.string()), z.string()]).optional(),
    lookingFor: z.string().optional(),
    religion: z.string().optional(),
    education: z.string().optional(),
    photos: z.union([z.array(z.any()), z.string()]).optional(),
    bio: z.string().optional(),
    aboutMe: z.string().optional()
  })
});

export const googleLoginSchema = z.object({
  body: z
    .object({
      email: z.string().email('Please enter a valid email address').optional(),
      idToken: z.string().optional(),
      credential: z.string().optional(),
      token: z.string().optional(),
      fullName: z.string().optional(),
      photo: z.string().optional(),
      googleId: z.string().optional()
    })
    .refine((data) => data.email || data.idToken || data.credential || data.token, {
      message: 'Either email or Google token (idToken / credential) is required'
    })
});
