'use strict';

const { Borrower } = require('../models');

// Display name used in the "Dear <name>," line of outgoing emails: the
// borrower's own name when they have a profile, otherwise the account's
// username (staff accounts), otherwise null (the template falls back to
// "User"). Never throws — a lookup failure must not block an email.
async function recipientNameFor(user) {
  if (!user) return null;
  try {
    const b = await Borrower.findOne({ where: { userId: user.id } });
    if (b) return [b.firstName, b.lastName].filter(Boolean).join(' ');
  } catch (e) {
    /* fall through to username */
  }
  return user.username || null;
}

module.exports = { recipientNameFor };
