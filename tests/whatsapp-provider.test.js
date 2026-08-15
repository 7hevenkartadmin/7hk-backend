import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { MetaWhatsAppOtpProvider } from '../src/modules/auth/providers/meta-whatsapp.provider.js';
import { extractWhatsAppMessageStatuses, isValidMetaWebhookSignature } from '../src/modules/auth/whatsapp.webhook.js';

test('Meta provider sends the approved authentication template with copy-code parameters', async () => {
  let captured;
  const provider = new MetaWhatsAppOtpProvider({
    accessToken: 'meta-access-token',
    phoneNumberId: '123456789',
    templateName: 'sevenheaven_login_otp',
    templateLanguage: 'en_US',
    graphApiVersion: 'v23.0',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.test-message' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const result = await provider.sendLoginOtp({ recipient: '+919876543210', otp: '123456' });
  const body = JSON.parse(captured.options.body);
  assert.equal(captured.url, 'https://graph.facebook.com/v23.0/123456789/messages');
  assert.equal(captured.options.headers.Authorization, 'Bearer meta-access-token');
  assert.equal(body.to, '919876543210');
  assert.equal(body.template.name, 'sevenheaven_login_otp');
  assert.equal(body.template.components[0].parameters[0].text, '123456');
  assert.equal(body.template.components[1].sub_type, 'url');
  assert.equal(body.template.components[1].parameters[0].text, '123456');
  assert.deepEqual(result, {
    provider: 'meta-whatsapp-cloud',
    providerMessageId: 'wamid.test-message',
    status: 'ACCEPTED',
  });
});

test('Meta provider classifies permanent API rejection without exposing provider response text', async () => {
  const provider = new MetaWhatsAppOtpProvider({
    accessToken: 'meta-access-token',
    phoneNumberId: '123456789',
    templateName: 'sevenheaven_login_otp',
    templateLanguage: 'en_US',
    graphApiVersion: 'v23.0',
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 132001, message: 'Sensitive provider diagnostic' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
  });

  await assert.rejects(
    provider.sendLoginOtp({ recipient: '+919876543210', otp: '123456' }),
    (error) => error.code === 'META_132001'
      && error.retryable === false
      && !error.message.includes('Sensitive provider diagnostic'),
  );
});

test('Meta webhook signatures are checked against the exact raw request body', () => {
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'meta-app-secret-for-tests';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  assert.equal(isValidMetaWebhookSignature(rawBody, signature, secret), true);
  assert.equal(isValidMetaWebhookSignature(Buffer.from('{}'), signature, secret), false);
  assert.equal(isValidMetaWebhookSignature(rawBody, 'sha256=bad', secret), false);
});

test('WhatsApp webhook parser extracts only message status callbacks', () => {
  const statuses = extractWhatsAppMessageStatuses({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      statuses: [
        { id: 'wamid.one', status: 'sent', recipient_id: '919999999999' },
        { id: 'wamid.two', status: 'delivered', recipient_id: '918888888888' },
      ],
    } }] }],
  });
  assert.deepEqual(statuses, [
    { providerMessageId: 'wamid.one', status: 'sent' },
    { providerMessageId: 'wamid.two', status: 'delivered' },
  ]);
});
