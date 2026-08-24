import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../modules/users/user.model.js';
import { AuditLog } from '../modules/audit/audit.model.js';
import { assertSecureStaffPassword } from '../modules/owner/owner.service.js';
import { decryptTotpSecret, verifyTotpCode } from '../modules/auth/totp.service.js';

async function readHidden(prompt) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('Use an interactive terminal');
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
      if (character === '\u0003') { finish(); reject(new Error('Owner reset cancelled')); return; }
      if (character === '\r' || character === '\n') { finish(); resolve(value); return; }
      if (character === '\u007f' || character === '\b') { value = value.slice(0, -1); return; }
      if (/^[\x20-\x7E]$/u.test(character)) value += character;
    };
    input.on('data', onData);
  });
}

let prompt = readline.createInterface({ input, output });
try {
  await connectDatabase();
  const email = (await prompt.question('Owner email: ')).trim().toLowerCase();
  prompt.close();
  prompt = null;
  const owner = await User.findOne({ email, role: 'owner', staffSeat: 'PRIMARY_OWNER' })
    .select('+totpSecretEncrypted +refreshTokenHash +passwordHash');
  if (!owner || !owner.totpEnabled || !owner.totpSecretEncrypted) throw new Error('Primary owner not found or authenticator unavailable');
  const code = await readHidden('Current 6-digit authenticator code: ');
  if (!verifyTotpCode(decryptTotpSecret(owner.totpSecretEncrypted), code)) throw new Error('Authenticator verification failed');
  const password = assertSecureStaffPassword(await readHidden('New owner password (15+ characters): '));
  const confirmation = await readHidden('Confirm new owner password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');

  owner.passwordHash = await User.hashPassword(password);
  owner.passwordChangedAt = new Date();
  owner.refreshTokenHash = undefined;
  owner.tokenVersion = Number(owner.tokenVersion || 0) + 1;
  await owner.save();
  await AuditLog.create({
    actor: owner._id,
    actorRole: 'owner',
    action: 'owner.password_reset.cli',
    entityType: 'User',
    entityId: String(owner._id),
    before: null,
    after: { sessionsRevoked: true },
    userAgent: 'owner:reset-password CLI',
  });
  output.write('Owner password changed and all sessions revoked.\n');
} catch (error) {
  console.error(`Owner password reset failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  prompt?.close();
  await disconnectDatabase().catch(() => {});
}
