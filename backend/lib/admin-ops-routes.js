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
    persistSealedCatalogNow,
    runAdminTcgPriceCheckForSet,
    runPriceChartingDetailsPrewarmBackground,
    persistTcgLinkPriceCacheNow,
    persistPriceChartingCardDetailsCacheNow,
    persistAdminSetRefreshTimestampsNow,
    persistMarketHistoryCacheNow,
    persistDiscoverySnapshotNow,
    persistTrendingNow,
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
    getPriceChartingMarketHistoryCacheMeta,
    getDiscoveryMeta,
    buildDiscoverySnapshot,
    fetchPriceChartingMarketHistoryForCard,
    getOrFetchPriceChartingSealedDetails,
    readCachedChartEntry,
    readCachedSealedProductDetails,
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
      },
      marketHistoryMeta:
        typeof getPriceChartingMarketHistoryCacheMeta === "function"
          ? getPriceChartingMarketHistoryCacheMeta()
          : null,
      discoveryMeta: typeof getDiscoveryMeta === "function" ? getDiscoveryMeta() : null
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

  async function buildMarketHistoryWarmTargets({
    limit = 200,
    missingOnly = true,
    includeSealed = true,
    setCode = ""
  } = {}) {
    const codeFilter = String(setCode || "").trim().toUpperCase();
    const max = Math.max(1, Math.min(5000, Number(limit) || 200));
    const targets = [];
    const sets = await listEnglishSetPricingTargets();
    const manifest = await getSetCardManifest("english");
    const byCode = manifest?.byCode && typeof manifest.byCode === "object" ? manifest.byCode : {};

    for (const set of sets) {
      if (targets.length >= max) break;
      const code = String(set.setCode || "").trim().toUpperCase();
      if (!code) continue;
      if (codeFilter && code !== codeFilter) continue;
      const cards = byCode[code]?.cards && typeof byCode[code].cards === "object" ? byCode[code].cards : {};
      for (const [cardNo, card] of Object.entries(cards)) {
        if (targets.length >= max) break;
        const no = String(cardNo || "").trim();
        if (!no) continue;
        const cached =
          typeof readCachedChartEntry === "function" ? readCachedChartEntry(code, no) : null;
        if (missingOnly && cached) continue;
        targets.push({
          kind: "card",
          setCode: code,
          setName: set.setName || byCode[code]?.setName || code,
          cardNo: no,
          cardName: String(card?.name || card?.cardName || "").trim()
        });
      }
    }

    if (includeSealed && targets.length < max) {
      try {
        const sealed = await readSealedCatalog();
        const sealedByCode = sealed?.byCode && typeof sealed.byCode === "object" ? sealed.byCode : {};
        for (const [code, row] of Object.entries(sealedByCode)) {
          if (targets.length >= max) break;
          const setCodeUpper = String(code || "").trim().toUpperCase();
          if (!setCodeUpper) continue;
          if (codeFilter && setCodeUpper !== codeFilter) continue;
          const products = Array.isArray(row?.products) ? row.products : [];
          for (const product of products) {
            if (targets.length >= max) break;
            const productId = String(product?.productId || "").trim();
            const productUrl = String(product?.productUrl || "").trim();
            if (!productId && !productUrl) continue;
            const cached =
              productId && typeof readCachedSealedProductDetails === "function"
                ? readCachedSealedProductDetails(setCodeUpper, productId)
                : null;
            if (missingOnly && cached) continue;
            targets.push({
              kind: "sealed",
              setCode: setCodeUpper,
              setName: row?.name || setCodeUpper,
              productId,
              productUrl,
              productTitle: String(product?.title || product?.name || "").trim()
            });
          }
        }
      } catch {
        /* sealed optional */
      }
    }
    return targets;
  }

  async function warmOneMarketHistoryTarget(target) {
    if (target.kind === "sealed") {
      const payload = await getOrFetchPriceChartingSealedDetails(
        {
          setCode: target.setCode,
          setName: target.setName,
          productId: target.productId,
          productUrl: target.productUrl,
          productTitle: target.productTitle
        },
        { forceRefresh: false, cacheOnly: false }
      );
      return {
        ok: Boolean(payload?.ok),
        skipped: Boolean(payload?.cached)
      };
    }
    const series = await fetchPriceChartingMarketHistoryForCard({
      setCode: target.setCode,
      setName: target.setName,
      cardNo: target.cardNo,
      cardName: target.cardName,
      forceRefresh: false
    });
    return { ok: Array.isArray(series) && series.length > 0 };
  }

  if (pathname === "/api/admin/market-history" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, {
      ok: true,
      job: adminOps.getMarketHistoryJob(),
      meta:
        typeof getPriceChartingMarketHistoryCacheMeta === "function"
          ? getPriceChartingMarketHistoryCacheMeta()
          : null
    });
    return true;
  }

  if (pathname === "/api/admin/market-history/warm" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const body = (await readBody(req)) || {};
      const actor = admin.sessionUser.username || admin.sessionUser.email || "admin";
      const limit = Number(body.limit) || 200;
      const missingOnly = body.missingOnly !== false;
      const includeSealed = body.includeSealed !== false;
      const concurrency = Number(body.concurrency) || 2;
      const targets = await buildMarketHistoryWarmTargets({
        limit,
        missingOnly,
        includeSealed,
        setCode: body.setCode || ""
      });
      const result = await adminOps.runMarketHistoryWarmJob({
        actor,
        targets,
        concurrency,
        warmFn: warmOneMarketHistoryTarget
      });
      json(res, result.started ? 202 : 200, result);
    } catch (err) {
      json(res, 409, { ok: false, error: err.message || "Market history warm failed" });
    }
    return true;
  }

  if (pathname === "/api/admin/market-history/stop" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, adminOps.stopMarketHistoryWarmJob());
    return true;
  }

  if (pathname === "/api/admin/discovery" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, {
      ok: true,
      meta: typeof getDiscoveryMeta === "function" ? getDiscoveryMeta() : null
    });
    return true;
  }

  if (pathname === "/api/admin/discovery/rebuild" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const actor = admin.sessionUser.username || admin.sessionUser.email || "admin";
      const job = await adminOps.pushJobHistory({
        kind: "discovery-rebuild",
        label: "Discovery snapshot rebuild",
        actor
      });
      const snapshot = await buildDiscoverySnapshot({ force: true });
      await adminOps.finishJobHistory(job.id, {
        status: "done",
        builtAt: snapshot.builtAt,
        sourceEntries: snapshot.sourceEntries
      });
      json(res, 200, {
        ok: true,
        builtAt: snapshot.builtAt,
        sourceEntries: snapshot.sourceEntries,
        sourceBreakdown: snapshot.sourceBreakdown || null
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || "Discovery rebuild failed" });
    }
    return true;
  }

  if (pathname === "/api/admin/pull-catalog" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, { ok: true, job: adminOps.getPullCatalogJob() });
    return true;
  }

  if (pathname === "/api/admin/pull-catalog" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    try {
      const body = (await readBody(req)) || {};
      const actor = admin.sessionUser.username || admin.sessionUser.email || "admin";
      const stages = body.stages && typeof body.stages === "object" ? body.stages : {};
      const historyLimit = Number(body.historyLimit) || 300;
      const historyConcurrency = Number(body.historyConcurrency) || 2;

      const waitForJob = async (getJob, { timeoutMs = 1000 * 60 * 90 } = {}) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (adminOps.getPullCatalogJob()?.stopRequested) return { aborted: true };
          const job = getJob();
          if (!job || job.status !== "running") return job || { status: "done" };
          await new Promise((r) => setTimeout(r, 1500));
        }
        return { status: "timeout" };
      };

      const result = await adminOps.runPullCatalogJob({
        actor,
        stages,
        runStage: async (stage, helpers) => {
          if (stage === "sealed") {
            helpers.setDetail("Syncing sealed catalog…");
            const started = await adminOps.runSealedRefreshJob({
              actor,
              syncFn: () => syncPriceChartingSealedCatalog({}),
              downloadImages: async () => {
                await downloadSealedProductImages({});
              }
            });
            const finished = await waitForJob(() => adminOps.getSealedJob());
            return { ok: true, started, finished };
          }
          if (stage === "pricecharting") {
            helpers.setDetail("Warming PriceCharting details (gap)…");
            const coverageRows = await adminOps.buildCoverageRows(await coverageContext());
            const started = await adminOps.runGapRefreshJob({
              kind: "pricecharting",
              mode: "stale",
              staleDays: 21,
              limit: Number(body.pcLimit) || 20,
              actor,
              coverageRows,
              runSet: async (setCode, setName) => {
                await runPriceChartingDetailsPrewarmBackground(actor, { setCode, setName });
              }
            });
            const finished = await waitForJob(() => adminOps.getGapJob());
            return { ok: true, started, finished };
          }
          if (stage === "tcg") {
            helpers.setDetail("Warming TCG prices (gap)…");
            const coverageRows = await adminOps.buildCoverageRows(await coverageContext());
            const started = await adminOps.runGapRefreshJob({
              kind: "tcg",
              mode: "stale",
              staleDays: 14,
              limit: Number(body.tcgLimit) || 20,
              actor,
              coverageRows,
              runSet: async (setCode, setName) => {
                await runAdminTcgPriceCheckForSet(setCode, setName, actor);
              }
            });
            const finished = await waitForJob(() => adminOps.getGapJob());
            return { ok: true, started, finished };
          }
          if (stage === "marketHistory") {
            helpers.setDetail("Warming market history…");
            const targets = await buildMarketHistoryWarmTargets({
              limit: historyLimit,
              missingOnly: true,
              includeSealed: true
            });
            const started = await adminOps.runMarketHistoryWarmJob({
              actor,
              targets,
              concurrency: historyConcurrency,
              warmFn: warmOneMarketHistoryTarget,
              label: "Pull Catalog · market history",
              allowDuringPullCatalog: true
            });
            const finished = await waitForJob(() => adminOps.getMarketHistoryJob());
            return { ok: true, started, finished };
          }
          if (stage === "discovery") {
            helpers.setDetail("Rebuilding discovery snapshot…");
            const snapshot = await buildDiscoverySnapshot({ force: true });
            return {
              ok: true,
              builtAt: snapshot.builtAt,
              sourceEntries: snapshot.sourceEntries
            };
          }
          if (stage === "persist") {
            helpers.setDetail("Persisting caches to disk/R2…");
            const results = {};
            if (typeof persistTcgLinkPriceCacheNow === "function") {
              await persistTcgLinkPriceCacheNow();
              results.tcg = true;
            }
            if (typeof persistPriceChartingCardDetailsCacheNow === "function") {
              await persistPriceChartingCardDetailsCacheNow();
              results.pricecharting = true;
            }
            if (typeof persistMarketHistoryCacheNow === "function") {
              await persistMarketHistoryCacheNow();
              results.marketHistory = true;
            }
            if (typeof persistDiscoverySnapshotNow === "function") {
              await persistDiscoverySnapshotNow();
              results.discovery = true;
            }
            if (typeof persistSealedCatalogNow === "function") {
              await persistSealedCatalogNow();
              results.sealed = true;
            }
            if (typeof persistAdminSetRefreshTimestampsNow === "function") {
              await persistAdminSetRefreshTimestampsNow();
              results.stamps = true;
            }
            return { ok: true, results };
          }
          return { ok: false, error: `Unknown stage ${stage}` };
        }
      });
      json(res, result.started ? 202 : 200, result);
    } catch (err) {
      json(res, 409, { ok: false, error: err.message || "Pull Catalog failed" });
    }
    return true;
  }

  if (pathname === "/api/admin/pull-catalog/stop" && method === "POST") {
    const admin = adminGate();
    if (!admin) return true;
    json(res, 200, adminOps.stopPullCatalogJob());
    return true;
  }

  if (pathname === "/api/admin/jobs" && method === "GET") {
    const admin = adminGate();
    if (!admin) return true;
    const jobs = await adminOps.loadJobHistory();
    json(res, 200, {
      ok: true,
      jobs,
      live: {
        gap: adminOps.getGapJob(),
        sealed: adminOps.getSealedJob(),
        marketHistory: adminOps.getMarketHistoryJob(),
        pullCatalog: adminOps.getPullCatalogJob()
      }
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
      const targets = Array.isArray(body.targets)
        ? body.targets
        : ["tcg", "pricecharting", "stamps"];
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
      if (targets.includes("marketHistory") && typeof persistMarketHistoryCacheNow === "function") {
        await persistMarketHistoryCacheNow();
        results.marketHistory = true;
      }
      if (targets.includes("discovery") && typeof persistDiscoverySnapshotNow === "function") {
        await persistDiscoverySnapshotNow();
        if (typeof persistTrendingNow === "function") await persistTrendingNow();
        results.discovery = true;
      }
      if (targets.includes("sealed") && typeof persistSealedCatalogNow === "function") {
        await persistSealedCatalogNow();
        results.sealed = true;
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
