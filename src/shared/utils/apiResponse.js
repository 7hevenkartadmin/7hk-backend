export function ok(res, data, message = 'OK', statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

export function created(res, data, message = 'Created') {
  return ok(res, data, message, 201);
}
