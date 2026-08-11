import {
  OTP_CHANNEL,
  OTP_PURPOSE,
  createClientOtpNotificationWorker,
  createOtpModule,
} from '@hiithere/otp-verification-module';
import { env } from '../../config/env.js';

const otpModuleOptions = {
  preset: 'simple',
  redisUrl: env.REDIS_URL,
  queueName: env.OTP_QUEUE_NAME,
  defaultOtpPolicy: {
    length: 6,
    ttlSeconds: 300,
    maxAttempts: 5,
  },
  otpPolicies: {
    [OTP_PURPOSE.LOGIN]: {
      ttlSeconds: 300,
      maxAttempts: 5,
    },
  },
};

let sevenHeavenOtpModule;

export function getSevenHeavenOtpService() {
  if (!sevenHeavenOtpModule) {
    sevenHeavenOtpModule = createOtpModule(otpModuleOptions);
  }

  return sevenHeavenOtpModule.otpService;
}

export function buildLoginOtpPayload(phone) {
  return {
    userId: phone,
    purpose: OTP_PURPOSE.LOGIN,
    channel: OTP_CHANNEL.IN_APP,
    recipient: phone,
  };
}

export function startOtpNotificationWorker() {
  if (!env.OTP_WORKER_ENABLED) return null;

  return createClientOtpNotificationWorker({
    queueName: env.OTP_QUEUE_NAME,
    channel: OTP_CHANNEL.IN_APP,
    providerName: '7heaven-local',
    sendOtp: async ({ recipient, otp, purpose, requestId }) => {
      if (env.NODE_ENV !== 'production') {
        console.log('OTP delivery', { recipient, otp, purpose, requestId });
      }

      return {
        provider: '7heaven-local',
        status: 'SENT',
      };
    },
  });
}

export async function closeOtpModule() {
  if (sevenHeavenOtpModule) await sevenHeavenOtpModule.close();
}
