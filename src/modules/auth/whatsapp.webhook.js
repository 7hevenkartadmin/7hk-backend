import crypto from 'crypto';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { getSevenHeavenOtpService } from './otp.module.js';

export function isValidMetaWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader || !appSecret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const actualBuffer = Buffer.from(String(signatureHeader));
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function extractWhatsAppMessageStatuses(payload) {
  if (payload?.object !== 'whatsapp_business_account') return [];
  return (payload.entry || []).flatMap((entry) => (entry.changes || []))
    .filter((change) => change.field === 'messages')
    .flatMap((change) => change.value?.statuses || [])
    .filter((status) => status?.id && status?.status)
    .map((status) => ({ providerMessageId: status.id, status: status.status }));
}

export const whatsappWebhookRoutes = Router();

whatsappWebhookRoutes.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken === env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN && challenge) {
    return res.status(200).type('text/plain').send(String(challenge));
  }
  return res.sendStatus(403);
});

whatsappWebhookRoutes.post('/', asyncHandler(async (req, res) => {
  if (!isValidMetaWebhookSignature(
    req.rawBody,
    req.headers['x-hub-signature-256'],
    env.META_WHATSAPP_APP_SECRET,
  )) {
    return res.sendStatus(401);
  }

  const statuses = extractWhatsAppMessageStatuses(req.body);
  const otpService = getSevenHeavenOtpService();
  await Promise.all(statuses.map(({ providerMessageId, status }) => (
    otpService.recordProviderStatus(providerMessageId, status)
  )));
  return res.sendStatus(200);
}));
