'use strict';

// Unit tests for server/middlewares/roleMiddleware.js — previously at zero
// coverage (High #3, 2026-09-08 system audit). This is the middleware
// every role-gated route in the app is built on (Admin-only equipment CRUD,
// the uniform Admin/Director/Staff gate on borrow review/approve/reject,
// etc.), so its edge cases are worth pinning directly rather than only
// exercising it indirectly through route-level tests elsewhere.

const roleMiddleware = require('../../middlewares/roleMiddleware');

function mockRes() {
  return {};
}

describe('middlewares/roleMiddleware.js', () => {
  test('calls next() with no error when req.user.userRole is in the allowed list', () => {
    const middleware = roleMiddleware(['Admin', 'Director']);
    const req = { user: { id: 1, userRole: 'Director' } };
    const next = jest.fn();

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('rejects with 403 when req.user.userRole is not in the allowed list', () => {
    const middleware = roleMiddleware(['Admin', 'Director']);
    const req = { user: { id: 1, userRole: 'Staff' } };
    const next = jest.fn();

    middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/permission/i);
  });

  test('rejects with 403 when req.user is missing entirely (authMiddleware should always run first, but this must not throw or fail open)', () => {
    const middleware = roleMiddleware(['Admin']);
    const req = {};
    const next = jest.fn();

    middleware(req, mockRes(), next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
  });

  test('rejects when userRole is undefined on an otherwise-present req.user', () => {
    const middleware = roleMiddleware(['Admin']);
    const req = { user: { id: 1 } };
    const next = jest.fn();

    middleware(req, mockRes(), next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
  });

  test('a single-role allow-list only admits that exact role', () => {
    const middleware = roleMiddleware(['Director']);
    const next1 = jest.fn();
    middleware({ user: { userRole: 'Director' } }, mockRes(), next1);
    expect(next1).toHaveBeenCalledWith();

    const next2 = jest.fn();
    middleware({ user: { userRole: 'Admin' } }, mockRes(), next2);
    expect(next2.mock.calls[0][0].statusCode).toBe(403);
  });

  test('returns a fresh middleware function per call, independent allow-lists do not leak into each other', () => {
    const adminOnly = roleMiddleware(['Admin']);
    const directorOnly = roleMiddleware(['Director']);

    const next1 = jest.fn();
    adminOnly({ user: { userRole: 'Director' } }, mockRes(), next1);
    expect(next1.mock.calls[0][0].statusCode).toBe(403);

    const next2 = jest.fn();
    directorOnly({ user: { userRole: 'Director' } }, mockRes(), next2);
    expect(next2).toHaveBeenCalledWith();
  });
});
