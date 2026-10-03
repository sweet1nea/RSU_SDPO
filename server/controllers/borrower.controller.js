'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Borrower, User, sequelize } = require('../models');
const { requirementsFor, missingDocuments, BORROWER_CATEGORIES } = require('../constants/borrowerCategories');
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

function slugPart(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
}

// Generates a unique, human-readable username for a borrower who isn't
// choosing one themselves (see exports.create below). Collisions are
// vanishingly unlikely (a random hex suffix after the first try) but
// User.username is a unique column, so this still confirms availability
// against the database rather than assuming the suffix is enough.
async function uniqueWalkinUsername(firstName, lastName) {
  const base = `walkin.${slugPart(firstName)}${slugPart(lastName) ? '.' + slugPart(lastName) : ''}` || 'walkin.borrower';
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}.${crypto.randomBytes(3).toString('hex')}`;
    // eslint-disable-next-line no-await-in-loop
    const taken = await User.findOne({ where: { username: candidate } });
    if (!taken) return candidate;
  }
  return `walkin.${crypto.randomBytes(6).toString('hex')}`;
}

// Staff-facing quick-create for a true walk-in borrower who has no account
// yet — backs the New Transaction modal's "+ New Borrower" flow. Mirrors
// auth.controller.js#register's User+Borrower creation (same two tables,
// same atomicity via sequelize.transaction) but skips the parts of
// self-registration that don't apply to a staff-verified counter
// interaction: the borrower doesn't choose their own username (one is
// generated below) and no verification email is sent (emailVerified
// defaults true, same as every other non-self-registered account) since
// staff already checked the person and their documents in person before
// creating the record. Staff DO set the initial password here (by request
// — a borrower created with an unknown, randomly-generated password had no
// practical way to ever sign in): staff relay it to the borrower at the
// counter, and the borrower can change it to one only they know anytime
// afterward from Settings → Change Password (user.controller.js#
// changePassword), the same self-service flow every other account uses.
exports.create = async (req, res) => {
  const { firstName, lastName, collegeOrUnit, borrowerCategory, emailAddress, contactNumber, password } = req.body;
  if (!firstName || !collegeOrUnit || !borrowerCategory || !emailAddress || !password) {
    const err = new Error('firstName, collegeOrUnit, borrowerCategory, emailAddress, and password are required');
    err.statusCode = 400;
    throw err;
  }
  // Same minimum as the self-service change-password flow
  // (user.controller.js#changePassword) — one password-strength rule for
  // every account in the system, not a separate one for walk-ins.
  if (password.length < 8) {
    const err = new Error('Password must be at least 8 characters long');
    err.statusCode = 400;
    throw err;
  }
  if (!BORROWER_CATEGORIES.includes(borrowerCategory)) {
    const err = new Error(`borrowerCategory must be one of: ${BORROWER_CATEGORIES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const existingEmail = await User.findOne({ where: { emailAddress } });
  if (existingEmail) {
    const err = new Error('A borrower with that email address already has an account — search for them above instead of creating a new one.');
    err.statusCode = 409;
    throw err;
  }

  const username = await uniqueWalkinUsername(firstName, lastName);
  const passwordHash = await bcrypt.hash(password, 10);

  const borrowerId = await sequelize.transaction(async (t) => {
    const user = await User.create(
      {
        username,
        emailAddress,
        password: passwordHash,
        userRole: 'Borrower',
        contactNumber: contactNumber || null,
        emailVerified: true
      },
      { transaction: t }
    );
    const borrower = await Borrower.create(
      { userId: user.id, firstName, lastName: lastName || '', collegeOrUnit, borrowerCategory },
      { transaction: t }
    );
    return borrower.id;
  });

  const withUser = await Borrower.findByPk(borrowerId, { include: [{ model: User, as: 'user' }] });
  res.status(201).json({ success: true, data: serialize(withUser) });
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

// Best-effort cleanup only — never lets a storage hiccup block the upload
// that already succeeded. A stale document (nothing in the app points to
// it anymore) is harmless to the review workflow either way; this just
// stops it from sitting in the bucket forever.
async function deleteStorageObjectQuietly(key) {
  if (!key) return;
  try {
    await getClient().storage.from(DOCUMENTS_BUCKET).remove([key]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Failed to delete superseded document "${key}" from storage:`, err.message || err);
  }
}

// Shared by both upload entry points below. ownerId keys the storage path —
// the borrower's own userId when known, so a walk-in borrower's documents
// land under their own id in Storage regardless of which staff member
// happened to upload them (not the staff member's own id).
//
// Documents live on the Borrower record itself, not per-transaction (every
// transaction's document review reads these same two fields live — see
// exports.downloadDocument) — there is no history/versioning. Re-uploading
// (e.g. after a request was returned for correction) therefore replaces
// what every pending and past transaction shows for this borrower, not
// just the one that triggered the re-upload. Each upload writes to a new,
// uniquely-named key (see uploadToStorage) and only swaps the borrower's
// pointer once that succeeds — the previous object is then deleted from
// Storage so it doesn't sit there unreferenced indefinitely.
async function saveUploadedDocuments(borrower, ownerId, files) {
  if (!files.validId && !files.authorizationDocument) {
    const err = new Error('No file uploaded — attach a valid ID or authorization document');
    err.statusCode = 400;
    throw err;
  }

  const previousValidId = borrower.validIdPath;
  const previousAuthDoc = borrower.authorizationDocumentPath;

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

  // Only after the save commits — the borrower record must already point
  // at the new file before the old one is removed.
  if (files.validId && previousValidId && previousValidId !== borrower.validIdPath) {
    await deleteStorageObjectQuietly(previousValidId);
  }
  if (files.authorizationDocument && previousAuthDoc && previousAuthDoc !== borrower.authorizationDocumentPath) {
    await deleteStorageObjectQuietly(previousAuthDoc);
  }

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

// ---- Direct-to-Supabase-Storage upload (2026-10-03) ----
//
// The route above (uploadDocuments) sends the file through this server in
// one multipart request, which is why it's capped at 2MB — Vercel hard-caps
// every serverless function's total request body at 4.5MB, shared between
// both document fields in that one request (see uploadMiddleware.js). The
// two endpoints below let the borrower's browser upload straight to
// Supabase Storage instead: this server only ever hands out a short-lived
// signed upload URL (/sign) and, once Storage confirms the file actually
// landed (/confirm), swaps the borrower's pointer to it — the file itself
// never touches a Vercel function, so the 4.5MB ceiling doesn't apply and
// the cap below (MAX_UPLOAD_BYTES) is a plain app-level choice again.
//
// Nothing from /sign is trusted: a borrower could ask for a signed URL and
// never use it, or (in principle) tamper with what they upload before
// calling /confirm. /confirm re-reads the object's real size and MIME type
// back from Storage itself before accepting it — not whatever the browser
// claimed — and deletes + rejects anything that doesn't hold up.
const ALLOWED_UPLOAD_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // .docx
];
const EXT_BY_UPLOAD_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
};
// field (matches the multer field names used by the request-body route
// above, 'validId'/'authorizationDocument') -> [storage folder, Borrower column]
const UPLOAD_FIELD_MAP = {
  validId: ['valid_ids', 'validIdPath'],
  authorizationDocument: ['authorization_documents', 'authorizationDocumentPath']
};
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB — see the file-level comment above for why this no longer has to match Vercel's limit.

function assertKnownField(field) {
  if (!UPLOAD_FIELD_MAP[field]) {
    const err = new Error('field must be "validId" or "authorizationDocument"');
    err.statusCode = 400;
    throw err;
  }
}

exports.createDocumentUploadUrl = async (req, res) => {
  await findOwnBorrower(req); // 403s if this account has no Borrower row, same as the request-body route
  const { field, contentType, size } = req.body;
  assertKnownField(field);
  if (!ALLOWED_UPLOAD_MIME.includes(contentType)) {
    const err = new Error('Only JPG, PNG, WEBP, PDF, or DOCX files are allowed');
    err.statusCode = 400;
    throw err;
  }
  const numericSize = Number(size);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    const err = new Error('size (in bytes) is required');
    err.statusCode = 400;
    throw err;
  }
  // A first, cheap rejection on the declared size — purely for a fast UI
  // error before the browser spends time uploading. Not relied on for
  // anything: confirmDocumentUpload re-checks the real size Storage
  // actually received before this upload is ever accepted.
  if (numericSize > MAX_UPLOAD_BYTES) {
    const err = new Error(`Files must be ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB or smaller.`);
    err.statusCode = 400;
    throw err;
  }

  const [folder] = UPLOAD_FIELD_MAP[field];
  const ext = EXT_BY_UPLOAD_MIME[contentType];
  const key = path.posix.join(folder, `borrower-${req.user.id}-${field}-${Date.now()}${ext}`);

  const { data, error } = await getClient().storage.from(DOCUMENTS_BUCKET).createSignedUploadUrl(key);
  if (error) {
    const err = new Error(`Failed to prepare upload: ${error.message}`);
    err.statusCode = 502;
    throw err;
  }

  res.json({ success: true, data: { uploadUrl: data.signedUrl, key, field } });
};

exports.confirmDocumentUpload = async (req, res) => {
  const borrower = await findOwnBorrower(req);
  const { field, key } = req.body;
  assertKnownField(field);
  const [folder, column] = UPLOAD_FIELD_MAP[field];

  // The key must be one this exact borrower could actually have been
  // handed by createDocumentUploadUrl above — stops one borrower confirming
  // (and thereby pointing their own record at) an arbitrary storage path,
  // including another borrower's file.
  const expectedPrefix = `${folder}/borrower-${req.user.id}-${field}-`;
  if (typeof key !== 'string' || !key.startsWith(expectedPrefix)) {
    const err = new Error('That upload key does not belong to you');
    err.statusCode = 403;
    throw err;
  }

  const filename = key.slice(folder.length + 1);
  const { data: listing, error: listError } = await getClient().storage.from(DOCUMENTS_BUCKET).list(folder, { search: filename });
  const found = !listError && listing ? listing.find((f) => f.name === filename) : null;
  if (!found) {
    const err = new Error('Upload not found in storage — it may have failed or not finished yet');
    err.statusCode = 404;
    throw err;
  }

  // Authoritative checks against what Storage actually received, not
  // whatever createDocumentUploadUrl was told beforehand.
  const actualSize = found.metadata && found.metadata.size;
  if (Number.isFinite(actualSize) && actualSize > MAX_UPLOAD_BYTES) {
    await deleteStorageObjectQuietly(key);
    const err = new Error(`Files must be ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB or smaller.`);
    err.statusCode = 400;
    throw err;
  }
  const actualMime = found.metadata && found.metadata.mimetype;
  if (actualMime && !ALLOWED_UPLOAD_MIME.includes(actualMime)) {
    await deleteStorageObjectQuietly(key);
    const err = new Error('Only JPG, PNG, WEBP, PDF, or DOCX files are allowed');
    err.statusCode = 400;
    throw err;
  }

  const previous = borrower[column];
  borrower[column] = key;
  await borrower.save();
  await borrower.reload();
  if (previous && previous !== key) {
    await deleteStorageObjectQuietly(previous);
  }

  res.json({ success: true, data: documentStatus(borrower) });
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
  let storageError = null;
  try {
    const { data, error } = await getClient().storage.from(DOCUMENTS_BUCKET).download(key);
    if (!error && data) {
      return {
        buffer: Buffer.from(await data.arrayBuffer()),
        contentType: data.type || CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream'
      };
    }
    storageError = error || new Error('Supabase Storage returned no data and no error');
  } catch (err) {
    storageError = err;
  }

  // Fall back to local disk for uploads made before the move to Supabase.
  const resolved = path.resolve(LOCAL_UPLOADS_DIR, String(key).replace(/^[/\\]+/, ''));
  if (resolved.startsWith(LOCAL_UPLOADS_DIR + path.sep)) {
    try {
      const buffer = await fs.promises.readFile(resolved);
      return { buffer, contentType: CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream' };
    } catch (e) {
      // Not found locally either — not informative on its own, fall through
      // to the storageError check below.
    }
  }

  // Both lookups failed. A storage object that genuinely doesn't exist
  // reports a "not found"-style error from Supabase; anything else (auth
  // failure, network error, a thrown exception) is an unexpected storage
  // problem, not a missing file, and staff should see that distinction
  // instead of the misleading "missing in storage" message.
  const notFound = storageError && /not.?found/i.test(storageError.message || '');
  if (notFound) return null;

  console.error('[documents] Storage download failed for key', key, '-', storageError && storageError.message);
  const err = new Error('Could not load the document from storage. Please try again in a moment.');
  err.statusCode = 502;
  throw err;
}
