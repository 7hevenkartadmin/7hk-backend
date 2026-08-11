import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { closeOtpModule, startOtpNotificationWorker } from './modules/auth/otp.module.js';

const app = createApp();
let otpNotificationWorker;

try {
  await connectDatabase();
  otpNotificationWorker = startOtpNotificationWorker();
} catch (error) {
  console.error('Failed to connect to MongoDB during startup:', error);
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
    clearTimeout(shutdownTimeout);
    if (otpNotificationWorker) await otpNotificationWorker.close();
    await closeOtpModule();
    await disconnectDatabase();
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
