/* مسح السايت — field survey tool for the old Rusafa riverfront (Baghdad) */
(() => {
'use strict';

// ---------------------------------------------------------------- constants
const DATA_VERSION = '29';    // bump when files in data/ change (also in sw.js)
const SITE_CENTER = [33.3387, 44.3935];
const SITE_ZOOM = 17;
const BAGHDAD_VIEWBOX = '44.20,33.45,44.55,33.20';
// calibration pivot = Mustansiriya courtyard; the plan was georeferenced on it
const ANCHOR = [33.338593, 44.389793];
const KX = 111320 * Math.cos(33.336 * Math.PI / 180);
const KY = 110950;

const CATS = {
  point: [
    ['heritage', 'مبنى تراثي', '#8b3a1a'],
    ['religious', 'ديني (جامع/كنيسة/كنيس)', '#0e7c66'],
    ['khan', 'خان / سوق', '#c27c0e'],
    ['commercial', 'تجاري', '#e07b39'],
    ['residential', 'سكني', '#5b7db1'],
    ['public', 'حكومي / عام', '#6b5b95'],
    ['education', 'تعليمي / ثقافي', '#2e86ab'],
    ['open', 'ساحة / فضاء مفتوح', '#3a9d23'],
    ['entrance', 'مدخل / بوابة', '#444444'],
    ['view', 'إطلالة / منظر مهم', '#1f9bd1'],
    ['activity', 'نشاط / تجمّع', '#d6336c'],
    ['issue', 'مشكلة / تشوّه بصري', '#c0392b'],
    ['other', 'أخرى', '#7f8c8d'],
  ],
  line: [
    ['darb', 'درب / دربونة', '#e67e22'],
    ['deadend', 'زقاق مغلق', '#b94a0f'],
    ['street', 'شارع', '#34495e'],
    ['pedestrian', 'مسار مشاة', '#16a085'],
    ['market', 'ممر سوق', '#c27c0e'],
    ['axis', 'محور بصري', '#8e44ad'],
    ['track', 'مسار مسجّل GPS', '#1a73e8'],
    ['edge', 'حد / سور', '#7f8c8d'],
  ],
  polygon: [
    ['heritage', 'مبنى تراثي (إضافي)', '#8b3a1a'],
    ['building', 'مبنى', '#5b7db1'],
    ['ruin', 'خربة / أرض خالية', '#9e8b74'],
    ['open', 'ساحة / فضاء', '#3a9d23'],
    ['green', 'مساحة خضراء', '#5cb85c'],
    ['market', 'سوق', '#c27c0e'],
    ['zone', 'منطقة / نطاق', '#8e44ad'],
  ],
};
const CONDITIONS = [
  ['good', 'جيدة', '#2f8a4c'],
  ['fair', 'متوسطة', '#9bbf3a'],
  ['poor', 'سيئة', '#e0a020'],
  ['critical', 'متهالكة / آيلة للسقوط', '#e0602a'],
  ['ruined', 'مهدّمة', '#9b1c1c'],
];
const ERAS = ['عباسي', 'إيلخاني / جلائري', 'عثماني', 'ملكي (1921–1958)', 'جمهوري (1958–2003)', 'حديث', 'غير معروف'];
const ELEMENTS = ['شناشيل', 'أقواس', 'طارمة', 'حوش وسطي', 'سرداب', 'باذكير', 'زخارف آجرية', 'كاشي', 'شبابيك خشب', 'قبة', 'منارة', 'إضافات حديثة مشوّهة'];
const MATERIALS = ['طابوق', 'جص', 'خشب', 'حجر', 'كونكريت', 'حديد', 'ألمنيوم / كلادينك'];
const SURFACES = ['مبلّط', 'إسفلت', 'ترابي', 'حجر / مقرنص', 'مسقّف'];
const ACTIVITY = ['هادئ', 'متوسط', 'مزدحم'];

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const catOf = (kind, key) => (CATS[kind] || []).find(c => c[0] === key) || ['other', 'أخرى', '#7f8c8d'];
const condOf = key => CONDITIONS.find(c => c[0] === key);
const fmtLen = m => m >= 1000 ? (m / 1000).toFixed(2) + ' كم' : Math.round(m) + ' م';
const fmtArea = m2 => m2 >= 10000 ? (m2 / 10000).toFixed(2) + ' هكتار' : Math.round(m2).toLocaleString('en') + ' م²';
const nowIso = () => new Date().toISOString();
const fmtDate = s => s ? new Date(s).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' }) : '';

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- IndexedDB
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('site-survey-rusafa', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of ['features', 'photos', 'heritage', 'meta']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      };
      // never let a stuck database freeze the whole app: give up after 5 s and run without local storage
      const to = setTimeout(() => rej(new Error('db timeout')), 5000);
      r.onsuccess = () => {
        clearTimeout(to); this.db = r.result;
        this.db.onversionchange = () => { this.db.close(); this.db = null; };   // don't block other tabs
        res();
      };
      r.onerror = () => { clearTimeout(to); rej(r.error); };
    });
  },
  _tx(store, mode, fn) {
    if (!this.db) return Promise.reject(new Error('التخزين المحلي غير متاح'));
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  all: s => DB._tx(s, 'readonly', st => st.getAll()),
  get: (s, id) => DB._tx(s, 'readonly', st => st.get(id)),
  put: (s, v) => DB._tx(s, 'readwrite', st => st.put(v)),
  del: (s, id) => DB._tx(s, 'readwrite', st => st.delete(id)),
  clear: s => DB._tx(s, 'readwrite', st => st.clear()),
};

// ---------------------------------------------------------------- state
const S = {
  features: new Map(),   // user-surveyed features (GeoJSON Feature + props)
  heritage: new Map(),   // records attached to heritage polygons, keyed by H-id
  heritageGeo: null,     // original heritage FeatureCollection
  planCorners: null,
  calib: { dx: 0, dy: 0, rot: 0, scale: 1 },
  settings: { mode: 'field', observer: '', basemap: 'sat', heritageMode: 'status', planOpacity: 0.55,
    layers: { heritage: true, heritageLabels: true, heritagePts: true, buildings: true, streets: true, places: true, axes: true, context: true, contours: false, thumbs: true, plan: false, site: true, landmarks: true, survey: true }, hiddenCats: [] },
  selected: null,
  me: null,              // last GPS fix {lat,lng,acc,heading}
  urls: new Map(),       // photo id -> object URL cache
};

// ---------------------------------------------------------------- calibration transform
function calibLL(lat, lng) {
  const { dx, dy, rot, scale } = S.calib;
  if (!dx && !dy && !rot && scale === 1) return [lat, lng];
  const x = (lng - ANCHOR[1]) * KX, y = (lat - ANCHOR[0]) * KY;
  const r = rot * Math.PI / 180, c = Math.cos(r) * scale, s = Math.sin(r) * scale;
  const X = c * x - s * y + dx, Y = s * x + c * y + dy;
  return [ANCHOR[0] + Y / KY, ANCHOR[1] + X / KX];
}
function calibGeo(geom) {
  const { dx, dy, rot, scale } = S.calib;
  if (!dx && !dy && !rot && scale === 1) return geom;
  const tr = ring => ring.map(([lng, lat]) => { const [a, b] = calibLL(lat, lng); return [b, a]; });
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(tr) };
  if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map(p => p.map(tr)) };
  if (geom.type === 'LineString') return { type: 'LineString', coordinates: tr(geom.coordinates) };
  if (geom.type === 'MultiLineString') return { type: 'MultiLineString', coordinates: geom.coordinates.map(tr) };
  return geom;
}

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomControl: false, maxZoom: 22, attributionControl: true, tap: false }).setView(SITE_CENTER, SITE_ZOOM);
window.siteMap = map; // handy for debugging from the console
L.control.scale({ metric: true, imperial: false, position: 'bottomright' }).addTo(map);
map.createPane('planPane').style.zIndex = 350;
map.createPane('heritagePane').style.zIndex = 410;
map.createPane('surveyPane').style.zIndex = 430;

const esriAttr = 'Imagery © Esri, Maxar, Earthstar Geographics';
const BASEMAPS = {
  sat: { name: 'قمر صناعي', layers: () => [
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, attribution: esriAttr }),
  ] },
  hybrid: { name: 'هجين', layers: () => [
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, attribution: esriAttr }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22 }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, opacity: .7 }),
  ] },
  osm: { name: 'شوارع', layers: () => [
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 22, attribution: '© OpenStreetMap' }),
  ] },
  light: { name: 'فاتح', layers: () => [
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxNativeZoom: 20, maxZoom: 22, attribution: '© OpenStreetMap © CARTO' }),
  ] },
};
let baseGroup = L.layerGroup().addTo(map);
function setBasemap(key) {
  S.settings.basemap = key; saveSettings();
  baseGroup.clearLayers(); BASEMAPS[key].layers().forEach(l => baseGroup.addLayer(l));
}

// rotated image overlay (plan drawing), defined by top-left / top-right / bottom-left corners
const PlanOverlay = L.Layer.extend({
  initialize(url, corners) { this._url = url; this._c = corners; },
  onAdd(m) {
    this._img = L.DomUtil.create('img', 'plan-img leaflet-zoom-hide');
    this._img.src = this._url; this._img.alt = '';
    this._img.style.opacity = S.settings.planOpacity;
    m.getPane('planPane').appendChild(this._img);
    this._img.onload = () => this._reset();
    m.on('zoomend viewreset moveend', this._reset, this);
    this._reset();
  },
  onRemove(m) { m.off('zoomend viewreset moveend', this._reset, this); this._img.remove(); },
  setCorners(c) { this._c = c; this._reset(); },
  setOpacity(o) { if (this._img) this._img.style.opacity = o; },
  _reset() {
    const img = this._img; if (!img || !img.naturalWidth) return;
    const w = img.naturalWidth, h = img.naturalHeight;
    const p0 = this._map.latLngToLayerPoint(this._c.tl), p1 = this._map.latLngToLayerPoint(this._c.tr), p2 = this._map.latLngToLayerPoint(this._c.bl);
    img.style.width = w + 'px'; img.style.height = h + 'px';
    img.style.transform = `matrix(${(p1.x - p0.x) / w},${(p1.y - p0.y) / w},${(p2.x - p0.x) / h},${(p2.y - p0.y) / h},${p0.x},${p0.y})`;
  },
});

// ---------------------------------------------------------------- layers
const L_ = {
  heritage: L.featureGroup(),
  buildings: L.featureGroup(),
  plan: null,
  site: L.featureGroup(),
  landmarks: L.featureGroup(),
  survey: L.featureGroup(),
  thumbs: L.featureGroup(),
  streets: L.featureGroup(),
  context: L.featureGroup(),
  contours: L.featureGroup(),
  me: L.layerGroup().addTo(map),
  measure: L.layerGroup().addTo(map),
};
map.createPane('contextPane').style.zIndex = 401;
map.createPane('streetsPane').style.zIndex = 402;
map.createPane('buildingsPane').style.zIndex = 405;
map.createPane('thumbPane').style.zIndex = 640;
const bRenderer = L.canvas({ pane: 'buildingsPane', tolerance: 4 });
const hRenderer = L.svg({ pane: 'heritagePane' });
const ctxRenderer = L.canvas({ pane: 'contextPane', tolerance: 2 });

const isHeritageId = id => /^H/.test(id);

// lazy labels: bound only while the zoom is high enough, so the map is not dragging hundreds of tooltips around
function lazyLabel(layer, text, opts, minZ) { layer._lz = { text, opts: { permanent: true, interactive: false, ...opts }, minZ }; }
function syncLabels() {
  const z = map.getZoom();
  for (const g of [L_.heritage, L_.buildings, L_.streets, L_.landmarks, L_.survey, L_.places, L_.axes, L_.hpts]) if (g) g.eachLayer(l => {
    const s = l._lz;
    if (!s) { return; }
    const want = z >= s.minZ;
    if (want && !l.getTooltip()) l.bindTooltip(s.text, s.opts);
    else if (!want && l.getTooltip()) l.unbindTooltip();
  });
}
const isDocumented = r => !!(r && (r.visited || r.name || (r.photos || []).length || r.condition));

// building height (floors): field record wins, else CAD/OSM survey value
const FLOOR_RAMP = [[1, '#fde7d1'], [2, '#fbc9a0'], [3, '#f7a571'], [4, '#ef8250'], [6, '#d95b37'], [9, '#b13a26'], [99, '#7a1f14']];
const floorColor = f => f ? FLOOR_RAMP.find(([k]) => f <= k)[1] : null;
const floorsOf = id => +(S.heritage.get(id)?.floors) || S.geoIndex?.get(id)?.properties.floors || null;
function heritageStyle(hid) {
  const own = S.heritage.get(hid), fr = S.heritage.get(hpOfMember.get(hid));
  const rec = own || fr;
  const mode = S.settings.heritageMode;
  let fill = '#9c3d16', stroke = '#2a0f04', w = 1.3;
  if (mode === 'status') {
    if (rec && rec.visited) { stroke = '#3ddc84'; w = 2.6; }
  } else if (mode === 'condition') {
    const c = rec && condOf(rec.condition);
    fill = c ? c[2] : '#a99c8e'; stroke = '#2a1d12';
  } else if (mode === 'height') {
    fill = floorColor(floorsOf(hid)) || '#a99c8e'; stroke = '#2a0f04';
  }
  if (hid === S.selected) { stroke = '#ffd166'; w = 4; }
  return { renderer: hRenderer, color: stroke, weight: w, fillColor: fill, fillOpacity: .72, opacity: .95 };
}
function buildingStyle(id) {
  const rec = S.heritage.get(id);
  if (id === S.selected) return { renderer: bRenderer, color: '#ffd166', weight: 3.5, fillColor: '#ffd166', fillOpacity: .25 };
  if (S.settings.heritageMode === 'height') {
    const fc = floorColor(floorsOf(id));
    return { renderer: bRenderer, color: '#ffffff', weight: 1, fillColor: fc || '#ffffff', fillOpacity: fc ? .8 : .1 };
  }
  if (isDocumented(rec)) {
    const c = S.settings.heritageMode === 'condition' && condOf(rec.condition);
    return { renderer: bRenderer, color: '#bfe3ff', weight: 1.4, fillColor: c ? c[2] : '#2e86ab', fillOpacity: .55 };
  }
  return { renderer: bRenderer, color: '#ffffff', weight: 1.3, opacity: .95, fillColor: '#ffffff', fillOpacity: .13 };
}

// street network vectorized from the plan: street space + centre-lines by type
const STREET_KINDS = { street: ['شارع', '#ffd166', 5], alley: ['درب / دربونة', '#ff9f43', 3.5], lane: ['زقاق ضيّق', '#ff6b6b', 2.5] };
function renderStreets() {
  L_.streets.clearLayers();
  if (!S.streetsGeo) return;
  const sr = L.svg({ pane: 'streetsPane' });
  // one label per real street name (OSM also carries block codes like "110-55" — skip those)
  const realName = n => n && /[ء-ي]{3,}/.test(n) && !/^\d/.test(n);
  const longest = new Map();
  for (const f of S.streetsGeo.features) {
    const p = f.properties; if (p.type !== 'centerline') continue;
    if (!realName(p.name)) { p.name = null; continue; }
    const cur = longest.get(p.name); if (!cur || cur.length_m < p.length_m) longest.set(p.name, p);
  }
  for (const f of S.streetsGeo.features) {
    const g = calibGeo(f.geometry), p = f.properties;
    if (p.type === 'area') {
      L.geoJSON({ type: 'Feature', properties: p, geometry: g }, { interactive: false, style: { renderer: sr, stroke: false, fillColor: '#fff3d1', fillOpacity: .16 } }).addTo(L_.streets);
      continue;
    }
    const [label, color, w] = STREET_KINDS[p.kind] || STREET_KINDS.alley;
    const lyr = L.geoJSON({ type: 'Feature', properties: p, geometry: g }, { style: { renderer: sr, color, weight: w, opacity: .9, lineCap: 'round', dashArray: p.kind === 'lane' ? '4 6' : null } });
    if (p.name && longest.get(p.name) === p) lazyLabel(lyr, esc(p.name), { direction: 'center', className: 'lbl lbl-street' }, 17);
    lyr.on('click', e => { L.DomEvent.stopPropagation(e); openStreet(p.sid); });
    L_.streets.addLayer(lyr);
  }
  syncLabels();
}
function openStreet(sid) {
  const f = S.streetsGeo.features.find(x => x.properties.sid === sid); if (!f) return;
  const p = f.properties, rec = S.heritage.get(sid) || { id: sid, photos: [] };
  const [label, color] = STREET_KINDS[p.kind] || STREET_KINDS.alley;
  const len = turf.length({ type: 'Feature', geometry: calibGeo(f.geometry) }) * 1000;
  openSheet(rec.name || p.name || `${label} ${sid}`, `
    <div class="hero" id="hero">${(rec.photos || []).length ? '' : `<div class="hero-empty"><span>ماكو صور لهذا المسار بعد</span></div>`}</div>
    <div class="row" style="margin:10px 0 4px"><button class="btn primary" id="sCam">📷 صوّر المسار</button><button class="btn" id="sGal">🖼 من المعرض</button></div>
    <dl class="kv">
      <dt>النوع</dt><dd><span class="badge"><span class="dot" style="background:${color}"></span>${label}</span></dd>
      <dt>العرض التقريبي</dt><dd>${p.width_m ?? '—'} م</dd>
      <dt>الطول</dt><dd>${fmtLen(len)}</dd>
      ${p.name ? `<dt>الاسم (OSM)</dt><dd>${esc(p.name)}</dd>` : ''}
    </dl>
    <label class="f" style="margin-top:12px"><span>ملاحظات (حركة، أرضية، إحساس المكان…)</span><textarea id="sNotes">${esc(rec.notes)}</textarea></label>
    <button class="btn primary block" id="sSave">حفظ</button>`, body => {
    renderHero($('#hero', body), rec.photos || [], sid);
    $('#sCam', body).onclick = async () => { if (await addPhotosTo(sid, true)) openStreet(sid); };
    $('#sGal', body).onclick = async () => { if (await addPhotosTo(sid, false)) openStreet(sid); };
    $('#sSave', body).onclick = async () => { await putHeritage({ ...rec, id: sid, notes: $('#sNotes', body).value.trim() }); toast('انحفظ ✓'); };
  });
}

const geoLayers = new Map();   // building id -> leaflet layer
function renderHeritage() {
  L_.heritage.clearLayers(); L_.buildings.clearLayers(); geoLayers.clear();
  if (!S.heritageGeo) return;
  const add = (fc, group, styleFn) => {
    for (const f of fc.features) {
      const id = f.properties.id;
      const lyr = L.geoJSON({ type: 'Feature', properties: f.properties, geometry: calibGeo(f.geometry) }, { style: () => styleFn(id) });
      lyr.on('click', e => { L.DomEvent.stopPropagation(e); openBuilding(id); });
      const rec = S.heritage.get(id);
      setBuildingLabel(lyr, id);
      geoLayers.set(id, lyr); group.addLayer(lyr);
    }
  };
  if (S.buildingsGeo) add(S.buildingsGeo, L_.buildings, buildingStyle);
  add(S.heritageGeo, L_.heritage, heritageStyle);
  renderThumbs(); syncLabels();
}
function setBuildingLabel(lyr, id) {
  const rec = S.heritage.get(id);
  if (lyr.getTooltip()) lyr.unbindTooltip();
  lyr._lz = null;
  const nm = rec?.name || S.geoIndex?.get(id)?.properties.name;
  if (nm) lazyLabel(lyr, esc(nm), { direction: 'center', className: 'lbl lbl-name' }, 17);
  else if (isHeritageId(id) && S.settings.layers.heritageLabels) lazyLabel(lyr, id, { direction: 'center', className: 'lbl lbl-id' }, 19);
}
// cheap refresh after editing one building (no full rebuild of 1000 layers)
function refreshBuilding(id) {
  if (hpById.has(id)) { renderHeritagePoints(); const m = hpById.get(id).properties.members; m.forEach(restyle); return; }
  const l = geoLayers.get(id); if (!l) return;
  restyle(id); setBuildingLabel(l, id); syncLabels(); renderThumbs();
}
function restyleAll() { geoLayers.forEach((l, id) => l.setStyle(isHeritageId(id) ? heritageStyle(id) : buildingStyle(id))); }
function restyle(id) {
  const l = geoLayers.get(id); if (!l) return;
  l.setStyle(isHeritageId(id) ? heritageStyle(id) : buildingStyle(id));
}
function select(id) {
  const prev = S.selected; S.selected = id;
  if (prev) restyle(prev);
  if (id) { restyle(id); if (isHeritageId(id)) geoLayers.get(id)?.bringToFront(); }
}

// round photo thumbnails on the map for every building / shape that has photos
let thumbRun = 0;
async function renderThumbs() {
  const run = ++thumbRun;
  const items = [];
  for (const r of S.heritage.values()) {
    if (!(r.photos || []).length || isHP(r.id)) continue;   // field points draw their own photo marker
    const f = buildingFeature(r.id); if (!f) continue;
    items.push({ ll: labelPoint(f), photo: r.photos[0], n: r.photos.length, open: () => openBuilding(r.id) });
  }
  for (const f of S.features.values()) {
    const p = f.properties; if (!(p.photos || []).length || p.kind === 'point') continue;
    items.push({ ll: labelPoint(f), photo: p.photos[0], n: p.photos.length, open: () => openFeature(p.id) });
  }
  const markers = [];
  for (const it of items) {
    const url = await photoUrl(it.photo);
    const m = L.marker(it.ll, { pane: 'thumbPane', icon: L.divIcon({ className: '', html: `<div class="thumb-pin" style="background-image:url(${url})">${it.n > 1 ? `<b>${it.n}</b>` : ''}</div>`, iconSize: [38, 38], iconAnchor: [19, 19] }) });
    m.on('click', it.open); markers.push(m);
  }
  if (run !== thumbRun) return;
  L_.thumbs.clearLayers(); markers.forEach(m => L_.thumbs.addLayer(m));
}

function renderPlan() {
  if (!S.planCorners) return;
  const c = {};
  for (const k of ['tl', 'tr', 'bl']) c[k] = L.latLng(calibLL(...S.planCorners[k]));
  if (!L_.plan) L_.plan = new PlanOverlay('data/plan.webp', c);
  else L_.plan.setCorners(c);
}

