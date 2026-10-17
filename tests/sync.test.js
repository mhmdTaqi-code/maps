// Cloud sync tests: the real app.js runs in a Node vm with stubbed browser APIs, an in-memory IndexedDB and a fake
// Apps Script (same merge rules as cloud/Code.gs). No network. Run: node --test tests/sync.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// ---- a do-nothing stand-in for Leaflet / the DOM: every property and call gives another stub
function stub() {
  const own = new Map();
  return new Proxy(function () {}, {
    get(t, k) {
      if (own.has(k)) return own.get(k);
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      const s = stub(); own.set(k, s); return s;
    },
    set(t, k, v) { own.set(k, v); return true; },
    apply: () => stub(),
    construct: () => stub(),
  });
}

// IndexedDB keeps copies, not live objects
const clone = v => v instanceof Blob || v === null || typeof v !== 'object' ? v
  : Array.isArray(v) ? v.map(clone) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));

// ---- fake team cloud: the parts of cloud/Code.gs the app's sync uses
const BUSY = Symbol('Apps Script overloaded: HTML error page instead of JSON');
function fakeCloud() {
  const t0 = Date.parse('2026-10-14T08:00:00Z');
  let n = 0;
  const now = () => new Date(t0 + (++n) * 1000).toISOString();
  const s = { records: new Map(), photos: new Map(), calls: [], fail: {}, busy: {}, onCall: null, now };
  const deleted = () => new Set([...s.photos.values()].filter(p => p.deleted).map(p => p.id));
  const mergePhotoLists = (into, from) => {
    const a = into && (into.properties || into), b = from && (from.properties || from);
    if (!a || !b || !b.photos || !b.photos.length) return false;
    const gone = [...(a.removedPhotos || []), ...(b.removedPhotos || [])], have = a.photos || [];
    const add = b.photos.filter(x => !have.includes(x) && !gone.includes(x));
    if (!add.length) return false;
    a.photos = have.concat(add); return true;
  };
  const clean = (data, old) => {
    const a = data && (data.properties || data), o = old && (old.properties || old);
    if (!a) return;
    const rm = [...new Set([...(a.removedPhotos || []), ...((o && o.removedPhotos) || [])])], del = deleted();
    if (rm.length) a.removedPhotos = rm;
    if (a.photos) a.photos = a.photos.filter(x => !rm.includes(x) && !del.has(x));
  };
  s.handle = async req => {
    s.calls.push(req);
    if (s.onCall) await s.onCall(req);
    if (s.fail[req.action]?.(req)) return { ok: false, error: 'injected failure' };
    if (s.lockTimeout?.[req.action]?.(req)) return { ok: false, busy: true, error: 'مهلة التأمين: كانت هناك عملية أخرى تؤجل التأمين لفترة طويلة جدًا.' };
    if (s.busy[req.action]?.(req)) return BUSY;
    switch (req.action) {
      case 'epoch': return { ok: true, epoch: '' };
      case 'putThumb': {
        const row = s.photos.get(req.id);
        if (row?.deleted) return { ok: true, deleted: true };
        s.photos.set(req.id, { ...(row || { id: req.id, fileId: '' }), thumb: req.thumb, synced: now() });
        return { ok: true };
      }
      case 'putPhoto': {
        const row = s.photos.get(req.id);
        if (row?.deleted) return { ok: true, deleted: true };
        if (row?.fileId) return { ok: true, fileId: row.fileId, existed: true };
        const fileId = 'file-' + req.id;
        s.photos.set(req.id, { ...(row || { id: req.id }), fileId, bytes: req.data.length, thumb: row?.thumb || req.thumb || '', synced: now() });
        return { ok: true, fileId };
      }
      case 'delPhotos': {
        const t = now(); let k = 0;
        for (const id of (req.ids || []).slice(0, 200)) {
          const row = s.photos.get(id);
          if (row?.deleted) continue;
          s.photos.set(id, { id, fileId: row?.fileId || '', thumb: '', synced: t, deleted: t }); k++;
        }
        return { ok: true, deleted: k };
      }
      case 'putRecords': {
        const t = now();
        for (const r of (req.records || []).slice(0, 100)) {
          const old = s.records.get(r.id), photos = r.store === 'features' || r.store === 'heritage';
          if (old) {
            const oldData = photos ? clone(old.data) : null;
            if (String(old.updated) >= String(r.updated || '')) {
              if (!oldData || !mergePhotoLists(oldData, r.data)) continue;
              clean(oldData, r.data);
              s.records.set(r.id, { ...old, synced: t, data: oldData });
            } else {
              if (oldData) mergePhotoLists(r.data, oldData);
              if (photos) clean(r.data, oldData);
              s.records.set(r.id, { id: r.id, store: r.store, updated: r.updated || '', synced: t, data: r.data });
            }
          } else {
            if (photos) clean(r.data, null);
            s.records.set(r.id, { id: r.id, store: r.store, updated: r.updated || '', synced: t, data: r.data });
          }
        }
        return { ok: true, now: t };
      }
      case 'pull': {
        const t = now(), since = String(req.since || '');
        const records = [...s.records.values()].filter(r => r.synced > since).map(r => ({ id: r.id, store: r.store, updated: r.updated, data: clone(r.data) }));
        const photos = [...s.photos.values()].filter(p => p.synced > since)
          .map(p => p.deleted ? { id: p.id, deleted: true } : { id: p.id, fileId: p.fileId || '', owner: '', created: '', observer: '', thumb: since ? p.thumb || '' : '' });
        return { ok: true, records, photos, now: t, thumbs: !!since };
      }
      case 'thumbs': {
        const thumbs = {};
        for (const id of (req.ids || []).slice(0, 60)) { const p = s.photos.get(id); if (p && !p.deleted && p.thumb) thumbs[id] = p.thumb; }
        return { ok: true, thumbs };
      }
      default: return { ok: false, error: 'unknown action ' + req.action };
    }
  };
  s.actions = () => s.calls.map(c => c.action);
  return s;
}

