/**
 * Subb2 — Google Sheet backend (Apps Script web app)
 * =================================================================
 * This turns a normal Google Sheet into the backend for the reservation
 * form and the feedback box, so every signup lands as a spreadsheet row.
 *
 * SETUP (one time, ~3 minutes):
 *   1. Create a new Google Sheet (this is where signups will appear).
 *   2. In that sheet: Extensions → Apps Script.
 *   3. Delete the sample code, paste THIS whole file, and Save.
 *   4. Deploy → New deployment → type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Click Deploy, authorise, and COPY the "Web app URL" (ends in /exec).
 *   5. Give that URL to your dev / paste it when starting the server:
 *        SUBB2_SHEET_URL="https://script.google.com/macros/s/XXXX/exec" node serve.mjs
 *      (Two tabs, "Reservations" and "Feedback", are created automatically.)
 *
 * That URL is the ONLY thing you need to provide. Nothing else.
 */

var BASE_RESERVED = 57;                 // starting "reserved" count shown on the site
var RES_SHEET = 'Reservations';
var FB_SHEET  = 'Feedback';
var RES_HEADERS = ['timestamp','name','email','handle','social','phone','platform','community_size','about'];
var FB_HEADERS  = ['timestamp','name','email','rating','message'];

function sheetFor_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}
function normHandle_(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30); }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function reservedCount_() {
  var sh = sheetFor_(RES_SHEET, RES_HEADERS);
  return BASE_RESERVED + Math.max(0, sh.getLastRow() - 1);
}
function handleTaken_(handle) {
  var h = normHandle_(handle); if (!h) return false;
  var sh = sheetFor_(RES_SHEET, RES_HEADERS);
  var last = sh.getLastRow(); if (last < 2) return false;
  var vals = sh.getRange(2, 4, last - 1, 1).getValues(); // column 4 = handle
  for (var i = 0; i < vals.length; i++) { if (String(vals[i][0]).toLowerCase() === h) return true; }
  return false;
}
function emailTaken_(email) {
  var e = String(email || '').trim().toLowerCase(); if (!e) return false;
  var sh = sheetFor_(RES_SHEET, RES_HEADERS);
  var last = sh.getLastRow(); if (last < 2) return false;
  var vals = sh.getRange(2, 3, last - 1, 1).getValues(); // column 3 = email
  for (var i = 0; i < vals.length; i++) { if (String(vals[i][0]).trim().toLowerCase() === e) return true; }
  return false;
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'count';
  if (action === 'check') {
    if (e.parameter.email) {
      return json_({ emailAvailable: !emailTaken_(e.parameter.email) });
    }
    var h = normHandle_(e.parameter.handle);
    return json_({ available: h.length >= 3 && !handleTaken_(h), normalized: h });
  }
  return json_({ count: reservedCount_() });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  var action = body.action || 'reserve';

  if (action === 'feedback') {
    if (!String(body.message || '').trim()) return json_({ ok: false, error: 'Empty feedback.' });
    sheetFor_(FB_SHEET, FB_HEADERS).appendRow([new Date(), body.name || '', body.email || '', body.rating || '', body.message || '']);
    return json_({ ok: true });
  }

  // reserve
  var handle = normHandle_(body.handle);
  if (!String(body.name || '').trim() || !String(body.email || '').trim()) return json_({ ok: false, error: 'Name and email are required.' });
  if (handle && handle.length < 3) return json_({ ok: false, code: 'short', error: 'Username needs at least 3 characters.' });
  if (emailTaken_(body.email)) return json_({ ok: false, code: 'email', error: 'That email is already on the list.' });
  if (handle && handleTaken_(handle)) return json_({ ok: false, code: 'taken', error: 'That username is already taken.' });
  sheetFor_(RES_SHEET, RES_HEADERS).appendRow([
    new Date(), body.name, body.email, handle, body.social || '', body.phone || '', body.platform || '', body.size || '', body.about || ''
  ]);
  return json_({ ok: true, count: reservedCount_() });
}
