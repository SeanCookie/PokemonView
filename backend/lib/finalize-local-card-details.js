const fsp = require("fs/promises");
const path = require("path");
const { writeJsonAtomic } = require("./write-json-atomic");
const { cardNoLookupKeys } = require("./local-card-images");

const PKMN_HOST = /pkmncards\.com/i;

function pickLocalImageUrl(localImages, cardNo) {
  if (!localImages || typeof localImages !== "object") return "";
  for (const key of cardNoLookupKeys(cardNo)) {
    const v = String(localImages[key] || "").trim();
    if (v.startsWith("/card-images/") || v.startsWith("/card-images-japanese/")) return v;
  }
  return "";
}

function stripExternalDetailUrls(card, localImageUrl) {
  const out = { ...card };
  if (localImageUrl) {
    out.localImageUrl = localImageUrl;
  }
  if (out.cardUrl && PKMN_HOST.test(String(out.cardUrl))) {
    delete out.cardUrl;
  }
  if (out.imageUrl && PKMN_HOST.test(String(out.imageUrl))) {
    if (localImageUrl) {
      out.imageUrl = localImageUrl;
    } else {
      delete out.imageUrl;
    }
  }
  return out;
}

function getListsByCode(parsedLists) {
  if (parsedLists?.byLanguage?.english?.byCode && typeof parsedLists.byLanguage.english.byCode === "object") {
    return parsedLists.byLanguage.english.byCode;
  }
  if (parsedLists?.byCode && typeof parsedLists.byCode === "object") {
    return parsedLists.byCode;
  }
  return {};
}

/**
 * Make card-details self-contained: local image paths only, no PkmnCards URLs required at runtime.
 */
function finalizeCardDetailsPayload(detailsPayload, listsPayload) {
  const listsByCode = getListsByCode(listsPayload);
  const byCode =
    detailsPayload && detailsPayload.byCode && typeof detailsPayload.byCode === "object"
      ? detailsPayload.byCode
      : {};
  const outByCode = {};
  let cardCount = 0;

  for (const [code, entry] of Object.entries(byCode)) {
    const codeKey = String(code || "").toUpperCase();
    const listEntry = listsByCode[codeKey] || listsByCode[code];
    const localImages =
      listEntry && listEntry.localImages && typeof listEntry.localImages === "object"
        ? listEntry.localImages
        : {};
    const cardsIn = entry && entry.cards && typeof entry.cards === "object" ? entry.cards : {};
    const cardsOut = {};
    for (const [cardNo, card] of Object.entries(cardsIn)) {
      const localImageUrl = pickLocalImageUrl(localImages, cardNo);
      cardsOut[cardNo] = stripExternalDetailUrls(card, localImageUrl);
      cardCount += 1;
    }
    const { failures, skippedNotInManifest, ...rest } = entry || {};
    outByCode[codeKey] = {
      ...rest,
      sourceHref: rest.sourceHref || listEntry?.sourceHref || "",
      sourceTitle: rest.sourceTitle || listEntry?.sourceTitle || codeKey,
      totalCards: Object.keys(cardsOut).length,
      cards: cardsOut
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "local",
    complete: true,
    localizedAt: new Date().toISOString(),
    runtimeNote: "Card text/details served from this file only; PkmnCards not required at runtime.",
    setCount: Object.keys(outByCode).length,
    cardCount,
    byCode: outByCode
  };
}

function isDetailsCatalogComplete(detailsPayload, minSets = 80) {
  if (!detailsPayload || detailsPayload.complete !== true) return false;
  const setCount = Object.keys(detailsPayload.byCode || {}).length;
  return setCount >= minSets;
}

async function finalizeLocalCardDetailsFile({
  detailsPath,
  listsPath,
  minSets = 80
} = {}) {
  const root = path.resolve(__dirname, "..");
  const detailsFile = detailsPath || path.join(root, "data", "set-card-details.json");
  const listsFile = listsPath || path.join(root, "data", "set-card-lists.json");

  const detailsPayload = JSON.parse(await fsp.readFile(detailsFile, "utf8"));
  const listsPayload = JSON.parse(await fsp.readFile(listsFile, "utf8"));
  const setCount = Object.keys(detailsPayload.byCode || {}).length;
  if (setCount < minSets) {
    return {
      ok: false,
      skipped: true,
      reason: `Only ${setCount} detail sets (need ${minSets}+ before finalize)`,
      setCount
    };
  }

  const finalized = finalizeCardDetailsPayload(detailsPayload, listsPayload);
  await writeJsonAtomic(detailsFile, finalized);
  return {
    ok: true,
    skipped: false,
    setCount: finalized.setCount,
    cardCount: finalized.cardCount,
    path: detailsFile
  };
}

module.exports = {
  finalizeCardDetailsPayload,
  finalizeLocalCardDetailsFile,
  isDetailsCatalogComplete,
  pickLocalImageUrl
};
