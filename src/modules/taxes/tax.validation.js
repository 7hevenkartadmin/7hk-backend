import { z } from 'zod';
import { reportDateRange } from './tax.domain.js';

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
export const taxQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).optional(),
  financialYear: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(60).optional(),
  kind: z.enum(['INVOICE', 'CREDIT_NOTE']).optional(),
}).strict().superRefine((value, ctx) => {
  if (Number(Boolean(value.period)) + Number(Boolean(value.financialYear)) + Number(Boolean(value.from || value.to)) > 1) ctx.addIssue({ code: 'custom', message: 'Choose one month, financial year or date range.' });
  try { reportDateRange(value); } catch (error) { ctx.addIssue({ code: 'custom', message: error.message }); }
});
export const taxIdSchema = z.object({ id: objectId }).passthrough();
export const prepareFilingSchema = z.object({
  period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  reviewed: z.literal(true),
  hsnDigits: z.union([z.literal(4), z.literal(6)]).default(4),
  reviewNotes: z.string().trim().min(10).max(2000),
}).strict();
export const portalFilingSchema = z.object({
  returnType: z.enum(['GSTR1', 'GSTR3B']),
  arn: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{15}$/),
  filedAt: z.string().datetime({ offset: true }),
}).strict();
export const creditNoteSchema = z.object({
  reason: z.string().trim().min(10).max(500),
  gstAdjustment: z.boolean(),
  eligibilityConfirmed: z.literal(true),
  idempotencyKey: z.string().uuid(),
  lines: z.array(z.object({ lineIndex: z.number().int().min(0), amount: z.number().positive().refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, 'Use at most two decimal places'), quantity: z.number().min(0).max(100000).default(0) }).strict()).min(1).max(200),
}).strict();
export const classificationSchema = z.object({
  lineIndex: z.number().int().min(0),
  hsnCode: z.string().regex(/^(?:\d{4}|\d{6}|\d{8})$/),
  uqc: z.enum(['NOS', 'OTH', 'KGS', 'GMS', 'LTR', 'MLT', 'PCS', 'PAC', 'BOX', 'SET']),
  reason: z.string().trim().min(10).max(500),
  idempotencyKey: z.string().uuid(),
}).strict();
