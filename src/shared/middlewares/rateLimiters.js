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

export const paymentRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => String(req.user?._id || 'anonymous'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment requests. Please wait before retrying.', code: 'PAYMENT_RATE_LIMITED' },
});

export const paymentCreationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  keyGenerator: (req) => String(req.user?._id || 'anonymous'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment checkouts. Resume an existing session or wait before trying again.', code: 'PAYMENT_SESSION_RATE_LIMITED' },
});

export const restrictedProductConsentRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.user?._id || 'anonymous'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many restricted-product acknowledgement attempts. Please wait before retrying.', code: 'RESTRICTED_PRODUCT_CONSENT_RATE_LIMITED' },
});

export const customerOrderActionRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.user?._id || 'anonymous'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many order actions. Please wait before trying again.', code: 'ORDER_ACTION_RATE_LIMITED' },
});

export const supportTicketRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.user?._id || 'anonymous'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many support requests. Please try again later.', code: 'SUPPORT_RATE_LIMITED' },
});

export const supportPickupOtpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => `${req.user?._id || 'anonymous'}:${req.params.id || 'unknown-ticket'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many pickup OTP attempts. Please wait before retrying.', code: 'PICKUP_OTP_RATE_LIMITED' },
});

export const ownerSecurityRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.user?._id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many security actions. Please wait before trying again.', code: 'OWNER_SECURITY_RATE_LIMITED' },
});

export const adminActionTokenRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many account setup attempts. Please wait before trying again.', code: 'ADMIN_ACTION_RATE_LIMITED' },
});
