'use strict';

const { Transaction, Borrower, User } = require('../models');
const { txnCode } = require('../helpers/txnCode');
const { Op } = require('sequelize');
const { notifyBorrower, notifyStaff } = require('../helpers/notify');
const { logStatusChange } = require('../helpers/transactionLog');

// Flips Released transactions whose expected return date has passed into
// Overdue. Only matches currently-Released rows, so re-running this on an
// interval never re-notifies a transaction that's already Overdue.
async function runOverdueSweep() {
  const now = new Date();
  const overdue = await Transaction.findAll({
    where: {
      transactionStatus: 'Released',
      expectedReturnDatetime: { [Op.lt]: now }
    },
    include: [{ model: Borrower, as: 'borrower', include: [{ model: User, as: 'user' }] }]
  });

  let flaggedCount = 0;

  // Each transaction is isolated in its own try/catch — without this, one
  // bad row (a save() constraint error, a notify() failure from a borrower
  // with a malformed record) throws out of the loop and silently skips
  // every remaining overdue transaction in the same batch. Since this sweep
  // only runs hourly (see app.js), that means unrelated borrowers' items
  // wouldn't get flagged, logged, or notified about for up to an hour — and
  // if the failure is deterministic (e.g. that one row always errors), it
  // would keep blocking the rest of the batch on every single run.
  for (const txn of overdue) {
    try {
      // Conditional update: if the transaction was returned (or another
      // sweep instance already flipped it) between the query and now, skip
      // it instead of overwriting the newer status or notifying twice.
      const [moved] = await Transaction.update(
        { transactionStatus: 'Overdue' },
        { where: { id: txn.id, transactionStatus: 'Released' } }
      );
      if (!moved) continue;
      await logStatusChange(txn.id, null, 'Released', 'Overdue', 'Automatically flagged overdue by system sweep');

      if (txn.borrower && txn.borrower.user) {
        await notifyBorrower(
          txn.borrower.user.id,
          `Your borrowed equipment (Transaction ${txnCode(txn)}) is now overdue. Please return it to the SDPO office as soon as possible.`,
          'Overdue',
          `txn-${txn.id}-overdue`
        );
      }
      await notifyStaff(`Transaction ${txnCode(txn)} is now overdue.`, 'Overdue', `txn-${txn.id}-overdue`);
      flaggedCount += 1;
    } catch (err) {
      console.error(`Overdue sweep: failed to process transaction #${txn.id}:`, err.message);
    }
  }

  if (flaggedCount) {
    console.log(`Overdue sweep: flagged ${flaggedCount} transaction(s) as Overdue.`);
  }
}

module.exports = { runOverdueSweep };
