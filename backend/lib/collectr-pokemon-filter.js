"use strict";

/** Collectr `web_slug_category` for Pokémon (Magic = 1, One Piece = 68, etc.). */
const COLLECTR_POKEMON_WEB_SLUG = "3";

const NON_POKEMON_CATEGORY_HINTS = [
  "magic",
  "one piece",
  "yugioh",
  "yu-gi",
  "lorcana",
  "dragon ball",
  "flesh and blood",
  "digimon",
  "star wars",
  "union arena",
  "weiss schwarz",
  "cardfight",
  "force of will",
  "final fantasy tcg",
  "funko"
];

function normalizeCollectrCategoryName(product) {
  return String(product?.catalog_category_name || "")
    .trim()
    .toLowerCase()
    .replace(/é/g, "e");
}

function isCollectrNonPokemonCategory(category) {
  if (!category) return false;
  return NON_POKEMON_CATEGORY_HINTS.some((hint) => category.includes(hint));
}

function isCollectrPokemonProduct(product) {
  const category = normalizeCollectrCategoryName(product);
  const slug = String(product?.web_slug_category ?? "").trim();

  if (isCollectrNonPokemonCategory(category)) return false;
  if (slug && slug !== COLLECTR_POKEMON_WEB_SLUG) return false;
  return category === "pokemon";
}

function filterCollectrPokemonProducts(products) {
  return (Array.isArray(products) ? products : []).filter(isCollectrPokemonProduct);
}

module.exports = {
  COLLECTR_POKEMON_WEB_SLUG,
  isCollectrPokemonProduct,
  filterCollectrPokemonProducts
};