function surveyLayer(f) {
  const p = f.properties, kind = p.kind;
  const [, , color] = catOf(kind, p.category);
  let lyr;
  if (kind === 'point') {
    const [lng, lat] = f.geometry.coordinates;
    const ph = (p.photos || [])[0];
    lyr = L.marker([lat, lng], {
      pane: 'surveyPane',
      icon: L.divIcon({ className: '', html: ph ? `<div class="thumb-pin pt" data-ph="${ph}" style="border-color:${color}"></div>` : `<div class="pin" style="background:${color}"></div>`,
        iconSize: ph ? [38, 38] : [22, 22], iconAnchor: ph ? [19, 19] : [11, 11] }),
    });
    if (ph) lyr.on('add', async () => {
      const el = lyr.getElement()?.querySelector('[data-ph]'); if (!el) return;
      const u = await photoUrl(ph);
      if (u) el.style.backgroundImage = `url(${u})`; else el.classList.add('waiting');      // still uploading from its phone
    });
  } else {
    const style = kind === 'line'
      ? { pane: 'surveyPane', color, weight: p.category === 'darb' || p.category === 'deadend' ? 5 : 4, opacity: .95, dashArray: p.category === 'axis' ? '10 8' : p.category === 'deadend' ? '2 7' : null, lineCap: 'round' }
      : { pane: 'surveyPane', color, weight: 2, fillColor: color, fillOpacity: .35 };
    lyr = L.geoJSON(f, { style: () => style });
  }
  if (p.name) lazyLabel(lyr, esc(p.name), { direction: kind === 'point' ? 'top' : 'center', offset: kind === 'point' ? [0, -12] : [0, 0], className: 'lbl lbl-name' }, 17);
  lyr.on('click', e => { L.DomEvent.stopPropagation(e); openFeature(f.properties.id); });
  lyr._fid = f.properties.id;
  return lyr;
}
function renderSurvey() {
  L_.survey.clearLayers();
  const hidden = new Set(S.settings.hiddenCats);
  for (const f of S.features.values()) {
    if (hidden.has(f.properties.kind + ':' + f.properties.category)) continue;
    L_.survey.addLayer(surveyLayer(f));
  }
  renderThumbs(); syncLabels();
}

// label density by zoom is handled in CSS through classes on the map container
function updateLabelVisibility() {
  const z = map.getZoom(), c = map.getContainer().classList;
  c.toggle('z-lt17', z < 17); c.toggle('z-lt18', z < 18); c.toggle('z-lt19', z < 19);
  syncLabels();
}
map.on('zoomend', updateLabelVisibility);

function applyLayerVisibility() {
  const ly = S.settings.layers, A = S.settings.mode === 'analysis';
  const tog = (lyr, on) => { if (!lyr) return; if (on && !map.hasLayer(lyr)) map.addLayer(lyr); if (!on && map.hasLayer(lyr)) map.removeLayer(lyr); };
  // field mode = basemap + approximate heritage points + what the team draws/photographs; everything else is analysis
  tog(L_.hpts, !A && ly.heritagePts); tog(L_.survey, ly.survey); tog(L_.thumbs, ly.thumbs);
  if (!A) {
    for (const k of ['buildings', 'heritage', 'plan', 'site', 'streets', 'places', 'axes', 'context', 'contours', 'landmarks']) tog(L_[k], false);
    updateLabelVisibility(); return;
  }
  tog(L_.buildings, ly.buildings); tog(L_.heritage, ly.heritage); tog(L_.plan, ly.plan); tog(L_.site, ly.site);
  tog(L_.streets, ly.streets); tog(L_.places, ly.places && !!S.places); tog(L_.axes, ly.axes); tog(L_.context, ly.context); tog(L_.contours, ly.contours); tog(L_.landmarks, ly.landmarks); tog(L_.survey, ly.survey); tog(L_.thumbs, ly.thumbs);
  updateLabelVisibility();
}

async function loadStatic() {
  const get = u => fetch(`${u}?v=${DATA_VERSION}`).then(r => { if (!r.ok) throw new Error(u); return r.json(); });
  const [her, bld, corners, site, lm, st, cadB, cadC, pl, hp] = await Promise.all([
    get('data/heritage.json'), get('data/buildings.json'), get('data/plan_corners.json'), get('data/site.json'), get('data/landmarks.json'), get('data/streets.json').catch(() => null), get('data/context_buildings.json').catch(() => null), get('data/cad_contours.json').catch(() => null), get('data/places.json').catch(() => null), get('data/heritage_points.json').catch(() => null),
  ]);
  S.heritageGeo = her; S.buildingsGeo = bld; S.planCorners = corners; S.streetsGeo = st; S.siteGeo = site;
  if (pl) { S.places = pl.places; S.links = { axes: pl.axes, triangle: pl.triangle }; }
  for (const f of hp?.features || []) { hpById.set(f.properties.id, f); f.properties.members.forEach(m => hpOfMember.set(m, f.properties.id)); }
  // surrounding city from the CAD (CADMapper/OSM) export, coloured by height
  if (cadB) L.geoJSON(cadB, {
    style: f => ({ renderer: ctxRenderer, color: '#3b2a1e', weight: .6, fillColor: floorColor(f.properties.floors) || '#ccc', fillOpacity: .55 }),
    onEachFeature: (f, l) => l.bindTooltip(f.properties.floors ? `${f.properties.floors} طابق · ${f.properties.height_m} م` : 'ارتفاع غير معروف', { sticky: true, className: 'lbl' }),
  }).addTo(L_.context);
  if (cadC) L.geoJSON(cadC, {
    style: { color: '#a0522d', weight: 1, opacity: .7, dashArray: '3 4' },
    onEachFeature: (f, l) => l.bindTooltip(`منسوب ${f.properties.elev_m} م`, { sticky: true, className: 'lbl' }),
  }).addTo(L_.contours);
  st?.features.forEach((f, i) => (f.properties.sid = 'S' + String(i + 1).padStart(3, '0')));
  S.geoIndex = new Map([...her.features, ...bld.features].map(f => [f.properties.id, f]));
  L.geoJSON(site, { style: { color: '#ffd166', weight: 2, dashArray: '8 6', fill: false, interactive: false } }).addTo(L_.site);
  if (!S.places) L.geoJSON(lm, {
    pointToLayer: (f, ll) => L.marker(ll, { pane: 'surveyPane', icon: L.divIcon({ className: '', html: '<div class="lm"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }) }),
    onEachFeature: (f, l) => {
      lazyLabel(l, esc(f.properties.name), { direction: 'top', offset: [0, -6], className: 'lbl lbl-lm' }, 18);
      l.on('click', () => openLandmark(f));
    },
  }).addTo(L_.landmarks);
}

// ---------------------------------------------------------------- persistence
async function saveSettings() { try { await DB.put('meta', { id: 'settings', ...S.settings }); } catch {} }
async function saveCalib() { await DB.put('meta', { id: 'calib', ...S.calib }); }
async function loadUserData() {
  const [feats, her, meta] = await Promise.all([DB.all('features'), DB.all('heritage'), DB.all('meta')]);
  feats.forEach(f => S.features.set(f.id, f.feature));
  her.forEach(h => S.heritage.set(h.id, h));
  for (const m of meta) {
    if (m.id === 'settings') { const { id, ...rest } = m; S.settings = { ...S.settings, ...rest, layers: { ...S.settings.layers, ...(rest.layers || {}) } }; }
    if (m.id === 'calib') { const { id, ...rest } = m; S.calib = { ...S.calib, ...rest }; }
  }
}
async function putFeature(f) {
  f.properties.updated = nowIso();
  S.features.set(f.properties.id, f);
  await DB.put('features', { id: f.properties.id, feature: f });
  cloudKick();
}
async function putHeritage(rec) {
  rec.updated = nowIso();
  S.heritage.set(rec.id, rec);
  await DB.put('heritage', rec);
  cloudKick();
}

// ---------------------------------------------------------------- photos
async function compressImage(file, max, q) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, PHOTO_TYPE, q));
}
// WebP is ~30% smaller than JPEG at the same quality; Safari versions without WebP encoding fall back to JPEG
const PHOTO_TYPE = (() => { try { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg'; } catch { return 'image/jpeg'; } })();
const photoExt = t => ({ 'image/webp': 'webp', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif' }[t] || 'jpg');
// «أصلية» keeps the camera file untouched (up to the cloud's ≈ 35 MB per photo); «مضغوطة» = 1600 px WebP
const MAX_ORIGINAL = 34 * 1024 * 1024;
const keepOriginal = () => S.settings.photoQuality !== 'compressed';
async function addPhotos(files) {
  const ids = [], imgs = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  // one at a time: phones run out of memory decoding many full-size camera photos in parallel
  for (const [i, file] of imgs.entries()) {
    if (imgs.length > 1) toast(`جاري حفظ الصور ${i + 1} / ${imgs.length}…`, 60000);
    try {
      const orig = keepOriginal() && /^image\/(jpeg|png|webp|heic|heif)$/.test(file.type);
      const blob = orig && file.size <= MAX_ORIGINAL ? file : await compressImage(file, orig ? 4096 : 1600, orig ? .92 : .78);
      const thumb = await compressImage(file, 320, .62);
      const id = uid('P');
      await DB.put('photos', { id, blob, thumb, created: nowIso(), lat: S.me?.lat ?? null, lng: S.me?.lng ?? null, observer: S.settings.observer, name: file.name });
      ids.push(id);
    } catch (e) { console.error(e); toast(`تعذّرت قراءة ${file.name}`); }
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  return ids;
}
async function photoUrl(id, thumb = true) {
  const key = id + (thumb ? ':t' : '');
  if (S.urls.has(key)) return S.urls.get(key);
  const p = await DB.get('photos', id); if (!p) return '';
  let b = thumb ? (p.thumb || p.blob) : p.blob;
  // a teammate's photo that is only in the cloud: download once, then it is on this phone too
  if (!b && cloudOn()) { try { b = await cloudPhotoBlob(p, thumb); } catch { b = null; } }
  // full view while the original is still uploading: show the thumbnail but don't cache it as the full photo,
  // so the 1600 px version is fetched as soon as it exists
  if (!b && !thumb) return p.thumb ? URL.createObjectURL(p.thumb) : '';
  if (!b) return '';
  const u = URL.createObjectURL(b); S.urls.set(key, u); return u;
}
function pickPhotos(capture) {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = !capture;
    if (capture) inp.setAttribute('capture', 'environment');
    inp.onchange = () => res([...inp.files]);
    inp.click();
  });
}
async function renderPhotoGrid(el, ids, onRemove) {
  el.innerHTML = '';
  for (const id of ids) {
    const d = document.createElement('div'); d.className = 'ph';
    const u = await photoUrl(id);
    if (u) d.style.backgroundImage = `url(${u})`; else { d.classList.add('waiting'); d.textContent = '⏳'; }
    d.onclick = () => openGallery(ids, ids.indexOf(id));
    if (onRemove) {
      const b = document.createElement('button'); b.textContent = '✕'; b.title = 'إزالة الصورة';
      b.onclick = e => { e.stopPropagation(); onRemove(id); }; d.appendChild(b);
    }
    el.appendChild(d);
  }
}

// full-screen gallery: swipe / arrows / keyboard
const GAL = { ids: [], i: 0 };
async function showGal() {
  const lb = $('#lightbox'), id = GAL.ids[GAL.i];
  $('img', lb).src = await photoUrl(id, false);
  const p = await DB.get('photos', id);
  $('.lb-cap', lb).textContent = `${GAL.i + 1} / ${GAL.ids.length}${p?.observer ? ' · ' + p.observer : ''}${p?.created ? ' · ' + fmtDate(p.created) : ''}`;
  $('.lb-prev', lb).hidden = $('.lb-next', lb).hidden = GAL.ids.length < 2;
}
function openGallery(ids, i = 0) { GAL.ids = ids; GAL.i = Math.max(0, i); $('#lightbox').hidden = false; showGal(); }
function galStep(d) { GAL.i = (GAL.i + d + GAL.ids.length) % GAL.ids.length; showGal(); }
(() => {
  const lb = $('#lightbox');
  lb.addEventListener('click', e => {
    if (e.target.closest('.lb-prev')) return galStep(1);      // RTL: the right-hand arrow goes back
    if (e.target.closest('.lb-next')) return galStep(-1);
    if (e.target.closest('.lb-dl')) { const a = document.createElement('a'); a.href = $('img', lb).src; a.download = GAL.ids[GAL.i] + '.' + photoExt(PHOTO_TYPE); a.click(); return; }
    if (e.target.tagName !== 'IMG') lb.hidden = true;
  });
  let x0 = null;
  lb.addEventListener('touchstart', e => (x0 = e.touches[0].clientX), { passive: true });
  lb.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) galStep(dx > 0 ? 1 : -1); x0 = null; });
  addEventListener('keydown', e => { if (lb.hidden) return; if (e.key === 'Escape') lb.hidden = true; if (e.key === 'ArrowLeft') galStep(1); if (e.key === 'ArrowRight') galStep(-1); });
})();

// ---------------------------------------------------------------- sheet
let sheetCleanup = null;
function openSheet(title, html, after) {
  if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; }
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false; document.body.classList.add('sheet-open');
  $('#sheetBody').scrollTop = 0;
  if (after) sheetCleanup = after($('#sheetBody')) || null;
}
function closeSheet() {
  if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; }
  $('#sheet').hidden = true; document.body.classList.remove('sheet-open');
  $$('.dock button').forEach(b => b.classList.remove('on'));
}
$('#sheetClose').onclick = closeSheet;
$$('.dock button').forEach(b => b.onclick = () => {
  const p = b.dataset.panel;
  if (b.classList.contains('on')) return closeSheet();
  $$('.dock button').forEach(x => x.classList.toggle('on', x === b));
  PANELS[p]();
});

const swHtml = (key, label, sub, on, swatch) => `<div class="switch${on ? ' on' : ''}" data-key="${key}" role="switch" aria-checked="${!!on}" tabindex="0">
  ${swatch ? `<span class="swatch" style="${swatch}"></span>` : ''}<span class="sw-l">${label}${sub ? `<small>${sub}</small>` : ''}</span><span class="sw"></span></div>`;
const chipsHtml = (name, opts, sel, multi) => `<div class="chips" data-name="${name}" data-multi="${multi ? 1 : 0}">${opts.map(o => {
  const [v, l, c] = Array.isArray(o) ? o : [o, o];
  const on = multi ? (sel || []).includes(v) : sel === v;
  return `<button type="button" class="chip${on ? ' on' : ''}" data-v="${esc(v)}">${c ? `<span class="dot" style="background:${c}"></span>` : ''}${esc(l)}</button>`;
}).join('')}</div>`;
function wireChips(root) {
  $$('.chips', root).forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    if (g.dataset.multi === '1') b.classList.toggle('on');
    else { const was = b.classList.contains('on'); $$('.chip', g).forEach(x => x.classList.remove('on')); if (!was) b.classList.add('on'); }
    g.dispatchEvent(new Event('change'));
  }));
}
const chipVal = (root, name) => {
  const g = $(`.chips[data-name="${name}"]`, root); if (!g) return undefined;
  const v = $$('.chip.on', g).map(b => b.dataset.v);
  return g.dataset.multi === '1' ? v : (v[0] || '');
};

