/**
 * Loads Collectr showcases through our backend (Collectr blocks direct browser calls to their API).
 */
(function (global) {
  const DEFAULT_PAGE_SIZE = 100;

  function parseCollectrProfileUrl(rawUrl = "") {
    const text = String(rawUrl || "").trim();
    if (!text) {
      return { ok: false, error: "Enter a Collectr @username or showcase link." };
    }

    const urlMatch = text.match(
      /^(?:https?:\/\/)?(?:app\.)?getcollectr\.com\/showcase\/profile\/@?([a-z0-9_]{3,24})\/?(?:\?.*)?$/i
    );
    if (urlMatch) {
      const handle = urlMatch[1].toLowerCase();
      return {
        ok: true,
        handle,
        profileUrl: `https://app.getcollectr.com/showcase/profile/@${handle}`
      };
    }

    const handleMatch = text.match(/^@?([a-z0-9_]{3,24})$/i);
    if (handleMatch) {
      const handle = handleMatch[1].toLowerCase();
      return {
        ok: true,
        handle,
        profileUrl: `https://app.getcollectr.com/showcase/profile/@${handle}`
      };
    }

    return {
      ok: false,
      error: "Use @username or a Collectr link like https://app.getcollectr.com/showcase/profile/@username"
    };
  }

  function countCollectrProductTypes(products) {
    const rows = Array.isArray(products) ? products : [];
    let cards = 0;
    let sealed = 0;
    for (const row of rows) {
      if (row && row.is_card === false) sealed += 1;
      else cards += 1;
    }
    return { cards, sealed, total: rows.length };
  }

  async function fetchAllCollectrShowcaseProducts(rawUrl, options = {}) {
    const parsed = parseCollectrProfileUrl(rawUrl);
    if (!parsed.ok) return parsed;

    const maxItems = Math.min(25_000, Math.max(1, Number(options.maxItems) || 20_000));
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

    if (onProgress) {
      onProgress({ loaded: 0, totalCards: 0, totalSealed: 0, expectedTotal: null, phase: "start" });
    }

    const response = await fetch("/api/collectr/showcase/catalog", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: rawUrl,
        maxItems,
        useBrowser: options.useBrowser !== false
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      const raw =
        payload.error ||
        (response.status === 401 ? "Sign in to PokemonView, then try Preview again." : "") ||
        `Collectr catalog request failed (${response.status})`;
      return { ok: false, error: raw };
    }

    const products = Array.isArray(payload.products) ? payload.products : [];
    const counts = countCollectrProductTypes(products);
    const totalCards =
      Number(payload.totalCards) > 0 ? Number(payload.totalCards) : counts.cards;
    const totalSealed =
      Number(payload.totalSealed) > 0 ? Number(payload.totalSealed) : counts.sealed;
    const expectedTotal =
      Number(payload.expectedTotal) > 0
        ? Number(payload.expectedTotal)
        : totalCards + totalSealed > 0
          ? totalCards + totalSealed
          : null;

    if (onProgress) {
      onProgress({
        loaded: products.length,
        totalCards,
        totalSealed,
        expectedTotal,
        phase: "done"
      });
    }

    return {
      ok: true,
      handle: payload.handle || parsed.handle,
      profileUrl: payload.profileUrl || parsed.profileUrl,
      profile: payload.profile || {
        handle: parsed.handle,
        displayName: parsed.handle,
        profilePhoto: null
      },
      products,
      totalCards,
      totalSealed,
      expectedTotal,
      partial: payload.partial === true,
      pokemonOnly: payload.pokemonOnly === true,
      filteredOutNonPokemon: Number(payload.filteredOutNonPokemon) || 0,
      source: payload.source || "collectr-proxy"
    };
  }

  const api = {
    parseCollectrProfileUrl,
    fetchAllCollectrShowcaseProducts
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.CollectrImportClient = api;
})(typeof window !== "undefined" ? window : globalThis);
