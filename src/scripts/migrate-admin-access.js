import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../modules/users/user.model.js';

try {
  await connectDatabase();
  const seated = await User.findOne({ staffSeat: 'PRIMARY_ADMIN' });
  if (seated) {
    console.log('Primary administrator seat is already assigned.');
  } else {
    const activeAdmins = await User.find({ role: 'admin', status: 'active' }).sort({ createdAt: 1 });
    if (activeAdmins.length !== 1) {
      throw new Error(`Expected exactly one active admin to migrate; found ${activeAdmins.length}`);
    }
    const expiry = new Date(process.env.ADMIN_ASSIGNMENT_EXPIRES_AT || '');
    if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
      throw new Error('Set ADMIN_ASSIGNMENT_EXPIRES_AT to a future ISO-8601 timestamp');
    }
    activeAdmins[0].staffSeat = 'PRIMARY_ADMIN';
    activeAdmins[0].assignmentExpiresAt = expiry;
    await activeAdmins[0].save();
    console.log('Existing administrator assigned to the primary seat.');
  }
} catch (error) {
  console.error(`Admin access migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase().catch(() => {});
}
