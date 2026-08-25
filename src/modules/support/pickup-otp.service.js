import crypto from 'crypto';
import { env } from '../../config/env.js';

export function pickupOtpForTicket(ticketOrId) {
  const id = String(ticketOrId?._id || ticketOrId?.id || ticketOrId || '');
  const digest = crypto.createHmac('sha256', env.OTP_HMAC_SECRET)
    .update(`support-pickup:${id}`)
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function matchesPickupOtp(ticketOrId, otp) {
  if (!/^\d{6}$/.test(String(otp || ''))) return false;
  const expected = Buffer.from(pickupOtpForTicket(ticketOrId));
  const received = Buffer.from(String(otp));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
