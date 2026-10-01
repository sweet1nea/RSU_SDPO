'use strict';

// Unit tests for server/middlewares/errorHandler.js.
// Covers the `code` passthrough added alongside authMiddleware.js's
// AUTH_EXPIRED (Low finding, 2026-09-08 system audit) — it must appear
// only when the thrown error actually set one, and every existing
// {success,message} consumer must stay unaffected.

const errorHandler = require('../../middlewares/errorHandler');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.headersSent = false;
  return res;
}

describe('middlewares/errorHandler.js', () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('responds with the error\'s statusCode and message, no code field, when none was set', () => {
    const err = new Error('Current password is incorrect');
    err.statusCode = 401;
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    const payload = res.json.mock.calls[0][0];
    expect(payload).toEqual({ success: false, message: 'Current password is incorrect' });
    expect(payload).not.toHaveProperty('code');
  });

  test('includes code in the payload when the error set one (e.g. AUTH_EXPIRED)', () => {
    const err = new Error('Authentication required');
    err.statusCode = 401;
    err.code = 'AUTH_EXPIRED';
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    const payload = res.json.mock.calls[0][0];
    expect(payload).toEqual({ success: false, message: 'Authentication required', code: 'AUTH_EXPIRED' });
  });

  test('defaults to 500 and a generic message when the error has neither', () => {
    const err = new Error();
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0]).toEqual({ success: false, message: 'Internal Server Error' });
  });

  // 2026-10-01 system audit: a dropped DB connection on GET /api/qr/lookup
  // surfaced its raw driver message, "Connection terminated unexpectedly",
  // straight to whoever was scanning a QR code — confusing, and leaks
  // internals. Any error WITHOUT an explicit statusCode is exactly this
  // kind of unexpected failure (every deliberate business-rule error in
  // this app sets one), so its message is replaced; the real message is
  // still logged server-side via console.error, just not sent to the client.
  test('replaces the message with a generic one for an unexpected error that has no statusCode, even if it has a real message', () => {
    const err = new Error('Connection terminated unexpectedly');
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0]).toEqual({ success: false, message: 'Internal Server Error' });
    expect(errorSpy).toHaveBeenCalled(); // still logged server-side
  });

  test('still uses the real message for a deliberate business-rule error (statusCode set)', () => {
    const err = new Error('A category named "Basketball" already exists');
    err.statusCode = 409;
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    expect(res.json.mock.calls[0][0].message).toBe('A category named "Basketball" already exists');
  });

  test('delegates to next(err) instead of writing a response when headers were already sent', () => {
    const err = new Error('boom');
    const res = mockRes();
    res.headersSent = true;
    const next = jest.fn();

    errorHandler(err, {}, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});
