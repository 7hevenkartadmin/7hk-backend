import { AuditLog } from './audit.model.js';
import { criticalAuditType } from './criticalAudit.js';

export function snapshot(doc) {
  if (!doc) return null;
  if (typeof doc.toObject === 'function') return doc.toObject();
  return doc;
}

export async function audit({ req, action, entityType, entityId, before, after }) {
  const beforeSnapshot = snapshot(before);
  const afterSnapshot = snapshot(after);
  return AuditLog.create({
    actor: req.user?._id,
    actorRole: req.user?.role,
    action,
    entityType,
    entityId: String(entityId),
    before: beforeSnapshot,
    after: afterSnapshot,
    criticalType: criticalAuditType({ action, before: beforeSnapshot, after: afterSnapshot }) || undefined,
    ip: req.ip,
    userAgent: req.headers['user-agent'] || '',
  });
}
