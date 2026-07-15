/* ── Mapa ── */
const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [] },
  center: [-8.5, 36.5],
  zoom: 4.3,
  minZoom: 4.3,
  maxBounds: [[-60, 20], [50, 58]],
  antialias: true
});

/* ── Geocoder (Nominatim) ── */
class GeocoderControl {
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl geocoder-ctrl';

    this._input = document.createElement('input');
    this._input.type = 'text';
    this._input.placeholder = 'Buscar lugar…';
    this._input.className = 'geocoder-input';
    this._input.setAttribute('autocomplete', 'off');

    this._list = document.createElement('div');
    this._list.className = 'geocoder-results';

    this._container.appendChild(this._input);
    this._container.appendChild(this._list);

    let timer;
    this._input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = this._input.value.trim();
      if (q.length < 3) { this._list.innerHTML = ''; this._list.hidden = true; return; }
      timer = setTimeout(() => this._search(q), 350);
    });
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._list.hidden = true;
    });
    document.addEventListener('click', (e) => {
      if (!this._container.contains(e.target)) this._list.hidden = true;
    });
    return this._container;
  }

  async _search(q) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&accept-language=es&countrycodes=es`;
      const data = await fetch(url).then(r => r.json());
      this._render(data);
    } catch { /* red no disponible */ }
  }

  _render(items) {
    this._list.innerHTML = '';
    if (!items.length) {
      const el = document.createElement('div');
      el.className = 'geocoder-item geocoder-empty';
      el.textContent = 'Sin resultados';
      this._list.appendChild(el);
    } else {
      items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'geocoder-item';
        el.textContent = item.display_name;
        el.addEventListener('click', () => {
          this._input.value = item.display_name;
          this._list.hidden = true;
          const bb = item.boundingbox;
          if (bb) {
            this._map.fitBounds(
              [[parseFloat(bb[2]), parseFloat(bb[0])], [parseFloat(bb[3]), parseFloat(bb[1])]],
              { padding: 60, maxZoom: 14 }
            );
          } else {
            this._map.flyTo({ center: [parseFloat(item.lon), parseFloat(item.lat)], zoom: 13 });
          }
        });
        this._list.appendChild(el);
      });
    }
    this._list.hidden = false;
  }

  onRemove() {
    this._container.parentNode?.removeChild(this._container);
    this._map = undefined;
  }
}

map.addControl(new GeocoderControl(), 'top-right');
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

/* ── Tooltip hover ── */
const tooltip = document.createElement('div');
tooltip.className = 'map-tooltip';
document.body.appendChild(tooltip);

/* ── Protocolo PMTiles ── */
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile.bind(protocol));

const esFile = location.protocol === 'file:';
const pmtilesCache = {}; // dia -> ArrayBuffer, solo se usa con file://

async function registrarPMTilesLocal(file) {
  if (!esFile || pmtilesCache[file]) return;
  const buf = await fetch(file).then(r => r.arrayBuffer());
  pmtilesCache[file] = buf;
  protocol.add(new pmtiles.PMTiles({
    getBytes: (off, len) => Promise.resolve({ data: buf.slice(off, off + len) }),
    getKey: () => file
  }));
}

/* ── Estado ── */
let diasData = null;
let diaSeleccionado = 'D00';
let popup = null;

function fmtFecha(fechaISO) {
  const d = new Date(fechaISO + 'T00:00:00');
  return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }).replace('.', '');
}

/* ── Carga de una capa de día ── */
async function cargarDia(dia) {
  const file = `./data/nivel_peligro_${dia}.pmtiles`;
  await registrarPMTilesLocal(file);

  if (map.getLayer('nivel-fill')) map.removeLayer('nivel-fill');
  if (map.getSource('nivel-peligro')) map.removeSource('nivel-peligro');

  map.addSource('nivel-peligro', {
    type: 'vector',
    url: `pmtiles://${file}`
  });

  // Solo relleno, sin contorno: el raster de origen es muy fragmentado
  // (vegetación/pendiente/orientación varían píxel a píxel) y una capa de
  // línea sobre esa geometría oscurecía el conjunto. Además, combinar
  // fill-color y line-color data-driven sobre la misma fuente disparaba un
  // glitch de renderizado en MapLibre GL (banda blanca en el borde superior
  // del viewport).
  map.addLayer({
    id: 'nivel-fill',
    type: 'fill',
    source: 'nivel-peligro',
    'source-layer': 'nivel_peligro',
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': [
        'interpolate', ['linear'], ['zoom'],
        4, 0.55,
        10, 0.7
      ]
    }
  });

  map.on('mousemove', 'nivel-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const feat = e.features?.[0];
    if (!feat) return;
    tooltip.style.left = (e.originalEvent.clientX + 14) + 'px';
    tooltip.style.top  = (e.originalEvent.clientY - 40) + 'px';
    tooltip.textContent = feat.properties.nivel_label;
    tooltip.classList.add('visible');
  });
  map.on('mouseleave', 'nivel-fill', () => {
    map.getCanvas().style.cursor = '';
    tooltip.classList.remove('visible');
  });

  map.on('click', 'nivel-fill', (e) => {
    const p = e.features?.[0]?.properties;
    if (!p) return;
    tooltip.classList.remove('visible');

    const municipioProps = map.queryRenderedFeatures(e.point, { layers: ['municipios-fill'] })[0]?.properties;
    const lugar = municipioProps
      ? [municipioProps.municipio, municipioProps.provincia].filter(Boolean).join(', ')
      : null;

    const html = `
      <div class="pp">
        <div class="pp-top-bar" style="background:${p.color}"></div>
        <div class="pp-inner">
          ${lugar ? `<p class="pp-provincia">${lugar}</p>` : ''}
          <p class="pp-nombre pp-centrado">${p.nivel_label}</p>
        </div>
      </div>`;
    if (!popup) {
      popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 12, maxWidth: '260px' });
    }
    popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
  });

  // El límite de municipios debe quedar siempre por encima del relleno,
  // que se elimina y se vuelve a añadir (al tope de la pila) en cada cambio de día.
  if (map.getLayer('municipios-line')) map.moveLayer('municipios-line');
}

