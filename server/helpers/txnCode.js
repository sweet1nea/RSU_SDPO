'use strict';

const { toPhtWallClock } = require('./dateHelper');

// Public transaction code shown to users, e.g. TN53-2026 (id + request year
// in Philippine time). Notifications and emails use this instead of the bare
// database id so the number matches the one on the transactions list.
function txnCode(t) {
  const year = toPhtWallClock(t.requestDatetime || t.createdAt || new Date()).getUTCFullYear();
  return `TN${t.id}-${year}`;
}

// For call sites that only hold a transaction id.
async function txnCodeById(id) {
  const { Transaction } = require('../models');
  const t = await Transaction.findByPk(id);
  return t ? txnCode(t) : `TN${id}`;
}

module.exports = { txnCode, txnCodeById };
