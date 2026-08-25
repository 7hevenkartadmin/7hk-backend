import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { env } from './config/env.js';
import { applySecurity } from './shared/middlewares/security.js';
import { errorHandler, notFound } from './shared/middlewares/errorHandler.js';
import { routes } from './routes.js';
import { assertDatabaseTransactionSupport } from './config/database.js';
import { identifyClientPlatform } from './shared/middlewares/clientPlatform.js';

export function createApp({
  databaseTransactionCheck = assertDatabaseTransactionSupport,
  requireTransactionHealthCheck = env.NODE_ENV === 'production',
} = {}) {
  const app = express();
  applySecurity(app);
  if (env.NODE_ENV !== 'test') app.use(morgan('combined'));

  app.get('/health', async (_req, res) => {
    if (requireTransactionHealthCheck) {
      try {
        await databaseTransactionCheck();
      } catch {
        return res.status(503).json({
          success: false,
          service: '7Heven API',
          status: 'unhealthy',
        });
      }
    }
    return res.json({ success: true, service: '7Heven API', status: 'healthy' });
  });

  app.use('/uploads', express.static(path.resolve('uploads'), {
    immutable: true,
    maxAge: '30d',
    setHeaders(res) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));

  app.use(`/api/${env.API_VERSION}`, identifyClientPlatform, routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
