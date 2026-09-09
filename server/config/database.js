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
  }
};

module.exports = {
  development: supabaseConfig,
  test: supabaseConfig,
  production: supabaseConfig
};