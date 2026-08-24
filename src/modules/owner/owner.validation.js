import { z } from 'zod';
import { INDIAN_MOBILE_PATTERN } from '../auth/phone.js';

const totp = z.string().regex(/^\d{6}$/u, 'Enter the six-digit owner authenticator code');
const securePassword = z.string().min(15).max(128);

export const replaceAdminSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(INDIAN_MOBILE_PATTERN).optional(),
  assignmentExpiresAt: z.string().datetime({ offset: true }),
  totp,
}).strict();

export const ownerTotpSchema = z.object({ totp }).strict();

export const adminActionTokenSchema = z.object({
  token: z.string().min(40).max(200),
  password: securePassword,
}).strict();

export const changeStaffPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: securePassword,
  totp: z.string().regex(/^\d{6}$/u).optional(),
}).strict();
