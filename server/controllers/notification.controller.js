'use strict';

const { Notification } = require('../models');

function serialize(n) {
  return {
    id: n.id,
    type: n.notificationType,
    message: n.message,
    isRead: !!n.isRead,
    sentAt: n.sentAt
  };
}

// Only the in-app ('System') row is a notification the user sees. Older
// rows written per delivery channel ('Email'/'SMS' copies of the same
// event, from before helpers/notify.js was fixed) are delivery records,
// not separate notifications, so they're excluded here.
exports.list = async (req, res) => {
  const rows = await Notification.findAll({
    where: { userId: req.user.id, deliveryChannel: 'System' },
    order: [['id', 'DESC']]
  });
  res.json({ success: true, data: rows.map(serialize) });
};

exports.markRead = async (req, res) => {
  const notif = await Notification.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!notif) {
    const err = new Error('Notification not found');
    err.statusCode = 404;
    throw err;
  }
  notif.isRead = true;
  await notif.save();
  res.json({ success: true, data: serialize(notif) });
};

exports.markAllRead = async (req, res) => {
  await Notification.update({ isRead: true }, { where: { userId: req.user.id, isRead: false } });
  res.json({ success: true, data: { message: 'All notifications marked as read.' } });
};

exports.remove = async (req, res) => {
  const notif = await Notification.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!notif) {
    const err = new Error('Notification not found');
    err.statusCode = 404;
    throw err;
  }
  if (!notif.isRead) {
    const err = new Error('Mark this notification as read before deleting it.');
    err.statusCode = 400;
    throw err;
  }
  await notif.destroy();
  res.json({ success: true, data: { message: 'Notification deleted.' } });
};

// Deletes every notification the user has already read. Unread ones are
// never touched — a notification must be read before it can be deleted.
// Only the visible in-app ('System') rows are removed, matching list().
exports.removeAllRead = async (req, res) => {
  const deleted = await Notification.destroy({
    where: { userId: req.user.id, deliveryChannel: 'System', isRead: true }
  });
  res.json({
    success: true,
    data: { deleted, message: deleted ? 'Read notifications deleted.' : 'No read notifications to delete.' }
  });
};

exports.serialize = serialize;
