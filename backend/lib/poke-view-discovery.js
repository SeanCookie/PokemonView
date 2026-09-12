"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { writeJsonAtomic } = require("./write-json-atomic");
const { forEachCachedChartEntry } = require("./pricecharting-market-history-cache");
const { forEachCachedCardDetailsEntry } = require("./pricecharting-card-details-cache");

const DATA_DIR = path.join(__dirname, "..", "data");
const SNAPSHOT_FILE = path.join(DATA_DIR, "poke-view-discovery.json");
const TRENDING_FILE = path.join(DATA_DIR, "poke-view-discovery-trending.json");
const SET_CARD_LISTS_FILE = path.join(DATA_DIR, "set-card-lists.json");
const SEALED_BY_SET_FILE = path.join(DATA_DIR, "pricecharting-sealed-by-set.json");

const SNAPSHOT_VERSION = 2;
const SNAPSHOT_TTL_MS = 1000 * 60 * 60 * 6;
const TRENDING_MAX_KEYS = 5000;
const SOURCE_PRIORITY = {
  chart: 3,
  "sealed-series": 2,
  "sold-listings": 1
};

const RANGE_DAYS = {
  "1D": 1,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "90D": 90,
  "1Y": 365,
  YTD: 0
};

let snapshotCache = null;
let snapshotBuiltAt = 0;
let snapshotBuildPromise = null;
let cardListsCache = null;
let sealedTitleCache = null;
let trendingState = { version: 1, savedAt: null, views: {} };
let trendingLoaded = false;
let trendingPersistTimer = null;

function clampNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function startOfUtcYearMs(ms = Date.now()) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), 0, 1);
}

function chartPointsFromEntry(value) {
  const chartData = value?.chartData;
  if (!chartData || typeof chartData !== "object") return [];
  const raw = Array.isArray(chartData.used)
    ? chartData.used
    : Array.isArray(chartData.new)
      ? chartData.new
      : Array.isArray(chartData.cib)
        ? chartData.cib
        : [];
  const points = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const ts = Number(row[0]);
    const pennies = Number(row[1]);
    if (!Number.isFinite(ts) || !Number.isFinite(pennies) || pennies <= 0) continue;
    points.push({ ts, price: Number((pennies / 100).toFixed(2)) });
  }
  points.sort((a, b) => a.ts - b.ts);
  return points;
}

function parseSoldListingDateMs(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(ts) ? ts : null;
  }
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
}

function collectSoldListings(value) {
  if (Array.isArray(value?.soldListings) && value.soldListings.length) {
    return value.soldListings;
  }
  const out = [];
  for (const guide of Array.isArray(value?.soldGuides) ? value.soldGuides : []) {
    if (Array.isArray(guide?.listings)) out.push(...guide.listings);
  }
  return out;
}

function pointsFromSoldListings(value) {
  const byDay = new Map();
  for (const listing of collectSoldListings(value)) {
    if (!listing || typeof listing !== "object") continue;
    const title = String(listing.title || "").toLowerCase();
    if (/\b(psa|cgc|bgs|sgc|graded|gem\s*mint\s*10)\b/.test(title)) continue;
    if (/\b(lot|lots|x\d+|play\s*set)\b/.test(title)) continue;
    const ts = parseSoldListingDateMs(listing.date || listing.soldDate);
    const price = Number(listing.price);
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) continue;
    const day = Math.floor(ts / 86400000) * 86400000;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(price);
  }
  const points = [];
  for (const [ts, prices] of byDay.entries()) {
    if (!prices.length) continue;
    const sorted = prices.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    points.push({ ts, price: Number(median.toFixed(2)) });
  }
  points.sort((a, b) => a.ts - b.ts);
  if (points.length < 3) return [];
  const spanDays = (points[points.length - 1].ts - points[0].ts) / 86400000;
  if (spanDays < 7) return [];
  return points;
}

function pickSealedSeries(value) {
  const series = Array.isArray(value?.series) ? value.series : [];
  if (!series.length) return null;
  const scored = series
    .map((row) => {
      const points = Array.isArray(row?.points) ? row.points : [];
      const variant = String(row?.variantKey || row?.label || "").toLowerCase();
      let score = points.length;
      if (variant.includes("ungraded") || variant === "used" || variant.includes("loose")) score += 1000;
      if (variant.includes("cib") || variant.includes("new")) score += 100;
      return { row, score, points };
    })
    .filter((entry) => entry.points.length >= 2)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.row || null;
}

