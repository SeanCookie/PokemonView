const fsp = require("fs/promises");
const path = require("path");
const {
  readCachedChartEntry,
  writeCachedChartEntry
} = require("./pricecharting-market-history-cache");

const DATA_DIR = path.join(__dirname, "..", "data");
const SET_SLUGS_FILE = path.join(DATA_DIR, "pricecharting-set-slugs.json");
const INDEX_CACHE_DIR = path.join(DATA_DIR, "pricecharting-index-cache");

const PC_FETCH_MIN_INTERVAL_MS = 1100;
const CONSOLE_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHART_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PRODUCT_PAGE_PARSE_VERSION = 3;

const PC_CHART_LABELS = {
  used: "Ungraded",
  graded: "PSA 10",
  manualonly: "Manual Only",
  new: "New",
  cib: "Complete",
  boxonly: "Box Only"
};

const PC_TCG_CHART_LABELS = {
  used: "Ungraded",
  manualonly: "PSA 10"
};

const PC_VIDEO_GAME_CHART_SORT_ORDER = ["used", "graded", "manualonly", "new", "cib", "boxonly"];
const PC_TCG_CHART_SORT_ORDER = ["used", "manualonly"];

const POKEMON_PROMO_SET_CODES = new Set([
  "MEP",
  "SVP",
  "SWSHP",
  "SMP",
  "XYP",
  "BWP",
  "HSP",
  "DPP",
  "NBSP",
  "FUT20",
  "DET"
]);

const GRADE_DISPLAY_ORDER = [
  "Ungraded",
  "PSA 1",
  "PSA 2",
  "PSA 3",
  "PSA 4",
  "PSA 5",
  "PSA 6",
  "PSA 7",
  "PSA 8",
  "PSA 9",
  "PSA 10",
  "CGC 10",
  "CGC 10 Pristine",
  "BGS 9.5",
  "BGS 10",
  "BGS 10 Black",
  "TAG 10",
  "ACE 10"
];

function isTradingCardCategory(category = "", consoleSlug = "") {
  const cat = String(category || "").trim().toLowerCase();
  const slug = String(consoleSlug || "").trim().toLowerCase();
  if (cat.endsWith("-cards") || /pokemon|magic|yugioh|lorcana|digimon|one-piece|flesh-and-blood/i.test(cat)) {
    return true;
  }
  return /^(pokemon|magic|yugioh|lorcana|digimon|one-piece|flesh-and-blood)-/i.test(slug);
}

function chartLabelForKey(key, category = "", consoleSlug = "") {
  if (isTradingCardCategory(category, consoleSlug)) {
    return PC_TCG_CHART_LABELS[key] || PC_CHART_LABELS[key] || key;
  }
  return PC_CHART_LABELS[key] || key;
}

function chartSortOrderForProduct(category = "", consoleSlug = "") {
  return isTradingCardCategory(category, consoleSlug)
    ? PC_TCG_CHART_SORT_ORDER
    : PC_VIDEO_GAME_CHART_SORT_ORDER;
}

