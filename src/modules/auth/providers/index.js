import { env } from '../../../config/env.js';
import { ConsoleOtpDeliveryProvider } from './console-otp.provider.js';
import { DisabledOtpDeliveryProvider } from './disabled-otp.provider.js';
import { MetaWhatsAppOtpProvider } from './meta-whatsapp.provider.js';

export function createLoginOtpDeliveryProvider() {
  if (env.WHATSAPP_PROVIDER === 'console') return new ConsoleOtpDeliveryProvider();
  if (env.WHATSAPP_PROVIDER !== 'meta') return new DisabledOtpDeliveryProvider();
  return new MetaWhatsAppOtpProvider({
    accessToken: env.META_WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID,
    templateName: env.META_WHATSAPP_TEMPLATE_NAME,
    templateLanguage: env.META_WHATSAPP_TEMPLATE_LANGUAGE,
    graphApiVersion: env.META_GRAPH_API_VERSION,
    apiBaseUrl: env.META_GRAPH_API_BASE_URL,
  });
}
