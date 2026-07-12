#!/usr/bin/env node
/**
 * Strip third-party image URLs from set-card-lists.json and re-finalize card details.
 * Run after download-card-images.js / sync-local-images-from-disk.js.
 */
const { localizeCatalogBundle } = require("../backend/lib/localize-catalog");

localizeCatalogBundle()
  .then((result) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
