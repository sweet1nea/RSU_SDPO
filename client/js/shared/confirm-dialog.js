/* ======================================================================
   Shared confirm / prompt popup dialog
   ----------------------------------------------------------------------
   Drop-in, self-contained replacement for the native window.confirm()
   and window.prompt() dialogs used across the admin and borrower pages.
   Native browser dialogs ("rsu-sdpo.vercel.app says...") look jarring and
   cannot be styled, so this module renders a themed popup modal instead
   and returns a Promise so call sites can simply `await` it.

   This file injects its own markup + scoped CSS the first time it is
   used, so it works on any page that already loads
   client/js/shared/app-shell.css (for the --page/--ink/--muted/--line/
   --softline custom properties) without depending on, or colliding
   with, any page's own .modal / .modal-overlay / .modal-box classes.

   Usage:
     const ok = await showConfirmDialog({
       title: 'Approve this request?',
       message: 'Transaction TN9-2026 will be approved.',
       kind: 'success',          // 'warning' (default) | 'danger' | 'success'
       confirmLabel: 'Approve',
       cancelLabel: 'Cancel'
     });
     if (!ok) return;

     const reason = await showPromptDialog({
       title: 'Reject this request?',
       message: 'Let the borrower know why.',
       placeholder: 'Reason for rejection',
       required: true
     });
     if (reason === null) return; // cancelled
   ====================================================================== */
