import crypto from 'crypto';
import { OtpDeliveryProvider } from './otp-delivery.provider.js';

function recipientEnding(recipient) {
  const digits = String(recipient || '').replace(/\D/g, '');
  return digits.slice(-4).padStart(4, '*');
}

export class ConsoleOtpDeliveryProvider extends OtpDeliveryProvider {
  constructor({ log = console.info } = {}) {
    super('development-console');
    this.log = log;
  }

  async sendLoginOtp({ recipient, otp }) {
    this.log(`[LOCAL OTP] ${otp} (phone ending ${recipientEnding(recipient)})`);

    return {
      provider: this.name,
      providerMessageId: `local-${crypto.randomUUID()}`,
      status: 'ACCEPTED',
    };
  }
}
