'use strict';

const { Transaction, Borrower, User } = require('../models');
const { txnCode } = require('../helpers/txnCode');
const { Op } = require('sequelize');
const { notifyBorrower } = require('../helpers/notify');
const { missingDocuments } = require('../constants/borrowerCategories');

// Reminds a borrower with an active, not-yet-approved request that a
// required document is missing, so the request doesn't silently stall at
// Review/Approval. Matches transactions still in flight (submitted but not
// yet Approved/Rejected/Released/etc.) that haven't already gotten this
// reminder.
//
// Every matching transaction is marked incompleteReqReminderSentDatetime
// once checked — regardless of whether a document was actually missing —
// so a transaction is only ever evaluated once by this sweep. This keeps a
// borrower with complete documents from being re-checked every hour, but
// also means a borrower who uploads the missing document *after* being
// reminded will not get a follow-up "all clear" message; that is out of
// scope here per the task spec.
async function runIncompleteRequirementsSweep() {
  const active = await Transaction.findAll({
    where: {
      transactionStatus: { [Op.in]: ['Acknowledged', 'For Review', 'For Approval'] },
      incompleteReqReminderSentDatetime: null
    },
    include: [{ model: Borrower, as: 'borrower', include: [{ model: User, as: 'user' }] }]
  });

  let sentCount = 0;

  for (const txn of active) {
    try {
      const borrower = txn.borrower;

      if (borrower && borrower.user) {
        // Same per-borrower-type rules the request wizard and staff review use.
        const missing = missingDocuments(borrower);
        if (missing.length) {
          await notifyBorrower(
            borrower.user.id,
            `Your borrowing request (Transaction ${txnCode(txn)}) is missing: ${missing.join(', ')}. Please upload it as soon as possible so your request isn't delayed.`,
            'Incomplete Requirements',
            `txn-${txn.id}-incomplete-requirements`
          );
          sentCount += 1;
        }
      }

      // Mark checked either way so this transaction is never re-evaluated.
      txn.incompleteReqReminderSentDatetime = new Date();
      await txn.save();
    } catch (err) {
      console.error(`Incomplete requirements sweep: failed to process transaction #${txn.id}:`, err.message);
    }
  }

  if (sentCount) {
    console.log(`Incomplete requirements sweep: sent ${sentCount} reminder(s) for missing requirements.`);
  }
}

module.exports = { runIncompleteRequirementsSweep };
