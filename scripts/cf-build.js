/**
 * Cloudflare Git build: prune LFS card art, embed Worker nav overrides, then noop.
 */
const { pruneCardImagesForDocker } = require("./prune-docker-context");

pruneCardImagesForDocker();
require("./embed-frontend-overrides.js");
require("./noop-build.js");