// ---------------------------------------------------------------- panels
const PANELS = {
  add() {
    openSheet('إضافة للسايت', `
      <div class="grid2">
        <button class="tile" data-a="gps"><span class="ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/></svg></span><span><b>نقطة بموقعي</b><small>يسجّل مكانك الحالي بالـ GPS</small></span></button>
        <button class="tile" data-a="point"><span class="ico"><svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/></svg></span><span><b>نقطة على الخريطة</b><small>حرّك الخريطة وثبّت الهدف</small></span></button>
        <button class="tile" data-a="line"><span class="ico"><svg viewBox="0 0 24 24"><path d="M4 19c4-1 3-7 8-8s4-6 8-7"/></svg></span><span><b>درب / مسار</b><small>ارسم الدربونة نقطة بنقطة</small></span></button>
        <button class="tile" data-a="polygon"><span class="ico"><svg viewBox="0 0 24 24"><path d="M4 7 12 3l8 5-2 11H7z"/></svg></span><span><b>مبنى / مساحة</b><small>ارسم حدود المبنى أو الساحة</small></span></button>
        <button class="tile" data-a="track"><span class="ico" style="background:#1a73e8"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg></span><span><b>سجّل مشيتي</b><small>يرسم مسارك تلقائياً وأنت تمشي بالدربونة</small></span></button>
        <button class="tile" data-a="photo"><span class="ico"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></span><span><b>صورة سريعة</b><small>صوّر وتنحفظ بمكانك فوراً</small></span></button>
      </div>
      <p class="muted" style="margin-top:12px">حتى توثّق أي مبنى (حفاظ أو غيره) أو تضيفله صور، دوس عليه بالخريطة مباشرة.</p>`,
    body => body.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      closeSheet();
      if (a === 'gps') addAtGps();
      else if (a === 'point') startCrosshair();
      else if (a === 'line') startDraw('Line');
      else if (a === 'polygon') startDraw('Polygon');
      else if (a === 'track') startTrack();
      else if (a === 'photo') quickPhoto();
    }));
  },

  layers() {
    const ly = S.settings.layers;
    const field = S.settings.mode !== 'analysis';
    openSheet(field ? 'الطبقات — وضع الميدان' : 'الطبقات — وضع التحليل', `
      <h3>الخريطة الأساسية</h3>
      <div class="basemaps">${Object.entries(BASEMAPS).map(([k, b]) => `<button data-bm="${k}" class="${S.settings.basemap === k ? 'on' : ''}">${b.name}</button>`).join('')}</div>
      ${field ? `<h3>طبقات الميدان</h3>
      ${swHtml('heritagePts', 'مواقع مباني الحفاظ (تقريبية)', `${hpById.size} موقع — بدون حدود، ترسمونها بالموقع`, ly.heritagePts, 'background:#9c3d16;border-radius:50%')}
      ${swHtml('survey', 'رسمنا ورصدنا', `${S.features.size} عنصر`, ly.survey, 'background:#e67e22')}
      ${swHtml('thumbs', 'الصور على الخريطة', '', ly.thumbs, 'background:#ccc;border-radius:50%')}
      <p class="muted">باقي الطبقات (المباني، الشوارع، الأماكن، المثلث…) بـ <b>وضع التحليل</b> من الزر فوق.</p>` : `
      <h3>طبقات السايت</h3>
      ${swHtml('heritage', 'مباني الحفاظ', `${S.heritageGeo?.features.length || 0} مبنى — مطابقة على بصمات المباني الحقيقية`, ly.heritage, 'background:#9c3d16')}
      ${swHtml('heritageLabels', 'أرقام مباني الحفاظ', 'تظهر عند التقريب الكبير', ly.heritageLabels)}
      ${swHtml('plan', 'المخطط الأصلي (صورة)', 'مخطط الحفاظ فوق الصورة الجوية', ly.plan, 'background:linear-gradient(135deg,#fff 50%,#8b3a1a 50%)')}
      <div id="planOp" ${ly.plan ? '' : 'hidden'}><label class="f"><span>شفافية المخطط</span><input type="range" min="0.1" max="1" step="0.05" value="${S.settings.planOpacity}"></label></div>
      ${swHtml('survey', 'رصدنا الميداني', `${S.features.size} عنصر`, ly.survey, 'background:#e67e22')}
      ${swHtml('landmarks', 'معالم معروفة', 'من OpenStreetMap', ly.landmarks, 'background:#fff;border:3px solid #1d5f8a')}
      ${swHtml('buildings', 'كل المباني', `${S.buildingsGeo?.features.length || 0} مبنى بحدوده من المخطط — دوس على أي مبنى لتوثيقه`, ly.buildings, 'background:rgba(255,255,255,.25);border:1.5px solid #fff')}
      ${swHtml('places', 'أماكن للربط', `${S.places?.length || 0} مكان معروف حول السايت مع وصف ومسافة مشي`, ly.places, 'background:#8e44ad;border-radius:50%')}
      ${swHtml('axes', 'محاور الربط ومثلث المتنبي', 'مقترحات ربط السايت بالمحيط', ly.axes, 'border-top:3px dotted #7b2cbf')}
      ${swHtml('context', 'مباني المحيط (CAD)', 'مباني بغداد حول السايت ملوّنة حسب الارتفاع', ly.context, 'background:linear-gradient(90deg,#fde7d1,#ef8250,#7a1f14)')}
      ${swHtml('contours', 'خطوط الكنتور', 'المناسيب من ملف الكاد', ly.contours, 'border-top:2px dashed #a0522d')}
      ${swHtml('streets', 'الشوارع والدرابين', 'شبكة المسارات: شارع / درب / زقاق ضيّق', ly.streets, 'background:linear-gradient(90deg,#ffd166 33%,#ff9f43 33% 66%,#ff6b6b 66%)')}
      ${swHtml('thumbs', 'صور المباني على الخريطة', 'تظهر صورة مصغّرة فوق كل مبنى مصوّر', ly.thumbs, 'background:#ccc;border-radius:50%')}
      ${swHtml('site', 'حدود السايت', '', ly.site, 'border:2px dashed #ffd166')}
      <h3>تلوين مباني الحفاظ</h3>
      ${chipsHtml('hmode', [['status', 'موثّق / غير موثّق'], ['condition', 'حسب الحالة الإنشائية'], ['height', 'حسب الارتفاع (طوابق)'], ['plain', 'لون واحد']], S.settings.heritageMode)}
      <div class="legend" id="hLegend"></div>
      <h3>إظهار فئات الرصد</h3>
      ${['point', 'line', 'polygon'].map(k => chipsHtml('cats-' + k, CATS[k].map(c => [k + ':' + c[0], c[1], c[2]]), CATS[k].map(c => k + ':' + c[0]).filter(x => !S.settings.hiddenCats.includes(x)), true)).join('<div style="height:6px"></div>')}`}
    `, body => {
      wireChips(body);
      const legend = () => {
        const m = S.settings.heritageMode;
        $('#hLegend', body).innerHTML = m === 'status'
          ? `<span><i class="swatch" style="background:#9c3d16;border:3px solid #3ddc84"></i>موثّق (زرناه)</span><span><i class="swatch" style="background:#9c3d16;border:1px solid #ffe2c8"></i>بعد ما انوثّق</span><span><i class="swatch" style="background:#2e86ab"></i>مبنى عادي موثّق</span>`
          : m === 'condition' ? CONDITIONS.map(c => `<span><i class="swatch" style="background:${c[2]}"></i>${c[1]}</span>`).join('') + '<span><i class="swatch" style="background:#bbb"></i>غير مقيّم</span>'
          : m === 'height' ? FLOOR_RAMP.map(([k, c], i) => { const lo = i ? FLOOR_RAMP[i - 1][0] + 1 : 1; return `<span><i class="swatch" style="background:${c}"></i>${k === 99 ? lo + '+' : lo === k ? lo : lo + '–' + k} طابق</span>`; }).join('') + '<span><i class="swatch" style="background:#a99c8e"></i>غير معروف — سجّل عدد الطوابق بالموقع</span>' : '';
      };
      legend();
      body.addEventListener('click', e => {
        const bm = e.target.closest('[data-bm]');
        if (bm) { setBasemap(bm.dataset.bm); $$('[data-bm]', body).forEach(b => b.classList.toggle('on', b === bm)); return; }
        const sw = e.target.closest('.switch'); if (!sw) return;
        const k = sw.dataset.key; ly[k] = !ly[k]; sw.classList.toggle('on', ly[k]); sw.setAttribute('aria-checked', ly[k]);
        if (k === 'plan') { if (ly.plan) renderPlan(); $('#planOp', body).hidden = !ly.plan; }
        if (k === 'heritageLabels') renderHeritage();
        applyLayerVisibility(); saveSettings();
      });
      $('#planOp input', body).oninput = e => { S.settings.planOpacity = +e.target.value; L_.plan?.setOpacity(S.settings.planOpacity); saveSettings(); };
      $('.chips[data-name="hmode"]', body).addEventListener('change', () => {
        S.settings.heritageMode = chipVal(body, 'hmode') || 'plain'; restyleAll(); legend(); saveSettings();
      });
      for (const k of ['point', 'line', 'polygon']) $(`.chips[data-name="cats-${k}"]`, body).addEventListener('change', () => {
        const all = ['point', 'line', 'polygon'].flatMap(kk => CATS[kk].map(c => kk + ':' + c[0]));
        const on = new Set(['point', 'line', 'polygon'].flatMap(kk => chipVal(body, 'cats-' + kk)));
        S.settings.hiddenCats = all.filter(x => !on.has(x)); renderSurvey(); saveSettings();
      });
    });
  },

  analysis() { openSheet('تحليل السايت', analysisHtml(), body => {
    body.addEventListener('click', e => {
      const go = e.target.closest('[data-goh]'); if (go) { flyToBuilding(go.dataset.goh); closeSheet(); }
      const pl = e.target.closest('[data-pl]'); if (pl) { const x = S.places.find(q => q.name === pl.dataset.pl); map.flyTo([x.lat, x.lon], 18); openPlace(x.name); }
      if (e.target.closest('[data-tri]')) { map.flyToBounds(L.latLngBounds(S.links.triangle.coords), { padding: [40, 40] }); openTriangle(); }
    });
  }); },

  list() {
    openSheet('سجل الرصد', `
      <label class="f"><input id="lq" type="search" placeholder="فلترة بالاسم أو الملاحظات…"></label>
      <div class="chips" id="lsort" style="margin-bottom:6px">
        <button class="chip on" data-v="recent">الأحدث</button><button class="chip" data-v="near">الأقرب لي</button>
        <button class="chip" data-v="todo">مباني حفاظ ما زرناها</button>
        <button class="chip" data-v="photos">📷 الصور</button>
      </div>
      <div id="lres"></div>`, body => {
      let mode = 'recent';
      const draw = async () => {
        const q = $('#lq', body).value.trim();
        if (mode === 'photos') return drawGallery($('#lres', body), q);
        const items = mode === 'todo' ? todoHeritage() : listItems();
        let arr = items.filter(it => !q || (it.title + ' ' + it.search).includes(q));
        if (mode === 'near' || mode === 'todo') { if (!S.me) toast('شغّل الـ GPS حتى نرتب حسب القرب'); arr.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9)); }
        else arr.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
        const el = $('#lres', body);
        if (!arr.length) { el.innerHTML = `<p class="muted">${mode === 'todo' ? 'وثّقتوا كل مباني الحفاظ 👏' : 'بعد ما سجّلتوا شي. ابدوا من زر «إضافة».'}</p>`; return; }
        el.innerHTML = arr.slice(0, 300).map(it => `<div class="list-item" data-open="${esc(it.key)}">
          <div class="thumb" ${it.photo ? `data-ph="${it.photo}"` : ''} style="${it.photo ? '' : `background:${it.color}22`}">${it.photo ? '' : `<span class="dot" style="width:12px;height:12px;border-radius:50%;background:${it.color}"></span>`}</div>
          <div class="meta"><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></div>
          ${it.dist != null ? `<span class="dist">${fmtLen(it.dist)}</span>` : ''}</div>`).join('');
        for (const t of $$('[data-ph]', el)) t.style.backgroundImage = `url(${await photoUrl(t.dataset.ph)})`;
      };
      $('#lq', body).oninput = draw;
      $('#lsort', body).onclick = e => { const b = e.target.closest('.chip'); if (!b) return; mode = b.dataset.v; $$('#lsort .chip', body).forEach(x => x.classList.toggle('on', x === b)); draw(); };
      $('#lres', body).onclick = e => {
        const ph = e.target.closest('[data-gph]');
        if (ph) { const g = GALLERY_GROUPS[+ph.dataset.g]; return openGallery(g.ids, +ph.dataset.i); }
        const go = e.target.closest('[data-ggo]');
        if (go) { closeSheet(); return GALLERY_GROUPS[+go.dataset.ggo].go(); }
        const k = e.target.closest('[data-open]')?.dataset.open; if (!k) return;
        if (S.geoIndex.has(k) || isHP(k)) { flyToBuilding(k); openRecord(k); }
        else { flyToFeature(k); openFeature(k); }
      };
      draw();
    });
  },

  more() {
    openSheet('المزيد', `
      <label class="f"><span>اسم الراصد (يظهر على كل شي تسجله)</span><input id="obs" value="${esc(S.settings.observer)}" placeholder="مثلاً: محمد تقي"></label>
      <h3>مشاركة البيانات مع الفريق</h3>
      <p class="muted">كل واحد يرصد على تلفونه. بنهاية اليوم كلكم صدّروا ملف ZIP ودزّوه بالكروب، وواحد يستورد كل الملفات حتى تندمج بخريطة وحدة.</p>
      <div class="row">
        <button class="btn primary" id="exZip">تصدير ZIP (مع الصور)</button>
        <button class="btn" id="share">مشاركة</button>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn" id="exGeo">GeoJSON (لـ QGIS/CAD)</button>
        <button class="btn" id="exCsv">CSV (لـ Excel)</button>
      </div>
      <div class="row" style="margin-top:8px"><button class="btn" id="imp">استيراد ملف ZIP / GeoJSON</button></div>
      <h3>☁️ المزامنة السحابية (Google Drive)</h3>
      <p class="muted" id="cloudStatus" style="margin-top:0">${cloudStatusHtml()}</p>
      <div class="row"><button class="btn primary" id="cTest">فحص الاتصال</button><button class="btn" id="cNow">زامن هسه</button></div>
      <details class="howto"><summary>إعدادات متقدمة</summary>
        <label class="f" style="margin-top:8px"><span>رابط السكربت (Web app URL)</span><input id="cUrl" dir="ltr" value="${esc(cloudCfg().url)}"></label>
        <label class="f"><span>كلمة السر (إذا السكربت مقفول)</span><input id="cKey" dir="ltr" type="password" value="${esc(cloudCfg().key === 'open' ? '' : cloudCfg().key)}"></label>
      </details>
      ${cloudOn() ? '<div class="row" style="margin-top:8px"><button class="btn" id="cInvite">إرسال رابط المزامنة للفريق</button></div>' : ''}
      <details class="howto"><summary>شلون تشتغل؟</summary>
        <p>كل صورة تصوّرونها تنرفع تلقائياً لـ Google Drive الفريق، بمجلد باسم المبنى، واسم الملف بيه التاريخ واسم المصوّر. وكل تلفون يسحب صور وسجلات الباقين ويعرضها بالخريطة وبـ «السجل ← 📷 الصور». ماكو أي إعداد — بس افتحوا الموقع.</p>
        <p style="margin-bottom:0">لإعداد سكربت جديد بحساب ثاني:</p>
        <ol>
          <li>افتح <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a> بحساب Google (حساب الجامعة إذا مساحته أكبر).</li>
          <li>امسح الموجود والصق كود <a href="https://github.com/mhmdTaqi-code/maps/blob/main/cloud/Code.gs" target="_blank" rel="noopener">Code.gs</a>.</li>
          <li>Deploy ← New deployment ← Web app ← Execute as: <b>Me</b> ← Who has access: <b>Anyone</b> ← Deploy، ووافق على الصلاحيات.</li>
          <li>الصق رابط الـ Web app (ينتهي بـ /exec) بـ <code>WEBAPP_URL</code> بالكود، احفظ، واختار الدالة <code>setup</code> ودوس Run. تطلع كلمة سر عشوائية و<b>رابط انضمام</b> بتبويب «الإعداد» بجدول السجل بالـ Drive.</li>
          <li>افتح رابط الانضمام بالتلفون — التطبيق يتفعّل وحده — ودزّه للفريق.</li>
        </ol>
        <p>الصور تنحفظ بمجلد «مسح السايت» بـ Drive مالتك، كل مبنى بمجلد، والسجل بجدول Google Sheets بنفس المجلد. محد يكدر يوصلها بدون كلمة السر.</p>
      </details>
      <h3>التخزين على هذا الجهاز</h3>
      <p class="muted" id="storageInfo">جاري الحساب…</p>
      <label class="f"><span>جودة الصور المرفوعة للـ Drive</span></label>
      ${chipsHtml('pq', [['original', 'أصلية — بدون ضغط (حد ≈ 35 MB للصورة)'], ['compressed', 'مضغوطة — أسرع على النت الضعيف']], S.settings.photoQuality || 'original')}
      <p class="muted" style="margin-top:6px">بالأصلية: الصورة تنرفع كما هي، وبعد ما توصل الـ Drive يحتفظ التلفون بنسخة أخف حتى ما تتعبّى ذاكرته.</p>
      <h3>العمل بدون انترنت</h3>
      <p class="muted">نزّل صور القمر الصناعي للسايت قبل لا تطلعون، حتى الخريطة تشتغل حتى لو النت ضعيف.</p>
      <button class="btn block" id="offline">تنزيل خريطة السايت للاستخدام بدون نت</button>
      <h3>معايرة مباني الحفاظ</h3>
      <p class="muted">إذا شفت المباني الجوزية مزاحة عن الصورة الجوية أو عن موقعك الحقيقي، عدّلها هنا. المحور هو المدرسة المستنصرية.</p>
      <button class="btn block" id="calib">فتح أداة المعايرة</button>
      <h3>المظهر</h3>
      ${chipsHtml('theme', [['auto', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']], S.settings.theme || 'auto')}
      <h3>منطقة الخطر</h3>
      <button class="btn danger block" id="wipe">مسح كل بيانات الرصد من هذا الجهاز</button>
      <hr><p class="muted">الخريطة: Esri / OpenStreetMap. مباني الحفاظ مستخرجة من مخطط الحفاظ ومُسقطة تقريبياً على الإحداثيات — راجعوها بالموقع.</p>`,
    body => {
      wireChips(body);
      $('#obs', body).onchange = e => { S.settings.observer = e.target.value.trim(); saveSettings(); toast('انحفظ الاسم'); };
      $('#exZip', body).onclick = () => exportZip(false);
      $('#share', body).onclick = () => exportZip(true);
      $('#exGeo', body).onclick = exportGeoJSON;
      $('#exCsv', body).onclick = exportCSV;
      $('#imp', body).onclick = importFile;
      $('#offline', body).onclick = e => downloadOffline(e.target);
      $('#calib', body).onclick = () => { closeSheet(); openCalibration(); };
      $('#wipe', body).onclick = wipeAll;
      $('.chips[data-name="pq"]', body).addEventListener('change', () => { S.settings.photoQuality = chipVal(body, 'pq') || 'original'; saveSettings(); toast(S.settings.photoQuality === 'original' ? 'الصور الجديدة تنرفع بجودتها الأصلية' : 'الصور الجديدة تنضغط قبل الرفع'); });
      storageInfo($('#storageInfo', body)).catch(() => { $('#storageInfo', body).textContent = 'التخزين المحلي مقفول — سدّ كل تبويبات الموقع وافتحه من جديد.'; });
      $('#cTest', body).onclick = async e => {
        const c = cloudCfg(); c.url = $('#cUrl', body).value.trim() || TEAM_CLOUD_URL; c.key = $('#cKey', body).value.trim() || 'open';
        if (!/^https:\/\//.test(c.url)) return toast('الرابط غير صالح');
        await saveSettings(); e.target.disabled = true; $('#cloudStatus', body).textContent = '⏳ جاري الاختبار…';
        try {
          const j = await cloudCall({ action: 'ping' }, 30000);
          const gb = v => (v / 1073741824).toFixed(1) + ' GB';
          $('#cloudStatus', body).innerHTML = `✓ متصل بـ Drive — المساحة ${gb(j.used)} من ${j.limit ? gb(j.limit) : 'غير محدودة'} · بالسحابة ${j.photos} صورة و ${j.records} سجل · <a href="${esc(j.folder)}" target="_blank" rel="noopener">فتح المجلد</a>`;
          cloudStart();
        } catch (err) { $('#cloudStatus', body).textContent = '⚠ ما اشتغل: ' + (err.message === 'bad key' ? 'كلمة السر غلط' : err.message); }
        e.target.disabled = false;
      };
      const inv = $('#cInvite', body);
      if (inv) inv.onclick = async () => {
        const text = `فعّل مزامنة مسح السايت (افتحه بالتلفون):\n${cloudJoinLink()}`;
        if (navigator.share) { try { await navigator.share({ title: 'مزامنة مسح السايت', text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
        try { await navigator.clipboard.writeText(text); toast('انسخ — دزّه للفريق بس'); } catch { prompt('انسخ:', text); }
      };
      $('#cNow', body).onclick = () => { if (!cloudOn()) return toast('فعّل المزامنة أول'); cloudSync(); };
      $('.chips[data-name="theme"]', body).addEventListener('change', () => { S.settings.theme = chipVal(body, 'theme') || 'auto'; applyTheme(); saveSettings(); });
    });
  },
};

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------- gallery: all photos of the team, per building
let GALLERY_GROUPS = [];
function galleryGroups() {
  const out = [];
  for (const r of S.heritage.values()) if ((r.photos || []).length && (isHP(r.id) || S.geoIndex?.has(r.id)))
    out.push({ title: buildingTitle(r.id, r), sub: isHP(r.id) ? `مبنى حفاظ ${r.id}` : `مبنى ${r.id}`, ids: r.photos, updated: r.updated || '', go: () => { flyToBuilding(r.id); openRecord(r.id); } });
  for (const f of S.features.values()) if ((f.properties.photos || []).length) {
    const p = f.properties, cat = catOf(p.kind, p.category)[1];
    out.push({ title: p.name || cat, sub: cat, ids: p.photos, updated: p.updated || '', go: () => { flyToFeature(p.id); openFeature(p.id); } });
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}
async function drawGallery(el, q) {
  GALLERY_GROUPS = galleryGroups();
  // photos in the team Drive that no record points at (yet) — grouped by their Drive folder name
  const used = new Set(GALLERY_GROUPS.flatMap(g => g.ids)), loose = new Map();
  for (const ph of await DB.all('photos').catch(() => [])) {
    if (used.has(ph.id) || !(ph.cloud || ph.blob)) continue;
    const k = ph.owner || 'صور بدون مبنى';
    if (!loose.has(k)) loose.set(k, { title: k, sub: 'من Drive الفريق', ids: [], updated: ph.created || '', go: () => toast('هاي الصور مو مربوطة بمبنى بالخريطة') });
    loose.get(k).ids.push(ph.id);
  }
  GALLERY_GROUPS.push(...loose.values());
  GALLERY_GROUPS = GALLERY_GROUPS.filter(g => !q || (g.title + ' ' + g.sub).includes(q));
  const total = GALLERY_GROUPS.reduce((a, g) => a + g.ids.length, 0);
  if (!total) { el.innerHTML = '<p class="muted">ماكو صور بعد. صوّروا المباني من بطاقاتها — وتطلع هنا صور كل الفريق.</p>'; return; }
  el.innerHTML = `<p class="muted" style="margin:4px 0 10px">${total} صورة بـ ${GALLERY_GROUPS.length} مكان — من كل الفريق</p>` + GALLERY_GROUPS.map((g, gi) => `
    <div class="gal-group">
      <div class="gal-head"><div><b>${esc(g.title)}</b><small>${esc(g.sub)} · ${g.ids.length} صورة</small></div><button class="btn small" data-ggo="${gi}">روح له</button></div>
      <div class="gal-strip">${g.ids.map((id, i) => `<button class="gal-ph" data-gph="${esc(id)}" data-g="${gi}" data-i="${i}" aria-label="صورة"></button>`).join('')}</div>
    </div>`).join('');
  // thumbnails load as they scroll into view (teammates' photos come from Drive the first time)
  const io = new IntersectionObserver(es => es.forEach(async en => {
    if (!en.isIntersecting) return; io.unobserve(en.target);
    const u = await photoUrl(en.target.dataset.gph);
    if (u) en.target.style.backgroundImage = `url(${u})`; else en.target.classList.add('missing');
  }), { root: el.closest('.sheet-body'), rootMargin: '200px' });
  $$('.gal-ph', el).forEach(b => io.observe(b));
}

// ---------------------------------------------------------------- feature records
function featureCenter(f) {
  if (f.geometry.type === 'Point') return [f.geometry.coordinates[1], f.geometry.coordinates[0]];
  const c = turf.centroid(f).geometry.coordinates; return [c[1], c[0]];
}
function buildingFeature(id) {
  if (hpById.has(id)) return hpById.get(id);
  const f = S.geoIndex?.get(id);
  return f && { type: 'Feature', properties: f.properties, geometry: calibGeo(f.geometry) };
}
// a point guaranteed inside the shape (centroid can fall in a courtyard)
function labelPoint(f) {
  if (f.geometry.type === 'Point') return [f.geometry.coordinates[1], f.geometry.coordinates[0]];
  try { const c = turf.pointOnFeature(f).geometry.coordinates; return [c[1], c[0]]; } catch { return featureCenter(f); }
}
function distTo(latlng) { return S.me ? map.distance([S.me.lat, S.me.lng], latlng) : null; }

function listItems() {
  const out = [];
  for (const f of S.features.values()) {
    const p = f.properties, [, label, color] = catOf(p.kind, p.category);
    out.push({ key: p.id, title: p.name || label, sub: `${label}${p.condition ? ' · ' + condOf(p.condition)?.[1] : ''} · ${fmtDate(p.created)}`,
      search: `${p.notes || ''} ${p.observer || ''}`, color, photo: p.photos?.[0], updated: p.updated, dist: distTo(featureCenter(f)) });
  }
  for (const r of S.heritage.values()) {
    if (!isDocumented(r)) continue;
    const f = buildingFeature(r.id); if (!f) continue;
    const her = isHeritageId(r.id);
    out.push({ key: r.id, title: buildingTitle(r.id, r), sub: `${her ? 'مبنى حفاظ' : 'مبنى'} ${r.id}${r.condition ? ' · ' + condOf(r.condition)?.[1] : ''}${(r.photos || []).length ? ' · ' + r.photos.length + ' صورة' : ''}`,
      search: `${r.notes || ''} ${r.use || ''} ${r.id}`, color: her ? '#9c3d16' : '#2e86ab', photo: r.photos?.[0], updated: r.updated, dist: distTo(featureCenter(f)) });
  }
  return out;
}
function todoHeritage() {
  if (hpById.size) return [...hpById.values()].filter(f => !S.heritage.get(f.properties.id)?.visited).map(f => ({
    key: f.properties.id, title: f.properties.name || `مبنى حفاظ ${f.properties.id}`, sub: `موقع تقريبي · ≈ ${fmtArea(f.properties.area_m2)}`,
    search: '', color: '#9c3d16', dist: distTo([f.geometry.coordinates[1], f.geometry.coordinates[0]]) }));
  return S.heritageGeo.features.filter(f => !S.heritage.get(f.properties.id)?.visited).map(f => {
    const hf = buildingFeature(f.properties.id);
    return { key: f.properties.id, title: `مبنى حفاظ ${f.properties.id}`, sub: `${fmtArea(f.properties.area_m2)}${f.properties.courtyard ? ' · بيه حوش' : ''}`,
      search: '', color: '#8b3a1a', dist: distTo(featureCenter(hf)) };
  });
}

function flyToFeature(id) {
  const f = S.features.get(id); if (!f) return;
  if (f.geometry.type === 'Point') map.flyTo(featureCenter(f), Math.max(map.getZoom(), 19));
  else map.flyToBounds(L.geoJSON(f).getBounds(), { maxZoom: 20, padding: [40, 40] });
}
function flyToBuilding(hid) {
  const f = buildingFeature(hid); if (!f) return;
  if (f.geometry.type === 'Point') return map.flyTo([f.geometry.coordinates[1], f.geometry.coordinates[0]], Math.max(map.getZoom(), 19));
  map.flyToBounds(L.geoJSON(f).getBounds(), { maxZoom: 20, padding: [60, 60] });
}

function measureText(f) {
  if (f.geometry.type === 'LineString') return 'الطول: ' + fmtLen(turf.length(f, { units: 'kilometers' }) * 1000);
  if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') return `المساحة: ${fmtArea(turf.area(f))} · المحيط: ${fmtLen(turf.length(turf.polygonToLine(f), { units: 'kilometers' }) * 1000)}`;
  const [lng, lat] = f.geometry.coordinates; return `<span dir="ltr">${lat.toFixed(6)}, ${lng.toFixed(6)}</span>`;
}

// form shared by new & edit
function featureForm(kind, p, noCategory) {
  const isLine = kind === 'line';
  return `
    <label class="f"><span>الاسم</span><input name="name" value="${esc(p.name)}" placeholder="${isLine ? 'مثلاً: دربونة الجامع' : 'مثلاً: المدرسة المستنصرية'}"></label>
    ${noCategory ? '' : `<label class="f"><span>التصنيف</span></label>${chipsHtml('category', CATS[kind].map(c => [c[0], c[1], c[2]]), p.category)}
    <div style="height:10px"></div>`}
    <label class="f"><span>الحالة</span></label>${chipsHtml('condition', CONDITIONS, p.condition)}
    <div style="height:10px"></div>
    ${isLine ? `
      <div class="grid2"><label class="f"><span>العرض التقريبي (م)</span><input name="width" inputmode="decimal" value="${esc(p.width)}"></label>
      <label class="f"><span>الحركة</span><select name="activity"><option value=""></option>${ACTIVITY.map(a => `<option ${p.activity === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label></div>
      <label class="f"><span>الأرضية</span></label>${chipsHtml('surface', SURFACES, p.surface)}<div style="height:10px"></div>
    ` : `
      <div class="grid2"><label class="f"><span>عدد الطوابق</span><input name="floors" inputmode="numeric" value="${esc(p.floors)}"></label>
      <label class="f"><span>الحقبة</span><select name="era"><option value=""></option>${ERAS.map(a => `<option ${p.era === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label></div>
      <div class="grid2"><label class="f"><span>الاستعمال الحالي</span><input name="use" value="${esc(p.use)}"></label>
      <label class="f"><span>الاستعمال الأصلي</span><input name="use_orig" value="${esc(p.use_orig)}"></label></div>
      <label class="f"><span>مواد البناء</span></label>${chipsHtml('materials', MATERIALS, p.materials || [], true)}<div style="height:10px"></div>
      <label class="f"><span>عناصر معمارية</span></label>${chipsHtml('elements', ELEMENTS, p.elements || [], true)}<div style="height:10px"></div>
    `}
    <label class="f"><span>ملاحظات التحليل</span><textarea name="notes" placeholder="الواجهات، الإطلالات، المشاكل، الإحساس بالمكان…">${esc(p.notes)}</textarea></label>
    <label class="f"><span>الصور</span></label>
    <div class="photos" id="fph"></div>
    <div class="row" style="margin-top:8px"><button type="button" class="btn" id="cam">📷 تصوير</button><button type="button" class="btn" id="gal">🖼 من المعرض</button></div>
    <div class="row" style="margin-top:16px"><button type="button" class="btn primary" id="save">حفظ</button><button type="button" class="btn" id="cancel">إلغاء</button></div>`;
}
function readForm(body, kind) {
  const v = n => $(`[name="${n}"]`, body)?.value.trim() ?? '';
  const out = { name: v('name'), category: chipVal(body, 'category'), condition: chipVal(body, 'condition'), notes: v('notes') };
  if (kind === 'line') Object.assign(out, { width: v('width'), activity: v('activity'), surface: chipVal(body, 'surface') });
  else Object.assign(out, { floors: v('floors'), era: v('era'), use: v('use'), use_orig: v('use_orig'), materials: chipVal(body, 'materials'), elements: chipVal(body, 'elements') });
  return out;
}

function editFeature(geometry, kind, existing) {
  const isNew = !existing;
  const p = existing ? { ...existing.properties } : { kind, category: kind === 'line' ? 'darb' : kind === 'polygon' ? 'building' : 'heritage', photos: [] };
  if (isNew && kind === 'line' && geometry._track) { p.category = 'track'; delete geometry._track; }
  let photos = [...(p.photos || [])];
  let saved = false;
  const preview = isNew ? L.geoJSON({ type: 'Feature', geometry }, { pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 9, color: '#fff', weight: 3, fillColor: '#e53935', fillOpacity: 1 }), style: { color: '#e53935', weight: 4, fillOpacity: .2 } }).addTo(L_.measure) : null;
  openSheet(isNew ? 'تسجيل عنصر جديد' : 'تعديل', `<p class="muted" style="margin-top:0">${measureText({ type: 'Feature', geometry })}</p>` + featureForm(kind, p), body => {
    wireChips(body);
    const grid = $('#fph', body);
    const redraw = () => renderPhotoGrid(grid, photos, id => { photos = photos.filter(x => x !== id); redraw(); });
    redraw();
    const add = async cap => { const files = await pickPhotos(cap); if (!files.length) return; toast('جاري حفظ الصور…'); photos.push(...await addPhotos(files)); redraw(); };
    $('#cam', body).onclick = () => add(true);
    $('#gal', body).onclick = () => add(false);
    $('#cancel', body).onclick = closeSheet;
    $('#save', body).onclick = async () => {
      const vals = readForm(body, kind);
      if (!vals.category) { toast('اختار التصنيف'); return; }
      const props = { ...p, ...vals, kind, photos, id: p.id || uid('F'), created: p.created || nowIso(), observer: p.observer || S.settings.observer, editedBy: S.settings.observer };
      const f = { type: 'Feature', properties: props, geometry: existing ? existing.geometry : geometry };
      await putFeature(f); saved = true;
      renderSurvey(); closeSheet(); toast('انحفظ ✓');
    };
    return () => { if (preview) L_.measure.removeLayer(preview); if (!saved && isNew) { /* discarded */ } };
  });
}

async function openFeature(id) {
  const f = S.features.get(id); if (!f) return;
  const p = f.properties, [, label, color] = catOf(p.kind, p.category), cond = condOf(p.condition);
  const c = featureCenter(f);
  const rows = [
    ['التصنيف', `<span class="badge"><span class="dot" style="background:${color}"></span>${label}</span>`],
    cond && ['الحالة', `<span class="badge"><span class="dot" style="background:${cond[2]}"></span>${cond[1]}</span>`],
    p.floors && ['الطوابق', esc(p.floors)], p.era && ['الحقبة', esc(p.era)],
    p.use && ['الاستعمال الحالي', esc(p.use)], p.use_orig && ['الاستعمال الأصلي', esc(p.use_orig)],
    p.materials?.length && ['المواد', esc(p.materials.join('، '))], p.elements?.length && ['عناصر', esc(p.elements.join('، '))],
    p.width && ['العرض', esc(p.width) + ' م'], p.surface && ['الأرضية', esc(p.surface)], p.activity && ['الحركة', esc(p.activity)],
    ['القياس', measureText(f)],
    S.me && ['يبعد عني', fmtLen(distTo(c))],
    ['سجّله', `${esc(p.observer || '—')} · ${fmtDate(p.created)}`],
  ].filter(Boolean);
  openSheet(p.name || label, `
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${p.notes ? `<h3>ملاحظات</h3><p style="white-space:pre-wrap;margin:0;font-size:14px;line-height:1.7">${esc(p.notes)}</p>` : ''}
    <h3>الصور (${(p.photos || []).length})</h3><div class="photos" id="dph"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="edit">تعديل المعلومات</button>
      ${p.kind !== 'point' ? '<button class="btn" id="shape">تعديل الشكل</button>' : '<button class="btn" id="move">نقلها لموقعي</button>'}
    </div>
    <div class="row" style="margin-top:8px">
      <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${c[0]},${c[1]}&travelmode=walking" target="_blank" rel="noopener">اتجاهات</a>
      <button class="btn danger" id="del">حذف</button>
    </div>`, body => {
    renderPhotoGrid($('#dph', body), p.photos || []);
    $('#edit', body).onclick = () => editFeature(f.geometry, p.kind, f);
    $('#del', body).onclick = async () => {
      if (!confirm(`حذف «${p.name || label}» نهائياً؟`)) return;
      S.features.delete(id); await DB.del('features', id);
      await DB.put('meta', { id: 'del:' + id, updated: nowIso() }); cloudKick();     // tell teammates' phones too
      for (const ph of p.photos || []) await DB.del('photos', ph);
      renderSurvey(); closeSheet(); toast('انحذف');
    };
    const mv = $('#move', body);
    if (mv) mv.onclick = async () => {
      if (!S.me) return toast('شغّل الـ GPS أول');
      f.geometry = { type: 'Point', coordinates: [S.me.lng, S.me.lat] }; await putFeature(f); renderSurvey(); toast('انتقلت لموقعك');
    };
    const sh = $('#shape', body);
    if (sh) sh.onclick = () => { closeSheet(); editShape(id); };
  });
}

function editShape(id) {
  const f = S.features.get(id);
  L_.survey.eachLayer(l => { if (l._fid === id) L_.survey.removeLayer(l); });
  const lyr = L.geoJSON(f, { style: { color: '#e53935', weight: 4, fillOpacity: .2 }, pmIgnore: false }).addTo(map);
  lyr.eachLayer(l => l.pm.enable({ allowSelfIntersection: false }));
  setMode('اسحب النقاط لتعديل الشكل', [
    ['حفظ', async () => { lyr.eachLayer(l => (f.geometry = l.toGeoJSON().geometry)); map.removeLayer(lyr); await putFeature(f); renderSurvey(); clearMode(); toast('انحفظ الشكل'); }, true],
    ['إلغاء', () => { map.removeLayer(lyr); renderSurvey(); clearMode(); }],
  ]);
}

// ---------------------------------------------------------------- building records (heritage + every other footprint)
const buildingTitle = (id, rec) => rec?.name || (hpById.get(id) || S.geoIndex?.get(id))?.properties.name || (isHeritageId(id) ? `مبنى حفاظ ${id}` : `مبنى ${id}`);
const OSM_KIND_AR = { school: 'مدرسة', place_of_worship: 'دار عبادة', archaeological_site: 'موقع أثري', bank: 'مصرف', exhibition_centre: 'معارض / غرفة تجارة',
  memorial: 'معلم تذكاري', sports: 'رياضي', building: 'مبنى', yes: 'مبنى', library: 'مكتبة', cafe: 'مقهى', restaurant: 'مطعم', marketplace: 'سوق' };
// rows of the always-known (computed) details every building has
function baseRows(bp) {
  return [
    bp.name && ['معروف باسم', esc(bp.name)],
    bp.osm_kind && OSM_KIND_AR[bp.osm_kind] && bp.osm_kind !== 'yes' && ['الصنف (OSM)', OSM_KIND_AR[bp.osm_kind]],
    (bp.street || bp.street_kind) && ['يطل على', `${esc(bp.street || bp.street_kind)}${bp.street_w ? ` · عرض ≈ ${bp.street_w} م` : ''}`],
    bp.near && ['أقرب معلم', `${esc(bp.near)} · ${bp.near_d} م`],
    ['المساحة / المحيط', `${fmtArea(bp.area_m2)} · ${bp.perim_m ?? '—'} م`],
    bp.courtyard && ['الحوش', 'بيه حوش داخلي'],
    bp.block && ['البلوك', `رقم ${bp.block}`],
  ];
}
async function addPhotosTo(id, capture) {
  const files = await pickPhotos(capture); if (!files.length) return false;
  toast('جاري حفظ الصور…');
  const ids = await addPhotos(files);
  const rec = { id, photos: [], ...(S.heritage.get(id) || {}) };
  rec.photos = [...(rec.photos || []), ...ids];
  if (!rec.visited) { rec.visited = true; rec.visitedAt = nowIso(); rec.visitedBy = S.settings.observer; }
  await putHeritage(rec); refreshBuilding(id);
  toast(`انضافت ${ids.length} صورة ✓`);
  return true;
}

// keep the selected thing visible next to / above the panel
function ensureVisible(latlng) {
  const r = $('#sheet').getBoundingClientRect(), p = map.latLngToContainerPoint(latlng);
  if (innerWidth < 900) { if (p.y > r.top - 50) map.panBy([0, p.y - r.top / 2], { animate: true }); }
  else if (p.x < r.right + 30) map.panBy([p.x - (r.right + innerWidth) / 2, 0], { animate: true });
}
// the knowledge-base place whose name matches this building (names can be joined with " / ")
const placeOf = base => { const n = base.properties.name; return n && (S.places || []).find(p => n.split(' / ').includes(p.name)); };
function openBuilding(id) {
  const base = S.geoIndex.get(id); if (!base) return;
  const rec = S.heritage.get(id) || { id, photos: [] };
  const f = buildingFeature(id), c = featureCenter(f), her = isHeritageId(id);
  const cond = condOf(rec.condition);
  select(id);
  const rows = [
    ['النوع', her ? '<span class="badge"><span class="dot" style="background:#9c3d16"></span>مبنى حفاظ</span>' : '<span class="badge"><span class="dot" style="background:#2e86ab"></span>مبنى</span>'],
    cond && ['الحالة', `<span class="badge"><span class="dot" style="background:${cond[2]}"></span>${cond[1]}</span>`],
    rec.floors && ['الطوابق', esc(rec.floors)], rec.era && ['الحقبة', esc(rec.era)],
    rec.use && ['الاستعمال الحالي', esc(rec.use)], rec.use_orig && ['الاستعمال الأصلي', esc(rec.use_orig)],
    rec.materials?.length && ['المواد', esc(rec.materials.join('، '))], rec.elements?.length && ['عناصر', esc(rec.elements.join('، '))],
    ...baseRows(base.properties),
    !rec.floors && base.properties.floors && ['الارتفاع (مسح CAD)', `${base.properties.height_m} م ≈ ${base.properties.floors} طابق`],
    S.me && ['يبعد عني', fmtLen(distTo(c))],
    rec.visitedAt && ['وثّقه', `${esc(rec.visitedBy || '—')} · ${fmtDate(rec.visitedAt)}`],
  ].filter(Boolean);
  const hpId = hpOfMember.get(id), fieldRec = hpId && S.heritage.get(hpId);
  const photos = [...new Set([...(rec.photos || []), ...(fieldRec?.photos || [])])];
  openSheet(buildingTitle(id, rec), `
    <div class="hero" id="hero">${photos.length ? '' : `<div class="hero-empty"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>ماكو صور لهذا المبنى بعد</span></div>`}</div>
    <div class="row" style="margin:10px 0 4px">
      <button class="btn primary" id="bCam">📷 صوّر المبنى</button>
      <button class="btn" id="bGal">🖼 من المعرض</button>
    </div>
    <h3>${her ? 'مبنى حفاظ — ' : ''}<span dir="ltr">${id}</span></h3>
    ${placeOf(base) ? `<button class="btn block" id="bPlace" style="margin-bottom:10px">📖 تاريخ المكان وعلاقته بالسايت</button>` : ''}
    ${hpId ? `<button class="btn block" id="bField" style="margin-bottom:10px">🛰 توثيق الميدان لهذا الموقع (${hpId})${fieldRec?.photos?.length ? ` · ${fieldRec.photos.length} صورة` : ''}</button>` : ''}
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${rec.notes ? `<h3>ملاحظات</h3><p style="white-space:pre-wrap;margin:0;font-size:14px;line-height:1.7">${esc(rec.notes)}</p>` : ''}
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="bEdit">${isDocumented(rec) ? 'تعديل التوثيق' : 'وثّق المبنى'}</button>
      <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${c[0]},${c[1]}&travelmode=walking" target="_blank" rel="noopener">اتجاهات</a>
    </div>`, body => {
    renderHero($('#hero', body), photos, id);
    $('#bCam', body).onclick = async () => { if (await addPhotosTo(id, true)) openBuilding(id); };
    $('#bGal', body).onclick = async () => { if (await addPhotosTo(id, false)) openBuilding(id); };
    $('#bEdit', body).onclick = () => editBuilding(id);
    const bp = $('#bPlace', body); if (bp) bp.onclick = () => openPlace(placeOf(base).name);
    const bf = $('#bField', body); if (bf) bf.onclick = () => { setAppMode('field'); flyToBuilding(hpId); openHeritagePoint(hpId); };
    return () => select(null);
  });
  ensureVisible(labelPoint(f));
}

function editBuilding(id) {
  const rec = { id, visited: false, photos: [], ...(S.heritage.get(id) || {}) };
  let photos = [...(rec.photos || [])];
  select(id);
  openSheet('توثيق ' + buildingTitle(id, rec), `
    ${swHtml('visited', 'زرناه ووثّقناه', rec.visitedAt ? `${esc(rec.visitedBy || '')} · ${fmtDate(rec.visitedAt)}` : 'يتعلّم تلقائياً لمن تضيف صور أو معلومات', rec.visited)}
    <div style="height:10px"></div>
    ${featureForm('point', rec, true)}`, body => {
    wireChips(body);
    const sw = $('.switch', body);
    sw.onclick = () => { rec.visited = !rec.visited; sw.classList.toggle('on', rec.visited); };
    const grid = $('#fph', body);
    const redraw = () => renderPhotoGrid(grid, photos, pid => { photos = photos.filter(x => x !== pid); redraw(); });
    redraw();
    const add = async cap => { const files = await pickPhotos(cap); if (!files.length) return; toast('جاري حفظ الصور…'); photos.push(...await addPhotos(files)); if (!rec.visited) { rec.visited = true; sw.classList.add('on'); } redraw(); };
    $('#cam', body).onclick = () => add(true);
    $('#gal', body).onclick = () => add(false);
    $('#cancel', body).onclick = () => openRecord(id);
    $('#save', body).onclick = async () => {
      const v = readForm(body, 'point'); delete v.category;
      const was = S.heritage.get(id)?.visited;
      Object.assign(rec, v, { photos });
      if (!rec.visited && isDocumented(rec)) rec.visited = true;
      if (rec.visited && !was) { rec.visitedAt = nowIso(); rec.visitedBy = S.settings.observer; }
      await putHeritage(rec); refreshBuilding(id); toast('انحفظ ✓'); openRecord(id);
    };
    return () => select(null);
  });
}

// big swipeable photo strip at the top of a building card
async function renderHero(el, ids, ownerId) {
  if (!ids.length) return;
  el.innerHTML = `<div class="hero-strip">${ids.map((pid, i) => `<button class="hero-ph" data-i="${i}" aria-label="صورة ${i + 1}"></button>`).join('')}</div><span class="hero-count">${ids.length} صورة</span>`;
  const btns = $$('.hero-ph', el);
  btns.forEach(async (b, i) => {
    const u = await photoUrl(ids[i], false);
    if (u) b.style.backgroundImage = `url(${u})`; else { b.classList.add('waiting'); b.textContent = '⏳ الصورة بعدها ترتفع من تلفون صاحبها'; }
  });
  el.onclick = e => { const b = e.target.closest('.hero-ph'); if (b) openGallery(ids, +b.dataset.i, ownerId); };
}

function openLandmark(f) {
  const [lng, lat] = f.geometry.coordinates;
  openSheet(f.properties.name, `
    <dl class="kv">${f.properties.name_en ? `<dt>بالإنكليزي</dt><dd>${esc(f.properties.name_en)}</dd>` : ''}
    <dt>المصدر</dt><dd>OpenStreetMap</dd>${S.me ? `<dt>يبعد عني</dt><dd>${fmtLen(distTo([lat, lng]))}</dd>` : ''}</dl>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="adopt">سجّله برصدنا</button>
    <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking" target="_blank" rel="noopener">اتجاهات</a></div>`,
  body => { $('#adopt', body).onclick = () => { editFeature({ type: 'Point', coordinates: [lng, lat] }, 'point', null); const n = $('#sheetBody [name="name"]'); if (n) n.value = f.properties.name; }; });
}


// ---------------------------------------------------------------- places to connect with + connection axes / triangle
const PLACE_CATS = {
  religious: ['ديني', '#0e7c66'], market: ['سوق', '#c27c0e'], khan: ['خان', '#b8860b'], heritage_house: ['بيت تراثي', '#9c3d16'],
  education: ['تعليمي', '#2e86ab'], cultural: ['ثقافي', '#8e44ad'], government: ['حكومي', '#6b5b95'], cafe: ['مقهى', '#d6336c'],
  street: ['شارع / سوق', '#e67e22'], palace: ['قصر', '#a0522d'], bath: ['حمّام', '#1f9bd1'], bridge: ['جسر', '#555555'], other: ['أخرى', '#7f8c8d'],
};
const placeCat = c => PLACE_CATS[c] || PLACE_CATS.other;
const walkTxt = m => m < 1 ? 'أقل من دقيقة' : `${Math.round(m)} دقيقة مشي`;
L_.places = L.featureGroup(); L_.axes = L.featureGroup();
map.createPane('axesPane').style.zIndex = 415;

function renderPlaces() {
  L_.places.clearLayers();
  for (const p of S.places || []) {
    const [, color] = placeCat(p.category);
    const sz = p.analysis_value === 'high' ? 16 : p.analysis_value === 'medium' ? 12 : 9;
    const m = L.marker([p.lat, p.lon], { pane: 'surveyPane', icon: L.divIcon({ className: '', html: `<div class="place-pin" style="width:${sz}px;height:${sz}px;background:${color}"></div>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] }) });
    lazyLabel(m, esc(p.name), { direction: 'top', offset: [0, -sz / 2 - 2], className: 'lbl lbl-lm' }, p.analysis_value === 'high' ? 16 : 18);
    m.on('click', () => openPlace(p.name));
    L_.places.addLayer(m);
  }
  syncLabels();
}

function renderAxes() {
  L_.axes.clearLayers();
  const ar = L.svg({ pane: 'axesPane' });
  const t = S.links?.triangle;
  if (t?.coords?.length === 3) {
    const tri = L.polygon(t.coords, { renderer: ar, color: '#b03ad8', weight: 2.5, dashArray: '10 7', fillColor: '#b03ad8', fillOpacity: .08 });
    tri.on('click', e => { L.DomEvent.stopPropagation(e); openTriangle(); });
    lazyLabel(tri, 'مثلث الربط — المتنبي', { direction: 'center', className: 'lbl lbl-axis' }, 15);
    L_.axes.addLayer(tri);
  }
  for (const [i, a] of (S.links?.axes || []).entries()) {
    if (!a.coords || a.coords.length < 2) continue;
    const l = L.polyline(a.coords, { renderer: ar, color: '#7b2cbf', weight: 4, opacity: .85, dashArray: '2 8', lineCap: 'round' });
    l.on('click', e => { L.DomEvent.stopPropagation(e); openAxis(i); });
    lazyLabel(l, esc(a.name_ar), { direction: 'center', className: 'lbl lbl-axis' }, 17);
    L_.axes.addLayer(l);
  }
  syncLabels();
}

function openPlace(name) {
  const p = (S.places || []).find(x => x.name === name); if (!p) return;
  const [label, color] = placeCat(p.category);
  openSheet(p.name, `
    <div class="row" style="gap:6px;margin-bottom:8px">
      <span class="badge"><span class="dot" style="background:${color}"></span>${label}</span>
      ${p.era ? `<span class="badge">${esc(p.era)}</span>` : ''}${p.built ? `<span class="badge">${esc(p.built)}</span>` : ''}
      ${p.analysis_value === 'high' ? '<span class="badge" style="background:#f3e2d8">قيمة تحليلية عالية</span>' : ''}
    </div>
    ${p.name_en ? `<p class="muted" style="margin:0 0 6px" dir="ltr">${esc(p.name_en)}</p>` : ''}
    <p style="margin:0;line-height:1.8;font-size:14.5px">${esc(p.summary_ar || '')}</p>
    ${p.site_relevance_ar ? `<h3>علاقته بالسايت</h3><p style="margin:0;line-height:1.8;font-size:14px">${esc(p.site_relevance_ar)}</p>` : ''}
    <div class="kpis" style="margin-top:12px">
      <div class="kpi"><b>${p.inside ? 'داخل' : fmtLen(p.dist_m)}</b><span>${p.inside ? 'السايت' : 'من حدود السايت'}</span></div>
      <div class="kpi"><b>${p.inside ? '—' : Math.round(p.walk_min)}</b><span>دقيقة مشي تقريباً</span></div>
      <div class="kpi"><b>${S.me ? fmtLen(distTo([p.lat, p.lon])) : '—'}</b><span>يبعد عني</span></div>
    </div>
    ${p.confidence === 'low' ? '<p class="muted" style="color:var(--warn)">⚠ المعلومات التاريخية لهذا المكان غير مؤكدة — تحقّقوا منها.</p>' : ''}
    ${(p.sources || []).filter(u => /^https:\/\//.test(u)).length ? `<p class="muted" style="margin:10px 0 0">مصادر: ${p.sources.filter(u => /^https:\/\//.test(u)).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener" dir="ltr">${esc(new URL(u).hostname)}</a>`).join(' · ')}</p>` : ''}
    <div class="row" style="margin-top:14px">
      ${p.inside ? '' : '<button class="btn primary" id="pAxis">ارسم محور ربط مع السايت</button>'}
      <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=walking" target="_blank" rel="noopener">اتجاهات</a>
    </div>
    <div class="row" style="margin-top:8px"><button class="btn" id="pAdopt">سجّله برصدنا (صور وملاحظات)</button></div>
    <p class="muted" style="margin-top:12px">الوصف من قاعدة معرفة مولّدة بالذكاء الاصطناعي (gpt-6-astra) ومربوطة بمواقع OpenStreetMap — راجعوها قبل الاعتماد عليها بالتقرير.</p>`, body => {
    const ax = $('#pAxis', body);
    if (ax) ax.onclick = () => { drawLinkToSite(p); closeSheet(); };
    $('#pAdopt', body).onclick = () => { editFeature({ type: 'Point', coordinates: [p.lon, p.lat] }, 'point', null); const n = $('#sheetBody [name="name"]'); if (n) n.value = p.name; };
  });
}

// straight link from the nearest point of the site edge to a place, with length and walking time
function drawLinkToSite(p) {
  const site = S.siteGeo; if (!site) return;
  const line = turf.polygonToLine(site);
  const near = turf.nearestPointOnLine(line, turf.point([p.lon, p.lat]));
  const a = [near.geometry.coordinates[1], near.geometry.coordinates[0]], b = [p.lat, p.lon];
  const d = map.distance(a, b);
  const l = L.polyline([a, b], { color: '#7b2cbf', weight: 4, dashArray: '2 8', lineCap: 'round' }).addTo(L_.measure);
  l.bindTooltip(`${esc(p.name)} · ${fmtLen(d)} · ≈ ${Math.round(d * 1.25 / 75)} دقيقة`, { permanent: true, direction: 'center', className: 'lbl lbl-axis' }).openTooltip();
  map.flyToBounds(L.latLngBounds([a, b]), { padding: [60, 60], maxZoom: 18 });
  toast('المحور مرسوم مؤقتاً — امسحه من زر القياس «مسح القياسات»', 4000);
}

function openAxis(i) {
  const a = S.links.axes[i];
  openSheet(a.name_ar, `
    <div class="row" style="gap:6px;margin-bottom:8px"><span class="badge"><span class="dot" style="background:#7b2cbf"></span>محور ${esc(a.type || '')}</span></div>
    <dl class="kv"><dt>من</dt><dd>${esc(a.from)}</dd><dt>إلى</dt><dd>${esc(a.to)}</dd>
    ${(a.via || []).length ? `<dt>مروراً بـ</dt><dd>${esc(a.via.join('، '))}</dd>` : ''}
    <dt>الطول (مستقيم)</dt><dd>${fmtLen(a.length_m)}</dd><dt>المشي</dt><dd>${walkTxt(a.walk_min)}</dd></dl>
    <h3>الفكرة</h3><p style="margin:0;line-height:1.8">${esc(a.rationale_ar || '')}</p>
    <p class="muted" style="margin-top:12px">مقترح من gpt-6-astra — للنقاش والتطوير، مو قرار تصميمي نهائي.</p>`);
}
function openTriangle() {
  const t = S.links.triangle;
  openSheet('مثلث الربط', `
    <p class="muted" style="margin-top:0">فكرة الدكتورة: ربط السايت مع شارع المتنبي ومحيطه.</p>
    <dl class="kv">${t.vertices.map((v, i) => `<dt>الرأس ${i + 1}</dt><dd>${esc(v)}</dd>`).join('')}
    <dt>محيط المثلث</dt><dd>${fmtLen(t.perimeter_m)}</dd><dt>مساحته</dt><dd>${fmtArea(t.area_m2)}</dd></dl>
    <h3>المفهوم</h3><p style="margin:0;line-height:1.8">${esc(t.concept_ar || '')}</p>
    <h3>أماكن داخل المثلث وحوله</h3><div id="triList"></div>`, body => {
    const poly = turf.polygon([[...t.coords.map(([la, lo]) => [lo, la]), [t.coords[0][1], t.coords[0][0]]]]);
    const inside = (S.places || []).filter(p => turf.booleanPointInPolygon(turf.point([p.lon, p.lat]), turf.buffer(poly, 0.06, { units: 'kilometers' })));
    $('#triList', body).innerHTML = inside.map(p => `<div class="list-item" data-pl="${esc(p.name)}"><div class="thumb" style="background:${placeCat(p.category)[1]}33"></div><div class="meta"><b>${esc(p.name)}</b><small>${placeCat(p.category)[0]}${p.era ? ' · ' + esc(p.era) : ''}</small></div></div>`).join('') || '<p class="muted">—</p>';
    $('#triList', body).onclick = e => { const n = e.target.closest('[data-pl]')?.dataset.pl; if (n) openPlace(n); };
  });
}

function linksHtml() {
  const out = (S.places || []).filter(p => !p.inside && p.analysis_value !== 'low').sort((a, b) => a.walk_min - b.walk_min).slice(0, 12);
  if (!out.length) return '';
  return `<h3>أماكن للربط مع السايت (الأقرب مشياً)</h3>
    ${S.links?.triangle ? `<button class="btn block" data-tri="1" style="margin-bottom:8px">مثلث الربط مع المتنبي — اقرأ الفكرة</button>` : ''}
    ${out.map(p => `<div class="list-item" data-pl="${esc(p.name)}"><div class="thumb" style="background:${placeCat(p.category)[1]}33"><span class="dot" style="width:12px;height:12px;border-radius:50%;background:${placeCat(p.category)[1]}"></span></div>
      <div class="meta"><b>${esc(p.name)}</b><small>${placeCat(p.category)[0]}${p.era ? ' · ' + esc(p.era) : ''}</small></div><span class="dist">${Math.round(p.walk_min)} د</span></div>`).join('')}`;
}


// ---------------------------------------------------------------- field mode: approximate heritage points (no boundaries)
// Each point stands for a group of heritage cells of the plan (`members`); records saved on a point
// show up in analysis mode on those cells, and boundaries drawn on site become survey polygons.
L_.hpts = L.featureGroup();
const hpById = new Map(), hpOfMember = new Map();
const isHP = id => hpById.has(id);
const hpRec = id => S.heritage.get(id) || { id, photos: [] };

function renderHeritagePoints() {
  L_.hpts.clearLayers();
  for (const [id, f] of hpById) {
    const rec = S.heritage.get(id), ph = rec?.photos?.[0], [lng, lat] = f.geometry.coordinates;
    const cls = `hp-pin${rec?.visited ? ' visited' : ''}${rec?.boundary ? ' drawn' : ''}`;
    const html = ph ? `<div class="thumb-pin hp-photo${rec?.visited ? ' visited' : ''}" data-ph="${ph}">${rec.photos.length > 1 ? `<b>${rec.photos.length}</b>` : ''}</div>`
      : `<div class="${cls}"><span>${id.slice(2)}</span></div>`;
    const m = L.marker([lat, lng], { pane: 'thumbPane', icon: L.divIcon({ className: '', html, iconSize: ph ? [38, 38] : [28, 28], iconAnchor: ph ? [19, 19] : [14, 14] }) });
    if (ph) m.on('add', async () => { const el = m.getElement()?.querySelector('[data-ph]'); if (el) el.style.backgroundImage = `url(${await photoUrl(ph)})`; });
    const nm = rec?.name || f.properties.name;
    if (nm) lazyLabel(m, esc(nm), { direction: 'top', offset: [0, -16], className: 'lbl lbl-name' }, 17);
    m.on('click', e => { L.DomEvent.stopPropagation(e); openHeritagePoint(id); });
    L_.hpts.addLayer(m);
  }
  syncLabels();
}

function openRecord(id) { if (isHP(id)) openHeritagePoint(id); else openBuilding(id); }

function openHeritagePoint(id) {
  const f = hpById.get(id); if (!f) return;
  const rec = hpRec(id), p = f.properties, [lng, lat] = f.geometry.coordinates;
  const cond = condOf(rec.condition);
  const bnd = rec.boundary && S.features.get(rec.boundary);
  const rows = [
    ['النوع', '<span class="badge"><span class="dot" style="background:#9c3d16"></span>مبنى حفاظ — موقع تقريبي</span>'],
    p.name && ['معروف باسم', esc(p.name)],
    cond && ['الحالة', `<span class="badge"><span class="dot" style="background:${cond[2]}"></span>${cond[1]}</span>`],
    rec.floors && ['الطوابق', esc(rec.floors)], rec.era && ['الحقبة', esc(rec.era)], rec.use && ['الاستعمال الحالي', esc(rec.use)],
    ['الحدود', bnd ? `مرسومة ✓ · ${fmtArea(turf.area(bnd))}` : 'بعد ما انرسمت — ارسمها بالموقع'],
    ['حسب المخطط', `≈ ${fmtArea(p.area_m2)}${p.courtyard ? ' · بيه حوش' : ''} · ${p.members.length} وحدة`],
    S.me && ['يبعد عني', fmtLen(distTo([lat, lng]))],
    rec.visitedAt && ['وثّقه', `${esc(rec.visitedBy || '—')} · ${fmtDate(rec.visitedAt)}`],
  ].filter(Boolean);
  openSheet(buildingTitle(id, rec), `
    <div class="hero" id="hero">${(rec.photos || []).length ? '' : `<div class="hero-empty"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>ماكو صور بعد — صوّروا المبنى من أكثر من زاوية</span></div>`}</div>
    <div class="row" style="margin:10px 0 4px">
      <button class="btn primary" id="hCam">📷 صوّر</button>
      <button class="btn" id="hGal">🖼 صور كثيرة من المعرض</button>
    </div>
    <div class="row" style="margin:8px 0 4px">
      <button class="btn${bnd ? '' : ' primary'}" id="hDraw">${bnd ? '✏️ عدّل الحدود' : '✏️ ارسم حدود المبنى'}</button>
      <button class="btn" id="hEdit">📝 ${isDocumented(rec) ? 'تعديل التوثيق' : 'وثّق المبنى'}</button>
    </div>
    <h3>مبنى حفاظ <span dir="ltr">${id}</span></h3>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${rec.notes ? `<h3>ملاحظات</h3><p style="white-space:pre-wrap;margin:0;font-size:14px;line-height:1.7">${esc(rec.notes)}</p>` : ''}
    <div class="row" style="margin-top:14px">
      <button class="btn" id="hAna">📊 شوفه بوضع التحليل</button>
      <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking" target="_blank" rel="noopener">اتجاهات</a>
    </div>
    <p class="muted" style="margin-top:10px">الموقع تقريبي من مخطط الحفاظ. المبنى الحقيقي يتحدد بالموقع — ارسم حدوده بعد ما تتأكد منه.</p>`, body => {
    renderHero($('#hero', body), rec.photos || [], id);
    $('#hCam', body).onclick = async () => { if (await addPhotosTo(id, true)) openHeritagePoint(id); };
    $('#hGal', body).onclick = async () => { if (await addPhotosTo(id, false)) openHeritagePoint(id); };
    $('#hEdit', body).onclick = () => editBuilding(id);
    $('#hDraw', body).onclick = () => { closeSheet(); if (bnd) editShape(bnd.properties.id); else drawHeritageBoundary(id); };
    $('#hAna', body).onclick = () => { closeSheet(); setAppMode('analysis'); const b = p.members.map(m => buildingFeature(m)).filter(Boolean); if (b.length) map.flyToBounds(L.geoJSON({ type: 'FeatureCollection', features: b }).getBounds(), { maxZoom: 19, padding: [60, 60] }); };
  });
}

function drawHeritageBoundary(id) {
  const [lng, lat] = hpById.get(id).geometry.coordinates;
  map.flyTo([lat, lng], Math.max(map.getZoom(), 19));
  startDraw('Polygon', async geometry => {
    const rec = hpRec(id);
    const f = { type: 'Feature', geometry, properties: { id: uid('F'), kind: 'polygon', category: 'heritage', name: buildingTitle(id, rec), heritageId: id,
      photos: [], created: nowIso(), observer: S.settings.observer, notes: '' } };
    await putFeature(f);
    rec.boundary = f.properties.id;
    if (!rec.visited) { rec.visited = true; rec.visitedAt = nowIso(); rec.visitedBy = S.settings.observer; }
    await putHeritage(rec);
    renderSurvey(); renderHeritagePoints(); toast('انحفظت حدود المبنى ✓'); openHeritagePoint(id);
  });
}

// ---------------------------------------------------------------- modes: field (clean) / analysis (all layers)
function setAppMode(mode) {
  S.settings.mode = mode; saveSettings();
  document.body.dataset.mode = mode;
  $$('.modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  applyLayerVisibility();
  toast(mode === 'field' ? 'وضع الميدان: خريطة نظيفة + مواقع الحفاظ التقريبية + رسمكم' : 'وضع التحليل: كل الطبقات المرجعية', 2200);
}
$$('.modes button').forEach(b => b.onclick = () => { closeSheet(); setAppMode(b.dataset.mode); });


// ---------------------------------------------------------------- team: live locations of friends
// No server of our own: positions go through free public MQTT brokers (several at once, so a network
// that blocks one port still gets through another). Everything is end-to-end encrypted with a key
// derived from the team code (AES-GCM); the broker only sees an opaque topic hash and ciphertext.
// Sharing is opt-in per person; stopping clears the retained position from the brokers.
const BROKERS = [
  { name: 'shiftr', url: 'wss://public.cloud.shiftr.io:443', opts: { username: 'public', password: 'public' } },
  { name: 'mosquitto', url: 'wss://test.mosquitto.org:8081' },
  { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
  { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' },
];
const MQTT_SRC = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
const TEAM_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324'];
const TEAM = { code: null, key: null, topic: null, clients: [], up: new Set(), members: new Map(), lastSent: 0, lastPos: null, beat: null, tick: null,
  lastMsg: null, g: { timer: null, busy: false, ok: 0, fail: 0, sent: 0 } };
L_.team = L.featureGroup();
map.createPane('teamPane').style.zIndex = 660;

// one id per installed app (sessionStorage override lets two tabs act as two people when testing)
const deviceId = (() => {
  try {
    const o = sessionStorage.getItem('ssm-device'); if (o) return o;
    let d = localStorage.getItem('ssm-device'); if (!d) { d = 'D' + crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 14); localStorage.setItem('ssm-device', d); }
    return d;
  } catch { return uid('D'); }
})();
const myColor = () => TEAM_COLORS[[...deviceId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % TEAM_COLORS.length];
const SITE_TEAM_CODE = 'RUSAF-AMAPS';   // the site's own team — everyone who opens the app is in it
const teamSettings = () => {
  const t = (S.settings.team ||= { code: null, sharing: false, viewing: true });
  if (!t.code && !t.left) t.code = SITE_TEAM_CODE;
  return t;
};
const normCode = c => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function newTeamCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint8Array(10));
  const s = [...r].map(b => A[b % A.length]).join(''); return s.slice(0, 5) + '-' + s.slice(5);
}

// ---- crypto
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function teamKeys(code) {
  const enc = new TextEncoder(), c = normCode(code);
  const base = await crypto.subtle.importKey('raw', enc.encode(c), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('ssm-team-v1'), iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('ssm-topic:' + c)));
  return { key, topic: 'ssm-rusafa/' + [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('') };
}
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, TEAM.key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return b64(out);
}
async function unseal(s) {
  const u = unb64(s);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, TEAM.key, u.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---- connection
let mqttLib;
function loadMqtt() {
  return mqttLib || (mqttLib = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = MQTT_SRC;
    sc.onload = () => res(window.mqtt); sc.onerror = () => { mqttLib = null; rej(new Error('mqtt')); };
    document.head.appendChild(sc);
  }));
}
function teamDisconnect() {
  for (const c of TEAM.clients) { try { c.end(true); } catch {} }
  TEAM.clients = []; TEAM.up.clear(); updateTeamBadge();
  clearTimeout(TEAM.g.timer); TEAM.g.timer = null;
}

// ---- backup channel: the team's own Apps Script. Public brokers are free and can go down; this one is
// Google's. Every ~10 s (25 s while a broker is up) each phone posts its latest sealed position and gets
// everyone else's back. Same end-to-end encryption — the script only stores ciphertext, for ≤ 6 h.
function googleLocStart() {
  clearTimeout(TEAM.g.timer);
  TEAM.g.timer = setTimeout(googleLoc, 1500);
}
async function googleLoc() {
  clearTimeout(TEAM.g.timer);
  const ts = teamSettings();
  if (!ts.code || !TEAM.topic || !cloudOn()) return;
  const next = () => { TEAM.g.timer = setTimeout(googleLoc, document.hidden ? 30000 : TEAM.up.size ? 25000 : 10000); };
  if (TEAM.g.busy || !navigator.onLine) return next();
  TEAM.g.busy = true;
  try {
    const body = { action: 'loc', topic: TEAM.topic, id: deviceId };
    if (ts.sharing && TEAM.lastMsg) { body.msg = TEAM.lastMsg; TEAM.g.sent = Date.now(); }
    const j = await cloudCall(body, 20000);
    TEAM.g.ok = Date.now(); TEAM.g.fail = 0;
    for (const l of j.locs || []) if (l.id !== deviceId) await onTeamMessage(`${TEAM.topic}/${l.id}`, l.m);
  } catch { TEAM.g.fail++; }
  finally { TEAM.g.busy = false; updateTeamBadge(); next(); }
}
// sharing needs the app on screen (browsers pause GPS when the screen locks) — so keep the screen awake
let shareLock = null;
async function keepAwake() {
  const want = teamSettings().sharing && document.visibilityState === 'visible';
  if (want && !shareLock) { try { shareLock = await navigator.wakeLock?.request('screen'); shareLock?.addEventListener('release', () => { shareLock = null; }); } catch {} }
  else if (!want && shareLock) { try { await shareLock.release(); } catch {} shareLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !TEAM.topic) return;
  keepAwake();                                                // wake locks drop when the app is hidden
  if (teamSettings().sharing) teamPublish(true);
  googleLoc();                                                // catch up right away
});
async function teamConnect() {
  const ts = teamSettings();
  teamDisconnect();
  if (!ts.code) return;
  if (!window.crypto?.subtle) { toast('مشاركة الموقع تحتاج رابط آمن (https)'); return; }
  Object.assign(TEAM, await teamKeys(ts.code), { code: normCode(ts.code) });
  googleLocStart();
  keepAwake();
  let mq;
  try { mq = await loadMqtt(); } catch { updateTeamBadge(); return; }       // Google channel still carries positions
  const myTopic = `${TEAM.topic}/${deviceId}`;
  // if the phone drops off, brokers tell the team (last will) instead of showing a frozen dot
  const will = ts.sharing ? { topic: myTopic, payload: await seal({ off: 1, n: S.settings.observer, t: Date.now() }), qos: 0, retain: true } : undefined;
  for (const b of BROKERS) {
    const c = mq.connect(b.url, { ...(b.opts || {}), clientId: `ssm_${deviceId}_${Math.random().toString(36).slice(2, 6)}`, clean: true,
      connectTimeout: 10000, reconnectPeriod: 10000, keepalive: 30, will });
    c.on('connect', () => { TEAM.up.add(b.name); c.subscribe(`${TEAM.topic}/+`, { qos: 0 }); updateTeamBadge(); if (ts.sharing) teamPublish(true); });
    c.on('close', () => { TEAM.up.delete(b.name); updateTeamBadge(); });
    c.on('error', () => {});
    c.on('message', (topic, payload) => onTeamMessage(topic, payload));
    TEAM.clients.push(c);
  }
  clearInterval(TEAM.beat); TEAM.beat = setInterval(() => teamPublish(true), 30000);
  clearInterval(TEAM.tick); TEAM.tick = setInterval(renderTeam, 15000);
}
async function onTeamMessage(topic, payload) {
  const id = topic.split('/').pop();
  if (id === deviceId) return;
  const s = payload.toString();
  if (!s) { TEAM.members.delete(id); renderTeam(); return; }                 // member stopped sharing
  let m; try { m = await unseal(s); } catch { return; }                       // not our team / tampered
  const cur = TEAM.members.get(id);
  // last will ("connection dropped"): its timestamp is from when that phone connected, so it is older than
  // the positions sent since — apply it to the last known position instead of comparing times
  if (m.off) {
    if (cur && !cur.off) {
      const t0 = cur.t;
      setTimeout(() => { const c = TEAM.members.get(id); if (c && c.t === t0 && !c.off) { c.off = true; c.offAt = Date.now(); renderTeam(); } }, 45000);
    }
    return;
  }
  if (cur && cur.t >= m.t) return;                                            // same message via another channel
  TEAM.members.set(id, { ...m, id, off: false });
  renderTeam();
}
async function teamPublish(force) {
  const ts = teamSettings();
  if (!ts.sharing || !S.me || !TEAM.key) return;
  const now = Date.now();
  if (now - S.me.t > 90000) return;                                          // no precise fix lately: let it go stale honestly
  const moved = TEAM.lastPos ? map.distance(TEAM.lastPos, [S.me.lat, S.me.lng]) : Infinity;
  if (!force && (now - TEAM.lastSent < 5000 || (moved < 8 && now - TEAM.lastSent < 30000))) return;
  TEAM.lastSent = now; TEAM.lastPos = [S.me.lat, S.me.lng];
  const msg = await seal({ n: S.settings.observer || 'بدون اسم', c: myColor(), la: +S.me.lat.toFixed(6), lo: +S.me.lng.toFixed(6),
    a: Math.round(S.me.acc), h: S.me.heading != null ? Math.round(S.me.heading) : null, t: now });
  TEAM.lastMsg = msg;
  for (const c of TEAM.clients) if (c.connected) c.publish(`${TEAM.topic}/${deviceId}`, msg, { qos: 0, retain: true });
  if (!TEAM.up.size && now - TEAM.g.sent > 8000) googleLoc();   // no broker: don't wait for the next Google round
}
async function teamStopSharing() {
  // clear our retained position so nobody sees a stale dot, then reconnect without a last will
  for (const c of TEAM.clients) if (c.connected) c.publish(`${TEAM.topic}/${deviceId}`, '', { qos: 0, retain: true });
  TEAM.lastMsg = null;
  if (TEAM.topic && cloudOn()) { try { await cloudCall({ action: 'loc', topic: TEAM.topic, id: deviceId, msg: '' }, 8000); } catch {} }
  else await new Promise(r => setTimeout(r, 400));
}

// ---- map
function agoTxt(t) {
  const s = (Date.now() - t) / 1000;
  return s < 45 ? 'هسه' : s < 3600 ? `قبل ${Math.round(s / 60)} د` : `قبل ${Math.round(s / 3600)} س`;
}
const initials = n => (n || '؟').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('');
const mateLayers = new Map();   // member id -> { mk, circle, key }
function glide(mk, to, ms = 1200) {
  const from = mk.getLatLng(), t0 = performance.now();
  if (from.distanceTo(to) > 300 || document.hidden) return mk.setLatLng(to);   // big jumps: no animation
  cancelAnimationFrame(mk._glide);
  const stepFn = now => {
    const k = Math.min(1, (now - t0) / ms), e = k * (2 - k);
    mk.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
    if (k < 1) mk._glide = requestAnimationFrame(stepFn);
  };
  mk._glide = requestAnimationFrame(stepFn);
}
function renderTeam() {
  const ts = teamSettings();
  for (const [id, m] of TEAM.members) if ((Date.now() - m.t) / 1000 > 6 * 3600) TEAM.members.delete(id);
  for (const [id, L0] of mateLayers) if (!TEAM.members.has(id) || !ts.viewing) { L_.team.removeLayer(L0.mk); if (L0.circle) L_.team.removeLayer(L0.circle); mateLayers.delete(id); }
  if (ts.viewing) for (const [id, m] of TEAM.members) {
    if (m.la == null) continue;
    const age = (Date.now() - m.t) / 1000, stale = m.off || age > 120;
    const key = `${m.c}|${stale}|${m.h}|${m.n}`;
    let L0 = mateLayers.get(id);
    const icon = () => L.divIcon({ className: '', html: `<div class="mate${stale ? ' stale' : ''}" style="--c:${m.c}">${m.h != null && !stale ? `<i class="mate-hd" style="transform:rotate(${m.h}deg)"></i>` : ''}<span>${esc(initials(m.n))}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    if (!L0) {
      const mk = L.marker([m.la, m.lo], { pane: 'teamPane', zIndexOffset: 900, icon: icon() });
      mk.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -16], className: 'lbl lbl-mate' });
      mk.on('click', () => openTeam());
      L0 = { mk, circle: null, key }; mateLayers.set(id, L0); L_.team.addLayer(mk);
    } else {
      if (L0.key !== key) { L0.mk.setIcon(icon()); L0.key = key; }
      glide(L0.mk, [m.la, m.lo]);
    }
    L0.mk.setTooltipContent(`${esc(m.n)} · ${m.off ? 'انقطع ' + agoTxt(m.t) : agoTxt(m.t)}`);
    const showC = !stale && m.a && m.a < 80;
    if (showC && !L0.circle) { L0.circle = L.circle([m.la, m.lo], { radius: m.a, color: m.c, weight: 1, fillColor: m.c, fillOpacity: .08, interactive: false, pane: 'teamPane' }); L_.team.addLayer(L0.circle); }
    else if (!showC && L0.circle) { L_.team.removeLayer(L0.circle); L0.circle = null; }
    if (L0.circle) L0.circle.setLatLng([m.la, m.lo]).setRadius(m.a);
  }
  updateTeamBadge();
  if (!$('#sheet').hidden && $('#sheet').dataset.panel === 'team') renderTeamList();
}
const googleUp = () => TEAM.g.ok && Date.now() - TEAM.g.ok < 70000;
function teamStatusHtml() {
  if (!TEAM.code) return '';
  const live = TEAM.up.size ? `✓ مباشر (${TEAM.up.size} من ${BROKERS.length} خوادم)` : '✗ المباشر مقطوع';
  const g = googleUp() ? '✓ احتياطي Google' : TEAM.g.fail ? '✗ احتياطي Google' : '⏳ احتياطي Google';
  const any = TEAM.up.size || googleUp();
  return `${any ? '<span class="dot-live"></span> ' : '⚠ '}${live} · ${g}${any ? '' : ' — جاري إعادة الاتصال…'}`;
}
function updateTeamBadge() {
  const st = $('#teamStatus');
  if (st) st.innerHTML = teamStatusHtml();
  const b = $('#btnTeam'); if (!b) return;
  const live = [...TEAM.members.values()].filter(m => !m.off && Date.now() - m.t < 120000).length;   // fresh = < 2 min
  b.classList.toggle('on', !!teamSettings().sharing);
  b.dataset.count = live || '';
  b.title = TEAM.code ? `الفريق — ${[TEAM.up.size && 'مباشر', googleUp() && 'Google'].filter(Boolean).join(' + ') || 'جاري الاتصال'}` : 'الفريق';
}

// ---- panel
function renderTeamList() {
  const el = $('#teamList'); if (!el) return;
  const st = $('#teamStatus');
  if (st) st.innerHTML = teamStatusHtml();
  const arr = [...TEAM.members.values()].sort((a, b) => b.t - a.t);
  el.innerHTML = arr.length ? arr.map(m => `<div class="list-item" data-mate="${esc(m.id)}">
      <div class="thumb" style="background:${m.c}"><b style="color:#fff">${esc(initials(m.n))}</b></div>
      <div class="meta"><b>${esc(m.n)}</b><small>${m.off ? 'انقطع الاتصال · آخر موقع ' + agoTxt(m.t) : agoTxt(m.t)}${m.a ? ` · دقة ±${m.a} م` : ''}</small></div>
      ${S.me && m.la != null ? `<span class="dist">${fmtLen(map.distance([S.me.lat, S.me.lng], [m.la, m.lo]))}</span>` : ''}</div>`).join('')
    : `<p class="muted">${TEAM.code ? 'ماكو أحد من الفريق مشارك موقعه هسه.' : ''}</p>`;
}
// first open: who are you, and do you want the team to see you on the map?
function openWelcome() {
  openSheet('أهلاً بيك 👋', `
    <p class="muted" style="margin-top:0">التطبيق مربوط تلقائياً بفريق السايت وبـ Drive الفريق — صورك وملاحظاتك توصل للكل.</p>
    <label class="f"><span>اسمك (يطلع على صورك وعلى موقعك بالخريطة)</span><input id="wName" value="${esc(S.settings.observer)}" placeholder="مثلاً: محمد تقي"></label>
    ${swHtml('wShare', 'شارك موقعي ويه الفريق', 'يشوفون وين أنت ويه حركتك وأنت بالسايت — تكدر توقفه بأي وقت من زر 👥', true, 'background:#3ddc84;border-radius:50%')}
    <button class="btn primary block" id="wGo" style="margin-top:12px">يلا نبدي</button>`, body => {
    const sw = $('.switch', body); sw.onclick = () => sw.classList.toggle('on');
    $('#wGo', body).onclick = async () => {
      const n = $('#wName', body).value.trim();
      if (!n) { toast('اكتب اسمك حتى الفريق يعرفك'); return $('#wName', body).focus(); }
      S.settings.observer = n; S.settings.welcomed = true;
      const ts = teamSettings(), share = sw.classList.contains('on');
      if (share !== !!ts.sharing) { ts.sharing = share; }
      await saveSettings(); closeSheet();
      if (share) { startGps(); await teamConnect(); toast('موقعك صار يطلع للفريق — وتشوف مواقعهم هم'); }
      else toast('تكدر تشغّل مشاركة الموقع بعدين من زر 👥');
    };
  });
}
function openTeam() {
  const ts = teamSettings();
  const link = ts.code ? `${location.origin}${location.pathname}#team=${normCode(ts.code)}` : '';
  openSheet('الفريق — مواقع الأصدقاء', ts.code ? `
    <p class="muted" id="teamStatus" style="margin-top:0"></p>
    <div class="team-code"><span>كود الفريق</span><b dir="ltr">${esc(ts.code)}</b></div>
    <div class="row" style="margin:8px 0"><button class="btn primary" id="tShare">إرسال الكود للأصدقاء</button><button class="btn" id="tCopy">نسخ الرابط</button></div>
    <label class="f"><span>اسمك (يشوفه الفريق)</span><input id="tName" value="${esc(S.settings.observer)}" placeholder="مثلاً: محمد تقي"></label>
    ${swHtml('sharing', 'شارك موقعي مع الفريق', 'الشاشة تبقى شغّالة وأنت تشارك — إذا قفلتها يوقف لحد ما ترجع للتطبيق', ts.sharing, `background:${myColor()};border-radius:50%`)}
    ${swHtml('viewing', 'اعرض الفريق على الخريطة', '', ts.viewing)}
    <h3>الأعضاء</h3><div id="teamList"></div>
    <hr><p class="muted">🔒 المواقع تنتقل بطريقين بنفس الوقت: خوادم مباشرة (أسرع) وسكربت Google مال الفريق (احتياطي إذا وكعت الخوادم). مشفّرة من التلفون للتلفون بكود الفريق — محد بالطريق يكدر يقراها. أي واحد عنده الكود يشوف المواقع، فلا تنشروه برّه الفريق. لمن توقف المشاركة ينمسح موقعك.</p>
    <button class="btn danger block" id="tLeave">مغادرة الفريق</button>` : `
    <p class="muted" style="margin-top:0">شوفوا بعض على الخريطة وأنتم بالسايت. واحد يسوّي فريق ويدز الكود للباقين.</p>
    <label class="f"><span>اسمك (يشوفه الفريق)</span><input id="tName" value="${esc(S.settings.observer)}" placeholder="مثلاً: محمد تقي"></label>
    <button class="btn primary block" id="tNew">سوّي فريق جديد</button>
    <h3>أو انضم لفريق</h3>
    <label class="f"><input id="tCode" placeholder="الكود مثل: K7Q2M-XR4PA" dir="ltr" autocapitalize="characters"></label>
    <button class="btn block" id="tJoin">انضم</button>`, body => {
    $('#sheet').dataset.panel = 'team';
    const nameOk = () => { const n = $('#tName', body).value.trim(); if (!n) { toast('اكتب اسمك أول'); $('#tName', body).focus(); return false; } S.settings.observer = n; saveSettings(); return true; };
    $('#tName', body).onchange = () => { S.settings.observer = $('#tName', body).value.trim(); saveSettings(); if (ts.sharing) teamPublish(true); };
    const join = async code => { if (!nameOk()) return; ts.code = code; ts.viewing = true; saveSettings(); await teamConnect(); openTeam(); };
    if (!ts.code) {
      $('#tNew', body).onclick = () => join(newTeamCode());
      $('#tJoin', body).onclick = () => { const c = normCode($('#tCode', body).value); if (c.length < 8) return toast('الكود ناقص'); join(c.slice(0, 5) + '-' + c.slice(5)); };
    } else {
      renderTeamList();
      $('#tShare', body).onclick = async () => {
        const text = `انضم لفريق مسح السايت حتى نشوف مواقع بعض:\n${link}\nالكود: ${ts.code}`;
        if (navigator.share) { try { await navigator.share({ title: 'فريق مسح السايت', text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
        try { await navigator.clipboard.writeText(text); toast('انسخ — الصقه بالكروب'); } catch { prompt('انسخ هذا وأرسله:', text); }
      };
      $('#tCopy', body).onclick = async () => { try { await navigator.clipboard.writeText(link); toast('انسخ الرابط'); } catch { prompt('الرابط:', link); } };
      body.addEventListener('click', async e => {
        const sw = e.target.closest('.switch');
        if (sw) {
          const k = sw.dataset.key;
          if (k === 'sharing') {
            if (!ts.sharing && !nameOk()) return;
            if (ts.sharing) await teamStopSharing();
            ts.sharing = !ts.sharing; saveSettings();
            if (ts.sharing) { startGps(); toast('موقعك صار يطلع للفريق'); } else toast('وقفت مشاركة موقعك');
            keepAwake();
            await teamConnect();                       // reconnect so the last-will matches the new state
          } else { ts.viewing = !ts.viewing; saveSettings(); renderTeam(); }
          sw.classList.toggle('on', !!ts[k]); sw.setAttribute('aria-checked', !!ts[k]);
          return;
        }
        const it = e.target.closest('[data-mate]');
        if (it) { const m = TEAM.members.get(it.dataset.mate); if (m?.la != null) { map.flyTo([m.la, m.lo], 19); closeSheet(); } }
      });
      $('#tLeave', body).onclick = async () => {
        if (!confirm('تطلع من الفريق وتوقف مشاركة موقعك؟')) return;
        if (ts.sharing) await teamStopSharing();
        Object.assign(ts, { code: null, sharing: false, left: true }); saveSettings();
        teamDisconnect(); TEAM.members.clear(); renderTeam(); closeSheet(); toast('طلعت من الفريق');
      };
    }
    return () => { delete $('#sheet').dataset.panel; };
  });
}
$('#btnTeam').onclick = openTeam;

// joining from a shared link: https://…/maps/#team=CODE
// cloud join link (made by the Apps Script `setup`): https://…/maps/#cloud=<encoded web app url>~<key>
async function cloudFromLink() {
  const m = location.hash.match(/cloud=([^~&]+)~([A-Za-z0-9]+)/); if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const url = decodeURIComponent(m[1]);
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return toast('رابط المزامنة غير صالح');
  const c = cloudCfg();
  if (c.url === url && c.key === m[2]) return;
  if (!confirm('تفعّل المزامنة السحابية مع Drive الفريق؟ صورك وسجلاتك راح تنرفع وتشوف شغل الباقين.')) return;
  Object.assign(c, { url, key: m[2], lastPull: '', lastPush: '' }); await saveSettings();
  try { const j = await cloudCall({ action: 'ping' }, 30000); toast(`✓ المزامنة شغّالة — بالسحابة ${j.photos} صورة`, 4000); }
  catch (e) { toast('⚠ ما اشتغلت المزامنة: ' + e.message, 5000); }
  cloudStart();
}
// the same link, so a teammate who is already set up can invite others
function cloudJoinLink() { const c = cloudCfg(); return `${location.origin}${location.pathname}#cloud=${encodeURIComponent(c.url)}~${c.key}`; }
async function teamFromLink() {
  const m = location.hash.match(/team=([A-Za-z0-9-]+)/); if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const c = normCode(m[1]); if (c.length < 8) return;
  const code = c.slice(0, 5) + '-' + c.slice(5), ts = teamSettings();
  if (ts.code === code) return;
  if (!confirm(`تنضم لفريق ${code} حتى تشوفون مواقع بعض؟`)) return;
  if (ts.sharing) await teamStopSharing();
  Object.assign(ts, { code, sharing: false, viewing: true }); saveSettings();
  await teamConnect(); openTeam();
}


// ---------------------------------------------------------------- team cloud: Google Drive via the user's Apps Script
// Photos are uploaded once (sequentially, resumable), records are pushed when they change and pulled
// from teammates. Remote photos are fetched on demand through the script and kept on the device.
const CLOUD = { busy: false, timer: null, debounce: null, state: '', err: '', up: 0, upTotal: 0, lastOk: 0 };
// the team's Apps Script (cloud/Code.gs, open access): every visitor syncs with it automatically
const TEAM_CLOUD_URL = 'https://script.google.com/macros/s/AKfycbzabFq7IVXtCGArW3T26G8PnlX5bmAh7XYpk89QOR5iO_bs-wsRCfCAgQZvgE8p8a-0gA/exec';
const cloudCfg = () => {
  const c = (S.settings.cloud ||= { url: '', key: '', lastPull: '', lastPush: '' });
  if (!c.url) { c.url = TEAM_CLOUD_URL; c.key = c.key || 'open'; }
  return c;
};
const cloudOn = () => { const c = cloudCfg(); return !!(c.url && c.key); };
async function cloudCall(body, timeoutMs = 60000) {
  const c = cloudCfg();
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // text/plain keeps it a "simple" request (no CORS preflight) — Apps Script answers through a redirect
    const r = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, key: c.key, device: deviceId }), signal: ctl.signal, redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'cloud error');
    return j;
  } finally { clearTimeout(to); }
}
const blobToB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
const b64ToBlob = (b, mime) => new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))], { type: mime });
function setCloudState(state, err = '') { CLOUD.state = state; CLOUD.err = err; const el = $('#cloudStatus'); if (el) el.innerHTML = cloudStatusHtml(); updateCloudBadge(); }
function cloudStatusHtml() {
  if (!cloudOn()) return 'غير مفعّلة — الصور تبقى على هذا التلفون بس.';
  const ago = CLOUD.lastOk ? agoTxt(CLOUD.lastOk) : '—';
  const up = CLOUD.upTotal ? ` · رفع الصور ${CLOUD.up}/${CLOUD.upTotal}` : '';
  return { idle: `✓ متزامن · آخر مزامنة ${ago}`, sync: `⏳ جاري المزامنة${up}`, offline: '📴 بدون نت — راح تتزامن لمن يرجع', error: `⚠ ${esc(CLOUD.err)} — راح يعيد المحاولة` }[CLOUD.state] || `آخر مزامنة ${ago}`;
}
function updateCloudBadge() {
  const b = document.querySelector('.dock [data-panel="more"]'); if (!b) return;
  b.classList.toggle('cloud-sync', CLOUD.state === 'sync');
  b.classList.toggle('cloud-err', CLOUD.state === 'error');
}
// which record owns a photo → its Drive sub-folder ("HP20 خان مرجان الاثري")
function photoOwners() {
  const m = new Map();
  for (const f of S.features.values()) for (const ph of f.properties.photos || []) m.set(ph, { id: f.properties.id, name: f.properties.name || catOf(f.properties.kind, f.properties.category)[1] });
  for (const r of S.heritage.values()) for (const ph of r.photos || []) m.set(ph, { id: r.id, name: buildingTitle(r.id, r) });
  return m;
}

async function cloudSync() {
  if (!cloudOn() || CLOUD.busy) return;
  if (!navigator.onLine) return setCloudState('offline');
  CLOUD.busy = true; setCloudState('sync');
  const c = cloudCfg();
  try {
    // 1) push changed records (features, building records, deletions)
    const recs = [];
    for (const f of S.features.values()) if ((f.properties.updated || '') > (c.lastPush || '')) recs.push({ id: f.properties.id, store: 'features', updated: f.properties.updated, data: f });
    for (const r of S.heritage.values()) if ((r.updated || '') > (c.lastPush || '')) recs.push({ id: r.id, store: 'heritage', updated: r.updated, data: r });
    for (const d of await DB.all('meta')) if (d.id.startsWith('del:') && (d.updated || '') > (c.lastPush || '')) recs.push({ id: d.id.slice(4), store: 'deleted', updated: d.updated, data: { id: d.id.slice(4) } });
    for (let i = 0; i < recs.length; i += 40) await cloudCall({ action: 'putRecords', records: recs.slice(i, i + 40) });
    if (recs.length) { c.lastPush = recs.reduce((a, r) => (r.updated > a ? r.updated : a), c.lastPush || ''); await saveSettings(); }

    // 2a) thumbnails first — a few KB each, so teammates see every photo within seconds
    const owners = photoOwners();
    const local = (await DB.all('photos')).filter(p => p.blob && !p.remote);
    const meta = p => ({ created: p.created, observer: p.observer || S.settings.observer, lat: p.lat, lng: p.lng, name: p.name });
    for (const p of local.filter(p => !p.thumbSent && !p.cloud && p.thumb)) {
      try {
        await cloudCall({ action: 'putThumb', id: p.id, thumb: await blobToB64(p.thumb), ownerId: owners.get(p.id)?.id || '', ownerName: owners.get(p.id)?.name || '', meta: meta(p) }, 30000);
        p.thumbSent = true; await DB.put('photos', p);
      } catch (e) { if (!navigator.onLine) throw e; }
    }
    // 2b) then the full photos, one at a time; one failing photo never blocks the others
    const pending = local.filter(p => !p.cloud && (p.cloudErrs || 0) < 5);
    CLOUD.upTotal = pending.length; CLOUD.up = 0;
    let failed = 0;
    for (const p of pending) {
      if (!navigator.onLine) throw new Error('انقطع النت');
      try {
        const big = p.blob.size > 1.5e6;
        const preview = big ? await compressImage(p.blob, 1600, .82).catch(() => null) : null;
        const j = await cloudCall({ action: 'putPhoto', id: p.id, mime: p.blob.type || 'image/jpeg', data: await blobToB64(p.blob),
          preview: preview ? await blobToB64(preview) : undefined, thumb: p.thumb ? await blobToB64(p.thumb) : undefined,
          ownerId: owners.get(p.id)?.id || '', ownerName: owners.get(p.id)?.name || '', meta: meta(p) }, 60000 + p.blob.size / 25);   // ≈ 25 KB/s worst case
        p.cloud = j.fileId;
        // the original is safe in Drive now: keep the light 1600 px copy on the phone so storage doesn't fill up
        if (preview) { p.blob = preview; p.slim = true; }
      } catch (e) {
        if (!navigator.onLine) throw e;
        p.cloudErrs = (p.cloudErrs || 0) + 1; failed++;
      }
      await DB.put('photos', p);
      CLOUD.up++; setCloudState('sync');
    }
    CLOUD.upTotal = 0;

    // 3) pull teammates' changes (2-minute overlap covers writes that raced the previous pull)
    const since = c.lastPull ? new Date(new Date(c.lastPull).getTime() - 120000).toISOString() : '';
    const j = await cloudCall({ action: 'pull', since });
    const feats = j.records.filter(r => r.store === 'features').map(r => r.data);
    const hers = j.records.filter(r => r.store === 'heritage').map(r => r.data);
    let changed = (await mergeFeatures(feats)) + (await mergeHeritage(hers));
    for (const r of j.records.filter(r => r.store === 'deleted')) {
      if (S.features.has(r.id)) { S.features.delete(r.id); await DB.del('features', r.id); changed++; }
    }
    let newPhotos = 0;
    for (const ph of j.photos) {
      const cur = await DB.get('photos', ph.id);
      const thumb = ph.thumb ? b64ToBlob(ph.thumb, 'image/webp') : null;
      if (!cur) { await DB.put('photos', { id: ph.id, cloud: ph.fileId || '', remote: true, created: ph.created, observer: ph.observer, owner: ph.owner, thumb }); newPhotos++; }
      else if (cur.remote && ((ph.fileId && !cur.cloud) || (thumb && !cur.thumb))) {
        if (ph.fileId) cur.cloud = ph.fileId;
        if (thumb && !cur.thumb) cur.thumb = thumb;
        await DB.put('photos', cur); newPhotos++;
      }
    }
    c.lastPull = j.now; await saveSettings();
    if (changed || newPhotos) { for (const k of [...S.urls.keys()]) if (!S.urls.get(k)) S.urls.delete(k); renderSurvey(); renderHeritage(); renderHeritagePoints(); }
    CLOUD.lastOk = Date.now();
    setCloudState(failed ? 'error' : 'idle', failed ? `${failed} صورة ما انرفعت — راح يعيد المحاولة` : '');
  } catch (e) {
    setCloudState(navigator.onLine ? 'error' : 'offline', e.name === 'AbortError' ? 'الخادم بطيء' : e.message);
  } finally { CLOUD.busy = false; }
}
// run soon after a local change, and every 2 minutes in the background
function cloudKick(delay = 4000) { if (!cloudOn()) return; clearTimeout(CLOUD.debounce); CLOUD.debounce = setTimeout(cloudSync, delay); }
function cloudStart() {
  clearInterval(CLOUD.timer);
  if (!cloudOn()) return setCloudState('');
  CLOUD.timer = setInterval(cloudSync, 120000);
  cloudKick(1500);
}
addEventListener('online', () => cloudKick(1000));

// a photo that lives only in the cloud (taken by a teammate): fetch through the script and keep it
async function cloudPhotoBlob(p, thumb) {
  if (!p.cloud) return thumb ? null : p.thumb || null;           // original still uploading from its phone
  const j = await cloudCall({ action: 'getPhoto', fileId: p.cloud, size: thumb ? 'thumb' : 'preview' }, 90000);
  const blob = b64ToBlob(j.data, j.mime);
  if (thumb) p.thumb = blob; else { p.blob = blob; if (!p.thumb) p.thumb = blob; }
  await DB.put('photos', p);
  return blob;
}

// ---------------------------------------------------------------- analysis
function analysisHtml() {
  const H = S.heritageGeo.features;
  const total = hpById.size || H.length;
  const visited = hpById.size ? [...hpById.keys()].filter(k => S.heritage.get(k)?.visited).length : H.filter(f => S.heritage.get(f.properties.id)?.visited).length;
  const otherDoc = [...S.heritage.values()].filter(r => !isHeritageId(r.id) && isDocumented(r)).length;
  const hArea = H.reduce((a, f) => a + f.properties.area_m2, 0);
  const court = H.filter(f => f.properties.courtyard).length;
  const pct = total ? Math.round(visited / total * 100) : 0;
  const condCount = Object.fromEntries(CONDITIONS.map(c => [c[0], 0]));
  [...S.heritage.values()].forEach(r => r.condition && condCount[r.condition]++);
  [...S.features.values()].forEach(f => f.properties.condition && f.properties.kind !== 'line' && condCount[f.properties.condition]++);
  const condMax = Math.max(1, ...Object.values(condCount));

  const feats = [...S.features.values()];
  const pts = feats.filter(f => f.properties.kind === 'point'), lines = feats.filter(f => f.properties.kind === 'line'), polys = feats.filter(f => f.properties.kind === 'polygon');
  const byCat = (arr, kind, val) => CATS[kind].map(c => [c, arr.filter(f => f.properties.category === c[0]).reduce((a, f) => a + val(f), 0)]).filter(x => x[1] > 0);
  const lenOf = f => turf.length(f, { units: 'kilometers' }) * 1000;
  const ptCats = byCat(pts, 'point', () => 1), lnCats = byCat(lines, 'line', lenOf), pgCats = byCat(polys, 'polygon', f => turf.area(f));
  const bars = (rows, fmt) => { const mx = Math.max(1, ...rows.map(r => r[1])); return `<div class="bars">${rows.map(([c, v]) => `<div class="bar"><span>${c[1]}</span><span class="t"><i style="width:${v / mx * 100}%;background:${c[2]}"></i></span><span class="v">${fmt(v)}</span></div>`).join('')}</div>`; };

  // site-level ratios
  const siteArea = (() => { let a = 0; L_.site.eachLayer(l => l.eachLayer ? l.eachLayer(x => (a += turf.area(x.toGeoJSON()))) : (a += turf.area(l.toGeoJSON()))); return a; })();
  const totalPhotos = feats.reduce((a, f) => a + (f.properties.photos?.length || 0), 0) + [...S.heritage.values()].reduce((a, r) => a + (r.photos?.length || 0), 0);
  const darbLen = lines.filter(f => ['darb', 'deadend', 'pedestrian', 'market'].includes(f.properties.category)).reduce((a, f) => a + lenOf(f), 0);
  const deadEnds = lines.filter(f => f.properties.category === 'deadend').length;

  // nearest undocumented
  let nearest = '';
  if (S.me) {
    const todo = todoHeritage().sort((a, b) => a.dist - b.dist).slice(0, 3);
    if (todo.length) nearest = `<h3>أقرب مباني حفاظ ما وثقناها</h3>${todo.map(t => `<div class="list-item" data-goh="${t.key}"><div class="thumb" style="background:#8b3a1a33"></div><div class="meta"><b>${t.title}</b><small>${t.sub}</small></div><span class="dist">${fmtLen(t.dist)}</span></div>`).join('')}`;
  }

  return `
    <h3>مباني الحفاظ</h3>
    <div class="kpis">
      <div class="kpi"><b>${total}</b><span>مبنى حفاظ</span></div>
      <div class="kpi"><b>${fmtArea(hArea)}</b><span>بصمة كلية</span></div>
      <div class="kpi"><b>${siteArea ? Math.round(hArea / siteArea * 100) + '%' : '—'}</b><span>من مساحة السايت</span></div>
    </div>
    <div style="margin-top:10px;display:flex;justify-content:space-between;font-size:13px"><span>تقدّم التوثيق</span><b>${visited} / ${total} (${pct}%)</b></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <p class="muted">${court} مبنى بيه حوش وسطي · مساحة السايت ≈ ${fmtArea(siteArea)} · ${S.buildingsGeo.features.length} مبنى آخر بالسايت، وثّقتوا منها ${otherDoc}</p>
    ${nearest}
    ${linksHtml()}
    <h3>الحالة الإنشائية (المقيّمة)</h3>
    ${Object.values(condCount).some(Boolean) ? `<div class="bars">${CONDITIONS.map(c => `<div class="bar"><span>${c[1]}</span><span class="t"><i style="width:${condCount[c[0]] / condMax * 100}%;background:${c[2]}"></i></span><span class="v">${condCount[c[0]]}</span></div>`).join('')}</div>` : '<p class="muted">بعد ما قيّمتوا حالة أي مبنى.</p>'}
    <h3>الرصد الميداني</h3>
    <div class="kpis">
      <div class="kpi"><b>${pts.length}</b><span>نقطة</span></div>
      <div class="kpi"><b>${fmtLen(darbLen)}</b><span>درابين ومسارات</span></div>
      <div class="kpi"><b>${totalPhotos}</b><span>صورة</span></div>
    </div>
    ${ptCats.length ? `<h3>النقاط حسب التصنيف</h3>${bars(ptCats, v => v)}` : ''}
    ${lnCats.length ? `<h3>أطوال المسارات</h3>${bars(lnCats, fmtLen)}${deadEnds ? `<p class="muted">${deadEnds} زقاق مغلق — مؤشر على نسيج عضوي تقليدي.</p>` : ''}` : ''}
    ${pgCats.length ? `<h3>المساحات المرسومة</h3>${bars(pgCats, fmtArea)}` : ''}
    ${!feats.length ? '<p class="muted">ابدوا الرصد من زر «إضافة» وراح تطلع هنا الإحصائيات تلقائياً.</p>' : ''}
  `;
}

// ---------------------------------------------------------------- modes (crosshair, draw, measure)
function setMode(text, actions) {
  $('#modeText').textContent = text;
  const box = $('#modeActions'); box.innerHTML = '';
  for (const [label, fn, primary] of actions) { const b = document.createElement('button'); b.className = 'btn small' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = fn; box.appendChild(b); }
  $('#modeBar').hidden = false;
}
function clearMode() { $('#modeBar').hidden = true; $('#crosshair').hidden = true; $('#btnMeasure').classList.remove('active'); }

function startCrosshair() {
  $('#crosshair').hidden = false;
  setMode('حرّك الخريطة لحد ما الهدف الأحمر يصير على المكان', [
    ['تثبيت', () => { const c = map.getCenter(); clearMode(); editFeature({ type: 'Point', coordinates: [c.lng, c.lat] }, 'point'); }, true],
    ['إلغاء', clearMode],
  ]);
}
function addAtGps() {
  if (!S.me) { toast('ننتظر GPS دقيق (±30 م أو أحسن)…'); startGps(); waitFix(fix => editFeature({ type: 'Point', coordinates: [fix.lng, fix.lat] }, 'point')); return; }
  if (S.me.acc > 30) toast(`دقة الـ GPS ضعيفة (±${Math.round(S.me.acc)} م) — تأكد من المكان`);
  editFeature({ type: 'Point', coordinates: [S.me.lng, S.me.lat] }, 'point');
}
function buildingAt(lat, lng, maxDist = 6) {
  const pt = turf.point([lng, lat]); let best = null, bd = Infinity;
  for (const [id, f0] of S.geoIndex) {
    const f = buildingFeature(id);
    if (turf.booleanPointInPolygon(pt, f)) return id;
    const [bx, by] = featureCenter(f); const d = map.distance([lat, lng], [bx, by]);
    if (d < 40) { const dd = turf.pointToPolygonDistance ? turf.pointToPolygonDistance(pt, f, { units: 'meters' }) : d; if (dd < bd) { bd = dd; best = id; } }
  }
  return bd <= maxDist ? best : null;
}
async function quickPhoto() {
  if (S.me) {
    const id = buildingAt(S.me.lat, S.me.lng);
    if (id && confirm(`انت يم «${buildingTitle(id, S.heritage.get(id))}». تضيف الصورة لهذا المبنى؟`)) { if (await addPhotosTo(id, true)) openBuilding(id); return; }
  }
  const files = await pickPhotos(true); if (!files.length) return;
  const ids = await addPhotos(files);
  const c = S.me ? [S.me.lng, S.me.lat] : [map.getCenter().lng, map.getCenter().lat];
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: c },
    properties: { id: uid('F'), kind: 'point', category: 'view', name: '', photos: ids, created: nowIso(), observer: S.settings.observer, notes: '' } };
  await putFeature(f); renderSurvey(); toast(S.me ? 'انحفظت الصورة بموقعك ✓' : 'انحفظت بمركز الخريطة (الـ GPS مطفي)');
}

let drawHandler = null;
function stopDraw() { map.pm.disableDraw(); if (drawHandler) map.off('pm:create', drawHandler); drawHandler = null; clearMode(); }
function startDraw(shape, onDone) {
  if (measuring) stopMeasure();
  stopDraw();
  const help = shape === 'Line' ? 'دوس على الخريطة نقطة بنقطة على طول الدرب، وآخر نقطة دوس عليها مرتين' : 'دوس على زوايا المبنى، وارجع للنقطة الأولى حتى تسكّر الشكل';
  map.pm.enableDraw(shape, { snappable: true, snapDistance: 15, templineStyle: { color: '#e53935' }, hintlineStyle: { color: '#e53935', dashArray: '5 5' }, pathOptions: { color: '#e53935' } });
  setMode(help, [
    ...(shape === 'Line' ? [['إنهاء', () => map.pm.Draw.Line._finishShape?.(), true]] : []),
    ['تراجع نقطة', () => map.pm.Draw[shape]._removeLastVertex?.()],
    ['إلغاء', stopDraw],
  ]);
  drawHandler = e => {
    const gj = e.layer.toGeoJSON(); map.removeLayer(e.layer); stopDraw();
    if (onDone) return onDone(gj.geometry);
    editFeature(gj.geometry, shape === 'Line' ? 'line' : 'polygon');
  };
  map.on('pm:create', drawHandler);
}

let measuring = false, measureHandler = null;
function stopMeasure() { map.pm.disableDraw(); if (measureHandler) map.off('pm:create', measureHandler); measureHandler = null; measuring = false; clearMode(); }
function startMeasure() {
  if (measuring) return stopMeasure();
  if (drawHandler) stopDraw();
  measuring = true; $('#btnMeasure').classList.add('active');
  L_.measure.clearLayers();
  const run = shape => {
    map.pm.disableDraw(); map.off('pm:create', onCreate); measureHandler = onCreate;
    map.pm.enableDraw(shape, { templineStyle: { color: '#ffd166' }, hintlineStyle: { color: '#ffd166', dashArray: '5 5' }, pathOptions: { color: '#ffd166', weight: 3 } });
    map.on('pm:create', onCreate);
  };
  const onCreate = e => {
    const gj = e.layer.toGeoJSON(); e.layer.remove();
    const l = L.geoJSON(gj, { style: { color: '#ffd166', weight: 3, dashArray: '6 4', fillOpacity: .15 } }).addTo(L_.measure);
    l.bindTooltip(measureText(gj), { permanent: true, className: 'lbl', direction: 'center' }).openTooltip();
    stopMeasure(); toast(measureText(gj).replace(/<[^>]+>/g, ''), 6000);
  };
  setMode('قياس: دوس نقاط على الخريطة', [
    ['مسافة', () => run('Line'), true], ['مساحة', () => run('Polygon')],
    ['مسح القياسات', () => L_.measure.clearLayers()],
    ['إغلاق', stopMeasure],
  ]);
  run('Line');
}
$('#btnMeasure').onclick = startMeasure;

// ---------------------------------------------------------------- GPS
// Only fixes within GPS_MAX_ACC metres are used: coarse Wi-Fi / cell-tower fixes (often 100 m+) never move the
// dot, never tag a photo and never reach the team. Good fixes go through a small Kalman filter (walking speed),
// and a sudden jump that no accuracy circle explains (multipath in narrow alleys) is held back until the next
// fixes confirm it.
const GPS_MAX_ACC = 30, GPS_Q = 4;          // metres; m/s of expected movement
let watchId = null, follow = false, meMarker = null, accCircle = null, fixWaiters = [], wakeLock = null, compassOn = false;
const KF = { lat: 0, lng: 0, v: -1, t: 0, sus: [], lastRaw: 0, weak: 0 };
function waitFix(fn) { fixWaiters.push(fn); }
function watchGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onFix, onGpsErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
function startGps() {
  if (!('geolocation' in navigator)) return toast('الجهاز ما يدعم تحديد الموقع');
  if (watchId != null) return;
  KF.lastRaw = Date.now();
  watchGps();
  if (!S.settings.gpsOn) { S.settings.gpsOn = true; saveSettings(); }      // comes back on after an update / reload
  $('#btnGps').classList.add('on');
  gpsChip();
  if (!compassOn) { compassOn = true; startCompass(); }
}
function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; follow = false; L_.me.clearLayers(); meMarker = accCircle = null; S.me = null;
  Object.assign(KF, { v: -1, sus: [], weak: 0 });
  if (S.settings.gpsOn) { S.settings.gpsOn = false; saveSettings(); }
  $('#btnGps').classList.remove('on', 'follow'); $('#gpsChip').hidden = true;
}
function onGpsErr(err) {
  if (err.code === 1) { toast('لازم تسمح للموقع بالوصول للـ GPS من إعدادات المتصفح', 5000); stopGps(); return; }
  gpsChip();                                  // timeout / no signal: keep watching, the watchdog restarts it
}
// some phones silently stop a watch after the app was in the background — restart it when it goes quiet
setInterval(() => { if (watchId != null && !document.hidden && Date.now() - KF.lastRaw > 25000) { KF.lastRaw = Date.now(); watchGps(); } gpsChip(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && watchId != null) { KF.lastRaw = Date.now(); watchGps(); } });

function onFix(pos) {
  const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
  const t = pos.timestamp || Date.now();
  KF.lastRaw = Date.now();
  if (!(acc <= GPS_MAX_ACC)) { KF.weak = Math.round(acc); gpsChip(); return; }     // too coarse: keep the last good position
  KF.weak = 0;
  if (KF.v < 0 || t - KF.t > 120000) Object.assign(KF, { lat, lng, v: acc * acc, t, sus: [] });
  else {
    const dt = Math.max(0, (t - KF.t) / 1000), d = map.distance([KF.lat, KF.lng], [lat, lng]);
    if (d > Math.sqrt(KF.v) + acc + 10 && d / Math.max(dt, 1) > 7) {
      // farther than both circles allow and faster than running: believe it only when 3 fixes agree
      KF.sus.push({ lat, lng, acc });
      const last = KF.sus.slice(-3);
      if (last.length < 3 || !last.every(q => map.distance([q.lat, q.lng], [lat, lng]) <= q.acc + acc)) { if (KF.sus.length > 6) KF.sus.shift(); gpsChip(); return; }
      Object.assign(KF, { lat, lng, v: acc * acc, t, sus: [] });
    } else {
      KF.sus = [];
      KF.v += dt * GPS_Q * GPS_Q;
      const k = KF.v / (KF.v + acc * acc);
      KF.lat += k * (lat - KF.lat); KF.lng += k * (lng - KF.lng); KF.v *= 1 - k; KF.t = t;
    }
  }
  placeMe(KF.lat, KF.lng, acc, t);
}
function placeMe(lat, lng, acc, t) {
  const first = !S.me;
  S.me = { ...(S.me || {}), lat, lng, acc, t };
  if (!meMarker) {
    meMarker = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: '<div class="me"><span class="hd"></span></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000, interactive: false }).addTo(L_.me);
    accCircle = L.circle([lat, lng], { radius: acc, color: '#1a73e8', weight: 1, fillOpacity: .08, interactive: false }).addTo(L_.me);
  } else { meMarker.setLatLng([lat, lng]); accCircle.setLatLng([lat, lng]).setRadius(acc); }
  updateHeading(); gpsChip();
  if (first) { follow = true; $('#btnGps').classList.add('follow'); map.flyTo([lat, lng], Math.max(map.getZoom(), 18)); }
  else if (follow) map.panTo([lat, lng], { animate: true });
  if (track) trackFix(lat, lng, acc);
  if (teamSettings().sharing) teamPublish();
  const w = fixWaiters; fixWaiters = []; w.forEach(fn => fn(S.me));
}
// the chip says plainly what the dot is: a fresh precise fix, an older precise one, or still waiting
function gpsChip() {
  const chip = $('#gpsChip'); if (!chip) return;
  if (watchId == null) { chip.hidden = true; return; }
  chip.hidden = false;
  const age = S.me ? (Date.now() - S.me.t) / 1000 : Infinity, old = age > 20;
  meMarker?.getElement()?.querySelector('.me')?.classList.toggle('old', old);
  chip.classList.toggle('warn', !S.me || old);
  chip.textContent = !S.me
    ? (KF.weak ? `ننتظر GPS دقيق… الإشارة هسه ±${KF.weak} م` : 'ننتظر إشارة الـ GPS…')
    : old ? `آخر موقع دقيق قبل ${age < 90 ? Math.round(age) + ' ث' : Math.round(age / 60) + ' د'}${KF.weak ? ` · الإشارة هسه ±${KF.weak} م` : ''}`
    : `دقة ±${Math.round(S.me.acc)} م`;
}
$('#gpsChip').onclick = () => openSheet('دقة الموقع', `
  <p style="margin-top:0">التطبيق ما يستخدم أي موقع دقته أسوأ من <b>±${GPS_MAX_ACC} م</b> — لا للنقطة الزرقاء، لا للصور، ولا للفريق.</p>
  <p class="muted">إذا بقى «ننتظر GPS دقيق»، فالتلفون ديعطي موقع تقريبي من أبراج الاتصال بدل الـ GPS:</p>
  <ul class="muted">
    <li><b>آيفون:</b> الإعدادات › الخصوصية › خدمات الموقع › Safari (أو Chrome) › شغّل «الموقع الدقيق» واختار «أثناء الاستخدام».</li>
    <li><b>أندرويد:</b> الإعدادات › الموقع › شغّل «دقة الموقع من Google»، وبإعدادات الموقع للمتصفح خلّيه «دقيق» مو «تقريبي».</li>
    <li>اطلع لمكان مفتوح دقيقة وحدة حتى يلكف الأقمار — بالأزقة الضيكة والسقوف الإشارة تضعف.</li>
  </ul>`);
// tap: turn on / re-centre and follow. Long-press: turn off (so a tap never switches it off by accident)
{
  const b = $('#btnGps'); let pressT = null, long = false;
  b.title = 'موقعي — ضغطة مطوّلة تطفيه';
  b.addEventListener('pointerdown', () => { long = false; clearTimeout(pressT); pressT = setTimeout(() => { if (watchId != null) { long = true; stopGps(); toast('انطفى الـ GPS'); } }, 700); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(e => b.addEventListener(e, () => clearTimeout(pressT)));
  b.addEventListener('contextmenu', e => e.preventDefault());
  b.onclick = () => {
    if (long) { long = false; return; }
    if (watchId == null) return startGps();
    follow = true; b.classList.add('follow');
    if (S.me) map.flyTo([S.me.lat, S.me.lng], Math.max(map.getZoom(), 18)); else toast('ننتظر GPS دقيق…');
  };
}
map.on('dragstart', () => { if (follow) { follow = false; $('#btnGps').classList.remove('follow'); } });

function startCompass() {
  const handler = e => {
    let h = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
    if (h == null) return;
    if (S.me) { S.me.heading = h; updateHeading(); }
  };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(r => r === 'granted' && addEventListener('deviceorientation', handler)).catch(() => {});
  } else if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', handler);
  else addEventListener('deviceorientation', handler);
}
function updateHeading() {
  const hd = meMarker?.getElement()?.querySelector('.hd'); if (!hd) return;
  if (S.me?.heading == null) { hd.style.display = 'none'; return; }
  hd.style.display = ''; hd.style.transform = `rotate(${S.me.heading}deg)`;
}

// ---------------------------------------------------------------- GPS track recording
let track = null;
async function startTrack() {
  startGps();
  track = { pts: [], line: L.polyline([], { color: '#1a73e8', weight: 5, opacity: .9 }).addTo(L_.me), len: 0 };
  $('#trackBar').hidden = false; $('#trackInfo').textContent = 'ننتظر الـ GPS…';
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  if (S.me) trackFix(S.me.lat, S.me.lng, S.me.acc);
}
function trackFix(lat, lng, acc) {
  if (acc > GPS_MAX_ACC) { $('#trackInfo').textContent = `الإشارة ضعيفة ±${Math.round(acc)} م…`; return; }
  const last = track.pts[track.pts.length - 1];
  if (last) { const d = map.distance(last, [lat, lng]); if (d < Math.max(3, acc / 3)) return; track.len += d; }
  track.pts.push([lat, lng]); track.line.addLatLng([lat, lng]);
  $('#trackInfo').textContent = `تسجيل · ${fmtLen(track.len)} · ${track.pts.length} نقطة`;
}
$('#trackStop').onclick = () => {
  const t = track; track = null; $('#trackBar').hidden = true;
  try { wakeLock?.release(); } catch {} wakeLock = null;
  L_.me.removeLayer(t.line);
  if (t.pts.length < 2) return toast('المسار قصير جداً، ما انحفظ');
  const geometry = { type: 'LineString', coordinates: t.pts.map(([a, b]) => [b, a]), _track: true };
  editFeature(geometry, 'line');
};

// ---------------------------------------------------------------- calibration UI
function openCalibration() {
  const before = { ...S.calib };
  const was = { heritage: S.settings.layers.heritage, plan: S.settings.layers.plan };
  S.settings.layers.heritage = true; applyLayerVisibility();
  map.flyTo(ANCHOR, 18);
  const slider = (k, label, min, max, step, unit) => `<label class="f"><span>${label}: <b id="v-${k}">${S.calib[k]}</b> ${unit}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${S.calib[k]}"></label>`;
  openSheet('معايرة مباني الحفاظ', `
    <p class="muted" style="margin-top:0">قارن حواف المباني الجوزية مع الصورة الجوية، أو اوقف يم مبنى معروف وشغّل الـ GPS. التحريك بالأمتار.</p>
    ${slider('dx', 'شرق ↔ غرب', -60, 60, .5, 'م')}
    ${slider('dy', 'شمال ↕ جنوب', -60, 60, .5, 'م')}
    ${slider('rot', 'تدوير', -8, 8, .1, '°')}
    ${slider('scale', 'مقياس', .9, 1.1, .002, '×')}
    <div class="row"><button class="btn" id="cPlan">إظهار/إخفاء المخطط الأصلي</button></div>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="cSave">حفظ</button><button class="btn" id="cReset">رجوع للافتراضي</button><button class="btn" id="cCancel">إلغاء</button></div>`,
  body => {
    let raf;
    body.addEventListener('input', e => {
      const k = e.target.dataset.k; if (!k) return;
      S.calib[k] = +e.target.value; $('#v-' + k, body).textContent = S.calib[k];
      cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { renderHeritage(); renderStreets(); renderPlan(); });
    });
    $('#cPlan', body).onclick = () => { S.settings.layers.plan = !S.settings.layers.plan; renderPlan(); applyLayerVisibility(); };
    $('#cSave', body).onclick = async () => { await saveCalib(); saveSettings(); closeSheet(); toast('انحفظت المعايرة'); };
    $('#cReset', body).onclick = () => {
      S.calib = { dx: 0, dy: 0, rot: 0, scale: 1 };
      $$('input[data-k]', body).forEach(i => { i.value = S.calib[i.dataset.k]; $('#v-' + i.dataset.k, body).textContent = S.calib[i.dataset.k]; });
      renderHeritage(); renderPlan();
    };
    $('#cCancel', body).onclick = () => { S.calib = before; S.settings.layers.plan = was.plan; renderHeritage(); renderPlan(); applyLayerVisibility(); closeSheet(); };
  });
}

// ---------------------------------------------------------------- export / import
async function buildExport() {
  const feats = [...S.features.values()].map(f => ({ ...f, geometry: { ...f.geometry } }));
  const heritageRecs = [...S.heritage.values()];
  const heritageFC = { type: 'FeatureCollection', features: heritageRecs.filter(r => buildingFeature(r.id)).map(r => ({ ...buildingFeature(r.id), properties: { ...buildingFeature(r.id).properties, ...r, hid: r.id } })) };
  return { feats, heritageRecs, heritageFC };
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const who = () => (S.settings.observer || 'survey').replace(/[^\p{L}\p{N}_-]+/gu, '_');

let zipLib;
function needZip() {
  return zipLib || (zipLib = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    sc.onload = () => res(window.JSZip); sc.onerror = () => { zipLib = null; rej(new Error('jszip')); };
    document.head.appendChild(sc);
  }));
}
async function exportZip(share) {
  if (!S.features.size && !S.heritage.size) return toast('ماكو بيانات حتى نصدّرها');
  toast('جاري تجهيز الملف…', 8000);
  await needZip();
  const { feats, heritageRecs, heritageFC } = await buildExport();
  const zip = new JSZip();
  zip.file('survey.geojson', JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 1));
  zip.file('heritage_records.json', JSON.stringify(heritageRecs, null, 1));
  zip.file('heritage_documented.geojson', JSON.stringify(heritageFC));
  zip.file('calibration.json', JSON.stringify(S.calib));
  zip.file('survey.csv', '﻿' + csvText());
  const ids = new Set([...feats.flatMap(f => f.properties.photos || []), ...heritageRecs.flatMap(r => r.photos || [])]);
  for (const id of ids) { const p = await DB.get('photos', id); if (p?.blob) zip.file(`photos/${id}.${photoExt(p.blob.type)}`, p.blob); }
  zip.file('photos_meta.json', JSON.stringify(await Promise.all([...ids].map(async id => { const p = await DB.get('photos', id); return p && { id, created: p.created, lat: p.lat, lng: p.lng, observer: p.observer }; }))));
  const blob = await zip.generateAsync({ type: 'blob' }, m => toast(`تجهيز الملف ${Math.round(m.percent)}% (${ids.size} صورة)`, 60000));
  const name = `site-survey_${who()}_${stamp()}.zip`;
  if (share && navigator.canShare) {
    const file = new File([blob], name, { type: 'application/zip' });
    if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'رصد السايت' }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  }
  download(blob, name); toast('انحفظ الملف ✓');
}
async function exportGeoJSON() {
  const { feats, heritageFC } = await buildExport();
  const all = { type: 'FeatureCollection', features: [...feats.map(f => ({ ...f, properties: { ...f.properties, photos: (f.properties.photos || []).join(';') } })), ...heritageFC.features.map(f => ({ ...f, properties: { ...f.properties, kind: isHeritageId(f.properties.hid) ? 'heritage' : 'building', photos: (f.properties.photos || []).join(';') } }))] };
  download(new Blob([JSON.stringify(all)], { type: 'application/geo+json' }), `site-survey_${stamp()}.geojson`);
}
function csvText() {
  const cols = ['id', 'kind', 'category', 'name', 'condition', 'floors', 'era', 'use', 'use_orig', 'materials', 'elements', 'width', 'surface', 'activity', 'notes', 'lat', 'lng', 'length_m', 'area_m2', 'photos', 'observer', 'created'];
  const q = v => { v = Array.isArray(v) ? v.join('، ') : (v ?? ''); v = String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const rows = [cols.join(',')];
  for (const f of S.features.values()) {
    const p = f.properties, c = featureCenter(f);
    const o = { ...p, category: catOf(p.kind, p.category)[1], condition: condOf(p.condition)?.[1] || '', lat: c[0].toFixed(6), lng: c[1].toFixed(6),
      length_m: p.kind === 'line' ? Math.round(turf.length(f) * 1000) : '', area_m2: p.kind === 'polygon' ? Math.round(turf.area(f)) : '', photos: (p.photos || []).length };
    rows.push(cols.map(k => q(o[k])).join(','));
  }
  for (const r of S.heritage.values()) {
    const hf = buildingFeature(r.id); if (!hf) continue; const c = featureCenter(hf);
    const o = { ...r, kind: isHeritageId(r.id) ? 'heritage' : 'building', category: isHeritageId(r.id) ? 'مبنى حفاظ' : 'مبنى', condition: condOf(r.condition)?.[1] || '', lat: c[0].toFixed(6), lng: c[1].toFixed(6), area_m2: hf.properties.area_m2, photos: (r.photos || []).length, observer: r.visitedBy, created: r.visitedAt };
    rows.push(cols.map(k => q(o[k])).join(','));
  }
  return rows.join('\n');
}
function exportCSV() { download(new Blob(['﻿' + csvText()], { type: 'text/csv' }), `site-survey_${stamp()}.csv`); }

function importFile() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip,.geojson,.json,application/zip,application/json'; inp.multiple = true;
  inp.onchange = async () => {
    let nF = 0, nH = 0, nP = 0;
    if ([...inp.files].some(f => /\.zip$/i.test(f.name))) await needZip().catch(() => toast('تعذّر تحميل أداة ZIP — تأكد من النت'));
    for (const file of inp.files) {
      try {
        if (/\.zip$/i.test(file.name)) {
          const zip = await JSZip.loadAsync(file);
          const meta = zip.file('photos_meta.json') ? JSON.parse(await zip.file('photos_meta.json').async('string')) : [];
          for (const entry of Object.values(zip.files)) {
            const m = entry.name.match(/^photos\/(.+)\.(jpg|webp)$/); if (!m) continue;
            if (await DB.get('photos', m[1])) continue;
            const blob = await entry.async('blob');
            const thumb = await compressImage(new File([blob], 'x.' + m[2], { type: m[2] === 'webp' ? 'image/webp' : 'image/jpeg' }), 320, .62);
            const pm = meta.find(x => x && x.id === m[1]) || {};
            await DB.put('photos', { id: m[1], blob: new Blob([blob], { type: m[2] === 'webp' ? 'image/webp' : 'image/jpeg' }), thumb, created: pm.created, lat: pm.lat, lng: pm.lng, observer: pm.observer }); nP++;
          }
          if (zip.file('survey.geojson')) nF += await mergeFeatures(JSON.parse(await zip.file('survey.geojson').async('string')).features);
          if (zip.file('heritage_records.json')) nH += await mergeHeritage(JSON.parse(await zip.file('heritage_records.json').async('string')));
        } else {
          const gj = JSON.parse(await file.text());
          nF += await mergeFeatures((gj.features || []).filter(f => !['heritage', 'building'].includes(f.properties?.kind)).map(f => {
            const p = { ...f.properties }; if (typeof p.photos === 'string') p.photos = p.photos ? p.photos.split(';') : [];
            if (!p.id) p.id = uid('F'); if (!p.kind) p.kind = f.geometry.type === 'Point' ? 'point' : /Line/.test(f.geometry.type) ? 'line' : 'polygon';
            if (!p.category) p.category = 'other'; return { ...f, properties: p };
          }));
        }
      } catch (e) { console.error(e); toast('ملف غير صالح: ' + file.name); }
    }
    renderSurvey(); renderHeritage();
    toast(`اندمج: ${nF} عنصر، ${nH} مبنى حفاظ، ${nP} صورة`, 4500);
  };
  inp.click();
}
async function mergeFeatures(list) {
  let n = 0;
  for (const f of list) {
    const id = f.properties?.id; if (!id || !f.geometry) continue;
    const cur = S.features.get(id);
    if (cur && (cur.properties.updated || '') >= (f.properties.updated || '')) continue;
    S.features.set(id, f); await DB.put('features', { id, feature: f }); n++;
  }
  return n;
}
async function mergeHeritage(list) {
  let n = 0;
  for (const r of list) {
    const cur = S.heritage.get(r.id);
    if (cur && (cur.updated || '') >= (r.updated || '')) {
      // still union photos so nobody's pictures get lost
      const extra = (r.photos || []).filter(p => !(cur.photos || []).includes(p));
      if (extra.length) { cur.photos = [...(cur.photos || []), ...extra]; await DB.put('heritage', cur); n++; }
      continue;
    }
    if (cur) r.photos = [...new Set([...(cur.photos || []), ...(r.photos || [])])];
    S.heritage.set(r.id, r); await DB.put('heritage', r); n++;
  }
  return n;
}