function pointsFromSealedSeries(value) {
  const series = pickSealedSeries(value);
  if (!series) return [];
  const points = [];
  for (const row of Array.isArray(series.points) ? series.points : []) {
    if (!row || typeof row !== "object") continue;
    const ts = Number(row.ts) || parseSoldListingDateMs(row.date);
    const price = Number(row.price);
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) continue;
    points.push({ ts, price: Number(price.toFixed(2)) });
  }
  points.sort((a, b) => a.ts - b.ts);
  return points;
}

function parseDetailsCacheKey(key) {
  const raw = String(key || "").trim();
  const sealedMatch = raw.match(/^([A-Za-z0-9]+):sealed:(\d+)$/i);
  if (sealedMatch) {
    return {
      kind: "sealed",
      setCode: sealedMatch[1].toUpperCase(),
      productId: sealedMatch[2],
      cardNo: ""
    };
  }
  const cardMatch = raw.match(/^([A-Za-z0-9]+):(.+)$/);
  if (!cardMatch) return null;
  return {
    kind: "single",
    setCode: cardMatch[1].toUpperCase(),
    cardNo: String(cardMatch[2] || "").trim(),
    productId: ""
  };
}

function filterPointsSince(points, startMs) {
  return points.filter((p) => p.ts >= startMs);
}

function computeDelta(points) {
  if (!Array.isArray(points) || points.length < 1) {
    return { last: null, change: null, changePct: null, startPrice: null };
  }
  const first = points[0].price;
  const last = points[points.length - 1].price;
  if (!Number.isFinite(last) || last <= 0) {
    return { last: null, change: null, changePct: null, startPrice: first };
  }
  if (points.length < 2 || !Number.isFinite(first) || first <= 0) {
    return { last, change: 0, changePct: 0, startPrice: first };
  }
  const change = Number((last - first).toFixed(2));
  const changePct = Number(((change / first) * 100).toFixed(2));
  return { last, change, changePct, startPrice: first };
}

function metricsForRange(points, rangeKey) {
  if (!Array.isArray(points) || !points.length) {
    return { last: null, change: null, changePct: null, startPrice: null };
  }
  if (!rangeKey || rangeKey === "ALL") return computeDelta(points);

  const now = Date.now();
  let startMs = 0;
  if (rangeKey === "YTD") {
    startMs = startOfUtcYearMs(now);
  } else {
    const days = RANGE_DAYS[rangeKey];
    if (!days) return computeDelta(points);
    startMs = now - days * 24 * 60 * 60 * 1000;
  }

  // Use price at/just before range start — never fall back to all-time first→last
  // when a sparse (monthly) series has zero points inside the window.
  let baseline = null;
  let lastPt = null;
  let firstInWindow = null;
  for (const p of points) {
    if (!Number.isFinite(p?.ts) || !Number.isFinite(p?.price)) continue;
    if (p.ts <= now) lastPt = p;
    if (p.ts <= startMs) baseline = p;
    if (!firstInWindow && p.ts >= startMs && p.ts <= now) firstInWindow = p;
  }
  if (!lastPt) return computeDelta([]);
  if (!baseline) baseline = firstInWindow || lastPt;
  if (baseline === lastPt) {
    return {
      last: lastPt.price,
      change: 0,
      changePct: 0,
      startPrice: baseline.price
    };
  }
  return computeDelta([baseline, lastPt]);
}

function averagePrice(points, days) {
  const now = Date.now();
  const startMs = now - days * 24 * 60 * 60 * 1000;
  const sliced = filterPointsSince(points, startMs);
  if (!sliced.length) return null;
  const sum = sliced.reduce((acc, p) => acc + p.price, 0);
  return Number((sum / sliced.length).toFixed(2));
}

function highPrice(points, days) {
  const now = Date.now();
  const startMs = now - days * 24 * 60 * 60 * 1000;
  const sliced = filterPointsSince(points, startMs);
  if (!sliced.length) return null;
  return Math.max(...sliced.map((p) => p.price));
}

function movingAverageAtEnd(points, windowDays) {
  const now = Date.now();
  const startMs = now - windowDays * 24 * 60 * 60 * 1000;
  const sliced = filterPointsSince(points, startMs);
  if (sliced.length < 2) return null;
  const sum = sliced.reduce((acc, p) => acc + p.price, 0);
  return Number((sum / sliced.length).toFixed(2));
}

