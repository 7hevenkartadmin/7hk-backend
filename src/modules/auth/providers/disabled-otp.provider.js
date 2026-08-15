import { OtpDeliveryProvider, OtpDeliveryProviderError } from './otp-delivery.provider.js';

export class DisabledOtpDeliveryProvider extends OtpDeliveryProvider {
  constructor() {
    super('disabled');
  }

  async sendLoginOtp() {
    throw new OtpDeliveryProviderError('WhatsApp OTP delivery is not configured', {
      code: 'WHATSAPP_NOT_CONFIGURED', retryable: false,
    });
  }
}
