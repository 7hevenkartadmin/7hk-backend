import Redis from 'ioredis';
import { env } from '../../config/env.js';
import { OTP_CHANNEL, OTP_PURPOSE } from './otp.constants.js';
import { OtpNotificationQueue } from './otp-notification.queue.js';
import { createOtpNotificationWorker } from './otp-notification.worker.js';
import { OtpTokenService } from './otp-token.service.js';
import { createLoginOtpDeliveryProvider } from './providers/index.js';
import { SecureOtpService } from './secure-otp.service.js';

let sevenHeavenOtpService;

function redisConnectionOptions(redisUrl) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number(parsed.pathname.slice(1) || 0),
    ...(parsed.protocol === 'rediss:' ? { tls: { servername: parsed.hostname } } : {}),
  };
}

export function getSevenHeavenOtpService() {
  if (!sevenHeavenOtpService) {
    const connection = redisConnectionOptions(env.REDIS_URL);
    sevenHeavenOtpService = new SecureOtpService({
      redisClient: new Redis(env.REDIS_URL),
      notificationQueue: new OtpNotificationQueue({
        queueName: env.OTP_QUEUE_NAME,
        connection,
      }),
      tokenService: new OtpTokenService(env.OTP_HMAC_SECRET),
      ttlSeconds: 300,
      maxAttempts: 5,
      requestLimit: 5,
      requestWindowSeconds: 60,
      resendCooldownSeconds: 30,
    });
  }

  return sevenHeavenOtpService;
}

export function buildLoginOtpPayload(phone) {
  return {
    userId: phone,
    purpose: OTP_PURPOSE.LOGIN,
    channel: OTP_CHANNEL.WHATSAPP,
    recipient: phone,
  };
}

export function startOtpNotificationWorker() {
  if (!env.OTP_WORKER_ENABLED) return null;

  return createOtpNotificationWorker({
    queueName: env.OTP_QUEUE_NAME,
    connection: redisConnectionOptions(env.REDIS_URL),
    provider: createLoginOtpDeliveryProvider(),
    otpService: getSevenHeavenOtpService(),
  });
}

export async function closeOtpModule() {
  if (sevenHeavenOtpService) await sevenHeavenOtpService.close();
}
