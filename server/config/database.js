require('dotenv').config();

// Statically require the pg driver and hand it to Sequelize directly via
// `dialectModule`, instead of letting Sequelize load it itself with an
// internal `require(moduleName)` built from the `dialect: 'postgres'`
// string. That dynamic require is invisible to Vercel's dependency tracer
// (@vercel/nft), which only bundles node_modules it can see referenced by
// a literal `require('pg')` somewhere in the traced file graph — without
// this, `pg` gets silently left out of the deployed serverless function
// and every request crashes with "Please install pg package manually",
// even though `pg` is a direct dependency in package.json and installs
// and runs fine locally (where the whole node_modules folder is present).
const pg = require('pg');

/**
 * Sequelize CLI config — every environment connects to the same Supabase
 * Postgres project via DATABASE_URL. (Previously development pointed at a
 * local XAMPP MySQL instance; the team moved to Supabase as the single
 * source of truth for local dev and deployment alike.)
 */
const supabaseConfig = {
  use_env_variable: 'DATABASE_URL',
  dialect: 'postgres',
  dialectModule: pg,
  dialectOptions: {
    ssl: { require: true, rejectUnauthorized: false }
  },
  // 2026-10-01 system audit: public QR scans (GET /api/qr/lookup/:itemCode)
  // intermittently 500'd with raw-driver "Connection terminated
  // unexpectedly". Sequelize's default pool (max:5, idle:10000ms) is sized
  // for a long-lived server process with one steady pool — wrong for a
  // Vercel serverless function, where a cold-started instance can open up
  // to 5 connections it then holds idle for 10s, and concurrent cold starts
  // can exhaust Supabase's direct-connection limit. A small pool that's
  // quick to let go of idle connections leaves headroom for other
  // concurrently-running function instances sharing the same DB.
  //
  // NOTE: this is the code-side half of the fix. The other half lives in
  // Vercel's env config — DATABASE_URL should point at Supabase's pooled
  // "Transaction" connection string (port 6543, pgbouncer), not the direct
  // connection (port 5432); worth checking there too if 500s like this
  // keep happening after this change.
  pool: { max: 2, min: 0, idle: 5000, acquire: 20000, evict: 5000 },
  // Transparently retries a query once on exactly this class of transient
  // connection drop instead of surfacing it to whoever happened to be
  // scanning a QR code at that moment. Sequelize's own default retry list
  // already covers ConnectionError/TimeoutError; this adds the specific
  // "Connection terminated unexpectedly" message `pg` throws when the
  // server (or Supabase's pooler) drops an idle/cold connection.
  retry: { max: 2, match: [/Connection terminated unexpectedly/i, /ConnectionError/, /ETIMEDOUT/, /ECONNRESET/] }
};

module.exports = {
  development: supabaseConfig,
  test: supabaseConfig,
  production: supabaseConfig
};