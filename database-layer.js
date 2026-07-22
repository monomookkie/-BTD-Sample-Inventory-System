/**
 * ════════════════════════════════════════════════════════════════════════
 * BTD SAMPLE INVENTORY — DATABASE / DATA ACCESS LAYER
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS FILE IS
 * -------------------------------------------------
 * This is the ONLY file that talks to storage (browser localStorage and/or
 * Google Sheets). Every other part of the app — the UI, the rendering, the
 * forms, the report page — never touches localStorage or fetch() directly.
 * It only calls the functions exported here.
 *
 * This separation means: if you want to swap Google Sheets for a real
 * database (Firebase, Supabase, MySQL, a custom REST API, whatever), you
 * edit THIS FILE ONLY. Nothing in the HTML/UI code needs to change, because
 * the UI only ever calls things like DB.getSamples() and DB.saveSample(...),
 * never localStorage.getItem(...) or fetch(...) directly.
 *
 * HOW THE APP IS WIRED TOGETHER
 * -------------------------------------------------
 *   frontend (btd-sample-inventory.html)
 *        │
 *        │  calls DB.xxx() functions only
 *        ▼
 *   database-layer.js   <-- YOU ARE HERE
 *        │
 *        │  currently: localStorage (always) + Google Sheets (optional sync)
 *        ▼
 *   GOOGLE_APPS_SCRIPT.gs  (deployed separately to script.google.com)
 *        │
 *        ▼
 *   Google Sheet (the actual spreadsheet/database)
 *
 * CURRENT BEHAVIOR (out of the box)
 * -------------------------------------------------
 * - All reads/writes go to the browser's localStorage FIRST. This means the
 *   app always works, even with zero configuration, even offline.
 * - If WEB_APP_URL below is configured, every write is ALSO sent to Google
 *   Sheets in the background (fire-and-forget — never blocks the UI), and on
 *   startup the app tries to pull the latest data from Sheets to overwrite
 *   what's in localStorage, so multiple devices/browsers can stay in sync.
 * - If Sheets is unreachable (not configured, CORS error, network down),
 *   the app silently keeps using localStorage. It never crashes because of
 *   a database problem.
 *
 * HOW TO CONNECT A DIFFERENT DATABASE
 * -------------------------------------------------
 * Every function below that's exported on the `DB` object follows this
 * shape: read the in-memory array, call out to remote storage, return.
 * To point at a different backend:
 *   1. Replace the body of `remoteFetchAll()` to call YOUR backend's "get
 *      everything" endpoint instead of the Apps Script ?action=getAll URL.
 *   2. Replace the body of `remoteSync(action, payload)` to call YOUR
 *      backend's write endpoint instead of the Apps Script POST.
 *   3. Leave everything else in this file alone — the localStorage caching,
 *      the public DB.* functions, and all the safety fallbacks stay the same.
 * The rest of the app (UI) requires zero changes either way.
 */

// ═══════════════════════════════════════════════════════════════════════
// CONFIG — connect your backend here
// ═══════════════════════════════════════════════════════════════════════
//
// Google Sheets setup (current default backend):
//   1. Open https://script.google.com → New Project → paste the code from
//      the accompanying GOOGLE_APPS_SCRIPT.gs file.
//   2. Deploy → New deployment → type "Web app" → Execute as "Me" →
//      Who has access "Anyone" → Deploy.
//   3. Copy the generated Web App URL and paste it below.
// Leaving this as the placeholder value means the app runs on localStorage
// only — fully functional, just not synced across devices/browsers.
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyMT2UzujjYdnD3Yl6hDyjQdncdhThLfHkS4UTgLijWBQBhNXUDHa4hR9VUJud_74jG/exec';

const REMOTE_CONFIGURED = WEB_APP_URL && WEB_APP_URL !== 'YOUR_APPS_SCRIPT_URL';

// localStorage key names — change these only if you need to namespace
// multiple installations of this app in the same browser.
const STORAGE_KEYS = {
  samples: "btd_samples",
  templates: "btd_tpls",
  currentUser: "btd_cu",
  users: "btd_users",
  logs: "btd_logs",
};

// ═══════════════════════════════════════════════════════════════════════
// LOCAL STORAGE PRIMITIVES (the localStorage half of the data layer)
// ═══════════════════════════════════════════════════════════════════════

