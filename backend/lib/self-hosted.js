/**
 * When true, the server must not fetch card art, set symbols, or catalog data from third-party sites at runtime.
 */
function isSelfHosted() {
  const flag = String(process.env.SELF_HOSTED || "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

module.exports = { isSelfHosted };
