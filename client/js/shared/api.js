/* ======================================================================
   Shared fetch helper for every page that talks to /api/*.
   Attaches the JWT (if logged in) and normalizes the {success,data} contract.
   ====================================================================== */

// Low finding, 2026-09-08 system audit: there was no handling anywhere for
// an expired/invalid session — every request after that point just failed
// with a generic "Request failed (401)" toast, over and over, with no way
// back to a working session short of the person noticing and manually
// signing out. `body.code === 'AUTH_EXPIRED'` (set only by
// authMiddleware.js, see server/middlewares/authMiddleware.js) is what
// distinguishes a real expired/missing session from an ordinary
// business-logic 401 elsewhere in the app (wrong login password, wrong
// current password on change-password) — those must NOT force a sign-out.
// `redirected` guards against firing more than once if several requests
// 401 around the same time.
var sessionExpiredRedirected = false;
function handleExpiredSession() {
  if (sessionExpiredRedirected) return;
  // Determine where to send the person back from the *stored* user's role,
  // not the current page — a borrower's expired session must land them on
  // user-login.html, never the staff admin-login.html, and vice versa.
  var role = null;
  try {
    var raw = localStorage.getItem('rsuSdpoUser');
    role = raw ? JSON.parse(raw).userRole : null;
  } catch (e) { /* malformed/missing — fall through to the admin default below */ }
  localStorage.removeItem('rsuSdpoToken');
  localStorage.removeItem('rsuSdpoUser');
  var target = role === 'Borrower' ? '/pages/auth/user-login.html' : '/pages/auth/admin-login.html';
  // Already on a login page (e.g. this 401 came from a forgot-password
  // request made while signed out) — nothing to redirect away from.
  if (/\/(user|admin)-login\.html$/.test(window.location.pathname)) return;
  sessionExpiredRedirected = true;
  window.location.href = target;
}

function apiFetch(url, options) {
  options = options || {};
  var token = localStorage.getItem('rsuSdpoToken');
  var headers = Object.assign({}, options.headers || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  return fetch(url, Object.assign({}, options, { headers: headers })).then(function (res) {
    return res.json().catch(function () { return null; }).then(function (body) {
      if (body && body.code === 'AUTH_EXPIRED') {
        handleExpiredSession();
        throw new Error('Your session has expired. Please sign in again.');
      }
      if (!res.ok || !body || !body.success) {
        // `code` and `details` carry the server's structured reason (e.g.
        // BORROWER_FLAGGED, PENDING_REPLACEMENT, EMAIL_NOT_VERIFIED) so pages
        // can react to the rule, not the wording of the message.
        var err = new Error((body && body.message) || 'Request failed (' + res.status + ')');
        err.status = res.status;
        err.code = body && body.code;
        err.details = body && body.data;
        throw err;
      }
      return body.data;
    });
  });
}

/* ---------- Philippine Time display ----------
   Every timestamp is recorded by the server; the browser only formats it,
   always in Asia/Manila so users in any timezone (or with a wrong device
   clock/timezone) see the same Philippine date and time. */
var PH_TIME_ZONE = 'Asia/Manila';

function formatPHDate(value) {
  if (!value) return '—';
  var d = new Date(value);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { timeZone: PH_TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPHTime(value) {
  if (!value) return '';
  var d = new Date(value);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { timeZone: PH_TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatPHDateTime(value) {
  if (!value) return '—';
  var d = new Date(value);
  return isNaN(d)
    ? '—'
    : d.toLocaleString('en-US', { timeZone: PH_TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

// "YYYY-MM-DD" for today in Philippine Time — the floor for date inputs.
function todayPHDateString() {
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: PH_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
}

// Random idempotency key for one submission attempt (see
// borrow.controller.js#createSelfRequest).
function newRequestKey() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
  var s = '';
  for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// Uploads a borrower document (Valid ID or Authorization Document) straight
// to Supabase Storage instead of through this app's own server — the only
// way past Vercel's hard 4.5MB-per-request body cap (see
// server/middlewares/uploadMiddleware.js). Three steps, all hidden behind
// this one call: ask the server for a short-lived signed upload URL (/sign),
// PUT the file to that URL directly, then tell the server the upload
// finished (/confirm) so it can verify what Storage actually received and
// swap the borrower's document pointer to it. `field` is 'validId' or
// 'authorizationDocument'. Returns the same {validIdUploaded,...} shape
// GET /api/borrowers/me/documents does.
//
// The PUT body is NOT the raw file. A signed-upload-URL PUT is not a plain
// S3-style presigned PUT — Supabase Storage's /object/upload/sign/{path}
// endpoint expects multipart/form-data: a "cacheControl" field plus the
// file itself appended under an EMPTY field name, exactly what the
// official @supabase/storage-js client sends from
// StorageFileApi#uploadToSignedUrl (confirmed by reading
// node_modules/@supabase/storage-js's own source — this project doesn't
// pull in the full supabase-js client on the frontend, just this one
// endpoint's contract). An earlier version of this function PUT the raw
// File as the body with a Content-Type header, which this project's own
// Playwright tests never caught because they mock the PUT and never
// exercise Storage's real contract — but it meant every document upload
// failed against the live Supabase project (2026-10-03 report: "uploading
// still isn't working"). Do not set a Content-Type header on this
// request — the browser must set its own multipart boundary for FormData.
function uploadBorrowerDocument(field, file) {
  return apiFetch('/api/borrowers/me/documents/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: field, contentType: file.type, size: file.size })
  }).then(function (signed) {
    var formData = new FormData();
    formData.append('cacheControl', '3600');
    formData.append('', file);
    return fetch(signed.uploadUrl, { method: 'PUT', body: formData, headers: { 'x-upsert': 'false' } }).then(function (putRes) {
      if (!putRes.ok) {
        throw new Error('Upload to storage failed (' + putRes.status + '). Please try again.');
      }
      return apiFetch('/api/borrowers/me/documents/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: field, key: signed.key })
      });
    });
  });
}

function currentUser() {
  var raw = localStorage.getItem('rsuSdpoUser');
  return raw ? JSON.parse(raw) : null;
}

function logout() {
  localStorage.removeItem('rsuSdpoToken');
  localStorage.removeItem('rsuSdpoUser');
  window.location.href = '/pages/auth/user-login.html';
}
