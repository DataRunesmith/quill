const ADMIN_API_PREFIX = "/admin/api/";
const LEGACY_ADMIN_API_PREFIX = "/api/admin/";
const LEGACY_CRITICAL_PAGE = "/admin/critical";
const LEGACY_CRITICAL_API_PREFIX = "/admin/critical/api/";

export type AccessRoute =
  | { type: "pass"; pathname: string }
  | { type: "rewrite"; pathname: string }
  | { type: "redirect"; pathname: string };

export function robotsPolicy(pathname: string): string | null {
  if (pathname === "/") return "index, follow, max-image-preview:large";
  if (
    pathname === "/admin" ||
    pathname === "/admin/" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/api/")
  )
    return "noindex, nofollow";
  return null;
}

export function accessRoute(pathname: string, _method = "GET"): AccessRoute {
  if (pathname === LEGACY_CRITICAL_PAGE || pathname === `${LEGACY_CRITICAL_PAGE}/`) {
    return { type: "redirect", pathname: "/admin" };
  }

  if (pathname.startsWith(LEGACY_CRITICAL_API_PREFIX)) {
    return {
      type: "redirect",
      pathname: `${ADMIN_API_PREFIX}${pathname.slice(LEGACY_CRITICAL_API_PREFIX.length)}`,
    };
  }

  if (pathname.startsWith(ADMIN_API_PREFIX)) {
    return {
      type: "rewrite",
      pathname: `${LEGACY_ADMIN_API_PREFIX}${pathname.slice(ADMIN_API_PREFIX.length)}`,
    };
  }

  if (pathname.startsWith(LEGACY_ADMIN_API_PREFIX)) {
    return {
      type: "redirect",
      pathname: `${ADMIN_API_PREFIX}${pathname.slice(LEGACY_ADMIN_API_PREFIX.length)}`,
    };
  }

  return { type: "pass", pathname };
}

export function requestWithPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}
