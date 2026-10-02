/* ======================================================================
   Equipment Showroom
   Backed by the real database via /api/equipment and /api/categories.
   ====================================================================== */

(function () {
  "use strict";

  // Images, stock badges and the borrowing cap come from the shared
  // client/js/shared/equipment-ui.js so this page and the Borrower showroom
  // always show the same thing for the same equipment.
  var UI = window.EquipmentUI;

  /* ---------- State ---------- */
  var state = {
    equipment: [],
    categories: [], // [{id, categoryName}]
    search: "",
    category: "All Categories",
    formMode: "add", // 'add' | 'edit'
    editingId: null,
    detailsId: null,
    pendingConfirmAction: null,
  };

  var modalStack = [];

  /* ---------- DOM refs ---------- */
  var $ = function (id) {
    return document.getElementById(id);
  };

  var pageSubtitle = $("pageSubtitle");
  var openAddBtn = $("openAddBtn");
  var searchInput = $("searchInput");
  var toolbarCount = $("toolbarCount");
  var equipmentGrid = $("equipmentGrid");

  var categorySelect = $("categorySelect");
  var categoryTrigger = $("categoryTrigger");
  var categoryTriggerLabel = $("categoryTriggerLabel");
  var categoryPanel = $("categoryPanel");

  var detailsModalOverlay = $("detailsModalOverlay");
  var detailsHeroImg = $("detailsHeroImg");
  var detailsHeroId = $("detailsHeroId");
  var detailsName = $("detailsName");
  var detailsStockTotal = $("detailsStockTotal");
  var detailsStockPill = $("detailsStockPill");
  var detailsStockBar = $("detailsStockBar");
  var detailsStatTotal = $("detailsStatTotal");
  var detailsStatAvailable = $("detailsStatAvailable");
  var detailsStatBorrowed = $("detailsStatBorrowed");
  var detailsCategoryWrap = $("detailsCategoryWrap");
  var detailsDescriptionWrap = $("detailsDescriptionWrap");
  var detailsQrWrap = $("detailsQrWrap");
  var detailsEditBtn = $("detailsEditBtn");
  var detailsDeleteBtn = $("detailsDeleteBtn");
  var changePhotoBtn = $("changePhotoBtn");
  var photoFileInput = $("photoFileInput");
  var photoError = $("photoError");

  var formModalOverlay = $("formModalOverlay");
  var formModalTitle = $("formModalTitle");
  var formModalSubtitle = $("formModalSubtitle");
  var equipmentForm = $("equipmentForm");
  var fieldName = $("fieldName");
  var fieldNameError = $("fieldNameError");
  var fieldCategory = $("fieldCategory");
  var fieldCategoryError = $("fieldCategoryError");
  var fieldQuantity = $("fieldQuantity");
  var fieldQuantityError = $("fieldQuantityError");
  var fieldDescription = $("fieldDescription");
  var formCancelBtn = $("formCancelBtn");
  var formSubmitBtn = $("formSubmitBtn");
  var formSubmitIcon = $("formSubmitIcon");
  var formSubmitLabel = $("formSubmitLabel");

  var openAddCategoryBtn = $("openAddCategoryBtn");
  var addCategoryModalOverlay = $("addCategoryModalOverlay");
  var addCategoryForm = $("addCategoryForm");
  var fieldNewCategoryName = $("fieldNewCategoryName");
  var fieldNewCategoryNameError = $("fieldNewCategoryNameError");
  var fieldNewCategoryDescription = $("fieldNewCategoryDescription");
  var addCategoryCancelBtn = $("addCategoryCancelBtn");
  var addCategorySubmitBtn = $("addCategorySubmitBtn");

  var confirmModalOverlay = $("confirmModalOverlay");
  var confirmIcon = $("confirmIcon");
  var confirmTitle = $("confirmTitle");
  var confirmMessage = $("confirmMessage");
  var confirmNoBtn = $("confirmNoBtn");
  var confirmYesBtn = $("confirmYesBtn");

  var toastStack = $("toastStack");

  /* ---------- Utilities ---------- */
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
      );
    });
  }

  function availableQty(item) {
    return item.availableQty > 0 ? item.availableQty : 0;
  }

  // Units actually out with borrowers (each unit's own status — reserved
  // units awaiting release are not "borrowed").
  function borrowedQty(item) {
    return item.borrowedQty;
  }

  // The canonical Equipment ID comes from the server (helpers/equipmentCode.js)
  // — the same ID that prefixes every QR item code for this equipment.
  function displayId(item) {
    return item.code;
  }

  function stockLevel(available) {
    return UI.stockLevel(available);
  }

  /* ---------- API ---------- */
  /* apiFetch() comes from client/js/shared/api.js, loaded before this file. */

  function loadCategories() {
    return apiFetch("/api/categories").then(function (rows) {
      state.categories = rows;
    });
  }

  function loadEquipment() {
    return apiFetch("/api/equipment").then(function (rows) {
      state.equipment = rows.map(function (e) {
        return {
          id: e.id,
          code: e.equipmentCode,
          name: e.equipmentName,
          categoryId: e.categoryId,
          category: e.category ? e.category.categoryName : "",
          totalQty: e.totalQuantity,
          availableQty: e.availableQuantity,
          borrowedQty: e.borrowedQuantity || 0,
          reservedQty: e.reservedQuantity || 0,
          itemCodes: e.itemCodes || [],
          description: e.description || "",
          photoUrl: e.photoUrl || null,
        };
      });
    });
  }

  /* ---------- Modal helpers ---------- */
  function openModal(overlay) {
    overlay.hidden = false;
    modalStack.push(overlay);
  }

  function closeModal(overlay) {
    overlay.hidden = true;
    var idx = modalStack.indexOf(overlay);
    if (idx > -1) modalStack.splice(idx, 1);
  }

  function wireOverlayClose(overlay) {
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeModal(overlay);
    });
  }

  [detailsModalOverlay, formModalOverlay, addCategoryModalOverlay, confirmModalOverlay].forEach(
    wireOverlayClose
  );

  document.querySelectorAll("[data-close-modal]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeModal($(btn.getAttribute("data-close-modal")));
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!categoryPanel.hidden) {
      closeCategoryPanel();
      return;
    }
    if (modalStack.length) {
      closeModal(modalStack[modalStack.length - 1]);
    }
  });

  /* ---------- Toasts ---------- */
  function showToast(message, type) {
    var toast = document.createElement("div");
    toast.className = "toast toast--" + (type === "danger" ? "danger" : "success");
    toast.innerHTML =
      '<span class="toast__dot"></span><span>' + escapeHtml(message) + "</span>";
    toastStack.appendChild(toast);
    setTimeout(function () {
      toast.remove();
    }, 3200);
  }

  /* ---------- Confirm dialog ---------- */
  function openConfirm(kind, title, message, onYes) {
    confirmIcon.className = "confirm-icon confirm-icon--" + kind;
    confirmIcon.textContent = kind === "danger" ? "!" : "✓";
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmYesBtn.className = "btn " + (kind === "danger" ? "btn-danger" : "btn-primary");
    state.pendingConfirmAction = onYes;
    openModal(confirmModalOverlay);
  }

  confirmYesBtn.addEventListener("click", function () {
    var action = state.pendingConfirmAction;
    state.pendingConfirmAction = null;
    closeModal(confirmModalOverlay);
    if (typeof action === "function") action();
  });

  confirmNoBtn.addEventListener("click", function () {
    state.pendingConfirmAction = null;
    closeModal(confirmModalOverlay);
  });

  /* ---------- Category dropdown (toolbar) ---------- */
  function categoryNames() {
    return ["All Categories"].concat(state.categories.map(function (c) { return c.categoryName; }));
  }

  function renderCategoryPanel() {
    categoryPanel.innerHTML = categoryNames().map(function (cat) {
      var active = cat === state.category ? " category-select__option--active" : "";
      return (
        '<button type="button" class="category-select__option' +
        active +
        '" data-category="' +
        escapeHtml(cat) +
        '" role="option">' +
        escapeHtml(cat) +
        "</button>"
      );
    }).join("");
  }

  function openCategoryPanel() {
    categoryPanel.hidden = false;
    categoryTrigger.setAttribute("aria-expanded", "true");
  }

  function closeCategoryPanel() {
    categoryPanel.hidden = true;
    categoryTrigger.setAttribute("aria-expanded", "false");
  }

  categoryTrigger.addEventListener("click", function () {
    if (categoryPanel.hidden) openCategoryPanel();
    else closeCategoryPanel();
  });

  categoryPanel.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-category]");
    if (!btn) return;
    state.category = btn.getAttribute("data-category");
    categoryTriggerLabel.textContent = state.category;
    renderCategoryPanel();
    closeCategoryPanel();
    renderGrid();
  });

  document.addEventListener("click", function (e) {
    if (!categorySelect.contains(e.target)) closeCategoryPanel();
  });

  /* ---------- Grid rendering ---------- */
  function getFilteredEquipment() {
    var q = state.search.trim().toLowerCase();
    return state.equipment.filter(function (item) {
      var matchesCategory =
        state.category === "All Categories" || item.category === state.category;
      var matchesSearch =
        !q ||
        item.name.toLowerCase().indexOf(q) !== -1 ||
        displayId(item).toLowerCase().indexOf(q) !== -1;
      return matchesCategory && matchesSearch;
    });
  }

  // One management entry point per card: "View Details" opens stock, QR
  // codes, photo, Edit and Delete. (A second edit button on the card itself
  // duplicated the Edit action inside View Details and was removed.)
  function cardTemplate(item) {
    var avail = availableQty(item);
    var level = stockLevel(avail);
    return (
      '<div class="equipment-card" data-id="' + item.id + '">' +
        '<div class="equipment-card__media">' +
          '<img src="' + escapeHtml(UI.equipmentImage(item)) + '" alt="' + escapeHtml(item.name) + '" loading="lazy" onerror="' + UI.imageFallbackAttr(item.category) + '" />' +
          '<span class="equipment-card__badge equipment-card__badge--' + level + '">' + UI.stockLabel(avail) + "</span>" +
          '<div class="equipment-card__id-strip"><span class="equipment-card__id">' + escapeHtml(displayId(item)) + "</span></div>" +
        "</div>" +
        '<div class="equipment-card__body">' +
          '<h3 title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + "</h3>" +
          '<div class="equipment-card__tags">' +
            '<span class="chip chip--neutral">' + escapeHtml(item.category) + "</span>" +
          "</div>" +
          '<div class="equipment-card__stock-row' + (level !== "available" ? " equipment-card__stock-row--" + level : "") + '">' +
            "<span>Available</span>" +
            "<span>" + avail + " / " + item.totalQty + "</span>" +
          "</div>" +
          '<div class="equipment-card__stock-row"><span>Borrowed</span><span>' + borrowedQty(item) + "</span></div>" +
          '<div class="equipment-card__actions">' +
            '<button type="button" class="btn-details" data-action="details" data-id="' + item.id + '">View Details</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  function emptyStateTemplate() {
    return (
      '<div class="empty-state">' +
        '<img src="../../assets/icons/icon-search.svg" alt="" style="width:32px;height:32px;opacity:.5" />' +
        '<p class="empty-state__title">No equipment found</p>' +
        "<p>Try adjusting your search term or category filter.</p>" +
      "</div>"
    );
  }

  function renderGrid() {
    var filtered = getFilteredEquipment();
    equipmentGrid.innerHTML = filtered.length
      ? filtered.map(cardTemplate).join("")
      : emptyStateTemplate();

    toolbarCount.textContent =
      "Showing " + filtered.length + " of " + state.equipment.length + " items";
    pageSubtitle.textContent = "Total: " + state.equipment.length + " items";
  }

  equipmentGrid.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var id = Number(btn.getAttribute("data-id"));
    var action = btn.getAttribute("data-action");
    if (action === "details") openDetailsModal(id);
  });

  searchInput.addEventListener("input", function () {
    state.search = searchInput.value;
    renderGrid();
  });

  /* ---------- Details modal ---------- */
  function openDetailsModal(id) {
    var item = state.equipment.find(function (i) {
      return i.id === id;
    });
    if (!item) return;
    state.detailsId = id;

    detailsHeroImg.src = UI.equipmentImage(item);
    detailsHeroImg.onerror = function () {
      detailsHeroImg.onerror = null;
      detailsHeroImg.src = UI.iconTile(item.category);
    };
    detailsHeroImg.alt = item.name;
    detailsHeroId.textContent = displayId(item);
    detailsName.textContent = item.name;

    var avail = availableQty(item);
    var level = stockLevel(avail);
    detailsStockTotal.textContent = item.totalQty + " total";
    detailsStockBar.style.width =
      item.totalQty > 0 ? (avail / item.totalQty) * 100 + "%" : "0%";
    detailsStockBar.className =
      "stock-overview__bar-fill" + (level !== "available" ? " stock-overview__bar-fill--" + level : "");
    detailsStockPill.textContent = UI.stockLabel(avail);
    detailsStockPill.className = "stock-pill stock-pill--" + (level === "available" ? "available" : level);
    detailsStatTotal.textContent = item.totalQty;
    detailsStatAvailable.textContent = avail;
    detailsStatBorrowed.textContent = borrowedQty(item);

    detailsCategoryWrap.innerHTML =
      '<span class="chip chip--neutral">' + escapeHtml(item.category) + "</span>";
    detailsDescriptionWrap.textContent = item.description || "—";

    // Unit QR codes all start with this equipment's code (e.g. VVB-48-01).
    detailsQrWrap.textContent = item.itemCodes.length
      ? item.itemCodes.length + " unit(s) — " + item.itemCodes.join(", ")
      : "No units registered";

    openModal(detailsModalOverlay);
  }

  detailsEditBtn.addEventListener("click", function () {
    var id = state.detailsId;
    closeModal(detailsModalOverlay);
    openEditModal(id);
  });

  detailsDeleteBtn.addEventListener("click", function () {
    confirmDelete(state.detailsId);
  });

  // Real per-listing photo upload — replaces the category stock icon that's
  // the only visual an Equipment listing has until one is uploaded. Scoped
  // to the Details modal since it needs an existing equipment id (a fresh
  // "Add Equipment" listing has nowhere to upload a photo to until it's
  // been created and this modal is opened for it).
  changePhotoBtn.addEventListener("click", function () {
    photoError.style.display = "none";
    photoFileInput.click();
  });

  photoFileInput.addEventListener("change", function () {
    var file = photoFileInput.files[0];
    photoFileInput.value = "";
    if (!file) return;
    var id = state.detailsId;
    if (!id) return;

    var formData = new FormData();
    formData.append("photo", file);
    changePhotoBtn.disabled = true;
    changePhotoBtn.textContent = "Uploading…";
    apiFetch("/api/equipment/" + id + "/photo", { method: "POST", body: formData })
      .then(function (updated) {
        state.equipment = state.equipment.map(function (e) {
          return e.id === id ? Object.assign({}, e, { photoUrl: updated.photoUrl }) : e;
        });
        detailsHeroImg.onerror = null;
        detailsHeroImg.src = updated.photoUrl; // versioned URL — changes only when the photo does
        renderGrid();
        showToast("Photo updated");
      })
      .catch(function (err) {
        photoError.textContent = err.message;
        photoError.style.display = "block";
      })
      .finally(function () {
        changePhotoBtn.disabled = false;
        changePhotoBtn.textContent = "Change Photo";
      });
  });

  /* ---------- Delete flow ---------- */
  function confirmDelete(id) {
    var item = state.equipment.find(function (i) {
      return i.id === id;
    });
    if (!item) return;
    openConfirm(
      "danger",
      "Delete Equipment?",
      'Are you sure you want to delete "' + item.name + '" (' + displayId(item) + ")? This action cannot be undone.",
      function () {
        apiFetch("/api/equipment/" + id, { method: "DELETE" })
          .then(function () {
            closeModal(detailsModalOverlay);
            return loadEquipment();
          })
          .then(function () {
            renderGrid();
            showToast("Equipment deleted successfully.", "danger");
          })
          .catch(function (err) {
            showToast(err.message, "danger");
          });
      }
    );
  }

  /* ---------- Add / Edit form modal ---------- */
  function resetFieldErrors() {
    [fieldName, fieldCategory, fieldQuantity].forEach(function (el) {
      el.removeAttribute("aria-invalid");
    });
    [fieldNameError, fieldCategoryError, fieldQuantityError].forEach(
      function (el) {
        el.classList.remove("field__error--visible");
      }
    );
  }

  function populateCategoryOptions() {
    var options = ['<option value="">Select category</option>'];
    state.categories.forEach(function (c) {
      options.push('<option value="' + c.id + '">' + escapeHtml(c.categoryName) + "</option>");
    });
    fieldCategory.innerHTML = options.join("");
  }

  function openAddModal() {
    state.formMode = "add";
    state.editingId = null;

    formModalTitle.textContent = "Add Equipment";
    formModalSubtitle.textContent = "An Equipment ID and one QR item code per unit are assigned automatically";

    equipmentForm.reset();
    fieldName.value = "";
    fieldCategory.value = "";
    fieldQuantity.value = "1";
    fieldDescription.value = "";
    resetFieldErrors();

    formSubmitIcon.hidden = false;
    formSubmitLabel.textContent = "Add Equipment";

    openModal(formModalOverlay);
  }

  function openEditModal(id) {
    var item = state.equipment.find(function (i) {
      return i.id === id;
    });
    if (!item) return;

    state.formMode = "edit";
    state.editingId = id;

    formModalTitle.textContent = "Edit Equipment";
    formModalSubtitle.textContent = "Editing " + displayId(item);

    fieldName.value = item.name;
    fieldCategory.value = item.categoryId;
    fieldQuantity.value = item.totalQty;
    fieldDescription.value = item.description || "";
    resetFieldErrors();

    formSubmitIcon.hidden = true;
    formSubmitLabel.textContent = "Save Changes";

    openModal(formModalOverlay);
  }

  openAddBtn.addEventListener("click", openAddModal);
  formCancelBtn.addEventListener("click", function () {
    closeModal(formModalOverlay);
  });

  /* ---------- Add Category modal ----------
     Opened from the "+ Add New" link next to the Equipment form's Category
     field, for a category the seeded list (server/database/seeders/
     001_seed_categories.js) doesn't cover. Deliberately skips the Yes/No
     confirm-dialog step used below for Add/Edit/Delete Equipment — adding a
     category has no destructive side effect worth a confirmation prompt. */
  function resetAddCategoryForm() {
    addCategoryForm.reset();
    fieldNewCategoryName.value = "";
    fieldNewCategoryDescription.value = "";
    fieldNewCategoryName.removeAttribute("aria-invalid");
    fieldNewCategoryNameError.classList.remove("field__error--visible");
  }

  openAddCategoryBtn.addEventListener("click", function () {
    resetAddCategoryForm();
    openModal(addCategoryModalOverlay);
    fieldNewCategoryName.focus();
  });

  addCategoryCancelBtn.addEventListener("click", function () {
    closeModal(addCategoryModalOverlay);
  });

  addCategorySubmitBtn.addEventListener("click", function () {
    var categoryName = fieldNewCategoryName.value.trim();
    if (!categoryName) {
      fieldNewCategoryName.setAttribute("aria-invalid", "true");
      fieldNewCategoryNameError.classList.add("field__error--visible");
      return;
    }
    fieldNewCategoryName.removeAttribute("aria-invalid");
    fieldNewCategoryNameError.classList.remove("field__error--visible");

    var description = fieldNewCategoryDescription.value.trim() || null;

    addCategorySubmitBtn.disabled = true;
    apiFetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryName: categoryName, description: description }),
    })
      .then(function (created) {
        // Re-fetch the full list (rather than just pushing the new one onto
        // state.categories) so it stays alphabetically sorted exactly like
        // a fresh page load — the same order the server already returns it
        // in (GET /api/categories orders by categoryName ASC).
        return loadCategories().then(function () {
          return created;
        });
      })
      .then(function (created) {
        populateCategoryOptions();
        renderCategoryPanel();
        // Select it in the Equipment form immediately — the whole point of
        // adding a category from here is to use it on the equipment being
        // added/edited right now, not to visit a separate management screen.
        fieldCategory.value = created.id;
        fieldCategory.removeAttribute("aria-invalid");
        fieldCategoryError.classList.remove("field__error--visible");
        closeModal(addCategoryModalOverlay);
        showToast('Category "' + created.categoryName + '" added.', "success");
      })
      .catch(function (err) {
        showToast(err.message, "danger");
      })
      .then(function () {
        addCategorySubmitBtn.disabled = false;
      });
  });

  function validateForm() {
    var valid = true;

    var name = fieldName.value.trim();
    if (!name) {
      fieldName.setAttribute("aria-invalid", "true");
      fieldNameError.classList.add("field__error--visible");
      valid = false;
    } else {
      fieldName.removeAttribute("aria-invalid");
      fieldNameError.classList.remove("field__error--visible");
    }

    var categoryId = fieldCategory.value;
    if (!categoryId) {
      fieldCategory.setAttribute("aria-invalid", "true");
      fieldCategoryError.classList.add("field__error--visible");
      valid = false;
    } else {
      fieldCategory.removeAttribute("aria-invalid");
      fieldCategoryError.classList.remove("field__error--visible");
    }

    var qty = parseInt(fieldQuantity.value, 10);
    if (isNaN(qty) || qty < 1) {
      fieldQuantity.setAttribute("aria-invalid", "true");
      fieldQuantityError.classList.add("field__error--visible");
      valid = false;
    } else {
      fieldQuantity.removeAttribute("aria-invalid");
      fieldQuantityError.classList.remove("field__error--visible");
    }

    return valid;
  }

  function collectFormData() {
    return {
      equipmentName: fieldName.value.trim(),
      categoryId: Number(fieldCategory.value),
      totalQuantity: parseInt(fieldQuantity.value, 10),
      description: fieldDescription.value.trim() || null,
    };
  }

  formSubmitBtn.addEventListener("click", function () {
    if (!validateForm()) return;

    var data = collectFormData();
    var isAdd = state.formMode === "add";

    openConfirm(
      "success",
      isAdd ? "Add Equipment?" : "Save Changes?",
      isAdd
        ? 'Are you sure you want to add "' + data.equipmentName + '" to the equipment inventory?'
        : 'Are you sure you want to save changes to "' + data.equipmentName + '"?',
      function () {
        var request = isAdd
          ? apiFetch("/api/equipment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            })
          : apiFetch("/api/equipment/" + state.editingId, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            });

        formSubmitBtn.disabled = true;
        request
          .then(function () {
            return loadEquipment();
          })
          .then(function () {
            closeModal(formModalOverlay);
            renderGrid();
            showToast(
              isAdd ? "Equipment added successfully." : "Equipment updated successfully.",
              "success"
            );
          })
          .catch(function (err) {
            showToast(err.message, "danger");
          })
          .then(function () {
            formSubmitBtn.disabled = false;
          });
      }
    );
  });

  /* ---------- Init ---------- */
  // Sidebar/topbar chrome (clock, Settings, Sign Out, logged-in user card) is
  // owned by app-shell.js now, not duplicated here.
  function init() {
    Promise.all([loadCategories(), loadEquipment()])
      .then(function () {
        populateCategoryOptions();
        renderCategoryPanel();
        renderGrid();
      })
      .catch(function (err) {
        showToast("Could not load equipment: " + err.message, "danger");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
