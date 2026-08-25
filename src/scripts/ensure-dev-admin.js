import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../modules/users/user.model.js';

const DEVELOPMENT_ADMIN_EMAIL = 'admin@7heven.com';
const DEVELOPMENT_ADMIN_PASSWORD = 'admin12345';

try {
  if (env.NODE_ENV === 'production') throw new Error('Development administrator creation is disabled in production');
  await connectDatabase();

  const [seatHolder, existing] = await Promise.all([
    User.findOne({ staffSeat: 'PRIMARY_ADMIN' }),
    User.findOne({ email: DEVELOPMENT_ADMIN_EMAIL }).select('+passwordHash'),
  ]);
  if (seatHolder && (!existing || String(seatHolder._id) !== String(existing._id))) {
    throw new Error(`Primary administrator seat is already assigned to ${seatHolder.email}; no account was changed`);
  }
  if (existing && existing.role !== 'admin') {
    throw new Error('Development administrator email belongs to a non-admin account; no account was changed');
  }

  const administrator = existing || new User({ email: DEVELOPMENT_ADMIN_EMAIL });
  administrator.name = 'Admin';
  administrator.passwordHash = await User.hashPassword(DEVELOPMENT_ADMIN_PASSWORD);
  administrator.role = 'admin';
  administrator.status = 'active';
  administrator.staffSeat = 'PRIMARY_ADMIN';
  administrator.assignmentExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
  administrator.revokedAt = undefined;
  administrator.revokedBy = undefined;
  administrator.refreshTokenHash = undefined;
  administrator.tokenVersion = Number(administrator.tokenVersion || 0) + 1;
  administrator.passwordChangedAt = new Date();
  await administrator.save();

  console.log('Development administrator ready: admin@7heven.com');
} catch (error) {
  console.error(`Development administrator setup failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase().catch(() => {});
}
