'use strict';

const fs = require('fs');
const path = require('path');
const { Borrower, User } = require('../models');
const { requirementsFor, missingDocuments } = require('../constants/borrowerCategories');
const { getClient } = require('../config/supabase');

const DOCUMENTS_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'borrower-documents';

function serialize(borrower) {
  return {
    id: borrower.id,
    firstName: borrower.firstName,
    lastName: borrower.lastName,
    middleName: borrower.middleName,
    collegeOrUnit: borrower.collegeOrUnit,
    borrowerCategory: borrower.borrowerCategory,
    directorAuthorizationStatus: borrower.directorAuthorizationStatus,
    user: borrower.user
      ? { id: borrower.user.id, emailAddress: borrower.user.emailAddress, accountStatus: borrower.user.accountStatus }
      : null
  };
}

exports.list = async (req, res) => {
  const rows = await Borrower.findAll({
    include: [{ model: User, as: 'user' }],
    order: [['lastName', 'ASC'], ['firstName', 'ASC']]
  });
  res.json({ success: true, data: rows.map(serialize) });
};

// Upload state plus what this borrower's type requires, so every screen
// (borrower wizard, staff review drawer) uses the same server-side rules.
function documentStatus(borrower) {
  const requirements = requirementsFor(borrower && borrower.borrowerCategory);
  return {
    borrowerCategory: borrower ? borrower.borrowerCategory : null,
    validIdUploaded: !!(borrower && borrower.validIdPath),
    authorizationDocumentUploaded: !!(borrower && borrower.authorizationDocumentPath),
    validIdRequired: requirements.needsValidId,
    authorizationDocumentLabel: requirements.documentLabel,
    missing: borrower ? missingDocuments(borrower) : []
  };
}

async function findOwnBorrower(req) {
  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  if (!borrower) {
    const err = new Error('Only borrower accounts have documents on file');
    err.statusCode = 403;
    throw err;
  }
  return borrower;
}

async function findBorrowerById(req) {
  const borrower = await Borrower.findByPk(req.params.id);
  if (!borrower) {
    const err = new Error('Borrower not found');
    err.statusCode = 404;
    throw err;
  }
  return borrower;
}

exports.myDocumentStatus = async (req, res) => {
  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  res.json({ success: true, data: documentStatus(borrower) });
};

async function uploadToStorage(folder, field, ownerId, file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const key = path.posix.join(folder, `borrower-${ownerId}-${field}-${Date.now()}${ext}`);
  const { error } = await getClient()
    .storage.from(DOCUMENTS_BUCKET)
    .upload(key, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) {
    const err = new Error(`Failed to upload ${field}: ${error.message}`);
    err.statusCode = 502;
    throw err;
  }
  return key;
}

// Shared by both upload entry points below. ownerId keys the storage path —
// the borrower's own userId when known, so a walk-in borrower's documents
// land under their own id in Storage regardless of which staff member
// happened to upload them (not the staff member's own id).
async function saveUploadedDocuments(borrower, ownerId, files) {
  if (!files.validId && !files.authorizationDocument) {
    const err = new Error('No file uploaded — attach a valid ID or authorization document');
    err.statusCode = 400;
    throw err;
  }

  if (files.validId) {
    borrower.validIdPath = await uploadToStorage('valid_ids', 'validId', ownerId, files.validId[0]);
  }
  if (files.authorizationDocument) {
    borrower.authorizationDocumentPath = await uploadToStorage(
      'authorization_documents',
      'authorizationDocument',
      ownerId,
      files.authorizationDocument[0]
    );
  }
  await borrower.save();
  await borrower.reload();
  return borrower;
}

// Each field is independent — a borrower can upload just the ID now and the
// authorization document later (or both together); requiredness for actually
// submitting a request is enforced client-side against this saved state.
exports.uploadDocuments = async (req, res) => {
  const borrower = await findOwnBorrower(req);
  const saved = await saveUploadedDocuments(borrower, req.user.id, req.files || {});
  res.json({ success: true, data: documentStatus(saved) });
};

// Staff-facing equivalent of the above, for a borrower who can't (or
// hasn't) self-uploaded — chiefly a walk-in borrower a Property
// Custodian/Admin Aide registers in person (server/controllers/borrow.
// controller.js#create). Without this, review()'s document-verification
// gate (missingDocuments) had no way to ever be satisfied for a walk-in
// transaction: the borrower's own /me/documents route is restricted to
// their own account, and a walk-in may not have — or use — one at all.
// Same validation, same storage layout, same response shape as the
// self-service upload; only who the target borrower is differs.
exports.uploadDocumentsForBorrower = async (req, res) => {
  const borrower = await findBorrowerById(req);
  const saved = await saveUploadedDocuments(borrower, borrower.userId || `staff-${req.user.id}`, req.files || {});
  res.json({ success: true, data: documentStatus(saved) });
};

// ---- Staff-facing document review (transaction drawer "View Document") ----

const DOCUMENT_FIELD_BY_TYPE = { 'valid-id': 'validIdPath', 'authorization-document': 'authorizationDocumentPath' };

exports.staffDocumentStatus = async (req, res) => {
  const borrower = await Borrower.findByPk(req.params.id);
  if (!borrower) {
    const err = new Error('Borrower not found');
    err.statusCode = 404;
    throw err;
  }
  res.json({ success: true, data: documentStatus(borrower) });
};

exports.downloadDocument = async (req, res) => {
  const field = DOCUMENT_FIELD_BY_TYPE[req.params.type];
  if (!field) {
    const err = new Error('Unknown document type — expected "valid-id" or "authorization-document"');
    err.statusCode = 400;
    throw err;
  }

  const borrower = await Borrower.findByPk(req.params.id);
  if (!borrower || !borrower[field]) {
    const err = new Error('That document has not been submitted');
    err.statusCode = 404;
    throw err;
  }

  const file = await readDocument(borrower[field]);
  if (!file) {
    return res.status(404).json({ success: false, message: 'Document file is missing in storage' });
  }
  // Private, per-user content: never cache, and never let the browser guess
  // a different content type than the one stored.
  res.set('Content-Type', file.contentType);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(file.buffer);
};

// Documents live in the private Supabase Storage bucket. Uploads made
// before the move to Supabase were written to server/uploads/<folder>/ with
// the same relative key, so those are served from disk when the bucket
// doesn't have them — previously they returned "missing" and could never
// be reviewed. The key comes from the database (never the request), and is
// still confined to the uploads directory.
const LOCAL_UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

async function readDocument(key) {
  try {
    const { data, error } = await getClient().storage.from(DOCUMENTS_BUCKET).download(key);
    if (!error && data) {
      return {
        buffer: Buffer.from(await data.arrayBuffer()),
        contentType: data.type || CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream'
      };
    }
  } catch (err) {
    console.error('[documents] Storage download failed:', err.message);
  }

  const resolved = path.resolve(LOCAL_UPLOADS_DIR, String(key).replace(/^[/\\]+/, ''));
  if (!resolved.startsWith(LOCAL_UPLOADS_DIR + path.sep)) return null;
  try {
    const buffer = await fs.promises.readFile(resolved);
    return { buffer, contentType: CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream' };
  } catch (e) {
    return null;
  }
}