// ---- one app instance: its own vm, in-memory database and fake cloud
async function loadApp({ seed = {}, cloud = fakeCloud() } = {}) {
  const stores = Object.fromEntries(['features', 'photos', 'heritage', 'meta'].map(k => [k, new Map()]));
  for (const [store, list] of Object.entries(seed)) for (const v of list) stores[store].set(v.id, clone(v));
  const timers = [];
  let app = null, inputEl = null;
  const fakeTimer = interval => (fn, ms) => { timers.push({ fn, ms, interval }); return timers.length; };
  class FileReader {
    readAsDataURL(b) {
      b.arrayBuffer().then(ab => { this.result = `data:${b.type || 'application/octet-stream'};base64,` + Buffer.from(ab).toString('base64'); this.onload(); }, e => this.onerror(e));
    }
  }
  const document = stub();
  document.createElement = tag => tag === 'input' ? (inputEl = { click() {} }) : stub();
  const empty = { type: 'FeatureCollection', features: [] };
  const fetch = async (url, opts = {}) => {
    if (/^data\/plan_corners/.test(url)) return { ok: true, json: async () => ({ tl: [33.34, 44.38], tr: [33.34, 44.40], bl: [33.33, 44.38] }) };
    if (/^data\//.test(url)) return { ok: true, json: async () => empty };
    if (!/^https:\/\/script\.google\.com\//.test(url)) throw new Error('unexpected fetch ' + url);
    const text = typeof opts.body === 'string' ? opts.body : await opts.body.text();
    const res = await cloud.handle(JSON.parse(text));
    if (res === BUSY) return { ok: true, json: async () => { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); } };
    return { ok: true, json: async () => JSON.parse(JSON.stringify(res)) };
  };
  const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = {
    console, document, L: stub(), turf: stub(), JSZip: undefined, fetch, FileReader, Blob, File, AbortController, TextEncoder, TextDecoder, URL, crypto,
    atob, btoa, structuredClone, queueMicrotask,
    navigator: { onLine: true, userAgent: 'node-test', storage: { estimate: async () => ({ quota: 1e11, usage: 0 }), persist: async () => true, persisted: async () => true } },
    location: { hash: '', pathname: '/maps/', search: '', origin: 'https://example.test', protocol: 'https:', hostname: 'example.test' },
    history: { replaceState() {} }, localStorage: mem(), sessionStorage: mem(),
    setTimeout: fakeTimer(false), setInterval: fakeTimer(true), clearTimeout() {}, clearInterval() {},
    requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, confirm: () => true, prompt: () => '', alert() {},
    __ssmTest: x => {
      app = x;
      // in-memory IndexedDB, in place before the app's own boot code reads it
      Object.assign(x.DB, {
        open: async () => {},
        all: async s => [...stores[s].values()].map(clone),
        get: async (s, id) => clone(stores[s].get(id)),
        put: async (s, v) => { stores[s].set(v.id, clone(v)); },
        del: async (s, id) => { stores[s].delete(id); },
        clear: async s => { stores[s].clear(); },
      });
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'app.js' });
  // wait for the app's boot (loads the seeded data, then cloudStart() schedules the 2-minute sync)
  for (let i = 0; i < 200 && !timers.some(t => t.interval && t.ms === 120000); i++) await new Promise(r => setImmediate(r));
  assert.ok(timers.some(t => t.interval && t.ms === 120000), 'app booted and scheduled cloud sync');
  return { app, cloud, stores, timers, input: () => inputEl };
}

const blob = (n, type = 'image/jpeg') => new Blob([Buffer.alloc(n, 7)], { type });
const localPhoto = (id, extra) => ({ id, blob: blob(2000), thumb: blob(200, 'image/webp'), created: '2026-10-01T09:00:00.000Z', name: id + '.JPG', ...extra });
const point = (id, lng, lat, props) => ({ id, feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { id, kind: 'point', category: 'other', ...props } } });
const firstIndex = (list, pred) => list.findIndex(pred);

