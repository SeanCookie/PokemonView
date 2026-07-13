const PKMN_SHINY_VAULT_URL = "https://pkmncards.com/collection/shiny-vault/";
const SET_CODE = "HIF";

function decodeHtmlName(name) {
  return String(name || "")
    .replace(/&#038;/g, "&")
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

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

function parseShinyVaultFromPkmncardsHtml(html) {
  const cards = {};
  const images = {};
  const re =
    /<a href="https:\/\/pkmncards\.com\/card\/[^"]+" title="([^"]+)" class="card-image-link"><img[^>]*src="([^"]+)"/g;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const title = decodeHtmlName(match[1]);
    const imageUrl = String(match[2] || "").trim();
    const titleMatch = title.match(/^(.*?) · .*?#\s*([A-Za-z0-9-]+)$/);
    if (!titleMatch) continue;
    const name = decodeHtmlName(titleMatch[1]);
    const cardNo = String(titleMatch[2] || "").trim().toUpperCase();
    if (!isShinyVaultCardKey(cardNo) || !name) continue;
    cards[cardNo] = name;
    if (imageUrl) images[cardNo] = imageUrl;
  }
  return { cards, images };
}

function mergeShinyVaultIntoHifEntry(hifEntry, shiny, source = PKMN_SHINY_VAULT_URL) {
  if (!hifEntry || !shiny?.cards) return 0;
  hifEntry.cards = hifEntry.cards && typeof hifEntry.cards === "object" ? hifEntry.cards : {};
  hifEntry.images = hifEntry.images && typeof hifEntry.images === "object" ? hifEntry.images : {};
  hifEntry.localImages =
    hifEntry.localImages && typeof hifEntry.localImages === "object" ? hifEntry.localImages : {};

  let added = 0;
  for (const [cardNo, name] of Object.entries(shiny.cards)) {
    if (!hifEntry.cards[cardNo]) added += 1;
    hifEntry.cards[cardNo] = name;
    if (shiny.images?.[cardNo]) hifEntry.images[cardNo] = shiny.images[cardNo];
  }
  hifEntry.totalCards = Object.keys(hifEntry.cards).length;
  hifEntry.shinyVaultSource = source;
  return added;
}

function preserveShinyVaultFromPrevious(hifEntry, prevEntry) {
  if (!hifEntry || !prevEntry?.cards) return 0;
  let preserved = 0;
  hifEntry.cards = hifEntry.cards && typeof hifEntry.cards === "object" ? hifEntry.cards : {};
  hifEntry.images = hifEntry.images && typeof hifEntry.images === "object" ? hifEntry.images : {};
  hifEntry.localImages =
    hifEntry.localImages && typeof hifEntry.localImages === "object" ? hifEntry.localImages : {};

  for (const [cardNo, name] of Object.entries(prevEntry.cards)) {
    if (!isShinyVaultCardKey(cardNo)) continue;
    if (!hifEntry.cards[cardNo]) preserved += 1;
    hifEntry.cards[cardNo] = name;
    if (prevEntry.images?.[cardNo]) hifEntry.images[cardNo] = prevEntry.images[cardNo];
    if (prevEntry.localImages?.[cardNo]) hifEntry.localImages[cardNo] = prevEntry.localImages[cardNo];
  }
  if (prevEntry.shinyVaultSource && !hifEntry.shinyVaultSource) {
    hifEntry.shinyVaultSource = prevEntry.shinyVaultSource;
  }
  hifEntry.totalCards = Object.keys(hifEntry.cards).length;
  return preserved;
}

function countShinyVaultCards(entry) {
  if (!entry?.cards) return 0;
  return Object.keys(entry.cards).filter(isShinyVaultCardKey).length;
}

async function fetchPkmnShinyVaultHtml() {
  const response = await fetch(PKMN_SHINY_VAULT_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PokemonView/1.0)" }
  });
  if (!response.ok) {
    throw new Error(`PkmnCards shiny vault failed (${response.status})`);
  }
  return response.text();
}

async function fetchShinyVaultFromPkmncards() {
  const html = await fetchPkmnShinyVaultHtml();
  const shiny = parseShinyVaultFromPkmncardsHtml(html);
  const keys = Object.keys(shiny.cards);
  if (keys.length < 80) {
    throw new Error(`Expected ~94 SV cards from PkmnCards, found ${keys.length}`);
  }
  return shiny;
}

function applyShinyVaultToByCode(byCode, shiny) {
  if (!byCode || typeof byCode !== "object") return 0;
  const hif = byCode[SET_CODE];
  if (!hif) throw new Error(`Missing ${SET_CODE} in set-card-lists.json`);
  return mergeShinyVaultIntoHifEntry(hif, shiny);
}

async function ensureHifShinyVaultInByCode(byCode, { force = false } = {}) {
  const hif = byCode?.[SET_CODE];
  if (!hif) return { added: 0, total: 0, skipped: true };
  const existing = countShinyVaultCards(hif);
  if (!force && existing >= 94) {
    return { added: 0, total: existing, skipped: true };
  }
  const shiny = await fetchShinyVaultFromPkmncards();
  const added = applyShinyVaultToByCode(byCode, shiny);
  return { added, total: countShinyVaultCards(byCode[SET_CODE]), skipped: false };
}

module.exports = {
  PKMN_SHINY_VAULT_URL,
  SET_CODE,
  isShinyVaultCardKey,
  sortShinyVaultKeys,
  parseShinyVaultFromPkmncardsHtml,
  mergeShinyVaultIntoHifEntry,
  preserveShinyVaultFromPrevious,
  countShinyVaultCards,
  fetchShinyVaultFromPkmncards,
  applyShinyVaultToByCode,
  ensureHifShinyVaultInByCode
};
