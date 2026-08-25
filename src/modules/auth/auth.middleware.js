import { User } from '../users/user.model.js';
import { AppError } from '../../shared/utils/AppError.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { verifyAccessToken } from './token.service.js';
import {
  accessCookieName,
  AUTH_CONTEXT_HEADER,
  normalizeAuthContext,
} from './auth.cookies.js';
import { requestClientPlatform } from '../../shared/middlewares/clientPlatform.js';
import { env } from '../../config/env.js';

export function accessTokenForRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return { token: header.slice(7), context: 'bearer' };

  const requestedContext = normalizeAuthContext(req.headers[AUTH_CONTEXT_HEADER]);
  if (requestedContext) {
    return {
      token: req.cookies?.[accessCookieName(requestedContext)],
      context: requestedContext,
    };
  }

  // Preserve compatibility for non-browser/mobile callers and one-app browser
  // sessions. Browser clients that can hold both sessions send X-Auth-Context.
  if (req.cookies?.accessToken) return { token: req.cookies.accessToken, context: 'legacy' };
  const available = ['customer', 'admin', 'owner']
    .map((context) => ({ context, token: req.cookies?.[accessCookieName(context)] }))
    .filter(({ token }) => Boolean(token));
  if (available.length === 1) return available[0];
  return { token: null, context: null };
}

export function roleMatchesAuthContext(role, context) {
  if (context === 'customer') return role === 'customer';
  if (context === 'admin') return ['admin', 'manager', 'support'].includes(role);
  if (context === 'owner') return role === 'owner';
  return true;
}

export function userSessionIsCurrent(user, payload, context, now = new Date()) {
  return Boolean(user
    && user.status === 'active'
    && payload.tokenVersion === Number(user.tokenVersion || 0)
    && !(user.role === 'admin' && (user.staffSeat !== 'PRIMARY_ADMIN' || !user.assignmentExpiresAt || user.assignmentExpiresAt <= now))
    && !(user.role === 'owner' && user.staffSeat !== 'PRIMARY_OWNER')
    && roleMatchesAuthContext(user.role, context));
}

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const { token, context } = accessTokenForRequest(req);
  if (!token) throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');

  const payload = verifyAccessToken(token);
  const requestPlatform = requestClientPlatform(req);
  const tokenPlatform = payload.clientPlatform === 'android' ? 'android' : 'web';
  if (tokenPlatform !== requestPlatform) {
    throw new AppError('Session belongs to a different client platform', 401, 'INVALID_SESSION');
  }
  if (env.ANDROID_APP_CHECK_MODE === 'enforce'
    && context === 'bearer'
    && payload.role === 'customer'
    && !payload.clientPlatform) {
    throw new AppError('This mobile session must be renewed', 401, 'CLIENT_PLATFORM_REQUIRED');
  }
  const user = await User.findById(payload.sub);
  if (!userSessionIsCurrent(user, payload, context)) {
    throw new AppError('Invalid session', 401, 'INVALID_SESSION');
  }
  if (requestPlatform === 'android' && user.role !== 'customer') {
    throw new AppError('The Android app only supports customer accounts', 403, 'ANDROID_CUSTOMER_ONLY');
  }
  req.user = user;
  req.authContext = context;
  next();
});

export const authorize = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new AppError('Authentication required', 401, 'AUTH_REQUIRED'));
  if (!roles.includes(req.user.role)) return next(new AppError('Forbidden', 403, 'FORBIDDEN'));
  return next();
};
