import { Router } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env.js';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authRateLimiter, otpRateLimiter } from '../../shared/middlewares/rateLimiters.js';
import { loginSchema, refreshSchema, registerSchema, requestOtpSchema, verifyOtpSchema } from './auth.validation.js';
import { login, logout, refreshSession, registerCustomer, requestOtp, resendOtp, verifyOtp } from './auth.service.js';
import { requireAuth } from './auth.middleware.js';
import { tokenLifetimeMs } from './token.service.js';

export const authRoutes = Router();

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.COOKIE_SECURE,
};

const refreshCookiePath = `/api/${env.API_VERSION}/auth`;

export function attachCookies(res, tokens, currentTimeMs = Date.now()) {
  const accessMaxAge = tokenLifetimeMs(tokens.accessToken, currentTimeMs);
  const refreshMaxAge = tokenLifetimeMs(tokens.refreshToken, currentTimeMs);

  res.cookie('accessToken', tokens.accessToken, {
    ...cookieOptions,
    path: '/',
    maxAge: accessMaxAge,
  });
  res.cookie('refreshToken', tokens.refreshToken, {
    ...cookieOptions,
    path: refreshCookiePath,
    maxAge: refreshMaxAge,
  });
}

function sendSession(res, result, message, statusCode = 200) {
  attachCookies(res, result.tokens);
  return ok(res, { user: result.user }, message, statusCode);
}

authRoutes.post('/register', authRateLimiter, validate(registerSchema), asyncHandler(async (req, res) => {
  const result = await registerCustomer(req.body);
  sendSession(res, result, 'Customer registered', 201);
}));

authRoutes.post('/otp/resend', otpRateLimiter, validate(requestOtpSchema), asyncHandler(async (req, res) => {
  ok(
    res,
    await resendOtp(req.body.phone, crypto.randomUUID()),
    'A replacement OTP is being sent through WhatsApp.',
  );
}));

authRoutes.post('/login', authRateLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  const result = await login(req.body);
  sendSession(res, result, 'Logged in');
}));

authRoutes.post('/refresh', authRateLimiter, validate(refreshSchema), asyncHandler(async (req, res) => {
  const result = await refreshSession(req.cookies?.refreshToken);
  sendSession(res, result, 'Session refreshed');
}));

authRoutes.post('/otp/request', otpRateLimiter, validate(requestOtpSchema), asyncHandler(async (req, res) => {
  ok(
    res,
    await requestOtp(req.body.phone, crypto.randomUUID()),
    'If this number can receive WhatsApp messages, an OTP will arrive shortly.',
  );
}));

authRoutes.post('/otp/verify', authRateLimiter, validate(verifyOtpSchema), asyncHandler(async (req, res) => {
  const result = await verifyOtp(req.body);
  sendSession(res, result, 'OTP verified');
}));

authRoutes.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await logout(req.user.id);
  res.clearCookie('accessToken', { ...cookieOptions, path: '/' });
  res.clearCookie('refreshToken', { ...cookieOptions, path: refreshCookiePath });
  ok(res, null, 'Logged out');
}));