// photos live in this browser's IndexedDB (no server / database needed); show how much room is used
async function storageInfo(el) {
  const n = await DB._tx('photos', 'readonly', st => st.count());
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const mb = v => (v / 1048576).toFixed(v > 1048576 * 100 ? 0 : 1) + ' MB';
  el.innerHTML = `${n} صورة محفوظة${est ? ` · مستخدم ${mb(est.usage)} من ${mb(est.quota)} متاحة` : ''}<br>${persisted ? '✓ التخزين ثابت — المتصفح ما يمسح الصور تلقائياً' : '⚠ التخزين مو ثابت بعد — صدّروا نسخة ZIP بنهاية كل يوم'}<br>الصور تنحفظ على التلفون نفسه (بدون أي قاعدة بيانات أو اشتراك) وتنتقل للفريق بملف ZIP.`;
}
async function wipeAll() {
  if (!confirm('راح ينمسح كل الرصد والصور من هذا الجهاز نهائياً. صدّرت نسخة قبل؟')) return;
  if (prompt('اكتب «امسح» للتأكيد') !== 'امسح') return;
  await Promise.all(['features', 'photos', 'heritage'].map(s => DB.clear(s)));
  S.features.clear(); S.heritage.clear(); renderSurvey(); renderHeritage(); closeSheet(); toast('انمسحت البيانات');
}

