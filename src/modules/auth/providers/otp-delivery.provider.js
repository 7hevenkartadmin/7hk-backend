export class OtpDeliveryProviderError extends Error {
  constructor(message, { code = 'OTP_PROVIDER_ERROR', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'OtpDeliveryProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class OtpDeliveryProvider {
  constructor(name) {
    this.name = name;
  }

  async sendLoginOtp() {
    throw new OtpDeliveryProviderError('OTP delivery provider is not implemented');
  }
}
