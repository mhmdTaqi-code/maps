/**
 * Team cloud for «مسح السايت» (https://mhmdtaqi.me/maps) — free, runs in your own Google account.
 *
 * Photos go to a Google Drive folder (one sub-folder per building), survey records and a readable
 * photo index go to a Google Sheet in the same folder. The app reads everything back through this
 * script, so every teammate sees everyone's photos.
 *
 * Setup (once):
 *   1. https://script.google.com → New project → paste this whole file.
 *   2. Deploy → New deployment → "Web app" → Execute as: Me → Who has access: Anyone → Deploy → authorise.
 *   3. Put the …/exec URL in the app (TEAM_CLOUD_URL in app.js) — every visitor then syncs automatically.
 *   4. Optional: run `setup` once to create the folder/sheet right away.
 * Updating this code later: Deploy → Manage deployments → ✏️ → Version: New version → Deploy (URL stays the same).
 *
 * Access: OPEN_ACCESS = true means anyone who has the site can upload — the site is the team's.
 * Protections either way: only images, max ≈ 35 MB per photo (Apps Script's request limit), a daily cap per device, and reads are limited
 * to the survey photos this script stored (nothing else in your Drive can be fetched).
 * For a password instead, set OPEN_ACCESS = false and run `setup` (creates a key + join link).
 */
const OPEN_ACCESS = true;
const APP_URL = 'https://mhmdtaqi.me/maps/';
const WEBAPP_URL = '';                                // only needed for the join link when OPEN_ACCESS = false
const ROOT_NAME = 'مسح السايت — الرصافة القديمة';
const MAX_CELL = 45000;                             // Sheets cell limit is 50,000 characters
const MAX_PHOTO_B64 = 48 * 1024 * 1024;              // ≈ 35 MB per photo — Apps Script accepts ≈ 50 MB per request
const DAILY_PHOTOS_PER_DEVICE = 5000;
// thumb = small base64 preview sent first so teammates see the photo within seconds; previewId = 1600 px copy
const PHOTO_COLS = ['photoId', 'fileId', 'owner', 'created', 'device', 'synced', 'bytes', 'observer', 'lat', 'lng', 'link', 'name', 'thumb', 'previewId', 'deleted'];
const MAX_THUMB_B64 = 45000;

