'use strict';

// Verifies server/controllers/auth.controller.js's email-verification and
// password-reset logic against mocked models/bcrypt/email, following the
// same style as passport.test.js (mock the collaborators, assert on calls
// and on the response the controller sends). jwt/signToken and the
// register()/login() paths that were already correct before this feature
// (existing-user duplicate checks, successful password login, etc.) are not
// re-tested here — only the new behavior and the one modified branch of
// login() that this feature touches.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-auth-controller-spec';

jest.mock('../../models', () => ({
  User: {
    findOne: jest.fn(),
    create: jest.fn(),
    findByPk: jest.fn()
  },
  Borrower: {
    create: jest.fn()
  },
  sequelize: {
    transaction: jest.fn()
  }
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn()
}));
jest.mock('../../services/notificationService/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'test' })
}));
// Preserve the real CODE_EXPIRY_MINUTES/MAX_CODE_ATTEMPTS constants (so
// these tests stay in sync with the real 5-attempt lockout and 10-minute
// expiry) while making code generation/hashing deterministic and
// compareCode controllable per test.
jest.mock('../../helpers/verificationCode', () => {
  const actual = jest.requireActual('../../helpers/verificationCode');
  return {
    ...actual,
    generateCode: jest.fn(() => '123456'),
    hashCode: jest.fn(async (code) => `hashed-${code}`),
    compareCode: jest.fn()
  };
});

const { User, Borrower, sequelize } = require('../../models');
const bcrypt = require('bcrypt');
const { sendEmail } = require('../../services/notificationService/emailService');
const { MAX_CODE_ATTEMPTS, compareCode } = require('../../helpers/verificationCode');
const authController = require('../../controllers/auth.controller');

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  bcrypt.hash.mockImplementation(async (value) => `hashed-${value}`);
  // register()'s branches wrap their User/Borrower writes in
  // sequelize.transaction(async (t) => ...) — run the callback for real
  // (against a fake transaction token) rather than leaving it a no-op.
  sequelize.transaction.mockImplementation(async (cb) => cb({}));
});

