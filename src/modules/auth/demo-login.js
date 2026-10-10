import crypto from 'crypto';
import { AppError } from '../../shared/utils/AppError.js';
import { env } from '../../config/env.js';
import { OTP_CHANNEL, OTP_PURPOSE } from './otp.constants.js';

export const DEMO_LOGIN_PHONE = '+919999999999';
export const DEMO_LOGIN_OTP = '123456';
export const DEMO_LOGIN_USER_ID = crypto.createHash('sha256').update('7hevenkart:demo-customer:v1').digest('hex').slice(0, 24);
const DEMO_OTP_IDENTITY = `demo:${DEMO_LOGIN_PHONE}`;

export function demoLoginRequested(phone, demo, enabled = env.DEMO_LOGIN_ENABLED) {
  return demo === true && enabled && phone === DEMO_LOGIN_PHONE;
}

export function demoOtpIdentity(phone, demo) {
  return demo ? DEMO_OTP_IDENTITY : phone;
}

export function demoOtpFor(payload, enabled = env.DEMO_LOGIN_ENABLED) {
  return enabled
    && payload.purpose === OTP_PURPOSE.LOGIN
    && payload.channel === OTP_CHANNEL.WHATSAPP
    && payload.userId === DEMO_OTP_IDENTITY
    && payload.recipient === DEMO_LOGIN_PHONE
    ? DEMO_LOGIN_OTP
    : null;
}

export function requireNonDemoCustomer(req, _res, next) {
  if (req.user?.demoAccount) return next(new AppError('The demo account is for browsing only.', 403, 'DEMO_READ_ONLY'));
  return next();
}
