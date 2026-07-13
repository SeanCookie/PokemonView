const AMAZON_AFFILIATE_PARAMS = new Set([
  "tag",
  "linkCode",
  "th",
  "psc",
  "m",
  "aod",
  "linkId"
]);

const WHOLESALE_BASE = "https://wholesalegaming.com/pokemon/";
const SMOKE_AND_MIRRORS_COLLECTION_URL =
  "https://smokeandmirrorshobby.com/collections/pokemon-in-stock";
const SMOKE_AND_MIRRORS_PRODUCTS_JSON = `${SMOKE_AND_MIRRORS_COLLECTION_URL}/products.json?limit=250`;

function decodeHtml(text) {
  return String(text || "")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return decodeHtml(String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function cleanAmazonUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("amazon.com")) return url;
    for (const key of [...parsed.searchParams.keys()]) {
      if (AMAZON_AFFILIATE_PARAMS.has(key)) {
        parsed.searchParams.delete(key);
      }
    }
    if ([...parsed.searchParams.keys()].length === 0) {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function isMavelyUrl(url) {
  return /mavely\.app\.link/i.test(String(url || ""));
}

function targetSearchUrl(productName) {
  return `https://www.target.com/s?searchTerm=${encodeURIComponent(productName)}`;
}

function walmartSearchUrl(productName) {
  return `https://www.walmart.com/search?q=${encodeURIComponent(productName)}`;
}

function bestBuySearchUrl(productName) {
  return `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(productName)}`;
}

function isRetailer(retailer, name) {
  return String(retailer || "")
    .trim()
    .toLowerCase() === String(name || "").trim().toLowerCase();
}

/** Unwrap Skimlinks, Walmart goto, Best Buy impact, etc. */
function unwrapAffiliateUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host.includes("skimresources.com")) {
      const dest = parsed.searchParams.get("url");
      if (dest) return unwrapAffiliateUrl(dest);
    }
    if (host.includes("goto.walmart.com")) {
      const dest = parsed.searchParams.get("u");
      if (dest) return unwrapAffiliateUrl(dest);
    }
    if (host.includes("7tiv.net")) {
      const dest = parsed.searchParams.get("u");
      if (dest) return unwrapAffiliateUrl(dest);
    }
    return url;
  } catch {
    return url;
  }
}

function isAffiliateWrapperUrl(url) {
  const s = String(url || "").toLowerCase();
  return (
    s.includes("skimresources.com") ||
    s.includes("goto.walmart.com") ||
    s.includes("7tiv.net")
  );
}

