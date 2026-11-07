// Area/party/role aggregates only change when public_contacts is re-scraped.
// Caching them at the edge avoids three full scans (~16k rows each) per send-view load.
export const AGGREGATE_CACHE_SECONDS = 3600;

export async function cachedAggregate(
  name: string,
  load: () => Promise<unknown>,
): Promise<Response> {
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  const key = new Request(`https://aggregate-cache.quill.invalid/${name}`);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return jsonResponse(await hit.json());
  const data = await load();
  await cache
    ?.put(
      key,
      new Response(JSON.stringify(data), {
        headers: { "Cache-Control": `max-age=${AGGREGATE_CACHE_SECONDS}` },
      }),
    )
    .catch(() => {});
  return jsonResponse(data);
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}
