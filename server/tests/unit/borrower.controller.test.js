'use strict';

// Verifies server/controllers/borrower.controller.js — previously zero
// test coverage (High #3, 2026-09-08 system audit). Covers the borrower
// listing, self-service document upload (Supabase Storage), and the
// staff-facing document review/download endpoints.

// 2026-10-01: added POST /api/borrowers/:id/documents
// (uploadDocumentsForBorrower) — staff uploading a walk-in borrower's
// documents on their behalf, so review()'s document-verification gate
// (server/controllers/borrow.controller.js) isn't a permanent dead end for
// a transaction created via the staff walk-in endpoint. See
// claude/RSU_SDPO_System_Audit_2026-10-01.md.

jest.mock('../../models', () => ({
  Borrower: { findAll: jest.fn(), findOne: jest.fn(), findByPk: jest.fn() },
  User: {}
}));
jest.mock('../../config/supabase', () => ({ getClient: jest.fn() }));

const { Borrower } = require('../../models');
const { getClient } = require('../../config/supabase');
const ctrl = require('../../controllers/borrower.controller');

function mockRes() {
  return { json: jest.fn(), status: jest.fn().mockReturnThis(), set: jest.fn(), send: jest.fn() };
}

function makeStorageClient({ uploadError = null, downloadResult = null, downloadError = null } = {}) {
  const upload = jest.fn().mockResolvedValue({ error: uploadError });
  const download = jest.fn().mockResolvedValue({ data: downloadResult, error: downloadError });
  const from = jest.fn().mockReturnValue({ upload, download });
  return { storage: { from } };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/borrowers', () => {
  test('orders by lastName then firstName and serializes the nested user, omitting anything else', async () => {
    Borrower.findAll.mockResolvedValue([
      {
        id: 1,
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        middleName: null,
        collegeOrUnit: 'CCS',
        borrowerCategory: 'Student',
        directorAuthorizationStatus: 'Pending',
        validIdPath: 'secret/path.jpg', // must never leak through serialize()
        user: { id: 9, emailAddress: 'juan@example.com', accountStatus: 'Active', password: 'hash-should-not-leak' }
      }
    ]);

    const res = mockRes();
    await ctrl.list({}, res);

    expect(Borrower.findAll).toHaveBeenCalledWith({
      include: [{ model: expect.anything(), as: 'user' }],
      order: [['lastName', 'ASC'], ['firstName', 'ASC']]
    });
    const row = res.json.mock.calls[0][0].data[0];
    expect(row).toEqual({
      id: 1,
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      middleName: null,
      collegeOrUnit: 'CCS',
      borrowerCategory: 'Student',
      directorAuthorizationStatus: 'Pending',
      user: { id: 9, emailAddress: 'juan@example.com', accountStatus: 'Active' }
    });
    expect(row).not.toHaveProperty('validIdPath');
    expect(row.user).not.toHaveProperty('password');
  });

  test('serializes user: null for a borrower row with no linked account', async () => {
    Borrower.findAll.mockResolvedValue([{ id: 2, firstName: 'A', lastName: 'B', middleName: null, collegeOrUnit: 'X', borrowerCategory: 'Student', directorAuthorizationStatus: null, user: null }]);

    const res = mockRes();
    await ctrl.list({}, res);

    expect(res.json.mock.calls[0][0].data[0].user).toBeNull();
  });
});

describe('GET /api/borrowers/me/documents (myDocumentStatus)', () => {
  test('reports both flags false when neither document path is set', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1, validIdPath: null, authorizationDocumentPath: null });

    const res = mockRes();
    await ctrl.myDocumentStatus({ user: { id: 9 } }, res);

    expect(Borrower.findOne).toHaveBeenCalledWith({ where: { userId: 9 } });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ validIdUploaded: false, authorizationDocumentUploaded: false }) });
  });

  test('reports true for whichever path is actually set', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1, validIdPath: 'valid_ids/x.jpg', authorizationDocumentPath: null });

    const res = mockRes();
    await ctrl.myDocumentStatus({ user: { id: 9 } }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ validIdUploaded: true, authorizationDocumentUploaded: false }) });
  });

  test('does not throw when the account has no Borrower row at all (both flags false)', async () => {
    Borrower.findOne.mockResolvedValue(null);

    const res = mockRes();
    await ctrl.myDocumentStatus({ user: { id: 9 } }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ validIdUploaded: false, authorizationDocumentUploaded: false }) });
  });
});

