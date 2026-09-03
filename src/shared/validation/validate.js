import { AppError } from '../utils/AppError.js';

export const validate = (schema, source = 'body') => (req, _res, next) => {
  const parsed = schema.safeParse(req[source]);
  if (!parsed.success) {
    const flattened = parsed.error.flatten();
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
      code: issue.code,
      ...(issue.origin ? { origin: issue.origin } : {}),
      ...(issue.type ? { type: issue.type } : {}),
      ...(Number.isFinite(issue.minimum) ? { minimum: issue.minimum } : {}),
      ...(Number.isFinite(issue.maximum) ? { maximum: issue.maximum } : {}),
      ...(issue.expected ? { expected: issue.expected } : {}),
      ...(issue.format ? { format: issue.format } : {}),
    }));
    return next(new AppError('Validation failed', 422, 'VALIDATION_ERROR', { ...flattened, issues }));
  }
  req[source] = parsed.data;
  return next();
};