let setSlugsByCode = null;
let lastFetchMs = 0;
const consoleIndexMem = new Map();
const chartDataMem = new Map();
const productPageMem = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function slugifyForPriceCharting(text) {
  return decodeHtmlEntities(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isReverseHoloProduct(title = "", gameSlug = "") {
  return /reverse\s*holo/i.test(String(title || "")) || /reverse-holo/i.test(String(gameSlug || ""));
}

function parseUsdPrice(text) {
  const raw = String(text || "").trim();
  if (!raw || raw === "-" || raw === "–" || /^n\/a$/i.test(raw)) return null;
  const match = raw.replace(/,/g, "").match(/\$?\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function displayGradeLabel(rawLabel = "") {
  const label = decodeHtmlEntities(rawLabel).trim();
  if (!label) return "";
  if (/^SGC\b/i.test(label)) return "";
  const gradeMatch = /^Grade\s+(\d+(?:\.\d+)?)$/i.exec(label);
  if (gradeMatch) {
    const num = gradeMatch[1];
    if (num === "9.5") return "BGS 9.5";
    return `PSA ${num}`;
  }
  return label;
}

function sortGradeRows(grades) {
  return [...grades].sort((a, b) => {
    const ai = GRADE_DISPLAY_ORDER.indexOf(a.label);
    const bi = GRADE_DISPLAY_ORDER.indexOf(b.label);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

async function loadSetSlugsByCode() {
  if (setSlugsByCode) return setSlugsByCode;
  try {
    const raw = await fsp.readFile(SET_SLUGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    setSlugsByCode =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    setSlugsByCode = {};
  }
  return setSlugsByCode;
}

function normalizePcCardNumberKey(raw) {
  const token = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^#+/, "");
  if (!token) return "";
  if (/^\d+$/.test(token)) return String(Number(token));
  return token;
}

function cardNumberLookupKeys(raw) {
  const primary = normalizePcCardNumberKey(raw);
  if (!primary) return [];
  const keys = new Set([primary]);
  const digits = primary.match(/^([A-Z]{0,4})(\d+)$/);
  if (digits) {
    keys.add(digits[2]);
    keys.add(String(Number(digits[2])));
    if (digits[1]) keys.add(`${digits[1]}${digits[2]}`);
  }
  const slash = String(raw).match(/#?\s*([A-Za-z0-9]+)\s*\/\s*\d+/);
  if (slash) keys.add(normalizePcCardNumberKey(slash[1]));
  return [...keys].filter(Boolean);
}

async function rateLimitPriceChartingFetch() {
  const elapsed = Date.now() - lastFetchMs;
  if (elapsed < PC_FETCH_MIN_INTERVAL_MS) {
    await sleep(PC_FETCH_MIN_INTERVAL_MS - elapsed);
  }
  lastFetchMs = Date.now();
}

async function fetchPriceChartingHtml(url) {
  await rateLimitPriceChartingFetch();
  const response = await fetch(url, {
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
    throw new Error(`PriceCharting page failed (${response.status})`);
  }
  return text;
}

function resolveConsoleSlug(setCode = "", setName = "") {
  const code = String(setCode || "").trim().toUpperCase();
  const slugs = setSlugsByCode || {};
  if (code && slugs[code]) return slugs[code];
  if (code && POKEMON_PROMO_SET_CODES.has(code)) return "pokemon-promo";
  const nameNorm = String(setName || "").trim().toLowerCase();
  if (/promo/i.test(nameNorm)) return "pokemon-promo";
  const nameSlug = slugifyForPriceCharting(setName);
  if (!nameSlug) return "";
  if (nameSlug.startsWith("pokemon-")) return nameSlug;
  return `pokemon-${nameSlug}`;
}

function resolveConsoleSlugCandidates(setCode = "", setName = "") {
  const out = [];
  const primary = resolveConsoleSlug(setCode, setName);
  if (primary) out.push(primary);
  const code = String(setCode || "").trim().toUpperCase();
  if ((POKEMON_PROMO_SET_CODES.has(code) || /promo/i.test(String(setName || ""))) && !out.includes("pokemon-promo")) {
    out.push("pokemon-promo");
  }
  return [...new Set(out.filter(Boolean))];
}

function parseConsoleIndexFromHtml(consoleSlug, html) {
  const byCardNo = {};
  const re =
    /<td class="title" title="(\d+)">\s*<a href="\/game\/[^/]+\/([^"]+)">([^<]+)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const productId = String(match[1] || "").trim();
    const gameSlug = decodeHtmlEntities(match[2] || "").trim();
    const title = decodeHtmlEntities(match[3] || "").trim();
    if (!productId || !gameSlug) continue;
    const numMatch = title.match(/#([^#]+)$/);
    const cardNumber = normalizePcCardNumberKey(numMatch ? numMatch[1] : "");
    const entry = {
      productId,
      gameSlug,
      title,
      consoleSlug,
      productUrl: `https://www.pricecharting.com/game/${consoleSlug}/${gameSlug}`
    };
    if (cardNumber) {
      const reverseHolo = isReverseHoloProduct(title, gameSlug);
      for (const key of cardNumberLookupKeys(cardNumber)) {
        if (reverseHolo) {
          const rhKey = `${key}:rh`;
          if (!byCardNo[rhKey]) byCardNo[rhKey] = entry;
        } else if (!byCardNo[key] || isReverseHoloProduct(byCardNo[key].title, byCardNo[key].gameSlug)) {
          byCardNo[key] = entry;
        }
      }
    }
    const titleKey = slugifyForPriceCharting(title);
    if (titleKey && !byCardNo[`title:${titleKey}`]) {
      byCardNo[`title:${titleKey}`] = entry;
    }
  }
  return { consoleSlug, byCardNo, builtAt: new Date().toISOString() };
}

function indexCachePath(consoleSlug) {
  const safe = String(consoleSlug || "").replace(/[^a-z0-9-]/gi, "_");
  return path.join(INDEX_CACHE_DIR, `${safe}.json`);
}

async function readConsoleIndexFromDisk(consoleSlug) {
  try {
    const raw = await fsp.readFile(indexCachePath(consoleSlug), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.byCardNo || typeof parsed.byCardNo !== "object") return null;
    const builtAt = Date.parse(parsed.builtAt || "");
    if (!Number.isFinite(builtAt) || Date.now() - builtAt > CONSOLE_INDEX_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeConsoleIndexToDisk(index) {
  try {
    await fsp.mkdir(INDEX_CACHE_DIR, { recursive: true });
    await fsp.writeFile(indexCachePath(index.consoleSlug), JSON.stringify(index), "utf8");
  } catch {
    // best effort
  }
}

async function fetchConsoleIndexFromWeb(consoleSlug) {
  const slug = String(consoleSlug || "").trim();
  if (!slug) return null;
  let html = "";
  try {
    html = await fetchPriceChartingHtml(`https://www.pricecharting.com/console/${slug}`);
  } catch {
    return null;
  }
  if (!html || /Page Not Found|404 Not Found/i.test(html.slice(0, 1200))) {
    return null;
  }
  const index = parseConsoleIndexFromHtml(slug, html);
  if (!Object.keys(index.byCardNo || {}).length) return null;
  await writeConsoleIndexToDisk(index);
  return index;
}

async function getConsoleIndex(consoleSlug, { forceRefresh = false } = {}) {
  const slug = String(consoleSlug || "").trim();
  if (!slug) return null;

  if (!forceRefresh) {
    const mem = consoleIndexMem.get(slug);
    if (mem && mem.expiresAt > Date.now()) return mem.value;
  } else {
    consoleIndexMem.delete(slug);
  }

  let index = forceRefresh ? null : await readConsoleIndexFromDisk(slug);
  if (!index) {
    index = await fetchConsoleIndexFromWeb(slug);
  }

  if (!index) return null;
  consoleIndexMem.set(slug, { expiresAt: Date.now() + CONSOLE_INDEX_TTL_MS, value: index });
  return index;
}

function buildPriceChartingGameSlugCandidates(cardName = "", cardNo = "") {
  const nameSlug = slugifyForPriceCharting(cardName);
  const num = normalizePcCardNumberKey(cardNo);
  if (!nameSlug || !num) return [];
  const out = new Set();
  const tokens = nameSlug.split("-").filter(Boolean);
  if (tokens.length >= 2) {
    out.add(`${tokens.slice(0, 2).join("-")}-asia-championship-${num}`);
  }
  out.add(`${nameSlug}-${num}`);
  return [...out];
}

async function probePriceChartingProductByGameSlug(consoleSlug, gameSlug) {
  const slug = String(consoleSlug || "").trim();
  const game = String(gameSlug || "").trim();
  if (!slug || !game) return null;
  const url = `https://www.pricecharting.com/game/${slug}/${game}`;
  try {
    const html = await fetchPriceChartingHtml(url);
    if (!html || /Page Not Found|404 Not Found/i.test(html.slice(0, 1200))) return null;
    if (!html.includes('id="full-prices"')) return null;
    const pageData = {
      chartData: parseChartDataFromGameHtml(html),
      gradedGuide: parseGradedGuideFromGameHtml(html)
    };
    if (!extractUngradedPriceFromPageData(pageData)) return null;
    return {
      productId: parseProductIdFromGameHtml(html),
      gameSlug: game,
      title: pageData.gradedGuide?.title || "",
      consoleSlug: slug,
      productUrl: url
    };
  } catch {
    return null;
  }
}

function pickProductFromIndex(index, cardNo = "", cardName = "") {
  if (!index?.byCardNo) return null;
  const nameSlug = slugifyForPriceCharting(cardName);
  const num = normalizePcCardNumberKey(cardNo);

  if (nameSlug && num) {
    let best = null;
    let bestScore = -1;
    for (const entry of Object.values(index.byCardNo)) {
      if (!entry || typeof entry !== "object") continue;
      const gameSlug = String(entry.gameSlug || "").toLowerCase();
      const title = String(entry.title || "").toLowerCase();
      if (!gameSlug.includes(nameSlug) && !title.includes(nameSlug.replace(/-/g, " "))) continue;
      if (!gameSlug.endsWith(`-${num}`) && !gameSlug.includes(`-${num}-`)) continue;
      if (isReverseHoloProduct(entry.title, entry.gameSlug)) continue;
      let score = 10;
      if (gameSlug.includes(nameSlug)) score += 20;
      if (title.includes(nameSlug.replace(/-/g, " "))) score += 10;
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (best) return best;
  }

  if (nameSlug && index.byCardNo[`title:${nameSlug}`]) {
    return index.byCardNo[`title:${nameSlug}`];
  }
  if (nameSlug) {
    for (const [key, entry] of Object.entries(index.byCardNo)) {
      if (!key.startsWith("title:")) continue;
      if (key.includes(nameSlug) || nameSlug.includes(key.replace(/^title:/, ""))) {
        return entry;
      }
    }
  }

  const keys = cardNumberLookupKeys(cardNo);
  for (const key of keys) {
    const entry = index.byCardNo[key];
    if (entry && !isReverseHoloProduct(entry.title, entry.gameSlug)) return entry;
  }
  return null;
}

function extractUngradedPriceFromPageData(pageData) {
  const grades = pageData?.gradedGuide?.grades;
  if (Array.isArray(grades)) {
    const ungraded = grades.find((row) => String(row?.label || "").trim() === "Ungraded");
    if (ungraded && Number(ungraded.price) > 0) {
      return Number(Number(ungraded.price).toFixed(2));
    }
  }
  const used = pageData?.chartData?.used;
  if (Array.isArray(used) && used.length) {
    for (let i = used.length - 1; i >= 0; i -= 1) {
      const row = used[i];
      const pennies = Number(row?.[1]);
      if (Number.isFinite(pennies) && pennies > 0) {
        return Number((pennies / 100).toFixed(2));
      }
    }
  }
  return null;
}

async function fetchPriceChartingUngradedPriceFromProductUrl(productUrl = "") {
  const url = String(productUrl || "").trim();
  const match = url.match(/pricecharting\.com\/game\/([^/?#]+)\/([^/?#]+)/i);
  if (!match) {
    return { ok: false, ungradedPrice: null, productUrl: url, error: "Not a PriceCharting product URL" };
  }
  const product = {
    consoleSlug: decodeHtmlEntities(match[1]).trim(),
    gameSlug: decodeHtmlEntities(match[2]).trim(),
    productUrl: url.split("?")[0]
  };
  const pageData = await fetchProductPageData(product);
  const ungradedPrice = extractUngradedPriceFromPageData(pageData);
  if (!Number.isFinite(ungradedPrice) || ungradedPrice <= 0) {
    return {
      ok: false,
      ungradedPrice: null,
      productUrl: product.productUrl,
      error: "No Ungraded price on PriceCharting"
    };
  }
  return {
    ok: true,
    ungradedPrice,
    productUrl: product.productUrl,
    priceText: `$${ungradedPrice.toFixed(2)}`
  };
}

async function fetchPriceChartingUngradedPriceForCard({
  setCode = "",
  setName = "",
  cardNo = "",
  cardName = ""
} = {}) {
  await loadSetSlugsByCode();
  const candidates = resolveConsoleSlugCandidates(setCode, setName);
  if (!candidates.length) {
    return { ok: false, ungradedPrice: null, productUrl: "", error: "No PriceCharting console slug" };
  }

  let product = null;
  for (const consoleSlug of candidates) {
    let index = await getConsoleIndex(consoleSlug);
    if (index) product = pickProductFromIndex(index, cardNo, cardName);
    if (!product) {
      index = await getConsoleIndex(consoleSlug, { forceRefresh: true });
      if (index) product = pickProductFromIndex(index, cardNo, cardName);
    }
    if (product) break;
  }
  if (!product) {
    for (const consoleSlug of candidates) {
      for (const gameSlug of buildPriceChartingGameSlugCandidates(cardName, cardNo)) {
        product = await probePriceChartingProductByGameSlug(consoleSlug, gameSlug);
        if (product) break;
      }
      if (product) break;
    }
  }
  if (!product) {
    return { ok: false, ungradedPrice: null, productUrl: "", error: "Card not found on PriceCharting" };
  }

  const pageData = await fetchProductPageData(product);
  const ungradedPrice = extractUngradedPriceFromPageData(pageData);
  if (!Number.isFinite(ungradedPrice) || ungradedPrice <= 0) {
    return {
      ok: false,
      ungradedPrice: null,
      productUrl: product.productUrl || "",
      error: "No Ungraded price on PriceCharting"
    };
  }

  return {
    ok: true,
    ungradedPrice,
    productUrl: product.productUrl || "",
    priceText: `$${ungradedPrice.toFixed(2)}`
  };
}

function pickReverseHoloFromIndex(index, cardNo = "") {
  if (!index?.byCardNo) return null;
  for (const key of cardNumberLookupKeys(cardNo)) {
    if (index.byCardNo[`${key}:rh`]) return index.byCardNo[`${key}:rh`];
  }
  return null;
}

function parseProductIdFromGameHtml(html) {
  const match =
    String(html || "").match(/PriceCharting ID:\s*<\/th>\s*<td[^>]*>\s*(\d+)/i) ||
    String(html || "").match(/VGPC\.product\s*=\s*\{[\s\S]*?id:\s*(\d+)/);
  return match ? String(match[1] || "").trim() : "";
}

function parseSoldListingsFromGameHtml(html) {
  const tableMatch = String(html || "").match(
    /<table class="hoverable-rows sortable">([\s\S]*?)<\/table>/i
  );
  if (!tableMatch) return [];

  const listings = [];
  const rows = [
    ...tableMatch[1].matchAll(/<tr[^>]*>\s*<td class="date">([^<]+)<\/td>([\s\S]*?)<\/tr>/gi)
  ];
  for (const row of rows) {
    const inner = row[0];
    const date = decodeHtmlEntities(row[1]).trim();
    const titleLink =
      inner.match(/<td class="title"[^>]*>[\s\S]*?<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i) ||
      inner.match(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const sourceMatch =
      inner.match(/\[(eBay|TCGPlayer)\]/i) ||
      (/\bid="ebay-/i.test(inner) || /ebay\.com\/itm/i.test(inner) ? ["", "eBay"] : null);
    const priceMatch = inner.match(/<span class="js-price"[^>]*>\s*([^<]+)/i);
    if (!date || !priceMatch) continue;
    const priceText = decodeHtmlEntities(priceMatch[1]).trim();
    const price = parseUsdPrice(priceText);
    if (price === null) continue;
    listings.push({
      date,
      title: decodeHtmlEntities(titleLink?.[2] || "")
        .replace(/\s+/g, " ")
        .trim(),
      url: decodeHtmlEntities(titleLink?.[1] || ""),
      source: sourceMatch ? sourceMatch[1] : "",
      price,
      priceText
    });
  }
  return listings;
}

function parseGradedGuideFromGameHtml(html) {
  const section = String(html || "").match(
    /id="full-prices"[\s\S]*?<h2>([^<]*)<\/h2>\s*<table>([\s\S]*?)<\/table>/i
  );
  if (!section) return { title: "", grades: [] };

  const title = decodeHtmlEntities(section[1])
    .replace(/^Full Price Guide:\s*/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  const byLabel = new Map();
  const rows = [
    ...section[2].matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td class="price js-price">([^<]*)<\/td>\s*<\/tr>/gi)
  ];
  for (const row of rows) {
    const rawLabel = decodeHtmlEntities(row[1]).trim();
    const rawPrice = decodeHtmlEntities(row[2]).trim();
    if (!rawLabel) continue;
    const label = displayGradeLabel(rawLabel);
    if (!label) continue;
    const price = parseUsdPrice(rawPrice);
    if (price === null) continue;
    const priceText = rawPrice.startsWith("$") ? rawPrice : `$${rawPrice.replace(/^\$/, "")}`;
    byLabel.set(label, { label, price, priceText });
  }

  return { title, grades: sortGradeRows([...byLabel.values()]) };
}

async function resolveReverseHoloProduct(index, cardName = "", cardNo = "", consoleSlug = "") {
  const fromIndex = pickReverseHoloFromIndex(index, cardNo);
  if (fromIndex) return fromIndex;

  const nameSlug = slugifyForPriceCharting(cardName);
  const num = normalizePcCardNumberKey(cardNo);
  if (!nameSlug || !num || !consoleSlug) return null;

  const gameSlug = `${nameSlug}-reverse-holo-${num}`;
  const url = `https://www.pricecharting.com/game/${consoleSlug}/${gameSlug}`;
  try {
    const html = await fetchPriceChartingHtml(url);
    if (!html || /Page Not Found|404 Not Found/i.test(html.slice(0, 1200))) return null;
    if (!html.includes('id="full-prices"')) return null;
    const guide = parseGradedGuideFromGameHtml(html);
    if (!guide.grades.length) return null;
    return {
      productId: parseProductIdFromGameHtml(html),
      gameSlug,
      title: guide.title || `${cardName} [Reverse Holo] #${num}`,
      consoleSlug,
      productUrl: url
    };
  } catch {
    return null;
  }
}

function parseCategoryFromGameHtml(html) {
  const match = String(html || "").match(/VGPC\.category\s*=\s*['"]([^'"]+)['"]/);
  return match ? String(match[1] || "").trim() : "";
}

function parseChartDataFromGameHtml(html) {
  const match = String(html || "").match(/VGPC\.chart_data\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function fetchProductPageData(product) {
  const productId = String(product?.productId || "").trim();
  const cacheKey = `${PRODUCT_PAGE_PARSE_VERSION}:${
    productId ||
    `${String(product?.consoleSlug || "").trim()}:${String(product?.gameSlug || "").trim()}`
  }`;
  if (!cacheKey || cacheKey === ":") return null;

  const mem = productPageMem.get(cacheKey);
  if (mem && mem.expiresAt > Date.now()) return mem.value;

  const url =
    String(product?.productUrl || "").trim() ||
    `https://www.pricecharting.com/game/${product.consoleSlug}/${product.gameSlug}`;
  const html = await fetchPriceChartingHtml(url);
  const chartData = parseChartDataFromGameHtml(html);
  const payload = {
    chartData: chartData && typeof chartData === "object" ? chartData : null,
    category: parseCategoryFromGameHtml(html),
    consoleSlug: String(product?.consoleSlug || "").trim(),
    soldListings: parseSoldListingsFromGameHtml(html),
    gradedGuide: parseGradedGuideFromGameHtml(html),
    productUrl: url
  };
  productPageMem.set(cacheKey, { expiresAt: Date.now() + CHART_CACHE_TTL_MS, value: payload });
  if (productId) {
    chartDataMem.set(productId, { expiresAt: Date.now() + CHART_CACHE_TTL_MS, value: payload });
  }
  return payload;
}

async function fetchChartDataForProduct(product) {
  const payload = await fetchProductPageData(product);
  if (!payload?.chartData) return null;
  return payload;
}

function filterPositiveMarketHistoryPoints(points) {
  return (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.price) && point.price > 0
  );
}

function computeMarketHistoryDelta(points) {
  const usable = filterPositiveMarketHistoryPoints(points);
  if (usable.length < 1) {
    return { priceChange: null, percentChange: null, startPrice: null, endPrice: null };
  }
  const first = usable[0].price;
  const last = usable[usable.length - 1].price;
  const priceChange = Number((last - first).toFixed(2));
  const percentChange =
    Number.isFinite(first) && first > 0 ? Number(((priceChange / first) * 100).toFixed(2)) : null;
  return {
    priceChange,
    percentChange,
    startPrice: first,
    endPrice: last
  };
}

function chartDataToSeries(
  chartData,
  rangeDays = 0,
  { detailRarity = "", productId = "", category = "", consoleSlug = "" } = {}
) {
  const applyCutoff = Number(rangeDays) > 0;
  const cutoff = applyCutoff ? Date.now() - rangeDays * 24 * 60 * 60 * 1000 : 0;
  const series = [];
  const pid = String(productId || "").trim();
  const sortOrder = chartSortOrderForProduct(category, consoleSlug);

  for (const key of sortOrder) {
    if (isTradingCardCategory(category, consoleSlug) && key !== "used" && key !== "manualonly") continue;
    const rawPoints = Array.isArray(chartData[key]) ? chartData[key] : [];
    const points = [];
    for (const row of rawPoints) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const ts = Number(row[0]);
      const pennies = Number(row[1]);
      if (!Number.isFinite(ts) || (applyCutoff && ts < cutoff)) continue;
      if (!Number.isFinite(pennies) || pennies <= 0) continue;
      const price = Number((pennies / 100).toFixed(2));
      const date = new Date(ts).toISOString().slice(0, 10);
      points.push({ date, ts, price, volume: 0 });
    }
    points.sort((a, b) => a.ts - b.ts);
    const positive = filterPositiveMarketHistoryPoints(points);
    if (!positive.length) continue;

    const label = chartLabelForKey(key, category, consoleSlug);
    series.push({
      id: `pc:${pid}:${key}`,
      productId: pid,
      variantKey: key,
      label,
      printing: label,
      rarity: String(detailRarity || "").trim(),
      tcgplayerUrl: "",
      source: "pricecharting",
      category: String(category || "").trim(),
      consoleSlug: String(consoleSlug || "").trim(),
      points: positive,
      ...computeMarketHistoryDelta(positive)
    });
  }

  return series;
}

function comparePriceChartingSeries(a, b) {
  const rank = (row) => {
    const key = String(row?.variantKey || "").trim();
    const order = chartSortOrderForProduct(row?.category, row?.consoleSlug);
    const idx = order.indexOf(key);
    return idx === -1 ? order.length + 1 : idx;
  };
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  return String(a?.label || "").localeCompare(String(b?.label || ""), undefined, {
    sensitivity: "base"
  });
}

async function resolvePriceChartingProductForCard({
  setCode = "",
  setName = "",
  cardNo = "",
  cardName = ""
} = {}) {
  await loadSetSlugsByCode();
  const candidates = resolveConsoleSlugCandidates(setCode, setName);
  if (!candidates.length) {
    return { product: null, error: "No PriceCharting console slug for this set" };
  }

  let product = null;
  for (const consoleSlug of candidates) {
    let index = await getConsoleIndex(consoleSlug);
    if (index) product = pickProductFromIndex(index, cardNo, cardName);
    if (!product) {
      index = await getConsoleIndex(consoleSlug, { forceRefresh: true });
      if (index) product = pickProductFromIndex(index, cardNo, cardName);
    }
    if (product) break;
  }

  if (!product) {
    for (const consoleSlug of candidates) {
      for (const gameSlug of buildPriceChartingGameSlugCandidates(cardName, cardNo)) {
        product = await probePriceChartingProductByGameSlug(consoleSlug, gameSlug);
        if (product) break;
      }
      if (product) break;
    }
  }

  if (!product) {
    return { product: null, error: "Card not found on PriceCharting" };
  }
  return { product, error: "" };
}

async function fetchPriceChartingMarketHistoryForCard({
  setCode = "",
  setName = "",
  cardNo = "",
  cardName = "",
  detailRarity = "",
  rangeDays = 0,
  forceRefresh = false
} = {}) {
  if (!forceRefresh) {
    const cached = readCachedChartEntry(setCode, cardNo);
    if (cached) {
      const series = chartDataToSeries(cached.chartData, 0, {
        detailRarity: cached.detailRarity || detailRarity,
        productId: cached.productId,
        category: cached.category,
        consoleSlug: cached.consoleSlug
      });
      if (series.length) {
        series.sort(comparePriceChartingSeries);
        return series;
      }
    }
  }

  const resolved = await resolvePriceChartingProductForCard({
    setCode,
    setName,
    cardNo,
    cardName
  });
  const product = resolved.product;
  if (!product) return [];

  const chartPayload = await fetchChartDataForProduct(product);
  if (!chartPayload?.chartData) return [];

  writeCachedChartEntry(setCode, cardNo, {
    productId: product.productId,
    productUrl: product.productUrl,
    category: chartPayload.category,
    consoleSlug: chartPayload.consoleSlug || product.consoleSlug,
    chartData: chartPayload.chartData,
    detailRarity
  });

  const series = chartDataToSeries(chartPayload.chartData, 0, {
    detailRarity,
    productId: product.productId,
    category: chartPayload.category,
    consoleSlug: chartPayload.consoleSlug || product.consoleSlug
  });
  series.sort(comparePriceChartingSeries);
  return series;
}

async function fetchPriceChartingCardDetailsForCard({
  setCode = "",
  setName = "",
  cardNo = "",
  cardName = ""
} = {}) {
  const resolved = await resolvePriceChartingProductForCard({
    setCode,
    setName,
    cardNo,
    cardName
  });
  const product = resolved.product;
  if (!product) {
    return {
      ok: false,
      soldListings: [],
      gradedGuides: [],
      productUrl: "",
      error: resolved.error || "Card not found on PriceCharting"
    };
  }

  const consoleSlug = String(product.consoleSlug || "").trim();
  let index = consoleSlug ? await getConsoleIndex(consoleSlug) : null;

  let pageData;
  try {
    pageData = await fetchProductPageData(product);
  } catch (err) {
    return {
      ok: false,
      soldListings: [],
      gradedGuides: [],
      productUrl: product.productUrl || "",
      error: err?.message || "PriceCharting page fetch failed"
    };
  }

  if (pageData?.chartData) {
    writeCachedChartEntry(setCode, cardNo, {
      productId: product.productId,
      productUrl: product.productUrl,
      category: pageData.category,
      consoleSlug: pageData.consoleSlug || product.consoleSlug,
      chartData: pageData.chartData
    });
  }
  const gradedGuides = [];
  const soldGuides = [];
  if (pageData?.gradedGuide?.grades?.length) {
    gradedGuides.push({
      variant: "normal",
      title: pageData.gradedGuide.title,
      grades: pageData.gradedGuide.grades,
      productUrl: product.productUrl
    });
  }
  if (pageData?.soldListings?.length) {
    soldGuides.push({
      variant: "normal",
      title: pageData.gradedGuide?.title || String(cardName || "").trim() || "Normal",
      listings: pageData.soldListings,
      productUrl: product.productUrl
    });
  }

  const reverseHoloProduct = await resolveReverseHoloProduct(index, cardName, cardNo, consoleSlug);
  if (reverseHoloProduct) {
    try {
      const reversePageData = await fetchProductPageData(reverseHoloProduct);
      if (reversePageData?.gradedGuide?.grades?.length) {
        gradedGuides.push({
          variant: "reverse_holo",
          title: reversePageData.gradedGuide.title,
          grades: reversePageData.gradedGuide.grades,
          productUrl: reverseHoloProduct.productUrl
        });
      }
      if (reversePageData?.soldListings?.length) {
        soldGuides.push({
          variant: "reverse_holo",
          title:
            reversePageData.gradedGuide?.title ||
            `${String(cardName || "").trim()} Reverse Holofoil`.trim() ||
            "Reverse Holofoil",
          listings: reversePageData.soldListings,
          productUrl: reverseHoloProduct.productUrl
        });
      }
    } catch {
      // reverse holo is optional
    }
  }

  return {
    ok: true,
    productUrl: product.productUrl,
    soldListings: pageData?.soldListings || [],
    soldGuides,
    gradedGuides
  };
}

async function fetchPriceChartingCardDetailsFromProductUrl(
  productUrl = "",
  { cardName = "", cardNo = "" } = {}
) {
  const url = String(productUrl || "").trim();
  const match = url.match(/pricecharting\.com\/game\/([^/?#]+)\/([^/?#]+)/i);
  if (!match) {
    return {
      ok: false,
      soldListings: [],
      gradedGuides: [],
      productUrl: url,
      error: "Not a PriceCharting product URL"
    };
  }

  const consoleSlug = decodeHtmlEntities(match[1]).trim();
  const gameSlug = decodeHtmlEntities(match[2]).trim();
  const product = {
    consoleSlug,
    gameSlug,
    productUrl: url.split("?")[0]
  };

  let pageData;
  try {
    pageData = await fetchProductPageData(product);
  } catch (err) {
    return {
      ok: false,
      soldListings: [],
      gradedGuides: [],
      productUrl: product.productUrl,
      error: err?.message || "PriceCharting page fetch failed"
    };
  }

  if (!pageData || (!pageData.soldListings?.length && !pageData.gradedGuide?.grades?.length && !pageData.chartData)) {
    return {
      ok: false,
      soldListings: [],
      gradedGuides: [],
      productUrl: product.productUrl,
      error: "Could not read PriceCharting card details from that page"
    };
  }

  const gradedGuides = [];
  const soldGuides = [];
  if (pageData?.gradedGuide?.grades?.length) {
    gradedGuides.push({
      variant: "normal",
      title: pageData.gradedGuide.title,
      grades: pageData.gradedGuide.grades,
      productUrl: product.productUrl
    });
  }
  if (pageData?.soldListings?.length) {
    soldGuides.push({
      variant: "normal",
      title: pageData.gradedGuide?.title || String(cardName || "").trim() || "Normal",
      listings: pageData.soldListings,
      productUrl: product.productUrl
    });
  }

  const name = String(cardName || "").trim();
  const no = String(cardNo || "").trim();
  if (name && no && consoleSlug) {
    try {
      const index = await getConsoleIndex(consoleSlug);
      const reverseHoloProduct = await resolveReverseHoloProduct(index, name, no, consoleSlug);
      if (reverseHoloProduct) {
        const reversePageData = await fetchProductPageData(reverseHoloProduct);
        if (reversePageData?.gradedGuide?.grades?.length) {
          gradedGuides.push({
            variant: "reverse_holo",
            title: reversePageData.gradedGuide.title,
            grades: reversePageData.gradedGuide.grades,
            productUrl: reverseHoloProduct.productUrl
          });
        }
        if (reversePageData?.soldListings?.length) {
          soldGuides.push({
            variant: "reverse_holo",
            title:
              reversePageData.gradedGuide?.title ||
              `${name} Reverse Holofoil`.trim() ||
              "Reverse Holofoil",
            listings: reversePageData.soldListings,
            productUrl: reverseHoloProduct.productUrl
          });
        }
      }
    } catch {
      // reverse holo is optional
    }
  }

  return {
    ok: true,
    productUrl: product.productUrl,
    soldListings: pageData?.soldListings || [],
    soldGuides,
    gradedGuides
  };
}

module.exports = {
  fetchPriceChartingMarketHistoryForCard,
  fetchPriceChartingCardDetailsForCard,
  fetchPriceChartingCardDetailsFromProductUrl,
  fetchPriceChartingUngradedPriceForCard,
  fetchPriceChartingUngradedPriceFromProductUrl,
  resolveConsoleSlug,
  resolveConsoleSlugCandidates,
  loadSetSlugsByCode,
  comparePriceChartingSeries,
  chartDataToSeries,
  parseSoldListingsFromGameHtml,
  parseGradedGuideFromGameHtml,
  extractUngradedPriceFromPageData
};
