import { Router } from 'express';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { categoryReport, dashboardSummary, salesReport } from './report.service.js';
import { salesReportQuerySchema } from './report.validation.js';

export const reportRoutes = Router();

reportRoutes.use(requireAuth, authorize('admin', 'manager'));

reportRoutes.get('/dashboard', asyncHandler(async (_req, res) => {
  ok(res, await dashboardSummary(), 'Dashboard report loaded');
}));

reportRoutes.get('/sales', validate(salesReportQuerySchema), asyncHandler(async (req, res) => {
  ok(res, { rows: await salesReport(req.query) }, 'Sales report loaded');
}));

reportRoutes.get('/categories', asyncHandler(async (_req, res) => {
  ok(res, { rows: await categoryReport() }, 'Category report loaded');
}));
