/**
 * Cloudflare Git build: prune LFS card art, embed Worker nav overrides, then noop.
 */
const { pruneCardImagesForDocker } = require("./prune-docker-context");

pruneCardImagesForDocker();
require("./build-set-art-embedded.js");
require("./embed-frontend-overrides.js");
require("./noop-build.js");
