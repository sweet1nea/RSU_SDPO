'use strict';

const { Transaction, TransactionLog } = require('../models');
const { STATUS, AWAITING_REVIEW } = require('../constants/transactionStatus');
const { logStatusChange } = require('./transactionLog');
const { notifyStaff } = require('./notify');

// Remark written when a borrower re-uploads documents after SDPO returned a
// request for correction. It is the marker lastCorrectionLog() uses to tell
// "waiting for the borrower to fix it" from "borrower fixed it, waiting for
// SDPO to review again" — both are logged as Acknowledged -> Acknowledged
// because a correction never changes the request's status.
const REUPLOAD_REMARK = 'Documents re-uploaded by borrower';

// The "Return for Correction" log entry the request is currently waiting on,
// or null. A correction logs oldStatus === newStatus === 'Acknowledged', same
// as the first log every transaction gets at creation, so it is told apart by
// order: any LATER log of that shape is a correction. A borrower re-upload
// (REUPLOAD_REMARK) logged after it means the borrower has responded, so the
// request is no longer waiting on them.
function lastCorrectionLog(t) {
  if (!AWAITING_REVIEW.includes(t.transactionStatus)) return null;
  const logs = (t.logs || []).slice().sort((a, b) => new Date(a.changeDatetime) - new Date(b.changeDatetime));
  if (logs.length < 2) return null;
  const latest = logs[logs.length - 1];
  if (latest.remarks === REUPLOAD_REMARK) return null;
  return latest.oldStatus === STATUS.ACKNOWLEDGED && latest.newStatus === STATUS.ACKNOWLEDGED ? latest : null;
}

// Called after a borrower saves a new document. For every one of their
// requests still waiting on a correction, records that they responded and
// tells staff the request is ready for review again. Never throws — a failure
// here must not fail the upload itself.
async function recordResubmission(borrower) {
  try {
    const txns = await Transaction.findAll({
      where: { borrowerId: borrower.id, transactionStatus: AWAITING_REVIEW },
      include: [{ model: TransactionLog, as: 'logs' }]
    });
    const name = [borrower.firstName, borrower.lastName].filter(Boolean).join(' ') || 'A borrower';
    for (const t of txns) {
      const correction = lastCorrectionLog(t);
      if (!correction) continue;
      // eslint-disable-next-line no-await-in-loop
      await logStatusChange(t.id, borrower.userId, STATUS.ACKNOWLEDGED, STATUS.ACKNOWLEDGED, REUPLOAD_REMARK);
      // eslint-disable-next-line no-await-in-loop
      await notifyStaff(
        `${name} re-uploaded documents for Transaction #${t.id}. The request is ready for review again.`,
        'Documents Re-uploaded',
        `txn-${t.id}-reupload-${correction.id}`
      );
    }
  } catch (err) {
    console.error('[correction] Failed to record resubmission:', err.message || err);
  }
}

module.exports = { REUPLOAD_REMARK, lastCorrectionLog, recordResubmission };
