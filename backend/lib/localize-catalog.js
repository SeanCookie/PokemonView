const fsp = require("fs/promises");
const path = require("path");
const { writeJsonAtomic } = require("./write-json-atomic");
const {
  buildLocalImageIndexFromDisk,
  hydrateByCodeWithDiskImages,
  mergeLocalImagesIntoEntry
} = require("./local-card-images");
const {
  finalizeLocalCardDetailsFile,
  isDetailsCatalogComplete
} = require("./finalize-local-card-details");

const HTTP_URL = /^https?:\/\//i;
const PKMN_HOST = /pkmncards\.com/i;

function stripRemoteUrlsFromEntry(entry, diskLocalImages) {
  if (!entry || typeof entry !== "object") return entry;
  const hydrated = mergeLocalImagesIntoEntry(entry, diskLocalImages);
  const localImages =
    hydrated.localImages && typeof hydrated.localImages === "object" ? { ...hydrated.localImages } : {};
  const out = { ...hydrated };
  delete out.images;
  if (Object.keys(localImages).length) {
    out.localImages = localImages;
  } else {
    delete out.localImages;
  }
  if (out.sourceHref && PKMN_HOST.test(String(out.sourceHref))) {
    delete out.sourceHref;
  }
  return out;
}

function localizeByCode(byCode, diskIndex) {
  const out = {};
  for (const [code, entry] of Object.entries(byCode || {})) {
    const codeKey = String(code || "").toUpperCase();
    const disk = diskIndex.get(codeKey) || null;
    out[codeKey] = stripRemoteUrlsFromEntry(entry, disk);
  }
  return out;
}

function countRemoteImages(parsed) {
  let remote = 0;
  let local = 0;
  const walk = (byCode) => {
    for (const entry of Object.values(byCode || {})) {
      for (const url of Object.values(entry?.images || {})) {
        if (HTTP_URL.test(String(url))) remote += 1;
        else if (String(url).startsWith("/card-images/")) local += 1;
      }
      for (const url of Object.values(entry?.localImages || {})) {
        if (String(url).startsWith("/card-images/")) local += 1;
      }
    }
  };
  walk(parsed.byCode);
  for (const lang of ["english", "japanese"]) {
    walk(parsed.byLanguage?.[lang]?.byCode);
  }
  return { remote, local };
}

async function localizeSetCardListsFile({
  listsPath,
  cardImageDir,
  minLocalRefs = 1
} = {}) {
  const root = path.resolve(__dirname, "..", "..");
  const listsFile = listsPath || path.join(root, "backend", "data", "set-card-lists.json");
  const imageDir = cardImageDir || path.join(root, "backend", "data", "card-images");

  const raw = await fsp.readFile(listsFile, "utf8");
  const parsed = JSON.parse(raw);
  const before = countRemoteImages(parsed);
  const diskIndex = await buildLocalImageIndexFromDisk(imageDir);

  if (parsed.byLanguage && typeof parsed.byLanguage === "object") {
    for (const language of ["english", "japanese"]) {
      const node = parsed.byLanguage[language];
      if (!node?.byCode || typeof node.byCode !== "object") continue;
      node.byCode = localizeByCode(node.byCode, diskIndex);
    }
  }
  if (parsed.byCode && typeof parsed.byCode === "object") {
    parsed.byCode = localizeByCode(parsed.byCode, diskIndex);
  }

  const after = countRemoteImages(parsed);
  parsed.source = "local";
  parsed.localImageSnapshot = {
    generatedAt: new Date().toISOString(),
    source: "localize-catalog",
    setFoldersOnDisk: diskIndex.size,
    localImageRefs: after.local,
    remoteImageRefsRemoved: before.remote
  };

  await writeJsonAtomic(listsFile, parsed);

  if (after.local < minLocalRefs) {
    return {
      ok: false,
      error: `Only ${after.local} local image refs on disk (need ${minLocalRefs}+). Run download-card-images.js first.`,
      setFoldersOnDisk: diskIndex.size,
      localImageRefs: after.local
    };
  }

  return {
    ok: true,
    setFoldersOnDisk: diskIndex.size,
    localImageRefs: after.local,
    remoteImageRefsRemoved: before.remote
  };
}

async function localizeCatalogBundle(options = {}) {
  const listsResult = await localizeSetCardListsFile(options);
  if (!listsResult.ok) return listsResult;

  const root = path.resolve(__dirname, "..", "..");
  const detailsPath = path.join(root, "backend", "data", "set-card-details.json");
  const listsPath = path.join(root, "backend", "data", "set-card-lists.json");

  let detailsResult = { ok: false, skipped: true };
  try {
    const raw = await fsp.readFile(detailsPath, "utf8");
    const details = JSON.parse(raw);
    if (isDetailsCatalogComplete(details, 1)) {
      detailsResult = await finalizeLocalCardDetailsFile({
        detailsPath,
        listsPath,
        minSets: 1
      });
    }
  } catch {
    detailsResult = { ok: false, skipped: true };
  }

  return { ok: true, lists: listsResult, details: detailsResult };
}

module.exports = {
  localizeSetCardListsFile,
  localizeCatalogBundle,
  stripRemoteUrlsFromEntry
};
