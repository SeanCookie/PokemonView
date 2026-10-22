(() => {
  const dealsBody = document.getElementById("dealsBody");
  const statusLine = document.getElementById("statusLine");
  const sortSelect = document.getElementById("sortSelect");
  const searchInput = document.getElementById("searchInput");
  const refreshBtn = document.getElementById("refreshBtn");

  const state = {
    mode: "auction",
    sort: "ending",
    q: "",
    rows: [],
    loading: false,
    fetchedAt: null,
    liveTracked: 0,
    source: "",
    error: "",
    pollMs: 45000
  };

  let searchTimer = null;
  let tickTimer = null;
  let reloadTimer = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatEnds(secondsLeft, endsAt, isBin) {
    if (isBin) return "BIN";
    const s = Number(secondsLeft);
    if (!Number.isFinite(s)) {
      if (!endsAt) return "—";
      const t = Date.parse(endsAt);
      if (!Number.isFinite(t)) return "—";
      return new Date(t).toLocaleString();
    }
    if (s <= 0) return "ended";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h >= 1) return `${h}h ${m}m`;
    if (m >= 1) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function vsClass(pct) {
    const n = Number(pct);
    if (!Number.isFinite(n)) return "";
    if (n <= 80) return "good";
    if (n <= 100) return "mid";
    return "bad";
  }

  function filteredRows() {
    const q = String(state.q || "").trim().toLowerCase();
    if (!q) return state.rows.slice();
    return state.rows.filter((row) => {
      const hay = `${row.title || ""} ${row.matchLabel || ""} ${row.setName || ""} ${row.seller || ""} ${row.cardName || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function setStatus(text) {
    if (statusLine) statusLine.textContent = text;
  }

  function renderTable() {
    if (!dealsBody) return;
    const rows = filteredRows();
    if (state.loading && !state.rows.length) {
      dealsBody.innerHTML = `<tr><td colspan="9" class="muted center">Loading deals…</td></tr>`;
      return;
    }
    if (state.error && !state.rows.length) {
      dealsBody.innerHTML = `<tr><td colspan="9" class="muted center">${escapeHtml(state.error)}</td></tr>`;
      return;
    }
    if (!rows.length) {
      dealsBody.innerHTML = `<tr><td colspan="9" class="muted center">No Pokémon listings matched.</td></tr>`;
      return;
    }

    dealsBody.innerHTML = rows
      .map((row) => {
        const urgent = Number.isFinite(row.secondsLeft) && row.secondsLeft < 3600 && !row.isBin;
        const pct = Number(row.pctOfValue);
        const vsHtml = Number.isFinite(pct)
          ? `<span class="vs-pill ${vsClass(pct)}">${pct}%</span>`
          : `<span class="muted">—</span>`;
        const type = row.isBin ? (row.bestOffer ? "BIN · BO" : "BIN") : "Auction";
        const thumb = row.imageUrl
          ? `<img class="card-thumb" src="${escapeHtml(row.imageUrl)}" alt="" loading="lazy" decoding="async" />`
          : `<div class="card-thumb" aria-hidden="true"></div>`;
        const subParts = [
          row.matchLabel || row.cardName || "",
          row.setName || "",
          row.setYear ? String(row.setYear) : "",
          row.psaCert ? `Cert ${row.psaCert}` : ""
        ].filter(Boolean);
        const sub = subParts.join(" · ");
        return `<tr>
          <td class="ends-cell${urgent ? " urgent" : ""}">${escapeHtml(
            formatEnds(row.secondsLeft, row.endsAt, row.isBin)
          )}</td>
          <td>
            <div class="card-cell">
              ${thumb}
              <div class="card-meta">
                <a class="card-title" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a>
                ${sub ? `<span class="card-sub">${escapeHtml(sub)}</span>` : ""}
              </div>
            </div>
          </td>
          <td>${escapeHtml(type)}</td>
          <td class="num">${money(row.estValue)}</td>
          <td class="num">${money(row.currentPrice)}${
            !row.isBin && row.bidCount
              ? `<div class="card-sub">${row.bidCount} bid${row.bidCount === 1 ? "" : "s"}</div>`
              : ""
          }</td>
          <td>${vsHtml}</td>
          <td>${escapeHtml(row.gradeLabel || "—")}</td>
          <td>${escapeHtml(row.seller || "—")}</td>
          <td>${escapeHtml(row.sellerCountry || "—")}</td>
        </tr>`;
      })
      .join("");
  }

  function tickCountdowns() {
    if (!state.rows.length) return;
    const now = Date.now();
    for (const row of state.rows) {
      if (!row.endsAt || row.isBin) continue;
      const t = Date.parse(row.endsAt);
      if (!Number.isFinite(t)) continue;
      row.secondsLeft = Math.max(0, Math.round((t - now) / 1000));
    }
    renderTable();
  }

  function updateStatusLine() {
    if (state.error && !state.rows.length) {
      setStatus(state.error);
      return;
    }
    const when = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString() : "—";
    const tracked = state.liveTracked ? ` · ${state.liveTracked} tracked` : "";
    setStatus(
      `${state.rows.length} Pokémon ${state.mode === "bin" ? "BIN" : "auction"} listings${tracked} · live snapshot · ${when}`
    );
  }

  async function loadDeals({ soft = false } = {}) {
    if (!soft) state.loading = true;
    state.error = "";
    if (!soft) setStatus("Loading Pokémon deals…");
    if (!soft) renderTable();
    try {
      const params = new URLSearchParams({
        mode: state.mode,
        sort: state.sort,
        limit: "120"
      });
      const response = await fetch(`/api/ebay-terminal/deals?${params.toString()}`, {
        credentials: "same-origin",
        cache: "no-store"
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        if (!state.rows.length) {
          state.error = payload?.error || "Could not load deals.";
        }
        updateStatusLine();
        return;
      }
      state.rows = Array.isArray(payload.rows) ? payload.rows : [];
      state.fetchedAt = payload.fetchedAt || new Date().toISOString();
      state.liveTracked = Number(payload.liveTracked) || 0;
      state.source = String(payload.source || "");
      state.pollMs = Number(payload.pollMs) || state.pollMs;
      if (payload.error) state.error = payload.error;
      updateStatusLine();
    } catch (err) {
      if (!state.rows.length) {
        state.error = err?.message || "Network error loading deals.";
      }
      updateStatusLine();
    } finally {
      state.loading = false;
      renderTable();
    }
  }

  document.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode") || "auction";
      if (state.mode === mode) return;
      state.mode = mode;
      document.querySelectorAll("[data-mode]").forEach((el) => {
        const active = el.getAttribute("data-mode") === mode;
        el.classList.toggle("active", active);
        el.setAttribute("aria-selected", active ? "true" : "false");
      });
      void loadDeals();
    });
  });

  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      state.sort = sortSelect.value || "ending";
      void loadDeals();
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = searchInput.value || "";
        renderTable();
      }, 120);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => void loadDeals({ soft: false }));
  }

  tickTimer = window.setInterval(tickCountdowns, 1000);
  reloadTimer = window.setInterval(() => void loadDeals({ soft: true }), 30000);
  void loadDeals();
})();
