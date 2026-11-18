export function bindMapSearch(root, regions, openRegion, focusLocation) {
  const form = root.querySelector('#atn-search');
  const input = form.querySelector('input');
  const results = form.querySelector('.atn-search-results');
  const entries = [];

  for (const region of Object.values(regions)) {
    const add = (location, kind, edge) => entries.push({
      ...location, kind, edge, regionId: region.id, regionName: region.name,
    });
    add({ ...region.center, name: region.name }, 'Study area');
    region.landmarks.forEach(landmark => add(landmark, 'Landmark'));
    region.transit_stops.forEach(stop => add(stop, 'Transit stop'));
    const names = new Set();
    for (const edge of region.edges) {
      if (!edge.name || !edge.coordinates.length || names.has(edge.name)) continue;
      names.add(edge.name);
      const [lon, lat] = edge.coordinates[Math.floor(edge.coordinates.length / 2)];
      add({ name: edge.name, lon, lat }, 'Road', edge);
    }
  }

  function choose(entry) {
    input.value = entry.name;
    results.hidden = true;
    input.focus();
    openRegion(entry.regionId);
    focusLocation(entry);
  }

  function matching() {
    const query = input.value.trim().toLowerCase();
    if (!query) return [];
    const terms = query.split(/\s+/);
    const rank = entry => {
      const name = entry.name.toLowerCase();
      return name === query ? 0 : name.startsWith(query) ? 1 : 2;
    };
    return entries.filter(entry => {
      const text = (entry.name + ' ' + entry.regionName + ' ' + entry.kind).toLowerCase();
      return terms.every(term => text.includes(term));
    }).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  }

  function show() {
    results.replaceChildren();
    results.hidden = !input.value.trim();
    const matches = matching();
    if (!matches.length) {
      results.textContent = 'No matching roads, stops, or landmarks.';
      return;
    }
    for (const entry of matches) {
      const button = document.createElement('button');
      const detail = document.createElement('small');
      button.type = 'button';
      button.textContent = entry.name;
      detail.textContent = entry.kind + ' · ' + entry.regionName;
      button.append(detail);
      button.addEventListener('click', () => choose(entry));
      results.append(button);
    }
  }

  input.addEventListener('input', show);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (results.hidden) show();
    const [first] = matching();
    if (first) choose(first);
  });
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      results.hidden = true;
      input.focus();
    }
    if (!results.hidden && event.key === 'ArrowDown' && event.target === input) {
      event.preventDefault();
      results.querySelector('button')?.focus();
    }
  });
  form.addEventListener('focusout', event => {
    if (!form.contains(event.relatedTarget)) results.hidden = true;
  });
}
