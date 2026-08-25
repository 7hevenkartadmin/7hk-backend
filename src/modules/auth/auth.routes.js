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
import { AppError } from '../../shared/utils/AppError.js';
import {
  accessCookieName,
  authContextForRole,
  refreshCookieName,
} from './auth.cookies.js';
import { isAndroidRequest, requestClientPlatform } from '../../shared/middlewares/clientPlatform.js';

export const authRoutes = Router();

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.COOKIE_SECURE,
};

const refreshCookiePath = `/api/${env.API_VERSION}/auth`;

export function attachCookies(res, tokens, currentTimeMs = Date.now(), role = 'customer') {
  const accessMaxAge = tokenLifetimeMs(tokens.accessToken, currentTimeMs);
  const refreshMaxAge = tokenLifetimeMs(tokens.refreshToken, currentTimeMs);
  const authContext = authContextForRole(role);

  res.cookie(accessCookieName(authContext), tokens.accessToken, {
    ...cookieOptions,
    path: '/',
    maxAge: accessMaxAge,
  });
  res.cookie(refreshCookieName(authContext), tokens.refreshToken, {
    ...cookieOptions,
    path: refreshCookiePath,
    maxAge: refreshMaxAge,
  });
}

function sendSession(req, res, result, message, statusCode = 200) {
  const android = isAndroidRequest(req);
  if (!android) attachCookies(res, result.tokens, Date.now(), result.user.role);
  return ok(res, {
    user: result.user,
    ...(android ? { tokens: result.tokens } : {}),
  }, message, statusCode);
}

authRoutes.post('/register', authRateLimiter, validate(registerSchema), asyncHandler(async (req, res) => {
  const result = await registerCustomer(req.body, requestClientPlatform(req));
  sendSession(req, res, result, 'Customer registered', 201);
}));

authRoutes.post('/otp/resend', otpRateLimiter, validate(requestOtpSchema), asyncHandler(async (req, res) => {
  ok(
    res,
    await resendOtp(req.body.phone, crypto.randomUUID()),
    'A replacement OTP is being sent through WhatsApp.',
  );
}));

authRoutes.post('/login', authRateLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  const result = await login(req.body, requestClientPlatform(req));
  sendSession(req, res, result, 'Logged in');
}));

async function refreshForRole(req, res, expectedRole) {
  const authorization = req.headers.authorization || '';
  const bearerRefreshToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  const result = await refreshSession(
    bearerRefreshToken || req.cookies?.[refreshCookieName(expectedRole)],
    requestClientPlatform(req),
  );
  const validRole = expectedRole === 'customer'
    ? result.user.role === 'customer'
    : expectedRole === 'owner'
      ? result.user.role === 'owner'
      : ['admin', 'manager', 'support'].includes(result.user.role);
  if (!validRole) throw new AppError('Refresh token role does not match this application', 403, 'FORBIDDEN');
  sendSession(req, res, result, 'Session refreshed');
}

authRoutes.post('/refresh/customer', authRateLimiter, validate(refreshSchema), asyncHandler((req, res) => refreshForRole(req, res, 'customer')));
authRoutes.post('/refresh/admin', authRateLimiter, validate(refreshSchema), asyncHandler((req, res) => refreshForRole(req, res, 'admin')));
authRoutes.post('/refresh/owner', authRateLimiter, validate(refreshSchema), asyncHandler((req, res) => refreshForRole(req, res, 'owner')));

authRoutes.post('/otp/request', otpRateLimiter, validate(requestOtpSchema), asyncHandler(async (req, res) => {
  ok(
    res,
    await requestOtp(req.body.phone, crypto.randomUUID()),
    'If this number can receive WhatsApp messages, an OTP will arrive shortly.',
  );
}));

authRoutes.post('/otp/verify', authRateLimiter, validate(verifyOtpSchema), asyncHandler(async (req, res) => {
  const result = await verifyOtp({ ...req.body, clientPlatform: requestClientPlatform(req) });
  sendSession(req, res, result, 'OTP verified');
}));

authRoutes.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await logout(req.user.id);
  const authContext = req.authContext || authContextForRole(req.user.role);
  res.clearCookie(accessCookieName(authContext), { ...cookieOptions, path: '/' });
  res.clearCookie(refreshCookieName(authContext), { ...cookieOptions, path: refreshCookiePath });
  ok(res, null, 'Logged out');
}));
