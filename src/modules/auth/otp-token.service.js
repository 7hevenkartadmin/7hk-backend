import crypto from 'crypto';

export class OtpTokenService {
  constructor(secret) {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new TypeError('OTP_HMAC_SECRET must contain at least 32 characters');
    }
    this.secret = secret;
  }

  generate(length = 6) {
    const min = 10 ** (length - 1);
    const max = 10 ** length;
    return crypto.randomInt(min, max).toString();
  }

  hash(otp, identity) {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`otp:${identity}:${String(otp)}`)
      .digest('hex');
  }

  identity(value) {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`identity:${String(value)}`)
      .digest('hex');
  }
}
