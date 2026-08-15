import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import hpp from 'hpp';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';

export function applySecurity(app) {
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100000, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({
    limit: '1mb',
    verify(req, _res, buffer) {
      if (req.originalUrl.includes('/webhooks/whatsapp')) req.rawBody = Buffer.from(buffer);
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(mongoSanitize());
  app.use(hpp());
  app.use(compression({
    filter(req, res) {
      if (req.headers.accept?.includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }));
}
