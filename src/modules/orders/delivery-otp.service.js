import crypto from 'crypto';
import { env } from '../../config/env.js';

function orderIdentity(orderOrId) {
  return String(orderOrId?._id || orderOrId?.id || orderOrId);
}

export function deliveryOtpForOrder(orderOrId) {
  const digest = crypto.createHmac('sha256', env.OTP_HMAC_SECRET)
    .update(`delivery-otp:${orderIdentity(orderOrId)}`)
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function matchesDeliveryOtp(orderOrId, candidate) {
  const expected = Buffer.from(deliveryOtpForOrder(orderOrId));
  const supplied = Buffer.from(String(candidate || ''));
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
