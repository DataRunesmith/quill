// Cloudflare Turnstile server-side verification. Fail closed in every environment.
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp: string | null | undefined,
  expectedAction: string,
  allowedHostnames: string | undefined,
): Promise<boolean> {
  // Self-hosted installs without Turnstile keys set TURNSTILE_SECRET=off.
  if (secret === "off") return true;
  if (!secret || !token || token.length > 2048 || !allowedHostnames) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) return false;
    const data = await resp.json<{ success?: boolean; action?: string; hostname?: string }>();
    const hosts = new Set(
      allowedHostnames
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
    );
    return (
      data.success === true &&
      data.action === expectedAction &&
      typeof data.hostname === "string" &&
      hosts.has(data.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}
