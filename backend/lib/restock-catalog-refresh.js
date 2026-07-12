const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");
const {
  parseSmokeAndMirrorsProducts,
  SMOKE_AND_MIRRORS_COLLECTION_URL
} = require("../scripts/restock-parsers");

const POKENE_COLLECTION_URL = "https://www.pokene.com/category/pokemontcg";
const POKENE_GRAPHQL_URL = "https://www.pokene.com/_api/wixstores-graphql-server/graphql";
const POKENE_ACCESS_TOKEN_URL = "https://www.pokene.com/_api/v1/access-tokens";
const POKENE_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e";
const POKENE_APP_INT_ID = 3838;
const POKENE_ALL_POKEMON_CATEGORY_ID = "e0ab06f7-0314-4042-9b69-64434c043a4d";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProductUrl(url) {
  return String(url || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .split("?")[0]
    .split("#")[0];
}

function fetchUrl(url, accept = "application/json", extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept: accept,
          "Accept-Encoding": "gzip,deflate,br",
          ...extraHeaders
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(new URL(res.headers.location, url).href, accept, extraHeaders).then(resolve).catch(reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let body = Buffer.concat(chunks);
          const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
          try {
            if (encoding.includes("br")) body = zlib.brotliDecompressSync(body);
            else if (encoding.includes("gzip")) body = zlib.gunzipSync(body);
            else if (encoding.includes("deflate")) body = zlib.inflateSync(body);
          } catch {
            // keep raw body
          }
          resolve(body.toString("utf8"));
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
  });
}

async function fetchSmokeAndMirrorsCatalog() {
  const products = [];
  let page = 1;
  while (page <= 10) {
    const url = `${SMOKE_AND_MIRRORS_COLLECTION_URL}/products.json?limit=250&page=${page}`;
    const raw = await fetchUrl(url, "application/json");
    const data = JSON.parse(raw);
    const batch = Array.isArray(data?.products) ? data.products : [];
    if (!batch.length) break;
    products.push(...batch);
    if (batch.length < 250) break;
    page += 1;
    await sleep(150);
  }
  return parseSmokeAndMirrorsProducts({ products });
}

function pickPokeNeAccessToken(accessPayload) {
  const apps = accessPayload?.apps && typeof accessPayload.apps === "object" ? accessPayload.apps : {};
  const preferred = apps[POKENE_APP_ID];
  if (preferred && typeof preferred.accessToken === "string" && preferred.accessToken.trim()) {
    return preferred.accessToken.trim();
  }
  for (const app of Object.values(apps)) {
    const intId = Number(app && app.intId);
    const token = app && typeof app.accessToken === "string" ? app.accessToken.trim() : "";
    if (intId === POKENE_APP_INT_ID && token) return token;
  }
  return null;
}

function parsePokeNeProducts(products) {
  const items = [];
  for (const p of products) {
    const name = String(p.name || "").trim();
    if (!name) continue;
    const categories = Array.isArray(p.categories) ? p.categories : [];
    const inPokemonCategory = categories.some(
      (c) => String(c?.id || "") === POKENE_ALL_POKEMON_CATEGORY_ID
    );
    if (!inPokemonCategory) continue;

    const productUrl = String(p.pageUrl || "").trim() || POKENE_COLLECTION_URL;
    const discountedPrice = Number(p.discountedPrice);
    const basePrice = Number(p.price);
    const finalPrice = Number.isFinite(discountedPrice) ? discountedPrice : basePrice;
    const lastPrice =
      Number.isFinite(finalPrice) && finalPrice > 0 ? `$${finalPrice.toFixed(2)}` : null;

    const preorderFlag = String(p.productItemsPreOrderAvailability || "");
    const isPreorder = /pre[\s_-]*order/i.test(preorderFlag) || /pre[\s_-]*order/i.test(name);
    const inStock = p.isInStock === true;
    const status = isPreorder ? "preorder" : inStock ? "in_stock" : "out_of_stock";
    const statusLabel = isPreorder ? "Preorder" : inStock ? "In Stock" : "Out of Stock";

    items.push({
      name,
      retailer: "PokeNE",
      status,
      statusLabel,
      productUrl,
      statusUrl: productUrl,
      lastPrice,
      source: "pokene"
    });
  }
  return items;
}

