/**
 * Team cloud for «مسح السايت» (https://mhmdtaqi.me/maps) — free, runs in your own Google account.
 *
 * Photos go to a Google Drive folder, survey records to a Google Sheet in the same folder.
 * Setup (once, ~3 minutes):
 *   1. https://script.google.com → New project → paste this whole file.
 *   2. Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy
 *      → authorise with your Google account.
 *   3. Select the function `setup` → Run. It creates the Drive folder + sheet and a random secret key,
 *      and writes the team JOIN LINK into the sheet's «الإعداد» tab (and the execution log).
 *   4. Open the join link on your phone and send it to the team — the app configures itself.
 * Nothing is public: requests without the key are refused, and the photos stay private in your Drive
 * (the app fetches them through this script). Run `rotateKey` to revoke access and get a new link.
 */
const APP_URL = 'https://mhmdtaqi.me/maps/';
const ROOT_NAME = 'مسح السايت — الرصافة القديمة';
const MAX_CELL = 45000;                             // Sheets cell limit is 50,000 characters

function doGet() { return out({ ok: true, service: 'site-survey-cloud', version: 1 }); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad request' }); }
  const k = props().getProperty('SYNC_KEY');
  if (!req || !k || req.key !== k) return out({ ok: false, error: 'bad key' });
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
function folderFor(owner) {             // one sub-folder per building / record, e.g. "HP20 خان مرجان"
  const name = String(owner || 'بدون مبنى').slice(0, 80), cache = CacheService.getScriptCache(), k = 'dir:' + name;
  const hit = cache.get(k);
  if (hit) { try { return DriveApp.getFolderById(hit); } catch (e) {} }
  const parent = photosFolder(), it = parent.getFoldersByName(name);
  const f = it.hasNext() ? it.next() : parent.createFolder(name);
  cache.put(k, f.getId(), 21600); return f;
}
function book() {
  const id = props().getProperty('SHEET');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  const ss = SpreadsheetApp.create('سجل الرصد — ' + ROOT_NAME);
  DriveApp.getFileById(ss.getId()).moveTo(root());
  const r = ss.getSheets()[0]; r.setName('records'); r.appendRow(['id', 'store', 'updated', 'device', 'synced', 'json']); r.setFrozenRows(1);
  const p = ss.insertSheet('photos'); p.appendRow(['photoId', 'fileId', 'owner', 'created', 'device', 'synced', 'bytes']); p.setFrozenRows(1);
  props().setProperty('SHEET', ss.getId()); return ss;
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
  return { ok: true, folder: root().getUrl(), sheet: ss.getUrl(), photos: photos, records: records,
           used: DriveApp.getStorageUsed(), limit: DriveApp.getStorageLimit(), now: now() };
}

// ---- photos: idempotent upload (same photoId twice = same file)
function putPhoto(req) {
  if (!req.id || !req.data) return { ok: false, error: 'missing photo' };
  const sh = book().getSheetByName('photos');
  const found = sh.getRange('A:A').createTextFinder(req.id).matchEntireCell(true).findNext();
  if (found) return { ok: true, fileId: sh.getRange(found.getRow(), 2).getValue(), existed: true };
  const mime = req.mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), mime, req.id + (mime === 'image/webp' ? '.webp' : '.jpg'));
  const file = folderFor(req.owner).createFile(blob);
  file.setDescription(JSON.stringify(req.meta || {}));
  withLock(() => sh.appendRow([req.id, file.getId(), req.owner || '', (req.meta && req.meta.created) || '', req.device || '', now(), blob.getBytes().length]));
  return { ok: true, fileId: file.getId() };
}
function getPhoto(req) {
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
  (req.records || []).forEach(function (r) {
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
  if (m > 1) phSh.getRange(2, 1, m - 1, 6).getValues().forEach(function (v) {
    if (String(v[5]) > since) photos.push({ id: v[0], fileId: v[1], owner: v[2], created: v[3], device: v[4] });
  });
  return { ok: true, records: records, photos: photos, now: t };
}

// ---- setup: random key + join link (run from the editor after deploying)
function setup() {
  const p = props();
  if (!p.getProperty('SYNC_KEY')) p.setProperty('SYNC_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12));
  const ss = book(); root();
  const url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('انشر السكربت أول: Deploy → New deployment → Web app');
  const link = APP_URL + '#cloud=' + encodeURIComponent(url) + '~' + p.getProperty('SYNC_KEY');
  let sh = ss.getSheetByName('الإعداد'); if (!sh) sh = ss.insertSheet('الإعداد');
  sh.clear();
  sh.getRange(1, 1, 4, 1).setValues([['رابط الانضمام للمزامنة — افتحه بالتلفون ودزّه للفريق بس (بيه كلمة السر):'], [link], ['المجلد: ' + root().getUrl()], ['لإلغاء الوصول القديم: شغّل rotateKey من السكربت وخذ الرابط الجديد من هنا.']]);
  sh.setColumnWidth(1, 900);
  Logger.log('JOIN LINK: ' + link);
  Logger.log('SHEET: ' + ss.getUrl());
  return link;
}
function rotateKey() { props().deleteProperty('SYNC_KEY'); return setup(); }
