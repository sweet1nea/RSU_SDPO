const express = require('express');
const catchAsync = require('../helpers/catchAsync');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const ctrl = require('../controllers/borrow.controller');

const router = express.Router();
const staffOnly = roleMiddleware(['Admin', 'Director', 'Staff']);
// Document review/verification is Admin/Staff work; approval is the
// Director's (Admin as superuser). The Director can view everything but
// doesn't perform the Staff review step itself.
const reviewerOnly = roleMiddleware(['Admin', 'Staff']);
const directorOnly = roleMiddleware(['Admin', 'Director']);
const borrowerOnly = roleMiddleware(['Borrower']);

router.use(authMiddleware);
router.get('/', staffOnly, catchAsync(ctrl.list));
router.get('/mine', borrowerOnly, catchAsync(ctrl.mine));
router.get('/eligibility', borrowerOnly, catchAsync(ctrl.eligibility));
router.post('/', staffOnly, catchAsync(ctrl.create));
router.post('/request', borrowerOnly, catchAsync(ctrl.createSelfRequest));
router.patch('/:id/cancel', borrowerOnly, catchAsync(ctrl.cancelSelfRequest));
router.patch('/:id/review', reviewerOnly, catchAsync(ctrl.review));
router.patch('/:id/approve', directorOnly, catchAsync(ctrl.approve));
router.patch('/:id/reject', staffOnly, catchAsync(ctrl.reject));
router.post('/:id/release', staffOnly, catchAsync(ctrl.release));
router.patch('/:id/complete', staffOnly, catchAsync(ctrl.complete));

module.exports = router;
