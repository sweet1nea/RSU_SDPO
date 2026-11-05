'use strict';

const { Transaction, Borrower, User } = require('../models');
const { txnCode } = require('../helpers/txnCode');
const { Op } = require('sequelize');
const { notifyBorrower } = require('../helpers/notify');
const { formatDateTime } = require('../helpers/dateHelper');

// Reminds a borrower their equipment is due back soon, BEFORE it becomes
// overdue (overdueSweep.js only fires AFTER the due date passes). Matches
// Released transactions whose expected return date falls within the next
// 24 hours. Two guards keep this from double-notifying:
//   - the [Op.between] window itself: once expectedReturnDatetime slips
//     past `now`, the transaction falls out of this query and is instead
//     picked up by the *existing* overdue sweep once its status flips.
//   - dueReminderSentDatetime: null — since status doesn't change here
//     (unlike overdueSweep, which uses the status flip itself as its
//     dedupe guard), an explicit timestamp column is needed to remember
//     that this transaction already got its one reminder.
async function runDueDateReminderSweep() {
  const now = new Date();
  const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const dueSoon = await Transaction.findAll({
    where: {
      transactionStatus: 'Released',
      expectedReturnDatetime: { [Op.between]: [now, in24Hours] },
      dueReminderSentDatetime: null
    },
    include: [{ model: Borrower, as: 'borrower', include: [{ model: User, as: 'user' }] }]
  });

  let sentCount = 0;

  for (const txn of dueSoon) {
    try {
      if (txn.borrower && txn.borrower.user) {
        const dueText = txn.expectedReturnDatetime
          ? formatDateTime(txn.expectedReturnDatetime)
          : 'soon';
        await notifyBorrower(
          txn.borrower.user.id,
          `Reminder: your borrowed equipment (Transaction ${txnCode(txn)}) is due back on ${dueText}. Please return it to the SDPO office on time.`,
          'Due Date Reminder',
          `txn-${txn.id}-due-reminder`
        );
      }

      txn.dueReminderSentDatetime = new Date();
      await txn.save();
      sentCount += 1;
    } catch (err) {
      console.error(`Due date reminder sweep: failed to process transaction #${txn.id}:`, err.message);
    }
  }

  if (sentCount) {
    console.log(`Due date reminder sweep: sent ${sentCount} reminder(s) for equipment due within 24 hours.`);
  }
}

module.exports = { runDueDateReminderSweep };