async function loadCardListsLookup() {
  if (cardListsCache) return cardListsCache;
  try {
    const raw = await fsp.readFile(SET_CARD_LISTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const byCode = parsed?.byCode && typeof parsed.byCode === "object" ? parsed.byCode : parsed;
    cardListsCache = { byCode: byCode || {} };
  } catch {
    cardListsCache = { byCode: {} };
  }
  return cardListsCache;
}

async function loadSealedTitleLookup() {
  if (sealedTitleCache) return sealedTitleCache;
  const byProductId = new Map();
  try {
    const raw = await fsp.readFile(SEALED_BY_SET_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const byCode = parsed?.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {};
    for (const [setCode, entry] of Object.entries(byCode)) {
      const setName = String(entry?.name || entry?.setName || setCode).trim();
      for (const product of Array.isArray(entry?.products) ? entry.products : []) {
        const productId = String(product?.productId || "").trim();
        if (!productId) continue;
        byProductId.set(productId, {
          setCode: String(setCode || "").trim().toUpperCase(),
          setName,
          title: String(product?.title || product?.name || "").trim()
        });
      }
    }
  } catch {
    /* optional */
  }
  sealedTitleCache = byProductId;
  return sealedTitleCache;
}

function resolveCardMeta(setCode, cardNo, lookup) {
  const code = String(setCode || "").trim().toUpperCase();
  const no = String(cardNo || "").trim();
  const entry = lookup?.byCode?.[code];
  const setName = String(entry?.sourceTitle || entry?.setName || code).trim();
  const cards = entry?.cards && typeof entry.cards === "object" ? entry.cards : {};
  const cardName =
    String(cards[no] || cards[String(Number(no))] || "").trim() ||
    String(entry?.cardNames?.[no] || "").trim();
  const label = cardName
    ? `${cardName} (${setName}${no ? ` #${no}` : ""})`
    : `${code}${no ? ` #${no}` : ""}`;
  return { setName, cardName, label };
}

function resolveSealedMeta(setCode, productId, value, lookup, sealedTitles) {
  const code = String(setCode || "").trim().toUpperCase();
  const id = String(productId || "").trim();
  const fromCatalog = sealedTitles?.get(id) || null;
  const setEntry = lookup?.byCode?.[code];
  const setName =
    String(fromCatalog?.setName || setEntry?.sourceTitle || setEntry?.setName || code).trim() || code;
  const series = pickSealedSeries(value);
  const cardName =
    String(fromCatalog?.title || series?.label || value?.productTitle || value?.title || "").trim() ||
    `Sealed ${id}`;
  const label = `${cardName} (${setName})`;
  return { setName, cardName, label };
}

function buildItemRecordFromPoints({
  id,
  kind = "single",
  setCode,
  cardNo = "",
  setName = "",
  cardName = "",
  label = "",
  productId = "",
  productUrl = "",
  points,
  source = "chart"
} = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const code = String(setCode || "").trim().toUpperCase();
  if (!code) return null;
  if (kind !== "sealed" && !String(cardNo || "").trim()) return null;

  const metrics = {};
  for (const key of Object.keys(RANGE_DAYS)) {
    metrics[key] = metricsForRange(points, key);
  }

  const last = metrics["1M"]?.last ?? points[points.length - 1].price;
  const avg90 = averagePrice(points, 90);
  const high365 = highPrice(points, 365);
  const ma30 = movingAverageAtEnd(points, 30);
  const ma90 = movingAverageAtEnd(points, 90);

  let undervaluedScore = null;
  let undervaluedReason = "";
  if (Number.isFinite(last) && Number.isFinite(avg90) && avg90 > 0) {
    const ratio = last / avg90;
    undervaluedScore = Number((1 - ratio).toFixed(4));
    if (ratio <= 0.85) {
      undervaluedReason = `${Math.round((1 - ratio) * 100)}% below 90-day avg`;
    }
  }
  if (
    (source === "sold-listings" || source === "sealed-series") &&
    (!Number.isFinite(last) || last < 0.5)
  ) {
    undervaluedScore = null;
    undervaluedReason = "";
  }

  // Comp/series caches can spike from sparse or bad points; drop absurd range moves first.
  if (source === "sold-listings" || source === "sealed-series") {
    for (const key of Object.keys(metrics)) {
      const pct = metrics[key]?.changePct;
      const start = metrics[key]?.startPrice;
      const end = metrics[key]?.last;
      if (!Number.isFinite(pct)) continue;
      const absurd =
        Math.abs(pct) > 250 ||
        (Number.isFinite(start) && start < 0.5 && Math.abs(pct) > 150) ||
        (Number.isFinite(end) && end > 5000 && Number.isFinite(start) && end / start > 20);
      if (absurd) {
        metrics[key] = { ...metrics[key], change: null, changePct: null };
      }
    }
  }

  let breakoutScore = null;
  let breakoutReason = "";
  const monthPct = Number(metrics["1M"]?.changePct);
  if (Number.isFinite(last) && Number.isFinite(high365) && high365 > 0) {
    const nearHigh = last >= high365 * 0.95;
    const maCross = Number.isFinite(ma30) && Number.isFinite(ma90) && ma30 > ma90 && last > ma30;
    const monthUp = monthPct > 5;
    if (nearHigh && monthUp) {
      breakoutScore = monthPct;
      breakoutReason = `Near 52w high, up ${monthPct}% (1M)`;
    } else if (maCross && monthUp) {
      breakoutScore = monthPct;
      breakoutReason = `30d MA above 90d MA, up ${monthPct}% (1M)`;
    }
  }

  const hasAnyMove = Object.values(metrics).some((m) => Number.isFinite(m?.changePct));
  if (!hasAnyMove && !Number.isFinite(undervaluedScore) && !Number.isFinite(breakoutScore)) {
    return null;
  }

  return {
    id: String(id || "").trim(),
    kind: kind === "sealed" ? "sealed" : "single",
    setCode: code,
    cardNo: kind === "sealed" ? "" : String(cardNo || "").trim(),
    setName: String(setName || code).trim(),
    cardName: String(cardName || "").trim(),
    label: String(label || "").trim() || String(id || code).trim(),
    productId: String(productId || "").trim(),
    productUrl: String(productUrl || "").trim(),
    last,
    metrics,
    undervaluedScore,
    undervaluedReason,
    breakoutScore,
    breakoutReason,
    pointCount: points.length,
    source
  };
}

function buildItemRecord(value, lookup) {
  const setCode = String(value?.setCode || "").trim().toUpperCase();
  const cardNo = String(value?.cardNo || "").trim();
  if (!setCode || !cardNo) return null;
  const points = chartPointsFromEntry(value);
  if (points.length < 2) return null;
  const meta = resolveCardMeta(setCode, cardNo, lookup);
  return buildItemRecordFromPoints({
    id: `${setCode}:${cardNo}`,
    kind: "single",
    setCode,
    cardNo,
    setName: meta.setName,
    cardName: meta.cardName,
    label: meta.label,
    productId: String(value?.productId || "").trim(),
    productUrl: String(value?.productUrl || "").trim(),
    points,
    source: "chart"
  });
}

function upsertDiscoveryItem(byId, row) {
  if (!row?.id) return;
  const existing = byId.get(row.id);
  if (!existing) {
    byId.set(row.id, row);
    return;
  }
  const nextPriority = SOURCE_PRIORITY[row.source] || 0;
  const prevPriority = SOURCE_PRIORITY[existing.source] || 0;
  if (nextPriority > prevPriority) {
    byId.set(row.id, row);
    return;
  }
  if (nextPriority === prevPriority && Number(row.pointCount || 0) > Number(existing.pointCount || 0)) {
    byId.set(row.id, row);
  }
}

function buildHeatBySet(items, rangeKey = "1M") {
  const bySet = new Map();
  for (const item of items) {
    const code = item.setCode;
    if (!code) continue;
    const pct = item.metrics?.[rangeKey]?.changePct;
    if (!Number.isFinite(pct)) continue;
    if (!bySet.has(code)) {
      bySet.set(code, { setCode: code, setName: item.setName || code, values: [] });
    }
    bySet.get(code).values.push(pct);
  }
  const rows = [];
  for (const row of bySet.values()) {
    const sorted = row.values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    rows.push({
      setCode: row.setCode,
      setName: row.setName,
      medianChangePct: Number(median.toFixed(2)),
      cardCount: sorted.length,
      reason: `Median ${median >= 0 ? "+" : ""}${median.toFixed(1)}% (${rangeKey}) across ${sorted.length} tracked cards`
    });
  }
  rows.sort((a, b) => b.medianChangePct - a.medianChangePct);
  return rows;
}

async function buildDiscoverySnapshot({ force = false } = {}) {
  if (
    !force &&
    snapshotCache &&
    snapshotBuiltAt &&
    Date.now() - snapshotBuiltAt < SNAPSHOT_TTL_MS
  ) {
    return snapshotCache;
  }
  if (snapshotBuildPromise) return snapshotBuildPromise;

  snapshotBuildPromise = (async () => {
    const lookup = await loadCardListsLookup();
    const sealedTitles = await loadSealedTitleLookup();
    const byId = new Map();

    forEachCachedChartEntry((_key, value) => {
      const row = buildItemRecord(value, lookup);
      if (row) upsertDiscoveryItem(byId, row);
    });

    forEachCachedCardDetailsEntry((key, value) => {
      const parsed = parseDetailsCacheKey(key);
      if (!parsed) return;

      if (parsed.kind === "sealed") {
        const points = pointsFromSealedSeries(value);
        if (points.length < 2) return;
        const meta = resolveSealedMeta(parsed.setCode, parsed.productId, value, lookup, sealedTitles);
        const row = buildItemRecordFromPoints({
          id: `sealed:${parsed.productId}`,
          kind: "sealed",
          setCode: parsed.setCode,
          cardNo: "",
          setName: meta.setName,
          cardName: meta.cardName,
          label: meta.label,
          productId: parsed.productId,
          productUrl: String(value?.productUrl || "").trim(),
          points,
          source: "sealed-series"
        });
        if (row) upsertDiscoveryItem(byId, row);
        return;
      }

      const existing = byId.get(`${parsed.setCode}:${parsed.cardNo}`);
      if (existing && (SOURCE_PRIORITY[existing.source] || 0) >= SOURCE_PRIORITY.chart) {
        return;
      }
      const points = pointsFromSoldListings(value);
      if (points.length < 2) return;
      const meta = resolveCardMeta(parsed.setCode, parsed.cardNo, lookup);
      const row = buildItemRecordFromPoints({
        id: `${parsed.setCode}:${parsed.cardNo}`,
        kind: "single",
        setCode: parsed.setCode,
        cardNo: parsed.cardNo,
        setName: meta.setName,
        cardName: meta.cardName,
        label: meta.label,
        productId: String(value?.productId || "").trim(),
        productUrl: String(value?.productUrl || "").trim(),
        points,
        source: "sold-listings"
      });
      if (row) upsertDiscoveryItem(byId, row);
    });

    const items = [...byId.values()];
    const payload = {
      version: SNAPSHOT_VERSION,
      builtAt: new Date().toISOString(),
      sourceEntries: items.length,
      sourceBreakdown: {
        chart: items.filter((i) => i.source === "chart").length,
        sealedSeries: items.filter((i) => i.source === "sealed-series").length,
        soldListings: items.filter((i) => i.source === "sold-listings").length
      },
      items,
      heatBySet: {
        "1M": buildHeatBySet(items, "1M"),
        "1Y": buildHeatBySet(items, "1Y")
      }
    };

    snapshotCache = payload;
    snapshotBuiltAt = Date.now();
    try {
      await writeJsonAtomic(SNAPSHOT_FILE, payload);
    } catch {
      /* disk optional */
    }
    return payload;
  })();

  try {
    return await snapshotBuildPromise;
  } finally {
    snapshotBuildPromise = null;
  }
}

async function loadPersistedDiscoverySnapshot() {
  if (snapshotCache) return snapshotCache;
  try {
    const raw = await fsp.readFile(SNAPSHOT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Number(parsed?.version) === SNAPSHOT_VERSION && Array.isArray(parsed?.items)) {
      snapshotCache = parsed;
      snapshotBuiltAt = Date.parse(parsed.builtAt) || Date.now();
      return parsed;
    }
  } catch {
    /* no file */
  }
  return null;
}

async function ensureDiscoverySnapshot({ force = false } = {}) {
  if (!force) {
    const persisted = await loadPersistedDiscoverySnapshot();
    if (persisted && Date.now() - snapshotBuiltAt < SNAPSHOT_TTL_MS) {
      return persisted;
    }
  }
  return buildDiscoverySnapshot({ force });
}

function normalizeRange(raw) {
  const key = String(raw || "1M").trim().toUpperCase();
  if (key === "ALL") return "1Y";
  return RANGE_DAYS[key] != null || key === "YTD" ? key : "1M";
}

function normalizeKind(raw) {
  const k = String(raw || "all").trim().toLowerCase();
  if (k === "cards" || k === "card" || k === "single") return "cards";
  if (k === "sealed") return "sealed";
  return "all";
}

function rowForTab(item, tab, rangeKey) {
  const metrics = item.metrics?.[rangeKey] || item.metrics?.["1M"] || {};
  const last = metrics.last ?? item.last;
  const change = metrics.change;
  const changePct = metrics.changePct;
  let reason = "";
  if (tab === "movers" || tab === "leaders") {
    reason = `${changePct >= 0 ? "Up" : "Down"} ${Math.abs(changePct).toFixed(1)}% (${rangeKey})`;
  } else if (tab === "undervalued") {
    reason = item.undervaluedReason || "Below recent average";
  } else if (tab === "breakouts") {
    reason = item.breakoutReason || "Momentum breakout";
  } else {
    reason = `${changePct >= 0 ? "+" : ""}${Number(changePct || 0).toFixed(1)}% (${rangeKey})`;
  }
  return {
    id: item.id,
    kind: item.kind,
    setCode: item.setCode,
    cardNo: item.cardNo,
    setName: item.setName,
    cardName: item.cardName,
    label: item.label,
    productId: item.productId,
    productUrl: item.productUrl,
    last,
    change,
    changePct,
    reason
  };
}

function filterByKind(items, kind) {
  if (kind === "cards") return items.filter((i) => i.kind !== "sealed");
  if (kind === "sealed") return items.filter((i) => i.kind === "sealed");
  return items;
}

async function getDiscoveryResults({
  tab = "movers",
  range = "1M",
  direction = "up",
  kind = "all",
  limit = 40
} = {}) {
  const snapshot = await ensureDiscoverySnapshot();
  const rangeKey = normalizeRange(range);
  const kindNorm = normalizeKind(kind);
  const max = Math.min(Math.max(Number(limit) || 40, 5), 100);
  const tabNorm = String(tab || "movers").trim().toLowerCase();

  if (tabNorm === "heat") {
    const heatRows = snapshot?.heatBySet?.[rangeKey] || snapshot?.heatBySet?.["1M"] || [];
    return {
      tab: "heat",
      range: rangeKey,
      builtAt: snapshot?.builtAt || null,
      sourceEntries: snapshot?.sourceEntries || 0,
      rows: heatRows.slice(0, max)
    };
  }

  let items = filterByKind(Array.isArray(snapshot?.items) ? snapshot.items : [], kindNorm);

  if (tabNorm === "undervalued") {
    items = items
      .filter((i) => Number.isFinite(i.undervaluedScore) && i.undervaluedScore > 0.05)
      .sort((a, b) => b.undervaluedScore - a.undervaluedScore);
  } else if (tabNorm === "breakouts") {
    items = items
      .filter((i) => Number.isFinite(i.breakoutScore))
      .sort((a, b) => b.breakoutScore - a.breakoutScore);
  } else {
    const dir = String(direction || "up").trim().toLowerCase();
    items = items
      .filter((i) => Number.isFinite(i.metrics?.[rangeKey]?.changePct))
      .sort((a, b) => {
        const av = a.metrics[rangeKey].changePct;
        const bv = b.metrics[rangeKey].changePct;
        return dir === "down" ? av - bv : bv - av;
      });
  }

  const rows = items.slice(0, max).map((item) => rowForTab(item, tabNorm, rangeKey));
  return {
    tab: tabNorm,
    range: rangeKey,
    direction: String(direction || "up").trim().toLowerCase(),
    kind: kindNorm,
    builtAt: snapshot?.builtAt || null,
    sourceEntries: snapshot?.sourceEntries || 0,
    rows
  };
}

async function loadTrendingState() {
  if (trendingLoaded) return trendingState;
  trendingLoaded = true;
  try {
    const raw = await fsp.readFile(TRENDING_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      trendingState = {
        version: 1,
        savedAt: parsed.savedAt || null,
        views: parsed.views && typeof parsed.views === "object" ? parsed.views : {}
      };
    }
  } catch {
    /* no file */
  }
  return trendingState;
}

function schedulePersistTrending() {
  if (trendingPersistTimer) return;
  trendingPersistTimer = setTimeout(() => {
    trendingPersistTimer = null;
    void persistTrendingNow();
  }, 800);
}

async function persistTrendingNow() {
  trendingState.savedAt = new Date().toISOString();
  try {
    await writeJsonAtomic(TRENDING_FILE, trendingState);
  } catch {
    /* optional */
  }
}

function trendingKey({ setCode = "", cardNo = "", productId = "", kind = "single" } = {}) {
  if (String(kind).toLowerCase() === "sealed" && productId) {
    return `sealed:${String(productId).trim()}`;
  }
  const code = String(setCode || "").trim().toUpperCase();
  const no = String(cardNo || "").trim();
  if (code && no) return `${code}:${no}`;
  if (productId) return `pid:${String(productId).trim()}`;
  return "";
}

async function recordDiscoveryView(payload = {}) {
  await loadTrendingState();
  const key = trendingKey(payload);
  if (!key) return { ok: false, error: "Missing identity" };
  const prev = trendingState.views[key] || { count: 0, label: "", kind: payload.kind || "single" };
  prev.count = Number(prev.count || 0) + 1;
  prev.lastAt = new Date().toISOString();
  if (payload.label) prev.label = String(payload.label).trim();
  if (payload.setCode) prev.setCode = String(payload.setCode).trim().toUpperCase();
  if (payload.cardNo) prev.cardNo = String(payload.cardNo).trim();
  if (payload.setName) prev.setName = String(payload.setName).trim();
  if (payload.cardName) prev.cardName = String(payload.cardName).trim();
  if (payload.productId) prev.productId = String(payload.productId).trim();
  if (payload.kind) prev.kind = String(payload.kind).trim();
  trendingState.views[key] = prev;

  const keys = Object.keys(trendingState.views);
  if (keys.length > TRENDING_MAX_KEYS) {
    keys
      .sort(
        (a, b) =>
          Date.parse(trendingState.views[a]?.lastAt || 0) -
          Date.parse(trendingState.views[b]?.lastAt || 0)
      )
      .slice(0, keys.length - TRENDING_MAX_KEYS)
      .forEach((k) => delete trendingState.views[k]);
  }

  schedulePersistTrending();
  return { ok: true, key, count: prev.count };
}

async function getTrendingResults({ limit = 40, kind = "all" } = {}) {
  await loadTrendingState();
  const kindNorm = normalizeKind(kind);
  const max = Math.min(Math.max(Number(limit) || 40, 5), 100);
  let rows = Object.entries(trendingState.views).map(([key, row]) => ({
    id: key,
    kind: row.kind || "single",
    setCode: row.setCode || "",
    cardNo: row.cardNo || "",
    setName: row.setName || "",
    cardName: row.cardName || "",
    label: row.label || key,
    productId: row.productId || "",
    views: Number(row.count || 0),
    lastAt: row.lastAt || null,
    reason: `${row.count || 0} recent views`
  }));
  if (kindNorm === "cards") rows = rows.filter((r) => r.kind !== "sealed");
  if (kindNorm === "sealed") rows = rows.filter((r) => r.kind === "sealed");
  rows.sort((a, b) => b.views - a.views || Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return {
    tab: "trending",
    builtAt: trendingState.savedAt,
    rows: rows.slice(0, max)
  };
}

function getDiscoveryMeta() {
  return {
    tabs: ["watchlist", "movers", "leaders", "undervalued", "breakouts", "heat", "alerts", "trending"],
    ranges: ["1D", "1W", "1M", "3M", "1Y", "YTD"],
    kinds: ["all", "cards", "sealed"],
    snapshotBuiltAt: snapshotCache?.builtAt || null,
    snapshotEntryCount: snapshotCache?.sourceEntries || 0,
    trendingCount: Object.keys(trendingState.views || {}).length
  };
}

module.exports = {
  ensureDiscoverySnapshot,
  buildDiscoverySnapshot,
  getDiscoveryResults,
  getTrendingResults,
  recordDiscoveryView,
  getDiscoveryMeta,
  normalizeRange,
  normalizeKind
};
