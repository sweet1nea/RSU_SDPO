'use strict';

// Borrowing workflow (approved RSU SDPO process):
//
//   Borrower submits request ............ Acknowledged
//   SDPO reviews docs + approves ........ Approved   (single step, equally by
//                                          Director/Property Custodian/Admin
//                                          Aide VI — or Rejected / returned
//                                          for correction)
//   Equipment released .................. Released        (→ Overdue if past due)
//   Equipment returned .................. Completed       (or For Resolution if damaged/lost)
//   Replacement workflow ................ Replacement → Resolved → Completed
//
// 'Pending', 'For Review' and 'Returned' remain in the database enum for
// historical rows but are never assigned by current code. 'For Approval' was
// an intermediate status under the old two-step review-then-approve
// workflow (removed 2026-10-02 in favor of single-step approval); it is kept
// in the enum only so any pre-existing row in that status can still be
// resolved via the legacy exports.approve() fallback — no new transaction is
// assigned this status.
const STATUS = Object.freeze({
  PENDING: 'Pending',
  ACKNOWLEDGED: 'Acknowledged',
  FOR_APPROVAL: 'For Approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  RELEASED: 'Released',
  OVERDUE: 'Overdue',
  FOR_RESOLUTION: 'For Resolution',
  REPLACEMENT: 'Replacement',
  RESOLVED: 'Resolved',
  COMPLETED: 'Completed'
});

// Statuses at which an Admin/Staff document review is still outstanding.
const AWAITING_REVIEW = [STATUS.PENDING, STATUS.ACKNOWLEDGED];

// Statuses a transaction only reaches once the Director has approved it.
const POST_APPROVAL = [
  STATUS.APPROVED,
  STATUS.RELEASED,
  'Returned',
  STATUS.OVERDUE,
  STATUS.FOR_RESOLUTION,
  STATUS.REPLACEMENT,
  STATUS.RESOLVED,
  STATUS.COMPLETED
];

// Requests still "open" from the borrower's point of view (not yet a final
// outcome) — used for pending-request counts.
const OPEN_REQUEST = [STATUS.PENDING, STATUS.ACKNOWLEDGED, 'For Review', STATUS.FOR_APPROVAL];

// Equipment physically with the borrower.
const OUT_WITH_BORROWER = [STATUS.RELEASED, STATUS.OVERDUE];

module.exports = { STATUS, AWAITING_REVIEW, POST_APPROVAL, OPEN_REQUEST, OUT_WITH_BORROWER };