function cleanWalmartUrl(url) {
  const unwrapped = unwrapAffiliateUrl(url);
  try {
    const parsed = new URL(unwrapped);
    if (!parsed.hostname.includes("walmart.com")) return unwrapped;
    if (parsed.pathname.includes("/ip/")) {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return unwrapped;
  } catch {
    return unwrapped;
  }
}

/** Numeric Walmart product id from /ip/.../123456 URLs. */
function walmartItemIdFromUrl(url) {
  try {
    const pathname = new URL(cleanWalmartUrl(url) || url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (/^\d{6,}$/.test(segments[i])) return segments[i];
    }
    return null;
  } catch {
    return null;
  }
}

function filterWalmartExcludedItems(items, exclusionIds) {
  if (!exclusionIds || !exclusionIds.size) return items;
  return items.filter((item) => {
    const id = walmartItemIdFromUrl(item.productUrl || item.statusUrl);
    if (!id) return true;
    return !exclusionIds.has(id);
  });
}

function cleanBestBuyUrl(url) {
  const unwrapped = unwrapAffiliateUrl(url);
  try {
    const parsed = new URL(unwrapped);
    if (!parsed.hostname.includes("bestbuy.com")) return unwrapped;
    if (parsed.pathname.includes("/product/")) {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return unwrapped;
  } catch {
    return unwrapped;
  }
}

function cleanTargetUrl(url, productName) {
  if (!url || typeof url !== "string") return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("target.com")) return url;
    if (parsed.pathname === "/s" || parsed.pathname === "/s/") {
      const q = parsed.searchParams.get("searchTerm") || productName || "";
      return targetSearchUrl(q);
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Strip affiliate wrappers and tracking params from retailer URLs. */
function cleanTrackerUrl(url, retailer, productName) {
  if (!url || typeof url !== "string") return url;

  if (isMavelyUrl(url)) {
    if (isRetailer(retailer, "Target")) return targetSearchUrl(productName);
    if (isRetailer(retailer, "Walmart")) return walmartSearchUrl(productName);
    if (isRetailer(retailer, "Best Buy")) return bestBuySearchUrl(productName);
    return null;
  }

  let cleaned = unwrapAffiliateUrl(url);

  if (isAffiliateWrapperUrl(cleaned)) {
    if (retailer === "Walmart") return walmartSearchUrl(productName);
    if (retailer === "Best Buy") return bestBuySearchUrl(productName);
    return null;
  }

  if (isRetailer(retailer, "Target") || cleaned.includes("target.com")) {
    cleaned = cleanTargetUrl(cleaned, productName);
  } else if (isRetailer(retailer, "Walmart") || cleaned.includes("walmart.com")) {
    cleaned = cleanWalmartUrl(cleaned);
  } else if (isRetailer(retailer, "Best Buy") || cleaned.includes("bestbuy.com")) {
    cleaned = cleanBestBuyUrl(cleaned);
  } else {
    cleaned = cleanAmazonUrl(cleaned);
  }

  return cleaned;
}

function resolveWholesaleUrl(href) {
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  return new URL(href.replace(/^\//, ""), WHOLESALE_BASE).href;
}

function parseLink(cell) {
  const m = String(cell || "")
    .trim()
    .match(/^\[([\s\S]*)\]\((https?:\/\/[^)]+)\)$/);
  if (!m) return { text: String(cell || "").trim(), url: null };
  return { text: m[1], url: m[2] };
}

function splitNameRetailer(fullName) {
  const idx = fullName.lastIndexOf(" : ");
  if (idx === -1) return { name: fullName, retailer: "Unknown" };
  return {
    name: fullName.slice(0, idx).trim(),
    retailer: fullName.slice(idx + 3).trim()
  };
}

function normalizeNowInStockStatus(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("in stock")) return "in_stock";
  if (s.includes("preorder")) return "preorder";
  if (s.includes("out of stock")) return "out_of_stock";
  return "unknown";
}

function normalizeWholesaleStatus(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("in stock")) return "in_stock";
  if (s.includes("presale") || s.includes("preorder")) return "preorder";
  if (s.includes("unavailable") || s.includes("out of stock")) return "out_of_stock";
  return "unknown";
}

function extractPriceFromCell(html) {
  const text = stripHtml(html);
  if (!text || text === "--") return null;
  const match = text.match(/\$[\d,]+(?:\.\d{2})?/);
  return match ? match[0] : text || null;
}

function parseNowInStockMarkdown(raw) {
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("| [")) continue;
    if (/^\|\s*Name\s*\|/i.test(line)) continue;

    const parts = line
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 4) continue;

    const nameCell = parseLink(parts[0]);
    const statusCell = parseLink(parts[1]);
    const { name, retailer } = splitNameRetailer(nameCell.text);
    const nameLower = String(name || "").trim().toLowerCase();
    const retailerLower = String(retailer || "").trim().toLowerCase();
    const productUrlRaw = String(nameCell.url || "").toLowerCase();
    const statusUrlRaw = String(statusCell.url || "").toLowerCase();

    // Drop generic eBay listing rows like "Ebay : All Models" from NowInStock.
    if (
      productUrlRaw.includes("ebay.com") ||
      statusUrlRaw.includes("ebay.com") ||
      nameLower === "ebay" ||
      retailerLower === "ebay" ||
      retailerLower === "all models"
    ) {
      continue;
    }

    items.push({
      name,
      retailer,
      productUrl: cleanTrackerUrl(nameCell.url, retailer, name),
      status: normalizeNowInStockStatus(statusCell.text),
      statusLabel: statusCell.text,
      statusUrl: cleanTrackerUrl(statusCell.url, retailer, name),
      lastPrice: parts[2] === "-" ? null : parts[2],
      lastAvailable: parts[3] === "-" ? null : parts[3],
      trackerSource: "nowinstock"
    });
  }
  return items;
}