test('legacy data with an empty pending queue is backfilled once; tombstones stay deleted; estimated positions kept', async () => {
  const f8706 = point('F8706', 44.3921, 33.3389, { name: 'IMG_8706 — موقع تقديري', estimated: true, photos: ['IMG_8706'], updated: '2026-10-01T10:00:00.000Z' });
  const f8710 = point('F8710', 44.3930, 33.3381, { name: 'IMG_8710 — موقع تقديري', estimated: true, photos: ['IMG_8710', 'IMG_8715'], removedPhotos: ['IMG_8715'], updated: '2026-10-01T10:05:00.000Z' });
  const { app, cloud, stores } = await loadApp({ seed: {
    photos: [localPhoto('IMG_8706'), localPhoto('IMG_8710'), localPhoto('IMG_8701')],
    features: [f8706, f8710],
    heritage: [{ id: 'HP3', name: 'خان', photos: ['IMG_8701', 'IMG_8725'], updated: '2026-10-01T11:00:00.000Z' }],   // an old phone still lists the deleted photo
    meta: [{ id: 'pending', ids: {} }, { id: 'delph:IMG_8715', at: '2026-10-01T12:00:00.000Z' }, { id: 'delph:IMG_8725', at: '2026-10-01T12:01:00.000Z' },
      { id: 'settings', mode: 'field', observer: 'old phone' }],   // older app: no cloud settings at all
  } });

  await app.cloudSync();

  // records reached the cloud exactly as they were — same position, name and `updated`
  assert.deepEqual(cloud.records.get('F8706').data.geometry.coordinates, [44.3921, 33.3389]);
  assert.equal(cloud.records.get('F8706').data.properties.name, 'IMG_8706 — موقع تقديري');
  assert.equal(cloud.records.get('F8706').updated, '2026-10-01T10:00:00.000Z');
  assert.equal(cloud.records.get('F8710').data.properties.name, 'IMG_8710 — موقع تقديري');
  assert.ok(cloud.records.has('HP3'));
  // deleted photos: tombstoned in the cloud, dropped from the records, never uploaded, not back on the phone
  for (const id of ['IMG_8715', 'IMG_8725']) {
    assert.ok(cloud.photos.get(id)?.deleted, id + ' tombstoned in the cloud');
    assert.ok(!cloud.calls.some(c => c.id === id && (c.action === 'putPhoto' || c.action === 'putThumb')), id + ' never uploaded');
    assert.ok(!stores.photos.has(id) && app.DELPH.has(id), id + ' stays deleted on the phone');
  }
  assert.deepEqual(cloud.records.get('HP3').data.photos, ['IMG_8701']);
  assert.deepEqual(cloud.records.get('F8710').data.properties.photos, ['IMG_8710']);
  const acts = cloud.actions();
  assert.ok(acts.indexOf('delPhotos') < acts.indexOf('putRecords'), 'deletions reach the cloud before the records');
  // every photo is in the Drive and nothing is waiting
  for (const id of ['IMG_8706', 'IMG_8710', 'IMG_8701']) assert.equal(stores.photos.get(id).cloud, 'file-' + id);
  assert.deepEqual({ ...app.PENDING.ids }, {});
  assert.equal(app.CLOUD.state, 'idle');
  assert.match(app.cloudStatusHtml(), /✓ متزامن/);

  // the next sync republishes nothing
  const before = cloud.calls.length;
  await app.cloudSync();
  const again = cloud.calls.slice(before).map(c => c.action);
  assert.deepEqual(again.filter(a => a !== 'pull'), [], 'second sync only pulls: ' + again.join(','));
});

