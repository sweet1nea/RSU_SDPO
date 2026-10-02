'use strict';

// One canonical identifier scheme, derived from each equipment's category,
// name and database primary key, so every module shows the same ID for the
// same record:
//
//   Equipment Code = <category initial><equipment-name word initials>
//                     + "-" + equipment_id padded to 2 digits
//                     e.g. category "Volleyball" + equipment name
//                     "Volleyball Ball" (id 48) → VVB-48
//   Item Code      = <Equipment Code> + "-" + unit sequence (2 digits)
//                     e.g. VVB-48-01
//
// The letter prefix is for quick human recognition only (e.g. scanning a
// shelf of labels, "VVB" reads as "Volleyball Ball" at a glance) — it is
// NOT what guarantees uniqueness. Two different equipment can legitimately
// share a prefix: "Badminton Net" and "Basketball Net" both read "BBN"
// (category initial "B" + "Net"'s initial "N"), becoming BBN-04 and BBN-08.
// The equipment_id after the dash is what actually tells them apart, same
// as before this scheme existed. The client never builds these itself; it
// always displays the values the API returns.
//
// Superseded format (2026-09 to 2026-10-02, see migration 023): plain
// "EQ-<equipmentId>-<sequence>", both padded to 3 digits. parseItemCode
// below still reads it (and anything shaped like it) the same way, so
// pre-existing data and any still-unresolved history keep working.

// First letter/digit in a string, uppercased, or '' if there isn't one.
function firstAlnumChar(value) {
  const match = String(value || '').match(/[A-Za-z0-9]/);
  return match ? match[0].toUpperCase() : '';
}

// One letter for the category (its very first character) followed by one
// letter per word of the equipment name — e.g. category "Volleyball" +
// equipment name "Volleyball Ball" → "V" + "V" + "B" = "VVB". Falls back to
// "EQ" when neither a category nor an equipment name is available, so a
// code is never generated with an empty prefix.
function letterPrefix(categoryName, equipmentName) {
  const catLetter = firstAlnumChar(categoryName);
  const nameLetters = String(equipmentName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(firstAlnumChar)
    .join('');
  return `${catLetter}${nameLetters}` || 'EQ';
}

function formatEquipmentCode(categoryName, equipmentName, equipmentId) {
  return `${letterPrefix(categoryName, equipmentName)}-${String(equipmentId).padStart(2, '0')}`;
}

function formatItemCode(categoryName, equipmentName, equipmentId, sequence) {
  return `${formatEquipmentCode(categoryName, equipmentName, equipmentId)}-${String(sequence).padStart(2, '0')}`;
}

// Returns { equipmentId, sequence } for any canonical item code — current
// scheme or the superseded EQ-XXX-YYY one — or null. Deliberately doesn't
// validate what the letter-prefix segment looks like (it's a free-form
// label, not something to check); it only requires the code to split into
// exactly 3 dash-separated parts with the last two being plain digits.
function parseItemCode(code) {
  const parts = String(code || '').trim().split('-');
  if (parts.length !== 3) return null;
  const [, equipmentIdStr, sequenceStr] = parts;
  if (!/^\d+$/.test(equipmentIdStr) || !/^\d+$/.test(sequenceStr)) return null;
  return { equipmentId: Number(equipmentIdStr), sequence: Number(sequenceStr) };
}

// Highest unit sequence already used for an equipment, given its items'
// codes — new units continue after it so a code is never reused.
function maxSequence(equipmentId, codes) {
  return (codes || []).reduce((max, code) => {
    const parsed = parseItemCode(code);
    return parsed && parsed.equipmentId === Number(equipmentId) ? Math.max(max, parsed.sequence) : max;
  }, 0);
}

module.exports = { formatEquipmentCode, formatItemCode, parseItemCode, maxSequence };
