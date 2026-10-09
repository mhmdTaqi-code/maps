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
const PHOTO_COLS = ['photoId', 'fileId', 'owner', 'created', 'device', 'synced', 'bytes', 'observer', 'lat', 'lng', 'link', 'name', 'thumb', 'previewId'];
const MAX_THUMB_B64 = 45000;

function doGet() { return out({ ok: true, service: 'site-survey-cloud', version: 6, open: OPEN_ACCESS }); }

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
      case 'putRecords': return out(withLock(() => putRecords(req)));
      case 'pull': return out(pull(req));
      case 'loc': return out(loc(req));
      case 'epoch': return out({ ok: true, epoch: props().getProperty('EPOCH') || '' });
      default: return out({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
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
function root() {
  const id = props().getProperty('ROOT');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder(ROOT_NAME); props().setProperty('ROOT', f.getId()); return f;
}
function photosFolder() {
  const id = props().getProperty('PHOTOS');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = root().createFolder('الصور'); props().setProperty('PHOTOS', f.getId()); return f;
}
// one sub-folder per building / record, keyed by its id so a later rename keeps the same folder:
// "HP20 — خان مرجان الاثري", "F7k2… — مدخل الخان"
function previewsFolder() {
  const id = props().getProperty('PREVIEWS');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = root().createFolder('معاينات (للتطبيق)'); props().setProperty('PREVIEWS', f.getId()); return f;
}
function photoRow(sh, id) {
  const hit = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}
function folderFor(ownerId, ownerName) {
  const id = clean(ownerId) || 'بدون-مبنى', name = clean(ownerName ? `${id} — ${ownerName}` : id).slice(0, 100);
  const p = props(), key = 'DIR_' + id.slice(0, 60);
  const known = p.getProperty(key);
  if (known) {
    try { const f = DriveApp.getFolderById(known); if (f.getName() !== name) f.setName(name); return f; } catch (e) {}
  }
  const f = photosFolder().createFolder(name);
  p.setProperty(key, f.getId()); return f;
}
function book() {
  const id = props().getProperty('SHEET');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) {
    ss = SpreadsheetApp.create('سجل الرصد — ' + ROOT_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(root());
    const r = ss.getSheets()[0]; r.setName('records'); r.appendRow(['id', 'store', 'updated', 'device', 'synced', 'json']); r.setFrozenRows(1);
    ss.insertSheet('photos');
    props().setProperty('SHEET', ss.getId());
  }
  const ph = ss.getSheetByName('photos') || ss.insertSheet('photos');
  if (ph.getRange(1, PHOTO_COLS.length).getValue() !== PHOTO_COLS[PHOTO_COLS.length - 1]) {   // header (v1 had fewer columns)
    ph.getRange(1, 1, 1, PHOTO_COLS.length).setValues([PHOTO_COLS]); ph.setFrozenRows(1);
  }
  return ss;
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
  return withLock(() => {
    const row = photoRow(sh, req.id);
    if (row) { sh.getRange(row, 13).setValue(req.thumb); sh.getRange(row, 6).setValue(now()); }
    else sh.appendRow([req.id, '', clean(req.ownerName || req.owner), m.created || '', req.device || '', now(), '', clean(m.observer), m.lat || '', m.lng || '', '', clean(m.name), req.thumb, '']);
    bump();
    return { ok: true };
  });
}

// ---- photos: idempotent upload (same photoId twice = same file)
function putPhoto(req) {
  if (!req.id || !req.data) return { ok: false, error: 'missing photo' };
  if (String(req.data).length > MAX_PHOTO_B64) return { ok: false, error: 'photo too large (max ≈ 35 MB)' };
  const sh = book().getSheetByName('photos');
  const existing = photoRow(sh, req.id);
  if (existing) {
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
    const vals = [req.id, file.getId(), clean(req.ownerName || req.owner), m.created || '', req.device || '', now(), bytes.length,
                  clean(m.observer), m.lat || '', m.lng || '', file.getUrl(), clean(m.name), row ? sh.getRange(row, 13).getValue() : (req.thumb || ''), previewId];
    if (row) sh.getRange(row, 1, 1, vals.length).setValues([vals]); else sh.appendRow(vals);
  });
  cache.put(qk, String(used + 1), 90000);
  bump();
  return { ok: true, fileId: file.getId() };
}
// only files this script stored as survey photos can be read back.
// size: 'thumb' (stored base64 or Drive thumbnail), 'preview' (1600 px copy; small originals as-is), 'full'
function getPhoto(req) {
  const sh = book().getSheetByName('photos');
  const hit = req.fileId && sh.getRange('B:B').createTextFinder(String(req.fileId)).matchEntireCell(true).findNext();
  if (!hit) return { ok: false, error: 'not a survey photo' };
  const row = hit.getRow(), size = req.size || (req.thumb ? 'thumb' : 'full');
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
  const sh = book().getSheetByName('records'), rows = columnMap(sh), t = now();
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
  (req.records || []).slice(0, 100).forEach(function (r) {
    if (!r || !r.id) return;
    const row = rows[r.id], photos = r.store === 'features' || r.store === 'heritage';
    if (row) {
      // keep the version being replaced (edits and deletions can always be undone from «history»)
      const old = sh.getRange(row, 1, 1, 6).getValues()[0], cur = old[2];
      const oldData = photos ? readJson(old[5]) : null;
      if (String(cur) >= String(r.updated || '')) {
        // an older edit: the newer record stays, but the photos the older one added are never lost
        if (!oldData || !mergePhotoLists(oldData, r.data)) return;
        keep(old);
        sh.getRange(row, 5, 1, 2).setValues([[t, encode(oldData, r.id)]]);
      } else {
        if (oldData) mergePhotoLists(r.data, oldData);
        keep(old);
        sh.getRange(row, 2, 1, 5).setValues([[r.store, r.updated || '', req.device || '', t, encode(r.data, r.id)]]);
      }
    } else {
      sh.appendRow([r.id, r.store, r.updated || '', req.device || '', t, encode(r.data, r.id)]);
      rows[r.id] = sh.getLastRow();
    }
    written++;
  });
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
  if (p.getProperty('BACKUP_DAY') === day) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    if (p.getProperty('BACKUP_DAY') === day) return;
    let dir = null; const id = p.getProperty('BACKUPS');
    if (id) { try { dir = DriveApp.getFolderById(id); } catch (e) {} }
    if (!dir) { dir = root().createFolder('نسخ احتياطية (يومية)'); p.setProperty('BACKUPS', dir.getId()); }
    DriveApp.getFileById(ss.getId()).makeCopy('نسخة ' + day + ' — ' + ss.getName(), dir);
    p.setProperty('BACKUP_DAY', day);
  } catch (e) {} finally { lock.releaseLock(); }
}
function pull(req) {
  const ss = book(), since = String(req.since || ''), t = now();
  backupDaily(ss);
  const recSh = ss.getSheetByName('records'), n = recSh.getLastRow(), records = [];
  if (n > 1) recSh.getRange(2, 1, n - 1, 6).getValues().forEach(function (v) {
    if (String(v[4]) <= since) return;
    let data = JSON.parse(v[5]);
    if (data && data.__file) data = JSON.parse(DriveApp.getFileById(data.__file).getBlob().getDataAsString());
    records.push({ id: v[0], store: v[1], updated: v[2], device: v[3], data: data });
  });
  const phSh = ss.getSheetByName('photos'), m = phSh.getLastRow(), photos = [];
  if (m > 1) phSh.getRange(2, 1, m - 1, PHOTO_COLS.length).getValues().forEach(function (v) {
    if (String(v[5]) > since) photos.push({ id: v[0], fileId: v[1], owner: v[2], created: v[3], device: v[4], observer: v[7], thumb: v[12] || '' });
  });
  return { ok: true, records: records, photos: photos, now: t };
}