test('backfill after earlier pulls: only own-photo records, queued deletion kept, newer cloud version wins', async () => {
  const cloud = fakeCloud();
  cloud.records.set('HP9', { id: 'HP9', store: 'heritage', updated: '2026-10-05T00:00:00.000Z', synced: cloud.now(), data: { id: 'HP9', photos: ['PR1'], updated: '2026-10-05T00:00:00.000Z' } });
  cloud.records.set('HP3', { id: 'HP3', store: 'heritage', updated: '2026-10-05T00:00:00.000Z', synced: cloud.now(), data: { id: 'HP3', name: 'newer name', photos: ['PR2'], updated: '2026-10-05T00:00:00.000Z' } });
  cloud.records.set('F5', { id: 'F5', store: 'features', updated: '2026-10-02T00:00:00.000Z', synced: cloud.now(), data: point('F5', 44.39, 33.33, { updated: '2026-10-02T00:00:00.000Z' }).feature });
  const { app, stores } = await loadApp({ cloud, seed: {
    photos: [localPhoto('PL1'), { id: 'PR1', cloud: 'file-PR1', remote: true, thumb: blob(100, 'image/webp') }],
    heritage: [{ id: 'HP3', name: 'old name', photos: ['PL1'], updated: '2026-10-01T00:00:00.000Z' },
      { id: 'HP9', photos: ['PR1'], updated: '2026-10-05T00:00:00.000Z' }],    // downloaded from a teammate
    meta: [{ id: 'pending', ids: { F5: 'deleted' } }, { id: 'del:F5', updated: '2026-10-03T00:00:00.000Z' },
      { id: 'settings', cloud: { url: '', key: '', lastPull: '2026-10-13T00:00:00.000Z', lastPush: '' } }],
  } });

  await app.cloudSync();

  const pushed = cloud.calls.filter(c => c.action === 'putRecords').flatMap(c => c.records.map(r => `${r.id}:${r.store}`)).sort();
  assert.deepEqual(pushed, ['F5:deleted', 'HP3:heritage'], 'teammate record HP9 is not republished');
  assert.equal(cloud.records.get('F5').store, 'deleted');
  assert.equal(cloud.records.get('HP3').data.name, 'newer name');
  assert.equal(cloud.records.get('HP3').updated, '2026-10-05T00:00:00.000Z');
  assert.deepEqual(cloud.records.get('HP3').data.photos.sort(), ['PL1', 'PR2'], 'the newer record only gains the photo');
  assert.equal(app.S.heritage.get('HP3').name, 'newer name');
  assert.ok(app.S.heritage.get('HP3').photos.includes('PL1'));
  assert.ok(!app.S.features.has('F5') && !stores.features.has('F5'), 'deleted feature not resurrected');
  assert.deepEqual({ ...app.PENDING.ids }, {});

  const before = cloud.calls.length;
  await app.cloudSync();
  assert.ok(!cloud.calls.slice(before).some(c => c.action === 'putRecords'), 'no republish on the next sync');
});

