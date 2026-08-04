const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const {
  resolveConsoleSlugCandidates,
  loadSetSlugsByCode,
  getConsoleIndex,
  buildPriceChartingConsoleUrl,
  buildPriceChartingProductUrl
} = require("./pricecharting-market-history");
const { writeJsonAtomic } = require("./write-json-atomic");

const DATA_DIR = path.join(__dirname, "..", "data");
const SEALED_CATALOG_FILE = path.join(DATA_DIR, "pricecharting-sealed-by-set.json");
const SEALED_IMAGE_DIR = path.join(DATA_DIR, "pricecharting-sealed-images");
const INDEX_CACHE_DIR = path.join(DATA_DIR, "pricecharting-index-cache");

const PC_FETCH_MIN_INTERVAL_MS = 1100;
let lastFetchMs = 0;

const SEALED_TYPE_ORDER = [
  "booster-box",
  "elite-trainer-box",
  "booster-bundle",
  "ultra-premium-collection",
  "collection-box",
  "build-and-battle",
  "blister",
  "tin",
  "booster-pack",
  "other"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(text = "") {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseMoney(raw = "") {
  const n = Number(String(raw || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}

function isCardProductTitle(title = "") {
  return /#\s*[A-Za-z0-9]/.test(String(title || ""));
}

function isSealedProduct(title = "", gameSlug = "") {
  const name = String(title || "").trim();
  const slug = String(gameSlug || "").trim();
  if (!name && !slug) return false;
  if (isCardProductTitle(name)) return false;
  const hay = `${name} ${slug}`.toLowerCase();
  return /booster|elite\s*trainer|\betb\b|bundle|collection|ultra\s*premium|\bupc\b|\btin\b|blister|display|stadium|premium|build\s*(&|and)\s*battle|illustration|poster|tech\s*sticker|checklane|theme\s*deck|battle\s*deck|league\s*battle|trainer\s*toolkit|pin\s*collection|figure\s*collection|special\s*collection|mini\s*tin|stacking|surprise\s*box|advent|calendar|gift\s*box|binder|album|\bcase\b|sleeved|half\s*booster|pack\s*art|trophy|deck\s*box|playmat|accessory/i.test(
    hay
  );
}

function classifySealedProduct(title = "", gameSlug = "") {
  const hay = `${title} ${gameSlug}`.toLowerCase();
  if (/ultra\s*premium|\bupc\b/.test(hay)) return "ultra-premium-collection";
  if (/elite\s*trainer|\betb\b/.test(hay)) return "elite-trainer-box";
  if (/booster\s*box|half\s*booster\s*box|display\s*box/.test(hay)) return "booster-box";
  if (/booster\s*bundle|bundle\s*display/.test(hay)) return "booster-bundle";
  if (/build\s*(&|and)\s*battle/.test(hay)) return "build-and-battle";
  if (/\btin\b|mini\s*tin|stacking/.test(hay)) return "tin";
  if (/blister/.test(hay)) return "blister";
  if (/collection|illustration|poster|pin\s*collection|premium\s*collection|special\s*collection|figure\s*collection|binder/.test(hay)) {
    return "collection-box";
  }
  if (/booster\s*pack|sleeved\s*booster/.test(hay)) return "booster-pack";
  return "other";
}

function sealedTypeSortKey(type = "") {
  const idx = SEALED_TYPE_ORDER.indexOf(String(type || "other"));
  return idx === -1 ? SEALED_TYPE_ORDER.length : idx;
}

function upgradeImageUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw) return "";
  // Console tables use /60.jpg; product pages expose /240.jpg and /1600.jpg.
  return raw.replace(/\/(?:60|160)\.(jpg|jpeg|png|webp)$/i, "/240.$1");
}

function localSealedImageUrl(productId = "") {
  const id = String(productId || "").trim();
  if (!id) return "";
  return `/pricecharting-sealed/${id}.jpg`;
}

async function rateLimitFetch() {
  const elapsed = Date.now() - lastFetchMs;
  if (elapsed < PC_FETCH_MIN_INTERVAL_MS) {
    await sleep(PC_FETCH_MIN_INTERVAL_MS - elapsed);
  }
  lastFetchMs = Date.now();
}

async function fetchConsoleHtml(consoleSlug = "") {
  const slug = String(consoleSlug || "").trim();
  if (!slug) return "";
  await rateLimitFetch();
  const response = await fetch(buildPriceChartingConsoleUrl(slug), {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    },
    redirect: "follow"
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`PriceCharting console failed (${response.status}) for ${slug}`);
  }
  if (!text || /Page Not Found|404 Not Found/i.test(text.slice(0, 1200))) {
    return "";
  }
  return text;
}

function parseSealedProductsFromConsoleHtml(consoleSlug, html) {
  const slug = String(consoleSlug || "").trim();
  const text = String(html || "");
  const products = [];
  const seen = new Set();
  const rowRe = /<tr\b[^>]*\bid="product-(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(text))) {
    const productId = String(rowMatch[1] || "").trim();
    const rowHtml = rowMatch[2] || "";
    const linkMatch = rowHtml.match(
      /<td class="title"[^>]*>\s*<a href="\/game\/[^/]+\/([^"]+)">([^<]+)<\/a>/i
    );
    if (!linkMatch) continue;
    const gameSlug = decodeHtmlEntities(linkMatch[1] || "").trim();
    const title = decodeHtmlEntities(linkMatch[2] || "").trim();
    if (!productId || !gameSlug || !title) continue;
    if (!isSealedProduct(title, gameSlug)) continue;
    if (seen.has(productId)) continue;
    seen.add(productId);

    const imgMatch = rowHtml.match(/<img class="photo"[^>]*src="([^"]+)"/i);
    const usedMatch = rowHtml.match(
      /<td class="price numeric used_price">\s*<span class="js-price">([^<]*)<\/span>/i
    );
    const imageUrl = upgradeImageUrl(decodeHtmlEntities(imgMatch ? imgMatch[1] : ""));
    const ungradedPrice = parseMoney(usedMatch ? usedMatch[1] : "");
    const productType = classifySealedProduct(title, gameSlug);

    products.push({
      productId,
      gameSlug,
      title,
      productType,
      consoleSlug: slug,
      productUrl: buildPriceChartingProductUrl(slug, gameSlug),
      imageUrl,
      remoteImageUrl: imageUrl,
      ungradedPrice,
      priceText: ungradedPrice != null ? `$${ungradedPrice.toFixed(2)}` : ""
    });
  }

  products.sort((a, b) => {
    const typeDelta = sealedTypeSortKey(a.productType) - sealedTypeSortKey(b.productType);
    if (typeDelta !== 0) return typeDelta;
    return String(a.title).localeCompare(String(b.title));
  });
  return products;
}

