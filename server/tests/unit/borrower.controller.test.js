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
  Borrower: { findAll: jest.fn(), findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn() },
  User: { findOne: jest.fn(), create: jest.fn() },
  sequelize: { transaction: jest.fn((cb) => cb({})) }
}));
jest.mock('../../config/supabase', () => ({ getClient: jest.fn() }));
jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed-password') }));

const { Borrower, User } = require('../../models');
const { getClient } = require('../../config/supabase');
const bcrypt = require('bcrypt');
const ctrl = require('../../controllers/borrower.controller');

function mockRes() {
  return { json: jest.fn(), status: jest.fn().mockReturnThis(), set: jest.fn(), send: jest.fn() };
}

function makeStorageClient({
  uploadError = null,
  downloadResult = null,
  downloadError = null,
  removeError = null,
  signedUrlResult = { signedUrl: 'https://supabase.test/storage/v1/object/upload/sign/x?token=abc' },
  signedUrlError = null,
  listResult = [],
  listError = null
} = {}) {
  const upload = jest.fn().mockResolvedValue({ error: uploadError });
  const download = jest.fn().mockResolvedValue({ data: downloadResult, error: downloadError });
  const remove = jest.fn().mockResolvedValue({ error: removeError });
  const createSignedUploadUrl = jest.fn().mockResolvedValue({ data: signedUrlResult, error: signedUrlError });
  const list = jest.fn().mockResolvedValue({ data: listResult, error: listError });
  const from = jest.fn().mockReturnValue({ upload, download, remove, createSignedUploadUrl, list });
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

// POST /api/borrowers (create) — added 2026-10-02 for the New Transaction
// modal's "+ New Borrower" flow: lets staff register a true walk-in (no
// existing account) on the spot, without the borrower going through
// self-service registration (auth.controller.js#register) first.
describe('POST /api/borrowers (create)', () => {
  function validBody(overrides) {
    return {
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      collegeOrUnit: 'CCS',
      borrowerCategory: 'Student',
      emailAddress: 'juan.walkin@example.com',
      contactNumber: '09171234567',
      password: 'Court4821',
      ...overrides
    };
  }

  test('rejects with 400 when a required field is missing', async () => {
    await expect(
      ctrl.create({ body: validBody({ collegeOrUnit: '' }) }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('rejects with 400 when password is missing', async () => {
    await expect(
      ctrl.create({ body: validBody({ password: '' }) }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('rejects with 400 when password is shorter than 8 characters', async () => {
    await expect(
      ctrl.create({ body: validBody({ password: 'short1' }) }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('rejects with 400 for an unrecognized borrowerCategory', async () => {
    await expect(
      ctrl.create({ body: validBody({ borrowerCategory: 'Alumni' }) }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects with 409 when the email address is already in use', async () => {
    User.findOne.mockResolvedValueOnce({ id: 3, emailAddress: 'juan.walkin@example.com' });

    await expect(ctrl.create({ body: validBody() }, mockRes())).rejects.toMatchObject({ statusCode: 409 });
    expect(Borrower.create).not.toHaveBeenCalled();
  });

  test('creates a User (role Borrower, verified, staff-set password) and a linked Borrower row, and returns the serialized borrower', async () => {
    User.findOne
      .mockResolvedValueOnce(null) // email not already in use
      .mockResolvedValueOnce(null); // generated username is available on first try
    User.create.mockResolvedValueOnce({ id: 42 });
    Borrower.create.mockResolvedValueOnce({ id: 7 });
    Borrower.findByPk.mockResolvedValueOnce({
      id: 7,
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      middleName: null,
      collegeOrUnit: 'CCS',
      borrowerCategory: 'Student',
      directorAuthorizationStatus: 'Not Required',
      user: { id: 42, emailAddress: 'juan.walkin@example.com', accountStatus: 'Active' }
    });

    const res = mockRes();
    await ctrl.create({ body: validBody() }, res);

    // The password staff typed in is what gets hashed — not a random,
    // nobody-knows-it value, so the borrower can actually log in with it.
    expect(bcrypt.hash).toHaveBeenCalledWith('Court4821', 10);
    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: 'juan.walkin@example.com',
        password: 'hashed-password',
        userRole: 'Borrower',
        contactNumber: '09171234567',
        emailVerified: true,
        username: expect.stringMatching(/^walkin\./)
      }),
      expect.anything()
    );
    expect(Borrower.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, firstName: 'Juan', lastName: 'Dela Cruz', collegeOrUnit: 'CCS', borrowerCategory: 'Student' }),
      expect.anything()
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ id: 7, firstName: 'Juan', collegeOrUnit: 'CCS', borrowerCategory: 'Student' })
    });
  });

  test('defaults lastName to an empty string and contactNumber to null when omitted', async () => {
    User.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    User.create.mockResolvedValueOnce({ id: 50 });
    Borrower.create.mockResolvedValueOnce({ id: 11 });
    Borrower.findByPk.mockResolvedValueOnce({ id: 11, firstName: 'Mina', lastName: '', collegeOrUnit: 'CBA', borrowerCategory: 'External', user: null });

    await ctrl.create({ body: validBody({ lastName: undefined, contactNumber: undefined }) }, mockRes());

    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ contactNumber: null }), expect.anything());
    expect(Borrower.create).toHaveBeenCalledWith(expect.objectContaining({ lastName: '' }), expect.anything());
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

  // 2026-10-03: documents live on the Borrower record, not per-transaction —
  // re-uploading (e.g. after a request was returned for correction) used to
  // leave the previous file sitting in Storage forever, unreferenced by
  // anything. Each upload now writes a new key and only then deletes
  // whichever key it replaced.
  describe('superseded document cleanup', () => {
    test('deletes the previous file from storage once the new one is saved', async () => {
      const borrower = {
        id: 1,
        validIdPath: 'valid_ids/borrower-9-validId-1000.jpg',
        authorizationDocumentPath: null,
        save: jest.fn().mockResolvedValue(),
        reload: jest.fn().mockResolvedValue()
      };
      Borrower.findOne.mockResolvedValue(borrower);
      const client = makeStorageClient();
      getClient.mockReturnValue(client);

      await ctrl.uploadDocuments({ user: { id: 9 }, files: { validId: [makeFile('new-front.jpg')] } }, mockRes());

      expect(client.storage.from).toHaveBeenCalledWith('borrower-documents');
      expect(client.storage.from().remove).toHaveBeenCalledWith(['valid_ids/borrower-9-validId-1000.jpg']);
    });

    test('never deletes anything on a borrower\'s very first upload (no previous file)', async () => {
      const borrower = { id: 1, validIdPath: null, authorizationDocumentPath: null, save: jest.fn().mockResolvedValue(), reload: jest.fn().mockResolvedValue() };
      Borrower.findOne.mockResolvedValue(borrower);
      const client = makeStorageClient();
      getClient.mockReturnValue(client);

      await ctrl.uploadDocuments({ user: { id: 9 }, files: { validId: [makeFile()] } }, mockRes());

      expect(client.storage.from().remove).not.toHaveBeenCalled();
    });

    test('leaves the OTHER field\'s existing document alone when only one field is re-uploaded', async () => {
      const borrower = {
        id: 1,
        validIdPath: 'valid_ids/old.jpg',
        authorizationDocumentPath: 'authorization_documents/old.pdf',
        save: jest.fn().mockResolvedValue(),
        reload: jest.fn().mockResolvedValue()
      };
      Borrower.findOne.mockResolvedValue(borrower);
      const client = makeStorageClient();
      getClient.mockReturnValue(client);

      await ctrl.uploadDocuments({ user: { id: 9 }, files: { validId: [makeFile('new.jpg')] } }, mockRes());

      expect(client.storage.from().remove).toHaveBeenCalledTimes(1);
      expect(client.storage.from().remove).toHaveBeenCalledWith(['valid_ids/old.jpg']);
    });

    test('a failed deletion of the old file never blocks the response — the new upload already succeeded', async () => {
      const borrower = {
        id: 1,
        validIdPath: 'valid_ids/old.jpg',
        authorizationDocumentPath: null,
        save: jest.fn().mockResolvedValue(),
        reload: jest.fn().mockResolvedValue()
      };
      Borrower.findOne.mockResolvedValue(borrower);
      getClient.mockReturnValue(makeStorageClient({ removeError: { message: 'network blip' } }));

      const res = mockRes();
      await expect(ctrl.uploadDocuments({ user: { id: 9 }, files: { validId: [makeFile()] } }, res)).resolves.toBeUndefined();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
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

// 2026-10-03: direct-to-Supabase-Storage upload — the borrower's browser
// uploads straight to Storage with a signed URL (bypassing Vercel's
// 4.5MB-per-request body cap entirely), then this server confirms what
// Storage actually received before trusting it.
describe('POST /api/borrowers/me/documents/sign (createDocumentUploadUrl)', () => {
  function req(body, userId = 9) {
    return { user: { id: userId }, body };
  }

  test('rejects with 403 when the account has no Borrower row', async () => {
    Borrower.findOne.mockResolvedValue(null);
    await expect(
      ctrl.createDocumentUploadUrl(req({ field: 'validId', contentType: 'image/jpeg', size: 1000 }), mockRes())
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('rejects an unknown field name', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1 });
    await expect(
      ctrl.createDocumentUploadUrl(req({ field: 'somethingElse', contentType: 'image/jpeg', size: 1000 }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a disallowed content type', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1 });
    await expect(
      ctrl.createDocumentUploadUrl(req({ field: 'validId', contentType: 'application/zip', size: 1000 }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a missing or non-positive size', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1 });
    await expect(
      ctrl.createDocumentUploadUrl(req({ field: 'validId', contentType: 'image/jpeg' }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      ctrl.createDocumentUploadUrl(req({ field: 'validId', contentType: 'image/jpeg', size: 0 }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a declared size over the 10MB cap, before ever requesting a signed URL', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1 });
    const client = makeStorageClient();
    getClient.mockReturnValue(client);

    await expect(
      ctrl.createDocumentUploadUrl(req({ field: 'authorizationDocument', contentType: 'application/pdf', size: 11 * 1024 * 1024 }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/10MB/) });
    expect(client.storage.from().createSignedUploadUrl).not.toHaveBeenCalled();
  });

  test('propagates a 502 when Supabase Storage fails to create the signed URL', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1 });
    getClient.mockReturnValue(makeStorageClient({ signedUrlError: { message: 'bucket not found' } }));

    await expect(
      ctrl.createDocumentUploadUrl(req({ field: 'validId', contentType: 'image/jpeg', size: 1000 }), mockRes())
    ).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('bucket not found') });
  });

  test('on success, returns the signed uploadUrl and a key scoped to this user/field', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1 });
    const client = makeStorageClient({ signedUrlResult: { signedUrl: 'https://supabase.test/sign/xyz?token=abc' } });
    getClient.mockReturnValue(client);

    const res = mockRes();
    await ctrl.createDocumentUploadUrl(req({ field: 'authorizationDocument', contentType: 'application/pdf', size: 500000 }), res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        uploadUrl: 'https://supabase.test/sign/xyz?token=abc',
        key: expect.stringMatching(/^authorization_documents\/borrower-9-authorizationDocument-\d+\.pdf$/),
        field: 'authorizationDocument'
      }
    });
  });
});

describe('POST /api/borrowers/me/documents/confirm (confirmDocumentUpload)', () => {
  function req(body, userId = 9) {
    return { user: { id: userId }, body };
  }

  test('rejects a key that was not issued to this user/field (prefix check)', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1, save: jest.fn(), reload: jest.fn() });
    await expect(
      ctrl.confirmDocumentUpload(req({ field: 'validId', key: 'valid_ids/borrower-999-validId-123.jpg' }), mockRes())
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('rejects when the object does not actually exist in storage yet', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1, save: jest.fn(), reload: jest.fn() });
    getClient.mockReturnValue(makeStorageClient({ listResult: [] }));

    await expect(
      ctrl.confirmDocumentUpload(req({ field: 'validId', key: 'valid_ids/borrower-9-validId-123.jpg' }), mockRes())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('deletes and rejects a file that actually exceeds the size cap, regardless of what /sign was told', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1, save: jest.fn(), reload: jest.fn() });
    const client = makeStorageClient({
      listResult: [{ name: 'borrower-9-validId-123.jpg', metadata: { size: 11 * 1024 * 1024, mimetype: 'image/jpeg' } }]
    });
    getClient.mockReturnValue(client);

    await expect(
      ctrl.confirmDocumentUpload(req({ field: 'validId', key: 'valid_ids/borrower-9-validId-123.jpg' }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/10MB/) });
    expect(client.storage.from().remove).toHaveBeenCalledWith(['valid_ids/borrower-9-validId-123.jpg']);
  });

  test('deletes and rejects a file whose real MIME type is not allowed', async () => {
    Borrower.findOne.mockResolvedValue({ id: 1, save: jest.fn(), reload: jest.fn() });
    const client = makeStorageClient({
      listResult: [{ name: 'borrower-9-validId-123.jpg', metadata: { size: 1000, mimetype: 'application/x-msdownload' } }]
    });
    getClient.mockReturnValue(client);

    await expect(
      ctrl.confirmDocumentUpload(req({ field: 'validId', key: 'valid_ids/borrower-9-validId-123.jpg' }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(client.storage.from().remove).toHaveBeenCalledWith(['valid_ids/borrower-9-validId-123.jpg']);
  });

  test('on success, saves the key, reloads, and deletes whichever file it replaced', async () => {
    const borrower = {
      id: 1,
      validIdPath: 'valid_ids/borrower-9-validId-100.jpg',
      save: jest.fn().mockResolvedValue(),
      reload: jest.fn().mockResolvedValue()
    };
    Borrower.findOne.mockResolvedValue(borrower);
    const client = makeStorageClient({
      listResult: [{ name: 'borrower-9-validId-200.jpg', metadata: { size: 1000, mimetype: 'image/jpeg' } }]
    });
    getClient.mockReturnValue(client);

    const res = mockRes();
    await ctrl.confirmDocumentUpload(req({ field: 'validId', key: 'valid_ids/borrower-9-validId-200.jpg' }), res);

    expect(borrower.validIdPath).toBe('valid_ids/borrower-9-validId-200.jpg');
    expect(borrower.save).toHaveBeenCalledTimes(1);
    expect(client.storage.from().remove).toHaveBeenCalledWith(['valid_ids/borrower-9-validId-100.jpg']);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('on a borrower\'s first-ever upload (no previous file), nothing is deleted', async () => {
    const borrower = { id: 1, validIdPath: null, save: jest.fn().mockResolvedValue(), reload: jest.fn().mockResolvedValue() };
    Borrower.findOne.mockResolvedValue(borrower);
    const client = makeStorageClient({
      listResult: [{ name: 'borrower-9-validId-200.jpg', metadata: { size: 1000, mimetype: 'image/jpeg' } }]
    });
    getClient.mockReturnValue(client);

    await ctrl.confirmDocumentUpload(req({ field: 'validId', key: 'valid_ids/borrower-9-validId-200.jpg' }), mockRes());

    expect(client.storage.from().remove).not.toHaveBeenCalled();
  });
});
