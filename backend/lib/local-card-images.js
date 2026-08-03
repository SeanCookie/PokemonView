const fsp = require("fs/promises");
const path = require("path");
const { isLfsPointer } = require("./github-lfs-materialize");

const CARD_NO_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

function makeLocalCardUrl(setCode, filename) {
  return `/card-images/${encodeURIComponent(String(setCode || "").toUpperCase())}/${encodeURIComponent(filename)}`;
}

function cardNoFromFilename(filename) {
  return String(filename || "").replace(CARD_NO_EXT, "").trim();
}

function cardNoLookupKeys(cardNumberRaw) {
  const no = String(cardNumberRaw || "").trim();
  if (!no) return [];
  const keys = new Set([no]);
  // Collectr / printed form "232/091" → also try "232"
  const slash = no.match(/^([^/]+)\s*\/\s*.+$/);
  if (slash) {
    for (const part of cardNoLookupKeys(slash[1].trim())) keys.add(part);
  }
  const n = Number(no);
  if (Number.isFinite(n)) {
    keys.add(String(n));
    keys.add(String(n).padStart(3, "0"));
  }
  const promo = no.match(/^(\d+)([a-zA-Z]+)$/);
  if (promo) {
    const base = promo[1];
    const suffix = promo[2];
    keys.add(base);
    const bn = Number(base);
    if (Number.isFinite(bn)) {
      keys.add(String(bn).padStart(3, "0") + suffix);
      keys.add(String(bn) + suffix);
    }
  }
  return [...keys];
}

function registerLocalImage(map, cardNoRaw, localUrl) {
  for (const key of cardNoLookupKeys(cardNoRaw)) {
    if (!map[key]) map[key] = localUrl;
  }
}

/**
 * Scan backend/data/card-images/{SET}/ files and build localImages maps per set code.
 */
async function buildLocalImageIndexFromDisk(cardImageDir) {
  const bySetCode = new Map();
  let entries;
  try {
    entries = await fsp.readdir(cardImageDir, { withFileTypes: true });
  } catch {
    return bySetCode;
  }

  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const folderName = dirent.name;
    const code = decodeURIComponent(folderName).toUpperCase();
    const setDir = path.join(cardImageDir, folderName);
    let files;
    try {
      files = await fsp.readdir(setDir);
    } catch {
      continue;
    }
    const localImages = {};
    for (const filename of files) {
      if (!CARD_NO_EXT.test(filename)) continue;
      const filePath = path.join(setDir, filename);
      let head;
      try {
        head = await fsp.readFile(filePath);
      } catch {
        continue;
      }
      if (isLfsPointer(head)) continue;
      const cardNo = cardNoFromFilename(filename);
      if (!cardNo) continue;
      registerLocalImage(localImages, cardNo, makeLocalCardUrl(code, filename));
    }
    if (Object.keys(localImages).length) {
      bySetCode.set(code, localImages);
    }
  }
  return bySetCode;
}

function mergeLocalImagesIntoEntry(entry, diskLocalImages) {
  if (!entry) return entry;
  if (!diskLocalImages || !Object.keys(diskLocalImages).length) {
    return entry;
  }
  return {
    ...entry,
    // Disk wins per key, but keep any catalog-only entries (e.g. HIF SV remote art).
    localImages: { ...(entry.localImages || {}), ...diskLocalImages }
  };
}

function hydrateByCodeWithDiskImages(byCode, diskIndex) {
  if (!byCode || typeof byCode !== "object") return byCode;
  const out = {};
  for (const [code, entry] of Object.entries(byCode)) {
    const codeKey = String(code || "").toUpperCase();
    const disk = diskIndex && diskIndex.size ? diskIndex.get(codeKey) : null;
    out[codeKey] = mergeLocalImagesIntoEntry(entry, disk);
  }
  return out;
}

module.exports = {
  makeLocalCardUrl,
  cardNoLookupKeys,
  buildLocalImageIndexFromDisk,
  hydrateByCodeWithDiskImages,
  mergeLocalImagesIntoEntry
};