test('a persisted deletion overrides a stale feature even if it was already queued', async () => {
  const { app, stores, cloud } = await loadApp({ seed: {
    features: [point('Fstale', 44.39, 33.33, { updated: '2026-10-09T00:00:00.000Z', photos: ['Pstale'] })],
    photos: [localPhoto('Pstale')],
    meta: [{ id: 'pending', ids: { Fstale: 'features' } },
      { id: 'del:Fstale', updated: '2026-10-14T00:00:00.000Z' },
      { id: 'delph:Pstale', at: '2026-10-14T00:00:00.000Z' }],
  } });
  await app.cloudSync();
  assert.equal(cloud.records.get('Fstale').store, 'deleted');
  assert.ok(!app.S.features.has('Fstale') && !stores.features.has('Fstale'));
  assert.ok(!cloud.calls.some(c => ['putThumb', 'putPhoto'].includes(c.action) && c.id === 'Pstale'));
});

test('a deletion received from another device prevents a later import from recreating the record', async () => {
  const cloud = fakeCloud();
  cloud.records.set('Fgone', { id: 'Fgone', store: 'deleted', updated: '2026-10-14T00:00:00.000Z', synced: cloud.now(), data: { id: 'Fgone' } });
  const { app, stores, input } = await loadApp({ cloud });
  await app.cloudSync();
  assert.equal(stores.meta.get('del:Fgone').updated, '2026-10-14T00:00:00.000Z');
  const imported = point('Fgone', 44.39, 33.33, { updated: '2026-10-15T00:00:00.000Z' }).feature;
  app.importFile();
  const inp = input();
  inp.files = [new File([JSON.stringify({ type: 'FeatureCollection', features: [imported] })], 'survey.geojson', { type: 'application/json' })];
  await inp.onchange();
  assert.ok(!app.S.features.has('Fgone'));
});

test('import never brings back a deleted feature or photo and schedules a cloud sync by itself', async () => {
  const { app, timers, input } = await loadApp({ seed: { meta: [{ id: 'del:F7', updated: '2026-10-03T00:00:00.000Z' }, { id: 'delph:P7', at: '2026-10-03T00:00:00.000Z' }] } });
  app.importFile();
  const gj = { type: 'FeatureCollection', features: [point('F7', 44.39, 33.33, { updated: '2026-10-01T00:00:00.000Z' }).feature,
    point('F8', 44.39, 33.33, { updated: '2026-10-01T00:00:00.000Z', photos: ['P8'] }).feature] };
  const inp = input(); inp.files = [new File([JSON.stringify(gj)], 'survey.geojson', { type: 'application/json' })];
  const n = timers.length;
  await inp.onchange();
  assert.ok(!app.S.features.has('F7'), 'deleted feature stays deleted');
  assert.ok(app.S.features.has('F8'));
  assert.equal(app.PENDING.ids.F8, 'features');
  assert.ok(timers.slice(n).some(t => t.fn === app.cloudSync), 'sync scheduled after the import');
});

