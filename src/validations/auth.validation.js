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
      .object({
        month: z.number().optional(),
        day: z.number().optional(),
        year: z.number().optional()
      })
      .optional(),
    showGenderOnProfile: z.boolean().optional(),
    interestedIn: z.union([z.array(z.string()), z.string()]).optional(),
    interests: z.array(z.string()).optional(),
    lookingFor: z.string().optional(),
    religion: z.string().optional(),
    education: z.string().optional(),
    photos: z.array(z.any()).optional(),
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
      avatar: z.string().optional(),
      googleId: z.string().optional()
    })
    .refine((data) => data.email || data.idToken || data.credential || data.token, {
      message: 'Either email or Google token (idToken / credential) is required'
    })
});
