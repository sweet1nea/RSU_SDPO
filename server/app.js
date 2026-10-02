require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const passport = require('passport');

const routes = require('./routes');
// Registers the Google OAuth 2.0 strategy against the shared passport
// singleton above (see server/config/passport.js for what "requiring this
// file" actually does). Required here, once, at server startup — routes
// that call passport.authenticate('google', ...) then resolve the
// already-registered strategy by name.
require('./config/passport');
const errorHandler = require('./middlewares/errorHandler');
const sequelize = require('./database/connection');
const { runOverdueSweep } = require('./jobs/overdueSweep');
const { runDueDateReminderSweep } = require('./jobs/dueDateReminderSweep');
const { runIncompleteRequirementsSweep } = require('./jobs/incompleteRequirementsSweep');
const { buildContentSecurityPolicyDirectives } = require('./config/csp');

const app = express();

// Vercel (and any reverse proxy in front of this app) always sets
// X-Forwarded-For on every request. Express's own proxy trust defaults to
// false, and express-rate-limit deliberately throws (not just warns) when it
// sees a forwarded-for header with proxy trust unset, since it can't safely
// tell real users apart in that state — this was silently turning every
// request to the 6 rate-limited auth routes below into a 500 once deployed
// behind Vercel (never reproduced in local dev, since localhost never sends
// X-Forwarded-For). `1` trusts exactly one hop (Vercel's own edge) — not
// `true`, which express-rate-limit's own validation separately warns against
// because it would let a client spoof its own IP via that same header and
// dodge rate limiting entirely.
app.set('trust proxy', 1);

// Core middleware
// See server/config/csp.js for why script-src/script-src-attr, img-src, and
// frame-src each diverge from helmet's strict defaults. hsts is disabled
// separately here (not in csp.js, since HSTS isn't a CSP directive): this
// server is plain HTTP only (no TLS listener) in development, and helmet's
// HSTS default tells the browser to force this origin to https on every
// future visit, which self-inflicts ERR_INVALID_HTTP_RESPONSE /
// ERR_SSL_PROTOCOL_ERROR against localhost once cached. Re-enable once this
// is actually served over HTTPS in production.
app.use(
  helmet({
    hsts: false,
    contentSecurityPolicy: {
      directives: buildContentSecurityPolicyDirectives()
    }
  })
);
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Stateless/JWT-based app — no express-session is set up anywhere, so
// passport is initialized without session support. Every
// passport.authenticate() call in server/routes/auth.routes.js passes
// { session: false } to match.
app.use(passport.initialize());

// Rate limit brute-force attempts against login/register specifically (not
// the whole API — every other route stays unlimited). This capstone has
// essentially zero real user base and is graded/demoed live, so the limit
// errs generous: 10 requests per 15 minutes per IP is loose enough that a
// grader retrying a typo'd password, or the whole panel testing the same
// classroom Wi-Fi/NAT IP during a demo, won't get locked out, while still
// stopping a scripted password-guessing loop, which needs far more than 10
// attempts per 15 minutes to be practically useful.
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' }
});

// Tighter limit for the email-verification/password-reset endpoints: each
// guards a brute-forceable 6-digit code (the controller itself also caps
// wrong guesses per code via MAX_CODE_ATTEMPTS, but this limiter caps how
// often a client can even request a fresh code or attempt one at all), so
// it errs stricter than authRateLimiter above.
//
// A factory, not a single shared instance: express-rate-limit's default
// MemoryStore keys hits by req.ip alone, with no awareness of which route
// path a request hit. Passing the SAME limiter instance to app.use() for
// multiple different paths (as this used to do) makes them all draw down
// one combined budget — e.g. two "Forgot password" clicks plus a couple of
// "Resend" clicks could exhaust the whole 5-per-15-minutes allowance and
// then block a legitimate resend with "Too many attempts", even though the
// user never called any single endpoint more than twice. Each endpoint
// below gets its own instance so a resend can't be blocked by an unrelated
// forgot-password attempt (or vice versa).
function makeCodeRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts. Please try again later.' }
  });
}

// API routes
app.use('/api/auth/login', authRateLimiter);
app.use('/api/auth/register', authRateLimiter);
app.use('/api/auth/verify-registration', makeCodeRateLimiter());
app.use('/api/auth/resend-verification', makeCodeRateLimiter());
app.use('/api/auth/forgot-password', makeCodeRateLimiter());
app.use('/api/auth/reset-password', makeCodeRateLimiter());
// API responses are live data (stock, statuses, dashboards) — never let a
// browser or proxy serve a cached copy. Routes that are safe to cache (the
// versioned equipment photo) override this header themselves.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', routes);

// Static client (optional, adjust if serving client separately)
// 2026-10-02: express.static() set no Cache-Control header at all by
// default here, only ETag/Last-Modified — and Vercel's build output
// normalizes file mtimes to a fixed, years-old date (observed:
// 2018-10-20), which browsers use to compute an RFC 7234 *heuristic*
// freshness lifetime when no Cache-Control is present. An old
// Last-Modified means a long heuristic lifetime, so Chrome kept serving
// a stale cached copy of pages/scripts for a returning visitor straight
// from disk cache, with no revalidation request ever reaching the
// server — even well after a new deploy landed. A staff member testing
// a just-shipped fix in an already-open browser saw the old behavior
// and reasonably reported it as broken again.
// Cache-Control: no-cache forces the browser to always revalidate with
// the server (a conditional GET using the ETag Express already sends),
// so a deploy is picked up on the very next request — at the cost of
// one cheap 304 round trip per asset when nothing changed, which is
// the right trade for a low-traffic internal office tool.
app.use(express.static('client', { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// Global error handler (must be last)
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`RSU SDPO server running on port ${PORT}`);
  try {
    await sequelize.authenticate();
    console.log(`Database connected (${sequelize.getDialect()} @ ${sequelize.config.host || 'DATABASE_URL'})`);

    // Notification Engine sweeps. Locally (and on any normal always-on
    // host), this process never exits, so running them once at startup and
    // then every hour via setInterval is enough — no new dependency needed.
    //
    // On Vercel, this whole file is loaded fresh per cold start and the
    // process is frozen/torn down between requests, so a setInterval timer
    // here has no guarantee of ever firing again — it is not a real
    // background scheduler on a serverless platform. There, the sweeps run
    // instead via Vercel Cron Jobs hitting GET /api/cron/sweep once a day
    // (see the `crons` entry in vercel.json and server/routes/cron.routes.js
    // for the same three functions called the same way). `VERCEL` is a
    // platform-provided env var set to '1' on every Vercel deployment, so
    // this skips the interval there instead of running a timer that would
    // silently do nothing.
    if (process.env.VERCEL) {
      console.log('Running on Vercel — notification sweeps run via Cron (GET /api/cron/sweep), not setInterval.');
    } else {
      function runNotificationSweeps() {
        runOverdueSweep().catch((err) => console.error('Overdue sweep failed:', err.message));
        runDueDateReminderSweep().catch((err) => console.error('Due date reminder sweep failed:', err.message));
        runIncompleteRequirementsSweep().catch((err) =>
          console.error('Incomplete requirements sweep failed:', err.message)
        );
      }
      runNotificationSweeps();
      setInterval(runNotificationSweeps, 60 * 60 * 1000);
    }
  } catch (err) {
    console.error('Database connection failed:', err.message);
    console.error('Check DATABASE_URL in .env — it must be the Supabase session pooler connection string.');
  }
});

module.exports = app;
