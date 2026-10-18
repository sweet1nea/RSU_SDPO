/*
 * Shared admin app shell.
 * Renders the sidebar + topbar (clock, notification bell) around the page's
 * own content, and wires Settings / Sign Out / Profile. Single source of
 * truth for every admin-flow screen — edit here, not per-page.
 *
 * Usage: <div id="app-root" data-page="dashboard" data-title="..." data-subtitle="...">
 *          ...page content...
 *        </div>
 *        <script src="{relative}/js/shared/app-shell.js"></script>
 */
(function () {
  // Apply the stored theme immediately, before anything else renders, so
  // there's no flash of the wrong theme. Settings page writes this same key.
  try {
    var storedTheme = localStorage.getItem('rsuSdpoTheme');
    if (storedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch (e) { /* localStorage unavailable — default to light */ }

  var root = document.getElementById('app-root');
  if (!root) return;

  var page = root.getAttribute('data-page') || '';
  var title = root.getAttribute('data-title') || '';
  var subtitle = root.getAttribute('data-subtitle') || '';
  var previewOpen = root.getAttribute('data-preview-open') || '';
  // 'admin' (default) or 'user' — picks which nav, sidebar identity block,
  // and notification set the shell renders. Set via <div id="app-root" data-role="user">.
  var role = root.getAttribute('data-role') || 'admin';

  // Path prefix: every admin-flow page lives one level under client/pages/<area>/,
  // so assets/css/js are always reached via ../../
  var base = '../../';

  var ADMIN_NAV = [
    { section: 'Main System', items: [
      { key: 'dashboard', label: 'Dashboard', href: base + 'pages/admin/dashboard.html', icon: base + 'assets/icons/icon-dashboard.svg' },
      { key: 'equipment', label: 'Equipment', href: base + 'pages/admin/equipment-showroom.html', icon: base + 'assets/images/icon-basketball.png' },
      { key: 'transactions', label: 'Transactions', href: base + 'pages/admin/transaction-management.html', icon: base + 'assets/images/icon-transaction.png' }
    ]},
    { section: 'Management', items: [
      { key: 'damage-loss', label: 'Damage & Loss Records', href: base + 'pages/admin/damage-loss-management.html', icon: base + 'assets/images/icon-box-important.png' },
      { key: 'qr', label: 'QR Management', href: base + 'pages/admin/qr-management.html', icon: base + 'assets/images/icon-qr-code.png' }
    ]},
    { section: 'Reports', items: [
      { key: 'reports', label: 'Analytics', href: base + 'pages/admin/reports-analytics.html', icon: base + 'assets/images/icon-analytics.png' },
      { key: 'audit-log', label: 'Audit Log', href: base + 'pages/admin/audit-log.html', icon: base + 'assets/icons/icon-history.svg' }
    ]}
  ];

  // Borrower-facing nav: same sidebar/topbar chrome as admin, scoped to the
  // student self-service flow (browse → request → track → history).
  var USER_NAV = [
    { section: 'Main', items: [
      { key: 'user-equipment', label: 'Equipment Showroom', href: base + 'pages/user/equipment-showroom-figma.html', icon: base + 'assets/images/icon-basketball.png' }
    ]},
    { section: 'My Activity', items: [
      { key: 'my-requests', label: 'My Requests', href: base + 'pages/user/my-requests.html', icon: base + 'assets/icons/icon-clipboard.svg' },
      { key: 'my-borrowings', label: 'My Borrowings', href: base + 'pages/user/my-borrowings.html', icon: base + 'assets/images/icon-transaction.png' },
      { key: 'history', label: 'History', href: base + 'pages/user/history.html', icon: base + 'assets/icons/icon-history.svg' }
    ]}
  ];

  var NAV = role === 'user' ? USER_NAV : ADMIN_NAV;

  // Both admin and borrower notifications are backed by the real
  // /api/notifications data (loaded async below via loadRealNotifications),
  // so there's no static mock list for either role anymore — it starts
  // empty and fills in shortly after the shell renders.
  var NOTIFICATIONS = [];

  // Mirrors api.js#handleExpiredSession — kept as its own copy rather than
  // calling the api.js version directly, since this file is deliberately
  // self-contained and can't assume api.js was also loaded on this page.
  // If api.js *is* loaded, window.sessionExpiredRedirected there is a
  // separate flag from this closure's own, but the redirect itself is
  // idempotent (a second window.location.href to the same place is a
  // no-op in practice), so having two independent guards is harmless.
  var shellSessionExpiredRedirected = false;
  function shellHandleExpiredSession() {
    if (shellSessionExpiredRedirected) return;
    var storedRole = null;
    try {
      var raw = localStorage.getItem('rsuSdpoUser');
      storedRole = raw ? JSON.parse(raw).userRole : null;
    } catch (e) { /* malformed/missing — fall through to the admin default below */ }
    localStorage.removeItem('rsuSdpoToken');
    localStorage.removeItem('rsuSdpoUser');
    var target = storedRole === 'Borrower' ? base + 'pages/auth/user-login.html' : base + 'pages/auth/admin-login.html';
    if (/\/(user|admin)-login\.html$/.test(window.location.pathname)) return;
    shellSessionExpiredRedirected = true;
    window.location.href = target;
  }

  // Self-contained fetch helper (mirrors js/shared/api.js) so the shell
  // doesn't require every page to also include api.js just for the bell.
  function shellApiFetch(url, options) {
    options = options || {};
    var token = localStorage.getItem('rsuSdpoToken');
    var headers = Object.assign({}, options.headers || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, Object.assign({}, options, { headers: headers })).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (body && body.code === 'AUTH_EXPIRED') {
          shellHandleExpiredSession();
          throw new Error('Your session has expired. Please sign in again.');
        }
        if (!res.ok || !body || !body.success) {
          throw new Error((body && body.message) || 'Request failed (' + res.status + ')');
        }
        return body.data;
      });
    });
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var diffMs = Date.now() - new Date(iso).getTime();
    var mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
    var days = Math.round(hours / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return new Date(iso).toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function notifTypeClass(backendType) {
    if (backendType === 'Approval' || backendType === 'Release') return 'good';
    if (backendType === 'Rejection') return 'warn';
    if (backendType === 'New Request') return 'warn';
    return 'info';
  }

  // Loaded async after the shell renders (both roles now hit the real API).
  function loadRealNotifications(cb) {
    shellApiFetch('/api/notifications').then(function (rows) {
      NOTIFICATIONS = rows.map(function (n) {
        return {
          id: 'n' + n.id,
          dbId: n.id,
          type: notifTypeClass(n.type),
          unread: !n.isRead,
          text: n.message,
          time: timeAgo(n.sentAt)
        };
      });
      cb();
    }).catch(function () { cb(); });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function navHtml() {
    return NAV.map(function (group) {
      var links = group.items.map(function (item) {
        var active = item.key === page ? ' active' : '';
        return '<a class="nav-link' + active + '" data-key="' + item.key + '" href="' + item.href + '"><img src="' + item.icon + '" alt="">' + esc(item.label) + '</a>';
      }).join('');
      return '<div class="nav-section"><div class="nav-title">' + esc(group.section) + '</div>' + links + '</div>';
    }).join('');
  }

  // Same markup for every role — a boxed "user-card" (avatar + name/role,
  // linking to Settings) used to render here for admin/director/staff only,
  // sitting directly above a "Settings" button that already goes to the
  // exact same page. That was the same redundant-duplicate-entry pattern
  // already fixed on the borrower side (see the user-card removal noted
  // elsewhere in this file's history) — reported again here by the user
  // directly, comparing screenshots of both sidebars and asking for the
  // admin one to match the user one, which has never had this card.
  function userAreaHtml() {
    return (
      '<div class="user-area">' +
        '<div class="utility">' +
          '<button class="js-settings-btn"><img src="' + base + 'assets/icons/icon-settings.svg" alt="">Settings</button>' +
          '<button class="js-signout-btn"><img src="' + base + 'assets/icons/icon-signout.svg" alt="">Sign Out</button>' +
        '</div>' +
      '</div>'
    );
  }

  // Mobile-only: collapses the sidebar nav + settings/sign-out into a
  // hamburger button anchored at the top-right of the topbar, opening a
  // dropdown that carries the same nav links plus Settings / Sign Out.
  // Shown only under the 650px breakpoint (see app-shell.css); the desktop
  // sidebar stays as-is at wider widths.
  function mobileMenuHtml() {
    var utility =
      '<button class="js-settings-btn"><img src="' + base + 'assets/icons/icon-settings.svg" alt="">Settings</button>' +
      '<button class="js-signout-btn"><img src="' + base + 'assets/icons/icon-signout.svg" alt="">Sign Out</button>';
    return (
      '<div class="menu-wrap">' +
        '<button class="hamburger" id="hamburgerBtn" aria-haspopup="true" aria-expanded="false" aria-label="Open menu">' +
          '<span></span><span></span><span></span>' +
        '</button>' +
        '<div class="mobile-menu" id="mobileMenu" role="dialog" aria-label="Menu">' +
          navHtml() +
          '<div class="menu-divider"></div>' +
          '<div class="menu-utility">' + utility + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function sidebarHtml() {
    return (
      '<aside class="sidebar">' +
        '<div class="brand"><img class="brand-logo" src="' + base + 'assets/images/rsu-sdpo-logo.png" alt="RSU-SDPO logo">' +
          '<div><strong>RSU-<span>SDPO</span></strong><small>Sports Monitoring</small></div>' +
        '</div>' +
        '<nav class="nav">' + navHtml() + '</nav>' +
        userAreaHtml() +
      '</aside>'
    );
  }

  function topbarHtml() {
    return (
      '<header class="topbar">' +
        '<div><h1>' + esc(title) + '</h1><p>' + esc(subtitle) + '</p></div>' +
        '<div class="header-right">' +
          '<div class="online"><i></i>System Online</div>' +
          '<div class="clock"><span id="shellClockTime">--:-- --</span><small id="shellClockDate">Loading date…</small></div>' +
          '<div class="bell-wrap">' +
            '<button class="bell" id="notifBell" aria-haspopup="true" aria-expanded="false" aria-label="Show notifications">' +
              '<img src="' + base + 'assets/icons/icon-bell.svg" alt=""><span class="bell-dot"></span>' +
            '</button>' +
            notifPanelHtml() +
          '</div>' +
          mobileMenuHtml() +
        '</div>' +
      '</header>'
    );
  }

  function notifItemHtml(n, i) {
    return (
      '<div class="notif-item' + (n.unread ? ' notif-item-unread' : '') + '" data-index="' + i + '">' +
        '<span class="notif-dot-type notif-type-' + n.type + '"></span>' +
        '<div class="notif-item-body"><p>' + esc(n.text) + '</p><span>' + esc(n.time) + '</span></div>' +
      '</div>'
    );
  }

  function notifPanelHtml() {
    var items = NOTIFICATIONS.map(notifItemHtml).join('');
    return (
      '<div class="notif-panel" id="notifPanel" role="dialog" aria-label="Notifications">' +
        '<div class="notif-panel-head"><h3>Notifications</h3><button class="notif-mark-read" id="notifMarkRead">Mark all as read</button></div>' +
        '<div class="notif-list" id="notifList">' + (items || '<div class="notif-empty">You\'re all caught up.</div>') + '</div>' +
      '</div>'
    );
  }

  // Clicking a notification opens this — the "open it like an email" detail
  // view — instead of the item just sitting there unclickable in the panel.
  function notifDetailOverlayHtml() {
    return (
      '<div class="shell-modal-overlay" id="shellNotifDetailOverlay" hidden>' +
        '<div class="shell-modal" role="dialog" aria-modal="true" aria-labelledby="shellNotifDetailTitle">' +
          '<div class="shell-modal__header">' +
            '<p id="shellNotifDetailTitle">Notification</p>' +
            '<button type="button" class="shell-modal__close" id="shellNotifDetailClose" aria-label="Close"><img src="' + base + 'assets/icons/icon-close.svg" alt=""></button>' +
          '</div>' +
          '<div class="shell-modal__body">' +
            '<p class="shell-modal__meta" id="shellNotifDetailTime"></p>' +
            '<p class="shell-modal__message" id="shellNotifDetailMessage"></p>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function updateBellState() {
    var bell = document.getElementById('notifBell');
    var count = NOTIFICATIONS.filter(function (n) { return n.unread; }).length;
    if (bell) bell.classList.toggle('has-unread', count > 0);
  }

  // Re-renders just the panel body — used after the async real-data load
  // (user role) so the bell/panel reflect actual data instead of staying
  // empty until the next full page load.
  function refreshNotifPanel() {
    var list = document.getElementById('notifList');
    if (!list) return;
    var items = NOTIFICATIONS.map(notifItemHtml).join('');
    list.innerHTML = items || '<div class="notif-empty">You\'re all caught up.</div>';
    updateBellState();
  }

  function openNotifDetail(n) {
    var overlay = document.getElementById('shellNotifDetailOverlay');
    if (!overlay) return;
    document.getElementById('shellNotifDetailTime').textContent = n.time;
    document.getElementById('shellNotifDetailMessage').textContent = n.text;
    overlay.hidden = false;
  }

  function wireNotifications() {
    var bell = document.getElementById('notifBell');
    var panel = document.getElementById('notifPanel');
    var markRead = document.getElementById('notifMarkRead');
    var list = document.getElementById('notifList');
    var detailOverlay = document.getElementById('shellNotifDetailOverlay');
    var detailClose = document.getElementById('shellNotifDetailClose');
    if (!bell || !panel) return;

    function openPanel() {
      panel.classList.add('open');
      bell.setAttribute('aria-expanded', 'true');
    }
    function closePanel() {
      panel.classList.remove('open');
      bell.setAttribute('aria-expanded', 'false');
    }
    bell.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel.classList.contains('open')) closePanel(); else openPanel();
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { closePanel(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePanel(); if (detailOverlay) detailOverlay.hidden = true; } });

    // Opening a notification — like opening an email — marks it read and
    // shows the full message instead of the panel's truncated preview.
    list.addEventListener('click', function (e) {
      var item = e.target.closest('.notif-item');
      if (!item) return;
      var n = NOTIFICATIONS[Number(item.getAttribute('data-index'))];
      if (!n) return;
      openNotifDetail(n);
      if (n.unread) {
        n.unread = false;
        item.classList.remove('notif-item-unread');
        updateBellState();
        if (n.dbId) {
          shellApiFetch('/api/notifications/' + n.dbId + '/read', { method: 'PATCH' }).catch(function () {});
        }
      }
    });

    if (detailClose) detailClose.addEventListener('click', function () { detailOverlay.hidden = true; });
    if (detailOverlay) detailOverlay.addEventListener('click', function (e) { if (e.target === detailOverlay) detailOverlay.hidden = true; });

    markRead.addEventListener('click', function () {
      NOTIFICATIONS.forEach(function (n) { n.unread = false; });
      document.querySelectorAll('.notif-item-unread').forEach(function (el) { el.classList.remove('notif-item-unread'); });
      updateBellState();
      shellApiFetch('/api/notifications/read-all', { method: 'PATCH' }).catch(function () {});
    });

    if (previewOpen === 'notifications') openPanel();
  }

  function wireMobileMenu() {
    var toggle = document.getElementById('hamburgerBtn');
    var menu = document.getElementById('mobileMenu');
    if (!toggle || !menu) return;

    function openMenu() {
      menu.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
    }
    function closeMenu() {
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu.classList.contains('open')) closeMenu(); else openMenu();
    });
    menu.addEventListener('click', function (e) {
      // Let nav/profile links and the sign-out button act normally, just
      // close the menu afterwards instead of leaving it open mid-navigation.
      if (e.target.closest('a,button')) closeMenu();
    });
    document.addEventListener('click', function () { closeMenu(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  }

  function startClock() {
    var timeEl = document.getElementById('shellClockTime');
    var dateEl = document.getElementById('shellClockDate');
    function tick() {
      var now = new Date();
      // Always Philippine Time, matching every recorded timestamp.
      if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
      if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    tick();
    setInterval(tick, 1000);
  }

  function wireUtility() {
    // Settings/Sign Out now appear twice in the DOM — once in the desktop
    // sidebar, once in the mobile hamburger menu — so wire every match
    // instead of a single getElementById.
    document.querySelectorAll('.js-settings-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.location.href = base + (role === 'user' ? 'pages/user/settings.html' : 'pages/admin/admin-settings.html');
      });
    });
    document.querySelectorAll('.js-signout-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        confirmSignOut(btn, function () {
          localStorage.removeItem('rsuSdpoToken');
          localStorage.removeItem('rsuSdpoUser');
          window.location.href = base + (role === 'user' ? 'pages/auth/user-login.html' : 'pages/auth/admin-login.html');
        });
      });
    });
  }

  // "Are you sure you want to sign out?" dialog shared by borrowers and
  // SDPO staff/admins (both reach Sign Out through this same shell). The
  // safe choice — Cancel — has the initial focus, Esc / clicking outside /
  // Cancel all close it without signing out, and Tab stays inside the
  // dialog while it is open. Focus returns to the Sign Out button on cancel.
  // Automatic sign-outs (expired session, blocked account) do not go through
  // here — those happen in api.js / syncSessionUser and never ask.
  function confirmSignOut(trigger, onConfirm) {
    if (document.getElementById('signoutConfirmOverlay')) return;

    var overlay = document.createElement('div');
    overlay.className = 'signout-overlay';
    overlay.id = 'signoutConfirmOverlay';
    overlay.innerHTML =
      '<div class="signout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="signoutTitle" aria-describedby="signoutText">' +
        '<h2 class="signout-title" id="signoutTitle">Sign out?</h2>' +
        '<p class="signout-text" id="signoutText">You will need to sign in again to continue using RSU-SDPO.</p>' +
        '<div class="signout-actions">' +
          '<button type="button" class="signout-btn signout-btn--cancel" id="signoutCancel">Cancel</button>' +
          '<button type="button" class="signout-btn signout-btn--confirm" id="signoutConfirm">Sign Out</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var cancelBtn = overlay.querySelector('#signoutCancel');
    var confirmBtn = overlay.querySelector('#signoutConfirm');

    function close() {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (trigger && trigger.focus) trigger.focus();
    }
    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Tab') {
        // Keep keyboard focus inside the two-button dialog.
        e.preventDefault();
        (document.activeElement === cancelBtn ? confirmBtn : cancelBtn).focus();
      }
    }

    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      document.removeEventListener('keydown', onKeydown, true);
      onConfirm();
    });
    document.addEventListener('keydown', onKeydown, true);
    cancelBtn.focus();
  }

  // Keeps the cached signed-in user (name, Borrower Type, college, account
  // status) identical to the database on every page load, so a profile or
  // Borrower Type change made on another page/device shows up everywhere.
  // The server also re-validates the account on every API call, so an
  // unverified/blocked account is signed out here (AUTH_EXPIRED).
  function syncSessionUser() {
    if (!localStorage.getItem('rsuSdpoToken')) return;
    shellApiFetch('/api/auth/me').then(function (user) {
      var before = localStorage.getItem('rsuSdpoUser');
      var after = JSON.stringify(user);
      localStorage.setItem('rsuSdpoUser', after);
      if (before !== after) document.dispatchEvent(new CustomEvent('appshell:user-updated', { detail: user }));
    }).catch(function () { /* expired sessions are handled in shellApiFetch */ });
  }

  // --- Assemble shell ---
  var contentWrap = document.createElement('div');
  contentWrap.className = 'content';
  while (root.firstChild) contentWrap.appendChild(root.firstChild);

  var mainEl = document.createElement('main');
  mainEl.innerHTML = topbarHtml();
  mainEl.appendChild(contentWrap);

  var appEl = document.createElement('div');
  appEl.className = 'app';
  appEl.innerHTML = sidebarHtml();
  appEl.appendChild(mainEl);

  root.removeAttribute('id');
  root.className = 'app-shell-root';
  root.innerHTML = '';
  root.appendChild(appEl);

  var detailWrap = document.createElement('div');
  detailWrap.innerHTML = notifDetailOverlayHtml();
  document.body.appendChild(detailWrap.firstChild);

  startClock();
  wireNotifications();
  wireMobileMenu();
  updateBellState();
  wireUtility();
  loadRealNotifications(refreshNotifPanel);
  syncSessionUser();

  document.dispatchEvent(new Event('appshell:ready'));
})();
