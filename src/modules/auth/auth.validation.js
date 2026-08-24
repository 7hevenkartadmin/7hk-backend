import { z } from 'zod';
import { OTP_CODE_PATTERN } from './otp.constants.js';
import { INDIAN_MOBILE_PATTERN } from './phone.js';

const phone = z.string().regex(INDIAN_MOBILE_PATTERN, 'Valid Indian mobile number required');
const otp = z.string().regex(OTP_CODE_PATTERN, 'OTP must contain exactly six decimal digits');
const password = z.string().min(8).max(128);

export const registerSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email().optional(),
  phone,
  password,
});

export const loginSchema = z.object({
  identifier: z.string().min(3),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
}).strict();

export const refreshSchema = z.object({}).strict();

export const requestOtpSchema = z.object({
  phone,
});

export const verifyOtpSchema = z.object({
  phone,
  otp,
  name: z.string().min(2).max(80).optional(),
});
