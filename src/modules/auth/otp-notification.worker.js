import { UnrecoverableError, Worker } from 'bullmq';
import { OTP_PURPOSE } from './otp.constants.js';
import { sanitizeProviderCode } from './otp-diagnostics.js';

const SEND_OTP_JOB = 'send-otp';

export async function processOtpNotificationJob(job, { provider, otpService }) {
  if (job.name !== SEND_OTP_JOB || job.data.purpose !== OTP_PURPOSE.LOGIN) {
    throw new UnrecoverableError('Unsupported OTP notification job');
  }

  let result;
  try {
    result = await provider.sendLoginOtp(job.data);
  } catch (error) {
    const maxAttempts = Number(job.opts.attempts || 1);
    const permanent = error?.retryable === false;
    const providerCode = sanitizeProviderCode(error?.code);
    const isFinalAttempt = permanent || job.attemptsMade + 1 >= maxAttempts;
    if (isFinalAttempt) {
      try {
        await otpService.recordDeliveryFailed({
          identity: job.data.userId,
          otpId: job.data.otpId,
          requestId: job.data.requestId,
          providerCode,
          permanent,
        });
      } catch {
        if (permanent) throw new UnrecoverableError('OTP_DELIVERY_STATE_UPDATE_FAILED');
      }
    }
    if (permanent) throw new UnrecoverableError(providerCode);
    throw error;
  }

  try {
    await otpService.recordDeliveryAccepted({
      identity: job.data.userId,
      otpId: job.data.otpId,
      providerMessageId: result.providerMessageId,
      requestId: job.data.requestId,
    });
  } catch {
    // The provider has already accepted the send. Retrying would risk a duplicate OTP message.
    throw new UnrecoverableError('OTP_DELIVERY_STATE_UPDATE_FAILED');
  }
  return { provider: result.provider, status: result.status };
}

export function createOtpNotificationWorker({ queueName, connection, provider, otpService, concurrency = 5 }) {
  return new Worker(
    queueName,
    (job) => processOtpNotificationJob(job, { provider, otpService }),
    { connection, concurrency },
  );
}
