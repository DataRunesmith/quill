import { pathToFileURL } from "node:url";

const PRODUCTION_URL = "https://__PUBLIC_HOST__/";
const ATTEMPTS = 5;
const RETRY_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

function safeEdgeDiagnostics(response) {
  const names = ["server", "cf-ray", "cf-cache-status", "cf-mitigated", "content-type", "location"];
  return names
    .map((name) => [name, response.headers.get(name)])
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
}

export function isCloudflareEdgeBlock(response) {
  if (response.status !== 403) return false;

  const server = (response.headers.get("server") ?? "").toLowerCase();
  const cfRay = response.headers.get("cf-ray");
  const cfMitigated = (response.headers.get("cf-mitigated") ?? "").toLowerCase();
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

  if (cfMitigated === "challenge") return true;
  return (server === "cloudflare" || Boolean(cfRay)) && contentType.includes("text/html");
}

export async function validateProductionResponse(response) {
  if (response.status === 200) return { status: "ok" };

  if (isCloudflareEdgeBlock(response)) {
    return {
      status: "edge_blocked",
      diagnostics: safeEdgeDiagnostics(response),
    };
  }

  throw new Error(
    `${PRODUCTION_URL} returned ${response.status}, expected 200${safeEdgeDiagnostics(response) ? ` (${safeEdgeDiagnostics(response)})` : ""}`,
  );
}

export async function checkProduction({
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  warn = console.warn,
} = {}) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(PRODUCTION_URL, {
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { "user-agent": "quill-workers-build-production-check" },
      });
      const result = await validateProductionResponse(response);

      if (result.status === "edge_blocked") {
        const details = result.diagnostics ? ` (${result.diagnostics})` : "";
        warn(
          `::warning title=Production ingress blocked by Cloudflare edge::${PRODUCTION_URL} returned a Cloudflare edge 403 to the build runner${details}. Deployment and control-plane checks remain authoritative.`,
        );
        return result;
      }

      console.log(`quill: production check passed on attempt ${attempt}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`attempt ${attempt}: ${message}`);
      if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(`quill: production check failed after ${ATTEMPTS} attempts`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkProduction().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
