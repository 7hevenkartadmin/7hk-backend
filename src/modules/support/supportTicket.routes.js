import { Router } from 'express';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { catalogImageUpload } from '../catalog/catalog-upload.middleware.js';
import { uploadCatalogImage } from '../catalog/cloudinary-image.service.js';
import { AppError } from '../../shared/utils/AppError.js';
import { audit } from '../audit/audit.service.js';
import {
  approveSupportTicket,
  assertCustomerSupportEligibility,
  createSupportTicket,
  listAdminSupportTickets,
  listCustomerSupportTickets,
  rejectSupportTicket,
  verifySupportPickup,
} from './supportTicket.service.js';
import {
  createSupportTicketSchema,
  listSupportTicketsSchema,
  reviewSupportTicketSchema,
  supportProofUploadSchema,
  verifyPickupOtpSchema,
} from './supportTicket.validation.js';
import { SupportTicket } from './supportTicket.model.js';
import { supportPickupOtpRateLimiter, supportTicketRateLimiter } from '../../shared/middlewares/rateLimiters.js';
import { isAndroidRequest } from '../../shared/middlewares/clientPlatform.js';

export const supportTicketRoutes = Router();

supportTicketRoutes.use(requireAuth);

supportTicketRoutes.post('/uploads/proof', authorize('customer'), supportTicketRateLimiter, catalogImageUpload, validate(supportProofUploadSchema), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Proof image is required', 422, 'IMAGE_REQUIRED');
  await assertCustomerSupportEligibility(req.user, req.body.orderId, { excludePaanCorner: isAndroidRequest(req) });
  const image = await uploadCatalogImage(req.file, { kind: 'support-proof', actorId: req.user._id });
  created(res, { image }, 'Proof image uploaded');
}));

supportTicketRoutes.post('/', authorize('customer'), supportTicketRateLimiter, validate(createSupportTicketSchema), asyncHandler(async (req, res) => {
  created(res, { ticket: await createSupportTicket(req.user, req.body, { excludePaanCorner: isAndroidRequest(req) }) }, 'Support ticket created');
}));

supportTicketRoutes.get('/me', authorize('customer'), asyncHandler(async (req, res) => {
  ok(res, { tickets: await listCustomerSupportTickets(req.user, { excludePaanCorner: isAndroidRequest(req) }) }, 'Support tickets loaded');
}));

supportTicketRoutes.get('/admin', authorize('admin', 'manager', 'support'), validate(listSupportTicketsSchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, await listAdminSupportTickets(req.query), 'Support tickets loaded');
}));

supportTicketRoutes.post('/admin/:id/approve', authorize('admin', 'manager'), validate(reviewSupportTicketSchema), asyncHandler(async (req, res) => {
  const before = await SupportTicket.findById(req.params.id);
  const ticket = await approveSupportTicket(req.params.id, req.body, req.user);
  await audit({ req, action: 'support-ticket.approve', entityType: 'SupportTicket', entityId: ticket._id, before, after: ticket });
  ok(res, { ticket }, ticket.status === 'pickup_scheduled' ? 'Pickup scheduled' : 'Support ticket approved');
}));

supportTicketRoutes.post('/admin/:id/reject', authorize('admin', 'manager'), validate(reviewSupportTicketSchema.omit({ requiresPickup: true })), asyncHandler(async (req, res) => {
  const before = await SupportTicket.findById(req.params.id);
  const ticket = await rejectSupportTicket(req.params.id, req.body, req.user);
  await audit({ req, action: 'support-ticket.reject', entityType: 'SupportTicket', entityId: ticket._id, before, after: ticket });
  ok(res, { ticket }, 'Support ticket rejected');
}));

supportTicketRoutes.post('/admin/:id/verify-pickup', authorize('admin', 'manager', 'support'), supportPickupOtpRateLimiter, validate(verifyPickupOtpSchema), asyncHandler(async (req, res) => {
  const before = await SupportTicket.findById(req.params.id);
  const ticket = await verifySupportPickup(req.params.id, req.body.otp, req.user);
  await audit({ req, action: 'support-ticket.pickup.verify', entityType: 'SupportTicket', entityId: ticket._id, before, after: ticket });
  ok(res, { ticket }, 'Pickup verified and refund workflow started');
}));
