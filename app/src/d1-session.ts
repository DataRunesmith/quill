type D1SessionCarrier = {
  DB: D1Database;
  D1_PRIMARY?: D1Database;
};

type BookmarkDatabase = {
  getBookmark?: () => string | null;
};

export type D1SessionConstraint = Parameters<D1Database["withSession"]>[0];

export function withD1Session<T extends { DB: D1Database }>(
  env: T,
  constraint: D1SessionConstraint,
): T {
  const carrier = env as T & D1SessionCarrier;
  const primary = carrier.D1_PRIMARY ?? env.DB;
  return Object.assign(Object.create(env), {
    DB: primary.withSession(constraint),
    D1_PRIMARY: primary,
  }) as T;
}

export function d1SessionBookmark(env: { DB: D1Database }): string | null {
  const session = env.DB as unknown as BookmarkDatabase;
  return typeof session.getBookmark === "function" ? session.getBookmark() : null;
}

export function d1ReplicaEligibleRequest(method: string, pathname: string): boolean {
  if (
    method === "GET" &&
    [
      "/api/areas",
      "/api/parties",
      "/api/roles",
      "/api/public-contacts/search",
      "/api/politicians/search",
    ].includes(pathname)
  )
    return true;
  return method === "POST" && pathname === "/api/recipients/count";
}
