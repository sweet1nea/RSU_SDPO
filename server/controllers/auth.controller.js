'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { User, Borrower, sequelize } = require('../models');
const { sendEmail } = require('../services/notificationService/emailService');
const { recipientNameFor } = require('../helpers/recipientName');
const { CODE_EXPIRY_MINUTES, MAX_CODE_ATTEMPTS, generateCode, hashCode, compareCode } = require('../helpers/verificationCode');

function signToken(user) {
  return jwt.sign({ id: user.id, userRole: user.userRole }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d'
  });
}

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    userRole: user.userRole,
    emailAddress: user.emailAddress,
    contactNumber: user.contactNumber,
    accountStatus: user.accountStatus,
    borrowerProfile: user.borrowerProfile
      ? {
          id: user.borrowerProfile.id,
          firstName: user.borrowerProfile.firstName,
          lastName: user.borrowerProfile.lastName,
          collegeOrUnit: user.borrowerProfile.collegeOrUnit,
          borrowerCategory: user.borrowerProfile.borrowerCategory
        }
      : null
  };
}

// Exported so server/routes/auth.routes.js's Google OAuth callback can
// issue tokens/serialize the user identically to the password-login path —
// a Google-authenticated session must be indistinguishable from a
// password-authenticated one to the rest of the app.
exports.signToken = signToken;
exports.serializeUser = serializeUser;
exports.issueVerificationCode = issueVerificationCode;
exports.secondsUntilResendAllowed = secondsUntilResendAllowed;

// Minimum gap between two verification emails to the same account. Repeated
// clicks, page refreshes, or duplicate API calls inside this window reuse
// the code already sent instead of mailing a new one each time.
const RESEND_COOLDOWN_SECONDS = 60;

// When the current verification code was issued (codes are stored with a
// fixed lifetime, so issue time = expiry - lifetime). null if none pending.
function verificationIssuedAt(user) {
  if (!user.verificationCodeExpiresAt) return null;
  return new Date(new Date(user.verificationCodeExpiresAt).getTime() - CODE_EXPIRY_MINUTES * 60 * 1000);
}

function secondsUntilResendAllowed(user) {
  const issuedAt = verificationIssuedAt(user);
  if (!issuedAt) return 0;
  const elapsed = (Date.now() - issuedAt.getTime()) / 1000;
  return Math.max(Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed), 0);
}

// Generates a fresh 6-digit code, stores only its bcrypt hash (plus a
// CODE_EXPIRY_MINUTES expiry and a reset attempts counter) on the given
// User instance, saves it, and emails the plaintext code once. Unless
// { force: true }, does nothing (returns false) while a code sent less than
// RESEND_COOLDOWN_SECONDS ago is still pending — this is what prevents
// duplicate verification emails. Returns true when a new code was sent.
async function issueVerificationCode(user, { force = false } = {}) {
  if (!force && secondsUntilResendAllowed(user) > 0) return false;
  const code = generateCode();
  user.verificationCodeHash = await hashCode(code);
  user.verificationCodeExpiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);
  user.verificationCodeAttempts = 0;
  await user.save();

  // sendEmail never throws (see emailService.js) — a delivery failure must
  // not block registration/verification, so this is intentionally not
  // wrapped in its own try/catch, which would risk swallowing an unrelated
  // thrown error instead.
  await sendEmail(
    user.emailAddress,
    'RSU SDPO - Verify Your Email',
    `Your RSU SDPO email verification code is ${code}. This code expires in ${CODE_EXPIRY_MINUTES} minutes. If you did not request this, you can safely ignore this email.`,
    { heading: 'Email Verification', recipientName: await recipientNameFor(user) }
  );
  return true;
}

// Same pattern as issueVerificationCode, but for the separate reset_code_*
// columns used by forgotPassword()/resetPassword().
async function issueResetCode(user) {
  const code = generateCode();
  user.resetCodeHash = await hashCode(code);
  user.resetCodeExpiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);
  user.resetCodeAttempts = 0;
  await user.save();

  await sendEmail(
    user.emailAddress,
    'RSU SDPO - Password Reset Code',
    `Your RSU SDPO password reset code is ${code}. This code expires in ${CODE_EXPIRY_MINUTES} minutes. If you did not request this, you can safely ignore this email.`,
    { heading: 'Password Reset', recipientName: await recipientNameFor(user) }
  );
}