function parseWholesaleGamingMarkdown(raw) {
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("| [")) continue;
    if (/Contents:\s*\|/i.test(line) || /Pokemon Products:/i.test(line)) continue;

    const parts = line
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 4) continue;

    const nameCell = parseLink(parts[0]);
    if (!nameCell.url || !nameCell.url.includes("wholesalegaming.com")) continue;

    const priceRaw = parts[2];
    const availability = parts[3];

    items.push({
      name: nameCell.text,
      retailer: "Wholesale Gaming",
      productUrl: nameCell.url,
      status: normalizeWholesaleStatus(availability),
      statusLabel: availability,
      statusUrl: nameCell.url,
      lastPrice: priceRaw === "--" ? null : priceRaw,
      lastAvailable: null,
      trackerSource: "wholesale_gaming"
    });
  }
  return items;
}

function parseWholesaleGamingHtml(html) {
  const items = [];
  const rowRe = /<tr\s+bgcolor="#FFFFFF">([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowRe.exec(html)) !== null) {
    const row = match[1];
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (tds.length < 4) continue;

    const linkMatch = tds[0].match(
      /<a\s+CLASS="anylink"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
    );
    if (!linkMatch) continue;

    const name = stripHtml(linkMatch[2]);
    if (!name || /^(Pokemon Products|Pokemon TCG Products|Contents|Price|Availability):?$/i.test(name)) {
      continue;
    }

    const productUrl = resolveWholesaleUrl(linkMatch[1]);
    const availability = stripHtml(tds[3]);
    const lastPrice = extractPriceFromCell(tds[2]);

    items.push({
      name,
      retailer: "Wholesale Gaming",
      productUrl,
      status: normalizeWholesaleStatus(availability),
      statusLabel: availability,
      statusUrl: productUrl,
      lastPrice,
      lastAvailable: null,
      trackerSource: "wholesale_gaming"
    });
  }

  return items;
}