describe('POST /api/borrowers/me/documents (uploadDocuments)', () => {
  function makeFile(name = 'id.jpg') {
    return { originalname: name, buffer: Buffer.from('fake-bytes'), mimetype: 'image/jpeg' };
  }

  test('rejects with 403 when the account has no Borrower row (findOwnBorrower)', async () => {
    Borrower.findOne.mockResolvedValue(null);

    await expect(
      ctrl.uploadDocuments({ user: { id: 9 }, files: { validId: [makeFile()] } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('rejects with 400 when no files are attached at all', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1, save: jest.fn(), reload: jest.fn() });

    await expect(ctrl.uploadDocuments({ user: { id: 9 }, files: {} }, mockRes())).rejects.toMatchObject({ statusCode: 400 });
  });

  test('uploads just the valid ID, saves the returned storage key, and leaves authorizationDocumentPath untouched', async () => {
    const borrower = { id: 1, validIdPath: null, authorizationDocumentPath: 'existing/auth.pdf', save: jest.fn().mockResolvedValue(), reload: jest.fn().mockResolvedValue() };
    Borrower.findOne.mockResolvedValue(borrower);
    const client = makeStorageClient();
    getClient.mockReturnValue(client);

    const res = mockRes();
    await ctrl.uploadDocuments({ user: { id: 9 }, files: { validId: [makeFile('front.jpg')] } }, res);

    expect(client.storage.from).toHaveBeenCalledWith('borrower-documents');
    expect(borrower.validIdPath).toMatch(/^valid_ids\/borrower-9-validId-\d+\.jpg$/);
    expect(borrower.authorizationDocumentPath).toBe('existing/auth.pdf');
    expect(borrower.save).toHaveBeenCalledTimes(1);
    expect(borrower.reload).toHaveBeenCalledTimes(1);
  });

  test('uploads both documents in one call', async () => {
    const borrower = { id: 1, validIdPath: null, authorizationDocumentPath: null, save: jest.fn().mockResolvedValue(), reload: jest.fn().mockResolvedValue() };
    Borrower.findOne.mockResolvedValue(borrower);
    getClient.mockReturnValue(makeStorageClient());

    await ctrl.uploadDocuments(
      { user: { id: 9 }, files: { validId: [makeFile('id.jpg')], authorizationDocument: [makeFile('auth.pdf')] } },
      mockRes()
    );

    expect(borrower.validIdPath).toMatch(/^valid_ids\//);
    expect(borrower.authorizationDocumentPath).toMatch(/^authorization_documents\//);
  });

  test('propagates a 502 when Supabase Storage returns an upload error', async () => {
    const borrower = { id: 1, save: jest.fn(), reload: jest.fn() };
    Borrower.findOne.mockResolvedValue(borrower);
    getClient.mockReturnValue(makeStorageClient({ uploadError: { message: 'bucket not found' } }));

    await expect(
      ctrl.uploadDocuments({ user: { id: 9 }, files: { validId: [makeFile()] } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('bucket not found') });
    expect(borrower.save).not.toHaveBeenCalled();
  });
});

describe('POST /api/borrowers/:id/documents (uploadDocumentsForBorrower)', () => {
  function makeFile(name = 'id.jpg') {
    return { originalname: name, buffer: Buffer.from('fake-bytes'), mimetype: 'image/jpeg' };
  }

  test('rejects with 404 when the target borrower does not exist', async () => {
    Borrower.findByPk.mockResolvedValue(null);

    await expect(
      ctrl.uploadDocumentsForBorrower({ user: { id: 5 }, params: { id: 999 }, files: { validId: [makeFile()] } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rejects with 400 when no files are attached at all', async () => {
    Borrower.findByPk.mockResolvedValue({ id: 1, userId: 9, save: jest.fn(), reload: jest.fn() });

    await expect(
      ctrl.uploadDocumentsForBorrower({ user: { id: 5 }, params: { id: 1 }, files: {} }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('uploads on behalf of the borrower, keying the storage path by the BORROWER\'s userId, not the uploading staff member\'s', async () => {
    const borrower = { id: 1, userId: 9, validIdPath: null, authorizationDocumentPath: null, save: jest.fn().mockResolvedValue(), reload: jest.fn().mockResolvedValue() };
    Borrower.findByPk.mockResolvedValue(borrower);
    const client = makeStorageClient();
    getClient.mockReturnValue(client);

    // req.user.id (5) is the STAFF member uploading; borrower.userId (9) is
    // the walk-in borrower's own account. The saved key must use 9, so a
    // staff member reviewing later sees the document filed under the right
    // borrower regardless of who at the counter actually uploaded it.
    await ctrl.uploadDocumentsForBorrower(
      { user: { id: 5 }, params: { id: 1 }, files: { validId: [makeFile('front.jpg')] } },
      mockRes()
    );

    expect(borrower.validIdPath).toMatch(/^valid_ids\/borrower-9-validId-\d+\.jpg$/);
    expect(borrower.save).toHaveBeenCalledTimes(1);
  });

  test('falls back to a staff-tagged key when the borrower has no linked user account', async () => {
    const borrower = { id: 1, userId: null, validIdPath: null, authorizationDocumentPath: null, save: jest.fn().mockResolvedValue(), reload: jest.fn().mockResolvedValue() };
    Borrower.findByPk.mockResolvedValue(borrower);
    getClient.mockReturnValue(makeStorageClient());

    await ctrl.uploadDocumentsForBorrower(
      { user: { id: 5 }, params: { id: 1 }, files: { validId: [makeFile()] } },
      mockRes()
    );

    expect(borrower.validIdPath).toMatch(/^valid_ids\/borrower-staff-5-validId-\d+\.jpg$/);
  });

  test('uploads both documents in one call and returns the same documentStatus shape', async () => {
    const borrower = { id: 1, userId: 9, validIdPath: null, authorizationDocumentPath: null, save: jest.fn().mockResolvedValue(), reload: jest.fn().mockResolvedValue() };
    Borrower.findByPk.mockResolvedValue(borrower);
    getClient.mockReturnValue(makeStorageClient());

    const res = mockRes();
    await ctrl.uploadDocumentsForBorrower(
      { user: { id: 5 }, params: { id: 1 }, files: { validId: [makeFile('id.jpg')], authorizationDocument: [makeFile('auth.pdf')] } },
      res
    );

    expect(borrower.validIdPath).toMatch(/^valid_ids\//);
    expect(borrower.authorizationDocumentPath).toMatch(/^authorization_documents\//);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ validIdUploaded: true, authorizationDocumentUploaded: true }) });
  });

  test('propagates a 502 when Supabase Storage returns an upload error', async () => {
    const borrower = { id: 1, userId: 9, save: jest.fn(), reload: jest.fn() };
    Borrower.findByPk.mockResolvedValue(borrower);
    getClient.mockReturnValue(makeStorageClient({ uploadError: { message: 'bucket not found' } }));

    await expect(
      ctrl.uploadDocumentsForBorrower({ user: { id: 5 }, params: { id: 1 }, files: { validId: [makeFile()] } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('bucket not found') });
    expect(borrower.save).not.toHaveBeenCalled();
  });
});

describe('GET /api/borrowers/:id/documents (staffDocumentStatus)', () => {
  test('rejects with 404 when the borrower does not exist', async () => {
    Borrower.findByPk.mockResolvedValue(null);

    await expect(ctrl.staffDocumentStatus({ params: { id: 999 } }, mockRes())).rejects.toMatchObject({ statusCode: 404 });
  });

  test('returns the same documentStatus shape as the self-service endpoint', async () => {
    Borrower.findByPk.mockResolvedValue({ id: 1, validIdPath: 'x', authorizationDocumentPath: null });

    const res = mockRes();
    await ctrl.staffDocumentStatus({ params: { id: 1 } }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ validIdUploaded: true, authorizationDocumentUploaded: false }) });
  });
});

describe('GET /api/borrowers/:id/documents/:type (downloadDocument)', () => {
  test('rejects with 400 for an unrecognized document type', async () => {
    await expect(
      ctrl.downloadDocument({ params: { id: 1, type: 'passport' } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(Borrower.findByPk).not.toHaveBeenCalled();
  });

  test('rejects with 404 when the borrower does not exist', async () => {
    Borrower.findByPk.mockResolvedValue(null);

    await expect(
      ctrl.downloadDocument({ params: { id: 1, type: 'valid-id' } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rejects with 404 when that specific document was never submitted', async () => {
    Borrower.findByPk.mockResolvedValue({ id: 1, validIdPath: null });

    await expect(
      ctrl.downloadDocument({ params: { id: 1, type: 'valid-id' } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('responds 404 (not a thrown error) when Storage has no file at the recorded path', async () => {
    Borrower.findByPk.mockResolvedValue({ id: 1, validIdPath: 'valid_ids/missing.jpg' });
    getClient.mockReturnValue(makeStorageClient({ downloadError: { message: 'not found' } }));

    const res = mockRes();
    await ctrl.downloadDocument({ params: { id: 1, type: 'valid-id' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Document file is missing in storage' });
  });

  test('streams the file back with its content type on success', async () => {
    const fakeBlob = { type: 'image/jpeg', arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('file-bytes').buffer) };
    Borrower.findByPk.mockResolvedValue({ id: 1, validIdPath: 'valid_ids/front.jpg' });
    getClient.mockReturnValue(makeStorageClient({ downloadResult: fakeBlob }));

    const res = mockRes();
    await ctrl.downloadDocument({ params: { id: 1, type: 'valid-id' } }, res);

    expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(res.send.mock.calls[0][0])).toBe(true);
  });
});
