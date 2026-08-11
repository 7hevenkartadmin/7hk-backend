import express from 'express';
import morgan from 'morgan';
import { env } from './config/env.js';
import { applySecurity } from './shared/middlewares/security.js';
import { errorHandler, notFound } from './shared/middlewares/errorHandler.js';
import { routes } from './routes.js';

export function createApp() {
  const app = express();
  applySecurity(app);
  if (env.NODE_ENV !== 'test') app.use(morgan('combined'));

  app.get('/health', (_req, res) => {
    res.json({ success: true, service: '7Heven API', status: 'healthy' });
  });

  app.use(`/api/${env.API_VERSION}`, routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
