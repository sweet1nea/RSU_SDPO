module.exports = (err, req, res, next) => {
  console.error(err.stack);
  // Streaming endpoints (PDF/Excel report export) can throw after bytes are
  // already on the wire. Calling res.json() at that point would itself
  // throw ERR_HTTP_HEADERS_SENT, so delegate to Express's default handler
  // instead of attempting to send a fresh response.
  if (res.headersSent) {
    return next(err);
  }
  const status = err.statusCode || 500;
  // Every deliberate business-rule error in this app sets err.statusCode
  // (400/401/403/404/409/...) with a message written for the end user to
  // read. An error that reaches here WITHOUT one is unexpected — a bug, a
  // dependency failure, a dropped DB connection — and its message is
  // whatever that layer happens to say, e.g. the raw driver message
  // "Connection terminated unexpectedly" that used to reach a QR-scanning
  // borrower verbatim (2026-10-01 system audit). The real message is still
  // logged above via console.error; only the response is generic.
  const message = err.statusCode ? err.message : 'Internal Server Error';
  res.status(status).json({
    success: false,
    message,
    // Only ever set by authMiddleware.js right now (AUTH_EXPIRED) — purely
    // additive, existing consumers that only destructure {success,message,
    // data} are unaffected. Lets the client tell a real expired/missing
    // session apart from an ordinary business-logic 401 (wrong password,
    // etc.) without guessing from message text.
    ...(err.code ? { code: err.code } : {}),
    // Structured context for a business-rule error (e.g. which documents
    // are missing, which restriction blocked a request).
    ...(err.details ? { data: err.details } : {}),
  });
};
