(function () {
  const state = {
    items: [],
    statusFilter: "all",
    retailerFilter: "all",
    search: "",
    sort: "name",
    sortDir: "asc"
  };

  const els = {
    stats: document.getElementById("statsRow"),
    body: document.getElementById("trackerBody"),
    foot: document.getElementById("tableFoot"),
    search: document.getElementById("searchInput"),
    retailer: document.getElementById("retailerFilter"),
    chips: document.getElementById("statusFilters"),
    table: document.getElementById("trackerTable"),
    sortByName: document.getElementById("sortByName"),
    sortByPrice: document.getElementById("sortByPrice")
  };

  const STATUS_LABELS = {
    in_stock: "In Stock",
    out_of_stock: "Out of Stock",
    preorder: "Preorder",
    unknown: "Unknown"
  };

  function normalizeStatusLabel(status, label) {
    const raw = String(label || "").trim();
    if (/currently unavailable/i.test(raw)) {
      return "Out of Stock";
    }
    if (raw) return raw;
    return STATUS_LABELS[status] || "Unknown";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parsePrice(value) {
    if (!value || value === "-" || /^see site$/i.test(value)) return null;
    const num = Number(String(value).replace(/[^0-9.]/g, ""));
    return Number.isFinite(num) ? num : null;
  }

  function getFilteredItems() {
    const q = state.search.trim().toLowerCase();
    return state.items.filter((item) => {
      if (state.statusFilter !== "all" && item.status !== state.statusFilter) return false;
      if (state.retailerFilter !== "all" && item.retailer !== state.retailerFilter) return false;
      if (!q) return true;
      const hay = `${item.name} ${item.retailer}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function sortItems(list) {
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (state.sort === "price") {
        const pa = parsePrice(a.lastPrice);
        const pb = parsePrice(b.lastPrice);
        if (pa == null && pb == null) return a.name.localeCompare(b.name);
        if (pa == null) return 1;
        if (pb == null) return -1;
        if (pb !== pa) {
          return state.sortDir === "asc" ? pa - pb : pb - pa;
        }
        return a.name.localeCompare(b.name);
      }
      const nameCmp = a.name.localeCompare(b.name);
      return state.sortDir === "asc" ? nameCmp : -nameCmp;
    });
    return sorted;
  }

  function updateSortHeaders() {
    const nameArrow = state.sort === "name" ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
    const priceArrow = state.sort === "price" ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
    if (els.sortByName) {
      els.sortByName.textContent = `NAME${nameArrow}`;
      els.sortByName.classList.toggle("active", state.sort === "name");
    }
    if (els.sortByPrice) {
      els.sortByPrice.textContent = `LAST PRICE${priceArrow}`;
      els.sortByPrice.classList.toggle("active", state.sort === "price");
    }
  }

  function setSort(nextSort) {
    if (nextSort !== "name" && nextSort !== "price") return;
    if (state.sort === nextSort) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sort = nextSort;
      state.sortDir = nextSort === "name" ? "asc" : "desc";
    }
    renderTable();
  }

  function countByStatus(items) {
    return items.reduce(
      (acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      },
      { in_stock: 0, out_of_stock: 0, preorder: 0, unknown: 0 }
    );
  }

  function getBaseFilteredItems() {
    const q = state.search.trim().toLowerCase();
    return state.items.filter((item) => {
      if (state.retailerFilter !== "all" && item.retailer !== state.retailerFilter) return false;
      if (!q) return true;
      const hay = `${item.name} ${item.retailer}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function renderStats() {
    const base = getBaseFilteredItems();
    const counts = countByStatus(base);
    const cards = [
      { key: "all", label: "Tracked listings", value: base.length, className: "" },
      { key: "in_stock", label: "In stock", value: counts.in_stock, className: "in_stock" },
      { key: "out_of_stock", label: "Out of stock", value: counts.out_of_stock, className: "out_of_stock" },
      { key: "preorder", label: "Preorder", value: counts.preorder, className: "preorder" }
    ];
    els.stats.innerHTML = cards
      .map(
        (card) => `
        <button
          type="button"
          class="stat-card ${escapeHtml(card.className)} ${state.statusFilter === card.key ? "active" : ""}"
          data-status="${escapeHtml(card.key)}"
          aria-pressed="${state.statusFilter === card.key ? "true" : "false"}"
        >
          <p class="label">${escapeHtml(card.label)}</p>
          <p class="value">${escapeHtml(card.value)}</p>
        </button>`
      )
      .join("");
  }

  function setStatusFilter(nextStatus) {
    const next = nextStatus || "all";
    state.statusFilter = state.statusFilter === next ? "all" : next;
    els.chips.querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.status === state.statusFilter);
    });
    render();
  }

  function populateRetailers() {
    const retailers = [...new Set(state.items.map((i) => i.retailer).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b)
    );
    const current = state.retailerFilter;
    els.retailer.innerHTML =
      `<option value="all">All Retailers</option>` +
      retailers
        .map(
          (name) =>
            `<option value="${escapeHtml(name)}"${name === current ? " selected" : ""}>${escapeHtml(name)}</option>`
        )
        .join("");
  }

  function renderTable() {
    updateSortHeaders();
    const filtered = sortItems(getFilteredItems());
    if (!filtered.length) {
      els.body.innerHTML =
        '<tr><td colspan="4" class="empty">No products match your filters.</td></tr>';
      els.foot.textContent = "0 listings shown";
      return;
    }

    els.body.innerHTML = filtered
      .map((item) => {
        const statusLabel = normalizeStatusLabel(item.status, item.statusLabel);
        const productHref = item.productUrl || item.statusUrl || "#";
        const statusHref = item.statusUrl || item.productUrl || "#";
        const remainingQty = Number(item.remainingQty || 0);
        const remainingMarkup =
          item.status === "in_stock" && Number.isFinite(remainingQty) && remainingQty > 0
            ? `<span class="remaining-note">${escapeHtml(`${remainingQty} Remaining`)}</span>`
            : "";
        const price = item.lastPrice || "—";
        const seller =
          item.retailer === "Amazon" ? String(item.lastSeller || item.sellerName || "").trim() : "";
        const sellerMarkup = seller ? `<div class="seller-line">Seller: ${escapeHtml(seller)}</div>` : "";
        const available = item.lastAvailable
          ? new Date(item.lastAvailable).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "—";
        return `
          <tr class="row-${escapeHtml(item.status)}">
            <td>
              <a class="product-link" href="${escapeHtml(productHref)}" target="_blank" rel="noopener noreferrer">
                ${escapeHtml(item.name)}
              </a>
              <span class="retailer-tag">${escapeHtml(item.retailer)}</span>
            </td>
            <td>
              <div class="status-wrap">
                <a class="status-pill ${escapeHtml(item.status)}" href="${escapeHtml(statusHref)}" target="_blank" rel="noopener noreferrer">
                  ${escapeHtml(statusLabel)}
                </a>
                ${remainingMarkup}
              </div>
            </td>
            <td class="price-cell">${escapeHtml(price)}${sellerMarkup}</td>
            <td class="date-cell">${escapeHtml(available)}</td>
          </tr>`;
      })
      .join("");

    const total = state.items.length;
    els.foot.textContent = `Showing ${filtered.length} of ${total} listings`;
  }

  function render() {
    renderStats();
    renderTable();
  }

  function bindEvents() {
    els.search.addEventListener("input", () => {
      state.search = els.search.value;
      render();
    });

    els.retailer.addEventListener("change", () => {
      state.retailerFilter = els.retailer.value;
      render();
    });

    els.table?.querySelector("thead")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-sort]");
      if (!btn) return;
      setSort(btn.dataset.sort || "");
    });

    els.chips.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-status]");
      if (!btn) return;
      setStatusFilter(btn.dataset.status || "all");
    });

    els.stats.addEventListener("click", (event) => {
      const card = event.target.closest("[data-status]");
      if (!card) return;
      setStatusFilter(card.dataset.status || "all");
    });
  }

  async function load() {
    try {
      const res = await fetch("/api/restock-tracker");
      const data = await res.json();
      state.items = Array.isArray(data.items) ? data.items : [];

      if (data.ok === false) {
        els.body.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(
          data.message || "Tracker data is not imported yet."
        )}</td></tr>`;
        els.foot.textContent = "";
        els.stats.innerHTML = "";
        return;
      }

      populateRetailers();
      render();
    } catch (err) {
      els.body.innerHTML = `<tr><td colspan="4" class="empty">Could not load restock data: ${escapeHtml(
        err.message || "network error"
      )}</td></tr>`;
      els.foot.textContent = "";
      els.stats.innerHTML = "";
    }
  }

  bindEvents();
  load();
})();