test('remote records and thumbnails arrive before the long original uploads, and keep arriving during them', async () => {
  const cloud = fakeCloud();
  const thumbB64 = Buffer.alloc(64, 3).toString('base64');
  cloud.records.set('HPT', { id: 'HPT', store: 'heritage', updated: '2026-10-10T00:00:00.000Z', synced: cloud.now(), data: { id: 'HPT', name: 'teammate', photos: ['PT'], updated: '2026-10-10T00:00:00.000Z' } });
  cloud.photos.set('PT', { id: 'PT', fileId: '', thumb: thumbB64, synced: cloud.now() });
  const photos = ['PA', 'PB', 'PC'].map(id => localPhoto(id));
  const { app, stores } = await loadApp({ cloud, seed: { photos, heritage: [{ id: 'HP1', photos: ['PA', 'PB', 'PC'], updated: '2026-10-11T00:00:00.000Z' }] } });
  const seen = [];
  cloud.onCall = async req => {
    if (req.action !== 'putPhoto') return;
    seen.push({ id: req.id, teammate: app.S.heritage.has('HPT'), thumb: !!stores.photos.get('PT')?.thumb, later: app.S.heritage.has('HPU'), edit: !!cloud.records.get('HP2') });
    if (seen.length === 1) {
      // while the first original uploads: a teammate saves a record, and this phone saves one too
      cloud.records.set('HPU', { id: 'HPU', store: 'heritage', updated: '2026-10-14T00:00:00.000Z', synced: cloud.now(), data: { id: 'HPU', photos: [], updated: '2026-10-14T00:00:00.000Z' } });
      await app.putHeritage({ id: 'HP2', name: 'saved mid-upload', photos: [] });
      await app.cloudSync();                 // the kick lands while the sync is busy: no second sync runs alongside
    }
  };

  await app.cloudSync();

  const acts = cloud.actions();
  assert.ok(acts.indexOf('pull') < acts.indexOf('putPhoto'), 'pulled before the first original: ' + acts.join(','));
  assert.equal(acts.filter(a => a === 'putThumb').length, 3);
  assert.ok(acts.lastIndexOf('putThumb') < acts.indexOf('putPhoto'), 'all thumbnails before the originals');
  assert.ok(seen[0].teammate && seen[0].thumb, "the teammate's record and preview were on this phone before the first original");
  assert.ok(seen[1].edit && seen[1].later, 'the mid-upload save went up and the teammate record came down before the next original');
  assert.deepEqual(seen.map(s => s.id), ['PA', 'PB', 'PC']);
  for (const id of ['PA', 'PB', 'PC']) assert.equal(stores.photos.get(id).cloud, 'file-' + id);
  assert.equal(app.CLOUD.again, true, 'the kick during the sync asks for one more run afterwards');
});

test('failed originals are retried with backoff (never starved) and never reported as synced', async () => {
  const cloud = fakeCloud();
  let failPF = true;
  cloud.fail.putPhoto = req => req.id === 'PF' && failPF;
  const { app, stores } = await loadApp({ cloud, seed: {
    photos: [localPhoto('PS', { cloudErrs: 7, thumbSent: true }), localPhoto('PF')],   // PS: given up on by the old app
    heritage: [{ id: 'HP1', photos: ['PS', 'PF'], updated: '2026-10-11T00:00:00.000Z' }],
  } });

  await app.cloudSync();
  assert.equal(stores.photos.get('PS').cloud, 'file-PS', 'a photo the old app gave up on is uploaded');
  assert.equal(stores.photos.get('PS').cloudErrs, undefined);
  assert.equal(stores.photos.get('PF').cloudErrs, 1);
  assert.equal(app.CLOUD.state, 'error');
  assert.equal(app.CLOUD.pendPhotos, 1);
  assert.doesNotMatch(app.cloudStatusHtml(), /✓/);

  // right away: still backing off, still not «synced»
  failPF = false;
  let before = cloud.calls.length;
  await app.cloudSync();
  assert.ok(!cloud.calls.slice(before).some(c => c.action === 'putPhoto'));
  assert.equal(app.CLOUD.state, 'error');
  assert.doesNotMatch(app.cloudStatusHtml(), /✓/);

  // after the wait it goes up and the phone reports synced
  stores.photos.get('PF').cloudErrAt = Date.now() - 3 * 60000;
  before = cloud.calls.length;
  await app.cloudSync();
  assert.ok(cloud.calls.slice(before).some(c => c.action === 'putPhoto' && c.id === 'PF'));
  assert.equal(stores.photos.get('PF').cloud, 'file-PF');
  assert.equal(app.CLOUD.state, 'idle');
  assert.match(app.cloudStatusHtml(), /✓ متزامن/);

  // the backoff caps at an hour
  const now = Date.now();
  assert.equal(app.photoDue({ cloudErrs: 10, cloudErrAt: now - 59 * 60000 }, now), false);
  assert.equal(app.photoDue({ cloudErrs: 10, cloudErrAt: now - 61 * 60000 }, now), true);
});

