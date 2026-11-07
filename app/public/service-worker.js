self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-only by design. Sessions, D1, Queue, R2, credentials and send-job
// state remain server-side and must never become service-worker cache state.
self.addEventListener("fetch", () => {});
