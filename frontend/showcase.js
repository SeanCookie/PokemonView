(() => {
  const els = {
    root: document.getElementById("showcaseRoot"),
    landing: document.getElementById("showcaseLanding"),
    hero: document.getElementById("showcaseHero"),
    stats: document.getElementById("showcaseStats"),
    ownerBanner: document.getElementById("showcaseOwnerBanner"),
    toolbar: document.getElementById("showcaseToolbar"),
    grid: document.getElementById("showcaseGrid"),
    binder: document.getElementById("showcaseBinder"),
    empty: document.getElementById("showcaseEmpty"),
    error: document.getElementById("showcaseError"),
    priceToggle: document.getElementById("showcasePriceToggle"),
    priceFilterWrap: document.getElementById("showcasePriceFilterWrap"),
    pagePrice: document.getElementById("showcasePagePrice"),
    imageZoom: document.getElementById("showcaseImageZoom"),
    imageZoomImg: document.getElementById("showcaseImageZoomImg"),
    imageZoomClose: document.getElementById("showcaseImageZoomClose"),
    tabs: document.querySelectorAll("[data-showcase-filter]")
  };

  const state = {
    username: "",
    profile: null,
    stats: null,
    items: [],
    binderPages: [],
    binderPageIndex: 0,
    filter: "all",
    priceOn: false,
    priceLoading: false,
    isOwner: false,
    setCatalogLookup: null,
    setPricingCache: new Map()
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: n >= 100 ? 0 : 2
    }).format(n);
  }

  function initialsFor(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }

  function parseUsernameFromLocation() {
    const path = window.location.pathname || "";
    const match = path.match(/\/showcase\/@?([a-z0-9_]{3,24})\/?$/i);
    if (match) return match[1].toLowerCase();
    const params = new URLSearchParams(window.location.search);
    const fromQuery = String(params.get("u") || params.get("user") || "").trim().replace(/^@+/, "");
    return fromQuery.toLowerCase();
  }

  function setVisible(el, visible) {
    if (!el) return;
    el.hidden = !visible;
  }

  function filteredItems() {
    if (state.filter === "binder") return [];
    return state.items.filter((item) => {
      if (state.filter !== "all" && item.type !== state.filter) return false;
      return true;
    });
  }

  const BINDER_PAGE_SIZES = [4, 9, 12, 16];
  const BINDER_GRID_COLS = { 4: 2, 9: 3, 12: 4, 16: 4 };

  function binderPageTitle(page) {
    const custom = String(page?.title || "").trim();
    if (custom) return custom;
    const pageNo = Number(page?.pageNumber) || 1;
    return `Binder page ${pageNo}`;
  }

  function binderPageSize(page) {
    const fromRaw = Number(page?.size);
    if (BINDER_PAGE_SIZES.includes(fromRaw)) return fromRaw;
    const fromSlots = Array.isArray(page?.slots) ? page.slots.length : 0;
    if (BINDER_PAGE_SIZES.includes(fromSlots)) return fromSlots;
    return 9;
  }

  function binderGridCols(size) {
    return BINDER_GRID_COLS[binderPageSize({ size })] || 3;
  }

  function normalizeShowcaseCardNo(raw) {
    let q = String(raw || "")
      .trim()
      .replace(/^#/, "");
    if (!q) return "";
    const slash = q.indexOf("/");
    if (slash > 0) q = q.slice(0, slash);
    return (q.replace(/^0+/, "") || "0").toUpperCase();
  }

  function itemUnitPrice(item) {
    const unit = Number(item?.unitValue);
    if (Number.isFinite(unit) && unit > 0) return unit;
    const total = Number(item?.totalValue);
    const qty = Math.max(1, Math.floor(Number(item?.quantity) || 1));
    if (Number.isFinite(total) && total > 0) return total / qty;
    return 0;
  }

  function buildBinderCollectionPriceIndex() {
    const byId = new Map();
    const byKey = new Map();
    const byName = new Map();
    for (const item of state.items) {
      if (!item || item.type === "sealed") continue;
      const price = itemUnitPrice(item);
      if (!(price > 0)) continue;
      const id = String(item.id || "").trim();
      if (id) byId.set(id, price);
      const code = String(item.setCode || "")
        .trim()
        .toUpperCase();
      const cardNo = normalizeShowcaseCardNo(item.cardNumber);
      if (code && cardNo) {
        const key = `${code}:${cardNo}`;
        const prev = byKey.get(key);
        if (!prev || price > prev) byKey.set(key, price);
      }
      const name = String(item.name || "")
        .trim()
        .toLowerCase();
      if (name) {
        const prev = byName.get(name);
        if (!prev || price > prev) byName.set(name, price);
      }
    }
    return { byId, byKey, byName };
  }

  async function ensureSetPricingManifest(setCode, setName = "") {
    const code = String(setCode || "")
      .trim()
      .toUpperCase();
    if (!code) return null;
    if (state.setPricingCache.has(code)) return state.setPricingCache.get(code);
    const pending = (async () => {
      try {
        const params = new URLSearchParams({ setCode: code });
        if (setName) params.set("setName", String(setName).trim());
        const res = await fetch(`/api/sets/pricing?${params.toString()}`);
        return res.ok ? await res.json().catch(() => null) : null;
      } catch {
        return null;
      }
    })();
    state.setPricingCache.set(code, pending);
    const manifest = await pending;
    state.setPricingCache.set(code, manifest);
    return manifest;
  }

  async function ensureBinderSlotPricing(slots) {
    const needed = new Map();
    for (const slot of slots) {
      if (!slot) continue;
      if (Number(slot.unitValue) > 0) continue;
      const code = String(slot.setCode || "")
        .trim()
        .toUpperCase();
      if (!code || !slot.cardNumber) continue;
      if (!needed.has(code)) needed.set(code, String(slot.setName || "").trim());
    }
    await Promise.all(
      [...needed.entries()].map(([code, setName]) => ensureSetPricingManifest(code, setName))
    );
  }

  function slotUnitPrice(slot, collectionIndex) {
    if (!slot) return 0;
    const embedded = Number(slot.unitValue);
    if (Number.isFinite(embedded) && embedded > 0) return embedded;

    const collectionItemId = String(slot.collectionItemId || "").trim();
    if (collectionItemId && collectionIndex?.byId?.has(collectionItemId)) {
      return Number(collectionIndex.byId.get(collectionItemId)) || 0;
    }

    const code = String(slot.setCode || "")
      .trim()
      .toUpperCase();
    const cardNo = normalizeShowcaseCardNo(slot.cardNumber);
    if (code && cardNo && collectionIndex?.byKey?.has(`${code}:${cardNo}`)) {
      return Number(collectionIndex.byKey.get(`${code}:${cardNo}`)) || 0;
    }

    if (code && slot.cardNumber) {
      const cached = state.setPricingCache.get(code);
      const manifest = cached && typeof cached.then !== "function" ? cached : null;
      const fromManifest = pickPriceFromManifest(manifest?.byCardNo, slot.cardNumber);
      if (fromManifest > 0) return fromManifest;
    }

    const name = String(slot.name || "")
      .trim()
      .toLowerCase();
    if (name && collectionIndex?.byName?.has(name)) {
      return Number(collectionIndex.byName.get(name)) || 0;
    }
    return 0;
  }

  function binderPagesList() {
    return Array.isArray(state.binderPages) ? state.binderPages : [];
  }

  function currentBinderPageSlots() {
    const pages = binderPagesList();
    const page = pages[state.binderPageIndex];
    if (!page) return [];
    const size = binderPageSize(page);
    const rawSlots = Array.isArray(page.slots) ? page.slots : [];
    return Array.from({ length: size }, (_, i) => rawSlots[i] || null);
  }

  function sumBinderPageValue(slots, collectionIndex) {
    let total = 0;
    for (const slot of slots) {
      if (!slot) continue;
      total += slotUnitPrice(slot, collectionIndex);
    }
    return Number(total.toFixed(2));
  }

  function syncToolbarControls() {
    const onBinder = state.filter === "binder";
    if (els.priceFilterWrap) els.priceFilterWrap.hidden = !onBinder;
    if (els.priceToggle) {
      els.priceToggle.classList.toggle("is-on", state.priceOn);
      els.priceToggle.setAttribute("aria-pressed", state.priceOn ? "true" : "false");
      els.priceToggle.disabled = Boolean(state.priceLoading);
    }
    if (!onBinder && els.pagePrice) {
      els.pagePrice.hidden = true;
      els.pagePrice.textContent = "";
    }
  }

  function syncPagePriceDisplay(total) {
    if (!els.pagePrice || !els.priceToggle) return;
    if (!state.priceOn || state.filter !== "binder") {
      els.pagePrice.hidden = true;
      els.pagePrice.textContent = "";
      return;
    }
    if (!showValuesEnabled()) {
      els.pagePrice.hidden = false;
      els.pagePrice.textContent = "Hidden";
      return;
    }
    if (state.priceLoading) {
      els.pagePrice.hidden = false;
      els.pagePrice.textContent = "…";
      return;
    }
    const n = Number(total);
    els.pagePrice.hidden = false;
    els.pagePrice.textContent =
      Number.isFinite(n) && n > 0 ? formatUsd(n) : "—";
  }

  async function refreshBinderPagePriceTotal() {
    if (!state.priceOn || state.filter !== "binder" || !showValuesEnabled()) {
      syncPagePriceDisplay(0);
      return;
    }
    const slots = currentBinderPageSlots();
    state.priceLoading = true;
    syncToolbarControls();
    syncPagePriceDisplay(0);
    try {
      await ensureBinderSlotPricing(slots);
    } finally {
      state.priceLoading = false;
    }
    const collectionIndex = buildBinderCollectionPriceIndex();
    const total = sumBinderPageValue(slots, collectionIndex);
    syncToolbarControls();
    syncPagePriceDisplay(total);
  }

  function closeBinderCardZoom() {
    if (!els.imageZoom) return;
    els.imageZoom.hidden = true;
    if (els.imageZoomImg) {
      els.imageZoomImg.removeAttribute("src");
      els.imageZoomImg.alt = "";
    }
  }

  function openBinderCardZoom(imageUrl, altText = "Card") {
    if (!els.imageZoom || !els.imageZoomImg) return;
    const url = String(imageUrl || "").trim();
    if (!url) return;
    els.imageZoomImg.src = url;
    els.imageZoomImg.alt = String(altText || "Card");
    els.imageZoom.hidden = false;
  }

  function renderHero() {
    const profile = state.profile;
    if (!profile) return;
    const name = profile.name || profile.username;
    const avatarHtml = profile.picture
      ? `<img src="${escapeHtml(profile.picture)}" alt="" />`
      : escapeHtml(initialsFor(name));
    const bio = profile.showcase?.bio
      ? `<p class="showcase-bio">${escapeHtml(profile.showcase.bio)}</p>`
      : "";
    const memberSince = profile.memberSince
      ? `<p class="showcase-bio" style="margin-top:4px;">Collecting since ${escapeHtml(
          new Date(profile.memberSince).toLocaleDateString()
        )}</p>`
      : "";

    let actions = "";
    if (state.isOwner) {
      actions = `
        <div class="showcase-actions">
          <a class="showcase-btn primary" href="/dashboard.html">Manage collection</a>
          <a class="showcase-btn" href="/settings.html#showcase">Showcase settings</a>
          <button type="button" class="showcase-btn" id="showcaseCopyLink">Copy link</button>
        </div>`;
    } else {
      actions = `<div class="showcase-actions">
          <a class="showcase-btn" href="/dashboard.html">Start your collection</a>
        </div>`;
    }

    els.hero.innerHTML = `
      <div class="showcase-avatar">${avatarHtml}</div>
      <div class="showcase-identity">
        <h1>${escapeHtml(name)}</h1>
        <p class="showcase-handle">@${escapeHtml(profile.username)}</p>
        ${bio}
        ${memberSince}
        ${actions}
      </div>`;

    const copyBtn = document.getElementById("showcaseCopyLink");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const url = `${window.location.origin}${profile.showcaseUrl || window.location.pathname}`;
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = "Copied!";
          setTimeout(() => {
            copyBtn.textContent = "Copy link";
          }, 1600);
        } catch {
          copyBtn.textContent = "Copy failed";
        }
      });
    }
  }

  function showValuesEnabled() {
    return state.profile?.showcase?.showValues !== false;
  }

  function normalizeSetTitle(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/é/g, "e")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function buildTitleToCodeMap(byCode) {
    const map = {};
    for (const [code, entry] of Object.entries(byCode || {})) {
      const upper = String(code || "").trim().toUpperCase();
      if (!upper) continue;
      for (const title of [entry?.sourceTitle, entry?.name, entry?.setName].filter(Boolean)) {
        const key = normalizeSetTitle(title);
        if (key && !map[key]) map[key] = upper;
      }
    }
    return map;
  }

  async function ensureSetCatalogLookup() {
    if (state.setCatalogLookup) return state.setCatalogLookup;
    const [enRes, jaRes] = await Promise.all([
      fetch("/api/sets/cards?language=english"),
      fetch("/api/sets/cards?language=japanese")
    ]);
    const en = enRes.ok ? await enRes.json().catch(() => ({})) : {};
    const ja = jaRes.ok ? await jaRes.json().catch(() => ({})) : {};
    state.setCatalogLookup = {
      titleToCode: {
        english: buildTitleToCodeMap(en.byCode),
        japanese: buildTitleToCodeMap(ja.byCode)
      },
      byCode: {
        english: en.byCode || {},
        japanese: ja.byCode || {}
      }
    };
    return state.setCatalogLookup;
  }

  function resolveShowcaseSetCode(item, lookup) {
    const existing = String(item?.setCode || "")
      .trim()
      .toUpperCase();
    if (existing) return existing;
    const lang = String(item?.setLanguage || "").toLowerCase() === "japanese" ? "japanese" : "english";
    const key = normalizeSetTitle(item?.setName);
    if (!key) return "";
    return lookup.titleToCode[lang][key] || lookup.titleToCode.english[key] || "";
  }

  function cardLookupKeys(cardNo) {
    const raw = String(cardNo || "").trim();
    const keys = new Set([raw, raw.toUpperCase()]);
    const beforeSlash = raw.match(/^([^/]+)\s*\/\s*.+$/)?.[1]?.trim() || "";
    if (beforeSlash) {
      keys.add(beforeSlash);
      keys.add(beforeSlash.toUpperCase());
    }
    for (const token of [raw, beforeSlash].filter(Boolean)) {
      const n = Number(token);
      if (Number.isFinite(n)) {
        keys.add(String(n));
        keys.add(String(n).padStart(3, "0"));
      }
      const stripped = token.replace(/^0+/, "");
      if (stripped) keys.add(stripped);
    }
    return [...keys];
  }

  function primaryCardNumberForLink(cardNumber) {
    const q = String(cardNumber || "").trim();
    const slash = q.match(/^([^/]+)\s*\/\s*.+$/);
    if (slash) return slash[1].trim();
    return q;
  }

  function buildShowcaseCardUrl(item, lookup = null) {
    let existing = String(item?.cardUrl || "").trim();
    if (existing) {
      try {
        const parsed = new URL(existing, window.location.origin);
        if (!parsed.searchParams.get("card") && !parsed.searchParams.get("cardNumber")) {
          existing = "";
        }
      } catch {
        existing = "";
      }
    }
    if (existing) return existing;
    const setCode = String(item?.setCode || "")
      .trim()
      .toUpperCase();
    const cardNo = primaryCardNumberForLink(item?.cardNumber);
    if (!setCode || !cardNo || item?.type !== "single") return "";
    const lang =
      String(item?.setLanguage || "").toLowerCase() === "japanese" ? "japanese" : "english";
    const entry =
      lookup?.byCode?.[lang]?.[setCode] || lookup?.byCode?.english?.[setCode] || null;
    let card = cardNo;
    if (entry?.cards && typeof entry.cards === "object") {
      for (const key of cardLookupKeys(cardNo)) {
        if (Object.prototype.hasOwnProperty.call(entry.cards, key)) {
          card = key;
          break;
        }
      }
    }
    const params = new URLSearchParams({ set: setCode, card });
    if (lang === "japanese") params.set("lang", "ja");
    if (state.username) {
      params.set("showcase", `/showcase/@${encodeURIComponent(state.username)}`);
    }
    return `/sets.html?${params.toString()}`;
  }

  function pickImageForItem(item, lookup) {
    const saved = String(item?.imageUrl || "").trim();
    if (saved) return saved;
    if (item?.type !== "single") return "";
    const setCode = resolveShowcaseSetCode(item, lookup);
    if (!setCode) return "";
    const lang = String(item?.setLanguage || "").toLowerCase() === "japanese" ? "japanese" : "english";
    const entry = lookup.byCode[lang][setCode] || lookup.byCode.english[setCode];
    if (!entry) return "";
    for (const map of [entry.localImages, entry.images]) {
      if (!map || typeof map !== "object") continue;
      for (const key of cardLookupKeys(item.cardNumber)) {
        const url = map[key];
        if (typeof url === "string" && url.trim()) return url.trim();
      }
    }
    return "";
  }

  function pickPriceFromManifest(byCardNo, cardNumber) {
    if (!byCardNo || typeof byCardNo !== "object") return 0;
    for (const key of cardLookupKeys(cardNumber)) {
      const slot = byCardNo[key];
      if (!slot) continue;
      const price = Number(slot.tcgplayerPrice) || Number(slot.nearMintAddToCartPrice) || 0;
      if (price > 0) return price;
    }
    return 0;
  }

  function recomputeShowcaseStats(items, baseStats = null) {
    const base = baseStats || state.stats || {};
    if (!showValuesEnabled()) return base;
    let marketValue = 0;
    let pricedLineItems = 0;
    for (const item of items) {
      const qty = Math.max(0, Number(item.quantity) || 0);
      const unit = Number(item.unitValue) || 0;
      if (unit > 0) {
        marketValue += unit * qty;
        pricedLineItems += 1;
      }
    }
    return {
      ...base,
      marketValue: Number(marketValue.toFixed(2)),
      pricedLineItems
    };
  }

  async function enhancePublicShowcaseItems(items) {
    const rows = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
    if (!rows.length) return rows;

    const lookup = await ensureSetCatalogLookup();
    const showValues = showValuesEnabled();
    const priceCache = new Map();

    for (const item of rows) {
      const setCode = resolveShowcaseSetCode(item, lookup);
      if (setCode) item.setCode = setCode;
      item.cardUrl = buildShowcaseCardUrl(item, lookup);
      const imageUrl = pickImageForItem(item, lookup);
      if (imageUrl) item.imageUrl = imageUrl;
    }

    if (!showValues) return rows;

    const bySet = new Map();
    for (const item of rows) {
      if (item.type !== "single") continue;
      if (Number(item.unitValue) > 0 || Number(item.totalValue) > 0) continue;
      const code = String(item.setCode || "").trim().toUpperCase();
      if (!code || !item.cardNumber) continue;
      if (!bySet.has(code)) {
        bySet.set(code, { setName: item.setName || "", items: [] });
      }
      bySet.get(code).items.push(item);
    }

    await Promise.all(
      [...bySet.entries()].map(async ([setCode, group]) => {
        let manifest = priceCache.get(setCode);
        if (!manifest) {
          const params = new URLSearchParams({ setCode });
          if (group.setName) params.set("setName", group.setName);
          const res = await fetch(`/api/sets/pricing?${params}`);
          manifest = res.ok ? await res.json().catch(() => null) : null;
          priceCache.set(setCode, manifest);
        }
        const byCardNo = manifest?.byCardNo || {};
        for (const item of group.items) {
          const unit = pickPriceFromManifest(byCardNo, item.cardNumber);
          if (unit <= 0) continue;
          const qty = Math.max(1, Number(item.quantity) || 1);
          item.unitValue = Number(unit.toFixed(2));
          item.totalValue = Number((unit * qty).toFixed(2));
        }
      })
    );

    return rows;
  }

  function renderStats() {
    const stats = state.stats || {};
    const cards = [];
    cards.push({ label: "Unique items", value: Number(stats.lineItems || 0).toLocaleString() });
    cards.push({ label: "Total quantity", value: Number(stats.totalQuantity || 0).toLocaleString() });
    cards.push({ label: "Singles", value: Number(stats.singles || 0).toLocaleString() });
    cards.push({ label: "Sealed", value: Number(stats.sealed || 0).toLocaleString() });
    const binderCount = Number(stats.binderPages ?? state.binderPages.length) || 0;
    if (binderCount > 0) {
      cards.push({ label: "Binder pages", value: binderCount.toLocaleString() });
    }
    if (showValuesEnabled()) {
      const total = Number(stats.marketValue);
      const priced = Number(stats.pricedLineItems) || 0;
      const valueLabel =
        Number.isFinite(total) && total > 0
          ? formatUsd(total)
          : priced > 0
            ? formatUsd(total)
            : "—";
      const note =
        priced > 0 && priced < Number(stats.lineItems || 0)
          ? ` (${priced.toLocaleString()} priced)`
          : "";
      cards.push({ label: "Est. value", value: `${valueLabel}${note}` });
    }
    els.stats.innerHTML = cards
      .map(
        (row) => `<article class="stat-card">
          <div class="label">${escapeHtml(row.label)}</div>
          <div class="value">${escapeHtml(row.value)}</div>
        </article>`
      )
      .join("");
  }

  function cardImageHtml(item) {
    const url = String(item.imageUrl || "").trim();
    if (url) {
      return `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`;
    }
    return `<span class="placeholder">No image</span>`;
  }

  function renderGrid() {
    if (state.filter === "binder") {
      setVisible(els.grid, false);
      if (els.grid) els.grid.innerHTML = "";
      return;
    }
    const list = filteredItems();
    if (!list.length) {
      setVisible(els.grid, false);
      if (els.grid) els.grid.innerHTML = "";
      setVisible(els.empty, true);
      const filteredOut =
        state.filter === "sealed"
          ? state.items.some((item) => item.type === "sealed")
          : state.filter === "single"
            ? state.items.some((item) => item.type === "single")
            : state.items.length;
      if (!state.items.length) {
        els.empty.innerHTML = `<h2>No cards to show yet</h2><p>This collector has not added items to their showcase.</p>`;
      } else if (state.filter === "sealed" && !filteredOut) {
        els.empty.innerHTML = `<h2>No sealed products</h2><p>This collector has not added sealed items yet.</p>`;
      } else if (state.filter === "single" && !filteredOut) {
        els.empty.innerHTML = `<h2>No singles</h2><p>This collector has not added singles yet.</p>`;
      } else {
        els.empty.innerHTML = `<h2>No matches</h2><p>Try another filter.</p>`;
      }
      return;
    }

    setVisible(els.empty, false);
    setVisible(els.binder, false);
    if (els.binder) els.binder.innerHTML = "";
    setVisible(els.grid, true);
    const showValues = showValuesEnabled();
    els.grid.innerHTML = list
      .map((item) => {
        const meta = [item.setName, item.cardNumber].filter(Boolean).join(" · ");
        const cond =
          item.conditionType === "graded"
            ? [item.gradeCompany, item.gradeValue].filter(Boolean).join(" ")
            : item.condition;
        const unitVal = Number(item.unitValue);
        const totalVal = Number(item.totalValue);
        const value = showValues
          ? Number.isFinite(totalVal) && totalVal > 0
            ? formatUsd(totalVal)
            : Number.isFinite(unitVal) && unitVal > 0
              ? formatUsd(unitVal)
              : ""
          : "";
        const qty = Number(item.quantity) > 1 ? ` ×${item.quantity}` : "";
        const cardUrl = String(item.cardUrl || "").trim();
        const body = `<div class="showcase-card-thumb">${cardImageHtml(item)}</div>
          <div class="showcase-card-body">
            <h3 class="showcase-card-name">${escapeHtml(item.name)}${escapeHtml(qty)}</h3>
            <p class="showcase-card-meta">${escapeHtml(meta || item.type)}</p>
            ${cond ? `<p class="showcase-card-meta">${escapeHtml(cond)}</p>` : ""}
            ${value ? `<div class="showcase-card-value">${escapeHtml(value)}</div>` : ""}
          </div>`;
        if (cardUrl) {
          return `<a class="showcase-card" href="${escapeHtml(cardUrl)}" title="View on Sets">
            ${body}
          </a>`;
        }
        return `<article class="showcase-card showcase-card--static">${body}</article>`;
      })
      .join("");
  }

  function clampBinderPageIndex(pageCount) {
    const total = Math.max(0, Number(pageCount) || 0);
    if (total <= 0) {
      state.binderPageIndex = 0;
      return;
    }
    if (state.binderPageIndex < 0) state.binderPageIndex = 0;
    if (state.binderPageIndex >= total) state.binderPageIndex = total - 1;
  }

  function renderBinderPages() {
    if (!els.binder) return;
    if (state.filter !== "binder") {
      setVisible(els.binder, false);
      els.binder.innerHTML = "";
      return;
    }

    const pages = binderPagesList();
    if (!pages.length) {
      setVisible(els.binder, false);
      setVisible(els.grid, false);
      setVisible(els.empty, true);
      syncPagePriceDisplay(0);
      els.empty.innerHTML = `<h2>No binder pages yet</h2><p>This collector has not built a binder in their Collection yet.</p>`;
      return;
    }

    clampBinderPageIndex(pages.length);
    const pageIndex = state.binderPageIndex;
    const page = pages[pageIndex];
    const pageNo = pageIndex + 1;
    const custom = String(page?.title || "").trim();
    const navLabel = custom
      ? `${custom} (${pageNo}/${pages.length})`
      : `Page ${pageNo} / ${pages.length}`;
    const size = binderPageSize(page);
    const cols = binderGridCols(size);
    const rawSlots = Array.isArray(page.slots) ? page.slots : [];
    const slots = Array.from({ length: size }, (_, i) => rawSlots[i] || null);
    const collectionIndex = buildBinderCollectionPriceIndex();
    const pageTotal = state.priceOn ? sumBinderPageValue(slots, collectionIndex) : 0;
    const pockets = slots
      .map((slot, slotIndex) => {
        if (!slot) {
          return `<div class="showcase-binder-pocket"><span class="placeholder">Empty</span></div>`;
        }
        const invertedClass = slot.inverted ? " is-inverted" : "";
        const img = String(slot.imageUrl || "").trim();
        const art = img
          ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(slot.name || "Card")}" loading="lazy" />`
          : `<span class="placeholder">No image</span>`;
        if (img) {
          return `<button
              type="button"
              class="showcase-binder-pocket is-zoomable${invertedClass}"
              data-binder-zoom-src="${escapeHtml(img)}"
              data-binder-zoom-alt="${escapeHtml(slot.name || "Card")}"
              aria-label="Zoom ${escapeHtml(slot.name || "card")}"
            >
              <div class="showcase-binder-pocket-art">${art}</div>
            </button>`;
        }
        return `<div class="showcase-binder-pocket${invertedClass}" data-slot="${slotIndex}">
              <div class="showcase-binder-pocket-art">${art}</div>
            </div>`;
      })
      .join("");

    setVisible(els.empty, false);
    setVisible(els.grid, false);
    if (els.grid) els.grid.innerHTML = "";
    setVisible(els.binder, true);
    syncPagePriceDisplay(pageTotal);
    if (state.priceOn) {
      void refreshBinderPagePriceTotal();
    }
    els.binder.innerHTML = `
      <div class="showcase-binder-toolbar">
        <div class="showcase-binder-page-nav">
          <button type="button" class="showcase-binder-nav-btn" id="showcaseBinderPrev" ${
            pageIndex <= 0 ? "disabled" : ""
          }>Prev</button>
          <span class="showcase-binder-page-nav-label" id="showcaseBinderPageLabel">${escapeHtml(navLabel)}</span>
          <button type="button" class="showcase-binder-nav-btn" id="showcaseBinderNext" ${
            pageIndex >= pages.length - 1 ? "disabled" : ""
          }>Next</button>
        </div>
      </div>
      <article class="showcase-binder-page" data-size="${size}">
        <p class="showcase-binder-page-label">${escapeHtml(binderPageTitle(page))}</p>
        <div class="showcase-binder-grid" style="--binder-cols:${cols}">${pockets}</div>
      </article>`;

    els.binder.querySelector("#showcaseBinderPrev")?.addEventListener("click", () => {
      if (state.binderPageIndex <= 0) return;
      state.binderPageIndex -= 1;
      renderBinderPages();
    });
    els.binder.querySelector("#showcaseBinderNext")?.addEventListener("click", () => {
      const total = binderPagesList().length;
      if (state.binderPageIndex >= total - 1) return;
      state.binderPageIndex += 1;
      renderBinderPages();
    });
    els.binder.querySelectorAll("[data-binder-zoom-src]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openBinderCardZoom(
          btn.getAttribute("data-binder-zoom-src") || "",
          btn.getAttribute("data-binder-zoom-alt") || "Card"
        );
      });
    });
  }

  function renderCollectionView() {
    if (state.filter === "binder") {
      renderBinderPages();
      return;
    }
    setVisible(els.binder, false);
    if (els.binder) els.binder.innerHTML = "";
    renderGrid();
  }

  function renderAll() {
    setVisible(els.landing, false);
    setVisible(els.error, false);
    setVisible(els.hero, Boolean(state.profile));
    setVisible(els.stats, Boolean(state.profile));
    setVisible(els.toolbar, Boolean(state.profile));
    setVisible(els.ownerBanner, state.isOwner);
    if (state.isOwner) {
      els.ownerBanner.innerHTML =
        'You are viewing your public showcase. <a href="/settings.html#showcase">Privacy & display settings</a>';
    }
    syncToolbarControls();
    renderHero();
    renderStats();
    renderCollectionView();
  }

  function showError(message) {
    setVisible(els.landing, false);
    setVisible(els.hero, false);
    setVisible(els.stats, false);
    setVisible(els.toolbar, false);
    setVisible(els.grid, false);
    setVisible(els.binder, false);
    setVisible(els.empty, false);
    setVisible(els.error, true);
    els.error.innerHTML = `<h2>Showcase unavailable</h2><p>${escapeHtml(message)}</p>`;
  }

  function showLanding() {
    setVisible(els.landing, true);
    setVisible(els.hero, false);
    setVisible(els.stats, false);
    setVisible(els.toolbar, false);
    setVisible(els.grid, false);
    setVisible(els.binder, false);
    setVisible(els.empty, false);
    setVisible(els.error, false);
  }

  async function loadShowcase(username) {
    const slug = String(username || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
    if (!slug) {
      showLanding();
      return;
    }
    state.username = slug;
    document.title = `@${slug} — PokemonView Showcase`;
    try {
      const res = await fetch(`/api/showcase/profile/${encodeURIComponent(slug)}`);
      const payload = await res.json().catch(() => ({}));
      if (res.status === 404) {
        showError("No collector found with that username.");
        return;
      }
      if (res.status === 403) {
        showError("This showcase is private.");
        return;
      }
      if (!res.ok || !payload.ok) {
        showError(payload.error || "Could not load showcase.");
        return;
      }
      state.profile = payload.profile;
      state.isOwner = Boolean(payload.isOwner);
      state.setCatalogLookup = null;
      const rawItems = Array.isArray(payload.items) ? payload.items : [];
      state.items = await enhancePublicShowcaseItems(rawItems);
      state.binderPages = Array.isArray(payload.binderPages) ? payload.binderPages : [];
      state.binderPageIndex = 0;
      state.stats = recomputeShowcaseStats(state.items, payload.stats || {});
      state.stats.binderPages = state.binderPages.length;
      renderAll();
    } catch {
      showError("Network error while loading showcase.");
    }
  }

  async function bootstrapLanding() {
    showLanding();
    const goBtn = document.getElementById("showcaseGoBtn");
    const input = document.getElementById("showcaseUsernameInput");
    const go = () => {
      const slug = String(input?.value || "")
        .trim()
        .replace(/^@+/, "")
        .toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(slug)) {
        const status = document.getElementById("showcaseLandingStatus");
        if (status) status.textContent = "Enter a valid username (3–24 characters).";
        return;
      }
      window.location.href = `/showcase/@${encodeURIComponent(slug)}`;
    };
    goBtn?.addEventListener("click", go);
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") go();
    });

    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      const payload = res.ok ? await res.json() : null;
      if (payload?.signedIn && payload.user?.username) {
        const mine = document.getElementById("showcaseMyLink");
        if (mine) {
          mine.hidden = false;
          mine.href = `/showcase/@${encodeURIComponent(payload.user.username)}`;
        }
        const hint = document.getElementById("showcaseLandingHint");
        if (hint) {
          hint.innerHTML = `Signed in as <strong>@${escapeHtml(payload.user.username)}</strong>.`;
        }
      }
    } catch {
      // ignore
    }
  }

  for (const tab of els.tabs) {
    tab.addEventListener("click", () => {
      for (const node of els.tabs) node.classList.remove("active");
      tab.classList.add("active");
      const nextFilter = tab.getAttribute("data-showcase-filter") || "all";
      if (nextFilter === "binder" && state.filter !== "binder") {
        state.binderPageIndex = 0;
      }
      state.filter = nextFilter;
      syncToolbarControls();
      renderCollectionView();
    });
  }

  els.priceToggle?.addEventListener("click", () => {
    if (state.priceLoading) return;
    state.priceOn = !state.priceOn;
    syncToolbarControls();
    if (state.priceOn) {
      syncPagePriceDisplay(0);
      void refreshBinderPagePriceTotal();
    } else {
      syncPagePriceDisplay(0);
    }
  });

  els.imageZoomClose?.addEventListener("click", closeBinderCardZoom);
  els.imageZoom?.addEventListener("click", (event) => {
    if (event.target === els.imageZoom) closeBinderCardZoom();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.imageZoom && !els.imageZoom.hidden) {
      closeBinderCardZoom();
    }
  });

  const username = parseUsernameFromLocation();
  if (username) {
    loadShowcase(username);
  } else {
    bootstrapLanding();
  }
})();