describe('auth.controller.js#verifyRegistration', () => {
  function makeUser(overrides = {}) {
    return {
      id: 1,
      emailAddress: 'borrower@example.com',
      emailVerified: false,
      verificationCodeHash: 'hashed-123456',
      verificationCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      verificationCodeAttempts: 0,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides
    };
  }

  test('correct code marks the account verified and clears the code fields', async () => {
    const user = makeUser();
    User.findOne.mockResolvedValueOnce(user);
    compareCode.mockResolvedValueOnce(true);
    const res = makeRes();

    await authController.verifyRegistration({ body: { email: user.emailAddress, code: '123456' } }, res);

    expect(user.emailVerified).toBe(true);
    expect(user.verificationCodeHash).toBeNull();
    expect(user.verificationCodeExpiresAt).toBeNull();
    expect(user.verificationCodeAttempts).toBe(0);
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Email verified. You can now sign in.' });
  });

  test('wrong code increments attempts and reports the exact number remaining', async () => {
    const user = makeUser({ verificationCodeAttempts: 2 });
    User.findOne.mockResolvedValueOnce(user);
    compareCode.mockResolvedValueOnce(false);
    const res = makeRes();

    await authController.verifyRegistration({ body: { email: user.emailAddress, code: '000000' } }, res);

    expect(user.verificationCodeAttempts).toBe(3);
    expect(user.emailVerified).toBe(false);
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: `Incorrect code. ${MAX_CODE_ATTEMPTS - 3} attempt(s) remaining.`
    });
  });

  test('expired code is rejected without ever calling compareCode', async () => {
    const user = makeUser({ verificationCodeExpiresAt: new Date(Date.now() - 1000) });
    User.findOne.mockResolvedValueOnce(user);
    const res = makeRes();

    await authController.verifyRegistration({ body: { email: user.emailAddress, code: '123456' } }, res);

    expect(compareCode).not.toHaveBeenCalled();
    expect(user.save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'This code has expired. Please request a new one.'
    });
  });

  test('already-verified account is rejected', async () => {
    const user = makeUser({ emailVerified: true });
    User.findOne.mockResolvedValueOnce(user);
    const res = makeRes();

    await authController.verifyRegistration({ body: { email: user.emailAddress, code: '123456' } }, res);

    expect(compareCode).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'This account is already verified. Please sign in.'
    });
  });

  test('max attempts already reached is rejected without consuming compareCode', async () => {
    const user = makeUser({ verificationCodeAttempts: MAX_CODE_ATTEMPTS });
    User.findOne.mockResolvedValueOnce(user);
    const res = makeRes();

    await authController.verifyRegistration({ body: { email: user.emailAddress, code: '123456' } }, res);

    expect(compareCode).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Too many incorrect attempts. Please request a new code.'
    });
  });

  test('unknown email gets the same wording as an expired/wrong code (no enumeration)', async () => {
    User.findOne.mockResolvedValueOnce(null);
    const res = makeRes();

    await authController.verifyRegistration({ body: { email: 'nobody@example.com', code: '123456' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Invalid or expired code.' });
  });
});

describe('auth.controller.js#resetPassword', () => {
  function makeUser(overrides = {}) {
    return {
      id: 7,
      emailAddress: 'someone@example.com',
      password: 'old-hashed-password',
      resetCodeHash: 'hashed-654321',
      resetCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      resetCodeAttempts: 0,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides
    };
  }

  test('correct code changes the password hash and clears the reset code fields', async () => {
    const user = makeUser();
    User.findOne.mockResolvedValueOnce(user);
    compareCode.mockResolvedValueOnce(true);
    const res = makeRes();

    await authController.resetPassword(
      { body: { email: user.emailAddress, code: '654321', newPassword: 'newSecurePass1' } },
      res
    );

    expect(bcrypt.hash).toHaveBeenCalledWith('newSecurePass1', 10);
    expect(user.password).toBe('hashed-newSecurePass1');
    expect(user.resetCodeHash).toBeNull();
    expect(user.resetCodeExpiresAt).toBeNull();
    expect(user.resetCodeAttempts).toBe(0);
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Password reset successfully. Please sign in with your new password.'
    });
  });

  test('wrong code increments resetCodeAttempts and reports remaining attempts', async () => {
    const user = makeUser({ resetCodeAttempts: 1 });
    User.findOne.mockResolvedValueOnce(user);
    compareCode.mockResolvedValueOnce(false);
    const res = makeRes();

    await authController.resetPassword(
      { body: { email: user.emailAddress, code: '000000', newPassword: 'newSecurePass1' } },
      res
    );

    expect(user.resetCodeAttempts).toBe(2);
    expect(user.password).toBe('old-hashed-password');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: `Incorrect code. ${MAX_CODE_ATTEMPTS - 2} attempt(s) remaining.`
    });
  });

  test('expired reset code is rejected without calling compareCode', async () => {
    const user = makeUser({ resetCodeExpiresAt: new Date(Date.now() - 1000) });
    User.findOne.mockResolvedValueOnce(user);
    const res = makeRes();

    await authController.resetPassword(
      { body: { email: user.emailAddress, code: '654321', newPassword: 'newSecurePass1' } },
      res
    );

    expect(compareCode).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'This code has expired. Please request a new one.'
    });
  });

  test('max attempts already reached is rejected without calling compareCode', async () => {
    const user = makeUser({ resetCodeAttempts: MAX_CODE_ATTEMPTS });
    User.findOne.mockResolvedValueOnce(user);
    const res = makeRes();

    await authController.resetPassword(
      { body: { email: user.emailAddress, code: '654321', newPassword: 'newSecurePass1' } },
      res
    );

    expect(compareCode).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Too many incorrect attempts. Please request a new code.'
    });
  });

  test('unknown email gets the same "Invalid or expired code." wording (no enumeration)', async () => {
    User.findOne.mockResolvedValueOnce(null);
    const res = makeRes();

    await authController.resetPassword(
      { body: { email: 'nobody@example.com', code: '654321', newPassword: 'newSecurePass1' } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Invalid or expired code.' });
  });
});

