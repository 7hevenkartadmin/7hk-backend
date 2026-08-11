import { AppError } from '../utils/AppError.js';

export const validate = (schema, source = 'body') => (req, _res, next) => {
  const parsed = schema.safeParse(req[source]);
  if (!parsed.success) {
    return next(new AppError('Validation failed', 422, 'VALIDATION_ERROR', parsed.error.flatten()));
  }
  req[source] = parsed.data;
  return next();
};