test('failed thumbnails or records keep the sync unfinished; a failed thumbnail whose original went up does not', async () => {
  const cloud = fakeCloud();
  cloud.fail.putThumb = () => true;
  cloud.fail.putPhoto = req => req.id === 'PX';
  const { app, stores } = await loadApp({ cloud, seed: { photos: [localPhoto('PX'), localPhoto('PY')], heritage: [{ id: 'HP1', photos: ['PX', 'PY'], updated: '2026-10-11T00:00:00.000Z' }] } });
  await app.cloudSync();
  assert.equal(app.CLOUD.state, 'error');
  assert.match(app.CLOUD.err, /^1 /, 'only PX counts — PY went up with its original');
  assert.equal(app.CLOUD.pendPhotos, 1);

  // records that cannot be written stay queued and the status says so
  cloud.fail.putThumb = () => false; cloud.fail.putPhoto = () => false; cloud.fail.putRecords = () => true;
  await app.putHeritage({ id: 'HP5', photos: [] });
  await app.cloudSync();
  assert.equal(app.PENDING.ids.HP5, 'heritage');
  assert.equal(app.CLOUD.state, 'error');
  assert.doesNotMatch(app.cloudStatusHtml(), /✓/);

  cloud.fail.putRecords = () => false;
  await app.cloudSync();
  assert.deepEqual({ ...app.PENDING.ids }, {});
  assert.equal(app.CLOUD.state, 'error', 'PX is still waiting out its backoff');
  stores.photos.get('PX').cloudErrAt = Date.now() - 3 * 60000;
  await app.cloudSync();
  assert.deepEqual({ ...app.PENDING.ids }, {});
  assert.equal(app.CLOUD.state, 'idle');
  assert.match(app.cloudStatusHtml(), /✓ متزامن/);
});

test('a failing pull is reported but does not hold back the uploads', async () => {
  const cloud = fakeCloud();
  let pullFails = true;
  cloud.fail.pull = () => pullFails;
  const { app, stores } = await loadApp({ cloud, seed: { photos: [localPhoto('PA')], heritage: [{ id: 'HP1', photos: ['PA'], updated: '2026-10-11T00:00:00.000Z' }] } });
  await app.cloudSync();
  assert.equal(stores.photos.get('PA').cloud, 'file-PA');
  assert.ok(cloud.records.has('HP1'));
  assert.equal(app.CLOUD.state, 'error');
  assert.doesNotMatch(app.cloudStatusHtml(), /✓ متزامن/);
  pullFails = false;
  await app.cloudSync();
  assert.equal(app.CLOUD.state, 'idle');
});

test('more than 200 photo deletions are all delivered (the script takes 200 per call)', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => 'PD' + i);
  const { app, cloud } = await loadApp({ seed: { meta: [{ id: 'pending', ids: Object.fromEntries(ids.map(id => [id, 'delphoto'])) },
    { id: 'settings', cloud: { url: '', key: '', lastPull: '2026-10-13T00:00:00.000Z', lastPush: '' } }] } });
  await app.cloudSync();
  assert.equal(cloud.calls.filter(c => c.action === 'delPhotos').length, 2);
  assert.ok(ids.every(id => cloud.photos.get(id)?.deleted));
  assert.deepEqual({ ...app.PENDING.ids }, {});
});