async function fetchPokeNeCatalog() {
  const accessRaw = await fetchUrl(POKENE_ACCESS_TOKEN_URL, "application/json");
  const accessPayload = JSON.parse(accessRaw);
  const accessToken = pickPokeNeAccessToken(accessPayload);
  if (!accessToken) throw new Error("Could not resolve PokeNE app access token");

  const query = `
    query Products($offset: Int, $limit: Int) {
      catalog {
        products(offset: $offset, limit: $limit, onlyVisible: true) {
          totalCount
          list {
            id
            name
            price
            discountedPrice
            isInStock
            productItemsPreOrderAvailability
            pageUrl
            categories(withDefault: false) {
              id
              name
            }
          }
        }
      }
    }
  `;

  const allProducts = [];
  let offset = 0;
  const limit = 100;
  let totalCount = null;

  while (true) {
    const res = await fetch(POKENE_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        authorization: accessToken
      },
      body: JSON.stringify({ query, variables: { offset, limit } })
    });
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error(`PokeNE GraphQL HTTP ${res.status}: ${text.slice(0, 220)}`);
    }
    const payload = JSON.parse(text);
    const productsNode = payload?.data?.catalog?.products;
    const list = Array.isArray(productsNode?.list) ? productsNode.list : [];
    if (!list.length) break;
    allProducts.push(...list);
    totalCount = Number(productsNode?.totalCount || totalCount || 0);
    offset += list.length;
    if (list.length < limit) break;
    if (Number.isFinite(totalCount) && offset >= totalCount) break;
    await sleep(200);
  }

  return parsePokeNeProducts(allProducts);
}

function nextItemId(items) {
  let max = 0;
  for (const item of items) {
    const n = Number(item.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function applyCatalogToItems(items, catalogItems, retailer, options = {}) {
  const missingMeansOutOfStock = options.missingMeansOutOfStock === true;
  const nowIso = options.nowIso || new Date().toISOString();
  const byUrl = new Map();
  for (const row of catalogItems) {
    const key = normalizeProductUrl(row.productUrl);
    if (key) byUrl.set(key, row);
  }

  let statusUpdates = 0;
  let priceUpdates = 0;
  let added = 0;
  const seen = new Set();

  for (const item of items) {
    if (String(item.retailer || "") !== retailer) continue;
    const key = normalizeProductUrl(item.productUrl || item.statusUrl);
    if (!key) continue;
    const live = byUrl.get(key);
    if (!live) {
      if (missingMeansOutOfStock && String(item.status || "").toLowerCase() !== "out_of_stock") {
        item.status = "out_of_stock";
        item.statusLabel = "Out of Stock";
        statusUpdates += 1;
      }
      continue;
    }
    seen.add(key);

    const prevStatus = String(item.status || "");
    const nextStatus = String(live.status || prevStatus);
    if (nextStatus && nextStatus !== prevStatus) {
      item.status = live.status;
      item.statusLabel = live.statusLabel || item.statusLabel;
      statusUpdates += 1;
    } else if (live.statusLabel) {
      item.statusLabel = live.statusLabel;
    }

    if (live.lastPrice && live.lastPrice !== item.lastPrice) {
      item.lastPrice = live.lastPrice;
      priceUpdates += 1;
    }

    if (String(item.status || "").toLowerCase() === "in_stock") {
      item.lastAvailable = nowIso;
    }
    item.statusUrl = item.statusUrl || live.statusUrl || live.productUrl;
  }

  for (const live of catalogItems) {
    const key = normalizeProductUrl(live.productUrl);
    if (!key || seen.has(key)) continue;
    // Only auto-add currently available / preorder listings.
    const status = String(live.status || "").toLowerCase();
    if (status !== "in_stock" && status !== "preorder") continue;
    items.push({
      id: nextItemId(items),
      ...live,
      lastAvailable: status === "in_stock" ? nowIso : live.lastAvailable || null
    });
    added += 1;
    seen.add(key);
  }

  return { statusUpdates, priceUpdates, added, catalogCount: catalogItems.length };
}

async function refreshSmokeAndMirrorsCatalog(items, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  onProgress?.({ phase: "smoke", label: "Fetching Smoke & Mirrors catalog…", percent: 0 });
  const catalog = await fetchSmokeAndMirrorsCatalog();
  onProgress?.({
    phase: "smoke",
    label: `Applying Smoke & Mirrors catalog (${catalog.length})…`,
    percent: 60
  });
  const result = applyCatalogToItems(items, catalog, "Smoke & Mirrors Hobby", {
    missingMeansOutOfStock: true,
    nowIso: options.nowIso
  });
  onProgress?.({
    phase: "smoke",
    label: `Smoke & Mirrors updated (${result.statusUpdates} status, ${result.priceUpdates} price)`,
    percent: 100
  });
  return result;
}

async function refreshPokeNeCatalog(items, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  onProgress?.({ phase: "pokene", label: "Fetching PokeNE catalog…", percent: 0 });
  const catalog = await fetchPokeNeCatalog();
  onProgress?.({
    phase: "pokene",
    label: `Applying PokeNE catalog (${catalog.length})…`,
    percent: 70
  });
  const result = applyCatalogToItems(items, catalog, "PokeNE", {
    missingMeansOutOfStock: false,
    nowIso: options.nowIso
  });
  onProgress?.({
    phase: "pokene",
    label: `PokeNE updated (${result.statusUpdates} status, ${result.priceUpdates} price)`,
    percent: 100
  });
  return result;
}

module.exports = {
  refreshSmokeAndMirrorsCatalog,
  refreshPokeNeCatalog,
  fetchSmokeAndMirrorsCatalog,
  fetchPokeNeCatalog,
  normalizeProductUrl
};
