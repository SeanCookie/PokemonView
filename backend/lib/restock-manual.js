const fsp = require("fs/promises");
const path = require("path");
const { writeJsonAtomic } = require("./write-json-atomic");

function randomId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e7)}`;
}

function normalizeProductUrl(url) {
  return String(url || "").trim();
}

function detectRetailerFromUrl(productUrl) {
  const text = String(productUrl || "").toLowerCase();
  if (text.includes("amazon.com")) return "Amazon";
  if (text.includes("walmart.com")) return "Walmart";
  if (text.includes("target.com")) return "Target";
  if (text.includes("tcgplayer.com")) return "TCGplayer";
  if (text.includes("bestbuy.com")) return "Best Buy";
  if (text.includes("gamestop.com")) return "GameStop";
  return "Other";
}

async function loadRestockManualItems(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function saveRestockManualItems(filePath, items) {
  await writeJsonAtomic(filePath, {
    ok: true,
    updatedAt: new Date().toISOString(),
    items: Array.isArray(items) ? items : []
  });
}

function mergeRestockTrackerPayload(basePayload, manualItems) {
  const base = basePayload && typeof basePayload === "object" ? basePayload : {};
  const imported = Array.isArray(base.items) ? base.items : [];
  const manual = Array.isArray(manualItems) ? manualItems : [];
  const seen = new Set();
  const merged = [];

  for (const row of [...imported, ...manual]) {
    const url = normalizeProductUrl(row?.productUrl).toLowerCase();
    const dedupeKey = url || `manual:${String(row?.id || row?.name || "").toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(row);
  }

  return {
    ...base,
    ok: base.ok !== false,
    items: merged,
    manualItemCount: manual.length,
    importedItemCount: imported.length
  };
}

async function addRestockManualItem(filePath, input = {}) {
  const name = String(input.name || "").trim();
  const productUrl = normalizeProductUrl(input.productUrl);
  if (!name) throw new Error("Product name is required");
  if (!productUrl) throw new Error("Product URL is required");
  try {
    new URL(productUrl);
  } catch {
    throw new Error("Product URL must be a valid http(s) link");
  }

  const items = await loadRestockManualItems(filePath);
  const duplicate = items.some((row) => normalizeProductUrl(row.productUrl).toLowerCase() === productUrl.toLowerCase());
  if (duplicate) throw new Error("This product URL is already in the manual restock list");

  const status = String(input.status || "unknown").trim().toLowerCase();
  const allowed = new Set(["in_stock", "out_of_stock", "preorder", "unknown"]);
  const normalizedStatus = allowed.has(status) ? status : "unknown";

  const item = {
    id: randomId(),
    name,
    retailer: String(input.retailer || "").trim() || detectRetailerFromUrl(productUrl),
    productUrl,
    status: normalizedStatus,
    statusLabel:
      normalizedStatus === "in_stock"
        ? "In Stock"
        : normalizedStatus === "out_of_stock"
          ? "Out of Stock"
          : normalizedStatus === "preorder"
            ? "Pre-order"
            : "Unknown",
    statusUrl: productUrl,
    lastPrice: String(input.lastPrice || "").trim() || null,
    lastAvailable: input.lastAvailable ? String(input.lastAvailable) : null,
    trackerSource: "admin-manual",
    addedAt: new Date().toISOString(),
    addedBy: String(input.addedBy || "").trim() || ""
  };

  items.push(item);
  await saveRestockManualItems(filePath, items);
  return item;
}

async function removeRestockManualItem(filePath, itemId) {
  const id = String(itemId || "").trim();
  if (!id) throw new Error("Item id is required");
  const items = await loadRestockManualItems(filePath);
  const next = items.filter((row) => String(row.id) !== id);
  if (next.length === items.length) throw new Error("Manual restock item not found");
  await saveRestockManualItems(filePath, next);
  return { removedId: id, remaining: next.length };
}

module.exports = {
  loadRestockManualItems,
  saveRestockManualItems,
  mergeRestockTrackerPayload,
  addRestockManualItem,
  removeRestockManualItem
};
