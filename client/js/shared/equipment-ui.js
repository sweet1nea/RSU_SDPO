/* ======================================================================
   Shared equipment presentation — used by every role's equipment views
   (Borrower showroom, Admin/Staff/Director equipment management, request
   review) so the same equipment always shows the same image, ID and stock
   badge everywhere.
   ====================================================================== */
(function (global) {
  'use strict';

  var IMG = '../../assets/images/';

  // Real product photos, matched by what the item actually is (its name)
  // before falling back to its sport. A photo is only used when it shows
  // that kind of item. (equipment-baseball-helmet.png was previously named
  // "boxing-headgear" but actually shows a baseball batting helmet and bat,
  // so boxing headgear now gets the Boxing sport tile instead.)
  var NAME_RULES = [
    { test: /helmet|\bbat\b/i, category: 'Baseball', file: 'equipment-baseball-helmet.png' },
    { test: /helmet|\bbat\b/i, category: 'Softball', file: 'equipment-baseball-helmet.png' },
    { test: /glove/i, category: 'Boxing', file: 'equipment-boxing-gloves.png' },
    { test: /shuttle/i, file: 'equipment-badminton-shuttlecock.png' },
    { test: /chess\s*clock|\bclock\b/i, category: 'Chess', file: 'equipment-chess-clock.png' },
    { test: /volley\s*ball/i, file: 'equipment-volleyball.png' },
    { test: /basket\s*ball/i, file: 'equipment-basketball.png' },
    { test: /soccer|foot\s*ball|futsal/i, file: 'equipment-soccer-ball.png' }
  ];

  // Sport-level photo when the name doesn't identify the item more closely.
  var CATEGORY_PHOTO = {
    Basketball: 'equipment-basketball.png',
    Volleyball: 'equipment-volleyball.png',
    Football: 'equipment-soccer-ball.png',
    Futsal: 'equipment-soccer-ball.png',
    Badminton: 'equipment-badminton-shuttlecock.png',
    Boxing: 'equipment-boxing-gloves.png',
    Baseball: 'equipment-baseball-helmet.png'
  };

  // Sports with no product photo get a neutral tile with their own sport
  // symbol — never another sport's photo.
  var CATEGORY_ICON = {
    Badminton: '🏸', Baseball: '⚾', Basketball: '🏀', Boxing: '🥊', Chess: '♟', Football: '⚽',
    Futsal: '⚽', Volleyball: '🏐', 'Lawn Tennis': '🎾', 'Sports Training': '🏃', 'Sepak Takraw': '🏐',
    Softball: '🥎', 'Table Tennis': '🏓', Taekwondo: '🥋', 'Track & Field': '🏃', Swimming: '🏊'
  };

  function iconTile(category) {
    var emoji = CATEGORY_ICON[category] || '🏅';
    return 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="18" fill="#eef3f6"/>' +
      '<text x="60" y="80" text-anchor="middle" font-size="64">' + emoji + '</text></svg>'
    );
  }

  // Image for an equipment record: its uploaded photo if any, else the
  // best-matching product photo, else its sport tile.
  function equipmentImage(item) {
    if (item.photoUrl) return item.photoUrl;
    var name = item.name || item.equipmentName || '';
    var category = item.category && item.category.categoryName ? item.category.categoryName : item.category || '';
    for (var i = 0; i < NAME_RULES.length; i++) {
      var rule = NAME_RULES[i];
      if (rule.test.test(name) && (!rule.category || rule.category === category)) return IMG + rule.file;
    }
    return CATEGORY_PHOTO[category] ? IMG + CATEGORY_PHOTO[category] : iconTile(category);
  }

  // onerror handler string for an <img> showing equipment: falls back to
  // the sport tile (once) if a photo fails to load.
  function imageFallbackAttr(category) {
    return "this.onerror=null;this.src='" + iconTile(category).replace(/'/g, '%27') + "'";
  }

  // Approved RSU SDPO Availability Indicator — fixed thresholds, identical
  // on every page and to the server's maxBorrowableUnits():
  //   > 5 available = In Stock (Green), 4-5 = Low Stock (Yellow),
  //   1-3 = Critical Stock (Red), 0 = Out of Stock.
  function stockLevel(available) {
    if (available <= 3) return 'low';
    if (available <= 5) return 'limited';
    return 'available';
  }

  function stockLabel(available) {
    if (available <= 0) return 'Out of Stock';
    return { available: 'In Stock', limited: 'Low Stock', low: 'Critical Stock' }[stockLevel(available)];
  }

  // Server rule mirror: per-request cap incl. the 15% minimum-stock floor.
  function maxBorrowableUnits(available, total) {
    var cap = available > 5 ? 2 : available >= 4 ? 1 : 0;
    if (total > 0 && available <= Math.ceil(total * 0.15)) cap = 0;
    return cap;
  }

  global.EquipmentUI = {
    equipmentImage: equipmentImage,
    imageFallbackAttr: imageFallbackAttr,
    iconTile: iconTile,
    stockLevel: stockLevel,
    stockLabel: stockLabel,
    maxBorrowableUnits: maxBorrowableUnits
  };
})(window);
