(() => {
  const themes = new Set(["legacy", "forest", "blackout"]);
  const fallback = "legacy";
  const storageKey = "__THEME_KEY_PREFIX__.theme";
  const cookieName = "__THEME_KEY_PREFIX___theme";
  const themeColors = { legacy: "#04070e", forest: "#080b09", blackout: "#000000" };

  function savedTheme() {
    const entry = document.cookie.split("; ").find((value) => value.startsWith(cookieName + "="));
    let value = entry ? entry.split("=")[1] : "";
    if (themes.has(value)) return value;
    try {
      value = localStorage.getItem(storageKey) || "";
    } catch {}
    return themes.has(value) ? value : "";
  }

  function persistTheme(theme) {
    try {
      localStorage.setItem(storageKey, theme);
    } catch {}
    // A shared parent domain (set at deploy) lets sibling sites share the theme.
    const sharedDomain = "__THEME_COOKIE_DOMAIN__";
    const shared =
      sharedDomain &&
      !sharedDomain.startsWith("__") &&
      (location.hostname === sharedDomain || location.hostname.endsWith("." + sharedDomain));
    const domain = shared ? "; Domain=." + sharedDomain : "";
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      cookieName + "=" + theme + "; Max-Age=31536000; Path=/; SameSite=Lax" + domain + secure;
  }

  function applyTheme(value, save = false) {
    const theme = themes.has(value) ? value : fallback;
    document.documentElement.dataset.theme = theme;
    const select = document.querySelector("#theme-select");
    if (select) select.value = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", themeColors[theme]);
    if (save) persistTheme(theme);
  }

  const saved = savedTheme();
  applyTheme(saved || document.documentElement.dataset.theme || fallback, Boolean(saved));
  addEventListener("DOMContentLoaded", () => {
    const select = document.querySelector("#theme-select");
    if (!select) return;
    select.value = document.documentElement.dataset.theme || fallback;
    select.addEventListener("change", () => applyTheme(select.value, true));
  });
})();
