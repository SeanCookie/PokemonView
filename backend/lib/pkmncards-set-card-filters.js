/** PkmnCards lists some SM-era secret cards with SV numbers on set pages; exclude from these sets. */
const SET_CODES_WITHOUT_PKMN_SV_EXTRAS = new Set(["BUS"]);

function isPkmnCardsSvExtraCardKey(key) {
  return /^SV\d+$/i.test(String(key || "").trim());
}

function stripPkmnCardsSvExtrasFromSetEntry(entry, setCode) {
  if (!entry || !SET_CODES_WITHOUT_PKMN_SV_EXTRAS.has(String(setCode || "").toUpperCase())) {
    return 0;
  }
  let removed = 0;
  for (const mapKey of ["cards", "images", "localImages"]) {
    const map = entry[mapKey];
    if (!map || typeof map !== "object") continue;
    for (const key of Object.keys(map)) {
      if (!isPkmnCardsSvExtraCardKey(key)) continue;
      delete map[key];
      if (mapKey === "cards") removed += 1;
    }
  }
  if (entry.cards && typeof entry.cards === "object") {
    entry.totalCards = Object.keys(entry.cards).length;
  }
  return removed;
}

function stripPkmnCardsSvExtrasFromDetailsEntry(entry, setCode) {
  if (!entry || !SET_CODES_WITHOUT_PKMN_SV_EXTRAS.has(String(setCode || "").toUpperCase())) {
    return 0;
  }
  const cards = entry.cards;
  if (!cards || typeof cards !== "object") return 0;
  let removed = 0;
  for (const key of Object.keys(cards)) {
    if (!isPkmnCardsSvExtraCardKey(key)) continue;
    delete cards[key];
    removed += 1;
  }
  if (removed) {
    entry.totalCards = Object.keys(cards).length;
  }
  return removed;
}

module.exports = {
  SET_CODES_WITHOUT_PKMN_SV_EXTRAS,
  isPkmnCardsSvExtraCardKey,
  stripPkmnCardsSvExtrasFromSetEntry,
  stripPkmnCardsSvExtrasFromDetailsEntry
};
