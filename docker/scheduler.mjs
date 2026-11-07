// `wrangler dev` does not fire cron triggers by itself. This calls the
// Worker's scheduled handler once a minute, like the production cron
// "* * * * *" (it re-queues pending sends and promotes ADMIN_EMAIL).
const port = process.env.PORT || "8787";
const url = `http://127.0.0.1:${port}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`;

async function tick() {
  try {
    const response = await fetch(url);
    if (!response.ok) console.error(`[scheduler] scheduled run: HTTP ${response.status}`);
  } catch {
    // The Worker is still starting; try again next minute.
  }
}

setTimeout(
  function loop() {
    tick();
    setTimeout(loop, 60_000 - (Date.now() % 60_000));
  },
  60_000 - (Date.now() % 60_000),
);
