'use strict';

// 2026-10-02: Human-readable Item/Equipment codes.
//
// Until now every code was "EQ-<equipmentId>-<sequence>" (migration 023) —
// a prefix with no relationship to the equipment itself. The SDPO asked for
// codes staff can recognize at a glance on a shelf of labels, so the prefix
// now reads as the category's first letter followed by one letter per word
// of the equipment name — e.g. category "Volleyball" + equipment
// "Volleyball Ball" (id 48) → "VVB-48-01" for its first unit. See
// helpers/equipmentCode.js for the exact rule (and why two different
// equipment can legitimately share a letter prefix — e.g. "Badminton Net"
// and "Basketball Net" both read "BBN" — the equipment_id after the dash is
// still what guarantees uniqueness, same as before this scheme existed).
// Both the equipment id and the unit sequence are now padded to 2 digits
// instead of 3, since the id no longer has to carry the whole identity on
// its own.
//
// Every new value here is reconstructed, not looked up, from the same
// (equipment_id, sequence) pair the old code already encoded, so nothing
// is renumbered — a unit's place in its equipment's own sequence doesn't
// change, only how that pair is printed.
//
// legacy_item_code is backfilled with each unit's current (about-to-be-
// replaced) code, but only where it is still NULL — a unit that already
// carries a genuinely pre-2026-09 label (from migration 023's own
// standardization) keeps that one. Per the SDPO's own requirement
// ("regenerating a QR code always produces a new unique Item Code; the old
// code remains in history for audit purposes"), this preserves exactly one
// prior code per unit, not a full history.
//
// Postgres only (regexp_split_to_array, string_agg, substring-from-pattern).

const pad2 = (expr) => `(CASE WHEN length((${expr})::text) >= 2 THEN (${expr})::text ELSE lpad((${expr})::text, 2, '0') END)`;
const pad3 = (expr) => `(CASE WHEN length((${expr})::text) >= 3 THEN (${expr})::text ELSE lpad((${expr})::text, 3, '0') END)`;
// "<anything-without-a-dash>-<digits>-<digits>" — matches both the
// superseded EQ-XXX-YYY scheme and the new letter-prefixed one, same shape
// parseItemCode() in helpers/equipmentCode.js accepts.
const THREE_PART = "'^[^-]+-[0-9]+-[0-9]+$'";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (t) => {
      await queryInterface.sequelize.query(
        `UPDATE item SET legacy_item_code = item_code WHERE legacy_item_code IS NULL AND item_code ~ ${THREE_PART}`,
        { transaction: t }
      );

      await queryInterface.sequelize.query(
        `WITH lettered AS (
           SELECT
             i.item_id,
             i.equipment_id,
             split_part(i.item_code, '-', 3)::int AS sequence,
             COALESCE(upper(substring(c.category_name FROM '[A-Za-z0-9]')), '') AS cat_letter,
             COALESCE(
               (SELECT string_agg(upper(substring(word FROM '[A-Za-z0-9]')), '')
                  FROM unnest(regexp_split_to_array(trim(e.equipment_name), '\\s+')) AS word),
               ''
             ) AS name_letters
           FROM item i
           JOIN equipment e ON e.equipment_id = i.equipment_id
           LEFT JOIN categories c ON c.category_id = e.category_id
          WHERE i.item_code ~ ${THREE_PART}
         )
         UPDATE item
            SET item_code =
              CASE WHEN (lettered.cat_letter || lettered.name_letters) = '' THEN 'EQ'
                   ELSE (lettered.cat_letter || lettered.name_letters) END
              || '-' || ${pad2('lettered.equipment_id')}
              || '-' || ${pad2('lettered.sequence')}
           FROM lettered
          WHERE item.item_id = lettered.item_id`,
        { transaction: t }
      );
    });
  },

  // Best-effort reverse: rebuilds the superseded "EQ-<id>-<seq>" shape from
  // the same (equipment_id, sequence) pair embedded in the current code —
  // no data is lost by recomputing it this way. legacy_item_code is left
  // as-is, same looseness migration 023's own down() accepts (a unit that
  // had no legacy code before up() ran keeps the one up() backfilled).
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (t) => {
      await queryInterface.sequelize.query(
        `WITH parsed AS (
           SELECT item_id, equipment_id, split_part(item_code, '-', 3)::int AS sequence
             FROM item
            WHERE item_code ~ ${THREE_PART}
         )
         UPDATE item
            SET item_code = 'EQ-' || ${pad3('parsed.equipment_id')} || '-' || ${pad3('parsed.sequence')}
           FROM parsed
          WHERE item.item_id = parsed.item_id`,
        { transaction: t }
      );
    });
  }
};