function doGet() { return out({ ok: true, service: 'site-survey-cloud', version: 11, open: OPEN_ACCESS }); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad request' }); }
  if (!req) return out({ ok: false, error: 'bad request' });
  if (!OPEN_ACCESS) {
    const k = props().getProperty('SYNC_KEY');
    if (!k || req.key !== k) return out({ ok: false, error: 'bad key' });
  }
  try {
    switch (req.action) {
      case 'ping': return out(ping());
      case 'putThumb': return out(putThumb(req));
      case 'putPhoto': return out(putPhoto(req));
      case 'getPhoto': return out(getPhoto(req));
      case 'putRecords': return out(putRecords(req));
      case 'pull': return out(pull(req));
      case 'loc': return out(loc(req));
      case 'delPhotos': return out(delPhotos(req));
      case 'thumbs': return out(thumbs(req));
      case 'epoch': return out({ ok: true, epoch: prop('EPOCH') || '' });
      default: return out({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return out({ ok: false, busy: true, error: String(err && err.message || err) });
  }
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function withLock(fn) {
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function now() { return new Date().toISOString(); }
const clean = s => String(s || '').replace(/[\\/:*?"<>|#\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---- storage locations (created on first use, ids remembered)
function props() { return PropertiesService.getScriptProperties(); }
// every request needs a few ids (folder, sheet): read them through the cache — 50 phones syncing all day would
// otherwise use up the Properties service's daily quota
function prop(k) {
  const c = CacheService.getScriptCache(), v = c.get('p2:' + k);
  if (v) return v;
  const x = props().getProperty(k);
  if (x) c.put('p2:' + k, x, 21600);
  return x;
}
function setProp(k, v) { props().setProperty(k, v); CacheService.getScriptCache().put('p2:' + k, v, 21600); }
function root() {
  const id = prop('ROOT');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder(ROOT_NAME); setProp('ROOT', f.getId()); return f;
}
function photosFolder() {
  const id = prop('PHOTOS');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = root().createFolder('الصور'); setProp('PHOTOS', f.getId()); return f;
}
// one sub-folder per building / record, keyed by its id so a later rename keeps the same folder:
// "HP20 — خان مرجان الاثري", "F7k2… — مدخل الخان"
function previewsFolder() {
  const id = prop('PREVIEWS');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = root().createFolder('معاينات (للتطبيق)'); setProp('PREVIEWS', f.getId()); return f;
}
function photoRow(sh, id) {
  const hit = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}
function folderFor(ownerId, ownerName) {
  const id = clean(ownerId) || 'بدون-مبنى', name = clean(ownerName ? `${id} — ${ownerName}` : id).slice(0, 100);
  const key = 'DIR_' + id.slice(0, 60);
  const known = prop(key);
  if (known) {
    try { const f = DriveApp.getFolderById(known); if (f.getName() !== name) f.setName(name); return f; } catch (e) {}
  }
  const f = photosFolder().createFolder(name);
  setProp(key, f.getId()); return f;
}
// The records sheet, opened by its remembered id. If Google cannot open it for a moment: wait, retry, and
// then answer "busy" — never make a new one while an id is known (that once hid all the work behind an empty
// sheet). A new sheet is made only on a first setup or after a reset, and even then an existing records sheet
// in the folder is adopted first.
function book() {
  if (book.ss) return book.ss;
  const id = prop('SHEET');
  let ss = null, err = null;
  if (id) {
    for (let k = 0; k < 3 && !ss; k++) {
      try { ss = SpreadsheetApp.openById(id); } catch (e) { err = e; if (k < 2) Utilities.sleep(1500 * (k + 1)); }
    }
    if (!ss) throw new Error('records sheet unavailable for now: ' + (err && err.message));   // → busy: true
  } else {
    ss = recordsSheetsInRoot()[0] || null;
    if (!ss) {
      ss = SpreadsheetApp.create('سجل الرصد — ' + ROOT_NAME);
      DriveApp.getFileById(ss.getId()).moveTo(root());
      const r = ss.getSheets()[0]; r.setName('records'); r.appendRow(['id', 'store', 'updated', 'device', 'synced', 'json']); r.setFrozenRows(1);
      ss.insertSheet('photos');
    }
    setProp('SHEET', ss.getId());
  }
  const ph = ss.getSheetByName('photos') || ss.insertSheet('photos');
  if (ph.getRange(1, PHOTO_COLS.length).getValue() !== PHOTO_COLS[PHOTO_COLS.length - 1]) {   // header (v1 had fewer columns)
    ph.getRange(1, 1, 1, PHOTO_COLS.length).setValues([PHOTO_COLS]); ph.setFrozenRows(1);
  }
  book.ss = ss;
  return ss;
}
// records sheets directly in the survey folder (daily backups live in a sub-folder), the fullest first
function recordsSheetsInRoot() {
  const out = [], it = root().getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('سجل الرصد') !== 0) continue;
    try { out.push(SpreadsheetApp.open(f)); } catch (e) {}
  }
  const size = function (s) { return ['records', 'photos'].reduce(function (a, n) { const sh = s.getSheetByName(n); return a + (sh ? Math.max(0, sh.getLastRow() - 1) : 0); }, 0); };
  out.forEach(function (s) { s._rows = size(s); });
  return out.sort(function (a, b) { return b._rows - a._rows; });
}
function columnMap(sh) {                 // id (column A) -> row number
  const n = sh.getLastRow(), m = {};
  if (n < 2) return m;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) m[ids[i][0]] = i + 2;
  return m;
}

function ping() {
  const ss = book(), photos = Math.max(0, ss.getSheetByName('photos').getLastRow() - 1), records = Math.max(0, ss.getSheetByName('records').getLastRow() - 1);
  return { ok: true, open: OPEN_ACCESS, folder: root().getUrl(), sheet: ss.getUrl(), photos: photos, records: records,
           used: DriveApp.getStorageUsed(), limit: DriveApp.getStorageLimit(), now: now() };
}

// ---- thumbnail first: a few KB, so teammates see the photo long before the original finishes uploading
function putThumb(req) {
  if (!req.id || !req.thumb || String(req.thumb).length > MAX_THUMB_B64) return { ok: false, error: 'bad thumb' };
  const sh = book().getSheetByName('photos'), m = req.meta || {};
  const row = photoRow(sh, req.id);
  if (row && sh.getRange(row, 15).getValue()) return { ok: true, deleted: true };
  if (row) { sh.getRange(row, 13).setValue(req.thumb); sh.getRange(row, 6).setValue(now()); }
  else sh.appendRow([req.id, '', clean(req.ownerName || req.owner), m.created || '', req.device || '', now(), '', clean(m.observer), m.lat || '', m.lng || '', '', clean(m.name), req.thumb, '']);
  bump();
  return { ok: true };
}

// ---- photos: idempotent upload (same photoId twice = same file)
function putPhoto(req) {
  if (!req.id || !req.data) return { ok: false, error: 'missing photo' };
  if (String(req.data).length > MAX_PHOTO_B64) return { ok: false, error: 'photo too large (max ≈ 35 MB)' };
  const sh = book().getSheetByName('photos');
  const existing = photoRow(sh, req.id);
  if (existing) {
    if (sh.getRange(existing, 15).getValue()) return { ok: true, deleted: true };
    const fid = sh.getRange(existing, 2).getValue();
    if (fid) return { ok: true, fileId: fid, existed: true };
  }
  // daily cap per device so a runaway phone (or a stranger) cannot fill the Drive
  const day = now().slice(0, 10), cache = CacheService.getScriptCache(), qk = 'q:' + clean(req.device).slice(0, 40) + ':' + day;
  const used = Number(cache.get(qk) || 0);
  if (used >= DAILY_PHOTOS_PER_DEVICE) return { ok: false, error: 'daily limit reached' };
  const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif', 'image/tiff': 'tif', 'image/avif': 'avif' };
  const mime = EXT[req.mime] ? req.mime : (/^image\//.test(String(req.mime)) ? req.mime : 'image/jpeg');
  const bytes = Utilities.base64Decode(req.data);
  const m = req.meta || {}, when = String(m.created || now()).slice(0, 16).replace('T', '_').replace(':', '');
  const fname = clean(`${when}_${m.observer || 'مجهول'}_${req.id}`) + '.' + (EXT[mime] || 'img');
  const file = folderFor(req.ownerId || req.owner, req.ownerName).createFile(Utilities.newBlob(bytes, mime, fname));
  file.setDescription(JSON.stringify(m));
  let previewId = '';
  if (req.preview && String(req.preview).length < MAX_PHOTO_B64) {
    previewId = previewsFolder().createFile(Utilities.newBlob(Utilities.base64Decode(req.preview), 'image/webp', req.id + '_1600.webp')).getId();
  }
  withLock(() => {
    const row = photoRow(sh, req.id);   // the thumb may already have created the row
    if (row && sh.getRange(row, 15).getValue()) {   // deleted while it was uploading
      try { file.setTrashed(true); if (previewId) DriveApp.getFileById(previewId).setTrashed(true); } catch (e) {}
      return;
    }
    const vals = [req.id, file.getId(), clean(req.ownerName || req.owner), m.created || '', req.device || '', now(), bytes.length,
                  clean(m.observer), m.lat || '', m.lng || '', file.getUrl(), clean(m.name), row ? sh.getRange(row, 13).getValue() : (req.thumb || ''), previewId];
    if (row) sh.getRange(row, 1, 1, vals.length).setValues([vals]); else sh.appendRow(vals);
  });
  cache.put(qk, String(used + 1), 90000);
  bump();
  return { ok: true, fileId: file.getId() };
}
// ---- deleting photos: the files go to the Drive trash (recoverable for 30 days) and every phone drops them
function delPhotos(req) {
  const sh = book().getSheetByName('photos'), t = now(), trash = [];
  let n = 0;
  withLock(() => {
    (req.ids || []).slice(0, 200).forEach(function (id) {
      id = String(id); if (!id) return;
      const row = photoRow(sh, id);
      if (!row) {   // not uploaded yet: leave a marker so a late upload of it is ignored
        const r = PHOTO_COLS.map(function () { return ''; }); r[0] = id; r[4] = req.device || ''; r[5] = t; r[14] = t;
        sh.appendRow(r); n++; return;
      }
      const v = sh.getRange(row, 1, 1, PHOTO_COLS.length).getValues()[0];
      if (v[14]) return;
      [v[1], v[13]].forEach(function (fid) { if (fid) trash.push(fid); });
      sh.getRange(row, 6).setValue(t); sh.getRange(row, 13).setValue(''); sh.getRange(row, 15).setValue(t);
      CacheService.getScriptCache().remove('th:' + id);
      n++;
    });
  });
  if (n) bump();
  trash.forEach(function (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} });
  return { ok: true, deleted: n };
}

// only files this script stored as survey photos can be read back.
// size: 'thumb' (stored base64 or Drive thumbnail), 'preview' (1600 px copy; small originals as-is), 'full'
function getPhoto(req) {
  const sh = book().getSheetByName('photos');
  const hit = req.fileId && sh.getRange('B:B').createTextFinder(String(req.fileId)).matchEntireCell(true).findNext();
  if (!hit) return { ok: false, error: 'not a survey photo' };
  const row = hit.getRow(), size = req.size || (req.thumb ? 'thumb' : 'full');
  if (sh.getRange(row, 15).getValue()) return { ok: false, error: 'deleted' };
  if (size === 'thumb') { const t = sh.getRange(row, 13).getValue(); if (t) return { ok: true, mime: 'image/webp', data: t }; }
  if (size === 'preview') {
    const pid = sh.getRange(row, 14).getValue();
    if (pid) { const b = DriveApp.getFileById(pid).getBlob(); return { ok: true, mime: 'image/webp', data: Utilities.base64Encode(b.getBytes()) }; }
  }
  const f = DriveApp.getFileById(req.fileId);
  let blob = null;
  if (size !== 'full' && (size === 'thumb' || f.getSize() > 4 * 1024 * 1024)) { try { blob = f.getThumbnail(); } catch (e) {} }
  if (!blob) blob = f.getBlob();
  return { ok: true, mime: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) };
}

// ---- records: newest `updated` wins; `synced` (server clock) drives incremental pulls
function putRecords(req) {
  const sh = book().getSheetByName('records'), t = now();
  let rows = null;
  let written = 0, hist = null;
  const encode = function (data, id) {
    let json = JSON.stringify(data);
    if (json.length > MAX_CELL) {      // very long GPS tracks: keep the record in a Drive file
      const f = root().createFile(id + '.json', json, 'application/json');
      json = JSON.stringify({ __file: f.getId() });
    }
    return json;
  };
  const keep = function (old) { hist = hist || historySheet(); hist.appendRow(old.concat([t, req.device || ''])); };
  const deleted = {};
  if ((req.records || []).some(function (r) { return r && (r.store === 'features' || r.store === 'heritage'); })) {
    const ph = book().getSheetByName('photos'), n = ph.getLastRow();
    if (n > 1) { const a = ph.getRange(2, 1, n - 1, 1).getValues(), d = ph.getRange(2, 15, n - 1, 1).getValues(); a.forEach(function (v, i) { if (d[i][0]) deleted[v[0]] = 1; }); }
  }
  const clean = function (data, old) {        // drop photos that were deleted / removed, keep the removal list
    const a = data && (data.properties || data), o = old && (old.properties || old);
    if (!a) return;
    const rm = [].concat(a.removedPhotos || [], (o && o.removedPhotos) || []).filter(function (x, i, s) { return s.indexOf(x) === i; });
    if (rm.length) a.removedPhotos = rm;
    if (a.photos) a.photos = a.photos.filter(function (x) { return rm.indexOf(x) < 0 && !deleted[x]; });
  };
  withLock(function () { rows = columnMap(sh); (req.records || []).slice(0, 100).forEach(function (r) {
    if (!r || !r.id) return;
    const row = rows[r.id], photos = r.store === 'features' || r.store === 'heritage';
    if (row) {
      // keep the version being replaced (edits and deletions can always be undone from «history»)
      const old = sh.getRange(row, 1, 1, 6).getValues()[0], cur = old[2];
      const oldData = photos ? readJson(old[5]) : null;
      if (String(cur) >= String(r.updated || '')) {
        // an older edit: the newer record stays, but the photos the older one added are never lost
        if (!oldData || !mergePhotoLists(oldData, r.data)) return;
        clean(oldData, r.data);
        keep(old);
        sh.getRange(row, 5, 1, 2).setValues([[t, encode(oldData, r.id)]]);
      } else {
        if (oldData) mergePhotoLists(r.data, oldData);
        if (photos) clean(r.data, oldData);
        keep(old);
        sh.getRange(row, 2, 1, 5).setValues([[r.store, r.updated || '', req.device || '', t, encode(r.data, r.id)]]);
      }
    } else {
      if (photos) clean(r.data, null);
      sh.appendRow([r.id, r.store, r.updated || '', req.device || '', t, encode(r.data, r.id)]);
      rows[r.id] = sh.getLastRow();
    }
    written++;
  }); });
  if (written) bump();
  return { ok: true, written: written, now: t };
}
function readJson(cell) {
  try {
    let d = JSON.parse(cell);
    if (d && d.__file) d = JSON.parse(DriveApp.getFileById(d.__file).getBlob().getDataAsString());
    return d;
  } catch (e) { return null; }
}
// add `from`'s photos to `into` (a feature keeps them in properties) unless someone removed them on purpose
function mergePhotoLists(into, from) {
  const a = into && (into.properties || into), b = from && (from.properties || from);
  if (!a || !b || !b.photos || !b.photos.length) return false;
  const gone = [].concat(a.removedPhotos || [], b.removedPhotos || []), have = a.photos || [];
  const add = b.photos.filter(function (x) { return have.indexOf(x) < 0 && gone.indexOf(x) < 0; });
  if (!add.length) return false;
  a.photos = have.concat(add);
  return true;
}
// change counter: the app's location poll carries it, so phones fetch new photos / records within seconds
function bump() { CacheService.getScriptCache().put('rev', String(Date.now()), 21600); }
function historySheet() {
  const ss = book();
  let h = ss.getSheetByName('history');
  if (!h) { h = ss.insertSheet('history'); h.appendRow(['id', 'store', 'updated', 'device', 'synced', 'json', 'replacedAt', 'replacedBy']); h.setFrozenRows(1); }
  return h;
}
// one full copy of the records sheet per day, in «نسخ احتياطية» (made by the first sync of the day)
function backupDaily(ss) {
  const day = now().slice(0, 10), p = props();
  if (prop('BACKUP_DAY') === day) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    if (p.getProperty('BACKUP_DAY') === day) return;
    let dir = null; const id = p.getProperty('BACKUPS');
    if (id) { try { dir = DriveApp.getFolderById(id); } catch (e) {} }
    if (!dir) { dir = root().createFolder('نسخ احتياطية (يومية)'); p.setProperty('BACKUPS', dir.getId()); }
    DriveApp.getFileById(ss.getId()).makeCopy('نسخة ' + day + ' — ' + ss.getName(), dir);
    setProp('BACKUP_DAY', day);
  } catch (e) {} finally { lock.releaseLock(); }
}
// contiguous blocks [first row index, count] of rows whose sync time is newer than `since`
function changedBlocks(col, since) {
  const out = []; let start = -1;
  for (let i = 0; i <= col.length; i++) {
    const hit = i < col.length && String(col[i][0]) > since;
    if (hit && start < 0) start = i;
    if (!hit && start >= 0) { out.push([start, i - start]); start = -1; }
  }
  return out;
}
// A phone opening the app for the first time gets everything except thumbnails (it asks for those in batches,
// `thumbs`); later syncs only read the rows that changed. With hundreds of photos the thumbnail column alone
// is many MB, so reading it on every sync of every phone would not scale.
function pull(req) {
  const ss = book(), since = String(req.since || ''), t = now();
  backupDaily(ss);
  const recSh = ss.getSheetByName('records'), n = recSh.getLastRow(), records = [];
  if (n > 1) changedBlocks(recSh.getRange(2, 5, n - 1, 1).getValues(), since).forEach(function (b) {
    recSh.getRange(b[0] + 2, 1, b[1], 6).getValues().forEach(function (v) {
      let data = readJson(v[5]);
      records.push({ id: v[0], store: v[1], updated: v[2], device: v[3], data: data });
    });
  });
  const phSh = ss.getSheetByName('photos'), m = phSh.getLastRow(), photos = [];
  if (m > 1) changedBlocks(phSh.getRange(2, 6, m - 1, 1).getValues(), since).forEach(function (b) {
    const head = phSh.getRange(b[0] + 2, 1, b[1], 12).getValues(), tail = phSh.getRange(b[0] + 2, 14, b[1], 2).getValues();
    const th = since ? phSh.getRange(b[0] + 2, 13, b[1], 1).getValues() : null;
    head.forEach(function (v, i) {
      if (tail[i][1]) photos.push({ id: v[0], deleted: true });
      else photos.push({ id: v[0], fileId: v[1], owner: v[2], created: v[3], device: v[4], observer: v[7], thumb: th ? (th[i][0] || '') : '' });
    });
  });
  return { ok: true, records: records, photos: photos, now: t, thumbs: !!since };
}
// thumbnails in batches (≤ 60), from the cache when another phone already asked for them
function thumbs(req) {
  const ids = (req.ids || []).slice(0, 60).map(String), cache = CacheService.getScriptCache();
  const got = cache.getAll(ids.map(function (id) { return 'th:' + id; })), out = {}, miss = [];
  ids.forEach(function (id) { const v = got['th:' + id]; if (v) out[id] = v; else miss.push(id); });
  if (miss.length) {
    const sh = book().getSheetByName('photos'), n = sh.getLastRow(), put = {};
    if (n > 1) {
      const idx = {};
      sh.getRange(2, 1, n - 1, 1).getValues().forEach(function (v, i) { idx[v[0]] = i + 2; });
      miss.forEach(function (id) {
        const r = idx[id]; if (!r) return;
        const v = sh.getRange(r, 13, 1, 3).getValues()[0];
        if (v[2] || !v[0]) return;            // deleted / no thumbnail stored
        out[id] = v[0]; put['th:' + id] = String(v[0]);
      });
    }
    if (Object.keys(put).length) cache.putAll(put, 21600);
  }
  return { ok: true, thumbs: out };
}

// ---- live locations, backup channel (the app also uses public MQTT brokers; this keeps working if they fail).
// Positions live only in the script cache (fast, expire by themselves) and are end-to-end encrypted by the
// app — this script only ever sees ciphertext. msg '' = that person stopped sharing.
function loc(req) {
  const topic = clean(req.topic).slice(0, 80);
  if (!topic) return { ok: false, error: 'no topic' };
  const cache = CacheService.getScriptCache(), t = Date.now(), ik = 'li:' + topic, mk = function (id) { return 'lm:' + topic + ':' + id; };
  const readIdx = function () { try { return JSON.parse(cache.get(ik) || '[]'); } catch (e) { return []; } };
  let idx = readIdx();
  const me = req.id ? clean(req.id).slice(0, 40) : '';
  if (me && typeof req.msg === 'string' && req.msg.length < 4000) {
    cache.put(mk(me), JSON.stringify({ m: req.msg, t: t }), 21600);
    if (idx.indexOf(me) < 0) {              // a phone new to the index (if two join at the same instant, the
      idx.push(me);                         // one overwritten adds itself again on its next post)
      cache.put(ik, JSON.stringify(idx.slice(-400)), 21600);
    } else if (Math.random() < 0.02) cache.put(ik, JSON.stringify(idx), 21600);   // keep the index alive
  }
  const vals = idx.length ? cache.getAll(idx.map(mk)) : {}, locs = [];
  idx.forEach(function (id) {
    const raw = vals[mk(id)]; if (!raw) return;
    try { const v = JSON.parse(raw); if (t - v.t < 6 * 3600 * 1000) locs.push({ id: id, m: v.m, age: t - v.t }); } catch (e) {}
  });
  return { ok: true, now: t, rev: cache.get('rev') || '', locs: locs };
}

// ---- recovery (run from the editor): if the records sheet was swapped for an empty one, go back to the sheet that
// holds the work, copy in whatever was saved to the other one meanwhile, and make every phone pull everything
// again. Nothing is deleted: the other sheet is only renamed.
function restoreRecordsSheet() {
  const sheets = recordsSheetsInRoot();
  if (!sheets.length) throw new Error('no records sheet in ' + root().getName());
  const main = sheets[0], t = now();
  let copied = 0;
  sheets.slice(1).forEach(function (s) {
    ['records', 'photos'].forEach(function (name) {
      const from = s.getSheetByName(name), to = main.getSheetByName(name);
      if (!from || !to || from.getLastRow() < 2) return;
      const have = columnMap(to), w = name === 'records' ? 6 : PHOTO_COLS.length;
      from.getRange(2, 1, from.getLastRow() - 1, w).getValues().forEach(function (v) {
        const row = have[v[0]];
        if (!row) { to.appendRow(v); copied++; return; }
        const cur = to.getRange(row, 1, 1, w).getValues()[0];
        const newer = name === 'records' ? String(v[2]) > String(cur[2]) : !cur[1] && v[1];     // newer record / original that only it has
        if (newer) { to.getRange(row, 1, 1, w).setValues([v]); copied++; }
      });
    });
    DriveApp.getFileById(s.getId()).setName('(فارغ — انضاف للأصلي ' + t.slice(0, 10) + ') ' + s.getName());   // no longer starts with «سجل الرصد»
  });
  // every phone pulls everything again (also the ones that synced against the empty sheet)
  [['records', 5], ['photos', 6]].forEach(function (x) {
    const sh = main.getSheetByName(x[0]), n = sh.getLastRow();
    if (n > 1) sh.getRange(2, x[1], n - 1, 1).setValue(t);
  });
  setProp('SHEET', main.getId());
  CacheService.getScriptCache().removeAll(['p:SHEET']);
  bump();
  Logger.log('restored: ' + main.getName() + ' ' + main.getUrl() + ' · ' + main._rows + ' rows · ' + copied + ' rows copied from ' + (sheets.length - 1) + ' other sheet(s)');
  return 'ok';
}

// ---- fresh start for a new survey (run from the editor). Nothing is deleted: the current folder (photos, sheet,
// backups) is renamed as an archive, the app gets a new empty folder + sheet, and every phone drops its data from
// before this moment the next time it syncs (EPOCH).
function resetForNewSurvey() {
  const p = props(), old = root(), day = now().slice(0, 10);
  old.setName(ROOT_NAME + ' — أرشيف التجربة قبل ' + day);
  const gone = ['ROOT', 'SHEET', 'PHOTOS', 'PREVIEWS', 'BACKUPS', 'BACKUP_DAY'];
  Object.keys(p.getProperties()).forEach(function (k) { if (k.indexOf('DIR_') === 0) gone.push(k); });
  gone.forEach(function (k) { p.deleteProperty(k); });
  CacheService.getScriptCache().removeAll(gone.map(function (k) { return 'p2:' + k; }).concat(gone.map(function (k) { return 'p:' + k; })));
  setProp('EPOCH', 'E' + Date.now());
  // the site team's shared live positions too
  const h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'ssm-topic:RUSAFAMAPS', Utilities.Charset.UTF_8);
  const hex = h.slice(0, 12).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  CacheService.getScriptCache().removeAll(['loc:ssm-rusafa/' + hex, 'li:ssm-rusafa/' + hex, 'rev']);
  const ss = book();
  Logger.log('archived: ' + old.getName() + ' · new folder: ' + root().getUrl() + ' · new sheet: ' + ss.getUrl() + ' · topic ' + hex);
  return 'ok';
}

// ---- setup (run from the editor): creates folder + sheet; with OPEN_ACCESS = false also a key + join link
function setup() {
  const ss = book(), dir = root(); photosFolder();
  let sh = ss.getSheetByName('الإعداد'); if (!sh) sh = ss.insertSheet('الإعداد');
  sh.clear();
  const rows = [['مجلد الرصد: ' + dir.getUrl()], ['التطبيق: ' + APP_URL]];
  if (OPEN_ACCESS) {
    rows.push(['الوضع: مفتوح — أي واحد يفتح التطبيق يرفع ويشوف صور الفريق تلقائياً.']);
  } else {
    const p = props();
    if (!p.getProperty('SYNC_KEY')) p.setProperty('SYNC_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12));
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(WEBAPP_URL)) throw new Error('الصق رابط الـ Web app (ينتهي بـ /exec) بـ WEBAPP_URL فوق');
    rows.push(['رابط الانضمام (بيه كلمة السر — للفريق بس):'], [APP_URL + '#cloud=' + encodeURIComponent(WEBAPP_URL) + '~' + p.getProperty('SYNC_KEY')]);
  }
  sh.getRange(1, 1, rows.length, 1).setValues(rows); sh.setColumnWidth(1, 900);
  Logger.log('FOLDER: ' + dir.getUrl()); Logger.log('SHEET: ' + ss.getUrl());
}
function rotateKey() { props().deleteProperty('SYNC_KEY'); return setup(); }