function formatShopifyPrice(price) {
  const amount = Number(price);
  if (!Number.isFinite(amount)) return null;
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function normalizeSmokeTitle(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/pokémon/g, "pokemon")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSmokeAndMirrorsMarkdown(raw) {
  const items = [];
  const blocks = String(raw || "").split(/^##\s+/m);

  for (const block of blocks) {
    const titleLine = (block.split("\n")[0] || "").replace(/\s+/g, " ").trim();
    if (!/pok[eé]mon\s+tcg/i.test(titleLine)) continue;

    const priceMatch = block.match(/Current price\s+\$([\d,]+(?:\.\d{2})?)/i);
    const lastPrice = priceMatch ? `$${priceMatch[1]}` : null;

    let status = "out_of_stock";
    let statusLabel = "Out of Stock";
    if (/\bIn stock\b/i.test(block)) {
      status = "in_stock";
      statusLabel = "In Stock";
    } else if (/\bLow stock\b/i.test(block)) {
      status = "in_stock";
      statusLabel = "Low stock";
    }

    items.push({
      name: titleLine,
      retailer: "Smoke & Mirrors Hobby",
      productUrl: "",
      status,
      statusLabel,
      statusUrl: SMOKE_AND_MIRRORS_COLLECTION_URL,
      lastPrice,
      lastAvailable: null,
      trackerSource: "smoke_and_mirrors"
    });
  }

  return items;
}

function mergeSmokeAndMirrorsItems(apiItems, markdownItems) {
  const byTitle = new Map();
  for (const item of apiItems) {
    byTitle.set(normalizeSmokeTitle(item.name), item);
  }

  const byUrl = new Map();
  for (const item of apiItems) {
    const key = String(item.productUrl || "").trim().toLowerCase();
    if (key) byUrl.set(key, { ...item });
  }

  for (const md of markdownItems) {
    const titleKey = normalizeSmokeTitle(md.name);
    let matched = byTitle.get(titleKey);
    if (!matched) {
      for (const [key, candidate] of byTitle.entries()) {
        if (key.includes(titleKey) || titleKey.includes(key)) {
          matched = candidate;
          break;
        }
      }
    }

    if (matched) {
      const urlKey = matched.productUrl.toLowerCase();
      const existing = byUrl.get(urlKey) || { ...matched };
      byUrl.set(urlKey, {
        ...existing,
        name: md.name || existing.name,
        status: md.status === "in_stock" ? md.status : existing.status,
        statusLabel: md.statusLabel || existing.statusLabel,
        lastPrice: md.lastPrice || existing.lastPrice,
        statusUrl: matched.productUrl,
        productUrl: matched.productUrl
      });
      continue;
    }

    if (!md.name) continue;
    const fallbackKey = `title:${titleKey}`;
    if (byUrl.has(fallbackKey)) continue;
    byUrl.set(fallbackKey, {
      ...md,
      productUrl: md.productUrl || SMOKE_AND_MIRRORS_COLLECTION_URL,
      statusUrl: md.statusUrl || SMOKE_AND_MIRRORS_COLLECTION_URL
    });
  }

  return [...byUrl.values()].filter((item) => item.name);
}

function dedupeRestockItems(items) {
  const seen = new Map();
  for (const item of items) {
    const urlKey = String(item.productUrl || "").trim().toLowerCase();
    const key =
      urlKey && !urlKey.endsWith("/collections/pokemon-in-stock")
        ? urlKey
        : `${item.trackerSource || item.retailer}|${normalizeSmokeTitle(item.name)}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, item);
      continue;
    }
    const pickCurrent =
      (item.status === "in_stock" && prev.status !== "in_stock") ||
      (item.lastPrice && !prev.lastPrice);
    seen.set(key, pickCurrent ? { ...prev, ...item } : { ...item, ...prev });
  }
  return [...seen.values()];
}

function parseSmokeAndMirrorsProducts(data) {
  const products = Array.isArray(data?.products) ? data.products : [];
  const items = [];

  for (const product of products) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const availableVariants = variants.filter((v) => v.available);
    const anyAvailable = availableVariants.length > 0;
    const priceVariant = availableVariants[0] || variants[0];
    const handle = product.handle;
    const productUrl = handle
      ? `https://smokeandmirrorshobby.com/products/${handle}`
      : SMOKE_AND_MIRRORS_COLLECTION_URL;

    items.push({
      name: String(product.title || "").trim(),
      retailer: "Smoke & Mirrors Hobby",
      productUrl,
      status: anyAvailable ? "in_stock" : "out_of_stock",
      statusLabel: anyAvailable ? "In Stock" : "Out of Stock",
      statusUrl: productUrl,
      lastPrice: priceVariant ? formatShopifyPrice(priceVariant.price) : null,
      lastAvailable: null,
      trackerSource: "smoke_and_mirrors"
    });
  }

  return items.filter((item) => item.name);
}

module.exports = {
  cleanAmazonUrl,
  cleanWalmartUrl,
  walmartItemIdFromUrl,
  filterWalmartExcludedItems,
  cleanBestBuyUrl,
  cleanTrackerUrl,
  parseNowInStockMarkdown,
  parseWholesaleGamingMarkdown,
  parseWholesaleGamingHtml,
  parseSmokeAndMirrorsMarkdown,
  parseSmokeAndMirrorsProducts,
  mergeSmokeAndMirrorsItems,
  dedupeRestockItems,
  normalizeSmokeTitle,
  WHOLESALE_BASE,
  SMOKE_AND_MIRRORS_COLLECTION_URL,
  SMOKE_AND_MIRRORS_PRODUCTS_JSON
};
