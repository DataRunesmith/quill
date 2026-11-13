// `wrangler dev` does not fire cron triggers by itself. This calls the
// Worker's scheduled handler once a minute, like the production cron
// "* * * * *" (it re-queues pending sends and promotes ADMIN_EMAIL).
// The port only ever selects a loopback port; reject anything but a plain
// port number so the environment cannot steer the request elsewhere.
const rawPort = process.env.PORT || "8787";
const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
if (port < 1 || port > 65535) {
  console.error(`[scheduler] invalid PORT: ${JSON.stringify(rawPort)}`);
  process.exit(1);
}
const url = new URL("http://127.0.0.1/cdn-cgi/handler/scheduled");
url.port = String(port);
url.searchParams.set("cron", "* * * * *");

async function tick() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) console.error(`[scheduler] scheduled run: HTTP ${response.status}`);
  } catch {
    // The Worker is still starting or the local scheduled handler timed out.
  }
}

async function loop() {
  await tick();
  setTimeout(loop, 60_000 - (Date.now() % 60_000));
}

setTimeout(loop, 60_000 - (Date.now() % 60_000));
