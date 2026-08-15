import { Queue } from 'bullmq';

const SEND_OTP_JOB = 'send-otp';

export class OtpNotificationQueue {
  constructor({ queueName, connection }) {
    this.queue = new Queue(queueName, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
  }

  async enqueueOtp(payload) {
    const job = await this.queue.add(SEND_OTP_JOB, payload);
    return { jobId: job.id, status: 'QUEUED' };
  }

  async close() {
    await this.queue.close();
  }
}
