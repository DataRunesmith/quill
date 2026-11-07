(() => {
  const openHashTarget = () => {
    const raw = window.location.hash.slice(1);
    if (!raw) return;

    let id;
    try {
      id = decodeURIComponent(raw);
    } catch {
      return;
    }

    const target = document.getElementById(id);
    if (!(target instanceof HTMLDetailsElement)) return;

    target.open = true;
    target.scrollIntoView({ block: "start" });
  };

  openHashTarget();
  window.addEventListener("hashchange", openHashTarget);
})();
