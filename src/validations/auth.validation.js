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

export const adminLoginSchema = z.object({
  body: z
    .object({
      email: z.string().email('Please enter a valid email address'),
      password: z.string().min(1, 'Password is required').optional(),
      otp: z.string().min(4, 'OTP must be at least 4 digits').optional()
    })
    .refine((data) => data.password || data.otp, {
      message: 'Either password or OTP is required for login'
    })
});

export const changePasswordSchema = z.object({
  body: z
    .object({
      fullName: z.string().optional(),
      name: z.string().optional(),
      currentPassword: z.string().min(1, 'Current password is required').optional(),
      oldPassword: z.string().min(1, 'Current password is required').optional(),
      newPassword: z.string().min(6, 'New password must be at least 6 characters').optional(),
      password: z.string().min(6, 'New password must be at least 6 characters').optional(),
      confirmPassword: z.string().optional(),
      confirmNewPassword: z.string().optional()
    })
    .refine((data) => data.currentPassword || data.oldPassword, {
      message: 'Current password is required'
    })
    .refine((data) => data.newPassword || data.password, {
      message: 'New password is required (minimum 6 characters)'
    })
    .refine(
      (data) => {
        const cur = data.currentPassword || data.oldPassword;
        const nxt = data.newPassword || data.password;
        return cur !== nxt;
      },
      {
        message: 'New password cannot be the same as current password'
      }
    )
    .refine(
      (data) => {
        const nxt = data.newPassword || data.password;
        const conf = data.confirmPassword || data.confirmNewPassword;
        if (conf) {
          return conf === nxt;
        }
        return true;
      },
      {
        message: 'Confirm password does not match new password'
      }
    )
});

export const updateAdminProfileSchema = z.object({
  body: z
    .object({
      fullName: z.string().min(1, 'Full name cannot be empty').optional(),
      name: z.string().min(1, 'Full name cannot be empty').optional(),
      phoneNumber: z.string().optional(),
      phone: z.string().optional()
    })
    .refine((data) => data.fullName || data.name || data.phoneNumber || data.phone, {
      message: 'At least one field (fullName or phoneNumber) must be provided'
    })
});



