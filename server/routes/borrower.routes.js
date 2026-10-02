const express = require('express');
const catchAsync = require('../helpers/catchAsync');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const uploadDocuments = require('../middlewares/uploadMiddleware');
const ctrl = require('../controllers/borrower.controller');

const router = express.Router();
const borrowerOnly = roleMiddleware(['Borrower']);
const staffOnly = roleMiddleware(['Admin', 'Director', 'Staff']);

router.get('/', authMiddleware, staffOnly, catchAsync(ctrl.list));
// Staff-only quick-create for a walk-in borrower who has no account yet —
// see borrower.controller.js#create for why this differs from self-service
// registration (auth.controller.js#register).
router.post('/', authMiddleware, staffOnly, catchAsync(ctrl.create));
router.get('/me/documents', authMiddleware, borrowerOnly, catchAsync(ctrl.myDocumentStatus));
router.post('/me/documents', authMiddleware, borrowerOnly, uploadDocuments, catchAsync(ctrl.uploadDocuments));

// Staff reviewing a borrower's submitted ID/authorization document from the
// transaction drawer. Routes above (/me/documents) must stay registered
// first so they aren't shadowed by these :id params.
router.get('/:id/documents', authMiddleware, staffOnly, catchAsync(ctrl.staffDocumentStatus));
router.get('/:id/documents/:type', authMiddleware, staffOnly, catchAsync(ctrl.downloadDocument));

// Staff uploading a walk-in borrower's ID/authorization document on their
// behalf — e.g. a photo taken at the counter — since that borrower may not
// have (or use) their own account to upload it themselves. This is what
// lets review()'s document-verification step ever pass for a transaction
// created via POST /api/borrow (the walk-in path).
router.post('/:id/documents', authMiddleware, staffOnly, uploadDocuments, catchAsync(ctrl.uploadDocumentsForBorrower));

module.exports = router;
