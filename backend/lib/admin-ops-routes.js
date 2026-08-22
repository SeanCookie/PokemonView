/**
 * Extra admin ops routes (health, coverage, gap refresh, sealed, flags, etc.).
 * Returns true if the request was handled.
 */
const path = require("path");
const fsp = require("fs/promises");

async function tryHandleAdminOpsRoutes(req, res, ctx) {
  const {
    pathname,
    method,
    requireAdmin,
    readBody,
    json,
    adminOps,
    listEnglishSetPricingTargets,
    getAdminSetRefreshTimestampsSnapshot,
    getSetCardManifest,
    loadSetCardDetailsEntryForCode,
    readSealedCatalog,
    syncPriceChartingSealedCatalog,
    downloadSealedProductImages,
    runAdminTcgPriceCheckForSet,
    runPriceChartingDetailsPrewarmBackground,
    persistTcgLinkPriceCacheNow,
    persistPriceChartingCardDetailsCacheNow,
    persistAdminSetRefreshTimestampsNow,
    spawnSplitSetCardDetails,
    CARD_IMAGE_DIR,
    CARD_NICKNAMES_FILE,
    bulkAddCardNicknames,
    getCardNicknamesCached,
    invalidateNicknamesCache,
    store,
    persistStore,
    adminUsernames,
    withAdminFlag,
    publicUserPayload,
    ensureUserShowcase,
    defaultShowcaseSettings,
    syncTcgBulkPriceCheckCacheCount,
    getPriceChartingAdminMeta,
    isTcgBulkPriceCheckInFlight,
    isPriceChartingDetailsPrewarmInFlight,
    restockRefreshInFlight,
    pushJobHistory,
    finishJobHistory
  } = ctx;

  const adminGate = () => {
    const admin = requireAdmin(req, res);
    return admin;
  };

  async function coverageContext() {
    const sets = await listEnglishSetPricingTargets();
    const manifest = await getSetCardManifest("english");
    const byCode = manifest?.byCode && typeof manifest.byCode === "object" ? manifest.byCode : {};
    const enriched = [];
    for (const row of sets) {
      const entry = byCode[row.setCode] || {};
      const cards = entry.cards && typeof entry.cards === "object" ? entry.cards : {};
      const localImages =
        entry.localImages && typeof entry.localImages === "object" ? entry.localImages : {};
      enriched.push({
        ...row,
        cardCount: Object.keys(cards).length,
        localImageCount: Object.keys(localImages).length
      });
    }
    const detailsByCode = {};
    const byCodeDir = path.join(__dirname, "..", "data", "set-card-details", "by-code");
    for (const row of enriched) {
      try {
        const filePath = path.join(byCodeDir, `${row.setCode}.json`);
        const st = await fsp.stat(filePath);
        if (st.size > 50) {
          // Prefer lightweight presence; fall back to card count from lists when details file exists.
          detailsByCode[row.setCode] = { cards: row.cardCount ? { _n: row.cardCount } : {} };
          if (row.cardCount) {
            const fake = {};
            for (let i = 0; i < row.cardCount; i += 1) fake[String(i)] = true;
            detailsByCode[row.setCode] = { cards: fake };
          }
        } else {
          detailsByCode[row.setCode] = {};
        }
      } catch {
        try {
          const details = await loadSetCardDetailsEntryForCode(row.setCode);
          detailsByCode[row.setCode] = details || {};
        } catch {
          detailsByCode[row.setCode] = {};
        }
      }
    }
    let sealedByCode = {};
    try {
      const sealed = await readSealedCatalog();
      sealedByCode = sealed?.byCode && typeof sealed.byCode === "object" ? sealed.byCode : {};
    } catch {
      sealedByCode = {};
    }
    return {
      listSets: async () => enriched,
      getStamps: () => getAdminSetRefreshTimestampsSnapshot(),
      detailsByCode,
      sealedByCode
    };
  }

  if (pathname === "/api/admin/health" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    adminOps.recordMetricAndPersist("api.admin.status");
    const payload = await adminOps.buildHealthSnapshot({
      tcg: {
        ...syncTcgBulkPriceCheckCacheCount(),
        inFlight: isTcgBulkPriceCheckInFlight()
      },
      priceCharting: getPriceChartingAdminMeta(),
      restock: { inFlight: Boolean(restockRefreshInFlight) },
      site: {
        userCount: store.users.length,
        itemCount: store.items.length,
        activityCount: store.activities.length
      }
    });
    json(res, 200, payload);
    return true;
  }

  if (pathname === "/api/admin/metrics" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, { ok: true, metrics: adminOps.getMetricsSnapshot() });
    return true;
  }

  if (pathname === "/api/admin/coverage" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    const rows = await adminOps.buildCoverageRows(await coverageContext());
    json(res, 200, {
      ok: true,
      at: new Date().toISOString(),
      setCount: rows.length,
      rows
    });
    return true;
  }

  if (pathname === "/api/admin/integrity" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    const report = await adminOps.buildIntegrityReport(await coverageContext());
    json(res, 200, report);
    return true;
  }

  if (pathname === "/api/admin/gap-refresh" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, { ok: true, job: adminOps.getGapJob() });
    return true;
  }

  if (pathname === "/api/admin/gap-refresh" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const body = (await readBody(req)) || {};
      const kind = String(body.kind || "tcg").toLowerCase() === "pricecharting" ? "pricecharting" : "tcg";
      const mode = String(body.mode || "stale").toLowerCase();
      const staleDays = Number(body.staleDays) || (kind === "pricecharting" ? 21 : 14);
      const limit = Number(body.limit) || 10;
      const coverageRows = await adminOps.buildCoverageRows(await coverageContext());
      const actor = admin.sessionUser.username || admin.sessionUser.email || "admin";
      const result = await adminOps.runGapRefreshJob({
        kind,
        mode,
        staleDays,
        limit,
        actor,
        coverageRows,
        runSet: async (setCode, setName) => {
          if (kind === "pricecharting") {
            await runPriceChartingDetailsPrewarmBackground(actor, { setCode, setName });
          } else {
            await runAdminTcgPriceCheckForSet(setCode, setName, actor);
          }
        }
      });
      json(res, 202, result);
    } catch (err) {
      json(res, 409, { ok: false, error: err.message || "Gap refresh failed" });
    }
    return true;
  }

  if (pathname === "/api/admin/gap-refresh/stop" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, adminOps.stopGapRefreshJob());
    return true;
  }

  if (pathname === "/api/admin/sealed" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const summary = await adminOps.buildSealedAdminSummary(readSealedCatalog);
      json(res, 200, summary);
    } catch (err) {
      json(res, 200, { ok: false, error: err.message || "Sealed catalog missing", productCount: 0 });
    }
    return true;
  }

  if (pathname === "/api/admin/sealed/refresh" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const body = (await readBody(req)) || {};
      const actor = admin.sessionUser.username || admin.sessionUser.email || "admin";
      const result = await adminOps.runSealedRefreshJob({
        actor,
        syncFn: () => syncPriceChartingSealedCatalog({}),
        downloadImages:
          body.downloadImages === false
            ? null
            : async () => {
                await downloadSealedProductImages({});
              }
      });
      json(res, 202, result);
    } catch (err) {
      json(res, 409, { ok: false, error: err.message || "Sealed refresh failed" });
    }
    return true;
  }

  if (pathname === "/api/admin/jobs" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    const jobs = await adminOps.loadJobHistory();
    json(res, 200, {
      ok: true,
      jobs,
      live: { gap: adminOps.getGapJob(), sealed: adminOps.getSealedJob() }
    });
    return true;
  }

  if (pathname === "/api/admin/schedules" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, { ok: true, schedules: await adminOps.loadSchedules() });
    return true;
  }

  if (pathname === "/api/admin/schedules" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const body = (await readBody(req)) || {};
      const schedules = await adminOps.saveSchedules(body.schedules || body);
      json(res, 200, { ok: true, schedules });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to save schedules" });
    }
    return true;
  }

  if (pathname === "/api/admin/flags" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, { ok: true, flags: await adminOps.loadFlags(), defaults: adminOps.DEFAULT_FLAGS });
    return true;
  }

  if (pathname === "/api/admin/flags" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const body = (await readBody(req)) || {};
      const current = await adminOps.loadFlags();
      const next = { ...current };
      for (const key of Object.keys(adminOps.DEFAULT_FLAGS)) {
        if (Object.prototype.hasOwnProperty.call(body.flags || body, key)) {
          next[key] = Boolean((body.flags || body)[key]);
        }
      }
      const flags = await adminOps.saveFlags(next);
      json(res, 200, { ok: true, flags });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Failed to save flags" });
    }
    return true;
  }

  if (pathname === "/api/admin/persist" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const body = (await readBody(req)) || {};
      const targets = Array.isArray(body.targets) ? body.targets : ["tcg", "pricecharting", "stamps"];
      const results = {};
      const actor = admin.sessionUser.username || "admin";
      const job = await adminOps.pushJobHistory({ kind: "persist", label: targets.join(","), actor });
      if (targets.includes("tcg") && typeof persistTcgLinkPriceCacheNow === "function") {
        await persistTcgLinkPriceCacheNow();
        results.tcg = true;
      }
      if (targets.includes("pricecharting") && typeof persistPriceChartingCardDetailsCacheNow === "function") {
        await persistPriceChartingCardDetailsCacheNow();
        results.pricecharting = true;
      }
      if (targets.includes("stamps") && typeof persistAdminSetRefreshTimestampsNow === "function") {
        await persistAdminSetRefreshTimestampsNow();
        results.stamps = true;
      }
      if (targets.includes("split-details") && typeof spawnSplitSetCardDetails === "function") {
        results.split = await spawnSplitSetCardDetails();
      }
      await adminOps.finishJobHistory(job.id, { status: "done", results });
      json(res, 200, { ok: true, results });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Persist failed" });
    }
    return true;
  }

  if (pathname === "/api/admin/images/report" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    const sets = await listEnglishSetPricingTargets();
    const manifest = await getSetCardManifest("english");
    const byCode = manifest?.byCode && typeof manifest.byCode === "object" ? manifest.byCode : {};
    const enriched = sets.map((row) => {
      const cards = byCode[row.setCode]?.cards;
      return {
        ...row,
        cardCount: cards && typeof cards === "object" ? Object.keys(cards).length : 0
      };
    });
    const report = await adminOps.buildImageReport(CARD_IMAGE_DIR, enriched);
    json(res, 200, report);
    return true;
  }

  if (pathname === "/api/admin/showcase" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    const rows = store.users
      .map((user) => {
        const showcase = ensureUserShowcase ? ensureUserShowcase(user) : user.showcase || defaultShowcaseSettings();
        const itemCount = store.items.filter((item) => String(item.userId) === String(user.id)).length;
        return {
          id: user.id,
          username: user.username || "",
          name: user.name || "",
          email: user.email || "",
          isPublic: showcase.isPublic !== false,
          bio: showcase.bio || "",
          avatarUrl: showcase.avatarUrl || "",
          itemCount,
          disabledAt: user.disabledAt || null
        };
      })
      .sort((a, b) => Number(b.isPublic) - Number(a.isPublic) || String(a.username).localeCompare(String(b.username)));
    json(res, 200, { ok: true, showcases: rows });
    return true;
  }

  const showcaseActionMatch = pathname.match(/^\/api\/admin\/showcase\/([^/]+)\/(private|clear-avatar)$/);
  if (showcaseActionMatch && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    const user = store.users.find((entry) => entry.id === showcaseActionMatch[1]);
    if (!user) {
      json(res, 404, { ok: false, error: "User not found" });
      return true;
    }
    if (!user.showcase) user.showcase = defaultShowcaseSettings();
    if (showcaseActionMatch[2] === "private") {
      user.showcase.isPublic = false;
    } else {
      user.showcase.avatarUrl = "";
    }
    await persistStore();
    json(res, 200, { ok: true, showcase: user.showcase });
    return true;
  }

  const userActionMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/(disable|enable|reset-collection|delete)$/);
  if (userActionMatch && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    const target = store.users.find((entry) => entry.id === userActionMatch[1]);
    if (!target) {
      json(res, 404, { ok: false, error: "User not found" });
      return true;
    }
    if (String(target.id) === String(admin.sessionUser.id)) {
      json(res, 400, { ok: false, error: "Cannot modify your own account this way" });
      return true;
    }
    const action = userActionMatch[2];
    if (action === "disable") {
      target.disabledAt = new Date().toISOString();
      await persistStore();
      json(res, 200, { ok: true, user: withAdminFlag(publicUserPayload(target), adminUsernames) });
      return true;
    }
    if (action === "enable") {
      delete target.disabledAt;
      await persistStore();
      json(res, 200, { ok: true, user: withAdminFlag(publicUserPayload(target), adminUsernames) });
      return true;
    }
    if (action === "reset-collection") {
      const before = store.items.length;
      store.items = store.items.filter((item) => String(item.userId) !== String(target.id));
      const removed = before - store.items.length;
      await persistStore();
      json(res, 200, { ok: true, removed });
      return true;
    }
    if (action === "delete") {
      store.items = store.items.filter((item) => String(item.userId) !== String(target.id));
      store.activities = (store.activities || []).filter((row) => String(row.userId) !== String(target.id));
      store.users = store.users.filter((entry) => entry.id !== target.id);
      await persistStore();
      json(res, 200, { ok: true, deleted: true, id: target.id });
      return true;
    }
  }

  if (pathname === "/api/admin/card-nicknames/bulk" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const body = (await readBody(req)) || {};
      let rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length && typeof body.csv === "string") {
        rows = parseNicknameCsv(body.csv);
      }
      const result = await bulkAddCardNicknames(CARD_NICKNAMES_FILE, rows);
      if (typeof invalidateNicknamesCache === "function") invalidateNicknamesCache();
      json(res, 200, { ok: true, ...result, total: (await getCardNicknamesCached()).length });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message || "Bulk import failed" });
    }
    return true;
  }

  if (pathname === "/api/admin/activities" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    const limit = Math.max(1, Math.min(150, Number(new URL(req.url, "http://local").searchParams.get("limit")) || 40));
    json(res, 200, {
      ok: true,
      activities: (store.activities || []).slice(0, limit)
    });
    return true;
  }

  return false;
}

function parseNicknameCsv(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].toLowerCase();
  const hasHeader = /nickname/.test(header) && (/set/.test(header) || /code/.test(header));
  const start = hasHeader ? 1 : 0;
  const rows = [];
  for (let i = start; i < lines.length; i += 1) {
    const parts = lines[i].split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
    if (parts.length < 3) continue;
    rows.push({
      nickname: parts[0],
      setCode: parts[1],
      cardNumber: parts[2],
      setName: parts[3] || "",
      language: parts[4] || "english"
    });
  }
  return rows;
}

module.exports = {
  tryHandleAdminOpsRoutes,
  parseNicknameCsv
};