describe('auth.controller.js#login (email verification gate)', () => {
  test('an unverified user is rejected with the verification message before accountStatus is ever read', async () => {
    let accountStatusReads = 0;
    const user = {
      id: 9,
      username: 'unverified',
      password: 'hashed-pw',
      emailVerified: false
    };
    // A getter, not a plain property: proves the accountStatus check never
    // even runs for an unverified user, not merely that it isn't mentioned
    // in the response.
    Object.defineProperty(user, 'accountStatus', {
      get() {
        accountStatusReads += 1;
        return 'Restricted';
      }
    });
    User.findOne.mockResolvedValueOnce(user);
    bcrypt.compare.mockResolvedValueOnce(true);
    const res = makeRes();

    await expect(
      authController.login({ body: { username: 'unverified', password: 'correct-password' } }, res)
    ).rejects.toThrow('Please verify your email before signing in. Check your inbox for the verification code.');

    expect(accountStatusReads).toBe(0);
  });

  test('a flagged (Restricted) borrower can still sign in — new requests are blocked elsewhere', async () => {
    const user = {
      id: 10,
      username: 'flagged',
      password: 'hashed-pw',
      userRole: 'Borrower',
      emailVerified: true,
      accountStatus: 'Restricted'
    };
    User.findOne.mockResolvedValueOnce(user);
    bcrypt.compare.mockResolvedValueOnce(true);
    const res = makeRes();

    await authController.login({ body: { username: 'flagged', password: 'correct-password' } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('a Blocked account is refused with ACCOUNT_BLOCKED', async () => {
    const user = { id: 11, username: 'blocked', password: 'hashed-pw', emailVerified: true, accountStatus: 'Blocked' };
    User.findOne.mockResolvedValueOnce(user);
    bcrypt.compare.mockResolvedValueOnce(true);

    await expect(
      authController.login({ body: { username: 'blocked', password: 'correct-password' } }, makeRes())
    ).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_BLOCKED' });
  });

  test('an unverified account is refused with EMAIL_NOT_VERIFIED and the email to verify', async () => {
    const user = { id: 12, username: 'newbie', emailAddress: 'newbie@example.com', password: 'hashed-pw', emailVerified: false, accountStatus: 'Active' };
    User.findOne.mockResolvedValueOnce(user);
    bcrypt.compare.mockResolvedValueOnce(true);

    await expect(
      authController.login({ body: { username: 'newbie', password: 'correct-password' } }, makeRes())
    ).rejects.toMatchObject({ statusCode: 403, code: 'EMAIL_NOT_VERIFIED', details: { email: 'newbie@example.com' } });
  });
});

describe('auth.controller.js#resendVerification (duplicate-email protection)', () => {
  test('does not send another email while the previous code is inside the cooldown', async () => {
    const user = {
      emailAddress: 'a@example.com',
      emailVerified: false,
      // issued 10 seconds ago (codes expire 10 minutes after issue)
      verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000 - 10 * 1000),
      save: jest.fn()
    };
    User.findOne.mockResolvedValueOnce(user);
    const res = makeRes();
    await authController.resendVerification({ body: { email: 'a@example.com' } }, res);
    expect(user.save).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('sends a fresh code once the cooldown has passed', async () => {
    const user = {
      emailAddress: 'a@example.com',
      emailVerified: false,
      verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000 - 120 * 1000),
      save: jest.fn()
    };
    User.findOne.mockResolvedValueOnce(user);
    await authController.resendVerification({ body: { email: 'a@example.com' } }, makeRes());
    expect(user.save).toHaveBeenCalled();
  });
});

describe('auth.controller.js#register (re-registration of an abandoned unverified email)', () => {
  function makeReq(overrides = {}) {
    return {
      body: {
        username: 'newusername',
        emailAddress: 'abandoned@example.com',
        password: 'freshPassword1',
        firstName: 'Jane',
        lastName: 'Doe',
        collegeOrUnit: 'CICS',
        borrowerCategory: 'Student',
        ...overrides
      }
    };
  }

  function makeExistingByEmail(overrides = {}) {
    return {
      id: 42,
      username: 'oldusername',
      password: 'old-hashed-password',
      emailAddress: 'abandoned@example.com',
      userRole: 'Borrower',
      emailVerified: false,
      verificationCodeAttempts: 3,
      save: jest.fn().mockResolvedValue(undefined),
      borrowerProfile: {
        firstName: 'OldFirst',
        lastName: 'OldLast',
        collegeOrUnit: 'Old Dept',
        borrowerCategory: 'Employee',
        save: jest.fn().mockResolvedValue(undefined)
      },
      ...overrides
    };
  }

  test('regenerates and resends a code, updates the existing row, and never calls User.create', async () => {
    const existingByEmail = makeExistingByEmail();
    User.findOne
      .mockResolvedValueOnce(existingByEmail) // email lookup
      .mockResolvedValueOnce(null); // username-uniqueness lookup (excluding this row): free
    const res = makeRes();

    await authController.register(makeReq(), res);

    expect(User.create).not.toHaveBeenCalled();
    expect(Borrower.create).not.toHaveBeenCalled();
    expect(existingByEmail.username).toBe('newusername');
    expect(existingByEmail.password).toBe('hashed-freshPassword1');
    expect(existingByEmail.verificationCodeHash).toBe('hashed-123456');
    expect(existingByEmail.verificationCodeAttempts).toBe(0);
    // Once inside the User+Borrower transaction (username/password), once
    // more from issueVerificationCode's own save() afterward.
    expect(existingByEmail.save).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledWith(
      'abandoned@example.com',
      'RSU SDPO - Verify Your Email',
      expect.stringContaining('123456'),
      expect.objectContaining({ heading: 'Email Verification' })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { email: 'abandoned@example.com' } });
  });

  // Regression coverage for a real reported bug: a single-word name (e.g.
  // "Laurie", nothing after it) used to be rejected here unless the
  // frontend duplicated it into lastName too, which is exactly what pushed
  // the frontend into storing "Laurie Laurie" everywhere. lastName is no
  // longer required at registration, and an omitted one must be accepted
  // and normalized to an empty string rather than rejected with a 400 or
  // passed through as undefined (which the Borrower model's NOT NULL
  // lastName column would reject at the database level).
  test('accepts a single-word name with no lastName submitted at all, normalized to an empty string', async () => {
    const existingByEmail = makeExistingByEmail();
    User.findOne.mockResolvedValueOnce(existingByEmail).mockResolvedValueOnce(null);
    const res = makeRes();

    const req = makeReq({ firstName: 'Laurie' });
    delete req.body.lastName;
    await authController.register(req, res);

    expect(existingByEmail.borrowerProfile.firstName).toBe('Laurie');
    expect(existingByEmail.borrowerProfile.lastName).toBe('');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('regression: also updates the associated Borrower row\'s profile fields to the newly submitted values, not just username/password', async () => {
    const existingByEmail = makeExistingByEmail();
    User.findOne.mockResolvedValueOnce(existingByEmail).mockResolvedValueOnce(null);
    const res = makeRes();

    await authController.register(
      makeReq({
        firstName: 'CorrectedFirst',
        lastName: 'CorrectedLast',
        collegeOrUnit: 'CICS',
        borrowerCategory: 'Student'
      }),
      res
    );

    expect(existingByEmail.borrowerProfile.firstName).toBe('CorrectedFirst');
    expect(existingByEmail.borrowerProfile.lastName).toBe('CorrectedLast');
    expect(existingByEmail.borrowerProfile.collegeOrUnit).toBe('CICS');
    expect(existingByEmail.borrowerProfile.borrowerCategory).toBe('Student');
    expect(existingByEmail.borrowerProfile.save).toHaveBeenCalledTimes(1);
    expect(Borrower.create).not.toHaveBeenCalled();
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
  });

  test('defensive fallback: creates the Borrower row via Borrower.create when the existing User has none (data-inconsistency guard)', async () => {
    const existingByEmail = makeExistingByEmail({ borrowerProfile: null });
    User.findOne.mockResolvedValueOnce(existingByEmail).mockResolvedValueOnce(null);
    const res = makeRes();

    await authController.register(makeReq({ firstName: 'Newly', lastName: 'Created' }), res);

    expect(Borrower.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: existingByEmail.id,
        firstName: 'Newly',
        lastName: 'Created',
        collegeOrUnit: 'CICS',
        borrowerCategory: 'Student'
      }),
      expect.objectContaining({ transaction: expect.anything() })
    );
  });

  test('rejects with 409 when the newly submitted username belongs to a different existing account', async () => {
    const existingByEmail = makeExistingByEmail();
    const someoneElse = { id: 99, username: 'newusername' };
    User.findOne.mockResolvedValueOnce(existingByEmail).mockResolvedValueOnce(someoneElse);
    const res = makeRes();

    await expect(authController.register(makeReq(), res)).rejects.toThrow('That username is already taken');

    expect(existingByEmail.save).not.toHaveBeenCalled();
    expect(existingByEmail.borrowerProfile.save).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
    expect(Borrower.create).not.toHaveBeenCalled();
  });
});
