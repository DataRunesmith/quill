(() => {
  const TYPE_LABELS = {
    academia: "Akademi",
    media: "Media",
    eu: "EU",
    regering: "Regering",
    riksdag: "Riksdag",
    region: "Regioner",
    kommun: "Kommuner",
    kyrka: "Kyrkan",
  };
  const POLITICAL_TYPES = new Set(["eu", "regering", "riksdag", "region", "kommun", "kyrka"]);
  const openAreaTypes = new Set();

  function selectedAreaTypes() {
    const selected = new Set();
    for (const area of state.areas || []) {
      if (state.selectedAreas.has(area.area_name)) selected.add(area.area_type);
    }
    return selected;
  }

  function groupedAreaData(query = "") {
    const needle = String(query || "")
      .trim()
      .toLocaleLowerCase("sv-SE");
    const groups = new Map();

    for (const area of state.areas || []) {
      const type = area.area_type || "other";
      const typeLabel = TYPE_LABELS[type] || type;
      if (
        needle &&
        !String(area.area_name || "")
          .toLocaleLowerCase("sv-SE")
          .includes(needle) &&
        !typeLabel.toLocaleLowerCase("sv-SE").includes(needle)
      )
        continue;
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(area);
    }

    const selectedTypes = selectedAreaTypes();
    return [...groups.entries()].sort(([a], [b]) => {
      const aSelected = selectedTypes.has(a) ? 1 : 0;
      const bSelected = selectedTypes.has(b) ? 1 : 0;
      if (aSelected !== bSelected) return bSelected - aSelected;
      return (TYPE_LABELS[a] || a).localeCompare(TYPE_LABELS[b] || b, "sv-SE");
    });
  }

  function areaGroupMeta(type, rows) {
    const allRows = (state.areas || []).filter((area) => area.area_type === type);
    const selected = allRows.filter((area) => state.selectedAreas.has(area.area_name)).length;
    const posts = allRows.reduce((sum, area) => sum + Number(area.count || 0), 0);
    const areaWord = allRows.length === 1 ? "område" : "områden";
    const selectedText = selected ? selected + " valda · " : "";
    return selectedText + allRows.length + " " + areaWord + " · " + num(posts) + " poster";
  }

  function renderAreaGroups(query = "") {
    const host = document.querySelector("#area-list");
    if (!host) return;
    host.innerHTML = "";

    const needle = String(query || "").trim();
    const selectedTypes = selectedAreaTypes();
    const groups = groupedAreaData(needle);

    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "muted filter-area-empty";
      empty.textContent = "Inga områden matchar sökningen.";
      host.append(empty);
      return;
    }

    for (const [type, rows] of groups) {
      const details = document.createElement("details");
      details.className = "details filter-area-group";
      details.dataset.areaType = type;

      const forceOpen = Boolean(needle) || selectedTypes.has(type) || openAreaTypes.has(type);
      details.open = forceOpen;

      const summary = document.createElement("summary");
      summary.className = "filter-area-group__summary";

      const title = document.createElement("span");
      title.className = "filter-area-group__title";
      title.textContent = TYPE_LABELS[type] || type;

      const meta = document.createElement("span");
      meta.className = "filter-area-group__meta";
      meta.textContent = areaGroupMeta(type, rows);

      summary.append(title, meta);

      const body = document.createElement("div");
      body.className = "filter-area-group__body";

      const paintRows = () => {
        if (body.dataset.painted === "1") return;
        body.dataset.painted = "1";

        const visibleRows = rows.slice(0, 200);
        for (const area of visibleRows) {
          const label = document.createElement("label");
          label.className = "check";

          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = state.selectedAreas.has(area.area_name);

          const text = document.createElement("span");
          text.append(document.createTextNode(String(area.area_name || "")));
          const count = document.createElement("span");
          count.className = "muted";
          count.textContent = " (" + num(area.count) + ")";
          text.append(count);

          input.addEventListener("change", () => {
            if (input.checked) state.selectedAreas.add(area.area_name);
            else state.selectedAreas.delete(area.area_name);
            globalThis.renderAdvanced();
            if (typeof recipientCount === "function") recipientCount();
          });

          label.append(input, text);
          body.append(label);
        }

        if (rows.length > visibleRows.length) {
          const hint = document.createElement("p");
          hint.className = "muted filter-area-limit";
          hint.textContent = "Visar de första 200. Använd sökfältet för att hitta fler.";
          body.append(hint);
        }
      };

      if (details.open) paintRows();
      details.addEventListener("toggle", () => {
        if (details.open) {
          openAreaTypes.add(type);
          paintRows();
        } else {
          openAreaTypes.delete(type);
        }
      });

      details.append(summary, body);
      host.append(details);
    }
  }

  function makeSection(id, title) {
    const details = document.createElement("details");
    details.className = "details advanced-filter-section";
    details.id = id;

    const summary = document.createElement("summary");
    summary.textContent = title;

    const body = document.createElement("div");
    body.className = "stack advanced-filter-section__body";

    details.append(summary, body);
    return { details, body };
  }

  function prependHint(details, text) {
    if (!details || details.querySelector(":scope > .advanced-filter-hint")) return;
    const hint = document.createElement("p");
    hint.className = "muted advanced-filter-hint";
    hint.textContent = text;
    details.insertBefore(hint, details.children[1] || null);
  }

  function ensureStructure() {
    const areaList = document.querySelector("#area-list");
    if (!areaList) return null;

    const advanced = areaList.closest("details.details");
    const stack = advanced && advanced.querySelector(":scope > .stack");
    if (!advanced || !stack) return null;

    let areaSection = document.querySelector("#advanced-area-section");
    if (!areaSection) {
      const searchField = document.querySelector("#area-search")?.closest(".field");
      const localFilter = [...stack.querySelectorAll(":scope > details.details")].find((node) =>
        node.querySelector(":scope > summary")?.textContent?.includes("Uteslut ansvarsområden"),
      );
      const mediaFilter = document.querySelector("#media-filter");
      const academicFilter = document.querySelector("#academic-filter");
      const politicalFilter = [...stack.querySelectorAll(":scope > details.details")].find((node) =>
        node.querySelector(":scope > summary")?.textContent?.includes("Befattning och parti"),
      );

      const area = makeSection("advanced-area-section", "Områden och organisationer");
      areaSection = area.details;
      areaSection.open = true;
      if (searchField) area.body.append(searchField);
      area.body.append(areaList);
      stack.insertBefore(areaSection, localFilter || stack.firstChild);

      if (localFilter) {
        localFilter.id = "local-filter";
        localFilter.classList.add("advanced-filter-section");
        const summary = localFilter.querySelector(":scope > summary");
        if (summary) summary.textContent = "Kommuner och regioner";
        const heading = document.createElement("h3");
        heading.className = "advanced-filter-subheading";
        heading.textContent = "Uteslut ansvarsområden";
        const firstContent = summary?.nextSibling;
        localFilter.insertBefore(heading, firstContent || null);
      }

      if (mediaFilter) {
        mediaFilter.classList.add("advanced-filter-section");
        const summary = mediaFilter.querySelector(":scope > summary");
        if (summary) summary.textContent = "Media";
        prependHint(mediaFilter, "Begränsa urvalet efter redaktionell inriktning.");
      }

      if (academicFilter) {
        academicFilter.classList.add("advanced-filter-section");
        const summary = academicFilter.querySelector(":scope > summary");
        if (summary) summary.textContent = "Akademi";
        prependHint(academicFilter, "Begränsa urvalet efter akademiskt område.");
      }

      if (politicalFilter) {
        politicalFilter.id = "political-filter";
        politicalFilter.classList.add("advanced-filter-section");
        const summary = politicalFilter.querySelector(":scope > summary");
        if (summary) summary.textContent = "Politiska mottagare";
        prependHint(politicalFilter, "Avgränsa efter befattning eller uteslut parti.");
      }

      const personSearch = document.querySelector("#person-search")?.closest(".field");
      const personResults = document.querySelector("#person-results");
      const includeChips = document.querySelector("#include-chips")?.parentElement;
      const excludeChips = document.querySelector("#exclude-chips")?.parentElement;

      if (personSearch && personResults && includeChips && excludeChips) {
        const person = makeSection("person-filter", "Enskilda mottagare");
        person.body.append(personSearch, personResults, includeChips, excludeChips);
        stack.append(person.details);
      }
    }

    return { advanced, stack, areaSection };
  }

  function setRelevant(details, visible, autoOpen) {
    if (!details) return;
    const firstPass = details.dataset.relevanceInitialized !== "1";
    const becameVisible = details.hidden;
    details.hidden = !visible;

    if (!visible) {
      details.open = false;
    } else if (firstPass || becameVisible) {
      details.open = Boolean(autoOpen);
    }

    details.dataset.relevanceInitialized = "1";
  }

  function organizeAdvancedFilters() {
    const structure = ensureStructure();
    if (!structure) return;

    const selectedTypes = selectedAreaTypes();
    const hasLocal = selectedTypes.has("kommun") || selectedTypes.has("region");
    const hasMedia = selectedTypes.has("media");
    const hasAcademia = selectedTypes.has("academia");
    const hasPolitical = [...selectedTypes].some((type) => POLITICAL_TYPES.has(type));

    if (!hasLocal) state.excludeBodies.clear();
    if (!hasPolitical) {
      state.includeRoles.clear();
      state.excludeParties.clear();
    }

    const localFilter = document.querySelector("#local-filter");
    const mediaFilter = document.querySelector("#media-filter");
    const academicFilter = document.querySelector("#academic-filter");
    const politicalFilter = document.querySelector("#political-filter");

    setRelevant(localFilter, hasLocal, hasLocal);
    setRelevant(mediaFilter, hasMedia, hasMedia);
    setRelevant(academicFilter, hasAcademia, hasAcademia);
    setRelevant(politicalFilter, hasPolitical, hasPolitical && selectedTypes.size === 1);

    const search = document.querySelector("#area-search");
    if (search) {
      search.placeholder = "Kommun, region, universitet…";
      search.oninput = (event) => renderAreaGroups(event.target.value);
    }

    renderAreaGroups(search?.value || "");
  }

  const originalRenderAdvanced = globalThis.renderAdvanced;
  if (typeof originalRenderAdvanced === "function") {
    globalThis.renderAdvanced = function (...args) {
      const result = originalRenderAdvanced.apply(this, args);
      organizeAdvancedFilters();
      return result;
    };
  }
})();
