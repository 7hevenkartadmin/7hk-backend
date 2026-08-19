import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { closeOtpModule, startOtpNotificationWorker } from './modules/auth/otp.module.js';
import { startExpiredReservationSweep } from './modules/payments/payment.service.js';

const app = createApp();
let otpNotificationWorker;
let reservationSweep;

try {
  await connectDatabase();
  otpNotificationWorker = startOtpNotificationWorker();
  reservationSweep = startExpiredReservationSweep();
} catch (error) {
  console.error('Failed to initialize API dependencies during startup:', error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
}

const server = app.listen(env.PORT, () => {
  console.log(`7Heven API listening on port ${env.PORT}`);
});

async function shutdown(signal) {
  console.log(`${signal} received. Closing API server.`);
  const shutdownTimeout = setTimeout(() => {
    console.error('Graceful shutdown timeout. Forcing exit.');
    process.exit(1);
  }, 10000);

  server.close(async () => {
    if (reservationSweep) await reservationSweep.close();
    if (otpNotificationWorker) await otpNotificationWorker.close();
    await closeOtpModule();
    await disconnectDatabase();
    clearTimeout(shutdownTimeout);
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  shutdown('unhandledRejection');
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown('uncaughtException');
});
