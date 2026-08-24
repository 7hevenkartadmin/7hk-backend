import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { z } from 'zod';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../modules/users/user.model.js';
import { AuditLog } from '../modules/audit/audit.model.js';
import { assertSecureStaffPassword } from '../modules/owner/owner.service.js';
import { encryptTotpSecret, generateTotpSecret, ownerTotpUri, verifyTotpCode } from '../modules/auth/totp.service.js';

const ownerIdentitySchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
});

async function readHidden(prompt) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Owner password must be entered from an interactive terminal');
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
    };
    const onData = (character) => {
      if (character === '\u0003') {
        finish();
        reject(new Error('Owner creation cancelled'));
        return;
      }
      if (character === '\r' || character === '\n') {
        finish();
        resolve(value);
        return;
      }
      if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1);
        return;
      }
      if (/^[\x20-\x7E]$/u.test(character)) value += character;
    };
    input.on('data', onData);
  });
}

let prompt = readline.createInterface({ input, output });
try {
  await connectDatabase();
  const existing = await User.findOne({ staffSeat: 'PRIMARY_OWNER' });
  if (existing) throw new Error('A primary owner already exists');

  const identity = ownerIdentitySchema.parse({
    name: await prompt.question('Owner name: '),
    email: await prompt.question('Owner email: '),
  });
  const { name, email } = identity;
  prompt.close();
  prompt = null;
  const password = assertSecureStaffPassword(await readHidden('Owner password (15+ characters): '));
  const confirmation = await readHidden('Confirm owner password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');

  const secret = generateTotpSecret();
  output.write('\nAdd this setup key to an authenticator application.\n');
  output.write(`Account: ${email}\n`);
  output.write(`TOTP setup key: ${secret}\n`);
  output.write(`Authenticator URI: ${ownerTotpUri({ email, secret })}\n`);
  const verificationCode = await readHidden('Enter the current 6-digit authenticator code: ');
  if (!verifyTotpCode(secret, verificationCode)) throw new Error('Authenticator code verification failed');
  const owner = await User.create({
    name,
    email,
    passwordHash: await User.hashPassword(password),
    role: 'owner',
    status: 'active',
    staffSeat: 'PRIMARY_OWNER',
    totpEnabled: true,
    totpSecretEncrypted: encryptTotpSecret(secret),
    passwordChangedAt: new Date(),
  });
  await AuditLog.create({
    actor: owner._id,
    actorRole: 'owner',
    action: 'owner.bootstrap',
    entityType: 'User',
    entityId: String(owner._id),
    before: null,
    after: { role: 'owner', staffSeat: 'PRIMARY_OWNER', totpEnabled: true },
    userAgent: 'owner:create CLI',
  });

  output.write('\nOwner created and authenticator verified. Store the setup key in a secure offline location.\n');
} catch (error) {
  console.error(`Owner creation failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  prompt?.close();
  await disconnectDatabase().catch(() => {});
}