/** Reads a JSON value from localStorage, or returns `fallback` if missing/corrupt/unavailable. */
function localRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** Writes a JSON value to localStorage. Fails silently if storage is unavailable
 *  (private/incognito browsing, file:// restrictions, quota exceeded, etc.) —
 *  callers that need to know whether it actually worked should use
 *  DB.isStorageWorking() / DB.checkStorageWorks() rather than trusting this blindly. */
function localWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Reads a JSON value from sessionStorage, or returns `fallback` if missing/corrupt/unavailable.
 *  sessionStorage persists across a page refresh but clears when the tab/browser is closed —
 *  used only for the current-user session, so "stay signed in on refresh, but sign in again
 *  after closing the tab" works as expected. */
function sessionRead(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** Writes a JSON value to sessionStorage. Fails silently if storage is unavailable. */
function sessionWrite(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** True once we've confirmed this browser can actually persist data. Some browsers/contexts
 *  block localStorage entirely (file:// pages in some browsers, private/incognito mode). */
function checkStorageWorks() {
  try {
    const testKey = "__btd_storage_test__";
    localStorage.setItem(testKey, "1");
    const ok = localStorage.getItem(testKey) === "1";
    localStorage.removeItem(testKey);
    return ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// REMOTE BACKEND PRIMITIVES (the Google Sheets / database half)
// To swap backends, only these two functions need to change.
// ═══════════════════════════════════════════════════════════════════════

/** Last error message from the remote backend, if any — surfaced to admins via the Users page. */
let lastRemoteError = null;

/** Fire-and-forget write to the remote backend. Never blocks the UI; failures are logged
 *  but never thrown, because a database hiccup must never break the app for the person using it. */
function remoteSync(action, payload) {
  if (!REMOTE_CONFIGURED) return; // not configured, skip silently
  fetch('/api/proxy-sheets', {
    method: 'POST',
    // Apps Script web apps deployed with "Anyone" access already send back
    // Access-Control-Allow-Origin, so a normal 'cors' request (the default) works fine here —
    // no need for 'no-cors'. Using 'no-cors' would make the response opaque/unreadable, which
    // is fine for fire-and-forget writes but breaks anything that needs to read a real answer.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload, ts: new Date().toISOString() }),
  }).catch(err => console.warn('Remote sync failed (non-blocking):', err));
}

/** Sends an action to the remote backend and returns its parsed JSON response (or null on any
 *  failure). Unlike remoteSync, this AWAITS and reads the actual response — needed for actions
 *  where the UI must know whether the server-side step (e.g. "was this email found and sent?")
 *  actually succeeded, rather than optimistically assuming success. */
async function remoteAction(action, payload) {
  if (!REMOTE_CONFIGURED) return null;
try {
  const res = await fetch('/api/proxy-sheets', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action, payload, ts: new Date().toISOString() }),
});
    const data = await res.json();
    lastRemoteError = data.error || null;
    return data;
} catch (err) {
    lastRemoteError = (err && err.message) ? err.message : String(err);
    console.warn('Remote action failed:', err);
    return null;
  }
}

/** Pulls the full dataset (samples/templates/users/logs) from the remote backend.
 *  Returns true on success (and updates the in-memory + localStorage copies), false on any
 *  failure. Never throws — a broken/misconfigured backend must never prevent the app from
 *  working off whatever's already cached in localStorage. */
async function remoteFetchAll() {
  if (!REMOTE_CONFIGURED) return false;
  try {
   const res = await fetch('/api/proxy-sheets', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action, payload, ts: new Date().toISOString() }),
});

    const data = await res.json();
    
    if (data.error) {
      lastRemoteError = data.error;
      console.warn('Remote backend returned an error:', data.error);
      return false;
    }

    if (data.samples) _cache.samples = data.samples;
    if (data.templates) _cache.templates = data.templates;
    if (data.users) _cache.users = data.users;
    if (data.logs) _cache.logs = data.logs;

    localWrite(STORAGE_KEYS.samples, _cache.samples);
    localWrite(STORAGE_KEYS.templates, _cache.templates);
    localWrite(STORAGE_KEYS.users, _cache.users);
    localWrite(STORAGE_KEYS.logs, _cache.logs);
    
    lastRemoteError = null;
    return true;
  } catch (err) {
    lastRemoteError = (err && err.message) ? err.message : String(err);
    console.warn('Remote fetch failed:', err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE
// The UI reads/writes these arrays directly for performance & simplicity;
// every mutation below also persists to localStorage (and remote, where
// applicable) so nothing is ever lost.
// ═══════════════════════════════════════════════════════════════════════
const _cache = {
  samples: localRead(STORAGE_KEYS.samples, []),
  templates: localRead(STORAGE_KEYS.templates, []),
  users: localRead(STORAGE_KEYS.users, []),
  logs: localRead(STORAGE_KEYS.logs, []),
  currentUser: sessionRead(STORAGE_KEYS.currentUser, null),
};

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC DATA ACCESS API
// This is what the frontend calls. Everything above this line is private
// implementation detail that the UI never needs to know about.
// ═══════════════════════════════════════════════════════════════════════
const DB = {

  // ─── Bootstrapping ───────────────────────────────────────────────────

  /** Call once on app startup. Tries to refresh from the remote backend (if configured),
   *  then returns whether localStorage itself is usable in this browser. */
  async init() {
    const storageOk = checkStorageWorks();
    await remoteFetchAll();
    return storageOk;
  },

  isRemoteConfigured() { return REMOTE_CONFIGURED; },
  getLastRemoteError() { return lastRemoteError; },

  // ─── Samples ─────────────────────────────────────────────────────────

  getSamples() { return _cache.samples; },
  setSamples(next) { _cache.samples = next; localWrite(STORAGE_KEYS.samples, next); },

  /** Persists a newly-created batch of samples and its log entry, and syncs to remote. */
  addSampleBatch(newSamples, logEntry, remotePayload) {
    _cache.samples = [...newSamples, ..._cache.samples];
    _cache.logs = [logEntry, ..._cache.logs];
    localWrite(STORAGE_KEYS.samples, _cache.samples);
    localWrite(STORAGE_KEYS.logs, _cache.logs);
    remoteSync("addSampleBatch", remotePayload);
  },

  /** Updates a single sample in place (e.g. editing type/dates) and persists. */
  updateSample(id, patch) {
    _cache.samples = _cache.samples.map(s => s.id === id ? { ...s, ...patch } : s);
    localWrite(STORAGE_KEYS.samples, _cache.samples);
  },

  /** Marks a sample discarded and syncs the action to remote. */
  discardSample(id, discardInfo, remotePayload) {
    _cache.samples = _cache.samples.map(s => s.id === id ? { ...s, ...discardInfo } : s);
    localWrite(STORAGE_KEYS.samples, _cache.samples);
    remoteSync("discardSample", remotePayload);
  },

  /** Permanently removes a sample (used rarely; most discards just get hidden after the retention window). */
  deleteSample(id, remotePayload) {
    _cache.samples = _cache.samples.filter(s => s.id !== id);
    localWrite(STORAGE_KEYS.samples, _cache.samples);
    if (remotePayload) remoteSync("permanentDelete", remotePayload);
  },

  // ─── Templates ───────────────────────────────────────────────────────

  getTemplates() { return _cache.templates; },
  setTemplates(next) { _cache.templates = next; localWrite(STORAGE_KEYS.templates, next); },

  /** Persists a template (create or update) and syncs it to remote — this was previously
   *  local-only, which is why saved templates never reached Google Sheets. */
  saveTemplate(tpl, isNew) {
    _cache.templates = isNew ? [..._cache.templates, tpl] : _cache.templates.map(t => t.id === tpl.id ? tpl : t);
    localWrite(STORAGE_KEYS.templates, _cache.templates);
    remoteSync("saveTemplate", { template: tpl, isNew: !!isNew });
  },

  deleteTemplate(id, remotePayload) {
    _cache.templates = _cache.templates.filter(t => t.id !== id);
    localWrite(STORAGE_KEYS.templates, _cache.templates);
    remoteSync("deleteTemplate", remotePayload || { id });
  },

  // ─── Users ───────────────────────────────────────────────────────────

  getUsers() { return _cache.users; },
  setUsers(next) { _cache.users = next; localWrite(STORAGE_KEYS.users, next); },

  /** Registers a new user (Sign Up, or the first-time admin setup) and syncs to remote. */
  addUser(user, remotePayload) {
    _cache.users = [..._cache.users, user];
    localWrite(STORAGE_KEYS.users, _cache.users);
    remoteSync("registerUser", remotePayload);
  },

  /** Replaces the entire user list (used by the first-admin-setup flow, which resets to one account). */
  replaceUsers(users, remotePayload) {
    _cache.users = users;
    localWrite(STORAGE_KEYS.users, _cache.users);
    if (remotePayload) remoteSync("registerUser", remotePayload);
  },

  updateUserRole(id, role, remotePayload) {
    _cache.users = _cache.users.map(u => u.id === id ? { ...u, role } : u);
    localWrite(STORAGE_KEYS.users, _cache.users);
    remoteSync("updateUserRole", remotePayload);
  },

  deleteUser(id, remotePayload) {
    _cache.users = _cache.users.filter(u => u.id !== id);
    localWrite(STORAGE_KEYS.users, _cache.users);
    remoteSync("deleteUser", remotePayload);
  },

  /** Asks the backend to generate a new password for this email and send it out by email.
   *  Unlike the other methods here, this genuinely needs the server's answer (found the user?
   *  did the email send?) before the UI can tell the person what happened — so it awaits
   *  remoteAction() instead of firing-and-forgetting. Returns the parsed response, or null if
   *  the backend is unreachable/not configured. */
  async forgotPassword(email) {
    if (!REMOTE_CONFIGURED) return null;
    return remoteAction("forgotPassword", { email });
  },

  // ─── Logs (batch-creation history, for the Report page) ─────────────

  getLogs() { return _cache.logs; },
  setLogs(next) { _cache.logs = next; localWrite(STORAGE_KEYS.logs, next); },

  // ─── Session / current user ──────────────────────────────────────────

  getCurrentUser() { return _cache.currentUser; },
  setCurrentUser(user) { _cache.currentUser = user; sessionWrite(STORAGE_KEYS.currentUser, user); },
  clearCurrentUser() { _cache.currentUser = null; sessionWrite(STORAGE_KEYS.currentUser, null); },
};
