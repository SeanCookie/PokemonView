const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { writeJsonAtomic } = require("./write-json-atomic");

const DATA_DIR = path.join(__dirname, "..", "data");
const FLAGS_FILE = path.join(DATA_DIR, "admin-feature-flags.json");
const SCHEDULES_FILE = path.join(DATA_DIR, "admin-schedules.json");
const JOBS_FILE = path.join(DATA_DIR, "admin-job-history.json");
const METRICS_FILE = path.join(DATA_DIR, "admin-metrics.json");

const DEFAULT_FLAGS = {
  restockLiveFetch: true,
  priceChartingLiveFetch: true,
  tcgHourlyRefresh: true,
  scanYourCards: true,
  tradeAnalyzer: true,
  showcasePublic: true,
  collectionAdd: true
};

const DEFAULT_SCHEDULES = {
  restockNightly: { enabled: false, hourUtc: 6, lastRunAt: null },
  tcgGapDaily: { enabled: false, hourUtc: 7, lastRunAt: null, limit: 12, staleDays: 14 },
  pcGapDaily: { enabled: false, hourUtc: 8, lastRunAt: null, limit: 12, staleDays: 21 }
};

const JOB_HISTORY_MAX = 80;
const METRICS_KEYS = [
  "api.sets.pricing",
  "api.sets.pricechartingCardDetails",
  "api.sets.sealed",
  "api.sets.linkPrices",
  "api.restock",
  "api.admin.status"
];

let flagsCache = null;
let schedulesCache = null;
let metricsState = {
  startedAt: new Date().toISOString(),
  counters: Object.fromEntries(METRICS_KEYS.map((k) => [k, 0])),
  lastHitAt: {}
};
let scheduleTimer = null;
let gapJob = null;
let sealedJob = null;
let opsHooks = null;

