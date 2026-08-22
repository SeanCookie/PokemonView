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

  let coverageRows = [];
  let gapPollTimer = null;
  let sealedPollTimer = null;

  function toneClass(ok) {
    return ok ? "tone-ok" : "tone-bad";
  }

  function renderHealth(payload) {
    const host = byId("opsHealthStats");
    if (!host) return;
    const mem = payload.memory || {};
    const files = payload.files || {};
    const cells = [
      ["Uptime", `${Number(payload.uptimeSec || 0).toLocaleString()}s`],
      ["RSS", `${mem.rssMb ?? "—"} MB`],
      ["Heap used", `${mem.heapUsedMb ?? "—"} MB`],
      ["TCG cache", files.tcgCache?.exists ? `${files.tcgCache.mb} MB` : "missing"],
      ["PC details", files.pcDetails?.exists ? `${files.pcDetails.mb} MB` : "missing"],
      ["Sealed", files.sealed?.exists ? `${files.sealed.mb} MB` : "missing"],
      ["Store", files.store?.exists ? `${files.store.mb} MB` : "missing"],
      ["Card details", files.setCardDetails?.exists ? `${files.setCardDetails.mb} MB` : "missing"]
    ];
    host.innerHTML = cells
      .map(
        ([label, value]) =>
          `<div class="admin-stat"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`
      )
      .join("");
  }

  function renderMetrics(metrics) {
    const body = byId("opsMetricsBody");
    if (!body) return;
    const counters = metrics?.counters || {};
    const lastHitAt = metrics?.lastHitAt || {};
    const keys = Object.keys(counters);
    if (!keys.length) {
      body.innerHTML = `<tr><td colspan="3" style="color:var(--muted)">No metrics yet.</td></tr>`;
      return;
    }
    body.innerHTML = keys
      .map(
        (key) => `<tr>
          <td class="mono">${escapeHtml(key)}</td>
          <td>${Number(counters[key] || 0).toLocaleString()}</td>
          <td>${escapeHtml(formatDateTime(lastHitAt[key]))}</td>
        </tr>`
      )
      .join("");
  }

  function filteredCoverage() {
    const q = String(byId("opsCoverageSearch")?.value || "")
      .trim()
      .toLowerCase();
    const filter = byId("opsCoverageFilter")?.value || "all";
    return coverageRows.filter((row) => {
      if (filter === "staleTcg" && !row.tcgStale) return false;
      if (filter === "stalePc" && !row.pcStale) return false;
      if (filter === "missingDetails" && !row.missingDetails) return false;
      if (filter === "missingImages" && !row.missingImages) return false;
      if (!q) return true;
      return `${row.setName} ${row.setCode}`.toLowerCase().includes(q);
    });
  }

  function renderCoverage() {
    const body = byId("opsCoverageBody");
    if (!body) return;
    const list = filteredCoverage();
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="7" style="color:var(--muted)">No sets match.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .slice(0, 200)
      .map((row) => {
        const details = row.missingDetails ? "—" : `${row.detailsCoverage ?? "—"}%`;
        const images = row.missingImages ? "—" : `${row.imageCoverage ?? "—"}%`;
        return `<tr>
          <td><strong>${escapeHtml(row.setCode)}</strong><div class="admin-hint">${escapeHtml(row.setName)}</div></td>
          <td>${Number(row.cardCount || 0)}</td>
          <td class="${toneClass(!row.missingDetails)}">${details}</td>
          <td class="${toneClass(!row.missingImages)}">${images}</td>
          <td class="${toneClass(!row.tcgStale)}">${escapeHtml(row.tcgLastRefreshAt ? formatDateTime(row.tcgLastRefreshAt) : "never")}</td>
          <td class="${toneClass(!row.pcStale)}">${escapeHtml(row.priceChartingLastRefreshAt ? formatDateTime(row.priceChartingLastRefreshAt) : "never")}</td>
          <td>${Number(row.sealedPriced || 0)}/${Number(row.sealedCount || 0)}</td>
        </tr>`;
      })
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
      ["Missing price", summary.missingPrice ?? "—"],
      ["Missing image", summary.missingImage ?? "—"],
      ["Job", summary.job?.status || "idle"]
    ]
      .map(
        ([label, value]) =>
          `<div class="admin-stat"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`
      )
      .join("");
  }

  function renderJobs(payload) {
    const body = byId("opsJobsBody");
    if (!body) return;
    const jobs = payload.jobs || [];
    if (!jobs.length) {
      body.innerHTML = `<tr><td colspan="4" style="color:var(--muted)">No jobs recorded yet.</td></tr>`;
      return;
    }
    body.innerHTML = jobs
      .slice(0, 40)
      .map(
        (job) => `<tr>
          <td>${escapeHtml(formatDateTime(job.startedAt))}</td>
          <td>${escapeHtml(job.kind || job.label || "—")}</td>
          <td>${escapeHtml(job.status || "—")}</td>
          <td>${escapeHtml(job.label || job.detail || job.error || "")}</td>
        </tr>`
      )
      .join("");
  }

  function renderSchedules(schedules) {
    const host = byId("opsSchedulesForm");
    if (!host || !schedules) return;
    const defs = [
      ["restockNightly", "Restock nightly", true],
      ["tcgGapDaily", "TCG gap daily", true],
      ["pcGapDaily", "PriceCharting gap daily", true]
    ];
    host.innerHTML = defs
      .map(([key, label]) => {
        const cfg = schedules[key] || {};
        return `<div class="admin-schedule-row" data-schedule="${key}">
          <label class="admin-check"><input type="checkbox" data-field="enabled" ${cfg.enabled ? "checked" : ""} /> ${escapeHtml(label)}</label>
          <label>UTC hour <input class="admin-input" type="number" min="0" max="23" data-field="hourUtc" value="${Number(cfg.hourUtc) || 0}" /></label>
          ${
            key === "restockNightly"
              ? ""
              : `<label>Limit <input class="admin-input" type="number" min="1" max="50" data-field="limit" value="${Number(cfg.limit) || 12}" /></label>
                 <label>Stale days <input class="admin-input" type="number" min="1" max="90" data-field="staleDays" value="${Number(cfg.staleDays) || 14}" /></label>`
          }
          <span class="admin-hint">Last: ${escapeHtml(formatDateTime(cfg.lastRunAt))}</span>
        </div>`;
      })
      .join("");
  }

  function collectSchedulesFromForm() {
    const out = {};
    document.querySelectorAll("[data-schedule]").forEach((row) => {
      const key = row.getAttribute("data-schedule");
      out[key] = {
        enabled: Boolean(row.querySelector('[data-field="enabled"]')?.checked),
        hourUtc: Number(row.querySelector('[data-field="hourUtc"]')?.value) || 0,
        limit: Number(row.querySelector('[data-field="limit"]')?.value) || 12,
        staleDays: Number(row.querySelector('[data-field="staleDays"]')?.value) || 14
      };
    });
    return out;
  }

  function renderFlags(flags) {
    const host = byId("opsFlagsForm");
    if (!host) return;
    const labels = {
      restockLiveFetch: "Restock live fetch",
      priceChartingLiveFetch: "PriceCharting live fetch",
      tcgHourlyRefresh: "TCG hourly refresh",
      scanYourCards: "Scan Your Cards",
      tradeAnalyzer: "Trade Analyzer",
      showcasePublic: "Public showcases default",
      collectionAdd: "Collection add"
    };
    host.innerHTML = Object.keys(labels)
      .map(
        (key) => `<label class="admin-check">
          <input type="checkbox" data-flag="${key}" ${flags?.[key] !== false ? "checked" : ""} />
          ${escapeHtml(labels[key])}
        </label>`
      )
      .join("");
  }

  function collectFlagsFromForm() {
    const out = {};
    document.querySelectorAll("[data-flag]").forEach((input) => {
      out[input.getAttribute("data-flag")] = Boolean(input.checked);
    });
    return out;
  }

  function renderShowcase(rows) {
    const body = byId("opsShowcaseBody");
    if (!body) return;
    if (!rows?.length) {
      body.innerHTML = `<tr><td colspan="4" style="color:var(--muted)">No users.</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .slice(0, 100)
      .map(
        (row) => `<tr data-showcase-user="${escapeHtml(row.id)}">
          <td><strong>${escapeHtml(row.username || row.email || row.id)}</strong></td>
          <td>${row.isPublic ? "yes" : "no"}</td>
          <td>${Number(row.itemCount || 0)}</td>
          <td>
            <button type="button" class="admin-btn" data-showcase-action="private">Force private</button>
            <button type="button" class="admin-btn" data-showcase-action="clear-avatar">Clear avatar</button>
          </td>
        </tr>`
      )
      .join("");
    body.querySelectorAll("[data-showcase-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = btn.closest("tr");
        const id = tr?.getAttribute("data-showcase-user");
        const action = btn.getAttribute("data-showcase-action");
        if (!id || !action) return;
        try {
          await api(`/api/admin/showcase/${encodeURIComponent(id)}/${action}`, {
            method: "POST",
            body: "{}"
          });
          setStatus(byId("opsShowcaseMsg"), `Updated ${action}.`, "ok");
          await loadShowcases();
        } catch (err) {
          setStatus(byId("opsShowcaseMsg"), err.message, "error");
        }
      });
    });
  }

  function renderGapJob(job) {
    const stopBtn = byId("btnOpsGapStop");
    if (stopBtn) stopBtn.hidden = !(job && job.status === "running");
    if (!job) {
      setStatus(byId("opsGapMsg"), "Idle.");
      return;
    }
    if (job.status === "running") {
      setStatus(
        byId("opsGapMsg"),
        `Running ${job.kind}: ${job.done || 0}/${job.total || 0} · ${job.currentSet || "…"}`
      );
    } else {
      setStatus(
        byId("opsGapMsg"),
        `${job.status}: ok ${job.ok || 0}, fail ${job.fail || 0}`,
        job.status === "done" ? "ok" : ""
      );
    }
  }

  async function loadHealth() {
    const payload = await api("/api/admin/health");
    renderHealth(payload);
    setStatus(byId("opsHealthMsg"), `Updated ${formatDateTime(payload.at)}.`, "ok");
  }

  async function loadMetrics() {
    const payload = await api("/api/admin/metrics");
    renderMetrics(payload.metrics);
  }

  async function loadCoverage() {
    setStatus(byId("opsCoverageMsg"), "Loading coverage…");
    const payload = await api("/api/admin/coverage");
    coverageRows = payload.rows || [];
    renderCoverage();
    setStatus(byId("opsCoverageMsg"), `${coverageRows.length} sets loaded.`, "ok");
  }

  async function loadSealed() {
    const payload = await api("/api/admin/sealed");
    renderSealed(payload);
    if (payload.job?.status === "running") startSealedPolling();
  }

  async function loadJobs() {
    const payload = await api("/api/admin/jobs");
    renderJobs(payload);
    renderGapJob(payload.live?.gap || null);
  }

  async function loadSchedules() {
    const payload = await api("/api/admin/schedules");
    renderSchedules(payload.schedules);
  }

  async function loadFlags() {
    const payload = await api("/api/admin/flags");
    renderFlags(payload.flags);
  }

  async function loadShowcases() {
    const payload = await api("/api/admin/showcase");
    renderShowcase(payload.showcases);
  }

  function startGapPolling() {
    if (gapPollTimer) return;
    gapPollTimer = setInterval(async () => {
      try {
        const payload = await api("/api/admin/gap-refresh");
        renderGapJob(payload.job);
        if (!payload.job || payload.job.status !== "running") {
          clearInterval(gapPollTimer);
          gapPollTimer = null;
          await loadJobs();
        }
      } catch {
        /* ignore */
      }
    }, 2000);
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
          await loadJobs();
        }
      } catch {
        /* ignore */
      }
    }, 2500);
  }

  function bind() {
    byId("btnOpsHealthRefresh")?.addEventListener("click", () => {
      loadHealth().catch((err) => setStatus(byId("opsHealthMsg"), err.message, "error"));
    });
    byId("btnOpsMetricsRefresh")?.addEventListener("click", () => {
      loadMetrics().catch(() => {});
    });
    byId("btnOpsCoverageRefresh")?.addEventListener("click", () => {
      loadCoverage().catch((err) => setStatus(byId("opsCoverageMsg"), err.message, "error"));
    });
    byId("opsCoverageSearch")?.addEventListener("input", renderCoverage);
    byId("opsCoverageFilter")?.addEventListener("change", renderCoverage);

    byId("btnOpsGapStart")?.addEventListener("click", async () => {
      try {
        const body = {
          kind: byId("opsGapKind")?.value || "tcg",
          mode: byId("opsGapMode")?.value || "stale",
          limit: Number(byId("opsGapLimit")?.value) || 10,
          staleDays: Number(byId("opsGapStaleDays")?.value) || 14
        };
        const started = await api("/api/admin/gap-refresh", {
          method: "POST",
          body: JSON.stringify(body)
        });
        renderGapJob(started.job);
        setStatus(
          byId("opsGapMsg"),
          `Started for ${started.targets?.length || 0} set(s).`,
          "ok"
        );
        startGapPolling();
      } catch (err) {
        setStatus(byId("opsGapMsg"), err.message, "error");
      }
    });
    byId("btnOpsGapStop")?.addEventListener("click", async () => {
      try {
        await api("/api/admin/gap-refresh/stop", { method: "POST", body: "{}" });
        setStatus(byId("opsGapMsg"), "Stop requested.");
      } catch (err) {
        setStatus(byId("opsGapMsg"), err.message, "error");
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

    byId("btnOpsIntegrityScan")?.addEventListener("click", async () => {
      setStatus(byId("opsIntegrityMsg"), "Scanning…");
      try {
        const report = await api("/api/admin/integrity");
        byId("opsIntegrityOut").textContent = JSON.stringify(report.summary, null, 2);
        setStatus(
          byId("opsIntegrityMsg"),
          `Sets ${report.summary.setCount} · empty details ${report.summary.emptyDetails} · empty images ${report.summary.emptyImages}.`,
          "ok"
        );
      } catch (err) {
        setStatus(byId("opsIntegrityMsg"), err.message, "error");
      }
    });

    byId("btnOpsJobsRefresh")?.addEventListener("click", () => {
      loadJobs().catch(() => {});
    });

    byId("btnOpsSchedulesSave")?.addEventListener("click", async () => {
      try {
        await api("/api/admin/schedules", {
          method: "POST",
          body: JSON.stringify({ schedules: collectSchedulesFromForm() })
        });
        setStatus(byId("opsSchedulesMsg"), "Schedules saved.", "ok");
        await loadSchedules();
      } catch (err) {
        setStatus(byId("opsSchedulesMsg"), err.message, "error");
      }
    });

    byId("btnOpsPersist")?.addEventListener("click", async () => {
      const targets = [];
      if (byId("opsPersistTcg")?.checked) targets.push("tcg");
      if (byId("opsPersistPc")?.checked) targets.push("pricecharting");
      if (byId("opsPersistStamps")?.checked) targets.push("stamps");
      if (byId("opsPersistSplit")?.checked) targets.push("split-details");
      try {
        const result = await api("/api/admin/persist", {
          method: "POST",
          body: JSON.stringify({ targets })
        });
        setStatus(byId("opsPersistMsg"), `Done: ${JSON.stringify(result.results)}`, "ok");
        await loadJobs();
      } catch (err) {
        setStatus(byId("opsPersistMsg"), err.message, "error");
      }
    });

    byId("btnOpsImagesReport")?.addEventListener("click", async () => {
      setStatus(byId("opsImagesMsg"), "Scanning local card-images…");
      try {
        const report = await api("/api/admin/images/report");
        const body = byId("opsImagesBody");
        body.innerHTML = (report.rows || [])
          .map(
            (row) => `<tr>
              <td>${escapeHtml(row.setCode)} <span class="admin-hint">${escapeHtml(row.setName)}</span></td>
              <td>${row.expected}</td>
              <td>${row.onDisk}</td>
              <td>${row.missing}</td>
              <td>${row.coverage ?? "—"}%</td>
            </tr>`
          )
          .join("") || `<tr><td colspan="5" style="color:var(--muted)">No gaps found.</td></tr>`;
        setStatus(
          byId("opsImagesMsg"),
          `${report.summary.setsWithGaps} sets with gaps · ${report.summary.missingImages} missing files. ${report.tip || ""}`,
          "ok"
        );
      } catch (err) {
        setStatus(byId("opsImagesMsg"), err.message, "error");
      }
    });

    byId("btnOpsFlagsSave")?.addEventListener("click", async () => {
      try {
        await api("/api/admin/flags", {
          method: "POST",
          body: JSON.stringify({ flags: collectFlagsFromForm() })
        });
        setStatus(byId("opsFlagsMsg"), "Flags saved.", "ok");
      } catch (err) {
        setStatus(byId("opsFlagsMsg"), err.message, "error");
      }
    });

    byId("btnOpsShowcaseRefresh")?.addEventListener("click", () => {
      loadShowcases().catch((err) => setStatus(byId("opsShowcaseMsg"), err.message, "error"));
    });

    byId("btnOpsNicknameBulk")?.addEventListener("click", async () => {
      try {
        const csv = byId("opsNicknameCsv")?.value || "";
        const result = await api("/api/admin/card-nicknames/bulk", {
          method: "POST",
          body: JSON.stringify({ csv })
        });
        setStatus(
          byId("opsNicknameBulkMsg"),
          `Added ${result.added}, skipped ${result.skipped}, errors ${result.errors?.length || 0}.`,
          "ok"
        );
      } catch (err) {
        setStatus(byId("opsNicknameBulkMsg"), err.message, "error");
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
    await Promise.allSettled([
      loadHealth(),
      loadMetrics(),
      loadSealed(),
      loadJobs(),
      loadSchedules(),
      loadFlags()
    ]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot());
  } else {
    void boot();
  }
})();
