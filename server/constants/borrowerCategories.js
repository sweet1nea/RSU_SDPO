'use strict';

// Borrower Types, and which submitted documents each one must have on file
// before a request can be submitted or verified by SDPO staff. Mirrors the
// approved RSU SDPO borrowing requirements; the client reads the same rules
// back from GET /api/borrowers/me/documents so the wizard and the server can
// never disagree.
const BORROWER_CATEGORIES = ['Faculty', 'Employee', 'Student', 'External'];

const DOCUMENT_REQUIREMENTS = {
  Faculty: { needsValidId: false, documentLabel: 'Activity Schedule' },
  Employee: { needsValidId: false, documentLabel: 'Approved Proposal / Request Letter' },
  Student: { needsValidId: false, documentLabel: 'Authorization Letter' },
  External: { needsValidId: true, documentLabel: 'Approved Proposal / Request Letter' }
};

const DEFAULT_REQUIREMENT = { needsValidId: true, documentLabel: 'Approved Proposal / Authorization' };

function requirementsFor(category) {
  return DOCUMENT_REQUIREMENTS[category] || DEFAULT_REQUIREMENT;
}

// Names of the required documents this borrower has NOT uploaded yet.
// `docs` is where the file paths are read from: the borrower by default, or a
// transaction when checking the documents submitted with one specific request.
function missingDocuments(borrower, docs = borrower) {
  if (!borrower) return ['Borrower profile'];
  const req = requirementsFor(borrower.borrowerCategory);
  const missing = [];
  if (req.needsValidId && !docs.validIdPath) missing.push('Valid ID');
  if (!docs.authorizationDocumentPath) missing.push(req.documentLabel);
  return missing;
}

module.exports = { BORROWER_CATEGORIES, DOCUMENT_REQUIREMENTS, requirementsFor, missingDocuments };