test('an overloaded server does not count against a photo: no retry penalty, a soon randomised retry, uploaded next time', async () => {
  const { app, cloud, stores, timers } = await loadApp({ seed: {
    photos: [localPhoto('PB1')],
    heritage: [{ id: 'HP4', photos: ['PB1'], updated: '2026-10-14T07:00:00.000Z' }],
    meta: [{ id: 'pending', ids: { HP4: 'heritage' } }, { id: 'settings', cloud: { url: '', key: '', lastPull: '2026-10-13T00:00:00.000Z', lastPush: '' } }],
  } });
  cloud.busy.putPhoto = () => true;
  const before = timers.length;
  await app.cloudSync();
  assert.ok(!stores.photos.get('PB1').cloud, 'not uploaded while the server is busy');
  assert.ok(!stores.photos.get('PB1').cloudErrs, 'a busy server is not the photo\'s fault');
  assert.ok(app.photoDue(stores.photos.get('PB1')), 'so it is due again right away');
  const retry = timers.slice(before).filter(t => !t.interval && t.ms >= 2000 && t.ms <= 120000);
  assert.ok(retry.length, 'a retry is scheduled within seconds, not left to the 2-minute timer');
  assert.ok(cloud.records.has('HP4'), 'the record still went up before the originals');
  cloud.busy.putPhoto = null;
  await app.cloudSync();
  assert.equal(stores.photos.get('PB1').cloud, 'file-PB1');
});

test('a new phone gets the photo list without thumbnails, then all thumbnails in one batched request', async () => {
  const cloud = fakeCloud();
  for (const id of ['PT1', 'PT2', 'PT3']) cloud.photos.set(id, { id, fileId: 'file-' + id, thumb: Buffer.from('thumb-' + id).toString('base64'), synced: cloud.now() });
  cloud.records.set('F9', { id: 'F9', store: 'features', updated: '2026-10-10T00:00:00.000Z', synced: cloud.now(), data: point('F9', 44.39, 33.34, { photos: ['PT1', 'PT2', 'PT3'], updated: '2026-10-10T00:00:00.000Z' }).feature });
  const { app, stores } = await loadApp({ cloud });
  await app.cloudSync();
  const acts = cloud.actions();
  assert.equal(cloud.calls.find(c => c.action === 'pull').since, '', 'first sync of a new phone pulls everything');
  assert.equal(acts.filter(a => a === 'thumbs').length, 1, 'all thumbnails in one batched request: ' + acts.join(','));
  assert.ok(acts.indexOf('pull') < acts.indexOf('thumbs'));
  assert.deepEqual(cloud.calls.find(c => c.action === 'thumbs').ids.sort(), ['PT1', 'PT2', 'PT3']);
  assert.ok(!acts.includes('getPhoto'), 'no per-photo calls');
  for (const id of ['PT1', 'PT2', 'PT3']) assert.ok(stores.photos.get(id).thumb, id + ' thumbnail on the phone');
  const before = cloud.calls.length;
  const urls = await Promise.all(['PT1', 'PT2', 'PT3'].map(id => app.photoUrl(id)));
  assert.ok(urls.every(Boolean), 'every thumbnail shows');
  assert.equal(cloud.calls.length, before, 'showing them needs no more requests');
});

test('a lock timeout in the owner\'s language (Arabic) is treated as busy, not as the photo\'s fault', async () => {
  const { app, cloud, stores } = await loadApp({ seed: {
    photos: [localPhoto('PK1')],
    heritage: [{ id: 'HP5', photos: ['PK1'], updated: '2026-10-14T07:00:00.000Z' }],
    meta: [{ id: 'pending', ids: { HP5: 'heritage' } }, { id: 'settings', cloud: { url: '', key: '', lastPull: '2026-10-13T00:00:00.000Z', lastPush: '' } }],
  } });
  cloud.lockTimeout = { putPhoto: () => true };
  await app.cloudSync();
  assert.ok(!stores.photos.get('PK1').cloud && !stores.photos.get('PK1').cloudErrs, 'not uploaded, not counted against the photo');
  cloud.lockTimeout = {};
  await app.cloudSync();
  assert.equal(stores.photos.get('PK1').cloud, 'file-PK1');
});