function extractSealedFromConsoleIndex(index) {
  const consoleSlug = String(index?.consoleSlug || "").trim();
  const byCardNo = index?.byCardNo && typeof index.byCardNo === "object" ? index.byCardNo : {};
  const products = [];
  const seen = new Set();
  for (const entry of Object.values(byCardNo)) {
    if (!entry || typeof entry !== "object") continue;
    const productId = String(entry.productId || "").trim();
    const gameSlug = String(entry.gameSlug || "").trim();
    const title = String(entry.title || "").trim();
    const key = productId || `${gameSlug}|${title}`;
    if (!key || seen.has(key)) continue;
    if (!isSealedProduct(title, gameSlug)) continue;
    seen.add(key);
    const productType = classifySealedProduct(title, gameSlug);
    products.push({
      productId,
      gameSlug,
      title,
      productType,
      consoleSlug: String(entry.consoleSlug || consoleSlug),
      productUrl:
        String(entry.productUrl || "").trim() ||
        buildPriceChartingProductUrl(entry.consoleSlug || consoleSlug, gameSlug),
      imageUrl: "",
      ungradedPrice: null,
      priceText: ""
    });
  }
  products.sort((a, b) => {
    const typeDelta = sealedTypeSortKey(a.productType) - sealedTypeSortKey(b.productType);
    if (typeDelta !== 0) return typeDelta;
    return String(a.title).localeCompare(String(b.title));
  });
  return products;
}

function loadEnglishSetsFromFrontendHtml(setsHtmlPath) {
  const html = fs.readFileSync(setsHtmlPath, "utf8");
  const blockMatch = html.match(/english:\s*\{([\s\S]*?)\n\s*\},\s*\n\s*japanese:/);
  const block = blockMatch ? blockMatch[1] : html;
  const sets = [];
  const re = /set\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(block))) {
    sets.push({ name: m[1], code: String(m[2] || "").trim().toUpperCase() });
  }
  return sets.filter((s) => s.code && s.name);
}

function loadEnglishSetsFromCardLists() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "set-card-lists.json"), "utf8"));
    const byCode = parsed?.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {};
    return Object.entries(byCode).map(([code, row]) => ({
      code: String(code || "").trim().toUpperCase(),
      name: String(row?.sourceTitle || code || "").trim()
    })).filter((s) => s.code);
  } catch {
    return [];
  }
}

