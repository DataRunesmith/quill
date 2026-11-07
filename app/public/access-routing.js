(() => {
  const adminHash = /^#admin(?:\/|$)/;
  const legacyAdminApiPrefix = "/api/admin/";
  const adminApiPrefix = "/admin/api/";
  const isAdminPath = () =>
    location.pathname === "/admin" || location.pathname.startsWith("/admin/");
  const nativeFetch = window.fetch.bind(window);

  function canonicalAdminPath(pathname) {
    if (!pathname.startsWith(legacyAdminApiPrefix)) return null;
    return `${adminApiPrefix}${pathname.slice(legacyAdminApiPrefix.length)}`;
  }

  window.fetch = (input, init) => {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return nativeFetch(input, init);
    }

    if (url.origin !== location.origin) return nativeFetch(input, init);

    const canonical = canonicalAdminPath(url.pathname);
    if (!canonical) return nativeFetch(input, init);

    url.pathname = canonical;
    const rewritten =
      input instanceof Request ? new Request(url.toString(), input) : url.toString();
    return nativeFetch(rewritten, init);
  };

  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;
    const canonical = canonicalAdminPath(url.pathname);
    if (!canonical) return;
    event.preventDefault();
    url.pathname = canonical;
    location.href = url.toString();
  });

  function normalizeLocation() {
    if (
      location.pathname === "/admin/critical" ||
      location.pathname.startsWith("/admin/critical/")
    ) {
      location.replace(`/admin${location.search}${location.hash || "#admin/accounts"}`);
      return;
    }

    if (adminHash.test(location.hash) && !isAdminPath()) {
      location.replace(`/admin${location.search}${location.hash}`);
      return;
    }

    if (isAdminPath() && (!location.hash || location.hash === "#")) {
      history.replaceState(null, "", `${location.pathname}${location.search}#admin/accounts`);
      return;
    }

    if (isAdminPath() && location.hash && !adminHash.test(location.hash)) {
      location.replace(`/${location.search}${location.hash}`);
    }
  }

  normalizeLocation();
  addEventListener("hashchange", normalizeLocation);
})();
