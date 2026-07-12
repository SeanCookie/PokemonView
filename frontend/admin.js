/* Public stub — real admin script is only served to administrators. */
(() => {
  if (typeof location !== "undefined") location.replace("/");
})();
