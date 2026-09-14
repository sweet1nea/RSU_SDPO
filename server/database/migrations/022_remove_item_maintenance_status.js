'use strict';

// Reverts the Item-status half of migration 021. Confirmed via the real
// Supabase database before writing this migration that zero items are
// currently in either state (SELECT availability_status, count(*) FROM item
// GROUP BY 1 → only Available/Borrowed/Reserved rows exist), so this is a
// clean removal, not a data-loss risk.
//
// Postgres has no ALTER TYPE ... DROP VALUE, so removing an enum value for
// real (not just leaving it unreachable in application code) requires
// rebuilding the whole type: create a new type with only the values that
// should remain, repoint the column at it (the USING cast intentionally has
// no fallback — if a row somehow already holds 'Maintenance' or
// 'Decommissioned' when this runs, the cast fails loudly instead of silently
// coercing that row to something else), then drop the old type.
//
// The equipment.photo_path column added by the same migration 021 is a
// separate, still-wanted feature (equipment listing photos) and is
// deliberately left untouched here.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE enum_item_availability_status RENAME TO enum_item_availability_status_old;
      CREATE TYPE enum_item_availability_status AS ENUM ('Available', 'Borrowed', 'Reserved');
      ALTER TABLE item ALTER COLUMN availability_status DROP DEFAULT;
      ALTER TABLE item ALTER COLUMN availability_status TYPE enum_item_availability_status
        USING availability_status::text::enum_item_availability_status;
      ALTER TABLE item ALTER COLUMN availability_status SET DEFAULT 'Available'::enum_item_availability_status;
      DROP TYPE enum_item_availability_status_old;
    `);
  },

  async down(queryInterface) {
    // Same autocommit-per-statement ADD VALUE pattern as migration 021/014 —
    // restores the two values if this removal is ever reverted. Does not
    // restore the manual-status application code (qr.controller.js's
    // PATCH /api/qr/items/:id/status, the qr-management.html status
    // dropdown, etc.) — that was deleted outright by this same change, not
    // just disabled, since down() migrations only cover schema, not code.
    await queryInterface.sequelize.query(
      "ALTER TYPE enum_item_availability_status ADD VALUE IF NOT EXISTS 'Maintenance'"
    );
    await queryInterface.sequelize.query(
      "ALTER TYPE enum_item_availability_status ADD VALUE IF NOT EXISTS 'Decommissioned'"
    );
  }
};