// ---- live locations, backup channel (the app also uses public MQTT brokers; this keeps working if they fail).
// Positions live only in the script cache (fast, expire by themselves) and are end-to-end encrypted by the
// app — this script only ever sees ciphertext. msg '' = that person stopped sharing.
function loc(req) {
  const topic = clean(req.topic).slice(0, 80);
  if (!topic) return { ok: false, error: 'no topic' };
  const cache = CacheService.getScriptCache(), key = 'loc:' + topic, t = Date.now();
  const read = () => { try { return JSON.parse(cache.get(key) || '{}'); } catch (e) { return {}; } };
  let all;
  if (req.id && typeof req.msg === 'string' && req.msg.length < 4000) {
    all = withLock(() => {
      const a = read();
      a[clean(req.id).slice(0, 40)] = { m: req.msg, t: t };
      for (const k in a) if (t - a[k].t > 6 * 3600 * 1000) delete a[k];
      cache.put(key, JSON.stringify(a), 21600);
      return a;
    });
  } else all = read();
  return { ok: true, now: t, rev: cache.get('rev') || '', locs: Object.keys(all).map(k => ({ id: k, m: all[k].m, age: t - all[k].t })) };
}

// ---- fresh start for a new survey (run from the editor). Nothing is deleted: the current folder (photos, sheet,
// backups) is renamed as an archive, the app gets a new empty folder + sheet, and every phone drops its data from
// before this moment the next time it syncs (EPOCH).
function resetForNewSurvey() {
  const p = props(), old = root(), day = now().slice(0, 10);
  old.setName(ROOT_NAME + ' — أرشيف التجربة قبل ' + day);
  ['ROOT', 'SHEET', 'PHOTOS', 'PREVIEWS', 'BACKUPS', 'BACKUP_DAY'].forEach(function (k) { p.deleteProperty(k); });
  Object.keys(p.getProperties()).forEach(function (k) { if (k.indexOf('DIR_') === 0) p.deleteProperty(k); });
  p.setProperty('EPOCH', 'E' + Date.now());
  // the site team's shared live positions too
  const h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'ssm-topic:RUSAFAMAPS', Utilities.Charset.UTF_8);
  const hex = h.slice(0, 12).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  CacheService.getScriptCache().removeAll(['loc:ssm-rusafa/' + hex, 'rev']);
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
