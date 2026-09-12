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
// client/ pages use inline <script> blocks and inline onclick/onchange handlers
// throughout (not external .js files), so helmet's default CSP — which blocks
// inline scripts even under 'self' — silently breaks every click on the site.
// Relaxing script-src/script-src-attr here to match style-src's existing
// 'unsafe-inline'. Before any public deployment, migrate inline scripts to
// external files + nonces and drop this back to the strict default.
// This server is plain HTTP only (no TLS listener) in development. Helmet's
// defaults assume HTTPS: it sends Strict-Transport-Security and a CSP with
// upgrade-insecure-requests, which tell the browser to force this origin to
// https on every future visit. Since localhost:3000 never speaks TLS, that
// self-inflicts ERR_INVALID_HTTP_RESPONSE / ERR_SSL_PROTOCOL_ERROR once the
// browser caches the policy. Disable both here; re-enable hsts once this is
// actually served over HTTPS in production.
app.use(
  helmet({
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", "'unsafe-inline'"],
        'script-src-attr': ["'unsafe-inline'"],
        'upgrade-insecure-requests': null
      }
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
app.use('/api', routes);

// Static client (optional, adjust if serving client separately)
app.use(express.static('client'));

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
