/* Opens the print-ready Borrowing Sports Equipment Form (BSEF) for one
   transaction. The serialized transaction (same shape /api/borrow and
   /api/borrow/mine return) is handed to pages/shared/bsef-print.html through
   localStorage, so the print page needs no extra API call or permission. */
(function () {
  "use strict";
  window.openBsefPrint = function (txn) {
    if (!txn) return;
    try {
      localStorage.setItem("rsuSdpoBsefPrint", JSON.stringify(txn));
    } catch (e) {
      alert("Could not prepare the form for printing.");
      return;
    }
    var base = location.pathname.replace(/\/pages\/(admin|user)\/[^/]*$/, "");
    var w = window.open(base + "/pages/shared/bsef-print.html", "_blank");
    if (!w) alert("Please allow pop-ups to print the form.");
  };
})();