function nowIso() {
  return new Date().toISOString();
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function loadFlags() {
  if (flagsCache) return flagsCache;
  const parsed = await readJsonFile(FLAGS_FILE, {});
  flagsCache = { ...DEFAULT_FLAGS, ...(parsed.flags || parsed) };
  return flagsCache;
}

async function saveFlags(next) {
  flagsCache = { ...DEFAULT_FLAGS, ...next };
  await writeJsonAtomic(FLAGS_FILE, { updatedAt: nowIso(), flags: flagsCache });
  return flagsCache;
}

async function getFeatureFlag(name) {
  const flags = await loadFlags();
  if (!Object.prototype.hasOwnProperty.call(flags, name)) return true;
  return Boolean(flags[name]);
}

async function loadSchedules() {
  if (schedulesCache) return schedulesCache;
  const parsed = await readJsonFile(SCHEDULES_FILE, {});
  const incoming = parsed.schedules || parsed;
  schedulesCache = {
    restockNightly: { ...DEFAULT_SCHEDULES.restockNightly, ...(incoming.restockNightly || {}) },
    tcgGapDaily: { ...DEFAULT_SCHEDULES.tcgGapDaily, ...(incoming.tcgGapDaily || {}) },
    pcGapDaily: { ...DEFAULT_SCHEDULES.pcGapDaily, ...(incoming.pcGapDaily || {}) }
  };
  return schedulesCache;
}

async function saveSchedules(next) {
  const current = await loadSchedules();
  schedulesCache = {
    restockNightly: { ...current.restockNightly, ...(next.restockNightly || {}) },
    tcgGapDaily: { ...current.tcgGapDaily, ...(next.tcgGapDaily || {}) },
    pcGapDaily: { ...current.pcGapDaily, ...(next.pcGapDaily || {}) }
  };
  await writeJsonAtomic(SCHEDULES_FILE, { updatedAt: nowIso(), schedules: schedulesCache });
  return schedulesCache;
}

async function loadJobHistory() {
  const parsed = await readJsonFile(JOBS_FILE, { jobs: [] });
  return Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

async function pushJobHistory(entry) {
  const jobs = await loadJobHistory();
  jobs.unshift({
    id: `job-${Date.now()}-${Math.floor(Math.random() * 1e5)}`,
    startedAt: nowIso(),
    finishedAt: null,
    status: "running",
    ...entry
  });
  while (jobs.length > JOB_HISTORY_MAX) jobs.pop();
  await writeJsonAtomic(JOBS_FILE, { updatedAt: nowIso(), jobs });
  return jobs[0];
}

async function finishJobHistory(jobId, patch = {}) {
  const jobs = await loadJobHistory();
  const idx = jobs.findIndex((row) => row.id === jobId);
  if (idx === -1) return null;
  jobs[idx] = {
    ...jobs[idx],
    ...patch,
    finishedAt: nowIso(),
    status: patch.status || "done"
  };
  await writeJsonAtomic(JOBS_FILE, { updatedAt: nowIso(), jobs });
  return jobs[idx];
}

async function loadMetricsFromDisk() {
  const parsed = await readJsonFile(METRICS_FILE, null);
  if (!parsed) return;
  metricsState = {
    startedAt: parsed.startedAt || metricsState.startedAt,
    counters: { ...metricsState.counters, ...(parsed.counters || {}) },
    lastHitAt: { ...(parsed.lastHitAt || {}) }
  };
}

function recordMetric(key, amount = 1) {
  if (!METRICS_KEYS.includes(key)) return;
  metricsState.counters[key] = (Number(metricsState.counters[key]) || 0) + amount;
  metricsState.lastHitAt[key] = nowIso();
}

let metricsPersistTimer = null;
function schedulePersistMetrics() {
  if (metricsPersistTimer) return;
  metricsPersistTimer = setTimeout(() => {
    metricsPersistTimer = null;
    writeJsonAtomic(METRICS_FILE, {
      updatedAt: nowIso(),
      startedAt: metricsState.startedAt,
      counters: metricsState.counters,
      lastHitAt: metricsState.lastHitAt
    }).catch(() => {});
  }, 15000);
}

function recordMetricAndPersist(key, amount = 1) {
  recordMetric(key, amount);
  schedulePersistMetrics();
}

function getMetricsSnapshot() {
  return {
    startedAt: metricsState.startedAt,
    counters: { ...metricsState.counters },
    lastHitAt: { ...metricsState.lastHitAt }
  };
}

async function fileMeta(filePath) {
  try {
    const st = await fsp.stat(filePath);
    return {
      exists: true,
      bytes: st.size,
      mb: Number((st.size / (1024 * 1024)).toFixed(2)),
      mtime: st.mtime.toISOString()
    };
  } catch {
    return { exists: false, bytes: 0, mb: 0, mtime: null };
  }
}

async function dirFileCount(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

async function buildHealthSnapshot(ctx = {}) {
  const mem = process.memoryUsage();
  const flags = await loadFlags();
  const schedules = await loadSchedules();
  const files = {
    store: await fileMeta(path.join(DATA_DIR, "store.json")),
    tcgCache: await fileMeta(path.join(DATA_DIR, "tcg-link-prices-cache.json")),
    pcDetails: await fileMeta(path.join(DATA_DIR, "pricecharting-card-details-cache.json")),
    pcMarket: await fileMeta(path.join(DATA_DIR, "pricecharting-market-history-cache.json")),
    sealed: await fileMeta(path.join(DATA_DIR, "pricecharting-sealed-by-set.json")),
    restock: await fileMeta(path.join(DATA_DIR, "restock-tracker.json")),
    nicknames: await fileMeta(path.join(DATA_DIR, "card-nicknames.json")),
    setCardDetails: await fileMeta(path.join(DATA_DIR, "set-card-details.json"))
  };
  return {
    ok: true,
    at: nowIso(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    memory: {
      rssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
      heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
      heapTotalMb: Number((mem.heapTotal / (1024 * 1024)).toFixed(1))
    },
    files,
    flags,
    schedules,
    jobs: {
      gap: gapJob,
      sealed: sealedJob
    },
    tcg: ctx.tcg || null,
    priceCharting: ctx.priceCharting || null,
    restock: ctx.restock || null,
    site: ctx.site || null
  };
}

function daysAgoIso(days) {
  return new Date(Date.now() - Number(days) * 86400000).toISOString();
}

function isStale(iso, staleDays) {
  if (!iso) return true;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return true;
  return t < Date.now() - Number(staleDays) * 86400000;
}

async function buildCoverageRows(ctx) {
  const sets = (await ctx.listSets()) || [];
  const stamps = ctx.getStamps() || { tcg: {}, pricecharting: {} };
  const imageIndex = ctx.imageIndex || {};
  const detailsByCode = ctx.detailsByCode || {};
  const sealedByCode = ctx.sealedByCode || {};
  const rows = [];
  for (const set of sets) {
    const code = String(set.setCode || "").trim().toUpperCase();
    if (!code) continue;
    const details = detailsByCode[code] || {};
    const detailCards =
      details.cards && typeof details.cards === "object" ? Object.keys(details.cards).length : 0;
    const listCards = Number(set.cardCount) || detailCards || 0;
    const localImages =
      imageIndex[code] && typeof imageIndex[code] === "object"
        ? Object.keys(imageIndex[code]).length
        : Number(set.localImageCount) || 0;
    const sealedProducts = Array.isArray(sealedByCode[code]?.products)
      ? sealedByCode[code].products
      : [];
    const sealedPriced = sealedProducts.filter((p) => Number(p?.ungradedPrice) > 0).length;
    const tcgAt = stamps.tcg?.[code] || null;
    const pcAt = stamps.pricecharting?.[code] || null;
    rows.push({
      setCode: code,
      setName: set.setName || code,
      cardCount: listCards,
      detailCardCount: detailCards,
      localImageCount: localImages,
      imageCoverage: listCards ? Math.min(100, Math.round((localImages / listCards) * 100)) : null,
      detailsCoverage: listCards ? Math.min(100, Math.round((detailCards / listCards) * 100)) : null,
      tcgLastRefreshAt: tcgAt,
      priceChartingLastRefreshAt: pcAt,
      tcgStale: isStale(tcgAt, 14),
      pcStale: isStale(pcAt, 21),
      sealedCount: sealedProducts.length,
      sealedPriced,
      missingDetails: listCards > 0 && detailCards === 0,
      missingImages: listCards > 0 && localImages === 0
    });
  }
  rows.sort((a, b) => String(a.setName).localeCompare(String(b.setName)));
  return rows;
}

async function buildIntegrityReport(ctx) {
  const coverage = await buildCoverageRows(ctx);
  const emptyDetails = coverage.filter((r) => r.missingDetails);
  const emptyImages = coverage.filter((r) => r.missingImages);
  const staleTcg = coverage.filter((r) => r.tcgStale);
  const stalePc = coverage.filter((r) => r.pcStale);
  const sealedGaps = coverage.filter((r) => r.sealedCount > 0 && r.sealedPriced < r.sealedCount);
  return {
    ok: true,
    at: nowIso(),
    summary: {
      setCount: coverage.length,
      emptyDetails: emptyDetails.length,
      emptyImages: emptyImages.length,
      staleTcg: staleTcg.length,
      stalePc: stalePc.length,
      sealedPriceGaps: sealedGaps.length
    },
    emptyDetails: emptyDetails.slice(0, 40),
    emptyImages: emptyImages.slice(0, 40),
    sealedPriceGaps: sealedGaps.slice(0, 40),
    staleTcg: staleTcg.slice(0, 40),
    stalePc: stalePc.slice(0, 40)
  };
}

function pickGapTargets(rows, { kind, mode, staleDays, limit }) {
  const max = Math.max(1, Math.min(50, Number(limit) || 10));
  const key = kind === "pricecharting" ? "priceChartingLastRefreshAt" : "tcgLastRefreshAt";
  const staleKey = kind === "pricecharting" ? "pcStale" : "tcgStale";
  let list = [...rows];
  if (mode === "missing") {
    list = list.filter((r) => !r[key]);
  } else if (mode === "stale") {
    list = list.filter((r) => isStale(r[key], staleDays) || r[staleKey]);
  } else if (mode === "newest") {
    list = list.sort((a, b) => String(b.setCode).localeCompare(String(a.setCode)));
  } else {
    list = list.filter((r) => !r[key] || isStale(r[key], staleDays));
    list.sort((a, b) => {
      const ta = Date.parse(String(a[key] || "")) || 0;
      const tb = Date.parse(String(b[key] || "")) || 0;
      return ta - tb;
    });
  }
  return list.slice(0, max);
}

function getGapJob() {
  return gapJob;
}

function getSealedJob() {
  return sealedJob;
}

async function runGapRefreshJob({ kind, mode, staleDays, limit, actor, coverageRows, runSet }) {
  if (gapJob?.status === "running") {
    throw new Error("A gap refresh job is already running");
  }
  const targets = pickGapTargets(coverageRows, { kind, mode, staleDays, limit });
  if (!targets.length) {
    return { ok: true, message: "No matching sets to refresh", targets: [] };
  }
  const history = await pushJobHistory({
    kind: "gap-refresh",
    label: `${kind} ${mode}`,
    actor: actor || "admin",
    targetCount: targets.length,
    setCodes: targets.map((t) => t.setCode)
  });
  gapJob = {
    status: "running",
    kind,
    mode,
    startedAt: nowIso(),
    actor: actor || "admin",
    total: targets.length,
    done: 0,
    ok: 0,
    fail: 0,
    currentSet: "",
    jobId: history.id
  };
  void (async () => {
    for (const row of targets) {
      if (gapJob?.stopRequested) break;
      gapJob.currentSet = row.setCode;
      try {
        await runSet(row.setCode, row.setName || "");
        gapJob.ok += 1;
      } catch {
        gapJob.fail += 1;
      }
      gapJob.done += 1;
    }
    const stopped = Boolean(gapJob?.stopRequested);
    const summary = {
      status: stopped ? "stopped" : gapJob.fail ? "error" : "done",
      ok: gapJob.ok,
      fail: gapJob.fail,
      done: gapJob.done,
      total: gapJob.total
    };
    await finishJobHistory(history.id, summary);
    gapJob = { ...gapJob, status: summary.status, finishedAt: nowIso(), currentSet: "" };
  })();
  return { ok: true, started: true, targets, job: gapJob };
}

function stopGapRefreshJob() {
  if (!gapJob || gapJob.status !== "running") return { ok: false, error: "No gap job running" };
  gapJob.stopRequested = true;
  return { ok: true, job: gapJob };
}

async function runSealedRefreshJob({ actor, syncFn, downloadImages }) {
  if (sealedJob?.status === "running") {
    throw new Error("Sealed refresh already running");
  }
  const history = await pushJobHistory({
    kind: "sealed-refresh",
    label: "Sealed catalog sync",
    actor: actor || "admin"
  });
  sealedJob = {
    status: "running",
    startedAt: nowIso(),
    actor: actor || "admin",
    jobId: history.id,
    detail: "Starting sealed catalog sync…"
  };
  void (async () => {
    try {
      sealedJob.detail = "Scraping PriceCharting sealed catalog…";
      const result = await syncFn();
      if (downloadImages) {
        sealedJob.detail = "Downloading sealed images…";
        await downloadImages();
      }
      sealedJob = {
        ...sealedJob,
        status: "done",
        finishedAt: nowIso(),
        detail: "Sealed catalog refreshed",
        result: {
          setCount: result?.setCount,
          productCount: result?.productCount,
          generatedAt: result?.generatedAt
        }
      };
      await finishJobHistory(history.id, { status: "done", result: sealedJob.result });
    } catch (err) {
      sealedJob = {
        ...sealedJob,
        status: "error",
        finishedAt: nowIso(),
        detail: err.message || "Sealed refresh failed"
      };
      await finishJobHistory(history.id, { status: "error", error: err.message || "failed" });
    }
  })();
  return { ok: true, started: true, job: sealedJob };
}

async function buildSealedAdminSummary(readSealedCatalog) {
  const catalog = await readSealedCatalog();
  const byCode = catalog?.byCode && typeof catalog.byCode === "object" ? catalog.byCode : {};
  let priced = 0;
  let products = 0;
  let missingPrice = 0;
  let missingImage = 0;
  for (const row of Object.values(byCode)) {
    const list = Array.isArray(row?.products) ? row.products : [];
    for (const p of list) {
      products += 1;
      if (Number(p?.ungradedPrice) > 0) priced += 1;
      else missingPrice += 1;
      if (!String(p?.imageUrl || p?.remoteImageUrl || "").trim()) missingImage += 1;
    }
  }
  return {
    ok: true,
    generatedAt: catalog?.generatedAt || null,
    setCount: catalog?.setCount || Object.keys(byCode).length,
    productCount: catalog?.productCount || products,
    priced,
    missingPrice,
    missingImage,
    job: sealedJob
  };
}

async function buildImageReport(cardImageDir, sets) {
  const rows = [];
  for (const set of sets || []) {
    const code = String(set.setCode || "").trim().toUpperCase();
    if (!code) continue;
    const dir = path.join(cardImageDir, code);
    let onDisk = 0;
    try {
      const files = await fsp.readdir(dir);
      onDisk = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
    } catch {
      onDisk = 0;
    }
    const expected = Number(set.cardCount) || 0;
    rows.push({
      setCode: code,
      setName: set.setName || code,
      expected,
      onDisk,
      missing: Math.max(0, expected - onDisk),
      coverage: expected ? Math.min(100, Math.round((onDisk / expected) * 100)) : null
    });
  }
  rows.sort((a, b) => (b.missing || 0) - (a.missing || 0) || String(a.setName).localeCompare(String(b.setName)));
  const missingSets = rows.filter((r) => r.missing > 0 || (r.expected > 0 && r.onDisk === 0));
  return {
    ok: true,
    at: nowIso(),
    summary: {
      setCount: rows.length,
      setsWithGaps: missingSets.length,
      missingImages: missingSets.reduce((sum, r) => sum + (r.missing || 0), 0)
    },
    rows: missingSets.slice(0, 80),
    tip: "Upload gaps with: npm run upload:card-images -- --set CODE (after filling local backend/data/card-images)"
  };
}

function initAdminOps(hooks = {}) {
  opsHooks = hooks;
  loadFlags().catch(() => {});
  loadSchedules().catch(() => {});
  loadMetricsFromDisk().catch(() => {});
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(() => {
    void tickSchedules().catch(() => {});
  }, 60_000);
  setTimeout(() => {
    void tickSchedules().catch(() => {});
  }, 15_000);
}

async function tickSchedules() {
  if (!opsHooks) return;
  const schedules = await loadSchedules();
  const hour = new Date().getUTCHours();
  const today = new Date().toISOString().slice(0, 10);

  async function maybeRun(key, hourUtc, runner) {
    const cfg = schedules[key];
    if (!cfg?.enabled) return;
    if (Number(cfg.hourUtc) !== hour) return;
    const last = String(cfg.lastRunAt || "").slice(0, 10);
    if (last === today) return;
    cfg.lastRunAt = nowIso();
    await saveSchedules({ [key]: cfg });
    await runner(cfg);
  }

  await maybeRun("restockNightly", schedules.restockNightly.hourUtc, async () => {
    if (typeof opsHooks.runRestockRefresh === "function") {
      await opsHooks.runRestockRefresh();
    }
  });
  await maybeRun("tcgGapDaily", schedules.tcgGapDaily.hourUtc, async (cfg) => {
    if (typeof opsHooks.runGapRefresh === "function") {
      await opsHooks.runGapRefresh({
        kind: "tcg",
        mode: "stale",
        staleDays: cfg.staleDays || 14,
        limit: cfg.limit || 12,
        actor: "schedule"
      });
    }
  });
  await maybeRun("pcGapDaily", schedules.pcGapDaily.hourUtc, async (cfg) => {
    if (typeof opsHooks.runGapRefresh === "function") {
      await opsHooks.runGapRefresh({
        kind: "pricecharting",
        mode: "stale",
        staleDays: cfg.staleDays || 21,
        limit: cfg.limit || 12,
        actor: "schedule"
      });
    }
  });
}

module.exports = {
  DEFAULT_FLAGS,
  DEFAULT_SCHEDULES,
  FLAGS_FILE,
  SCHEDULES_FILE,
  JOBS_FILE,
  METRICS_FILE,
  DATA_DIR,
  initAdminOps,
  loadFlags,
  saveFlags,
  getFeatureFlag,
  loadSchedules,
  saveSchedules,
  loadJobHistory,
  pushJobHistory,
  finishJobHistory,
  recordMetric,
  recordMetricAndPersist,
  getMetricsSnapshot,
  buildHealthSnapshot,
  buildCoverageRows,
  buildIntegrityReport,
  pickGapTargets,
  runGapRefreshJob,
  stopGapRefreshJob,
  getGapJob,
  runSealedRefreshJob,
  getSealedJob,
  buildSealedAdminSummary,
  buildImageReport,
  daysAgoIso,
  isStale,
  fileMeta,
  dirFileCount
};
