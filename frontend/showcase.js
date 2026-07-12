(() => {
  const els = {
    root: document.getElementById("showcaseRoot"),
    landing: document.getElementById("showcaseLanding"),
    hero: document.getElementById("showcaseHero"),
    stats: document.getElementById("showcaseStats"),
    ownerBanner: document.getElementById("showcaseOwnerBanner"),
    toolbar: document.getElementById("showcaseToolbar"),
    grid: document.getElementById("showcaseGrid"),
    empty: document.getElementById("showcaseEmpty"),
    error: document.getElementById("showcaseError"),
    search: document.getElementById("showcaseSearch"),
    tabs: document.querySelectorAll("[data-showcase-filter]")
  };

  const state = {
    username: "",
    profile: null,
    stats: null,
    items: [],
    filter: "all",
    query: "",
    isOwner: false,
    setCatalogLookup: null
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
    const q = state.query.trim().toLowerCase();
    return state.items.filter((item) => {
      if (state.filter !== "all" && item.type !== state.filter) return false;
      if (!q) return true;
      const hay = [item.name, item.setName, item.cardNumber, item.setCode, item.condition]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
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
    const n = Number(raw);
    if (Number.isFinite(n)) {
      keys.add(String(n));
      keys.add(String(n).padStart(3, "0"));
    }
    const stripped = raw.replace(/^0+/, "");
    if (stripped) keys.add(stripped);
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
    const list = filteredItems();
    if (!list.length) {
      setVisible(els.grid, false);
      setVisible(els.empty, true);
      els.empty.innerHTML = state.items.length
        ? `<h2>No matches</h2><p>Try another filter or search term.</p>`
        : `<h2>No cards to show yet</h2><p>This collector has not added items to their showcase.</p>`;
      return;
    }

    setVisible(els.empty, false);
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
    renderHero();
    renderStats();
    renderGrid();
  }

  function showError(message) {
    setVisible(els.landing, false);
    setVisible(els.hero, false);
    setVisible(els.stats, false);
    setVisible(els.toolbar, false);
    setVisible(els.grid, false);
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
    document.title = `@${slug} — Infinity Cards Showcase`;
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
      state.stats = recomputeShowcaseStats(state.items, payload.stats || {});
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
          hint.innerHTML = `Signed in as <strong>@${escapeHtml(
            payload.user.username
          )}</strong>. <a href="/showcase/@${encodeURIComponent(
            payload.user.username
          )}">View your showcase</a>`;
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
      state.filter = tab.getAttribute("data-showcase-filter") || "all";
      renderGrid();
    });
  }

  els.search?.addEventListener("input", () => {
    state.query = els.search.value;
    renderGrid();
  });

  const username = parseUsernameFromLocation();
  if (username) {
    loadShowcase(username);
  } else {
    bootstrapLanding();
  }
})();