(function () {
  "use strict";

  if (window.showConfirmDialog && window.showPromptDialog) return; // already loaded

  var STYLE_ID = "rsuConfirmDialogStyles";
  var injected = false;
  var els = null;
  var activeResolve = null;
  var isPrompt = false;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".rsu-confirm-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2600;display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .15s ease}" +
      ".rsu-confirm-overlay.rsu-confirm-show{opacity:1}" +
      ".rsu-confirm-overlay[hidden]{display:none}" +
      ".rsu-confirm-box{background:var(--page,#fff);color:var(--ink,#1d293d);border-radius:16px;width:380px;max-width:100%;max-height:88vh;overflow:auto;box-shadow:0 24px 60px rgba(7,16,30,.28);transform:translateY(8px) scale(.98);transition:transform .15s ease}" +
      ".rsu-confirm-overlay.rsu-confirm-show .rsu-confirm-box{transform:translateY(0) scale(1)}" +
      ".rsu-confirm-body{padding:30px 26px 6px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px}" +
      ".rsu-confirm-icon{width:52px;height:52px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;margin-bottom:10px;background:#fff4e0;color:#b45900}" +
      ".rsu-confirm-icon--danger{background:#fef2f2;color:#dc2626}" +
      ".rsu-confirm-icon--success{background:#eafff5;color:#00875a}" +
      ".rsu-confirm-title{font-size:17px;font-weight:800;color:var(--ink,#1d293d);margin:0}" +
      ".rsu-confirm-message{font-size:13px;line-height:1.55;color:var(--muted,#62748e);margin:0}" +
      ".rsu-confirm-input{width:100%;margin-top:6px;font-size:13px;border:1px solid var(--line,#e2e8f0);border-radius:9px;padding:10px 12px;font-family:inherit;color:var(--ink,#1d293d);background:var(--page,#fff)}" +
      ".rsu-confirm-input:focus{outline:none;border-color:#00a86b}" +
      ".rsu-confirm-input-error{font-size:11px;color:#dc2626;min-height:14px;margin-top:4px}" +
      ".rsu-confirm-footer{display:flex;gap:10px;padding:22px 26px 26px}" +
      ".rsu-confirm-footer button{flex:1;height:40px;border-radius:9px;font-size:13px;font-weight:700;border:0;cursor:pointer;font-family:inherit}" +
      ".rsu-confirm-cancel{background:var(--softline,#f1f5f9);color:var(--ink,#1d293d)}" +
      ".rsu-confirm-cancel:hover{background:var(--line,#e2e8f0)}" +
      ".rsu-confirm-ok{background:#00a86b;color:#fff}" +
      ".rsu-confirm-ok:hover{background:#00945f}" +
      ".rsu-confirm-ok--danger{background:#dc2626}" +
      ".rsu-confirm-ok--danger:hover{background:#c41e1e}";
    document.head.appendChild(style);
  }

  function injectMarkup() {
    if (document.getElementById("rsuConfirmOverlay")) return;
    var overlay = document.createElement("div");
    overlay.className = "rsu-confirm-overlay";
    overlay.id = "rsuConfirmOverlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="rsu-confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="rsuConfirmTitle">' +
      '<div class="rsu-confirm-body">' +
      '<div class="rsu-confirm-icon" id="rsuConfirmIcon">!</div>' +
      '<p class="rsu-confirm-title" id="rsuConfirmTitle">Are you sure?</p>' +
      '<p class="rsu-confirm-message" id="rsuConfirmMessage"></p>' +
      '<input type="text" class="rsu-confirm-input" id="rsuConfirmInput" hidden>' +
      '<div class="rsu-confirm-input-error" id="rsuConfirmInputError"></div>' +
      "</div>" +
      '<div class="rsu-confirm-footer">' +
      '<button type="button" class="rsu-confirm-cancel" id="rsuConfirmCancelBtn">Cancel</button>' +
      '<button type="button" class="rsu-confirm-ok" id="rsuConfirmOkBtn">OK</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);

    els = {
      overlay: overlay,
      icon: document.getElementById("rsuConfirmIcon"),
      title: document.getElementById("rsuConfirmTitle"),
      message: document.getElementById("rsuConfirmMessage"),
      input: document.getElementById("rsuConfirmInput"),
      inputError: document.getElementById("rsuConfirmInputError"),
      cancelBtn: document.getElementById("rsuConfirmCancelBtn"),
      okBtn: document.getElementById("rsuConfirmOkBtn"),
    };

    els.cancelBtn.addEventListener("click", function () {
      settle(isPrompt ? null : false);
    });
    els.okBtn.addEventListener("click", function () {
      if (isPrompt) {
        var val = els.input.value.trim();
        if (els.input.dataset.required === "1" && !val) {
          els.inputError.textContent = "This field is required.";
          els.input.focus();
          return;
        }
        settle(val);
      } else {
        settle(true);
      }
    });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) settle(isPrompt ? null : false);
    });
    overlay.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        settle(isPrompt ? null : false);
      } else if (e.key === "Enter" && (isPrompt ? document.activeElement === els.input : true)) {
        e.preventDefault();
        els.okBtn.click();
      }
    });
  }

  function ensureReady() {
    if (injected) return;
    injectStyles();
    injectMarkup();
    injected = true;
  }

  function settle(value) {
    if (!activeResolve) return;
    var resolve = activeResolve;
    activeResolve = null;
    els.overlay.classList.remove("rsu-confirm-show");
    setTimeout(function () {
      els.overlay.hidden = true;
    }, 150);
    resolve(value);
  }

  function open(opts, promptMode) {
    ensureReady();
    isPrompt = !!promptMode;
    var kind = opts.kind || "warning";

    els.icon.className = "rsu-confirm-icon rsu-confirm-icon--" + kind;
    els.icon.textContent = kind === "danger" ? "!" : kind === "success" ? "✓" : "!";
    els.title.textContent = opts.title || (promptMode ? "Provide more information" : "Are you sure?");
    els.message.textContent = opts.message || "";
    els.message.hidden = !opts.message;

    if (promptMode) {
      els.input.hidden = false;
      els.input.value = opts.defaultValue || "";
      els.input.placeholder = opts.placeholder || "";
      els.input.dataset.required = opts.required ? "1" : "0";
      els.inputError.textContent = "";
    } else {
      els.input.hidden = true;
      els.inputError.textContent = "";
    }

    els.cancelBtn.textContent = opts.cancelLabel || "Cancel";
    els.okBtn.textContent = opts.confirmLabel || (promptMode ? "Submit" : "Yes");
    els.okBtn.className = "rsu-confirm-ok" + (kind === "danger" ? " rsu-confirm-ok--danger" : "");

    els.overlay.hidden = false;
    requestAnimationFrame(function () {
      els.overlay.classList.add("rsu-confirm-show");
      if (promptMode) {
        els.input.focus();
      } else {
        els.okBtn.focus();
      }
    });

    return new Promise(function (resolve) {
      activeResolve = resolve;
    });
  }

  // confirm() replacement — resolves true/false.
  window.showConfirmDialog = function (opts) {
    return open(opts || {}, false);
  };

  // prompt() replacement — resolves the entered string, or null if cancelled.
  window.showPromptDialog = function (opts) {
    return open(opts || {}, true);
  };
})();
