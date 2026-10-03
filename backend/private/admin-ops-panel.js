(() => {
  const byId = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const t = Date.parse(value);
    if (!Number.isFinite(t)) return String(value);
    return new Date(t).toLocaleString();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  function setStatus(el, message, type = "") {
    if (!el) return;
    el.textContent = message || "";
    el.className = type ? `admin-status ${type}` : "admin-status";
  }

  let sealedPollTimer = null;
  let marketHistoryPollTimer = null;

  function renderHealth(payload) {
    const host = byId("opsHealthStats");
    if (!host) return;
    const files = payload.files || {};
    const cells = [
      ["TCG", files.tcgCache?.exists ? `${files.tcgCache.mb} MB` : "missing"],
      ["PriceCharting", files.pcDetails?.exists ? `${files.pcDetails.mb} MB` : "missing"],
      ["Market history", files.pcMarket?.exists ? `${files.pcMarket.mb} MB` : "missing"],
      [
        "History entries",
        payload.marketHistoryMeta?.cacheEntryCount != null
          ? String(payload.marketHistoryMeta.cacheEntryCount)
          : "—"
      ],
      ["Discovery", files.discovery?.exists ? `${files.discovery.mb} MB` : "missing"],
      [
        "Discovery items",
        payload.discoveryMeta?.snapshotEntryCount != null
          ? String(payload.discoveryMeta.snapshotEntryCount)
          : "—"
      ],
      ["Sealed", files.sealed?.exists ? `${files.sealed.mb} MB` : "missing"],
      ["Restock", files.restock?.exists ? `${files.restock.mb} MB` : "missing"]
    ];
    host.innerHTML = cells
      .map(
        ([label, value]) =>
          `<div class="admin-stat"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`
      )
      .join("");
  }

  function renderSealed(summary) {
    const host = byId("opsSealedStats");
    if (!host) return;
    host.innerHTML = [
      ["Generated", formatDateTime(summary.generatedAt)],
      ["Sets", summary.setCount ?? "—"],
      ["Products", summary.productCount ?? "—"],
      ["Priced", summary.priced ?? "—"],
      ["Job", summary.job?.status || "idle"]
    ]
      .map(
        ([label, value]) =>
          `<div class="admin-stat"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`
      )
      .join("");
  }

  function renderMarketHistoryMeta(payload) {
    const host = byId("marketHistoryStats");
    if (!host) return;
    const meta = payload.meta || {};
    const job = payload.job || {};
    host.innerHTML = [
      ["Entries", meta.cacheEntryCount ?? "—"],
      ["Saved at", formatDateTime(meta.cacheSavedAt)],
      ["Job", job.status || "idle"],
      ["Progress", job.total ? `${job.done || 0}/${job.total}` : "—"]
    ]
      .map(
        ([label, value]) =>
          `<div class="admin-stat"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`
      )
      .join("");
  }

  function renderMarketHistoryJob(job) {
    const stopBtn = byId("btnMarketHistoryStop");
    if (stopBtn) stopBtn.hidden = !(job && job.status === "running");
    if (!job) return;
    if (job.status === "running") {
      setStatus(
        byId("marketHistoryMsg"),
        `Warming ${job.done || 0}/${job.total || 0} · ${job.current || "…"}`
      );
    } else if (job.status) {
      setStatus(
        byId("marketHistoryMsg"),
        `${job.status}: ok ${job.ok || 0}, fail ${job.fail || 0}, skipped ${job.skipped || 0}`,
        job.status === "done" ? "ok" : ""
      );
    }
  }

  function renderDiscoveryMeta(meta) {
    const host = byId("discoveryStats");
    if (!host) return;
    host.innerHTML = [
      ["Built at", formatDateTime(meta?.snapshotBuiltAt)],
      ["Items", meta?.snapshotEntryCount ?? "—"],
      ["Trending", meta?.trendingCount ?? "—"]
    ]
      .map(
        ([label, value]) =>
          `<div class="admin-stat"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`
      )
      .join("");
  }

  async function loadHealth() {
    const payload = await api("/api/admin/health");
    renderHealth(payload);
    setStatus(byId("opsHealthMsg"), `Updated ${formatDateTime(payload.at)}.`, "ok");
  }

  async function loadSealed() {
    const payload = await api("/api/admin/sealed");
    renderSealed(payload);
    if (payload.job?.status === "running") startSealedPolling();
  }

  async function loadMarketHistory() {
    const payload = await api("/api/admin/market-history");
    renderMarketHistoryMeta(payload);
    renderMarketHistoryJob(payload.job);
    if (payload.job?.status === "running") startMarketHistoryPolling();
  }

  async function loadDiscovery() {
    const payload = await api("/api/admin/discovery");
    renderDiscoveryMeta(payload.meta);
  }

  function startSealedPolling() {
    if (sealedPollTimer) return;
    sealedPollTimer = setInterval(async () => {
      try {
        const payload = await api("/api/admin/sealed");
        renderSealed(payload);
        if (!payload.job || payload.job.status !== "running") {
          clearInterval(sealedPollTimer);
          sealedPollTimer = null;
          setStatus(byId("opsSealedMsg"), payload.job?.detail || "Sealed job finished.", "ok");
          await loadHealth();
        }
      } catch {
        /* ignore */
      }
    }, 2500);
  }

  function startMarketHistoryPolling() {
    if (marketHistoryPollTimer) return;
    marketHistoryPollTimer = setInterval(async () => {
      try {
        const payload = await api("/api/admin/market-history");
        renderMarketHistoryMeta(payload);
        renderMarketHistoryJob(payload.job);
        if (!payload.job || payload.job.status !== "running") {
          clearInterval(marketHistoryPollTimer);
          marketHistoryPollTimer = null;
          await loadHealth();
        }
      } catch {
        /* ignore */
      }
    }, 2000);
  }

  function bind() {
    byId("btnOpsHealthRefresh")?.addEventListener("click", () => {
      loadHealth().catch((err) => setStatus(byId("opsHealthMsg"), err.message, "error"));
    });

    byId("btnOpsPersist")?.addEventListener("click", async () => {
      const targets = ["tcg", "pricecharting", "marketHistory", "discovery", "sealed", "stamps"];
      setStatus(byId("opsPersistMsg"), "Saving…");
      try {
        const result = await api("/api/admin/persist", {
          method: "POST",
          body: JSON.stringify({ targets })
        });
        setStatus(byId("opsPersistMsg"), `Saved: ${Object.keys(result.results || {}).join(", ")}`, "ok");
        await loadHealth();
      } catch (err) {
        setStatus(byId("opsPersistMsg"), err.message, "error");
      }
    });

    byId("btnOpsSealedRefreshStats")?.addEventListener("click", () => {
      loadSealed().catch((err) => setStatus(byId("opsSealedMsg"), err.message, "error"));
    });
    byId("btnOpsSealedSync")?.addEventListener("click", async () => {
      try {
        await api("/api/admin/sealed/refresh", {
          method: "POST",
          body: JSON.stringify({
            downloadImages: Boolean(byId("opsSealedDownloadImages")?.checked)
          })
        });
        setStatus(byId("opsSealedMsg"), "Sealed sync started…");
        startSealedPolling();
      } catch (err) {
        setStatus(byId("opsSealedMsg"), err.message, "error");
      }
    });

    byId("btnMarketHistoryRefreshMeta")?.addEventListener("click", () => {
      loadMarketHistory().catch((err) => setStatus(byId("marketHistoryMsg"), err.message, "error"));
    });
    byId("btnMarketHistoryWarm")?.addEventListener("click", async () => {
      try {
        const body = {
          limit: Number(byId("marketHistoryLimit")?.value) || 300,
          concurrency: Number(byId("marketHistoryConcurrency")?.value) || 2,
          missingOnly: Boolean(byId("marketHistoryMissingOnly")?.checked),
          includeSealed: Boolean(byId("marketHistoryIncludeSealed")?.checked)
        };
        const started = await api("/api/admin/market-history/warm", {
          method: "POST",
          body: JSON.stringify(body)
        });
        renderMarketHistoryJob(started.job);
        setStatus(
          byId("marketHistoryMsg"),
          started.started
            ? `Warming ${started.targets || 0} target(s)…`
            : started.message || "Nothing to warm.",
          "ok"
        );
        if (started.started) startMarketHistoryPolling();
      } catch (err) {
        setStatus(byId("marketHistoryMsg"), err.message, "error");
      }
    });
    byId("btnMarketHistoryStop")?.addEventListener("click", async () => {
      try {
        await api("/api/admin/market-history/stop", { method: "POST", body: "{}" });
        setStatus(byId("marketHistoryMsg"), "Stop requested.");
      } catch (err) {
        setStatus(byId("marketHistoryMsg"), err.message, "error");
      }
    });

    byId("btnDiscoveryRefreshMeta")?.addEventListener("click", () => {
      loadDiscovery().catch((err) => setStatus(byId("discoveryMsg"), err.message, "error"));
    });
    byId("btnDiscoveryRebuild")?.addEventListener("click", async () => {
      setStatus(byId("discoveryMsg"), "Rebuilding discovery…");
      try {
        const result = await api("/api/admin/discovery/rebuild", {
          method: "POST",
          body: "{}"
        });
        await loadDiscovery();
        setStatus(
          byId("discoveryMsg"),
          `Rebuilt ${result.sourceEntries || 0} items at ${formatDateTime(result.builtAt)}.`,
          "ok"
        );
        await loadHealth();
      } catch (err) {
        setStatus(byId("discoveryMsg"), err.message, "error");
      }
    });
  }

  async function boot() {
    const app = byId("adminApp");
    if (!app || app.hidden) {
      document.addEventListener(
        "infinity-auth-change",
        () => {
          if (!byId("adminApp")?.hidden) void bootOnce();
        },
        { once: false }
      );
      setTimeout(() => {
        if (!byId("adminApp")?.hidden) void bootOnce();
      }, 1500);
      return;
    }
    await bootOnce();
  }

  let booted = false;
  async function bootOnce() {
    if (booted) return;
    if (byId("adminApp")?.hidden) return;
    booted = true;
    bind();
    await Promise.allSettled([loadHealth(), loadSealed(), loadMarketHistory(), loadDiscovery()]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot());
  } else {
    void boot();
  }
})();
