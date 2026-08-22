(() => {
  const state = {
    you: { cash: 0, items: [] },
    them: { cash: 0, items: [] },
    pickerSide: "you",
    pickerOpen: false,
    pickerKind: "all",
    pickerQuery: "",
    cardIndex: [],
    cardIndexLoaded: false,
    sealedIndex: [],
    sealedIndexLoaded: false,
    pricingBySetCode: {},
    pricingLoading: {},
    pickerTimer: null,
    catalogsLoading: null
  };

  const byId = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function decodeHtml(value) {
    const ta = document.createElement("textarea");
    ta.innerHTML = String(value || "");
    return ta.value;
  }

  function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "$0.00";
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatSignedMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) < 0.005) return formatMoney(0);
    const abs = formatMoney(Math.abs(n));
    return n > 0 ? `+${abs}` : `-${abs}`;
  }

  function toLooseQueryText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function uid() {
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function itemLineValue(item) {
    const qty = Math.max(1, Math.floor(Number(item.qty) || 1));
    const unit = Math.max(0, Number(item.unitPrice) || 0);
    return qty * unit;
  }

  function sideItemsValue(side) {
    return (state[side].items || []).reduce((sum, item) => sum + itemLineValue(item), 0);
  }

  function sideTotal(side) {
    return sideItemsValue(side) + Math.max(0, Number(state[side].cash) || 0);
  }

  function buildLocalCardImageUrl(setCode, cardNo) {
    const code = String(setCode || "").trim().toUpperCase();
    const no = String(cardNo || "").trim();
    if (!code || !no) return "";
    return `/card-images/${encodeURIComponent(code)}/${encodeURIComponent(no)}.jpg`;
  }

  function cardNumberLookupKeys(raw) {
    const q = String(raw || "").trim().replace(/^#/, "");
    if (!q) return [];
    const keys = new Set([q, q.toUpperCase()]);
    const stripped = q.replace(/^0+/, "");
    if (stripped) keys.add(stripped);
    const n = Number(stripped);
    if (Number.isFinite(n)) {
      keys.add(String(n));
      keys.add(String(n).padStart(3, "0"));
    }
    return [...keys];
  }

  function parseMoneyLabel(value) {
    const text = String(value || "");
    const withShip = text.match(/\$([0-9,]+\.?[0-9]*)\s*\+\s*\$([0-9,]+\.?[0-9]*)/i);
    if (withShip) {
      const listing = Number(String(withShip[1]).replace(/,/g, ""));
      const ship = Number(String(withShip[2]).replace(/,/g, ""));
      if (Number.isFinite(listing) && listing > 0 && Number.isFinite(ship) && ship >= 0) {
        return Number((listing + ship).toFixed(2));
      }
    }
    const only = text.match(/\$([0-9,]+\.?[0-9]*)/);
    if (!only) return null;
    const n = Number(String(only[1]).replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
  }

  /** Same market value preference as Sets tiles / collection. */
  function pickPriceFromPricingSlot(slot) {
    if (!slot || typeof slot !== "object") return null;
    const nm = Number(slot.nearMintPrice ?? slot.nearMintAddToCartPrice);
    const ship = Number(slot.shippingPrice);
    if (Number.isFinite(nm) && nm > 0 && Number.isFinite(ship) && ship >= 0) {
      return Number((nm + ship).toFixed(2));
    }
    const fromLabel = parseMoneyLabel(slot.nearMintWithShipping);
    if (fromLabel != null) return fromLabel;
    for (const raw of [slot.tcgplayerPrice, slot.marketPrice, slot.ungradedPrice, slot.price, nm]) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Number(n.toFixed(2));
    }
    return null;
  }

  function lookupCachedCardPrice(setCode, cardNo) {
    const code = String(setCode || "").trim().toUpperCase();
    const byCardNo = state.pricingBySetCode[code];
    if (!byCardNo || typeof byCardNo !== "object") return null;
    for (const key of cardNumberLookupKeys(cardNo)) {
      const price = pickPriceFromPricingSlot(byCardNo[key]);
      if (price != null) return price;
    }
    return null;
  }

  async function ensureSetPricing(setCode, setName = "") {
    const code = String(setCode || "").trim().toUpperCase();
    if (!code) return {};
    if (Object.prototype.hasOwnProperty.call(state.pricingBySetCode, code)) {
      return state.pricingBySetCode[code];
    }
    if (state.pricingLoading[code]) return state.pricingLoading[code];
    state.pricingLoading[code] = (async () => {
      try {
        const params = new URLSearchParams({ setCode: code });
        const cleanName = String(setName || "").trim();
        if (cleanName) params.set("setName", cleanName);
        const res = await fetch(`/api/sets/pricing?${params.toString()}`);
        const payload = res.ok ? await res.json() : null;
        const byCardNo =
          payload && payload.ok && payload.byCardNo && typeof payload.byCardNo === "object"
            ? payload.byCardNo
            : {};
        state.pricingBySetCode[code] = byCardNo;
        return byCardNo;
      } catch {
        state.pricingBySetCode[code] = {};
        return {};
      } finally {
        delete state.pricingLoading[code];
      }
    })();
    return state.pricingLoading[code];
  }

  async function fetchPriceChartingCardUngraded(setCode, cardNo, setName = "", cardName = "") {
    const code = String(setCode || "").trim().toUpperCase();
    const number = String(cardNo || "").trim();
    if (!code || !number) return null;
    try {
      const params = new URLSearchParams({
        setCode: code,
        cardNo: number,
        cacheOnly: "1"
      });
      if (setName) params.set("setName", setName);
      if (cardName) params.set("cardName", cardName);
      const res = await fetch(`/api/sets/pricecharting-card-details?${params.toString()}`);
      const payload = res.ok || res.status === 202 ? await res.json() : null;
      const ungraded = Number(payload?.ungradedPrice);
      if (Number.isFinite(ungraded) && ungraded > 0) return Number(ungraded.toFixed(2));
    } catch {
      /* ignore */
    }
    try {
      const params = new URLSearchParams({ setCode: code, cardNo: number });
      if (setName) params.set("setName", setName);
      if (cardName) params.set("card", cardName);
      const res = await fetch(`/api/providers/pricecharting/live-card?${params.toString()}`);
      const payload = res.ok ? await res.json() : null;
      const market = Number(payload?.live?.marketPrice);
      if (Number.isFinite(market) && market > 0) return Number(market.toFixed(2));
    } catch {
      /* ignore */
    }
    return null;
  }

  async function resolveCardUnitPrice(row) {
    const code = String(row?.setCode || "").trim().toUpperCase();
    const number = String(row?.cardNo || "").trim();
    const setName = String(row?.setDisplayName || "").trim();
    const cardName = String(row?.name || "").trim();
    const cached = lookupCachedCardPrice(code, number);
    if (cached != null) return cached;
    await ensureSetPricing(code, setName);
    const fromGuide = lookupCachedCardPrice(code, number);
    if (fromGuide != null) return fromGuide;
    const fromPc = await fetchPriceChartingCardUngraded(code, number, setName, cardName);
    return fromPc != null ? fromPc : 0;
  }

  async function resolveSealedUnitPrice(row) {
    const known = Number(row?.unitPrice);
    if (Number.isFinite(known) && known > 0) return Number(known.toFixed(2));
    const productId = String(row?.productId || "").trim();
    const productUrl = String(row?.productUrl || "").trim();
    if (!productId && !productUrl) return 0;
    try {
      const params = new URLSearchParams();
      if (productId) params.set("productId", productId);
      if (productUrl) params.set("productUrl", productUrl);
      if (row?.setCode) params.set("setCode", row.setCode);
      if (row?.setDisplayName) params.set("setName", row.setDisplayName);
      if (row?.name) params.set("productTitle", row.name);
      const res = await fetch(`/api/sets/sealed-product-details?${params.toString()}`);
      const payload = res.ok || res.status === 202 ? await res.json() : null;
      const ungraded = Number(payload?.ungradedPrice);
      if (Number.isFinite(ungraded) && ungraded > 0) return Number(ungraded.toFixed(2));
    } catch {
      /* ignore */
    }
    return 0;
  }

  function attachCachedPricesToRows(rows) {
    return rows.map((row) => {
      if (row.kind === "sealed") {
        const n = Number(row.unitPrice);
        return { ...row, unitPrice: Number.isFinite(n) && n > 0 ? n : 0 };
      }
      const cached = lookupCachedCardPrice(row.setCode, row.cardNo);
      return { ...row, unitPrice: cached != null ? cached : Number(row.unitPrice) || 0 };
    });
  }

  async function hydratePickerSetPricing(rows) {
    const needed = new Map();
    for (const row of rows) {
      if (row.kind !== "card") continue;
      const code = String(row.setCode || "").trim().toUpperCase();
      if (!code || state.pricingBySetCode[code]) continue;
      if (!needed.has(code)) needed.set(code, row.setDisplayName || "");
    }
    if (!needed.size) return;
    await Promise.all(
      [...needed.entries()].map(([code, name]) => ensureSetPricing(code, name).catch(() => ({})))
    );
  }

  async function loadCardIndex() {
    if (state.cardIndexLoaded) return;
    const res = await fetch("/api/sets/cards?language=english");
    const payload = res.ok ? await res.json() : null;
    const cards = [];
    if (payload && payload.ok && payload.byCode && typeof payload.byCode === "object") {
      for (const [setCode, entry] of Object.entries(payload.byCode)) {
        const cardMap = entry?.cards && typeof entry.cards === "object" ? entry.cards : {};
        const localImages = entry?.localImages && typeof entry.localImages === "object" ? entry.localImages : {};
        const remoteImages = entry?.images && typeof entry.images === "object" ? entry.images : {};
        const imagesByNo = { ...remoteImages, ...localImages };
        const setDisplayName = decodeHtml(String(entry?.sourceTitle || "")).trim() || String(setCode).toUpperCase();
        for (const [cardNo, cardNameRaw] of Object.entries(cardMap)) {
          const cardName = decodeHtml(String(cardNameRaw || "")).trim();
          if (!cardName) continue;
          const code = String(setCode).toUpperCase();
          const no = String(cardNo);
          const fromMaps = String(imagesByNo[no] || imagesByNo[cardNo] || "").trim();
          cards.push({
            id: `card:${code}:${no}`,
            kind: "card",
            name: cardName,
            setCode: code,
            cardNo: no,
            setDisplayName,
            imageUrl: fromMaps || buildLocalCardImageUrl(code, no),
            label: `${cardName} · ${setDisplayName} (${code} #${no})`
          });
        }
      }
    }
    cards.sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.setCode.localeCompare(b.setCode) || a.cardNo.localeCompare(b.cardNo)
    );
    state.cardIndex = cards;
    state.cardIndexLoaded = true;
  }

  async function loadSealedIndex() {
    if (state.sealedIndexLoaded) return;
    const res = await fetch("/api/sets/sealed");
    const payload = res.ok ? await res.json() : null;
    const byCode = payload && payload.ok && payload.byCode && typeof payload.byCode === "object" ? payload.byCode : {};
    const products = [];
    for (const [setCode, row] of Object.entries(byCode)) {
      const code = String(setCode || "").trim().toUpperCase();
      const setName = String(row?.name || code).trim();
      const list = Array.isArray(row?.products) ? row.products : [];
      for (const product of list) {
        const productId = String(product?.productId || "").trim();
        const title = String(product?.title || "").trim();
        if (!productId || !title) continue;
        const ungradedPrice = Number(product?.ungradedPrice);
        products.push({
          id: `sealed:${productId}`,
          kind: "sealed",
          name: title,
          setCode: code,
          setDisplayName: setName,
          productId,
          productUrl: String(product?.productUrl || "").trim(),
          productType: String(product?.productType || "other").trim(),
          imageUrl: String(product?.imageUrl || product?.remoteImageUrl || "").trim(),
          unitPrice: Number.isFinite(ungradedPrice) && ungradedPrice > 0 ? ungradedPrice : 0,
          label: `${title} · ${setName} (${code})`
        });
      }
    }
    products.sort((a, b) => a.name.localeCompare(b.name) || a.setCode.localeCompare(b.setCode));
    state.sealedIndex = products;
    state.sealedIndexLoaded = true;
  }

  async function ensureCatalogs() {
    if (state.catalogsLoading) return state.catalogsLoading;
    state.catalogsLoading = Promise.all([loadCardIndex(), loadSealedIndex()]).finally(() => {
      state.catalogsLoading = null;
    });
    return state.catalogsLoading;
  }

  function rowMatchesQuery(row, queryRaw) {
    const query = toLooseQueryText(queryRaw);
    if (!query) return false;
    const haystack = toLooseQueryText(
      [row.name, row.setCode, row.setDisplayName, row.cardNo, row.productType, row.label].filter(Boolean).join(" ")
    );
    if (haystack.includes(query)) return true;
    const tokens = query.split(" ").filter(Boolean);
    return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
  }

  function searchCatalog(queryRaw, kind, limit = 48) {
    const q = String(queryRaw || "").trim();
    if (q.length < 2) return [];
    const out = [];
    const wantCards = kind === "all" || kind === "card";
    const wantSealed = kind === "all" || kind === "sealed";
    if (wantCards) {
      for (const row of state.cardIndex) {
        if (!rowMatchesQuery(row, q)) continue;
        out.push(row);
        if (out.length >= limit) return out;
      }
    }
    if (wantSealed) {
      for (const row of state.sealedIndex) {
        if (!rowMatchesQuery(row, q)) continue;
        out.push(row);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  function renderSummary() {
    const host = byId("tradeSummary");
    if (!host) return;
    const youTotal = sideTotal("you");
    const themTotal = sideTotal("them");
    const delta = themTotal - youTotal;
    const abs = Math.abs(delta);
    const denom = Math.max(youTotal, themTotal, 1);
    const pct = (abs / denom) * 100;
    let tone = "fair";
    let verdict = "Even trade";
    if (abs < 0.5) {
      tone = "fair";
      verdict = "Even trade";
    } else if (pct <= 8) {
      tone = "close";
      verdict = delta > 0 ? "Slightly in your favor" : "Slightly in their favor";
    } else {
      tone = "skewed";
      verdict = delta > 0 ? "Trade favors you" : "Trade favors them";
    }
    host.innerHTML = `
      <div class="summary-stat">
        <div class="summary-label">You offer</div>
        <div class="summary-value tone-you">${escapeHtml(formatMoney(youTotal))}</div>
      </div>
      <div class="summary-stat">
        <div class="summary-label">They offer</div>
        <div class="summary-value tone-them">${escapeHtml(formatMoney(themTotal))}</div>
      </div>
      <div class="summary-stat">
        <div class="summary-label">Difference</div>
        <div class="summary-value tone-${tone}">${escapeHtml(formatSignedMoney(delta))}</div>
      </div>
      <div class="summary-stat">
        <div class="summary-label">Fairness</div>
        <div class="summary-value tone-${tone}">${escapeHtml(verdict)}</div>
      </div>
      <p class="summary-note">Positive difference means their side is worth more (better for you). Edit cash or unit prices anytime.</p>
    `;
  }

  function renderSide(side) {
    const list = byId(side === "you" ? "listYou" : "listThem");
    const totalEl = byId(side === "you" ? "totalYou" : "totalThem");
    const cashInput = document.querySelector(`[data-cash-side="${side}"]`);
    if (cashInput && document.activeElement !== cashInput) {
      cashInput.value = String(Number(state[side].cash) || 0);
    }
    if (totalEl) totalEl.textContent = formatMoney(sideTotal(side));
    if (!list) return;
    const items = state[side].items;
    if (!items.length) {
      list.innerHTML = `<li><p class="item-empty">No items yet. Click + Add to include cards or sealed products.</p></li>`;
      return;
    }
    list.innerHTML = items
      .map((item) => {
        const sealedClass = item.kind === "sealed" ? " is-sealed" : "";
        const thumb = item.imageUrl
          ? `<img class="trade-item-thumb${sealedClass}" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" />`
          : `<div class="trade-item-thumb-fallback${sealedClass}">No image</div>`;
        const sub =
          item.kind === "sealed"
            ? `${item.setDisplayName || item.setCode || ""} · Sealed`
            : `${item.setDisplayName || item.setCode || ""} · #${item.cardNo || ""}`;
        return `
          <li class="trade-item" data-item-id="${escapeHtml(item.id)}">
            ${thumb}
            <div class="trade-item-meta">
              <div class="trade-item-name">${escapeHtml(item.name)}</div>
              <div class="trade-item-sub">${escapeHtml(sub)}</div>
            </div>
            <div class="trade-item-controls">
              <div class="trade-item-line">
                <label>Qty</label>
                <input type="number" min="1" step="1" inputmode="numeric" data-field="qty" value="${Math.max(1, Math.floor(Number(item.qty) || 1))}" />
              </div>
              <div class="trade-item-line">
                <label>Unit $</label>
                <input type="number" min="0" step="0.01" inputmode="decimal" data-field="unitPrice" value="${Number(item.unitPrice || 0)}" ${item.pricePending ? 'aria-busy="true"' : ""} />
              </div>
              <div class="trade-item-value">${
                item.pricePending && !(Number(item.unitPrice) > 0)
                  ? `<span class="trade-item-pending">Loading…</span>`
                  : escapeHtml(formatMoney(itemLineValue(item)))
              }</div>
              <button type="button" class="trade-item-remove" data-remove>Remove</button>
            </div>
          </li>
        `;
      })
      .join("");
  }

  function renderAll() {
    renderSide("you");
    renderSide("them");
    renderSummary();
  }

  function syncAddButtons() {
    document.querySelectorAll("[data-add-side]").forEach((btn) => {
      const side = btn.getAttribute("data-add-side") === "them" ? "them" : "you";
      const open = state.pickerOpen && state.pickerSide === side;
      btn.textContent = open ? "Close" : "+ Add";
      btn.classList.toggle("ghost", open);
      btn.classList.toggle("primary", !open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  function openPicker(side) {
    const next = side === "them" ? "them" : "you";
    if (state.pickerOpen && state.pickerSide === next) {
      closePicker();
      return;
    }
    state.pickerSide = next;
    state.pickerOpen = true;
    const panel = byId("pickerPanel");
    const slot = document.querySelector(`[data-picker-slot="${next}"]`);
    const sub = byId("pickerSub");
    if (sub) {
      sub.textContent =
        next === "you" ? "Search and add items to your side" : "Search and add items to their side";
    }
    if (panel && slot) {
      slot.appendChild(panel);
      panel.hidden = false;
    }
    syncAddButtons();
    const search = byId("pickerSearch");
    if (search) {
      search.value = state.pickerQuery || "";
      search.focus();
    }
    void refreshPicker();
  }

  function closePicker() {
    state.pickerOpen = false;
    const panel = byId("pickerPanel");
    if (panel) panel.hidden = true;
    syncAddButtons();
  }

  function renderPickerResults(rows) {
    const grid = byId("pickerGrid");
    const status = byId("pickerStatus");
    if (!grid) return;
    if (!rows.length) {
      grid.innerHTML = "";
      if (status) {
        status.textContent =
          String(state.pickerQuery || "").trim().length < 2
            ? "Type at least 2 characters to search…"
            : "No matches. Try a different name, set, or number.";
      }
      return;
    }
    if (status) status.textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}`;
    grid.innerHTML = rows
      .map((row) => {
        const sealedClass = row.kind === "sealed" ? " is-sealed" : "";
        const media = row.imageUrl
          ? `<img src="${escapeHtml(row.imageUrl)}" alt="" loading="lazy" class="${row.kind === "sealed" ? "is-sealed" : ""}" />`
          : `<div class="picker-tile-fallback${sealedClass}">No image</div>`;
        const sub =
          row.kind === "sealed"
            ? `${row.setDisplayName || row.setCode} · Sealed`
            : `${row.setDisplayName || row.setCode} · #${row.cardNo}`;
        const price = Number(row.unitPrice) > 0 ? formatMoney(row.unitPrice) : "";
        return `
          <button type="button" class="picker-tile" role="option" data-pick-id="${escapeHtml(row.id)}">
            ${media}
            <div class="picker-tile-name">${escapeHtml(row.name)}</div>
            <div class="picker-tile-sub">${escapeHtml(sub)}</div>
            ${price ? `<div class="picker-tile-price">${escapeHtml(price)}</div>` : `<div class="picker-tile-price muted">—</div>`}
          </button>
        `;
      })
      .join("");
  }

  async function refreshPicker() {
    const status = byId("pickerStatus");
    if (status) status.textContent = "Loading catalog…";
    try {
      await ensureCatalogs();
    } catch {
      if (status) status.textContent = "Could not load catalog.";
      return;
    }
    const rows = searchCatalog(state.pickerQuery, state.pickerKind);
    renderPickerResults(attachCachedPricesToRows(rows));
    if (!rows.length) return;
    const token = `${state.pickerQuery}|${state.pickerKind}|${Date.now()}`;
    state.pickerHydrateToken = token;
    await hydratePickerSetPricing(rows);
    if (state.pickerHydrateToken !== token) return;
    renderPickerResults(attachCachedPricesToRows(rows));
  }

  async function hydrateTradeItemPrice(side, itemId, row) {
    const item = findItem(side, itemId);
    if (!item) return;
    let unitPrice = 0;
    if (row.kind === "sealed") {
      unitPrice = await resolveSealedUnitPrice(row);
    } else {
      unitPrice = await resolveCardUnitPrice(row);
    }
    const latest = findItem(side, itemId);
    if (!latest) return;
    if (Number(latest.unitPrice) > 0) {
      latest.pricePending = false;
      renderAll();
      return;
    }
    latest.unitPrice = Number.isFinite(unitPrice) ? unitPrice : 0;
    latest.pricePending = false;
    renderAll();
  }

  async function addCatalogRow(row) {
    const side = state.pickerSide === "them" ? "them" : "you";
    let unitPrice = Number(row.unitPrice) || 0;
    if (row.kind === "card" && !(unitPrice > 0)) {
      unitPrice = lookupCachedCardPrice(row.setCode, row.cardNo) || 0;
    }
    const itemId = uid();
    state[side].items.push({
      id: itemId,
      kind: row.kind,
      name: row.name,
      setCode: row.setCode || "",
      setDisplayName: row.setDisplayName || "",
      cardNo: row.cardNo || "",
      productId: row.productId || "",
      productUrl: row.productUrl || "",
      imageUrl: row.imageUrl || "",
      qty: 1,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      pricePending: !(unitPrice > 0)
    });
    renderAll();
    if (!(unitPrice > 0)) {
      void hydrateTradeItemPrice(side, itemId, row);
    }
  }

  function findItem(side, itemId) {
    return (state[side].items || []).find((item) => item.id === itemId) || null;
  }

  function bind() {
    document.querySelectorAll("[data-add-side]").forEach((btn) => {
      btn.addEventListener("click", () => openPicker(btn.getAttribute("data-add-side") || "you"));
    });

    byId("clearTradeBtn")?.addEventListener("click", () => {
      if (!window.confirm("Clear both sides of this trade?")) return;
      state.you = { cash: 0, items: [] };
      state.them = { cash: 0, items: [] };
      renderAll();
    });

    document.querySelectorAll("[data-cash-side]").forEach((input) => {
      input.addEventListener("input", () => {
        const side = input.getAttribute("data-cash-side") === "them" ? "them" : "you";
        state[side].cash = Math.max(0, Number(input.value) || 0);
        renderAll();
      });
    });

    ["listYou", "listThem"].forEach((listId) => {
      const list = byId(listId);
      if (!list) return;
      const side = listId === "listThem" ? "them" : "you";
      list.addEventListener("input", (event) => {
        const input = event.target.closest("input[data-field]");
        if (!input) return;
        const row = input.closest("[data-item-id]");
        const item = findItem(side, row?.getAttribute("data-item-id") || "");
        if (!item) return;
        const field = input.getAttribute("data-field");
        if (field === "qty") item.qty = Math.max(1, Math.floor(Number(input.value) || 1));
        if (field === "unitPrice") {
          item.unitPrice = Math.max(0, Number(input.value) || 0);
          item.pricePending = false;
        }
        renderAll();
      });
      list.addEventListener("click", (event) => {
        const removeBtn = event.target.closest("[data-remove]");
        if (!removeBtn) return;
        const row = removeBtn.closest("[data-item-id]");
        const id = row?.getAttribute("data-item-id") || "";
        state[side].items = state[side].items.filter((item) => item.id !== id);
        renderAll();
      });
    });

    byId("pickerCloseBtn")?.addEventListener("click", closePicker);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.pickerOpen) {
        closePicker();
      }
    });

    document.querySelectorAll("[data-picker-kind]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.pickerKind = btn.getAttribute("data-picker-kind") || "all";
        document.querySelectorAll("[data-picker-kind]").forEach((node) => {
          const on = node === btn;
          node.classList.toggle("active", on);
          node.setAttribute("aria-selected", on ? "true" : "false");
        });
        void refreshPicker();
      });
    });

    byId("pickerSearch")?.addEventListener("input", (event) => {
      state.pickerQuery = event.target.value || "";
      if (state.pickerTimer) clearTimeout(state.pickerTimer);
      state.pickerTimer = setTimeout(() => {
        void refreshPicker();
      }, 180);
    });

    byId("pickerGrid")?.addEventListener("click", (event) => {
      const tile = event.target.closest("[data-pick-id]");
      if (!tile) return;
      const id = tile.getAttribute("data-pick-id") || "";
      const row =
        state.cardIndex.find((item) => item.id === id) ||
        state.sealedIndex.find((item) => item.id === id);
      if (!row) return;
      void addCatalogRow(row);
    });
  }

  bind();
  renderAll();
  void ensureCatalogs().catch(() => {});
})();