exports.register = async (req, res) => {
  const { username, emailAddress, password, firstName, collegeOrUnit, borrowerCategory } = req.body;
  // Normalized to a string right away (never undefined/null) — Borrower's
  // lastName column is NOT NULL, so any caller that omits it entirely (not
  // just the frontend's single-word-name case) still gets a valid empty
  // string instead of a database error.
  const lastName = req.body.lastName || '';
  if (!username || !emailAddress || !password) {
    const err = new Error('username, emailAddress, and password are required');
    err.statusCode = 400;
    throw err;
  }
  // Self-registration always creates a Borrower account. Staff/admin roles
  // (Director, Admin, Staff) must never be assignable from the public
  // registration endpoint to prevent privilege escalation.
  const role = 'Borrower';
  // lastName is deliberately NOT required here — plenty of real names are
  // just one word, and requiring a second one used to push the frontend
  // into silently duplicating firstName into lastName so validation would
  // pass (see user-login.html's sign-up handler), which meant a one-word
  // name was stored and shown everywhere as "Name Name". The Borrower
  // model's lastName column only requires NOT NULL, not non-empty, so an
  // empty string is a perfectly valid value here.
  if (role === 'Borrower' && (!firstName || !collegeOrUnit || !borrowerCategory)) {
    const err = new Error('firstName, collegeOrUnit, and borrowerCategory are required to register as a borrower');
    err.statusCode = 400;
    throw err;
  }

  // An abandoned, never-verified prior signup at this email is safe to
  // overwrite and re-issue a code for: only the real inbox owner can ever
  // supply the correct code and thus ever actually use the new credentials,
  // so letting a fresh attempt replace a lost/expired first attempt avoids
  // permanently squatting the email address. Any other email collision (a
  // staff account, or an already-verified Borrower) is left to fall through
  // unchanged to the existing create-and-let-the-unique-constraint-reject
  // behavior below, exactly as before this feature existed.
  const existingByEmail = await User.findOne({
    where: { emailAddress },
    include: [{ model: Borrower, as: 'borrowerProfile' }]
  });
  if (existingByEmail && existingByEmail.userRole === 'Borrower' && !existingByEmail.emailVerified) {
    const usernameTaken = await User.findOne({
      where: { username, id: { [Op.ne]: existingByEmail.id } }
    });
    if (usernameTaken) {
      const err = new Error('That username is already taken');
      err.statusCode = 409;
      throw err;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // The re-submitted firstName/lastName/collegeOrUnit/borrowerCategory
    // (already validated as required above) must land on the associated
    // Borrower row, not just username/password on the User row — otherwise
    // a corrected name/college/category on a second registration attempt is
    // silently discarded and the stale first-attempt values persist
    // forever. Mirrors the User+Borrower transaction below (and
    // user.controller.js#updateProfile's borrowerProfile.save() pattern)
    // for the same atomicity: either both rows update together or neither
    // does.
    await sequelize.transaction(async (t) => {
      existingByEmail.username = username;
      existingByEmail.password = passwordHash;
      await existingByEmail.save({ transaction: t });

      if (existingByEmail.borrowerProfile) {
        existingByEmail.borrowerProfile.firstName = firstName;
        existingByEmail.borrowerProfile.lastName = lastName;
        existingByEmail.borrowerProfile.collegeOrUnit = collegeOrUnit;
        existingByEmail.borrowerProfile.borrowerCategory = borrowerCategory;
        await existingByEmail.borrowerProfile.save({ transaction: t });
      } else {
        // Defensive fallback only: every Borrower-role User created by this
        // controller gets a Borrower row atomically (see the transaction
        // below), so this should never actually run in practice — but
        // guard against a data inconsistency by creating the missing
        // profile rather than silently dropping the submitted fields.
        await Borrower.create(
          { userId: existingByEmail.id, firstName, lastName, collegeOrUnit, borrowerCategory },
          { transaction: t }
        );
      }
    });

    await issueVerificationCode(existingByEmail, { force: true });

    return res.status(201).json({ success: true, data: { email: existingByEmail.emailAddress } });
  }

  const existing = await User.findOne({ where: { username } });
  if (existing) {
    const err = new Error('That username is already taken');
    err.statusCode = 409;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await sequelize.transaction(async (t) => {
    const created = await User.create(
      { username, emailAddress, password: passwordHash, userRole: role, emailVerified: false },
      { transaction: t }
    );
    if (role === 'Borrower') {
      await Borrower.create(
        { userId: created.id, firstName, lastName, collegeOrUnit, borrowerCategory },
        { transaction: t }
      );
    }
    return created;
  });

  // Registration no longer means "logged in" — it means "check your email".
  // No token is issued and no full user object is serialized here; the
  // account only becomes usable once verifyRegistration() confirms the code.
  await issueVerificationCode(user, { force: true });

  res.status(201).json({ success: true, data: { email: user.emailAddress } });
};

exports.login = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    const err = new Error('username and password are required');
    err.statusCode = 400;
    throw err;
  }

  const user = await User.findOne({
    where: { [Op.or]: [{ username }, { emailAddress: username }] },
    include: [{ model: Borrower, as: 'borrowerProfile' }]
  });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    const err = new Error('Incorrect username or password');
    err.statusCode = 401;
    throw err;
  }
  // Must run before the accountStatus check below: accountStatus drives the
  // damage/loss borrower-restriction system, which doesn't meaningfully
  // apply to an account that isn't even a verified, real user yet. A user
  // who is both unverified and would-be-restricted should see the
  // verification message first.
  if (!user.emailVerified) {
    // The password was correct, so it's safe to tell the client which email
    // to verify — the login page uses it to open the code screen directly.
    const err = new Error('Please verify your email before signing in. Check your inbox for the verification code.');
    err.statusCode = 403;
    err.code = 'EMAIL_NOT_VERIFIED';
    err.details = { email: user.emailAddress };
    throw err;
  }
  // 'Restricted' (flagged for a damaged/lost item) may still sign in to see
  // their records; new borrowing requests are refused server-side in
  // borrow.controller.js. Only 'Blocked' locks the account out entirely.
  if (user.accountStatus === 'Blocked') {
    const err = new Error('This account is blocked. Please contact the SDPO office.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_BLOCKED';
    throw err;
  }

  res.json({ success: true, data: { user: serializeUser(user), token: signToken(user) } });
};

