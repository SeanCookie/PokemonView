/**
 * Cloudflare Git build: prune LFS card art, then noop.
 */
const { pruneCardImagesForDocker } = require("./prune-docker-context");

pruneCardImagesForDocker();
require("./noop-build.js");
