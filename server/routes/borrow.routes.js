const express = require('express');
const catchAsync = require('../helpers/catchAsync');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const ctrl = require('../controllers/borrow.controller');

const router = express.Router();
const staffOnly = roleMiddleware(['Admin', 'Director', 'Staff']);
const borrowerOnly = roleMiddleware(['Borrower']);

router.use(authMiddleware);
router.get('/', staffOnly, catchAsync(ctrl.list));
router.get('/mine', borrowerOnly, catchAsync(ctrl.mine));
router.get('/eligibility', borrowerOnly, catchAsync(ctrl.eligibility));
router.post('/', staffOnly, catchAsync(ctrl.create));
router.post('/request', borrowerOnly, catchAsync(ctrl.createSelfRequest));
router.patch('/:id/cancel', borrowerOnly, catchAsync(ctrl.cancelSelfRequest));
// Single approval step (2026-10-02): the Director, Property Custodian, and
// Administrative Aide VI (Admin/Director/Staff) have identical access to
// review/approve a request — no separate reviewer-vs-director gate.
// '/approve' is kept only as a legacy fallback for any request that was
// already sitting in the old two-step "For Approval" status before this
// change; new requests are approved entirely through '/review'.
router.patch('/:id/review', staffOnly, catchAsync(ctrl.review));
router.patch('/:id/approve', staffOnly, catchAsync(ctrl.approve));
router.patch('/:id/reject', staffOnly, catchAsync(ctrl.reject));
router.post('/:id/release', staffOnly, catchAsync(ctrl.release));
router.patch('/:id/complete', staffOnly, catchAsync(ctrl.complete));

module.exports = router;
