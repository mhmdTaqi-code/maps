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
 * Protections either way: only images, max size per photo, a daily cap per device, and reads are limited
 * to the survey photos this script stored (nothing else in your Drive can be fetched).
 * For a password instead, set OPEN_ACCESS = false and run `setup` (creates a key + join link).
 */
const OPEN_ACCESS = true;
const APP_URL = 'https://mhmdtaqi.me/maps/';
const WEBAPP_URL = '';                                // only needed for the join link when OPEN_ACCESS = false
const ROOT_NAME = 'مسح السايت — الرصافة القديمة';
const MAX_CELL = 45000;                             // Sheets cell limit is 50,000 characters
const MAX_PHOTO_B64 = 6 * 1024 * 1024;               // ≈ 4.5 MB per photo (the app sends ≈ 0.3 MB)
const DAILY_PHOTOS_PER_DEVICE = 1500;
const PHOTO_COLS = ['photoId', 'fileId', 'owner', 'created', 'device', 'synced', 'bytes', 'observer', 'lat', 'lng', 'link', 'name'];

function doGet() { return out({ ok: true, service: 'site-survey-cloud', version: 2, open: OPEN_ACCESS }); }

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
      case 'putPhoto': return out(putPhoto(req));
      case 'getPhoto': return out(getPhoto(req));
      case 'putRecords': return out(withLock(() => putRecords(req)));
      case 'pull': return out(pull(req));
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

// ---- photos: idempotent upload (same photoId twice = same file)
function putPhoto(req) {
  if (!req.id || !req.data) return { ok: false, error: 'missing photo' };
  if (String(req.data).length > MAX_PHOTO_B64) return { ok: false, error: 'photo too large' };
  const sh = book().getSheetByName('photos');
  const found = sh.getRange('A:A').createTextFinder(String(req.id)).matchEntireCell(true).findNext();
  if (found) return { ok: true, fileId: sh.getRange(found.getRow(), 2).getValue(), existed: true };
  // daily cap per device so a runaway phone (or a stranger) cannot fill the Drive
  const day = now().slice(0, 10), cache = CacheService.getScriptCache(), qk = 'q:' + clean(req.device).slice(0, 40) + ':' + day;
  const used = Number(cache.get(qk) || 0);
  if (used >= DAILY_PHOTOS_PER_DEVICE) return { ok: false, error: 'daily limit reached' };
  const mime = req.mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const bytes = Utilities.base64Decode(req.data);
  const m = req.meta || {}, when = String(m.created || now()).slice(0, 16).replace('T', '_').replace(':', '');
  const fname = clean(`${when}_${m.observer || 'مجهول'}_${req.id}`) + (mime === 'image/webp' ? '.webp' : '.jpg');
  const file = folderFor(req.ownerId || req.owner, req.ownerName).createFile(Utilities.newBlob(bytes, mime, fname));
  file.setDescription(JSON.stringify(m));
  withLock(() => sh.appendRow([req.id, file.getId(), clean(req.ownerName || req.owner), m.created || '', req.device || '', now(), bytes.length,
                               clean(m.observer), m.lat || '', m.lng || '', file.getUrl(), clean(m.name)]));
  cache.put(qk, String(used + 1), 90000);
  return { ok: true, fileId: file.getId() };
}
// only files this script stored as survey photos can be read back
function getPhoto(req) {
  const sh = book().getSheetByName('photos');
  if (!req.fileId || !sh.getRange('B:B').createTextFinder(String(req.fileId)).matchEntireCell(true).findNext()) return { ok: false, error: 'not a survey photo' };
  const f = DriveApp.getFileById(req.fileId);
  let blob = null;
  if (req.thumb) { try { blob = f.getThumbnail(); } catch (e) {} }
  if (!blob) blob = f.getBlob();
  return { ok: true, mime: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) };
}

// ---- records: newest `updated` wins; `synced` (server clock) drives incremental pulls
function putRecords(req) {
  const sh = book().getSheetByName('records'), rows = columnMap(sh), t = now();
  let written = 0;
  (req.records || []).slice(0, 100).forEach(function (r) {
    if (!r || !r.id) return;
    let json = JSON.stringify(r.data);
    if (json.length > MAX_CELL) {      // very long GPS tracks: keep the record in a Drive file
      const f = root().createFile(r.id + '.json', json, 'application/json');
      json = JSON.stringify({ __file: f.getId() });
    }
    const row = rows[r.id];
    if (row) {
      const cur = sh.getRange(row, 3).getValue();
      if (String(cur) >= String(r.updated || '')) return;
      sh.getRange(row, 2, 1, 5).setValues([[r.store, r.updated || '', req.device || '', t, json]]);
    } else {
      sh.appendRow([r.id, r.store, r.updated || '', req.device || '', t, json]);
      rows[r.id] = sh.getLastRow();
    }
    written++;
  });
  return { ok: true, written: written, now: t };
}
function pull(req) {
  const ss = book(), since = String(req.since || ''), t = now();
  const recSh = ss.getSheetByName('records'), n = recSh.getLastRow(), records = [];
  if (n > 1) recSh.getRange(2, 1, n - 1, 6).getValues().forEach(function (v) {
    if (String(v[4]) <= since) return;
    let data = JSON.parse(v[5]);
    if (data && data.__file) data = JSON.parse(DriveApp.getFileById(data.__file).getBlob().getDataAsString());
    records.push({ id: v[0], store: v[1], updated: v[2], device: v[3], data: data });
  });
  const phSh = ss.getSheetByName('photos'), m = phSh.getLastRow(), photos = [];
  if (m > 1) phSh.getRange(2, 1, m - 1, PHOTO_COLS.length).getValues().forEach(function (v) {
    if (String(v[5]) > since) photos.push({ id: v[0], fileId: v[1], owner: v[2], created: v[3], device: v[4], observer: v[7] });
  });
  return { ok: true, records: records, photos: photos, now: t };
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
