import { z } from 'zod';

const phone = z.string().min(10).max(20);
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
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).optional(),
});

export const requestOtpSchema = z.object({
  phone: z.string().min(10).max(20),
});

export const verifyOtpSchema = z.object({
  phone: z.string().min(10).max(20),
  otp: z.string().length(6),
  name: z.string().min(2).max(80).optional(),
});