function collectEnglishSets(setsHtmlPath) {
  const byCode = new Map();
  for (const row of loadEnglishSetsFromCardLists()) {
    byCode.set(row.code, row);
  }
  if (setsHtmlPath && fs.existsSync(setsHtmlPath)) {
    for (const row of loadEnglishSetsFromFrontendHtml(setsHtmlPath)) {
      if (!byCode.has(row.code)) byCode.set(row.code, row);
      else if (!byCode.get(row.code).name) byCode.set(row.code, row);
    }
  }
  return [...byCode.values()];
}

async function loadSealedProductsForConsole(consoleSlug, { forceFetch = true } = {}) {
  const slug = String(consoleSlug || "").trim();
  if (!slug) return [];

  if (forceFetch) {
    try {
      const html = await fetchConsoleHtml(slug);
      if (html) {
        const parsed = parseSealedProductsFromConsoleHtml(slug, html);
        if (parsed.length) return parsed;
      }
    } catch {
      // fall through to index cache
    }
  }

  try {
    const index = await getConsoleIndex(slug, { forceRefresh: false });
    if (index) return extractSealedFromConsoleIndex(index);
  } catch {
    // ignore
  }

  try {
    const safe = slug.replace(/[^a-z0-9-]/gi, "_");
    const raw = fs.readFileSync(path.join(INDEX_CACHE_DIR, `${safe}.json`), "utf8");
    return extractSealedFromConsoleIndex(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function syncPriceChartingSealedCatalog({
  setsHtmlPath = path.join(__dirname, "..", "..", "frontend", "sets.html"),
  forceFetch = true,
  onProgress = null
} = {}) {
  await loadSetSlugsByCode();
  const sets = collectEnglishSets(setsHtmlPath).filter((set) => {
    const candidates = resolveConsoleSlugCandidates(set.code, set.name);
    return candidates.length > 0 && !candidates.every((slug) => slug === "pokemon-promo");
  });

  const byCode = {};
  const byConsoleSlug = {};
  const failed = [];
  let setDone = 0;
  const setTotal = sets.length;
  const consoleCache = new Map();

  for (const set of sets) {
    setDone += 1;
    const candidates = resolveConsoleSlugCandidates(set.code, set.name).filter(
      (slug) => slug && slug !== "pokemon-promo"
    );
    if (!candidates.length) continue;

    try {
      let chosenSlug = candidates[0];
      let products = [];
      for (const slug of candidates) {
        if (consoleCache.has(slug)) {
          products = consoleCache.get(slug);
        } else {
          products = await loadSealedProductsForConsole(slug, { forceFetch });
          consoleCache.set(slug, products);
        }
        chosenSlug = slug;
        if (products.length) break;
      }

      byConsoleSlug[chosenSlug] = {
        consoleSlug: chosenSlug,
        productCount: products.length,
        products
      };
      byCode[set.code] = {
        code: set.code,
        name: set.name,
        consoleSlug: chosenSlug,
        productCount: products.length,
        products
      };
      if (onProgress) {
        onProgress({
          phase: "console",
          done: setDone,
          total: setTotal,
          slug: chosenSlug,
          productCount: products.length,
          setCodes: [set.code]
        });
      }
    } catch (err) {
      failed.push({ code: set.code, error: err.message || String(err) });
      if (onProgress) {
        onProgress({
          phase: "console",
          done: setDone,
          total: setTotal,
          slug: candidates[0],
          ok: false,
          error: err.message || String(err)
        });
      }
    }
  }

  const catalog = {
    source: "https://www.pricecharting.com/category/pokemon-cards",
    credit: "https://www.pricecharting.com — Pokemon sealed product prices",
    generatedAt: new Date().toISOString(),
    setCount: Object.keys(byCode).length,
    consoleCount: Object.keys(byConsoleSlug).length,
    productCount: Object.values(byConsoleSlug).reduce((n, row) => n + (row.productCount || 0), 0),
    byCode,
    byConsoleSlug,
    failed
  };

  await writeJsonAtomic(SEALED_CATALOG_FILE, catalog);
  return catalog;
}

async function readSealedCatalog() {
  const raw = await fsp.readFile(SEALED_CATALOG_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid sealed catalog");
  return normalizeSealedCatalogImages(parsed);
}

function getSealedProductsForSetCode(catalog, setCode = "") {
  const code = String(setCode || "").trim().toUpperCase();
  if (!code || !catalog?.byCode) return [];
  const row = catalog.byCode[code];
  return Array.isArray(row?.products) ? row.products : [];
}

function normalizeProductImageFields(product = {}) {
  const productId = String(product.productId || "").trim();
  const remote =
    upgradeImageUrl(product.remoteImageUrl || "") ||
    upgradeImageUrl(product.imageUrl || "") ||
    "";
  const localPath = localSealedImageUrl(productId);
  const localExists = productId
    ? fs.existsSync(path.join(SEALED_IMAGE_DIR, `${productId}.jpg`))
    : false;
  return {
    ...product,
    remoteImageUrl: remote || String(product.remoteImageUrl || "").trim(),
    imageUrl: localExists ? localPath : remote || localPath
  };
}

function normalizeSealedCatalogImages(catalog) {
  if (!catalog || typeof catalog !== "object") return catalog;
  const out = { ...catalog, byCode: {}, byConsoleSlug: {} };
  for (const [code, row] of Object.entries(catalog.byCode || {})) {
    const products = Array.isArray(row?.products)
      ? row.products.map((p) => normalizeProductImageFields(p))
      : [];
    out.byCode[code] = { ...row, products, productCount: products.length };
  }
  for (const [slug, row] of Object.entries(catalog.byConsoleSlug || {})) {
    const products = Array.isArray(row?.products)
      ? row.products.map((p) => normalizeProductImageFields(p))
      : [];
    out.byConsoleSlug[slug] = { ...row, products, productCount: products.length };
  }
  return out;
}

async function downloadSealedProductImages({
  concurrency = 10,
  skipExisting = true,
  onProgress = null
} = {}) {
  const catalog = await readSealedCatalog();
  await fsp.mkdir(SEALED_IMAGE_DIR, { recursive: true });

  const byId = new Map();
  for (const row of Object.values(catalog.byCode || {})) {
    for (const product of Array.isArray(row?.products) ? row.products : []) {
      const id = String(product.productId || "").trim();
      if (!id || byId.has(id)) continue;
      const remote =
        upgradeImageUrl(product.remoteImageUrl || "") ||
        upgradeImageUrl(product.imageUrl || "");
      if (!remote || remote.startsWith("/")) continue;
      byId.set(id, { productId: id, remoteImageUrl: remote, product });
    }
  }

  const list = [...byId.values()];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  async function processOne(item) {
    const dest = path.join(SEALED_IMAGE_DIR, `${item.productId}.jpg`);
    try {
      if (skipExisting && fs.existsSync(dest)) {
        skipped += 1;
        return;
      }
      const res = await fetch(item.remoteImageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          Accept: "image/*"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const tmp = `${dest}.download`;
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, dest);
      downloaded += 1;
    } catch {
      failed += 1;
    }
  }

  for (let i = 0; i < list.length; i += concurrency) {
    const chunk = list.slice(i, i + concurrency);
    await Promise.all(chunk.map((item) => processOne(item)));
    if (onProgress) {
      onProgress({
        phase: "images",
        done: Math.min(i + concurrency, list.length),
        total: list.length,
        downloaded,
        skipped,
        failed
      });
    }
  }

  // Rewrite catalog image fields to prefer local paths.
  const next = normalizeSealedCatalogImages(catalog);
  for (const row of Object.values(next.byCode || {})) {
    for (const product of row.products || []) {
      const id = String(product.productId || "").trim();
      if (!id) continue;
      const remote =
        upgradeImageUrl(product.remoteImageUrl || "") ||
        upgradeImageUrl(product.imageUrl || "");
      product.remoteImageUrl = remote;
      if (fs.existsSync(path.join(SEALED_IMAGE_DIR, `${id}.jpg`))) {
        product.imageUrl = localSealedImageUrl(id);
      } else {
        product.imageUrl = remote;
      }
    }
  }
  for (const row of Object.values(next.byConsoleSlug || {})) {
    for (const product of row.products || []) {
      const id = String(product.productId || "").trim();
      if (!id) continue;
      const remote =
        upgradeImageUrl(product.remoteImageUrl || "") ||
        upgradeImageUrl(product.imageUrl || "");
      product.remoteImageUrl = remote;
      if (fs.existsSync(path.join(SEALED_IMAGE_DIR, `${id}.jpg`))) {
        product.imageUrl = localSealedImageUrl(id);
      } else {
        product.imageUrl = remote;
      }
    }
  }
  next.imagesDownloadedAt = new Date().toISOString();
  await writeJsonAtomic(SEALED_CATALOG_FILE, next);

  return { total: list.length, downloaded, skipped, failed };
}

module.exports = {
  SEALED_CATALOG_FILE,
  SEALED_IMAGE_DIR,
  isSealedProduct,
  classifySealedProduct,
  parseSealedProductsFromConsoleHtml,
  extractSealedFromConsoleIndex,
  collectEnglishSets,
  loadSealedProductsForConsole,
  syncPriceChartingSealedCatalog,
  readSealedCatalog,
  getSealedProductsForSetCode,
  normalizeSealedCatalogImages,
  downloadSealedProductImages,
  upgradeImageUrl
};
