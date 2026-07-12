"use strict";

const { cardNoLookupKeys } = require("./local-card-images");

function normalizeSetTitle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/é/g, "e")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildSetTitleToCodeMap(manifest) {
  const map = {};
  const byCode = manifest?.byCode && typeof manifest.byCode === "object" ? manifest.byCode : {};
  for (const [code, entry] of Object.entries(byCode)) {
    const titles = [entry?.sourceTitle, entry?.name, entry?.setName].filter(Boolean);
    const upper = String(code || "").trim().toUpperCase();
    if (!upper) continue;
    for (const title of titles) {
      const key = normalizeSetTitle(title);
      if (key && !map[key]) map[key] = upper;
    }
  }
  return map;
}

function buildShowcaseSetLookup(englishManifest, japaneseManifest) {
  return {
    titleToCode: {
      english: buildSetTitleToCodeMap(englishManifest),
      japanese: buildSetTitleToCodeMap(japaneseManifest)
    },
    byCode: {
      english: englishManifest?.byCode || {},
      japanese: japaneseManifest?.byCode || {}
    }
  };
}

function resolveSetCodeForItem(item, lookup) {
  const existing = String(item?.setCode || "")
    .trim()
    .toUpperCase();
  if (existing) return existing;
  const lang = String(item?.setLanguage || "").toLowerCase() === "japanese" ? "japanese" : "english";
  const key = normalizeSetTitle(item?.setName);
  if (!key) return "";
  return (
    lookup?.titleToCode?.[lang]?.[key] ||
    lookup?.titleToCode?.english?.[key] ||
    ""
  );
}

function pickImageFromRecord(record, cardNumber) {
  if (!record) return "";
  const maps = [
    record.localImages,
    record.images,
    record.cards && typeof record.cards === "object"
      ? Object.fromEntries(
          Object.entries(record.cards).filter(([, v]) => typeof v === "string" && v.startsWith("/"))
        )
      : null
  ];
  for (const imgs of maps) {
    if (!imgs || typeof imgs !== "object") continue;
    for (const key of cardNoLookupKeys(cardNumber)) {
      const url = imgs[key];
      if (typeof url === "string" && url.trim()) return url.trim();
    }
  }
  return "";
}

function resolveShowcaseImageUrl(item, lookup) {
  const saved = String(item?.imageUrl || "").trim();
  if (saved) return saved;
  if (item?.type !== "single") return "";
  const setCode = resolveSetCodeForItem(item, lookup);
  if (!setCode) return "";
  const lang = String(item?.setLanguage || "").toLowerCase() === "japanese" ? "japanese" : "english";
  const entry =
    lookup?.byCode?.[lang]?.[setCode] || lookup?.byCode?.english?.[setCode] || null;
  return pickImageFromRecord(entry, item.cardNumber);
}

function resolveCanonicalCardNumber(item, lookup) {
  const setCode = String(item?.setCode || "")
    .trim()
    .toUpperCase();
  const cardNumber = String(item?.cardNumber || "").trim();
  if (!setCode || !cardNumber) return cardNumber;
  const lang = String(item?.setLanguage || "").toLowerCase() === "japanese" ? "japanese" : "english";
  const entry = lookup?.byCode?.[lang]?.[setCode] || lookup?.byCode?.english?.[setCode];
  const cards = entry?.cards;
  if (!cards || typeof cards !== "object") return cardNumber;
  for (const key of cardNoLookupKeys(cardNumber)) {
    if (Object.prototype.hasOwnProperty.call(cards, key)) return key;
  }
  return cardNumber;
}

function primaryCardNumberForSetsLink(cardNumber) {
  const q = String(cardNumber || "").trim();
  const slash = q.match(/^([^/]+)\s*\/\s*.+$/);
  if (slash) return slash[1].trim();
  return q;
}

function buildShowcaseCardHref(item, showcaseReturnPath = "") {
  if (item?.type !== "single") return "";
  const setCode = String(item?.setCode || "")
    .trim()
    .toUpperCase();
  const cardNo = primaryCardNumberForSetsLink(item?.cardNumber);
  if (!setCode || !cardNo) return "";
  const params = new URLSearchParams({ set: setCode, card: cardNo });
  if (String(item?.setLanguage || "").toLowerCase() === "japanese") {
    params.set("lang", "ja");
  }
  const showcasePath = String(showcaseReturnPath || "").trim();
  if (showcasePath) params.set("showcase", showcasePath);
  return `/sets.html?${params.toString()}`;
}

function attachShowcaseLinks(item) {
  return {
    ...item,
    cardUrl: buildShowcaseCardHref(item)
  };
}

module.exports = {
  normalizeSetTitle,
  buildSetTitleToCodeMap,
  buildShowcaseSetLookup,
  resolveSetCodeForItem,
  resolveCanonicalCardNumber,
  primaryCardNumberForSetsLink,
  resolveShowcaseImageUrl,
  buildShowcaseCardHref,
  attachShowcaseLinks
};
