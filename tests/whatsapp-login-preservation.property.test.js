import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import { requestOtpSchema, verifyOtpSchema } from '../src/modules/auth/auth.validation.js';
import { OtpTokenService } from '../src/modules/auth/otp-token.service.js';
import { MetaWhatsAppOtpProvider } from '../src/modules/auth/providers/meta-whatsapp.provider.js';
import { extractWhatsAppMessageStatuses, isValidMetaWebhookSignature } from '../src/modules/auth/whatsapp.webhook.js';

const SEED = 20260608;
const RUNS = 100;
const secret = 'synthetic-preservation-hmac-secret-12345678901234567890';
const tokenService = new OtpTokenService(secret);
const indianSubscriber = fc.tuple(fc.constantFrom('6', '7', '8', '9'), fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 9, maxLength: 9 }))
  .map(([first, rest]) => `${first}${rest.join('')}`);
const otpArbitrary = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 6, maxLength: 6 })
  .map((digits) => digits.join(''));
const statusArbitrary = fc.constantFrom('sent', 'delivered', 'read', 'failed');

// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12**
test('Property 2: supported credentials preserve canonical identity and keyed challenge hashing', () => {
  fc.assert(fc.property(indianSubscriber, otpArbitrary, (subscriber, otp) => {
    const local = requestOtpSchema.safeParse({ phone: subscriber });
    const canonical = requestOtpSchema.safeParse({ phone: `+91${subscriber}` });
    const verification = verifyOtpSchema.safeParse({ phone: subscriber, otp });
    assert.equal(local.success, true);
    assert.equal(canonical.success, true);
    assert.equal(verification.success, true);

    const localIdentity = tokenService.identity(`+91${subscriber}:LOGIN:+91${subscriber}`);
    const canonicalIdentity = tokenService.identity(`+91${subscriber}:LOGIN:+91${subscriber}`);
    assert.equal(localIdentity, canonicalIdentity);
    assert.equal(tokenService.hash(otp, localIdentity), tokenService.hash(otp, canonicalIdentity));
    assert.doesNotMatch(localIdentity, new RegExp(subscriber));
    assert.notEqual(tokenService.hash(otp, localIdentity), otp);
  }), { seed: SEED, numRuns: RUNS });
});

test('Property 2: Meta payload shape and exact-body webhook authentication are preserved', async () => {
  await fc.assert(fc.asyncProperty(indianSubscriber, otpArbitrary, statusArbitrary, async (subscriber, otp, status) => {
    let captured;
    const provider = new MetaWhatsAppOtpProvider({
      accessToken: 'synthetic-meta-access-token',
      phoneNumberId: '123456789',
      templateName: 'sevenheaven_login_otp',
      templateLanguage: 'en_US',
      graphApiVersion: 'v23.0',
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.synthetic' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await provider.sendLoginOtp({ recipient: `+91${subscriber}`, otp });
    const body = JSON.parse(captured.options.body);
    assert.equal(body.to, `91${subscriber}`);
    assert.equal(body.template.components[0].parameters[0].text, otp);
    assert.equal(body.template.components[1].parameters[0].text, otp);

    const rawBody = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', marker: subscriber }));
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    assert.equal(isValidMetaWebhookSignature(rawBody, signature, secret), true);
    assert.equal(isValidMetaWebhookSignature(Buffer.concat([rawBody, Buffer.from(' ')]), signature, secret), false);

    assert.deepEqual(extractWhatsAppMessageStatuses({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.synthetic', status }] } }] }],
    }), [{ providerMessageId: 'wamid.synthetic', status }]);
  }), { seed: SEED, numRuns: RUNS });
});
