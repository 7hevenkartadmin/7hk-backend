import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleOtpDeliveryProvider } from '../src/modules/auth/providers/console-otp.provider.js';

test('console provider prints the OTP without exposing the complete phone number', async () => {
  const messages = [];
  const provider = new ConsoleOtpDeliveryProvider({ log: (message) => messages.push(message) });

  const result = await provider.sendLoginOtp({
    recipient: '+919876543210',
    otp: '482913',
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[LOCAL OTP\] 482913/);
  assert.match(messages[0], /phone ending 3210/);
  assert.equal(messages[0].includes('+919876543210'), false);
  assert.equal(messages[0].includes('9876543210'), false);
  assert.equal(result.provider, 'development-console');
  assert.match(result.providerMessageId, /^local-[0-9a-f-]{36}$/);
  assert.equal(result.status, 'ACCEPTED');
});
