'use strict';

// Verifies server/helpers/notify.js: one action produces exactly ONE
// notification row per recipient (the in-app 'System' row), email is a
// delivery channel for that same notification (no extra rows), and a
// dedupe key makes the same event idempotent per recipient.
//
// SMS was removed (2026-10-02) per the manuscript's confirmed notification
// channels (in-app + email only) — the old SMS delivery assertions were
// removed from these tests along with the smsService.js code they covered.

jest.mock('../../models', () => require('../fixtures/mockModels')());
jest.mock('../../services/notificationService/emailService');

const { Notification, User } = require('../../models');
const { sendEmail } = require('../../services/notificationService/emailService');
const { notifyBorrower, notifyStaff, notifyRoles } = require('../../helpers/notify');

function makeUser(overrides = {}) {
  return {
    id: 1,
    emailAddress: 'user@example.com',
    contactNumber: '09171234567',
    userRole: 'Borrower',
    ...overrides
  };
}

describe('helpers/notify.js', () => {
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Notification.create.mockResolvedValue({ id: 100 });
    Notification.findOrCreate = jest.fn();
    sendEmail.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('notifyBorrower', () => {
    test('writes exactly one in-app (System) row and returns it', async () => {
      User.findByPk.mockResolvedValue(makeUser());
      const created = await notifyBorrower(1, 'Request approved', 'Approval');

      expect(Notification.create).toHaveBeenCalledTimes(1);
      expect(Notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, notificationType: 'Approval', message: 'Request approved', deliveryChannel: 'System' })
      );
      expect(Notification.bulkCreate).not.toHaveBeenCalled();
      expect(created).toEqual({ id: 100 });
    });

    test('email is delivered for the same notification without writing extra rows', async () => {
      User.findByPk.mockResolvedValue(makeUser());
      await notifyBorrower(1, 'Request approved', 'Approval');

      expect(sendEmail).toHaveBeenCalledWith('user@example.com', 'RSU SDPO Notification: Approval', 'Request approved');
      expect(Notification.create).toHaveBeenCalledTimes(1);
      expect(Notification.bulkCreate).not.toHaveBeenCalled();
    });

    test('channel failures are logged, never thrown, and never add rows', async () => {
      User.findByPk.mockResolvedValue(makeUser());
      sendEmail.mockResolvedValue({ success: false, error: 'smtp down' });

      await expect(notifyBorrower(1, 'm', 'Approval')).resolves.toEqual({ id: 100 });
      expect(Notification.create).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    test('with a dedupe key, a repeated event finds the existing row and sends nothing again', async () => {
      User.findByPk.mockResolvedValue(makeUser());
      Notification.findOrCreate
        .mockResolvedValueOnce([{ id: 7 }, true])
        .mockResolvedValueOnce([{ id: 7 }, false]);

      const first = await notifyBorrower(1, 'Approved', 'Approval', 'txn-5-approved');
      const second = await notifyBorrower(1, 'Approved', 'Approval', 'txn-5-approved');

      expect(Notification.findOrCreate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 1, dedupeKey: 'txn-5-approved' } })
      );
      expect(first).toEqual({ id: 7 });
      expect(second).toEqual({ id: 7 });
      expect(Notification.create).not.toHaveBeenCalled();
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    test('the in-app write still succeeds when the user lookup for email/SMS fails', async () => {
      User.findByPk.mockRejectedValue(new Error('db hiccup'));
      await expect(notifyBorrower(1, 'm', 'Approval')).resolves.toEqual({ id: 100 });
    });
  });

  describe('notifyStaff / notifyRoles', () => {
    test('one notification per staff recipient, not one per channel', async () => {
      User.findAll.mockResolvedValue([
        makeUser({ id: 10, userRole: 'Admin' }),
        makeUser({ id: 11, userRole: 'Director' }),
        makeUser({ id: 12, userRole: 'Staff', contactNumber: null })
      ]);
      await notifyStaff('New request', 'New Request');

      expect(User.findAll).toHaveBeenCalledWith({ where: { userRole: ['Admin', 'Director', 'Staff'] } });
      expect(Notification.create).toHaveBeenCalledTimes(3);
      expect(Notification.create.mock.calls.map((c) => c[0].userId)).toEqual([10, 11, 12]);
      expect(Notification.create.mock.calls.every((c) => c[0].deliveryChannel === 'System')).toBe(true);
    });

    test('notifyRoles targets only the given roles', async () => {
      User.findAll.mockResolvedValue([makeUser({ id: 11, userRole: 'Director' })]);
      Notification.findOrCreate.mockResolvedValue([{ id: 1 }, true]);
      await notifyRoles(['Director'], 'Awaiting approval', 'Awaiting Approval', 'txn-3-awaiting-approval');
      expect(User.findAll).toHaveBeenCalledWith({ where: { userRole: ['Director'] } });
      expect(Notification.findOrCreate).toHaveBeenCalledTimes(1);
      expect(Notification.findOrCreate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 11, dedupeKey: 'txn-3-awaiting-approval' } })
      );
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    test('never throws, even if the staff lookup fails', async () => {
      User.findAll.mockRejectedValue(new Error('db down'));
      await expect(notifyStaff('m', 't')).resolves.toBeUndefined();
    });
  });
});
