import { User } from '../users/user.model.js';
import { AppError } from '../../shared/utils/AppError.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { verifyAccessToken } from './token.service.js';

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.accessToken;
  if (!token) throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');

  const payload = verifyAccessToken(token);
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active') throw new AppError('Invalid session', 401, 'INVALID_SESSION');
  req.user = user;
  next();
});

export const authorize = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new AppError('Authentication required', 401, 'AUTH_REQUIRED'));
  if (!roles.includes(req.user.role)) return next(new AppError('Forbidden', 403, 'FORBIDDEN'));
  return next();
};