// ---------------------------------------------------------------- offline tiles
async function downloadOffline(btn) {
  if (!('caches' in window) || !navigator.serviceWorker?.controller) return toast('التحميل للعمل بدون نت يحتاج تفتح الموقع من الرابط الرسمي (https) — أعد تحميل الصفحة وجرب مرة ثانية');
  const b = L.latLngBounds([33.3345, 44.3855], [33.3435, 44.4015]);
  const urls = [];
  const tile = (lat, lng, z) => { const n = 2 ** z, x = Math.floor((lng + 180) / 360 * n), r = lat * Math.PI / 180, y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); return [x, y]; };
  for (let z = 14; z <= 19; z++) {
    const [x0, y0] = tile(b.getNorth(), b.getWest(), z), [x1, y1] = tile(b.getSouth(), b.getEast(), z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.push(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`);
  }
  btn.disabled = true;
  const cache = await caches.open('tiles-v1');
  let done = 0;
  const queue = [...urls];
  const worker = async () => { while (queue.length) { const u = queue.shift(); try { if (!(await cache.match(u))) { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await cache.put(u, r); } } catch {} btn.textContent = `جاري التنزيل… ${++done}/${urls.length}`; } };
  await Promise.all(Array.from({ length: 6 }, worker));
  btn.textContent = 'تنزّلت خريطة السايت ✓'; btn.disabled = false;
}

// ---------------------------------------------------------------- search (local + Baghdad geocoder)
let searchTimer;
$('#searchInput').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(e.target.value.trim()), 350); });
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); doSearch($('#searchInput').value.trim(), true); });
document.addEventListener('click', e => { if (!e.target.closest('.search')) $('#searchResults').hidden = true; });
async function doSearch(q, remote) {
  const box = $('#searchResults');
  if (q.length < 2) { box.hidden = true; return; }
  const local = [
    ...listItems().filter(it => (it.title + ' ' + it.search).includes(q)).map(it => ({ key: it.key, label: it.title, sub: isHP(it.key) ? 'توثيق الميدان' : 'من رصدنا', go: () => { if (S.geoIndex.has(it.key) || isHP(it.key)) { flyToBuilding(it.key); openRecord(it.key); } else { flyToFeature(it.key); openFeature(it.key); } } })),
  ];
  L_.landmarks.eachLayer(g => (g.eachLayer ? g.eachLayer(l => {
    const f = l.feature; if (f && (f.properties.name.includes(q) || (f.properties.name_en || '').toLowerCase().includes(q.toLowerCase())))
      local.push({ label: f.properties.name, sub: 'معلم', go: () => { map.flyTo(l.getLatLng(), 19); openLandmark(f); } });
  }) : null));
  for (const [id, f] of S.geoIndex || []) {
    const n = f.properties.name;
    if (!n || !n.includes(q)) continue;
    // in field mode a heritage cell is found through its approximate point
    const hid = S.settings.mode !== 'analysis' && hpOfMember.get(id);
    if (hid) { if (!local.some(x => x.key === hid)) local.unshift({ key: hid, label: n, sub: `مبنى حفاظ — موقع تقريبي ${hid}`, go: () => { flyToBuilding(hid); openHeritagePoint(hid); } }); continue; }
    if (!local.some(x => x.key === id)) local.unshift({ key: id, label: n, sub: isHeritageId(id) ? `مبنى حفاظ ${id}` : `مبنى ${id}`,
      go: () => { if (S.settings.mode !== 'analysis') setAppMode('analysis'); flyToBuilding(id); openBuilding(id); } });
  }
  for (const pl of S.places || []) {
    if (pl.name.includes(q) && !local.some(x => x.label === pl.name)) local.push({ label: pl.name, sub: 'مكان للربط', go: () => { map.flyTo([pl.lat, pl.lon], 18); openPlace(pl.name); } });
  }
  const hm = q.match(/^([hb])?\s*(\d{1,4})$/i);
  if (hm) {
    const pre = (hm[1] || 'h').toUpperCase(), id = pre + hm[2].padStart(pre === 'H' ? 3 : 4, '0');
    if (S.geoIndex.has(id)) local.unshift({ label: buildingTitle(id, S.heritage.get(id)), sub: pre === 'H' ? 'مباني الحفاظ' : 'المباني', go: () => { flyToBuilding(id); openBuilding(id); } });
  }
  const render = (remoteRes = []) => {
    const all = [...local.slice(0, 8), ...remoteRes];
    box.innerHTML = all.length ? all.map((r, i) => `<button type="button" data-i="${i}">${esc(r.label)}<small>${esc(r.sub)}</small></button>`).join('') : '<button type="button" disabled>ماكو نتائج</button>';
    box.hidden = false;
    box.onclick = e => { const i = e.target.closest('[data-i]')?.dataset.i; if (i == null) return; all[i].go(); box.hidden = true; $('#searchInput').blur(); };
  };
  render();
  if (remote || q.length >= 3) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=ar&bounded=1&viewbox=${BAGHDAD_VIEWBOX}&q=${encodeURIComponent(q)}`).then(r => r.json());
      if ($('#searchInput').value.trim() !== q) return;
      render(r.map(x => ({ label: x.display_name.split(',')[0], sub: x.display_name.split(',').slice(1, 3).join('،'), go: () => map.flyTo([+x.lat, +x.lon], 18) })));
    } catch {}
  }
}

