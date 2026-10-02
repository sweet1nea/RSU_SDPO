'use strict';
// One-off reconciliation against the official Sports Equipment Inventory
// Report (Angelo Q. Maulion / Alphee F. Lachica, SDPO), run 2026-08-25.
// Confirmed by the user: merge the 3 duplicate equipment rows, add the
// extra Shuttle Cock line as a new equipment record with 0 available
// (matches the report's treatment of the other two shuttlecock lines as
// pure consumables), and register real QR/Item rows for the "Sustainable"
// (usable/borrowable) portion of every equipment type — additive only,
// never removing items that already exist for real (some are already
// attached to transactions).
//
// Safe to re-run: item registration only tops up to the target count and
// the duplicate/Shuttle Cock steps are no-ops once already applied.

require('dotenv').config();
const { Equipment, Category, Item, sequelize } = require('../models');
const { createUnits } = require('../controllers/equipment.controller');

// Sustainable (usable/available) count per equipment id, parsed from the
// report's Quantity/Sustainable columns. Ids 22/23/24 are the post-merge
// survivors for Resistant Rubber Band / Agility Ladder / Agility Cone.
const SUSTAINABLE_BY_ID = {
  1: 0, 2: 0, 3: 2, 4: 1, 5: 4, 6: 2, 7: 4, 8: 2, 9: 4, 10: 2,
  11: 2, 12: 4, 13: 5, 14: 8, 15: 0, 16: 0, 17: 3, 18: 1, 19: 5, 20: 8,
  21: 3, 22: 3, 23: 5, 24: 20, 25: 5, 26: 2, 27: 2, 28: 3, 29: 15, 30: 2,
  31: 13, 32: 2, 33: 4, 34: 2, 35: 5, 36: 1, 40: 10, 41: 4, 42: 2, 43: 3,
  44: 2, 45: 3, 46: 2, 47: 2, 48: 2, 49: 2, 50: 2
};
const DUPLICATE_IDS_TO_DELETE = [37, 38, 39]; // Sports Training copies of 22/23/24

// Same canonical unit codes as Equipment Management (helpers/equipmentCode.js).
// `equipment` here is already loaded with its category (see the findByPk
// below), so it's passed straight through.
async function generateItemsFor(equipment, qty, t) {
  await createUnits(equipment, qty, t);
  await Equipment.increment('availableQuantity', { by: qty, where: { id: equipment.id }, transaction: t });
}

async function main() {
  await sequelize.transaction(async (t) => {
    for (const id of DUPLICATE_IDS_TO_DELETE) {
      const removed = await Equipment.destroy({ where: { id }, transaction: t });
      if (removed) console.log(`Deleted duplicate equipment id=${id}`);
    }

    const badminton = await Category.findOne({ where: { categoryName: 'Badminton' }, transaction: t });
    const existingShuttleCock = await Equipment.findOne({ where: { equipmentName: 'Shuttle Cock' }, transaction: t });
    if (!existingShuttleCock) {
      const shuttleCock = await Equipment.create(
        { equipmentName: 'Shuttle Cock', categoryId: badminton.id, totalQuantity: 10, availableQuantity: 0, description: 'From official inventory report — consumable, no sustainable stock reported' },
        { transaction: t }
      );
      console.log(`Created equipment id=${shuttleCock.id} "Shuttle Cock" (totalQuantity=10, availableQuantity=0)`);
    } else {
      console.log('Shuttle Cock already exists, skipping creation');
    }

    for (const [idStr, target] of Object.entries(SUSTAINABLE_BY_ID)) {
      const id = Number(idStr);
      const equipment = await Equipment.findByPk(id, { include: [{ model: Category, as: 'category' }], transaction: t });
      if (!equipment) { console.log(`Skip id=${id}: not found`); continue; }
      const registered = await Item.count({ where: { equipmentId: id }, transaction: t });
      const needed = Math.max(target - registered, 0);
      if (needed === 0) {
        console.log(`${equipment.equipmentName} (id=${id}): already has ${registered} registered >= target ${target}, no action`);
        continue;
      }
      await generateItemsFor(equipment, needed, t);
      console.log(`${equipment.equipmentName} (id=${id}): registered ${needed} more item(s) (had ${registered}, target ${target})`);
    }
  });
  console.log('\nReconciliation complete.');
  process.exit(0);
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
