import { Router } from 'express';
import { env } from '../../config/env.js';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authRateLimiter, otpRateLimiter } from '../../shared/middlewares/rateLimiters.js';
import { loginSchema, refreshSchema, registerSchema, requestOtpSchema, verifyOtpSchema } from './auth.validation.js';
import { login, logout, refreshSession, registerCustomer, requestOtp, verifyOtp } from './auth.service.js';
import { requireAuth } from './auth.middleware.js';

export const authRoutes = Router();

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.COOKIE_SECURE,
};

function attachCookies(res, tokens) {
  res.cookie('accessToken', tokens.accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
  res.cookie('refreshToken', tokens.refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
}

authRoutes.post('/register', authRateLimiter, validate(registerSchema), asyncHandler(async (req, res) => {
  const result = await registerCustomer(req.body);
  attachCookies(res, result);
  created(res, result, 'Customer registered');
}));

authRoutes.post('/login', authRateLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  const result = await login(req.body);
  attachCookies(res, result);
  ok(res, result, 'Logged in');
}));

authRoutes.post('/refresh', validate(refreshSchema), asyncHandler(async (req, res) => {
  const result = await refreshSession(req.body.refreshToken || req.cookies?.refreshToken);
  attachCookies(res, result);
  ok(res, result, 'Session refreshed');
}));

authRoutes.post('/otp/request', otpRateLimiter, validate(requestOtpSchema), asyncHandler(async (req, res) => {
  ok(res, await requestOtp(req.body.phone), 'OTP sent');
}));

authRoutes.post('/otp/verify', authRateLimiter, validate(verifyOtpSchema), asyncHandler(async (req, res) => {
  const result = await verifyOtp(req.body);
  attachCookies(res, result);
  ok(res, result, 'OTP verified');
}));

authRoutes.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await logout(req.user.id);
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  ok(res, null, 'Logged out');
}));
