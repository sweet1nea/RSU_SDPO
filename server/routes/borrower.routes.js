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

// Direct-to-Supabase-Storage upload (2026-10-03): the borrower's browser
// uploads the file straight to Storage using a short-lived signed URL,
// never passing it through this server at all — the only way to get past
// Vercel's hard 4.5MB-per-request body ceiling (see uploadMiddleware.js),
// which the route above stays under instead. /sign hands out the signed
// URL; /confirm is called after the browser's own PUT to Storage succeeds,
// and is where size/type are actually enforced (see
// borrower.controller.js#confirmDocumentUpload) — nothing from /sign alone
// is trusted. Borrower-only: this is the self-service wizard/re-upload
// path; the staff walk-in upload above is unchanged.
router.post('/me/documents/sign', authMiddleware, borrowerOnly, catchAsync(ctrl.createDocumentUploadUrl));
router.post('/me/documents/confirm', authMiddleware, borrowerOnly, catchAsync(ctrl.confirmDocumentUpload));

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
