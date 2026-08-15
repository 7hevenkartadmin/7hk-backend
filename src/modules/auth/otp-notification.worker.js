import { UnrecoverableError, Worker } from 'bullmq';
import { OTP_PURPOSE } from './otp.constants.js';

const SEND_OTP_JOB = 'send-otp';

export function createOtpNotificationWorker({ queueName, connection, provider, otpService, concurrency = 5 }) {
  return new Worker(queueName, async (job) => {
    if (job.name !== SEND_OTP_JOB || job.data.purpose !== OTP_PURPOSE.LOGIN) {
      throw new UnrecoverableError('Unsupported OTP notification job');
    }

    let result;
    try {
      result = await provider.sendLoginOtp(job.data);
    } catch (error) {
      const maxAttempts = Number(job.opts.attempts || 1);
      const isFinalAttempt = error.retryable === false || job.attemptsMade + 1 >= maxAttempts;
      if (isFinalAttempt) {
        await otpService.recordDeliveryFailed({ identity: job.data.userId, otpId: job.data.otpId });
      }
      if (error.retryable === false) throw new UnrecoverableError(error.code || 'OTP_PROVIDER_REJECTED');
      throw error;
    }

    try {
      await otpService.recordDeliveryAccepted({
        identity: job.data.userId,
        otpId: job.data.otpId,
        providerMessageId: result.providerMessageId,
      });
      return { provider: result.provider, status: result.status };
    } catch {
      throw new UnrecoverableError('OTP_DELIVERY_STATE_UPDATE_FAILED');
    }
  }, { connection, concurrency });
}
