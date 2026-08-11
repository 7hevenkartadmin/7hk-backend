import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  API_VERSION: z.string().default('v1'),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(24),
  JWT_REFRESH_SECRET: z.string().min(24),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://admin.localhost:5173'),
  COOKIE_SECURE: z.coerce.boolean().default(false),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  OTP_QUEUE_NAME: z.string().min(1).default('otp-notifications'),
  OTP_WORKER_ENABLED: z.coerce.boolean().default(true),
  WHATSAPP_PROVIDER: z.string().default('mock'),
  LOW_STOCK_THRESHOLD: z.coerce.number().int().positive().default(20),
  STORE_LATITUDE: z.coerce.number().default(26.713052497465416),
  STORE_LONGITUDE: z.coerce.number().default(85.68640273918543),
  DELIVERY_RADIUS_KM: z.coerce.number().positive().default(10),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid backend environment', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};