/* ── Selector de días (tira tipo calendario) ── */
function hoyISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function construirSelectorDias() {
  const pills = document.getElementById('dia-pills');
  pills.innerHTML = '';
  const hoy = hoyISO();

  diasData.dias.forEach(({ dia, fecha }) => {
    const d = new Date(fecha + 'T00:00:00');
    const semana = d.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '').toUpperCase();
    const esHoy = fecha === hoy;

    const btn = document.createElement('button');
    btn.className = 'dia-cell' + (dia === diaSeleccionado ? ' active' : '') + (esHoy ? ' hoy' : '');
    btn.innerHTML = `<span class="dia-semana">${esHoy ? 'Hoy' : semana}</span><span class="dia-num">${d.getDate()}</span>`;
    btn.addEventListener('click', () => {
      diaSeleccionado = dia;
      document.querySelectorAll('.dia-cell').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      if (popup) { popup.remove(); popup = null; }
      cargarDia(dia);
    });
    pills.appendChild(btn);
  });
}

/* ── Init ── */
map.on('load', async () => {
  diasData = await fetch('dias.json').then(r => r.json()).catch(() => null);

  /* Mapa base */
  map.addSource('basemap', {
    type: 'raster',
    tiles: ['https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/{z}/{x}/{y}{r}.png'],
    tileSize: 256,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
  });
  map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-opacity': 0.85 } });

  if (diasData) {
    const hoy = hoyISO();
    const diaHoy = diasData.dias.find(d => d.fecha === hoy);
    diaSeleccionado = (diaHoy ?? diasData.dias[0]).dia;
    construirSelectorDias();
    await cargarDia(diaSeleccionado);
  }

  /* Límites de municipios — solo líneas, sin relleno, por encima del nivel de peligro */
  map.addSource('municipios', {
    type: 'geojson',
    data: './data/municipios.geojson'
  });
  // Relleno invisible: solo para detectar con queryRenderedFeatures en qué
  // municipio se ha hecho clic (una línea sola no sirve para hit-testing de polígono).
  map.addLayer({
    id: 'municipios-fill',
    type: 'fill',
    source: 'municipios',
    paint: { 'fill-opacity': 0 }
  });
  map.addLayer({
    id: 'municipios-line',
    type: 'line',
    source: 'municipios',
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.2, 10, 0.8],
      'line-opacity': 0.3
    }
  });

  /* ── Reset vista ── */
  document.getElementById('reset-btn').addEventListener('click', () => {
    map.easeTo({ center: [-8.5, 36.5], zoom: 4.3, duration: 700 });
  });
});