'use strict';

// Unit tests for server/controllers/notification.controller.js — the
// endpoints behind /api/notifications (list, markRead, markAllRead, remove).
// All Sequelize models are mocked; nothing here touches a real database.

jest.mock('../../models', () => require('../fixtures/mockModels')());

const { Notification } = require('../../models');
const ctrl = require('../../controllers/notification.controller');

function mockRes() {
  return { json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DELETE /api/notifications/:id (remove)', () => {
  test('deletes a read notification belonging to the requesting user', async () => {
    const fakeNotif = { id: 5, userId: 1, isRead: true, destroy: jest.fn().mockResolvedValue() };
    Notification.findOne.mockResolvedValue(fakeNotif);

    const req = { params: { id: '5' }, user: { id: 1 } };
    const res = mockRes();
    await ctrl.remove(req, res);

    expect(Notification.findOne).toHaveBeenCalledWith({ where: { id: '5', userId: 1 } });
    expect(fakeNotif.destroy).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { message: 'Notification deleted.' } });
  });

  test('rejects with 404 when no notification matches the id/userId pair', async () => {
    Notification.findOne.mockResolvedValue(null);

    const req = { params: { id: '999' }, user: { id: 1 } };
    await expect(ctrl.remove(req, mockRes())).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rejects with 400 and never destroys an unread notification', async () => {
    const fakeNotif = { id: 5, userId: 1, isRead: false, destroy: jest.fn() };
    Notification.findOne.mockResolvedValue(fakeNotif);

    const req = { params: { id: '5' }, user: { id: 1 } };
    await expect(ctrl.remove(req, mockRes())).rejects.toMatchObject({ statusCode: 400 });
    expect(fakeNotif.destroy).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/notifications/read (removeAllRead)', () => {
  test('destroys only the requesting user\'s READ in-app notifications', async () => {
    Notification.destroy.mockResolvedValue(3);
    const res = mockRes();
    await ctrl.removeAllRead({ user: { id: 9 } }, res);

    expect(Notification.destroy).toHaveBeenCalledWith({
      where: { userId: 9, deliveryChannel: 'System', isRead: true }
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { deleted: 3, message: 'Read notifications deleted.' }
    });
  });

  test('reports nothing deleted when there are no read notifications', async () => {
    Notification.destroy.mockResolvedValue(0);
    const res = mockRes();
    await ctrl.removeAllRead({ user: { id: 9 } }, res);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { deleted: 0, message: 'No read notifications to delete.' }
    });
  });
});

describe('GET /api/notifications (list)', () => {
  test('returns serialized notifications scoped to req.user.id, newest first', async () => {
    Notification.findAll.mockResolvedValue([
      { id: 2, notificationType: 'Approval', message: 'Approved', deliveryChannel: 'In-App', isRead: false, sentAt: '2026-01-02' },
      { id: 1, notificationType: 'Release', message: 'Released', deliveryChannel: 'Email', isRead: true, sentAt: '2026-01-01' }
    ]);

    const req = { user: { id: 7 } };
    const res = mockRes();
    await ctrl.list(req, res);

    expect(Notification.findAll).toHaveBeenCalledWith({
      // Only in-app rows; legacy per-channel Email/SMS copies are not notifications.
      where: { userId: 7, deliveryChannel: 'System' },
      order: [['id', 'DESC']]
    });
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data).toEqual([
      { id: 2, type: 'Approval', message: 'Approved', isRead: false, sentAt: '2026-01-02' },
      { id: 1, type: 'Release', message: 'Released', isRead: true, sentAt: '2026-01-01' }
    ]);
  });
});

describe('PATCH /api/notifications/:id/read (markRead)', () => {
  test('marks a matching notification as read and saves it', async () => {
    const fakeNotif = { id: 3, notificationType: 'Approval', message: 'Approved', deliveryChannel: 'In-App', isRead: false, sentAt: '2026-01-01', save: jest.fn().mockResolvedValue() };
    Notification.findOne.mockResolvedValue(fakeNotif);

    const req = { params: { id: '3' }, user: { id: 1 } };
    const res = mockRes();
    await ctrl.markRead(req, res);

    expect(Notification.findOne).toHaveBeenCalledWith({ where: { id: '3', userId: 1 } });
    expect(fakeNotif.isRead).toBe(true);
    expect(fakeNotif.save).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ id: 3, isRead: true }) });
  });

  test('rejects with 404 when no notification matches the id/userId pair', async () => {
    Notification.findOne.mockResolvedValue(null);
    const req = { params: { id: '999' }, user: { id: 1 } };
    await expect(ctrl.markRead(req, mockRes())).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('PATCH /api/notifications/read-all (markAllRead)', () => {
  test('updates all unread notifications for the requesting user', async () => {
    Notification.update = jest.fn().mockResolvedValue([1]);
    const req = { user: { id: 1 } };
    const res = mockRes();
    await ctrl.markAllRead(req, res);

    expect(Notification.update).toHaveBeenCalledWith(
      { isRead: true },
      { where: { userId: 1, isRead: false } }
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { message: 'All notifications marked as read.' } });
  });
});
