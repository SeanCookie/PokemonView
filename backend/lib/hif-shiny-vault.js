const SET_CODE = "HIF";

function sortShinyVaultKeys(keys) {
  return [...keys].sort((a, b) => {
    const asv = /^SV(\d+)$/i.exec(a);
    const bsv = /^SV(\d+)$/i.exec(b);
    if (asv && bsv) return Number(asv[1]) - Number(bsv[1]);
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  });
}

function isShinyVaultCardKey(key) {
  return /^SV\d+$/i.test(String(key || "").trim());
}

function localShinyVaultImageUrl(cardNo) {
  const no = String(cardNo || "").trim().toUpperCase();
  if (!isShinyVaultCardKey(no)) return "";
  return `/card-images/${SET_CODE}/${encodeURIComponent(no)}.jpg`;
}

/**
 * Ensure HIF Shiny Vault cards keep local /card-images/HIF/SVn.jpg paths.
 * Does not fetch remote hosts — SV art must already live under card-images/HIF.
 */
function mergeShinyVaultIntoHifEntry(hifEntry, shiny) {
  if (!hifEntry || !shiny?.cards) return 0;
  hifEntry.cards = hifEntry.cards && typeof hifEntry.cards === "object" ? hifEntry.cards : {};
  hifEntry.localImages =
    hifEntry.localImages && typeof hifEntry.localImages === "object" ? hifEntry.localImages : {};

  let added = 0;
  for (const [cardNo, name] of Object.entries(shiny.cards)) {
    if (!isShinyVaultCardKey(cardNo)) continue;
    if (!hifEntry.cards[cardNo]) added += 1;
    hifEntry.cards[cardNo] = name;
    const localUrl = localShinyVaultImageUrl(cardNo);
    if (localUrl) hifEntry.localImages[cardNo] = localUrl;
  }
  delete hifEntry.images;
  delete hifEntry.shinyVaultSource;
  hifEntry.totalCards = Object.keys(hifEntry.cards).length;
  return added;
}

function preserveShinyVaultFromPrevious(hifEntry, prevEntry) {
  if (!hifEntry || !prevEntry?.cards) return 0;
  let preserved = 0;
  hifEntry.cards = hifEntry.cards && typeof hifEntry.cards === "object" ? hifEntry.cards : {};
  hifEntry.localImages =
    hifEntry.localImages && typeof hifEntry.localImages === "object" ? hifEntry.localImages : {};

  for (const [cardNo, name] of Object.entries(prevEntry.cards)) {
    if (!isShinyVaultCardKey(cardNo)) continue;
    if (!hifEntry.cards[cardNo]) preserved += 1;
    hifEntry.cards[cardNo] = name;
    const prevLocal = prevEntry.localImages?.[cardNo];
    if (prevLocal && String(prevLocal).startsWith("/card-images/")) {
      hifEntry.localImages[cardNo] = prevLocal;
    } else {
      hifEntry.localImages[cardNo] = localShinyVaultImageUrl(cardNo);
    }
  }
  delete hifEntry.images;
  delete hifEntry.shinyVaultSource;
  hifEntry.totalCards = Object.keys(hifEntry.cards).length;
  return preserved;
}

function countShinyVaultCards(entry) {
  if (!entry?.cards) return 0;
  return Object.keys(entry.cards).filter(isShinyVaultCardKey).length;
}

function applyShinyVaultToByCode(byCode, shiny) {
  if (!byCode || typeof byCode !== "object") return 0;
  const hif = byCode[SET_CODE];
  if (!hif) throw new Error(`Missing ${SET_CODE} in set-card-lists.json`);
  return mergeShinyVaultIntoHifEntry(hif, shiny);
}

/**
 * Ensure local Shiny Vault image paths are set for existing SV card keys.
 * No network — returns skipped if already complete.
 */
async function ensureHifShinyVaultInByCode(byCode, { force = false } = {}) {
  const hif = byCode?.[SET_CODE];
  if (!hif) return { added: 0, total: 0, skipped: true };
  const existing = countShinyVaultCards(hif);
  hif.localImages = hif.localImages && typeof hif.localImages === "object" ? hif.localImages : {};
  let linked = 0;
  for (const cardNo of Object.keys(hif.cards || {})) {
    if (!isShinyVaultCardKey(cardNo)) continue;
    const url = localShinyVaultImageUrl(cardNo);
    if (!force && hif.localImages[cardNo] === url) continue;
    hif.localImages[cardNo] = url;
    linked += 1;
  }
  delete hif.images;
  delete hif.shinyVaultSource;
  hif.totalCards = Object.keys(hif.cards || {}).length;
  return { added: linked, total: existing, skipped: !force && linked === 0 };
}

module.exports = {
  SET_CODE,
  isShinyVaultCardKey,
  sortShinyVaultKeys,
  localShinyVaultImageUrl,
  mergeShinyVaultIntoHifEntry,
  preserveShinyVaultFromPrevious,
  countShinyVaultCards,
  applyShinyVaultToByCode,
  ensureHifShinyVaultInByCode
};
