// `wrangler dev` does not fire cron triggers by itself. This calls the
// Worker's scheduled handler once a minute, like the production cron
// "* * * * *" (it re-queues pending sends and promotes ADMIN_EMAIL).
const port = process.env.PORT || "8787";
const url = `http://127.0.0.1:${port}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`;

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
