ensureRecipientData = async function () {
  const tasks = [];
  if (!(state.areas && state.parties && state.roles))
    tasks.push(
      Promise.all([api("/api/areas"), api("/api/parties"), api("/api/roles")]).then((data) => {
        if (!data.every(Array.isArray)) throw new Error("Ogiltig mottagarmetadata från D1");
        [state.areas, state.parties, state.roles] = data;
      }),
    );
  if (!state.privateRecipientLoaded && typeof loadPrivateRecipientData === "function")
    tasks.push(loadPrivateRecipientData());
  await Promise.all(tasks);
};

function explicitRecipientCount() {
  const emails = new Set();
  for (const email of state.includeEmails?.keys?.() || [])
    emails.add(String(email).trim().toLowerCase());
  if (typeof selectedPrivateRecipientMap === "function")
    for (const email of selectedPrivateRecipientMap().keys())
      emails.add(String(email).trim().toLowerCase());
  return emails.size;
}
function localRecipientEstimate() {
  const selected = state.selectedAreas || new Set(),
    explicit = explicitRecipientCount();
  if (!selected.size) return { count: explicit, approximate: false };
  let count = (state.areas || []).reduce(
    (sum, a) => (selected.has(a.area_name) ? sum + Number(a.count || 0) : sum),
    0,
  );
  if (state.excludeParties?.size)
    count -= (state.parties || []).reduce(
      (sum, p) =>
        selected.has(p.area_name) && state.excludeParties.has(p.party)
          ? sum + Number(p.count || 0)
          : sum,
      0,
    );
  count += explicit;
  count -= state.excludeEmails?.size || 0;
  return { count: Math.max(0, count), approximate: true };
}
function paintLocalRecipientCount() {
  const estimate = localRecipientEstimate(),
    text = `${estimate.approximate ? "≈ " : ""}${num(estimate.count)} mottagare`;
  const e = $("#recipient-count");
  if (e) {
    e.textContent = text;
    e.title =
      "Beräknat lokalt från kontaktmetadata. Exakt mottagarlista fastställs först när utskicket startas.";
  }
  const r = $("#review-count");
  if (r) {
    r.textContent = `${estimate.approximate ? "≈ " : ""}${num(estimate.count)}`;
    r.title = "Exakt antal fastställs när utskicket startas.";
  }
  return estimate.count;
}
