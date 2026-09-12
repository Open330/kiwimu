// Opt-in Google Analytics 4 bootstrap. Loaded only when build.ga_measurement_id
// (or KIWIMU_GA_ID) is set; the ID arrives via this script tag's data-ga-id.
// Kept external because generated pages ship a CSP without inline scripts.
(function () {
  var script = document.currentScript;
  var id = script && script.getAttribute("data-ga-id");
  if (!id || !/^G-[A-Z0-9]{4,20}$/.test(id)) return;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", id);
})();
