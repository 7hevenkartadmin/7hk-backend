import rateLimit from 'express-rate-limit';

export const authRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Please try again later.', code: 'AUTH_RATE_LIMITED' },
});

export const otpRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Please wait before retrying.', code: 'OTP_RATE_LIMITED' },
});

export const deliveryOtpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => `${req.user?._id || 'anonymous'}:${req.params.id || 'unknown-order'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many delivery OTP attempts. Please wait before retrying.', code: 'DELIVERY_OTP_RATE_LIMITED' },
});