// long-press / right-click on map → add point there
map.on('contextmenu', e => editFeature({ type: 'Point', coordinates: [e.latlng.lng, e.latlng.lat] }, 'point'));
map.on('click', () => { if (S.selected && !$('#sheet').hidden) closeSheet(); });
$('#btnSite').onclick = () => map.flyTo(SITE_CENTER, SITE_ZOOM);

// ---------------------------------------------------------------- boot
(async () => {
  try { await DB.open(); await loadUserData(); } catch (e) { console.error(e); toast('التخزين المحلي مقفول — سدّ كل تبويبات الموقع وافتحه من جديد', 6000); }
  applyTheme();
  setBasemap(S.settings.basemap in BASEMAPS ? S.settings.basemap : 'sat');
  try { await loadStatic(); } catch (e) { console.error(e); toast('تعذّر تحميل طبقات السايت'); }
  renderHeritage(); renderStreets(); renderPlaces(); renderAxes(); renderHeritagePoints(); renderPlan(); renderSurvey();
  document.body.dataset.mode = S.settings.mode;
  L_.team.addTo(map);
  if (teamSettings().code) teamConnect();
  if (teamSettings().sharing || S.settings.gpsOn) startGps();
  if (!S.settings.welcomed) setTimeout(openWelcome, 900);
  teamFromLink();
  await cloudFromLink();
  cloudStart();
  $$('.modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.settings.mode));
  applyLayerVisibility();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !window.__reloading) { window.__reloading = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
  }
  if (!S.settings.observer) setTimeout(() => toast('من «المزيد» اكتب اسمك حتى يبين على رصدك', 4000), 1200);
})();
})();
