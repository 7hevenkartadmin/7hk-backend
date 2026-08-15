import { OtpDeliveryProvider, OtpDeliveryProviderError } from './otp-delivery.provider.js';

function metaErrorCode(payload, status) {
  const providerCode = payload?.error?.code;
  return providerCode ? `META_${providerCode}` : `META_HTTP_${status}`;
}

export class MetaWhatsAppOtpProvider extends OtpDeliveryProvider {
  constructor({ accessToken, phoneNumberId, templateName, templateLanguage, graphApiVersion,
    apiBaseUrl = 'https://graph.facebook.com', timeoutMs = 10_000, fetchImpl = fetch }) {
    super('meta-whatsapp-cloud');
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.templateName = templateName;
    this.templateLanguage = templateLanguage;
    this.graphApiVersion = graphApiVersion;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async sendLoginOtp({ recipient, otp }) {
    const to = String(recipient).replace(/\D/g, '');
    const endpoint = `${this.apiBaseUrl}/${this.graphApiVersion}/${this.phoneNumberId}/messages`;
    let response;

    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: {
            name: this.templateName,
            language: { code: this.templateLanguage },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: otp }] },
              {
                type: 'button', sub_type: 'url', index: '0',
                parameters: [{ type: 'text', text: otp }],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new OtpDeliveryProviderError('WhatsApp provider is temporarily unavailable', {
        code: error?.name === 'TimeoutError' ? 'META_TIMEOUT' : 'META_NETWORK_ERROR',
        retryable: true,
        cause: error,
      });
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new OtpDeliveryProviderError('WhatsApp provider rejected the OTP message', {
        code: metaErrorCode(payload, response.status),
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const messageId = payload?.messages?.[0]?.id;
    if (!messageId) {
      throw new OtpDeliveryProviderError('WhatsApp provider returned an invalid response', {
        code: 'META_INVALID_RESPONSE', retryable: false,
      });
    }

    return { provider: this.name, providerMessageId: messageId, status: 'ACCEPTED' };
  }
}