exports.verifyRegistration = async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    const err = new Error('email and code are required');
    err.statusCode = 400;
    throw err;
  }

  const user = await User.findOne({ where: { emailAddress: email } });
  // Deliberately identical wording to the expired/wrong-code cases below —
  // an unknown email must never be distinguishable from a known one with a
  // bad code, or this endpoint becomes an account-existence oracle.
  if (!user) {
    return res.status(400).json({ success: false, message: 'Invalid or expired code.' });
  }
  if (user.emailVerified) {
    return res.status(400).json({ success: false, message: 'This account is already verified. Please sign in.' });
  }
  if (!user.verificationCodeHash || !user.verificationCodeExpiresAt || user.verificationCodeExpiresAt < new Date()) {
    return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
  }
  if (user.verificationCodeAttempts >= MAX_CODE_ATTEMPTS) {
    return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
  }

  const matches = await compareCode(code, user.verificationCodeHash);
  if (!matches) {
    user.verificationCodeAttempts += 1;
    await user.save();
    return res.status(400).json({
      success: false,
      message: `Incorrect code. ${MAX_CODE_ATTEMPTS - user.verificationCodeAttempts} attempt(s) remaining.`
    });
  }

  user.emailVerified = true;
  user.verificationCodeHash = null;
  user.verificationCodeExpiresAt = null;
  user.verificationCodeAttempts = 0;
  await user.save();

  res.json({ success: true, message: 'Email verified. You can now sign in.' });
};

exports.resendVerification = async (req, res) => {
  const { email } = req.body;
  // Always the same response regardless of outcome — no enumeration of
  // whether the email exists or is already verified.
  const genericResponse = {
    success: true,
    message: 'If a pending verification exists for that email, a new code has been sent.'
  };

  if (email) {
    const user = await User.findOne({ where: { emailAddress: email } });
    if (user && !user.emailVerified) {
      await issueVerificationCode(user);
    }
  }

  // Same response whether or not a new email actually went out (cooldown,
  // unknown or already-verified address) — no account enumeration. The
  // client enforces the same cooldown on its Resend button.
  res.json({ ...genericResponse, data: { cooldownSeconds: RESEND_COOLDOWN_SECONDS } });
};

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  // Always the same response regardless of outcome — no enumeration of
  // whether an account exists at that email. Password reset intentionally
  // works for any role (Borrower or staff) and regardless of emailVerified
  // state, unlike registration verification.
  const genericResponse = {
    success: true,
    message: 'If an account exists with that email, a reset code has been sent.'
  };

  if (email) {
    const user = await User.findOne({ where: { emailAddress: email } });
    if (user) {
      await issueResetCode(user);
    }
  }

  res.json(genericResponse);
};

exports.resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;
  // register() applies no password-strength rule beyond requiring a
  // password be present at all (see exports.register above, and
  // helpers/verificationCode.js's comments) — this mirrors that exactly
  // rather than inventing a new minimum-length rule that doesn't exist
  // anywhere else in this codebase's registration path.
  if (!email || !code || !newPassword) {
    const err = new Error('email, code, and newPassword are required');
    err.statusCode = 400;
    throw err;
  }

  const user = await User.findOne({ where: { emailAddress: email } });
  // Deliberately identical wording whether the email exists or not — see
  // verifyRegistration above for the same no-enumeration rationale.
  if (!user) {
    return res.status(400).json({ success: false, message: 'Invalid or expired code.' });
  }
  if (!user.resetCodeHash || !user.resetCodeExpiresAt || user.resetCodeExpiresAt < new Date()) {
    return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
  }
  if (user.resetCodeAttempts >= MAX_CODE_ATTEMPTS) {
    return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
  }

  const matches = await compareCode(code, user.resetCodeHash);
  if (!matches) {
    user.resetCodeAttempts += 1;
    await user.save();
    return res.status(400).json({
      success: false,
      message: `Incorrect code. ${MAX_CODE_ATTEMPTS - user.resetCodeAttempts} attempt(s) remaining.`
    });
  }

  user.password = await bcrypt.hash(newPassword, 10);
  user.resetCodeHash = null;
  user.resetCodeExpiresAt = null;
  user.resetCodeAttempts = 0;
  await user.save();

  res.json({ success: true, message: 'Password reset successfully. Please sign in with your new password.' });
};

exports.me = async (req, res) => {
  const user = await User.findByPk(req.user.id, { include: [{ model: Borrower, as: 'borrowerProfile' }] });
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  res.json({ success: true, data: serializeUser(user) });
};
