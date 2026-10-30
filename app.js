const APP_REVISION_V30 = "pga-crew-clock-v30-attendance-wording-20261030";
/* Crew Clock V30: durable, immutable outbox. No authentication credentials stored here. */
(function (root) {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  const stable = value => JSON.stringify(sort(value));
  function sort(value) {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
    return value;
  }
  const keyFor = p => JSON.stringify([p.worker, p.clientShiftId]);
  class Outbox {
    constructor(options = {}) {
      this.indexedDB = options.indexedDB || root.indexedDB;
      this.name = options.name || "pga-crew-clock-outbox-v30";
      this.now = options.now || Date.now;
      this.owner = options.owner || `${Date.now()}-${Math.random()}`;
      this.db = null;
      this.opening = null;
      this.version = options.version || 2;
      this.store = options.store || "entries";
      if (!["entries", "starts"].includes(this.store)) throw new Error("Invalid outbox store");
      this.running = null;
    }
    async open() {
      if (this.db) return;
      if (this.opening) return this.opening;
      if (!this.indexedDB) throw new Error("IndexedDB is unavailable. Clock-out has NOT been recorded locally.");
      this.opening = new Promise((resolve, reject) => {
        let failed = false;
        const fail = error => { failed = true; reject(error); };
        const req = this.indexedDB.open(this.name, this.version);
        req.onupgradeneeded = () => {
          if (failed) { req.transaction.abort(); return; }
          // Additive migrations only. Existing stores and records are never recreated.
          for (const name of ["entries", "conflicts", "meta", ...(this.version >= 2 ? ["starts"] : [])]) {
            if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: "key" });
            else if (req.transaction.objectStore(name).keyPath !== "key") {
              fail(new Error("Unrecognized local database schema. Existing records were not changed; office review required."));
              req.transaction.abort();
              return;
            }
          }
        };
        req.onerror = () => fail(req.error);
        req.onblocked = () => fail(new Error("Local database upgrade blocked. Preserve other Crew Clock tabs before closing them; reopen this app after review."));
        req.onsuccess = () => {
          if (failed) { req.result.close(); return; }
          const required = ["entries", "conflicts", "meta", ...(this.version >= 2 ? ["starts"] : [])];
          if (required.some(name => !req.result.objectStoreNames.contains(name))) {
            req.result.close();
            fail(new Error("Local database stores are missing. Existing data was left untouched."));
            return;
          }
          const check = req.result.transaction(required, "readonly");
          if (required.some(name => check.objectStore(name).keyPath !== "key")) {
            req.result.close();
            fail(new Error("Unrecognized local database keys. Existing data was left untouched."));
            return;
          }
          req.result.onversionchange = () => { req.result.close(); this.db = null; };
          this.db = req.result;
          resolve(req.result);
        };
      });
      try { await this.opening; } finally { this.opening = null; }
    }
    async transaction(stores, mode, work) {
      await this.open();
      return new Promise((resolve, reject) => {
        let result;
        const tx = this.db.transaction(stores, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("Local database transaction failed"));
        try { work(tx, value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
      });
    }
    async list() {
      return this.transaction([this.store], "readonly", (tx, done) => {
        tx.objectStore(this.store).getAll().onsuccess = e => done(e.target.result);
      });
    }
    async meta(key, value) {
      return this.transaction(["meta"], value === undefined ? "readonly" : "readwrite", (tx, done) => {
        const store = tx.objectStore("meta");
        if (value !== undefined) store.put({ key, value: clone(value) });
        else store.get(key).onsuccess = e => done(e.target.result?.value);
      });
    }
    async enqueue(shift, payload, schedule = null, options = {}) {
      const isStart = this.store === "starts";
      if (!payload.clientShiftId || !payload.worker || !payload.startIso || (isStart ? !payload.deviceId || !payload.jobsite : !payload.endIso || !["Yes", "No"].includes(payload.lunch))) throw new Error("Incomplete shift. It has NOT been recorded locally.");
      const key = keyFor(payload);
      const immutable = { payload: clone(payload), schedule: schedule ? clone(schedule) : null };
      const result = await this.transaction([this.store, "conflicts", ...(isStart ? ["entries"] : [])], "readwrite", (tx, done) => {
        const entries = tx.objectStore(this.store);
        entries.get(key).onsuccess = e => {
          const existing = e.target.result;
          if (existing) {
            if (stable(existing.immutable) !== stable(immutable)) {
              tx.objectStore("conflicts").put({ key: `${this.store}:${key}:${this.now()}:${Math.random()}`, store: this.store, entryKey: key, shift: clone(shift), immutable, capturedAt: this.now() });
              existing.status = "attention";
              existing.blocked = true;
              existing.error = "Conflicting records for the same session. Original and alternate records preserved; office review required.";
              entries.put(existing);
            }
            done(existing);
            return;
          }
          const entry = { key, immutable, shift: clone(shift), status: "queued", attempts: 0, nextAttempt: 0, capturedAt: this.now(), verifyOnly: !!options.verifyOnly, error: "", leaseUntil: 0 };
          if (isStart) {
            entries.getAll().onsuccess = event => {
              const starts = event.target.result;
              tx.objectStore("entries").getAll().onsuccess = completed => {
                if (starts.some(r => r.shift.worker === shift.worker && !completed.target.result.some(end => end.shift.worker === shift.worker && end.shift.id === r.shift.id))) {
                  done({blocked:true,error:"Another clock-in is active on this device. Reopen that shift; no additional clock-in was recorded."});
                  return;
                }
                entries.put(entry);done(entry);
              };
            };
          } else { entries.put(entry);done(entry); }
        };
      });
      if (result.blocked) throw new Error(result.error);
      return result;
    }
    async claim(worker, manual = false, excluded = new Set()) {
      return this.transaction([this.store], "readwrite", (tx, done) => {
        const entries = tx.objectStore(this.store);
        entries.getAll().onsuccess = e => {
          const now = this.now();
          const row = e.target.result.filter(r => !excluded.has(r.key) && r.immutable.payload.worker === worker && r.status !== "saved" && !r.blocked && (r.leaseUntil || 0) <= now && (manual || r.status !== "attention") && (manual || r.nextAttempt <= now))
            .sort((a, b) => a.capturedAt - b.capturedAt)[0];
          if (!row) return done(null);
          row.lease = `${this.owner}:${now}:${Math.random()}`;
          row.leaseUntil = now + 60000;
          row.status = "sending";
          row.attempts++;
          entries.put(row);
          done(row);
        };
      });
    }
    async finish(entry, patch) {
      return this.transaction([this.store], "readwrite", (tx, done) => {
        const store = tx.objectStore(this.store);
        store.get(entry.key).onsuccess = e => {
          const current = e.target.result;
          if (!current || current.lease !== entry.lease || current.blocked) return done(current);
          Object.assign(current, patch, { lease: null, leaseUntil: 0 });
          store.put(current);
          done(current);
        };
      });
    }
    async owns(entry) {
      return this.transaction([this.store], "readonly", (tx, done) => {
        tx.objectStore(this.store).get(entry.key).onsuccess = e => {
          const current = e.target.result;
          done(!!current && !current.blocked && current.lease === entry.lease && current.leaseUntil > this.now() && stable(current.immutable) === stable(entry.immutable));
        };
      });
    }
    async reviewSnapshot(worker, sessionId) {
      const key = keyFor({ worker, clientShiftId: sessionId });
      return this.transaction([this.store, "conflicts"], "readonly", (tx, done) => {
        const result = { schemaVersion: this.version, capturedAt: this.now(), key, original: null, alternatives: [] };
        tx.objectStore(this.store).get(key).onsuccess = e => { result.original = e.target.result || null; done(result); };
        tx.objectStore("conflicts").getAll().onsuccess = e => { result.alternatives = e.target.result.filter(r => (!r.store || r.store === this.store) && (r.entryKey === key || r.key.startsWith(key + ":"))); done(result); };
      });
    }
    static verifyShift(data, payload) {
      const receipt = data?.receipt;
      const expectedId = `CC-${payload.date.replace(/[^0-9]/g, "")}-${payload.clientShiftId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
      if (data?.ok !== true || !receipt || receipt.version !== 30 || data.submissionId !== expectedId || receipt.submissionId !== expectedId || receipt.sessionId !== payload.clientShiftId || stable(receipt.payload) !== stable(payload)) {
        const error = new Error("Server receipt missing or does not match the original shift. Local record retained.");
        error.needsAttention = true;
        throw error;
      }
      return receipt;
    }
    static verifyStart(data, payload) {
      const receipt = data?.receipt;
      if (data?.ok !== true || receipt?.version !== 30 || receipt?.type !== "clockIn" || receipt.sessionId !== payload.clientShiftId || stable(receipt.payload) !== stable(payload)) {
        throw Object.assign(new Error("Clock-in receipt missing or mismatched. Original clock-in retained for office review."), { needsAttention: true });
      }
      return receipt;
    }
    static scheduleProof(report) {
      return Object.fromEntries(["scheduleId", "date", "jobsite", "scheduledStart", "scheduledEnd", "reportedBy", "sourceSubmissionId"].map(k => [k, report[k] || ""]));
    }
    static verifySchedule(data, report) {
      if (data?.ok !== true || data.receipt?.version !== 30 || data.scheduleId !== report.scheduleId || stable(data.receipt.report) !== stable(Outbox.scheduleProof(report))) {
        const error = new Error("Crew schedule receipt does not match. Confirmation preserved for retry.");
        error.needsAttention = true;
        throw error;
      }
    }
    async drain(worker, send, options = {}) {
      if (this.running) {
        const running = this.running;
        if (!options.manual) return running;
        await running;
        return this.drain(worker, send, options);
      }
      this.running = this.run(worker, send, options).finally(() => { this.running = null; });
      return this.running;
    }
    async run(worker, send, options) {
      // Each record is attempted at most once per drain, even under manual retry.
      const visited = new Set(options.exclude || []);
      let attempted = 0;
      for (;;) {
        if (options.maxEntries && attempted >= options.maxEntries) break;
        if (options.canSend && !options.canSend(worker)) break;
        const entry = await this.claim(worker, !!options.manual, visited);
        if (!entry) break;
        visited.add(entry.key);
        attempted++;
        let receipt = entry.receipt;
        try {
          if (!(await this.owns(entry)) || options.canSend && !options.canSend(worker)) continue;
          if (this.store === "starts") {
            const data = await send("saveClockIn", { clockIn: clone(entry.immutable.payload), clientProtocol: 30 });
            receipt = Outbox.verifyStart(data, entry.immutable.payload);
            await this.finish(entry, { status: "saved", receipt, savedAt: this.now(), error: "" });
            if (options.onChange) await options.onChange();
            continue;
          }
          // Re-send the same immutable shift to reconcile a lost acknowledgement or cleanup failure.
          const data = await send("saveShift", { shift: clone(entry.immutable.payload), clientProtocol: 30, verifyOnly: entry.verifyOnly });
          receipt = Outbox.verifyShift(data, entry.immutable.payload);
          if (entry.immutable.schedule) {
            // A late response must not initiate another request after conflict, lease takeover or logout.
            if (!(await this.owns(entry)) || options.canSend && !options.canSend(worker)) continue;
            const report = { ...clone(entry.immutable.schedule), sourceSubmissionId: data.submissionId };
            const scheduleData = await send("saveCrewScheduleReport", { report, clientProtocol: 30, verifyOnly: entry.verifyOnly });
            Outbox.verifySchedule(scheduleData, report);
          }
          if (data.openShiftCleanup?.ok === false) throw new Error("Hours received; open-shift cleanup pending. Retrying safely.");
          await this.finish(entry, { status: "saved", receipt, savedAt: this.now(), error: "" });
        } catch (error) {
          const attention = !!(error.needsAttention || error.isBackendError && !error.retryable);
          const delay = Math.min(300000, 2000 * 2 ** Math.min(entry.attempts, 7)) + Math.floor(Math.random() * 1000);
          await this.finish(entry, { status: attention ? "attention" : "queued", receipt, error: error.message || String(error), nextAttempt: this.now() + delay });
          if (options.onError) options.onError(error, entry);
        }
        if (options.onChange) await options.onChange();
      }
    }
  }
  Outbox.stable = stable;
  root.CrewClockOutbox = Outbox;
  if (typeof module !== "undefined") module.exports = Outbox;
})(typeof window !== "undefined" ? window : globalThis);

const CONFIG = {
  apiUrl: normalizeConfigText(window.CREW_CLOCK_CONFIG?.apiUrl || ""),
  vapidPublicKey: normalizeConfigText(window.CREW_CLOCK_CONFIG?.vapidPublicKey || ""),
  fcmVapidKey: normalizeConfigText(window.CREW_CLOCK_CONFIG?.fcmVapidKey || window.CREW_CLOCK_CONFIG?.vapidPublicKey || ""),
  firebaseConfig: normalizeFirebaseConfig(window.CREW_CLOCK_CONFIG?.firebaseConfig || null),
};

const STORAGE_KEY = "pga-crew-clock-payroll-v2";
const DEVICE_KEY = "pga-crew-clock-device-id";
const API_PLACEHOLDER = "PASTE_APPS_SCRIPT_WEB_APP_URL_HERE";
const VAPID_PLACEHOLDER = "PASTE_WEB_PUSH_VAPID_PUBLIC_KEY_HERE";
const APP_TIME_ZONE = "America/Vancouver";
const OPERATIONS_REFRESH_MS = 30000;
const MY_HOURS_REFRESH_THROTTLE_MS = 3000;
const STILL_CLOCKED_IN_ALERT_TIME = "17:30";
const SESSION_EXPIRED_SAVE_MESSAGE = "Your session expired. Please sign in again. Your shift is still saved on this phone.";
const FIREBASE_SDK_VERSION = "10.13.2";

const els = {
  loginScreen: document.querySelector("#loginScreen"),
  appShell: document.querySelector("#appShell"),
  pinDots: document.querySelectorAll(".pin-dots span"),
  keypad: document.querySelector(".keypad"),
  loginMessage: document.querySelector("#loginMessage"),
  logoutButton: document.querySelector("#logoutButton"),
  workerName: document.querySelector("#workerName"),
  workerRole: document.querySelector("#workerRole"),
  connectionBar: document.querySelector("#connectionBar"),
  connectionText: document.querySelector("#connectionText"),
  managerTabs: document.querySelector("#managerTabs"),
  alertsTab: document.querySelector('[data-tab="alerts"]'),
  tabs: document.querySelectorAll(".tab"),
  views: document.querySelectorAll(".view"),
  refreshButton: document.querySelector("#refreshButton"),
  siteSelect: document.querySelector("#siteSelect"),
  siteSwatch: document.querySelector("#siteSwatch"),
  liveClock: document.querySelector("#liveClock"),
  statusPanel: document.querySelector("#statusPanel"),
  statusPill: document.querySelector("#statusPill"),
  clockTitle: document.querySelector("#clockTitle"),
  statusDetail: document.querySelector("#statusDetail"),
  jobsiteHelper: document.querySelector("#jobsiteHelper"),
  primaryActions: document.querySelector("#primaryActions"),
  clockButton: document.querySelector("#clockButton"),
  switchButton: document.querySelector("#switchButton"),
  absentButton: document.querySelector("#absentButton"),
  markEmployeeAbsentButton: document.querySelector("#markEmployeeAbsentButton"),
  notificationButton: document.querySelector("#notificationButton"),
  todayClockIn: document.querySelector("#todayClockIn"),
  todayClockOut: document.querySelector("#todayClockOut"),
  todayClockOutCard: document.querySelector("#todayClockOutCard"),
  reminderPanel: document.querySelector("#reminderPanel"),
  enableRemindersButton: document.querySelector("#enableRemindersButton"),
  remindersStatus: document.querySelector("#remindersStatus"),
  syncStatus: document.querySelector("#syncStatus"),
  lunchStatus: document.querySelector("#lunchStatus"),
  rowCount: document.querySelector("#rowCount"),
  timelineList: document.querySelector("#timelineList"),
  entryCount: document.querySelector("#entryCount"),
  clockedInCount: document.querySelector("#clockedInCount"),
  clockedOutCount: document.querySelector("#clockedOutCount"),
  teamHours: document.querySelector("#teamHours"),
  teamList: document.querySelector("#teamList"),
  myHoursPeriod: document.querySelector("#myHoursPeriod"),
  myHoursList: document.querySelector("#myHoursList"),
  alertsList: document.querySelector("#alertsList"),
  retryButton: document.querySelector("#retryButton"),
  lunchDialog: document.querySelector("#lunchDialog"),
  lunchYesButton: document.querySelector("#lunchYesButton"),
  lunchNoButton: document.querySelector("#lunchNoButton"),
  switchDialog: document.querySelector("#switchDialog"),
  switchSiteSelect: document.querySelector("#switchSiteSelect"),
  switchConfirmButton: document.querySelector("#switchConfirmButton"),
  switchCancelButton: document.querySelector("#switchCancelButton"),
  crewScheduleDialog: document.querySelector("#crewScheduleDialog"),
  crewScheduleContext: document.querySelector("#crewScheduleContext"),
  crewScheduleStart: document.querySelector("#crewScheduleStart"),
  crewScheduleEnd: document.querySelector("#crewScheduleEnd"),
  crewScheduleSubmitButton: document.querySelector("#crewScheduleSubmitButton"),
  absentDialog: document.querySelector("#absentDialog"),
  absentYesButton: document.querySelector("#absentYesButton"),
  absentNoButton: document.querySelector("#absentNoButton"),
  employeeAbsentDialog: document.querySelector("#employeeAbsentDialog"),
  employeeAbsentSelect: document.querySelector("#employeeAbsentSelect"),
  employeeAbsentReason: document.querySelector("#employeeAbsentReason"),
  employeeAbsentSubmitButton: document.querySelector("#employeeAbsentSubmitButton"),
  employeeAbsentCancelButton: document.querySelector("#employeeAbsentCancelButton"),
  removeAbsenceDialog: document.querySelector("#removeAbsenceDialog"),
  removeAbsenceTitle: document.querySelector("#removeAbsenceTitle"),
  removeAbsenceConfirmButton: document.querySelector("#removeAbsenceConfirmButton"),
  removeAbsenceCancelButton: document.querySelector("#removeAbsenceCancelButton"),
  toast: document.querySelector("#toast"),
};

let operationsReadV30 = { worker: "", token: "", loadedAt: null, day: "", loading: false, error: "" };

let payroll = {
  employees: [],
  jobsites: [],
  absences: [],
  clockStates: [],
  submissions: [],
  vacations: {status: "unavailable", date: "", items: [], lastSuccessfulAt: null},
  myHours: [],
  myHoursSummary: null,
  myHoursMessage: "",
  myHoursLoadedAt: null,
  myHoursLoading: false,
  capabilities: {
    canUseOperations: false,
    canUseAlerts: false,
    canReportCrewSchedule: false,
  },
  payrollPeriod: {
    configured: false,
    start: "",
    end: "",
  },
  loadedAt: null,
};

const V30_UI_KEY = "pga-crew-clock-ui-v30";
const outbox = new CrewClockOutbox();
const clockIns = new CrewClockOutbox({store: "starts"});
let clockInSnapshot = [];
let offlineClockInGrant = null;
let clockSyncRunning = null;
let offlineReady = false;
let offlineError = "";
let localCaptureBusy = false;
let syncTimer;
let state = loadState();
let pinBuffer = "";
let pendingClockOutShiftId = null;
let lunchDialogMode = "";
let pendingSwitchShiftId = null;
let pendingSwitchLunch = "";
let pendingCrewScheduleShiftId = null;
let pendingCrewScheduleLunch = "";
let pendingRemoveAbsenceWorker = "";
let toastTimer;
let renderTimer;
let operationsRefreshTimer;
let bootstrapLoading = false;
let bootstrapRequestToken = null;
let bootstrapRequestOwner = null;
let bootstrapRequestPromise = null;
let attendanceVisibilityV30 = {scope: "", snapshot: null, reviews: null};
let switchShiftProof = null;
let loginRequestOwner = null;
let myHoursRequestPromise = null;
let lastMyHoursRefreshStartedAt = 0;
let serviceWorkerRegistration = null;
let recoveryV30 = { token: null, verifiedAt: 0, error: "", renewalWorker: "", renewing: false, resume: null };

function defaultState() {
  return {
    day: todayKey(),
    deviceId: getOrCreateDeviceId(),
    auth: null,
    selectedJobsite: "",
    activeShifts: {},
    shifts: [],
    scheduleReports: [],
    absenceDate: "",
    expandedAlertSections: {},
    expandedTransfers: {},
    notificationEndpoint: "",
    reminderStatus: "",
    activeTab: "clock",
    lastSync: "Ready",
  };
}

function loadState() {
  try {
    const saved = localStorage.getItem(V30_UI_KEY) || localStorage.getItem(STORAGE_KEY);
    if (!saved) return defaultState();
    const parsed = JSON.parse(saved);
    return { ...defaultState(), ...parsed, activeShifts: parsed.activeShifts || {}, shifts: parsed.shifts || [], scheduleReports: parsed.scheduleReports || [] };
  } catch (error) {
    offlineError = "Local state could not be read. Existing storage was left untouched; contact the office.";
    return defaultState();
  }
}

function saveState() {
  // V29 storage is a read-only migration source. Never overwrite or remove it.
  try {
    localStorage.setItem(V30_UI_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    offlineError = "Device storage failed. Pending IndexedDB records are retained. Contact the office.";
    setConnection("error", offlineError);
    return false;
  }
}

function getOrCreateDeviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const deviceId = newId();
    localStorage.setItem(DEVICE_KEY, deviceId);
    return deviceId;
  } catch { return newId(); }
}

function apiReady() {
  return CONFIG.apiUrl && CONFIG.apiUrl !== API_PLACEHOLDER;
}

async function apiGet(action) {
  if (!apiReady()) throw new Error("Add the Apps Script Web App URL in index.html.");
  const url = new URL(CONFIG.apiUrl);
  url.searchParams.set("action", action);
  url.searchParams.set("_", Date.now().toString());
  const response = await apiFetch(url.toString(), { method: "GET" });
  return parseApiResponse(response);
}

async function apiPost(action, payload = {}, readOptions = {}) {
  if (!apiReady()) throw new Error("Add the Apps Script Web App URL in index.html.");
  const body = new URLSearchParams();
  body.set("payload", JSON.stringify({ action, ...payload }));
  // Only the read-only My Hours route gets the longer, body-inclusive deadline.
  const boundedRead = ["login", "bootstrap", "myHours"].includes(action) && readOptions.boundedRead === true;
  try {
    const response = await apiFetch(CONFIG.apiUrl, { method: "POST", body }, boundedRead ? 60000 : 20000, boundedRead);
    return boundedRead ? response : await parseApiResponse(response);
  } catch (error) {
    // Late responses from an older sign-in must not invalidate the current employee.
    if (payload.token && payload.token === state.auth?.token) recoveryFailureV30(error);
    throw error;
  }
}

async function apiFetch(url, options, timeoutMs = 20000, parseWithinTimeout = false) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      controller.abort();
      reject(new Error("Request timed out"));
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return parseWithinTimeout ? await parseApiResponse(response) : response;
    })();
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error.isBackendError) throw error;
    const networkError = new Error("Connection interrupted or timed out. Pending clock-outs remain on this device.");
    networkError.isNetworkError = true;
    throw networkError;
  } finally { window.clearTimeout(timer); }
}

async function parseApiResponse(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new Error("Payroll 2.0 returned an unreadable response. Local records retained."); }
  if (!response.ok || data?.ok !== true) {
    const error = new Error(data?.error || `Payroll 2.0 request failed (${response.status}).`);
    error.isBackendError = true;
    error.code = data?.code || "";
    error.httpStatus = response.status;
    error.retryable = data?.retryable === true || response.status === 429 || response.status >= 500;
    throw error;
  }
  return data;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function setup() {
  ensureSyncPanelV30();
  els.keypad.addEventListener("click", (event) => {
    const key = event.target.closest("button")?.dataset.key;
    if (key) handlePinKey(key);
  });
  window.addEventListener("keydown", handleKeyboardPin);
  window.addEventListener("focus", resumeOfflineSync);
  window.addEventListener("online", resumeOfflineSync);
  window.addEventListener("pageshow", resumeOfflineSync);
  window.addEventListener("offline", () => setConnection("error", "Offline — local records retained."));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resumeOfflineSync();
  });
  els.logoutButton.addEventListener("click", logout);
  els.refreshButton.addEventListener("click", loadBootstrap);
  els.siteSelect.addEventListener("change", () => {
    state.selectedJobsite = els.siteSelect.value;
    saveState();
    render();
  });
  els.clockButton.addEventListener("click", toggleClock);
  els.switchButton.addEventListener("click", openSwitchDialog);
  els.absentButton.addEventListener("click", handleAbsentButton);
  els.markEmployeeAbsentButton.addEventListener("click", openEmployeeAbsentDialog);
  els.notificationButton.addEventListener("click", enableClockReminders);
  els.enableRemindersButton.addEventListener("click", enableClockReminders);
  els.retryButton.addEventListener("click", retryFailedSaves);
  els.lunchYesButton.addEventListener("click", () => handleLunchAnswer("Yes"));
  els.lunchNoButton.addEventListener("click", () => handleLunchAnswer("No"));
  els.switchConfirmButton.addEventListener("click", switchJobsite);
  els.switchCancelButton.addEventListener("click", closeSwitchDialog);
  els.crewScheduleSubmitButton.addEventListener("click", submitCrewScheduleClockOut);
  els.absentYesButton.addEventListener("click", markAbsentToday);
  els.absentNoButton.addEventListener("click", closeAbsentDialog);
  els.employeeAbsentSubmitButton.addEventListener("click", submitEmployeeAbsence);
  els.employeeAbsentCancelButton.addEventListener("click", closeEmployeeAbsentDialog);
  els.employeeAbsentSelect.addEventListener("change", renderEmployeeAbsentSubmitState);
  els.employeeAbsentReason.addEventListener("change", renderEmployeeAbsentSubmitState);
  els.removeAbsenceConfirmButton.addEventListener("click", removeEmployeeAbsence);
  els.removeAbsenceCancelButton.addEventListener("click", closeRemoveAbsenceDialog);
  els.teamList.addEventListener("click", handleOperationsClick);

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  });

  registerServiceWorker();
  renderTimer = window.setInterval(render, 1000);
  operationsRefreshTimer = window.setInterval(refreshOperationsIfOpen, OPERATIONS_REFRESH_MS);
  if (state.auth) showApp(); else showLogin("");
  render();
  initializeOffline().catch(storageFailureV30);
  syncTimer = window.setInterval(() => syncOutbox(), 15000);
}

function handleKeyboardPin(event) {
  if (state.auth) return;
  if (/^\d$/.test(event.key)) {
    event.preventDefault();
    handlePinKey(event.key);
  } else if (event.key === "Backspace") {
    event.preventDefault();
    handlePinKey("back");
  } else if (event.key === "Escape") {
    handlePinKey("clear");
  }
}

function handlePinKey(key) {
  if (key === "clear") {
    pinBuffer = "";
  } else if (key === "back") {
    pinBuffer = pinBuffer.slice(0, -1);
  } else if (/^\d$/.test(key) && pinBuffer.length < 4) {
    pinBuffer += key;
  }
  renderPinDots();
  if (pinBuffer.length === 4) loginWithPin();
}

function renderPinDots() {
  els.pinDots.forEach((dot, index) => {
    dot.classList.toggle("filled", index < pinBuffer.length);
  });
}

async function loginWithPin() {
  const owner={};loginRequestOwner=owner;
  const pin=pinBuffer;
  setLoginMessage("Checking PIN...");
  try {
    const data=await readOnlyRequestV30("login",{pin},()=>loginRequestOwner===owner);
    if(loginRequestOwner!==owner)return;
    resetMyHoursState();
    state.auth={token:data.token,worker:data.employee.worker,role:data.employee.role||"Employee",attendanceRequired:data.employee.attendanceRequired||"No",workerType:normalizeWorkerType(data.employee.workerType),expiresAt:data.expiresAt,signedInAt:new Date().toISOString()};
    recoveryV30.token=null;recoveryV30.verifiedAt=0;recoveryV30.error="";recoveryV30.renewalWorker="";
    state.lastSync="Signed in";state.activeTab="clock";pinBuffer="";
    saveState();renderPinDots();showApp();
    await loadBootstrap();
    if(loginRequestOwner!==owner)return;
    await syncOutbox();
    if(loginRequestOwner===owner&&state.auth?.worker===data.employee.worker)showToast(`Signed in as ${state.auth.worker}`);
  } catch(error) {
    if(loginRequestOwner!==owner)return;
    pinBuffer="";renderPinDots();
    setLoginMessage(error.message==="DUPLICATE_PIN"?"Duplicate PIN detected. Please contact the office.":error.message||"PIN not accepted",true);
  } finally {if(loginRequestOwner===owner)loginRequestOwner=null;}
}

function loadBootstrap(options = {}) {
  // All same-session callers await the same read; a previous sign-in cannot own a new one.
  if (bootstrapRequestPromise && bootstrapRequestToken === state.auth?.token) return bootstrapRequestPromise;
  const request = performBootstrapV30(options);
  bootstrapRequestPromise = request;
  return request;
}

async function performBootstrapV30(options = {}) {
  if(!state.auth||!apiReady())return;
  if (authExpiredV30()) { recoveryFailureV30(new Error("Session expired. Sign in again.")); setConnection("error", "Renew sign-in. Local records retained."); return; }
  const requestToken=state.auth.token,requestWorker=currentWorker(),owner={quiet:options.quiet===true};
  const sameEmployee=()=>state.auth?.token===requestToken&&currentWorker()===requestWorker;
  bootstrapRequestToken=requestToken;bootstrapRequestOwner=owner;
  bootstrapLoading = true;
  markOperationsReadV30("loading",requestWorker,requestToken);
  if(state.activeTab === "operations")render();
  if (!options.quiet) setConnection("loading", "Refreshing Payroll 2.0");
  try {
    const data = await readOnlyRequestV30("bootstrap", { token: requestToken, reconcileActiveSessionId: state.activeShifts?.[requestWorker]?.id || "" }, sameEmployee);
    if(!sameEmployee())return;
    markOperationsReadV30("success",requestWorker,requestToken,data);
    payroll = {
      employees: arrayOrEmpty(data.employees),
      jobsites: arrayOrEmpty(data.jobsites),
      absences: arrayOrEmpty(data.absences),
      clockStates: arrayOrEmpty(data.clockStates),
      submissions: arrayOrEmpty(data.submissions),
      vacations: mergeCrewVacations(data.capabilities?.canUseOperations ? data.vacations : null, data.capabilities?.canUseOperations ? payroll.vacations : null),
      openShiftReviews: data.capabilities?.canUseOperations ? data.openShiftReviews : null,
      myHours: payroll.myHours,
      myHoursSummary: payroll.myHoursSummary,
      myHoursMessage: payroll.myHoursMessage,
      myHoursLoadedAt: payroll.myHoursLoadedAt,
      myHoursLoading: payroll.myHoursLoading,
      capabilities: data.capabilities || payroll.capabilities || {},
      payrollPeriod: data.payrollPeriod || payroll.payrollPeriod || {},
      loadedAt: new Date().toISOString(),
    };
    const employee = currentEmployee();
    if (employee && state.auth) {
      state.auth.attendanceRequired = employee.attendanceRequired || state.auth.attendanceRequired || "No";
      state.auth.workerType = normalizeWorkerType(employee.workerType || state.auth.workerType);
    }
    if (state.selectedJobsite && !payroll.jobsites.some((jobsite) => jobsite.jobsite === state.selectedJobsite)) {
      state.selectedJobsite = "";
    }
    if (state.absenceDate === todayKey() && !payroll.absences.some((entry) => entry.worker === currentWorker() && entry.date === todayKey() && entry.status === "Absent")) {
      state.absenceDate = "";
    }
    const cachedWorker = requestWorker;
    const tokenParts = String(requestToken).split(".");
    let expiresAt = 0;
    try { expiresAt = Number(JSON.parse(atob(tokenParts[0].replace(/-/g,"+").replace(/_/g,"/"))).exp); } catch {}
    const tokenDigest=await tokenDigestV30(requestToken);
    if(!sameEmployee())return;
    offlineClockInGrant = {worker:cachedWorker,tokenDigest,expiresAt,checkedAt:Date.now()};
    await outbox.meta("bootstrap:" + cachedWorker, { jobsites: arrayOrEmpty(data.jobsites), capabilities: data.capabilities||{}, employees: arrayOrEmpty(data.employees).filter(e => e.worker === cachedWorker), offlineClockInGrant });
    if(!sameEmployee())return;
    await reconcileRestoredActiveV30(data.completedActiveSession,requestWorker,requestToken);
    if(!sameEmployee())return;
    restoreCurrentOpenShift();
    state.lastSync = "Ready";
    saveState();
    recoveryV30.token = requestToken; recoveryV30.verifiedAt = Date.now(); recoveryV30.error = "";
    recoveryV30.renewalWorker = "";
    switchShiftProof = {token:requestToken,worker:requestWorker,open:arrayOrEmpty(data.clockStates).find(open => open.worker === requestWorker && open.status === "Clocked In")};
    renderRecoveryV30();
    setConnection("ready", "Connected to Payroll 2.0");
  } catch (error) {
    if(!sameEmployee())return;
    markOperationsReadV30("error",requestWorker,requestToken,null,error.message);
    state.lastSync = "Connection failed";
    recoveryFailureV30(error);
    setConnection("error", error.message);
  } finally {
    if(bootstrapRequestOwner===owner){bootstrapLoading=false;bootstrapRequestToken=null;bootstrapRequestOwner=null;bootstrapRequestPromise=null;}
    if(sameEmployee())render();
  }
}

async function loadMyHours(options = {}) {
  if (!state.auth || !apiReady()) return;
  if (myHoursRequestPromise) return myHoursRequestPromise;
  const requestToken = state.auth.token;
  const requestWorker = currentWorker();
  const sameEmployee = () => state.auth?.token === requestToken && currentWorker() === requestWorker;
  lastMyHoursRefreshStartedAt = Date.now();
  const request = (async () => {
    payroll.myHoursLoading = true;
    if (options.renderBefore !== false && state.activeTab === "myHours") render();
    try {
      let data;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!sameEmployee()) return;
        try {
          data = await apiPost("myHours", { token: requestToken }, { boundedRead: true });
          break;
        } catch (error) {
          if (!sameEmployee()) return;
          if (attempt || navigator.onLine === false || !(error.isNetworkError || error.retryable)) throw error;
          payroll.myHoursMessage = "Connection interrupted. Retrying My Hours…";
          if (state.activeTab === "myHours") render();
          await new Promise(resolve => window.setTimeout(resolve, 750));
        }
      }
      if (!sameEmployee()) return;
      payroll.myHours = arrayOrEmpty(data.rows);
      payroll.myHoursSummary = data.payrollSummary || null;
      payroll.myHoursMessage = data.message || "";
      payroll.payrollPeriod = data.payrollPeriod || payroll.payrollPeriod || {};
      if (data.workerType) state.auth.workerType = normalizeWorkerType(data.workerType);
      payroll.myHoursLoadedAt = new Date().toISOString();
    } catch (error) {
      if (!sameEmployee()) return;
      // Keep the last successful result on this employee's screen, clearly marked stale.
      payroll.myHoursMessage = payroll.myHoursLoadedAt
        ? "Could not refresh My Hours. Showing the last successful result. Use Refresh to try again."
        : "Could not load My Hours. Use Refresh to try again. Pending clock-outs remain on this device.";
    } finally {
      if (sameEmployee()) {
        payroll.myHoursLoading = false;
        if (options.renderAfter !== false && state.activeTab === "myHours") render();
      }
    }
  })();
  myHoursRequestPromise = request;
  try { return await request; }
  finally { if (myHoursRequestPromise === request) myHoursRequestPromise = null; }
}

function requestMyHoursRefresh(options = {}) {
  if (!state.auth || !apiReady()) return Promise.resolve();
  if (myHoursRequestPromise) return myHoursRequestPromise;
  const now = Date.now();
  if (!options.force && now - lastMyHoursRefreshStartedAt < MY_HOURS_REFRESH_THROTTLE_MS) {
    return Promise.resolve();
  }
  return loadMyHours(options);
}

function refreshMyHoursFromAppResume() {
  if (!state.auth || state.activeTab !== "myHours" || document.hidden) return;
  requestMyHoursRefresh({ quiet: true });
}

function resetMyHoursState() {
  // A previous employee's in-flight read cannot block or update the next employee.
  myHoursRequestPromise = null;
  offlineClockInGrant = null;
  payroll.myHours = [];
  payroll.myHoursSummary = null;
  payroll.myHoursMessage = "";
  payroll.myHoursLoadedAt = null;
  payroll.myHoursLoading = false;
}

function refreshOperationsIfOpen() {
  if (document.hidden || navigator.onLine === false || !offlineReady || offlineError || localCaptureBusy
      || !state.auth || authExpiredV30() || recoveryV30.renewalWorker) return;
  const managerView = canUseOperations() && ["operations", "alerts"].includes(state.activeTab);
  const connectionDue = recoveryV30.token !== state.auth.token || !!recoveryV30.error
    || Date.now() - recoveryV30.verifiedAt >= OPERATIONS_REFRESH_MS;
  // Reuse the existing 30-second timer; never relax the 90-second verification guard.
  if (managerView || connectionDue) void loadBootstrap({ quiet: true });
}

function showLogin(message) {
  els.loginScreen.hidden = false;
  els.appShell.hidden = true;
  setLoginMessage(message || "");
  renderPinDots();
}

function showApp() {
  els.loginScreen.hidden = true;
  els.appShell.hidden = false;
}

function logout() {
  resetMyHoursState();
  loginRequestOwner = null;
  state.auth = null;
  recoveryV30.token=null;recoveryV30.verifiedAt=0;recoveryV30.error="";recoveryV30.renewalWorker="";
  state.activeTab = "clock";
  saveState();
  showLogin("");
}

function setActiveTab(tab) {
  if (!canAccessTab(tab)) tab = firstAllowedTab();
  state.activeTab = tab;
  saveState();
  render();
  if (tab === "operations" || tab === "alerts") loadBootstrap({ quiet: true });
  if (tab === "myHours") requestMyHoursRefresh({ quiet: true, force: true });
}

function currentWorker() {
  return state.auth?.worker || "";
}

function currentRole() {
  return state.auth?.role || "Employee";
}

function roleText() {
  return currentRole().toLowerCase();
}

function roleHasAny(words) {
  const role = roleText();
  return words.some((word) => role.includes(word));
}

function canUseOperations() {
  if (payroll.loadedAt && typeof payroll.capabilities?.canUseOperations === "boolean") return payroll.capabilities.canUseOperations;
  return roleHasAny(["foreman", "manager", "supervisor", "admin", "director"]);
}

function canUseAlerts() {
  if (payroll.loadedAt && typeof payroll.capabilities?.canUseAlerts === "boolean") return payroll.capabilities.canUseAlerts;
  return roleHasAny(["admin", "director"]);
}

function canReportCrewSchedule() {
  if (payroll.loadedAt && typeof payroll.capabilities?.canReportCrewSchedule === "boolean") return payroll.capabilities.canReportCrewSchedule;
  return roleHasAny(["foreman", "manager", "supervisor", "admin", "director"]);
}

function currentEmployee() {
  return payroll.employees.find((employee) => employee.worker === currentWorker()) || null;
}

function attendanceRequiredFor(worker = currentWorker()) {
  const employee = payroll.employees.find((item) => item.worker === worker);
  const value = employee?.attendanceRequired || (worker === currentWorker() ? state.auth?.attendanceRequired : "");
  return String(value || "").toLowerCase() === "yes";
}

function isManagerMode() {
  return canUseOperations() || canUseAlerts();
}

function canMarkEmployeeAbsent() {
  return roleHasAny(["admin", "director", "manager", "foreman"]);
}

function canEnableDeviceNotifications() {
  return attendanceRequiredFor() || canUseOperations() || canUseAlerts();
}

function allowedTabs() {
  const tabs = ["clock", "myHours"];
  if (canUseOperations()) tabs.push("operations");
  if (canUseAlerts()) tabs.push("alerts");
  return tabs;
}

function firstAllowedTab() {
  return allowedTabs()[0] || "clock";
}

function canAccessTab(tab) {
  return allowedTabs().includes(tab);
}

function hasFcmConfig() {
  const config = CONFIG.firebaseConfig;
  return !!config
    && ["apiKey", "projectId", "messagingSenderId", "appId"].every((key) => hasRealConfigValue(config[key]))
    && hasRealConfigValue(CONFIG.fcmVapidKey);
}

function hasRealConfigValue(value) {
  const text = String(value || "").trim();
  return !!text && !/^(PASTE|YOUR|FIREBASE)_/i.test(text);
}

function normalizeConfigText(value) {
  return String(value || "").trim().replace(/[\u2010-\u2015\u2212]/g, "-");
}

function normalizeFirebaseConfig(config) {
  if (!config || typeof config !== "object") return null;
  return {
    apiKey: normalizeConfigText(config.apiKey),
    authDomain: normalizeConfigText(config.authDomain),
    projectId: normalizeConfigText(config.projectId),
    messagingSenderId: normalizeConfigText(config.messagingSenderId),
    appId: normalizeConfigText(config.appId),
  };
}

function pushDiagnostics(registration = serviceWorkerRegistration) {
  const vapidBytes = publicKeyByteLength(CONFIG.vapidPublicKey);
  const fcmBytes = publicKeyByteLength(CONFIG.fcmVapidKey);
  const diagnostics = {
    vapidPublicKey: CONFIG.vapidPublicKey,
    fcmVapidKey: CONFIG.fcmVapidKey,
    vapidPublicKeyLength: CONFIG.vapidPublicKey.length,
    fcmVapidKeyLength: CONFIG.fcmVapidKey.length,
    vapidPublicKeyBytes: vapidBytes,
    fcmVapidKeyBytes: fcmBytes,
    firebaseConfigReady: hasFcmConfig(),
    firebaseSdkLoaded: !!(window.firebase?.initializeApp && window.firebase?.messaging),
    serviceWorkerScope: registration?.scope || "",
    serviceWorkerScript: registration?.active?.scriptURL || registration?.waiting?.scriptURL || registration?.installing?.scriptURL || "",
  };
  console.info("PGA Crew Clock push diagnostics", diagnostics);
  return diagnostics;
}

function pushDiagnosticsSummary(diagnostics) {
  return [
    `vapid ${diagnostics.vapidPublicKeyLength}/bytes ${diagnostics.vapidPublicKeyBytes}`,
    `fcm ${diagnostics.fcmVapidKeyLength}/bytes ${diagnostics.fcmVapidKeyBytes}`,
    `firebase config ${diagnostics.firebaseConfigReady ? "ok" : "missing"}`,
    `sdk ${diagnostics.firebaseSdkLoaded ? "loaded" : "not loaded"}`,
  ].join("; ");
}

function publicKeyByteLength(value) {
  try {
    return urlBase64ToUint8Array(normalizeConfigText(value)).byteLength;
  } catch {
    return 0;
  }
}

function assertValidP256PublicKey(value, label) {
  const text = normalizeConfigText(value);
  const bytes = publicKeyByteLength(text);
  if (text.length !== 87 || bytes !== 65) {
    throw new Error(`${label} must be 87 characters and decode to 65 bytes. Runtime value is ${text.length} characters and ${bytes} bytes.`);
  }
}

function currentActiveShift() {
  return state.activeShifts[currentWorker()] || null;
}

function completedRowsFor(worker = currentWorker()) {
  return state.shifts.filter((shift) => shift.worker === worker && (localDateKey(new Date(shift.start)) === todayKey() || shift.syncStatus !== "saved"));
}

function activeShiftFor(worker) {
  return state.activeShifts[worker] || null;
}

function restoreCurrentOpenShift() {
  const worker = currentWorker();
  if (!worker) return;
  const open = payroll.clockStates.find((entry) => entry.worker === worker && entry.date === todayKey() && entry.status === "Clocked In");
  if (!open?.clockInAt || !open.jobsite) {
    return;
  }

  if (state.shifts.some(s => s.worker === worker && s.id === open.sessionId && (s.clearOpenShift || s.nextOpenShift))) return;
  const existing = state.activeShifts[worker];
  if (existing?.id === open.sessionId && existing.start === open.clockInAt && existing.jobsite === open.jobsite) return; // preserve durable start metadata
  if (existing && existing.id !== open.sessionId && Date.parse(existing.start) >= Date.parse(open.clockInAt)) return;
  state.activeShifts[worker] = {
    id: open.sessionId || existing?.id || newId(),
    worker,
    jobsite: open.jobsite,
    start: open.clockInAt,
    restored: true,
  };
  state.selectedJobsite = open.jobsite;
}

function hasClockedInToday(worker = currentWorker()) {
  const status = clockStateFor(worker)?.status;
  return !!activeShiftFor(worker) || completedRowsFor(worker).length > 0 || status === "Clocked In" || status === "Clocked Out";
}

function hasAttendanceClockInToday(worker) {
  const status = clockStateFor(worker)?.status;
  return status === "Clocked In"
    || status === "Clocked Out"
    || !!(activeShiftFor(worker) && localDateKey(new Date(activeShiftFor(worker).start)) === todayKey())
    || payroll.submissions.some((row) => row.worker === worker && row.date === todayKey())
    || state.shifts.some((shift) => shift.worker === worker && localDateKey(new Date(shift.start)) === todayKey());
}

function activeAttendanceEmployees() {
  return payroll.employees.filter((employee) => {
    const status = String(employee.status || "Active").toLowerCase();
    return employee.worker && status === "active" && attendanceRequiredFor(employee.worker);
  });
}

function clockStateFor(worker = currentWorker()) {
  return payroll.clockStates.find((entry) => entry.worker === worker && entry.date === todayKey()) || null;
}

function isAbsentToday(worker = currentWorker()) {
  if (worker === currentWorker() && state.absenceDate === todayKey()) return true;
  return payroll.absences.some((entry) => entry.worker === worker && entry.date === todayKey() && entry.status === "Absent");
}

function setLocalAbsence(isAbsent) {
  state.absenceDate = isAbsent ? todayKey() : "";
  payroll.absences = payroll.absences.filter((entry) => !(entry.worker === currentWorker() && entry.date === todayKey()));
  if (isAbsent) {
    payroll.absences.push({ worker: currentWorker(), date: todayKey(), status: "Absent" });
  }
}

async function toggleClock() {
  if (!state.auth || !offlineReady || localCaptureBusy) return;
  const current = currentActiveShift();
  if (current) { openLunchDialog("clockOut",current.id); return; }
  const selected = findJobsite(state.selectedJobsite);
  if (!selected) return showToast("Select a jobsite before clocking in.");
  if (isAbsentToday()) return showToast("You have been marked absent. Contact the office.");
  const worker = currentWorker(), token = state.auth.token;
  const capturedStart = new Date().toISOString();
  localCaptureBusy = true; render();
  try {
    if (navigator.onLine === false && (!offlineClockInAllowedV30() || await tokenDigestV30(token) !== offlineClockInGrant.tokenDigest)) throw new Error("Offline clock-in needs a recent successful sign-in and jobsite download for this employee. Reconnect first.");
    if (currentWorker() !== worker || state.auth?.token !== token) throw new Error("Sign-in changed. Clock-in was not recorded.");
    const shift = {id:newId(),worker,jobsite:selected.jobsite,start:capturedStart,deviceId:state.deviceId,requiresClockInReceipt:true};
    await clockIns.enqueue(shift,clockInPayloadV30(shift));
    state.activeShifts[worker] = shift;
    await hydrateOutboxV30();
    saveState();
    state.lastSync = "Pending Sync — clock-in recorded on this device";
    showToast(state.lastSync);
    render();
    void syncOutbox();
  } catch(error) { setConnection("error",error.message); showToast(error.message); }
  finally { localCaptureBusy=false;render(); }
}

function openLunchDialog(mode, shiftId) {
  lunchDialogMode = mode;
  pendingClockOutShiftId = mode === "clockOut" ? shiftId : null;
  pendingSwitchShiftId = mode === "switch" ? shiftId : null;
  pendingSwitchLunch = "";
  els.lunchDialog.hidden = false;
  els.lunchNoButton.focus();
}

function handleLunchAnswer(lunch) {
  if (lunchDialogMode === "switch") {
    openSwitchJobsiteStep(lunch);
    return;
  }
  finishClockOut(lunch);
}

async function finishClockOut(lunch) {
  const current = currentActiveShift();
  if (!current || current.id !== pendingClockOutShiftId) {
    closeLunchDialog();
    return;
  }

  if (canReportCrewSchedule()) {
    openCrewScheduleDialog(current, lunch);
    return;
  }

  await completeClockOut(current, lunch, null);
}

async function completeClockOut(current, lunch, crewSchedule) {
  if (localCaptureBusy || !offlineReady) return;
  localCaptureBusy = true;
  render();
  try {
    const completed = { ...current, end: new Date().toISOString(), lunch, clearOpenShift: true,
      deviceId: state.deviceId, syncStatus: "pending" };
    if (crewSchedule) {
      completed.crewScheduleId = crewSchedule.id;
      completed.crewSchedule = { ...crewSchedule, linkedShiftId: completed.id, shiftStartIso: completed.start,
        shiftEndIso: completed.end, syncStatus: "waiting", error: "" };
    }
    // No local completion UI or network call until this IndexedDB transaction commits.
    await outbox.enqueue(completed, toSubmissionPayload(completed), completed.crewSchedule ? toCrewSchedulePayload(completed.crewSchedule, completed, "") : null);
    closeLunchDialog();
    closeCrewScheduleDialog();
    applyCompletedShiftSideEffects(completed);
    await hydrateOutboxV30();
    state.lastSync = "Pending Sync — clock-out recorded on this device";
    saveState();
    showToast(state.lastSync);
    if (navigator.onLine === false) setConnection("error", "Offline — clock-out recorded locally. Pending Sync.");
    void syncOutbox();
  } catch (error) { storageFailureV30(error); }
  finally { localCaptureBusy = false; els.crewScheduleSubmitButton.disabled = false; render(); }
}

function closeLunchDialog() {
  pendingClockOutShiftId = null;
  pendingSwitchShiftId = null;
  pendingSwitchLunch = "";
  lunchDialogMode = "";
  els.lunchDialog.hidden = true;
}

function openCrewScheduleDialog(shift, lunch) {
  pendingCrewScheduleShiftId = shift.id;
  pendingCrewScheduleLunch = lunch;
  lunchDialogMode = "";
  els.lunchDialog.hidden = true;
  els.crewScheduleContext.textContent = "Confirm the crew's scheduled start and end time for this jobsite.";
  if (!els.crewScheduleStart.value) els.crewScheduleStart.value = "07:00";
  if (!els.crewScheduleEnd.value) els.crewScheduleEnd.value = "15:30";
  els.crewScheduleDialog.hidden = false;
  els.crewScheduleStart.focus();
}

function closeCrewScheduleDialog() {
  pendingCrewScheduleShiftId = null;
  pendingCrewScheduleLunch = "";
  els.crewScheduleDialog.hidden = true;
  els.crewScheduleSubmitButton.disabled = false;
}

async function submitCrewScheduleClockOut() {
  const current = currentActiveShift();
  if (!current || current.id !== pendingCrewScheduleShiftId) {
    closeCrewScheduleDialog();
    return;
  }
  const schedule = buildCrewScheduleReport(current);
  if (!schedule) return;
  els.crewScheduleSubmitButton.disabled = true;
  await completeClockOut(current, pendingCrewScheduleLunch, schedule);
}

function buildCrewScheduleReport(shift) {
  const scheduledStart = normalizeTimeInput(els.crewScheduleStart.value);
  const scheduledEnd = normalizeTimeInput(els.crewScheduleEnd.value);
  if (!scheduledStart || !scheduledEnd) {
    showToast("Enter the crew schedule start and end.");
    return null;
  }
  if (scheduledStart === scheduledEnd) {
    showToast("Scheduled start and end cannot be the same.");
    return null;
  }
  return {
    id: `schedule-${newId()}`,
    worker: currentWorker(),
    role: currentRole(),
    date: localDateKey(new Date(shift.start)),
    jobsite: shift.jobsite,
    scheduledStart,
    scheduledEnd,
    reportedAt: new Date().toISOString(),
    source: "Foreman",
    sourceSessionId: shift.id,
    deviceId: state.deviceId || "",
  };
}

function normalizeTimeInput(value) {
  const text = String(value || "").trim();
  if (!/^\d{2}:\d{2}$/.test(text)) return "";
  const [hours, minutes] = text.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return "";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function openSwitchDialog() {
  const current = currentActiveShift();
  if (!current || !switchJobsiteReady()) return;
  openLunchDialog("switch", current.id);
}

function openSwitchJobsiteStep(lunch) {
  const current = currentActiveShift();
  if (!current || current.id !== pendingSwitchShiftId) {
    closeLunchDialog();
    return;
  }

  pendingSwitchLunch = lunch;
  const next = payroll.jobsites.find((jobsite) => jobsite.jobsite !== current.jobsite) || payroll.jobsites[0];
  renderJobsiteSelect(els.switchSiteSelect, next?.jobsite || "");
  pendingClockOutShiftId = null;
  lunchDialogMode = "";
  els.lunchDialog.hidden = true;
  els.switchDialog.hidden = false;
  els.switchSiteSelect.focus();
}

function closeSwitchDialog() {
  pendingSwitchShiftId = null;
  pendingSwitchLunch = "";
  els.switchDialog.hidden = true;
}

function handleAbsentButton() {
  if (isAbsentToday()) {
    showToast("Absent Today");
    return;
  }
  els.absentDialog.hidden = false;
  els.absentNoButton.focus();
}

function closeAbsentDialog() {
  els.absentDialog.hidden = true;
}

async function markAbsentToday() {
  closeAbsentDialog();
  if (hasClockedInToday()) return showToast("You already clocked in today");
  setLocalAbsence(true);
  state.selectedJobsite = "";
  saveState();
  render();
  setConnection("loading", "Saving absence");
  try {
    await apiPost("markAbsent", {
      token: state.auth?.token,
      date: todayKey(),
    });
    payroll.clockStates = payroll.clockStates.filter((entry) => !(entry.worker === currentWorker() && entry.date === todayKey()));
    payroll.clockStates.push({ worker: currentWorker(), date: todayKey(), status: "Absent", jobsite: "", clockInAt: "", clockOutAt: "" });
    setConnection("ready", "Absent Today saved");
    showToast("Absent Today saved");
  } catch (error) {
    setLocalAbsence(false);
    saveState();
    setConnection("error", error.message);
    showToast("Could not save absence");
  } finally {
    render();
  }
}

function openEmployeeAbsentDialog() {
  if (!canMarkEmployeeAbsent()) return;
  renderEmployeeAbsentOptions();
  if (els.employeeAbsentSelect.options.length <= 1) {
    showToast("No active employees available");
    return;
  }
  els.employeeAbsentReason.value = "";
  renderEmployeeAbsentSubmitState();
  els.employeeAbsentDialog.hidden = false;
  els.employeeAbsentSelect.focus();
}

function closeEmployeeAbsentDialog() {
  els.employeeAbsentDialog.hidden = true;
  els.employeeAbsentSubmitButton.disabled = false;
  els.employeeAbsentSubmitButton.textContent = "Submit";
}

function renderEmployeeAbsentOptions() {
  const employees = payroll.employees
    .filter((employee) => employee.worker && String(employee.status || "Active").toLowerCase() === "active")
    .filter((employee) => employee.worker !== currentWorker())
    .sort((a, b) => a.worker.localeCompare(b.worker));

  els.employeeAbsentSelect.innerHTML = [
    `<option value="">Select employee...</option>`,
    ...employees.map((employee) => `<option value="${escapeHtml(employee.worker)}">${escapeHtml(employee.worker)}</option>`),
  ].join("");
}

function renderEmployeeAbsentSubmitState() {
  els.employeeAbsentSubmitButton.disabled = !els.employeeAbsentSelect.value || !els.employeeAbsentReason.value;
}

async function submitEmployeeAbsence() {
  if (!canMarkEmployeeAbsent()) return;
  const worker = els.employeeAbsentSelect.value;
  const reason = els.employeeAbsentReason.value;
  if (!worker || !reason) {
    renderEmployeeAbsentSubmitState();
    return;
  }
  if (hasClockedInToday(worker)) return showToast("This employee has already clocked in today.");
  if (isAbsentToday(worker)) return showToast("This employee is already marked absent today.");

  els.employeeAbsentSubmitButton.disabled = true;
  els.employeeAbsentSubmitButton.textContent = "Saving";
  setConnection("loading", "Saving absence");
  try {
    const data = await apiPost("markEmployeeAbsent", {
      token: state.auth?.token,
      date: todayKey(),
      worker,
      reason,
    });
    const absence = data.absence || { worker, date: todayKey(), status: "Absent", reason, submittedBy: currentWorker() };
    payroll.absences = payroll.absences.filter((entry) => !(entry.worker === worker && entry.date === todayKey()));
    payroll.absences.push(absence);
    payroll.clockStates = payroll.clockStates.filter((entry) => !(entry.worker === worker && entry.date === todayKey()));
    payroll.clockStates.push({ worker, date: todayKey(), status: "Absent", jobsite: "", clockInAt: "", clockOutAt: "" });
    setConnection("ready", "Absent Today saved");
    showToast(`✓ ${worker} marked absent (${reason}).`);
    window.setTimeout(() => {
      closeEmployeeAbsentDialog();
      state.activeTab = "clock";
      saveState();
      render();
    }, 1000);
  } catch (error) {
    setConnection("error", error.message || "Could not save absence");
    showToast(error.message || "Could not save absence");
    els.employeeAbsentSubmitButton.disabled = false;
    els.employeeAbsentSubmitButton.textContent = "Submit";
  }
}

function handleOperationsClick(event) {
  const removeButton = event.target.closest(".absence-remove-button");
  if (!removeButton) return;
  if (!canMarkEmployeeAbsent()) return;
  openRemoveAbsenceDialog(removeButton.dataset.worker || "");
}

function openRemoveAbsenceDialog(worker) {
  if (!worker || !canMarkEmployeeAbsent()) return;
  pendingRemoveAbsenceWorker = worker;
  els.removeAbsenceTitle.textContent = `Remove today's absence for ${worker}?`;
  els.removeAbsenceConfirmButton.disabled = false;
  els.removeAbsenceConfirmButton.textContent = "Remove";
  els.removeAbsenceDialog.hidden = false;
  els.removeAbsenceCancelButton.focus();
}

function closeRemoveAbsenceDialog() {
  pendingRemoveAbsenceWorker = "";
  els.removeAbsenceDialog.hidden = true;
  els.removeAbsenceConfirmButton.disabled = false;
  els.removeAbsenceConfirmButton.textContent = "Remove";
}

async function removeEmployeeAbsence() {
  const worker = pendingRemoveAbsenceWorker;
  if (!worker || !canMarkEmployeeAbsent()) return closeRemoveAbsenceDialog();

  els.removeAbsenceConfirmButton.disabled = true;
  els.removeAbsenceConfirmButton.textContent = "Removing";
  setConnection("loading", "Removing absence");
  try {
    await apiPost("removeEmployeeAbsence", {
      token: state.auth?.token,
      date: todayKey(),
      worker,
    });
    payroll.absences = payroll.absences.filter((entry) => !(entry.worker === worker && entry.date === todayKey()));
    payroll.clockStates = payroll.clockStates.filter((entry) => !(entry.worker === worker && entry.date === todayKey() && entry.status === "Absent"));
    if (worker === currentWorker()) state.absenceDate = "";
    closeRemoveAbsenceDialog();
    setConnection("ready", "Absence removed");
    showToast("✓ Absence removed.");
    saveState();
    render();
    loadBootstrap({ quiet: true });
  } catch (error) {
    setConnection("error", error.message || "Could not remove absence");
    showToast(error.message || "Could not remove absence");
    els.removeAbsenceConfirmButton.disabled = false;
    els.removeAbsenceConfirmButton.textContent = "Remove";
  }
}

async function switchJobsite() {
  const current = currentActiveShift();
  const nextJobsite = els.switchSiteSelect.value;
  if (!current || current.id !== pendingSwitchShiftId || !switchJobsiteReady()) return;
  if (!nextJobsite || nextJobsite === current.jobsite) return showToast("Select a different jobsite");
  const now = new Date().toISOString();
  const completed = { ...current, end: now, lunch: pendingSwitchLunch === "Yes" ? "Yes" : "No",
    travelTo: nextJobsite, deviceId: state.deviceId, syncStatus: "pending" };
  completed.nextOpenShift = { id: newId(), worker: currentWorker(), jobsite: nextJobsite, start: now, travelFrom: current.jobsite };
  localCaptureBusy = true;
  try {
    await outbox.enqueue(completed, toSubmissionPayload(completed));
    applyCompletedShiftSideEffects(completed);
    closeSwitchDialog();
    await hydrateOutboxV30();
    saveState();
    showToast("Transfer recorded locally — Pending Sync");
    void syncOutbox();
  } catch (error) { storageFailureV30(error); }
  finally { localCaptureBusy = false; render(); }
}

async function recordClockState(status, shift = {}) {
  if (!state.auth || !apiReady()) return;
  const payload = {
    token: state.auth.token,
    status,
    date: todayKey(),
    jobsite: shift.jobsite || "",
    clockInAt: shift.start || "",
    clockOutAt: shift.end || "",
    sessionId: shift.id || "",
    deviceId: state.deviceId || "",
  };
  const data = await apiPost("clockState", payload);
  payroll.clockStates = payroll.clockStates.filter((entry) => !(entry.worker === currentWorker() && entry.date === todayKey()));
  payroll.clockStates.push(data.clockState || { worker: currentWorker(), date: todayKey(), status });
  return data;
}

async function saveCompletedShift(shift) {
  try {
    const schedule = shift.crewSchedule || crewScheduleReportForShift(shift.id);
    await outbox.enqueue(shift, toSubmissionPayload(shift), schedule ? toCrewSchedulePayload(schedule, shift, "") : null);
    await syncOutbox(true);
    return { ok: state.shifts.some(s => s.id === shift.id && s.syncStatus === "saved") };
  } catch (error) { storageFailureV30(error); return { ok: false, error }; }
}

function saveErrorMessage(error, fallback) {
  if (error?.isNetworkError) return error.message;
  if (error?.isBackendError) return `Payroll 2.0 error: ${error.message}`;
  return error?.message || fallback;
}

function applyCompletedShiftSideEffects(shift) {
  const shiftDate = localDateKey(new Date(shift.start));
  payroll.clockStates = payroll.clockStates.filter((entry) => !(entry.worker === shift.worker && entry.date === shiftDate));
  if (shift.nextOpenShift) {
    const next = shift.nextOpenShift;
    state.activeShifts[shift.worker] = next;
    state.selectedJobsite = next.jobsite;
    payroll.clockStates.push({
      worker: shift.worker,
      date: localDateKey(new Date(next.start)),
      status: "Clocked In",
      jobsite: next.jobsite,
      clockInAt: next.start,
      clockOutAt: "",
      sessionId: next.id,
      deviceId: state.deviceId || "",
    });
    return;
  }
  if (shift.clearOpenShift) {
    delete state.activeShifts[shift.worker];
    if (shift.worker === currentWorker()) state.selectedJobsite = "";
    payroll.clockStates.push({
      worker: shift.worker,
      date: shiftDate,
      status: "Clocked Out",
      jobsite: shift.jobsite,
      clockInAt: shift.start,
      clockOutAt: shift.end,
      sessionId: shift.id,
      deviceId: state.deviceId || "",
    });
  }
}

async function notifySaveProblem(shift, error) {
  const latest = state.shifts.find((item) => item.id === shift.id) || shift;
  if (!state.auth?.token || latest.saveProblemNotified) return;
  try {
    await apiPost("notifySaveProblem", {
      token: state.auth.token,
      shift: toSubmissionPayload(latest),
      error: error?.message || "Save failed, retry needed.",
    });
    updateShiftSync(shift.id, { saveProblemNotified: true });
  } catch {
    // The failed shift remains queued locally; this notification is best-effort.
  }
}

function queueCrewScheduleReport(report) {
  state.scheduleReports = state.scheduleReports.filter((item) => item.id !== report.id);
  state.scheduleReports.unshift(report);
}

function crewScheduleReportForShift(shiftId) {
  return state.scheduleReports.find((report) => report.linkedShiftId === shiftId) || null;
}

function updateCrewScheduleSync(id, patch) {
  state.scheduleReports = state.scheduleReports.map((report) => (report.id === id ? { ...report, ...patch } : report));
  saveState();
}

async function saveCrewScheduleReportForShift(shift, submissionId) {
  await syncOutbox(true);
  const report = crewScheduleReportForShift(shift.id);
  return { ok: !report || report.syncStatus === "saved" };
}

function toCrewSchedulePayload(report, shift, submissionId) {
  return {
    scheduleId: report.id,
    date: report.date,
    jobsite: report.jobsite,
    scheduledStart: report.scheduledStart,
    scheduledEnd: report.scheduledEnd,
    reportedBy: report.worker,
    reportedRole: report.role,
    reportedAt: report.reportedAt,
    source: report.source || "Foreman",
    sourceSessionId: report.sourceSessionId || shift.id,
    sourceSubmissionId: submissionId || "",
    deviceId: report.deviceId || state.deviceId || "",
    shiftStartIso: report.shiftStartIso || shift.start || "",
    shiftEndIso: report.shiftEndIso || shift.end || "",
  };
}

function isSessionExpiredError(error) {
  return /session expired/i.test(error?.message || "");
}

function handleExpiredSessionSave(shift) {
  const existing = state.shifts.find((item) => item.id === shift.id);
  const alreadyNotified = !!existing?.sessionExpiredNotified;
  updateShiftSync(shift.id, {
    syncStatus: "failed",
    error: SESSION_EXPIRED_SAVE_MESSAGE,
    sessionExpiredNotified: true,
  });
  state.lastSync = "Save failed, try again";
  loginRequestOwner = null;
  state.auth = null;
  saveState();
  setConnection("error", SESSION_EXPIRED_SAVE_MESSAGE);
  if (!alreadyNotified) showToast(SESSION_EXPIRED_SAVE_MESSAGE);
  showLogin(SESSION_EXPIRED_SAVE_MESSAGE);
}

function updateShiftSync(id, patch) {
  state.shifts = state.shifts.map((shift) => (shift.id === id ? { ...shift, ...patch } : shift));
  saveState();
}

async function retryFailedSaves() {
  await syncOutbox(true);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register("./service-worker.js", {updateViaCache:"none"});
    installUpdateSafetyV30(serviceWorkerRegistration);
    const notice = document.querySelector('#updateDiscoveryErrorV30');
    if (notice) notice.hidden = true;
  } catch {
    serviceWorkerRegistration = null;
    let notice = document.querySelector('#updateDiscoveryErrorV30');
    if (!notice) { notice=document.createElement('p');notice.id='updateDiscoveryErrorV30';notice.setAttribute('role','status');document.body.append(notice); }
    notice.hidden=false;
    notice.textContent='App update check could not start. Your records are retained. Reconnect; checking will retry when you reopen the app.';
  }
}

async function enableClockReminders() {
  if (!canEnableDeviceNotifications()) {
    state.reminderStatus = "Notifications are off for this worker.";
    saveState();
    render();
    return;
  }
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    state.reminderStatus = "Clock reminders are not supported on this browser.";
    saveState();
    render();
    return;
  }
  if (!CONFIG.vapidPublicKey || CONFIG.vapidPublicKey === VAPID_PLACEHOLDER) {
    state.reminderStatus = "Reminder setup needs the web push public key.";
    saveState();
    render();
    return;
  }
  try {
    assertValidP256PublicKey(CONFIG.vapidPublicKey, "vapidPublicKey");
    assertValidP256PublicKey(CONFIG.fcmVapidKey, "fcmVapidKey");
  } catch (error) {
    const diagnostics = pushDiagnostics();
    state.reminderStatus = `${error.message || error}. ${pushDiagnosticsSummary(diagnostics)}`;
    saveState();
    render();
    return;
  }
  let diagnostics = pushDiagnostics();
  state.reminderStatus = `Checking push setup: ${pushDiagnosticsSummary(diagnostics)}`;
  saveState();
  render();
  if (!hasFcmConfig()) {
    state.reminderStatus = `Firebase messaging config is incomplete. ${pushDiagnosticsSummary(diagnostics)}`;
    saveState();
    render();
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    state.reminderStatus = "Clock reminders were not enabled.";
    saveState();
    render();
    return;
  }

  try {
    await navigator.serviceWorker.register("./service-worker.js");
    const registration = await navigator.serviceWorker.ready;
    serviceWorkerRegistration = registration;
    await enableFcmReminders(registration);

    state.reminderStatus = "Clock reminders enabled on this device.";
    saveState();
    render();
    showToast("Clock reminders enabled");
  } catch (error) {
    diagnostics = pushDiagnostics(serviceWorkerRegistration);
    state.reminderStatus = `FCM setup failed: ${error.message || error}. ${pushDiagnosticsSummary(diagnostics)}`;
    saveState();
    render();
  }
}

async function enableFcmReminders(registration) {
  if (!window.firebase?.initializeApp || !window.firebase?.messaging) {
    throw new Error(`Firebase SDK scripts did not load before app.js. Expected firebase-app-compat.js and firebase-messaging-compat.js ${FIREBASE_SDK_VERSION}.`);
  }
  if (window.firebase.messaging.isSupported && !(await window.firebase.messaging.isSupported())) {
    throw new Error("Clock reminders are not supported on this browser.");
  }

  if (!window.firebase.apps?.length) window.firebase.initializeApp(CONFIG.firebaseConfig);
  const messaging = window.firebase.messaging();
  const fcmToken = await messaging.getToken({
    vapidKey: CONFIG.fcmVapidKey,
    serviceWorkerRegistration: registration,
  });
  if (!fcmToken) throw new Error("Could not create a Firebase notification token.");

  await apiPost("registerPushSubscription", {
    token: state.auth?.token,
    pushProvider: "fcm",
    fcmToken,
    userAgent: navigator.userAgent,
  });
  state.notificationEndpoint = `fcm:${fcmToken.slice(-16)}`;
}

async function enableNativeWebPushReminders(registration) {
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(CONFIG.vapidPublicKey),
  });

  await apiPost("registerPushSubscription", {
    token: state.auth?.token,
    pushProvider: "webpush",
    subscription: subscription.toJSON(),
    userAgent: navigator.userAgent,
  });
  state.notificationEndpoint = subscription.endpoint;
}

function toSubmissionPayload(shift) {
  return {
    ...(shift.requiresClockInReceipt ? {requiresClockInReceipt:true} : {}),
    clientShiftId: shift.id,
    worker: shift.worker,
    date: localDateKey(new Date(shift.start)),
    jobsite: shift.jobsite,
    startIso: shift.start,
    endIso: shift.end,
    lunch: shift.lunch === "Yes" ? "Yes" : "No",
    notes: shift.notes || "",
    deviceId: shift.deviceId || state.deviceId || "",
    crewScheduleConfirmation: shift.crewSchedule ? scheduleConfirmationV30(shift.crewSchedule) : null,
    clearOpenShift: !!shift.clearOpenShift,
    nextOpenShift: shift.nextOpenShift ? {
      clientShiftId: shift.nextOpenShift.id,
      worker: shift.nextOpenShift.worker,
      date: localDateKey(new Date(shift.nextOpenShift.start)),
      jobsite: shift.nextOpenShift.jobsite,
      startIso: shift.nextOpenShift.start,
      deviceId: shift.deviceId || state.deviceId || "",
    } : null,
  };
}

function render() {
  if (state.auth && authExpiredV30() && !recoveryV30.renewalWorker) recoveryFailureV30(new Error("Session expired. Sign in again."));
  if (els.connectionBar.classList.contains("ready") && !serverVerifiedV30()) setConnection("error", recoveryV30.error || "Server connection needs rechecking. Local records retained.");
  if (!state.auth) {
    renderPinDots();
    return;
  }
  showApp();
  renderRecoveryV30();
  renderShell();
  renderClock();
  renderMyHours();
  if (canUseOperations()) renderOperations();
  if (canUseAlerts()) renderAlerts();
}

function renderShell() {
  els.workerName.textContent = currentWorker();
  els.workerRole.textContent = currentRole() || "Employee";
  const tabs = allowedTabs();
  if (!canAccessTab(state.activeTab)) state.activeTab = firstAllowedTab();
  els.managerTabs.hidden = false;
  els.managerTabs.style.setProperty("--tab-count", String(tabs.length));
  renderAlertsTabIndicator();
  els.tabs.forEach((tab) => {
    const allowed = tabs.includes(tab.dataset.tab);
    tab.hidden = !allowed;
    tab.disabled = !allowed;
    tab.classList.toggle("active", allowed && tab.dataset.tab === state.activeTab);
  });
  els.views.forEach((view) => {
    const key = view.id.replace("View", "");
    view.classList.toggle("active", key === state.activeTab && canAccessTab(key));
  });
  els.connectionBar.hidden = false;
}

function renderAlertsTabIndicator() {
  if (!els.alertsTab) return;
  if (!canUseAlerts()) {
    els.alertsTab.textContent = "Alerts";
    els.alertsTab.setAttribute("aria-label", "Alerts");
    return;
  }
  const hasActionableAlerts = alertItemCount(buildAlertSections().filter((section) => section.actionable)) > 0;
  els.alertsTab.innerHTML = hasActionableAlerts
    ? `Alerts <span class="tab-alert-badge" aria-hidden="true">!</span>`
    : "Alerts";
  els.alertsTab.setAttribute("aria-label", hasActionableAlerts ? "Alerts, actionable items" : "Alerts");
}

function renderClock() {
  renderJobsiteSelect(els.siteSelect, state.selectedJobsite, { placeholder: true });
  const current = currentActiveShift();
  const rows = completedRowsFor();
  const lastRow = rows[0];
  const site = findJobsite(current?.jobsite || state.selectedJobsite);
  const selectedJobsite = findJobsite(state.selectedJobsite);
  const canClock = payroll.jobsites.length > 0;
  const absent = isAbsentToday();
  const clockDataReady = !bootstrapLoading && !!payroll.loadedAt;
  const canShowAbsentAction = !current && !absent && !hasClockedInToday();
  const canShowEmployeeAbsentAction = !absent && canMarkEmployeeAbsent();
  const connectionStatus = clockConnectionStatus();
  const connectionReady = connectionStatus.state === "ready";

  els.liveClock.textContent = new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  }).format(new Date());
  els.statusPanel.style.setProperty("--site-color", site?.colour || "#007f73");
  els.siteSwatch.style.background = selectedJobsite?.colour || "#8a94a6";
  els.clockButton.disabled = !offlineReady || localCaptureBusy || (current
    ? false
    : !(connectionReady || offlineClockInAllowedV30()) || !canClock || absent || !selectedJobsite);
  els.switchButton.disabled = !switchJobsiteReady();
  const siteSelectDisabled = !(connectionReady || offlineClockInAllowedV30()) || !!current || !canClock || absent;
  if (document.activeElement !== els.siteSelect && els.siteSelect.disabled !== siteSelectDisabled) {
    els.siteSelect.disabled = siteSelectDisabled;
  }
  els.absentButton.hidden = !connectionReady || !clockDataReady || !canShowAbsentAction;
  els.absentButton.textContent = "MARK ABSENT";
  els.markEmployeeAbsentButton.hidden = !connectionReady || !clockDataReady || !canShowEmployeeAbsentAction;
  els.markEmployeeAbsentButton.textContent = "MARK EMPLOYEE ABSENT";
  els.jobsiteHelper.hidden = !!current || absent || !canClock || !!selectedJobsite;
  renderReminderPanel();
  const problem = connectionStatus.state === "offline";
  els.statusPanel.classList.toggle("clocked-in", !!current);
  els.statusPanel.classList.toggle("clocked-out", !current);
  els.statusPanel.classList.toggle("status-problem", !!problem);
  els.clockTitle.textContent = current ? current.jobsite : "SELECT JOBSITE";
  els.statusPill.textContent = connectionStatus.text;
  els.statusPill.className = `status-pill ${connectionStatus.className}`;

  if (!current && !apiReady()) {
    els.statusDetail.textContent = current ? "" : "Where are you working today?";
  } else if (!current && !payroll.jobsites.length) {
    els.statusDetail.textContent = current ? "" : "Where are you working today?";
  } else if (!current && absent) {
    els.statusDetail.textContent = "You have been marked absent for today.";
    els.clockButton.className = "primary-button";
    els.clockButton.textContent = "CLOCK IN";
    els.switchButton.hidden = true;
    els.primaryActions.classList.remove("with-switch");
  } else if (current) {
    els.statusDetail.textContent = "";
    els.clockButton.className = "primary-button stop";
    els.clockButton.textContent = "END SHIFT";
    els.switchButton.hidden = false;
    els.switchButton.textContent = "SWITCH JOBSITE";
    els.primaryActions.classList.add("with-switch");
  } else {
    els.statusDetail.textContent = "Where are you working today?";
    els.clockButton.className = "primary-button";
    els.clockButton.textContent = "CLOCK IN";
    els.switchButton.hidden = true;
    els.primaryActions.classList.remove("with-switch");
  }

  els.syncStatus.textContent = syncStatusText();
  els.lunchStatus.textContent = current ? "Pending" : lastRow ? lastRow.lunch : "Pending";
  els.rowCount.textContent = String(rows.length);
  els.entryCount.textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  renderTodayClockStatusCards();
  renderCompletedRows(rows);
  renderSyncPanelV30();
}

function renderTodayClockStatusCards() {
  const worker = currentWorker();
  const current = currentActiveShift();
  const completed = completedSegmentsFor(worker).filter(segment => segment.end);
  const latest = completed.reduce((chosen, segment) => !chosen || Date.parse(segment.start) > Date.parse(chosen.start) ? segment : chosen, null);
  const start = current?.start || latest?.start || "";
  els.todayClockIn.previousElementSibling.textContent = current ? "Current shift start" : "Last shift start";
  els.todayClockIn.textContent = start ? timeLabel(start) + (localDateKey(new Date(start)) !== todayKey() ? " (" + localDateKey(new Date(start)) + ")" : "") : "Not Clocked In";
  const summary = dailyTimeSummaryFor(worker, todayKey());
  const clockOut = clockOutDisplay(summary);
  els.todayClockOut.textContent = clockOut.text;
  els.todayClockOutCard.classList.toggle("pending", clockOut.state === "pending");
  els.todayClockOutCard.classList.toggle("complete", clockOut.state === "complete");
  els.todayClockOutCard.classList.toggle("incomplete", clockOut.state === "incomplete");
}

function clockOutDisplay(summary) {
  if (summary.needsAttention) return { text: "Needs Attention", state: "incomplete" };
  if (summary.pendingSync) return { text: "Pending Sync", state: "pending" };
  if (summary.pending) return { text: "Pending", state: "pending" };
  if (summary.clockOutAt) return { text: timeLabel(summary.clockOutAt), state: "complete" };
  if (summary.clockInAt) return { text: "Not Clocked Out", state: "incomplete" };
  return { text: "—", state: "empty" };
}

function switchJobsiteReady() {
  if (!offlineReady || localCaptureBusy || !state.auth?.token || !serverVerifiedV30() || !apiReady() || !payroll.jobsites.length) return false;
  if (clockConnectionStatus().state === "ready") return true;
  // A quiet refresh may reuse recent server proof, never an unverified/offline start.
  if (!bootstrapLoading || !bootstrapRequestOwner?.quiet || bootstrapRequestToken !== state.auth?.token
    || !payroll.loadedAt
    || state.lastSync === "Connection failed" || els.connectionBar.classList.contains("error")) return false;
  const current = currentActiveShift();
  const open = switchShiftProof?.open;
  return !!current && !!open && switchShiftProof.token === state.auth.token && switchShiftProof.worker === currentWorker()
    && payroll.jobsites.some(site => site.jobsite === current.jobsite)
    && open.sessionId === current.id && open.jobsite === current.jobsite && open.clockInAt === current.start;
}

function clockConnectionStatus() {
  if (recoveryV30.renewalWorker || authExpiredV30()) return {state:"attention",text:"🔴 Sign in again — records retained",className:"problem"};
  if (navigator.onLine === false || !apiReady()) {
    return { state: "offline", text: "🔴 Offline", className: "problem" };
  }
  if (bootstrapLoading) {
    return { state: "connecting", text: "🟡 Connecting...", className: "connecting" };
  }
  if (state.lastSync === "Connection failed" || els.connectionBar.classList.contains("error")) {
    const detail = els.connectionBar.dataset.detail || state.lastSync || "";
    const offline = /network|offline|failed to fetch|load failed|connection failed/i.test(detail);
    return { state: offline ? "offline" : "attention", text: offline ? "🔴 Offline" : "🔴 Needs attention", className: "problem" };
  }
  if (!payroll.loadedAt) {
    return { state: "connecting", text: "🟡 Connecting...", className: "connecting" };
  }
  return { state: "ready", text: "🟢 Ready for Clock In", className: "ready" };
}

function renderMyHours() {
  if (!els.myHoursList) return;
  const period = payroll.payrollPeriod || {};
  if (payroll.myHoursLoading) {
    els.myHoursPeriod.textContent = "Loading current payroll period";
    els.myHoursList.innerHTML = `<p class="empty-state">Loading My Hours...</p>`;
    return;
  }
  if (!period.configured) {
    els.myHoursPeriod.textContent = "";
    els.myHoursList.innerHTML = `<p class="empty-state">${escapeHtml(payroll.myHoursMessage || "Current payroll period has not been set.")}</p>`;
    return;
  }

  els.myHoursPeriod.innerHTML = `
    <span>Current Payroll Period</span>
    <strong>${escapeHtml(dateLabel(period.start))} &ndash; ${escapeHtml(dateLabel(period.end))}</strong>
    ${renderMyHoursRefreshedAt()}
  `;
  const rows = myHoursRowsForDisplay();
  const summaryCards = renderMyHoursSummaryCards();
  if (!rows.length) {
    els.myHoursList.innerHTML = `
      <p class="empty-state">No clock records in the current payroll period</p>
      ${summaryCards}
    `;
    return;
  }

  els.myHoursList.innerHTML = `
    <div class="my-hours-table" role="table" aria-label="My Hours for current payroll period">
      <div class="my-hours-row my-hours-header" role="row">
        <span role="columnheader">Date / Day</span>
        <span role="columnheader">Clock In</span>
        <span role="columnheader">Clock Out</span>
      </div>
      ${rows.map(renderMyHoursRow).join("")}
    </div>
    ${summaryCards}
  `;
}

function renderMyHoursRefreshedAt() {
  if (!payroll.myHoursLoadedAt) return "";
  return `<span class="my-hours-refreshed">Last refreshed ${escapeHtml(timeLabel(payroll.myHoursLoadedAt))}</span>`;
}

function renderMyHoursSummaryCards() {
  const summary = payroll.myHoursSummary || {};
  const workerType = normalizeWorkerType(summary.workerType || currentWorkerType());
  const pending = summary.status !== "ready";
  const cards = workerType === "Subcontractor"
    ? [
        { label: "Regular Hours", value: summary.regularHours },
        { label: "Swing Stage Hours", value: summary.swingStageHours },
      ]
    : [
        { label: "Regular Hours", value: summary.regularHours },
        { label: "OT Hours", value: summary.otHours },
        { label: "Swing Stage Hours", value: summary.swingStageHours },
      ];
  const doubleTimeHours = Number(summary.doubleTimeHours);
  if (Number.isFinite(doubleTimeHours) && doubleTimeHours > 0) {
    cards.push({ label: "Double Time Hours", value: summary.doubleTimeHours });
  }

  return `
    <section class="my-hours-summary-cards" aria-label="Payroll summary">
      ${cards.map((card) => `
        <article class="my-hours-summary-card${pending ? " pending" : ""}">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(payrollHoursValue(card.value, pending))}</strong>
        </article>
      `).join("")}
    </section>
  `;
}

function payrollHoursValue(value, pending) {
  if (pending) return "Pending Payroll";
  return formatPayrollHours(value);
}

function formatPayrollHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

function currentWorkerType() {
  const employee = currentEmployee();
  return normalizeWorkerType(employee?.workerType || state.auth?.workerType);
}

function normalizeWorkerType(value) {
  return String(value || "").trim().toLowerCase() === "subcontractor" ? "Subcontractor" : "Employee";
}

function myHoursRowsForDisplay() {
  const period = payroll.payrollPeriod || {};
  if (!period.configured) return [];
  const byDate = {};
  payroll.myHours.forEach((row) => {
    if (!dateWithinPeriod(row.date, period)) return;
    const summary = byDate[row.date] || emptyDailyTimeSummary(row.date);
    if (row.clockInAt) summary.clockInAt = earliestTime(summary.clockInAt, row.clockInAt);
    if (row.clockOutAt) summary.clockOutAt = latestTime(summary.clockOutAt, row.clockOutAt);
    if (row.pending) summary.pending = true;
    byDate[row.date] = summary;
  });

  state.shifts.filter(s => s.worker === currentWorker() && s.syncStatus !== "saved" && dateWithinPeriod(localDateKey(new Date(s.start)), period)).forEach(s => {
    const date = localDateKey(new Date(s.start));
    const summary = byDate[date] || emptyDailyTimeSummary(date);
    mergeCompletedTime(summary, s.start, s.end);
    summary.pendingSync = true;
    summary.needsAttention = summary.needsAttention || s.syncStatus === "failed";
    byDate[date] = summary;
  });
  const today = todayKey();
  if (dateWithinPeriod(today, period)) {
    const todaySummary = dailyTimeSummaryFor(currentWorker(), today);
    if (todaySummary.clockInAt || todaySummary.clockOutAt || todaySummary.pending) {
      const summary = byDate[today] || emptyDailyTimeSummary(today);
      summary.clockInAt = earliestTime(summary.clockInAt, todaySummary.clockInAt);
      summary.clockOutAt = latestTime(summary.clockOutAt, todaySummary.clockOutAt);
      summary.pending = summary.pending || todaySummary.pending;
      summary.pendingSync = summary.pendingSync || todaySummary.pendingSync;
      summary.needsAttention = summary.needsAttention || todaySummary.needsAttention;
      summary.incomplete = !!summary.clockInAt && !summary.clockOutAt && !summary.pending;
      byDate[today] = summary;
    }
  }

  return Object.keys(byDate)
    .sort((a, b) => b.localeCompare(a))
    .map((date) => {
      const row = byDate[date];
      row.incomplete = !!row.clockInAt && !row.clockOutAt && !row.pending;
      return row;
    });
}

function renderMyHoursRow(row) {
  const out = clockOutDisplay(row);
  return `
    <div class="my-hours-row" role="row">
      <span role="cell">${escapeHtml(compactDateDayLabel(row.date))}</span>
      <strong role="cell">${row.clockInAt ? timeLabel(row.clockInAt) : "Not Clocked In"}</strong>
      <strong role="cell" class="my-hours-out ${escapeAttribute(out.state)}">${escapeHtml(out.text)}</strong>
    </div>
  `;
}

function renderCompletedRows(rows) {
  if (!rows.length) {
    els.timelineList.innerHTML = `<p class="empty-state">No completed rows today</p>`;
    return;
  }

  els.timelineList.innerHTML = rows
    .map((shift) => {
      const site = findJobsite(shift.jobsite);
      const travel = travelLabel(shift);
      return `
        <article class="entry-card" style="--row-site-color:${escapeAttribute(site?.colour || "#007f73")}">
          <div class="entry-main">
            <div>
              <span class="entry-title">${escapeHtml(shift.jobsite)}</span>
              <span class="entry-sub">${escapeHtml(localDateKey(new Date(shift.start)))} · ${timeLabel(shift.start)} - ${timeLabel(shift.end)}</span>
              <span class="entry-sub">Lunch: ${escapeHtml(shift.lunch)}</span>
              ${travel ? `<span class="entry-sub">${escapeHtml(travel)}</span>` : ""}
              ${crewScheduleStatusLabel(shift) ? `<span class="entry-sub">${escapeHtml(crewScheduleStatusLabel(shift))}</span>` : ""}
              ${shift.error ? `<span class="entry-sub">Save error: ${escapeHtml(shift.error)}</span>` : ""}
            </div>
            <span class="mini-pill ${syncClass(shift)}">${syncLabel(shift)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderReminderPanel() {
  const canEnable = canEnableDeviceNotifications();
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  const enabled = permission === "granted" && !!state.notificationEndpoint;
  const canRequestPermission = canEnable && permission === "default";
  els.reminderPanel.hidden = true;
  els.notificationButton.hidden = !canRequestPermission;
  els.notificationButton.disabled = false;
  if (!canEnable) return;

  els.enableRemindersButton.disabled = enabled;
  const buttonLabel = attendanceRequiredFor() ? "Clock Reminders" : "Manager Notifications";
  els.enableRemindersButton.textContent = enabled ? `${buttonLabel} Enabled` : `Enable ${buttonLabel}`;
  if (state.reminderStatus) {
    els.remindersStatus.textContent = state.reminderStatus;
  } else if (permission === "denied") {
    els.remindersStatus.textContent = "Notifications are blocked in this browser.";
  } else {
    els.remindersStatus.textContent = attendanceRequiredFor()
      ? "Tap once on this device to receive clock reminders."
      : "Tap once on this device to receive manager notifications.";
  }
}

function renderOperations() {
  if (!canUseOperations()) {
    els.teamList.innerHTML = "";
    return;
  }
  const operationsView = renderOperationsFreshnessV30();
  if (!operationsView.hasComplete) {
    els.clockedInCount.textContent = "—";els.clockedOutCount.textContent = "—";els.teamHours.textContent = "—";
    els.teamList.innerHTML = '<p class="empty-state">Attendance alerts temporarily paused. Complete team data is unavailable; no verified count is available. Previous-day shift review is unavailable. Your saved and pending clock records remain in Clock.</p>';
    return;
  }
  const activeEntries = Object.values(state.activeShifts).filter((shift) => localDateKey(new Date(shift.start)) === todayKey());
  const completed = state.shifts.filter((shift) => localDateKey(new Date(shift.start)) === todayKey());
  const todayStates = payroll.clockStates.filter((entry) => entry.date === todayKey());
  const clockedInWorkers = new Set(activeEntries.map((shift) => shift.worker));
  todayStates.filter((entry) => entry.status === "Clocked In").forEach((entry) => clockedInWorkers.add(entry.worker));
  const absentWorkers = new Set(payroll.absences.filter((entry) => entry.date === todayKey() && entry.status === "Absent").map((entry) => entry.worker));
  todayStates.filter((entry) => entry.status === "Absent").forEach((entry) => absentWorkers.add(entry.worker));
  if (isAbsentToday()) absentWorkers.add(currentWorker());
  const clockedOutWorkers = new Set(completed.map((shift) => shift.worker));
  todayStates.filter((entry) => entry.status === "Clocked Out").forEach((entry) => clockedOutWorkers.add(entry.worker));
  const totalHours = summarize(operationsHourSegments()).workMs;

  els.clockedInCount.textContent = String(clockedInWorkers.size);
  els.clockedOutCount.textContent = String([...clockedOutWorkers].filter((worker) => !clockedInWorkers.has(worker) && !absentWorkers.has(worker)).length);
  els.teamHours.textContent = durationLabel(totalHours);

  const groups = buildOperationsGroups(absentWorkers);
  els.teamList.innerHTML = groups.length
    ? groups.map(renderOperationsGroup).join("")
    : `<p class="empty-state">No clocked-in, clocked-out, or absent employees today</p>`;
  bindTransferExpansionState();
}

function operationsHourSegments() {
  const segments = [];
  payroll.submissions
    .filter((row) => row.date === todayKey())
    .forEach((row) => {
      segments.push({
        sourceId: row.submissionId || "",
        worker: row.worker,
        jobsite: row.jobsite,
        start: row.clockInAt,
        end: row.clockOutAt,
      });
    });
  state.shifts
    .filter((shift) => localDateKey(new Date(shift.start)) === todayKey())
    .forEach((shift) => {
      segments.push({
        sourceId: shift.id,
        worker: shift.worker,
        jobsite: shift.jobsite,
        start: shift.start,
        end: shift.end,
      });
    });
  payroll.clockStates
    .filter((entry) => entry.date === todayKey() && entry.status === "Clocked In")
    .forEach((entry) => {
      segments.push({
        sourceId: entry.sessionId || "",
        worker: entry.worker,
        jobsite: entry.jobsite,
        start: entry.clockInAt,
        end: "",
      });
    });
  Object.values(state.activeShifts)
    .filter((shift) => localDateKey(new Date(shift.start)) === todayKey())
    .forEach((shift) => {
      segments.push({
        sourceId: shift.id,
        worker: shift.worker,
        jobsite: shift.jobsite,
        start: shift.start,
        end: "",
      });
    });
  return dedupeSegments(segments);
}

// Manager display projection only. No storage writes, attendance capture or reminder decisions.
function attendanceVisibilityScopeV30() {
  const scope = JSON.stringify([currentWorker(), state.auth?.token || "", todayKey()]);
  if (attendanceVisibilityV30.scope !== scope) attendanceVisibilityV30 = {scope, snapshot: null, reviews: null};
  return attendanceVisibilityV30;
}
function attendanceVisibilityViewV30() {
  const cache = attendanceVisibilityScopeV30();
  const freshness = operationsFreshnessV30();
  const verified = !authExpiredV30() && crewVacationAlertsAvailable();
  const absent = new Set(payroll.absences.filter(e => e.date === todayKey() && e.status === "Absent").map(e => e.worker));
  payroll.clockStates.filter(e => e.date === todayKey() && e.status === "Absent").forEach(e => absent.add(e.worker));
  if (isAbsentToday()) absent.add(currentWorker());
  if (verified) {
    cache.snapshot = {at: operationsReadV30.loadedAt,
      missing: activeAttendanceEmployees()
        .filter(e => !crewVacationFor(e.worker) && !hasAttendanceClockInToday(e.worker) && !absent.has(e.worker))
        .map(e => ({worker:e.worker, status:"Not Clocked In", statusClass:"pending"})).sort(compareAlertPeople),
      clockedIn: payroll.clockStates.filter(e => e.date === todayKey() && e.status === "Clocked In")
        .map(e => ({worker:e.worker, status:"Still Clocked In", statusClass:"",jobsite:e.jobsite,clockIn:e.clockInAt})).sort(compareAlertPeople)};
  }
  // Positive evidence may remove an obsolete cached alert, never create a new missing-attendance decision.
  const missing = (cache.snapshot?.missing || []).filter(e =>
    activeAttendanceEmployees().some(a => a.worker === e.worker) && !hasAttendanceClockInToday(e.worker)
      && !absent.has(e.worker) && !crewVacationFor(e.worker));
  const notice = verified ? "Verified current attendance." : freshness.status === "loading" && cache.snapshot
    ? "Refreshing… Showing last verified attendance."
    : "Attendance alerts temporarily paused. " + (cache.snapshot ? "Showing cached attendance counts." : "No verified count available.");
  const clockedIn = (cache.snapshot?.clockedIn || []).filter(e => !absent.has(e.worker)
    && !payroll.clockStates.some(r => r.worker === e.worker && r.date === todayKey() && r.status === "Clocked Out")
    && !state.shifts.some(r => r.worker === e.worker && localDateKey(new Date(r.start)) === todayKey() && r.end));
  return {verified, missing, clockedIn, lastVerifiedAt:cache.snapshot?.at || null, countKnown:!!cache.snapshot,
    countLabel:verified ? "current" : cache.snapshot ? "cached" : "", notice};
}
function previousShiftReviewSectionV30() {
  const cache = attendanceVisibilityScopeV30(), view = payroll.openShiftReviews;
  const valid = view?.status === "available" && view.date === todayKey() && Array.isArray(view.items)
    && view.items.every(e => typeof e.worker === "string" && e.worker && typeof e.jobsite === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date < todayKey() && typeof e.clockInAt === "string" && Number.isFinite(Date.parse(e.clockInAt)));
  const fresh = !authExpiredV30() && operationsFreshnessV30().status === "current" && valid;
  if (fresh) cache.reviews = {at:operationsReadV30.loadedAt,items:view.items.map(e => ({worker:e.worker,
    jobsite:e.jobsite,status:"Office review",statusClass:"pending",detail:e.date + " — unresolved previous-day shift",clockIn:e.clockInAt}))};
  return {key:"previousOpenShifts",title:"Previous-day shifts — office review",actionable:fresh && !!cache.reviews?.items.length,
    people:cache.reviews?.items || [],countKnown:!!cache.reviews,countLabel:fresh ? "current" : cache.reviews ? "cached" : "",
    notice:fresh ? "" : cache.reviews ? "Previous-day shift review uses cached data." : "Previous-day shift review unavailable; no verified count available."};
}

function buildOperationsGroups(absentWorkers) {
  const groups = new Map();
  const vacationGroup = {jobsite: "Vacation", colour: "#7353a6", people: [], isVacation: true};
  const absentGroup = {
    jobsite: "Absent Today",
    colour: "#b42318",
    people: [],
    absent: true,
  };

  payroll.employees.forEach((employee) => {
    const stateRow = payroll.clockStates.find((entry) => entry.worker === employee.worker && entry.date === todayKey());
    const localActive = state.activeShifts[employee.worker];
    const active = (localActive && localDateKey(new Date(localActive.start)) === todayKey() ? localActive : null) || (stateRow?.status === "Clocked In" ? {
      worker: employee.worker,
      jobsite: stateRow.jobsite,
      start: stateRow.clockInAt,
    } : null);
    const activeForHistory = active || null;
    const pendingSync = state.shifts.find(s => s.worker === employee.worker && localDateKey(new Date(s.start)) === todayKey() && s.syncStatus !== "saved");
    const recent = latestCompletedSegmentFor(employee.worker);
    const clockOutAt = latestCompletedClockOutFor(employee.worker) || stateRow?.clockOutAt || recent?.end || "";
    const transferHistory = transferHistoryFor(employee.worker, activeForHistory);
    const absent = absentWorkers.has(employee.worker);
    const clockedOut = !!recent || stateRow?.status === "Clocked Out";

    const vacation = crewVacationFor(employee.worker);
    const work = !!active || clockedOut || !!pendingSync;
    if (vacation && !work) {
      vacationGroup.people.push({worker: employee.worker, status: "Vacation", statusClass: "vacation", vacation, existingAbsence: absent, canRemoveAbsence: absent && canMarkEmployeeAbsent()});
      return;
    }
    if (!active && !absent && !clockedOut && !pendingSync) return;

    if (absent && !(vacation && work)) {
      absentGroup.people.push({
        worker: employee.worker,
        status: "Absent",
        statusClass: "absent",
        clockIn: "",
        canRemoveAbsence: canMarkEmployeeAbsent(),
        vacation, vacationConflict: !!vacation && work,
      });
      return;
    }

    const jobsite = active?.jobsite || recent?.jobsite || stateRow?.jobsite || "Unknown Jobsite";
    const site = findJobsite(jobsite);
    if (!groups.has(jobsite)) {
      groups.set(jobsite, {
        jobsite,
        colour: site?.colour || "#007f73",
        people: [],
      });
    }

    groups.get(jobsite).people.push({
      worker: employee.worker,
      status: pendingSync ? syncLabel(pendingSync) : active ? "Clocked In" : clockOutAt ? `Clocked Out ${timeLabel(clockOutAt)}` : "Clocked Out",
      statusClass: pendingSync ? syncClass(pendingSync) : active ? "" : "out",
      clockIn: active?.start || recent?.start || stateRow?.clockInAt || "",
      vacation, vacationConflict: !!vacation && work, existingAbsence: absent,
      switched: transferHistory.length > 0,
      transferHistory,
    });
  });

  const jobsiteGroups = [...groups.values()]
    .filter((group) => group.people.length)
    .sort((a, b) => a.jobsite.localeCompare(b.jobsite));

  if (vacationGroup.people.length || crewVacationIndicatorV30()) jobsiteGroups.push(vacationGroup);
  if (absentGroup.people.length) jobsiteGroups.push(absentGroup);
  const visibility = attendanceVisibilityViewV30();
  jobsiteGroups.push({jobsite: "Not Clocked In", colour: "#a46b16", people: visibility.missing,
    notice: visibility.notice, countKnown: visibility.countKnown, countLabel: visibility.countLabel});
  const review = previousShiftReviewSectionV30();
  if (review.people.length || review.notice) jobsiteGroups.push({jobsite: review.title, colour: "#a46b16",
    people: review.people, notice: review.notice, countKnown: review.countKnown, countLabel: review.countLabel});
  return jobsiteGroups;
}

function renderOperationsGroup(group) {
  const colour = escapeAttribute(group.colour || "#007f73");
  return `
    <section class="jobsite-group" style="--row-site-color:${colour}">
      <header class="jobsite-group-header">
        <span class="jobsite-colour" aria-hidden="true"></span>
        <strong>${escapeHtml(group.jobsite)}${group.isVacation && crewVacationIndicatorV30() ? `<small class="vacation-data-indicator" role="status">${escapeHtml(crewVacationIndicatorV30())}</small>` : ""}</strong>
        <span>${group.countKnown === false ? "—" : group.people.length}${group.countLabel ? ` · ${escapeHtml(group.countLabel)}` : ""}</span>
      </header>
      <div class="jobsite-crew">
        ${group.notice ? `<p role="status">${escapeHtml(group.notice)}</p>` : ""}
        ${group.people.map(renderOperationsPerson).join("")}
      </div>
    </section>
  `;
}

function renderOperationsPerson(person) {
  const content = `
    <div class="avatar">${escapeHtml(initials(person.worker))}</div>
    <div class="person-main">
      <div>
        <span class="person-name">${escapeHtml(person.worker)}</span>
        ${person.clockIn ? `<span class="person-sub">Clock-in ${timeLabel(person.clockIn)}</span>` : ""}
          ${person.detail ? `<span class="person-sub">${escapeHtml(person.detail)}</span>` : ""}
      </div>
      <span class="person-status-stack">
        ${person.vacation && person.canRemoveAbsence ? `<span class="mini-pill vacation">Vacation</span>` : ""}
        ${person.canRemoveAbsence
          ? `<button class="mini-pill absence-remove-button" type="button" data-worker="${escapeHtml(person.worker)}">Undo Absent</button>`
          : `<span class="mini-pill ${person.statusClass}">${escapeHtml(person.status)}</span>`}
        ${person.vacation ? `<span class="vacation-dates">${escapeHtml(person.vacation.start)} → ${escapeHtml(person.vacation.end)}</span>` : ""}
        ${person.vacationConflict ? `<span class="mini-pill vacation-conflict">Vacation/work conflict</span>` : ""}
        ${person.existingAbsence ? `<span class="mini-pill absent">Existing Absent record</span>` : ""}
        ${person.switched ? `<span class="switch-indicator">↔ Switched</span>` : ""}
      </span>
    </div>
  `;
  if (person.switched) {
    const open = isTransferExpanded(person.worker) ? " open" : "";
    return `
      <details class="person-card transfer-person" data-worker="${escapeHtml(person.worker)}"${open}>
        <summary class="person-summary">${content}</summary>
        ${renderTransferHistory(person.transferHistory)}
      </details>
    `;
  }
  return `
    <article class="person-card">
      ${content}
    </article>
  `;
}

function bindTransferExpansionState() {
  els.teamList.querySelectorAll(".transfer-person").forEach((details) => {
    details.addEventListener("toggle", () => {
      const worker = details.dataset.worker || "";
      if (!worker) return;
      if (details.open) {
        state.expandedTransfers[worker] = true;
      } else {
        delete state.expandedTransfers[worker];
      }
      saveState();
    });
  });
}

function isTransferExpanded(worker) {
  return !!state.expandedTransfers?.[worker];
}

function renderTransferHistory(transfers) {
  return `
    <div class="transfer-history">
      ${transfers.map((transfer) => `
        <div class="transfer-event">
          <span>${transfer.transferTime ? timeLabel(transfer.transferTime) : "Transfer"}</span>
          <strong>${escapeHtml(transfer.previousJobsite)} → ${escapeHtml(transfer.currentJobsite)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function latestCompletedSegmentFor(worker) {
  const segments = completedSegmentsFor(worker);
  return segments.length ? segments[segments.length - 1] : null;
}

function latestCompletedClockOutFor(worker) {
  return completedSegmentsFor(worker).reduce((latest, segment) => latestTime(latest, segment.end), "");
}

function transferHistoryFor(worker, active) {
  const segments = completedSegmentsFor(worker);
  if (active?.jobsite) {
    segments.push({
      worker,
      jobsite: active.jobsite,
      start: active.start || "",
      end: "",
      current: true,
    });
  }
  segments.sort(compareSegments);

  const transfers = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (keyForCompare(previous.jobsite) && keyForCompare(current.jobsite) && keyForCompare(previous.jobsite) !== keyForCompare(current.jobsite)) {
      transfers.push({
        previousJobsite: previous.jobsite,
        transferTime: current.start || previous.end || "",
        currentJobsite: current.jobsite,
      });
    }
  }
  return transfers;
}

function completedSegmentsFor(worker) {
  const segments = [];
  payroll.submissions
    .filter((row) => row.worker === worker && row.date === todayKey())
    .forEach((row) => {
      segments.push({
        sourceId: row.submissionId || "",
        worker: row.worker,
        jobsite: row.jobsite,
        start: row.clockInAt,
        end: row.clockOutAt,
      });
    });
  state.shifts
    .filter((shift) => shift.worker === worker && localDateKey(new Date(shift.start)) === todayKey())
    .forEach((shift) => {
      segments.push({
        sourceId: shift.id,
        worker: shift.worker,
        jobsite: shift.jobsite,
        start: shift.start,
        end: shift.end,
      });
    });
  return dedupeSegments(segments).sort(compareSegments);
}

function dedupeSegments(segments) {
  const seen = new Set();
  return segments.filter((segment) => {
    if (!segment.worker || !segment.jobsite || !segment.start) return false;
    const key = [
      keyForCompare(segment.worker),
      keyForCompare(segment.jobsite),
      segment.start || "",
      segment.end || "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dailyTimeSummaryFor(worker, dateKey) {
  const summary = emptyDailyTimeSummary(dateKey);
  const workerKey = keyForCompare(worker);
  payroll.submissions
    .filter((row) => keyForCompare(row.worker) === workerKey && row.date === dateKey)
    .forEach((row) => mergeCompletedTime(summary, row.clockInAt, row.clockOutAt));

  state.shifts
    .filter((shift) => keyForCompare(shift.worker) === workerKey && localDateKey(new Date(shift.start)) === dateKey && shift.syncStatus === "saved")
    .forEach((shift) => mergeCompletedTime(summary, shift.start, shift.end));

  payroll.clockStates
    .filter((entry) => keyForCompare(entry.worker) === workerKey && entry.date === dateKey)
    .forEach((entry) => {
      if (entry.status === "Clocked In") mergeOpenTime(summary, entry.clockInAt);
      if (entry.status === "Clocked Out") mergeCompletedTime(summary, entry.clockInAt, entry.clockOutAt);
    });

  const active = state.activeShifts[worker];
  if (active && localDateKey(new Date(active.start)) === dateKey) mergeOpenTime(summary, active.start);
  const unsynced = state.shifts.filter(shift => keyForCompare(shift.worker) === workerKey && localDateKey(new Date(shift.start)) === dateKey && shift.syncStatus !== "saved");
  if (unsynced.length) { summary.pendingSync = true; summary.needsAttention = unsynced.some(s => s.syncStatus === "failed"); unsynced.forEach(shift => mergeCompletedTime(summary, shift.start, shift.end)); }
  summary.incomplete = !!summary.clockInAt && !summary.clockOutAt && !summary.pending;
  return summary;
}

function emptyDailyTimeSummary(dateKey) {
  return {
    date: dateKey,
    clockInAt: "",
    clockOutAt: "",
    pending: false,
    incomplete: false,
  };
}

function mergeCompletedTime(summary, start, end) {
  if (start) summary.clockInAt = earliestTime(summary.clockInAt, start);
  if (end) summary.clockOutAt = latestTime(summary.clockOutAt, end);
}

function mergeOpenTime(summary, start) {
  if (start) summary.clockInAt = earliestTime(summary.clockInAt, start);
  summary.pending = true;
}

function earliestTime(current, candidate) {
  if (!candidate) return current || "";
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function latestTime(current, candidate) {
  if (!candidate) return current || "";
  if (!current) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function compareSegments(a, b) {
  return segmentTimeValue(a) - segmentTimeValue(b);
}

function segmentTimeValue(segment) {
  const value = Date.parse(segment.start || segment.end || "");
  return Number.isNaN(value) ? 0 : value;
}

function keyForCompare(value) {
  return String(value ?? "").trim().toLowerCase();
}

function renderAlerts() {
  if (!canUseAlerts()) {
    els.alertsList.innerHTML = "";
    return;
  }
  const groups = buildAlertGroups();
  const signature = alertGroupsSignature(groups);
  if (els.alertsList.dataset.alertSignature === signature) return;
  els.alertsList.innerHTML = groups.map(renderAlertGroup).join("");
  els.alertsList.dataset.alertSignature = signature;
  bindAlertSectionState();
}

function alertGroupsSignature(groups) {
  return JSON.stringify(groups.map((group) => ({
    title: group.title,
    sections: group.sections.filter(Boolean).map((section) => ({
      key: section.key,
      title: section.title,
      actionable: !!section.actionable,
      people: section.people, notice: section.notice || "", countKnown: section.countKnown, countLabel: section.countLabel || "",
    })),
  })));
}

function buildAlertSections() {
  const failed = state.shifts.filter((shift) => shift.syncStatus === "failed");
  const pending = state.shifts.filter((shift) => shift.syncStatus === "pending");
  const scheduleProblems = state.scheduleReports.filter((report) => report.syncStatus === "failed" || report.syncStatus === "pending");
  const absentWorkers = new Set(payroll.absences
    .filter((entry) => entry.date === todayKey() && entry.status === "Absent")
    .map((entry) => entry.worker));
  if (isAbsentToday()) absentWorkers.add(currentWorker());

  const switchedPeople = switchedJobsitePeople();

  return [
    {
      key: "notClockedIn",
      title: "Not Clocked In",
      people: attendanceVisibilityViewV30().missing,
      actionable: attendanceVisibilityViewV30().verified,
      notice: attendanceVisibilityViewV30().notice,
      countKnown: attendanceVisibilityViewV30().countKnown,
      countLabel: attendanceVisibilityViewV30().countLabel,
    },
    {
      key: "stillClockedIn",
      title: "Still Clocked In",
      people: isAfterStillClockedInAlertTime() ? attendanceVisibilityViewV30().clockedIn : [],
      actionable: attendanceVisibilityViewV30().verified,
      notice: attendanceVisibilityViewV30().notice,
      countKnown: attendanceVisibilityViewV30().countKnown,
      countLabel: attendanceVisibilityViewV30().countLabel,
    },
    previousShiftReviewSectionV30(),
    {
      key: "saveProblems",
      title: "Save Problems",
      actionable: true,
      people: failed.concat(pending)
        .map((shift) => ({
          worker: shift.worker,
          status: syncLabel(shift),
          statusClass: shift.syncStatus === "pending" ? "pending" : "failed",
          detail: shift.error || (shift.syncStatus === "pending" ? "Waiting to save" : "Save failed, try again"),
        }))
        .concat(scheduleProblems.map((report) => ({
          worker: report.worker,
          status: report.syncStatus === "pending" ? "Crew Schedule Pending" : "Crew Schedule Failed",
          statusClass: report.syncStatus === "pending" ? "pending" : "failed",
          detail: report.error || `${report.jobsite} schedule not synced`,
        })))
        .sort(compareAlertPeople),
    },
    {
      key: "switchedJobsite",
      title: "Switched Jobsite",
      actionable: false,
      people: switchedPeople,
    },
    {
      key: "absentToday",
      title: "Absent Today",
      actionable: false,
      people: [...absentWorkers]
        .map((worker) => ({
          worker,
          status: "Absent",
          statusClass: "absent",
        }))
        .sort(compareAlertPeople),
    },
  ];
}

function buildAlertGroups() {
  const sections = buildAlertSections();
  const byKey = new Map(sections.map((section) => [section.key, section]));
  return [
    {
      title: "Needs Attention",
      sections: ["notClockedIn", "stillClockedIn", "previousOpenShifts", "saveProblems"].map((key) => byKey.get(key)),
    },
    {
      title: "Today's Activity",
      sections: ["switchedJobsite", "absentToday"].map((key) => byKey.get(key)),
    },
  ];
}

function switchedJobsitePeople() {
  return payroll.employees
    .map((employee) => {
      const stateRow = payroll.clockStates.find((entry) => entry.worker === employee.worker && entry.date === todayKey());
      const active = state.activeShifts[employee.worker] || (stateRow?.status === "Clocked In" ? {
        worker: employee.worker,
        jobsite: stateRow.jobsite,
        start: stateRow.clockInAt,
      } : null);
      const transferHistory = transferHistoryFor(employee.worker, active || null);
      if (!transferHistory.length) return null;
      const latest = transferHistory[transferHistory.length - 1];
      return {
        worker: employee.worker,
        status: "Switched",
        statusClass: "",
        jobsite: latest.currentJobsite,
        detail: `${latest.previousJobsite} → ${latest.currentJobsite}`,
        clockIn: latest.transferTime,
        details: transferHistory.map((transfer) => ({
          time: transfer.transferTime,
          text: `${transfer.previousJobsite} → ${transfer.currentJobsite}`,
        })),
      };
    })
    .filter(Boolean)
    .sort(compareAlertPeople);
}

function alertItemCount(sections) {
  return sections.reduce((total, section) => total + section.people.length, 0);
}

function compareAlertPeople(a, b) {
  return a.worker.localeCompare(b.worker);
}

function renderAlertGroup(group) {
  return `
    <section class="alert-group">
      <h3>${escapeHtml(group.title)}</h3>
      <div class="alert-group-sections">
        ${group.sections.filter(Boolean).map(renderAlertSection).join("")}
      </div>
    </section>
  `;
}

function renderAlertSection(section) {
  const open = isAlertSectionExpanded(section.key) ? " open" : "";
  const empty = section.people.length ? "" : " empty";
  return `
    <details class="alert-section${empty}" data-alert-section="${escapeAttribute(section.key)}"${open}>
      <summary class="alert-section-header">
        <span class="alert-chevron" aria-hidden="true"></span>
        <strong>${escapeHtml(section.title)}</strong>
        <span class="alert-count">${section.countKnown === false ? "—" : section.people.length}${section.countLabel ? ` · ${escapeHtml(section.countLabel)}` : ""}</span>
      </summary>
      <div class="alert-people">
        ${section.notice ? `<p role="status">${escapeHtml(section.notice)}</p>` : ""}
        ${section.people.length ? section.people.map(renderAlertPerson).join("") : `<p class="empty-state">${section.countKnown === false ? "No verified count available." : section.countLabel === "cached" ? "No items in the cached list." : "No items right now."}</p>`}
      </div>
    </details>
  `;
}

function bindAlertSectionState() {
  if (!state.expandedAlertSections) state.expandedAlertSections = {};
  els.alertsList.querySelectorAll(".alert-section").forEach((section) => {
    section.addEventListener("toggle", () => {
      const key = section.dataset.alertSection || "";
      if (!key) return;
      if (section.open) {
        state.expandedAlertSections[key] = true;
      } else {
        delete state.expandedAlertSections[key];
      }
      saveState();
    });
  });
}

function isAlertSectionExpanded(key) {
  return !!state.expandedAlertSections?.[key];
}

function renderAlertPerson(person) {
  return `
    <article class="alert-person">
      <div class="avatar">${escapeHtml(initials(person.worker))}</div>
      <div class="person-main">
        <div>
          <span class="person-name">${escapeHtml(person.worker)}</span>
          ${person.jobsite ? `<span class="person-sub">${escapeHtml(person.jobsite)}</span>` : ""}
          ${person.clockIn ? `<span class="person-sub">Clock-in ${timeLabel(person.clockIn)}</span>` : ""}
          ${person.detail ? `<span class="person-sub">${escapeHtml(person.detail)}</span>` : ""}
          ${person.details ? person.details.map((detail) => `<span class="person-sub">${detail.time ? `${timeLabel(detail.time)} ` : ""}${escapeHtml(detail.text)}</span>`).join("") : ""}
        </div>
        <span class="mini-pill ${person.statusClass || ""}">${escapeHtml(person.status)}</span>
      </div>
    </article>
  `;
}

function renderJobsiteSelect(select, selectedValue, options = {}) {
  const includePlaceholder = !!options.placeholder;
  const placeholder = `<option value="">Select a jobsite...</option>`;
  const selectOptions = payroll.jobsites.map((jobsite) => {
    return `<option value="${escapeHtml(jobsite.jobsite)}">${escapeHtml(jobsite.jobsite)}</option>`;
  });
  const optionsHtml = selectOptions.length
    ? `${includePlaceholder ? placeholder : ""}${selectOptions.join("")}`
    : `<option value="">No active jobsites</option>`;
  const optionsSignature = JSON.stringify({
    placeholder: includePlaceholder,
    jobsites: payroll.jobsites.map((jobsite) => jobsite.jobsite),
  });
  const desiredValue = payroll.jobsites.some((jobsite) => jobsite.jobsite === selectedValue) ? selectedValue : "";

  if (document.activeElement === select) {
    return;
  }

  if (select.dataset.optionsSignature !== optionsSignature) {
    select.innerHTML = optionsHtml;
    select.dataset.optionsSignature = optionsSignature;
  }

  if (select.value !== desiredValue) {
    select.value = desiredValue;
  }
}

function syncStatusText() {
  if (offlineError) return "Needs Attention — " + offlineError;
  const rows = state.shifts.filter(s => s.worker === currentWorker());
  if (rows.some(s => s.syncStatus === "failed")) return "Needs Attention — local records retained; Retry Saves or contact office";
  const count = rows.filter(s => s.syncStatus !== "saved").length;
  if (count) return `Pending Sync — ${count} recorded on this device`;
  return state.lastSync || "Ready";
}

function crewScheduleStatusLabel(shift) {
  const report = shift.crewScheduleId ? state.scheduleReports.find((item) => item.id === shift.crewScheduleId) : null;
  if (!report) return "";
  if (report.syncStatus === "saved") return "Crew schedule saved";
  if (report.syncStatus === "failed") return `Crew schedule not synced: ${report.error || "Retry Saves"}`;
  if (report.syncStatus === "pending" || report.syncStatus === "waiting") return "Crew schedule pending";
  return "";
}

function summarize(shifts) {
  return shifts.reduce(
    (totals, shift) => {
      totals.workMs += workedMs(shift);
      totals.jobsites.add(shift.jobsite);
      return totals;
    },
    { workMs: 0, jobsites: new Set() }
  );
}

function workedMs(shift) {
  const end = shift.end ? new Date(shift.end) : new Date();
  return Math.max(0, end - new Date(shift.start));
}

function shiftDurationLabel(shift) {
  return durationLabel(workedMs(shift));
}

function durationLabel(ms) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function timeLabel(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  }).format(new Date(iso));
}

function compactDateDayLabel(dateKey) {
  const date = dateFromKey(dateKey);
  if (!date) return dateKey || "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: APP_TIME_ZONE,
  }).format(date).replace(",", "");
}

function dateLabel(dateKey) {
  const date = dateFromKey(dateKey);
  if (!date) return dateKey || "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: APP_TIME_ZONE,
  }).format(date);
}

function dateFromKey(dateKey) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
}

function dateWithinPeriod(dateKey, period) {
  return !!dateKey && !!period?.start && !!period?.end && dateKey >= period.start && dateKey <= period.end;
}

function isAfterStillClockedInAlertTime(date = new Date()) {
  return localMinutesOfDay(date) >= minutesFromTime(STILL_CLOCKED_IN_ALERT_TIME);
}

function localMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((memo, part) => {
      memo[part.type] = part.value;
      return memo;
    }, {});
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

function minutesFromTime(hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

function travelLabel(shift) {
  if (shift.travelTo) return `Switched to ${shift.travelTo}`;
  if (shift.travelFrom) return `Started after ${shift.travelFrom}`;
  return "";
}

function syncLabel(shift) {
  return shift.syncStatus === "saved" ? "Saved" : shift.syncStatus === "failed" ? "Needs Attention" : "Pending Sync";
}

function syncClass(shift) {
  if (shift.syncStatus === "saved") return "saved";
  if (shift.syncStatus === "failed") return "failed";
  if (shift.syncStatus === "pending") return "pending";
  return "";
}

function findJobsite(name) {
  return payroll.jobsites.find((jobsite) => jobsite.jobsite === name) || null;
}

function setConnection(mode, message) {
  if (mode === "ready" && !serverVerifiedV30()) {
    mode = "error";
    message = recoveryV30.error || "Server connection not verified. Local records retained; reconnect or refresh.";
  }
  els.connectionBar.className = `connection-bar ${mode === "ready" ? "ready" : mode === "error" ? "error" : ""}`;
  const statusText = mode === "ready"
    ? "Connected to Payroll 2.0"
    : mode === "error"
      ? connectionErrorTitle(message)
      : "Connecting to Payroll 2.0";
  els.connectionText.textContent = statusText;
  els.connectionBar.dataset.detail = message || "";
  els.connectionBar.setAttribute("aria-label", message ? `${statusText}: ${message}` : statusText);
}

function connectionErrorTitle(message) {
  const text = String(message || "");
  if (/network|offline|failed to fetch|load failed|connection failed/i.test(text)) return "Lost connection to Payroll 2.0";
  return "Payroll 2.0 needs attention";
}

function setLoginMessage(message, isError = false) {
  els.loginMessage.textContent = message;
  els.loginMessage.classList.toggle("error", isError);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function todayKey(date = new Date()) {
  return localDateKey(date);
}

function localDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((memo, part) => {
      memo[part.type] = part.value;
      return memo;
    }, {});
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  return `${year}-${month}-${day}`;
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `shift-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replaceAll("-", "+").replaceAll("_", "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function initials(name) {
  return String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function clockIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v7l4 2"/><circle cx="12" cy="12" r="9"/></svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  const text = String(value ?? "");
  if (text.includes(";") || text.includes("{") || text.includes("}")) return "#007f73";
  if (globalThis.CSS?.supports?.("color", text)) return text;
  return "#007f73";
}


function scheduleConfirmationV30(report) {
  return Object.fromEntries(["id", "worker", "role", "date", "jobsite", "scheduledStart", "scheduledEnd", "reportedAt", "source", "sourceSessionId", "deviceId"].map(k => [k, report[k] || ""]));
}
function storageFailureV30(error) {
  offlineError = error?.message || "Local storage failed. Clock-out was NOT confirmed locally.";
  setConnection("error", "Needs Attention — " + offlineError);
  showToast("Needs Attention — " + offlineError);
  render();
}
async function initializeOffline() {
  await outbox.open();
  // Request durable storage when supported; refusal never deletes or resets records.
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const legacyRaw = localStorage.getItem(STORAGE_KEY);
  const legacy = legacyRaw ? JSON.parse(legacyRaw) : {};
  const migrationHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CrewClockOutbox.stable({ shifts: legacy.shifts || [], scheduleReports: legacy.scheduleReports || [], deviceId: legacy.deviceId || "" }))))).map(b => b.toString(16).padStart(2, "0")).join("");
  const migrated = await outbox.meta("migration-v29-complete");
  if (migrated?.snapshotHash !== migrationHash) {
    if (legacyRaw) {
      for (const oldShift of legacy.shifts || []) {
        if (!oldShift.end) continue;
        const schedule = (legacy.scheduleReports || []).find(r => r.linkedShiftId === oldShift.id);
        const shift = { ...oldShift, deviceId: legacy.deviceId || "", ...(schedule ? { crewSchedule: schedule } : {}) };
        try {
          await outbox.enqueue(shift, toSubmissionPayload(shift), schedule ? toCrewSchedulePayload(schedule, shift, "") : null, { verifyOnly: oldShift.syncStatus === "saved" });
        } catch (error) {
          // Conflicting variants were committed to quarantine. Incomplete records stay in untouched V29 storage.
          if (!/Conflicting records/.test(error.message)) throw error;
        }
      }
    }
    await outbox.meta("migration-v29-complete", { completedAt: new Date().toISOString(), snapshotHash: migrationHash });
  }
  // If the database was lost but the separate UI backup survives, recover missing entries without replacing existing ones.
  const known = new Set((await outbox.list()).map(r => r.key));
  for (const shift of state.shifts || []) {
    if (!shift.end || known.has(JSON.stringify([shift.worker, shift.id]))) continue;
    const schedule = shift.crewSchedule || (state.scheduleReports || []).find(r => r.linkedShiftId === shift.id);
    const copy = { ...shift, deviceId: shift.deviceId || state.deviceId, ...(schedule ? { crewSchedule: schedule } : {}) };
    try { await outbox.enqueue(copy, toSubmissionPayload(copy), schedule ? toCrewSchedulePayload(schedule, copy, "") : null, { verifyOnly: shift.syncStatus === "saved" }); }
    catch (error) { if (!/Conflicting records/.test(error.message)) throw error; }
  }
  const cache = state.auth ? await outbox.meta("bootstrap:" + currentWorker()) : null;
  if (cache) { payroll = { ...payroll, ...cache }; offlineClockInGrant = cache.offlineClockInGrant || null; }
  await hydrateOutboxV30();
  offlineReady = true;
  render();
  if (state.auth) {
    await loadBootstrap();
    await syncOutbox();
  }
}
async function hydrateOutboxV30() {
  const entries = (await outbox.list()).sort((a,b) => Date.parse(a.shift.end) - Date.parse(b.shift.end));
  for (const entry of entries) {
    const shift = { ...entry.shift, syncStatus: entry.status === "saved" ? "saved" : entry.status === "attention" ? "failed" : "pending",
      error: entry.error || "", submissionId: entry.receipt?.submissionId || "" };
    state.shifts = state.shifts.filter(s => !(s.worker === shift.worker && s.id === shift.id));
    state.shifts.push(shift);
    if (shift.crewSchedule) {
      queueCrewScheduleReport({ ...shift.crewSchedule, syncStatus: shift.syncStatus, error: shift.error });
    }
    // Recover local side effects after a process was killed just after IndexedDB commit.
    if (state.activeShifts[shift.worker]?.id === shift.id) applyCompletedShiftSideEffects(shift);
  }
  const starts = (await clockIns.list()).sort((a,b)=>Date.parse(a.shift.start)-Date.parse(b.shift.start));
  clockInSnapshot = starts;
  for (const entry of starts) {
    const shift=entry.shift;
    if (state.shifts.some(s=>s.worker===shift.worker&&s.id===shift.id)) continue;
    const active=state.activeShifts[shift.worker];
    if (!active || active.id===shift.id || Date.parse(active.start)<Date.parse(shift.start)) state.activeShifts[shift.worker]={...shift,clockInSyncStatus:entry.status};
  }
  state.shifts.sort((a,b) => Date.parse(b.end) - Date.parse(a.end));
}
async function sendOutboxV30(action, payload, worker, token) {
  if (!state.auth || currentWorker() !== worker || state.auth.token !== token) throw Object.assign(new Error("Sign in as the original worker to sync this record."), { needsAttention: true });
  if (authExpiredV30() || recoveryV30.renewalWorker) {
    const error = new Error("Session expired. Renew sign-in as the original worker. Records retained.");
    recoveryFailureV30(error); throw error;
  }
  // Bound the entire response, including body parsing. Original payload stays immutable after timeout.
  let timer;
  try {
    return await Promise.race([
      apiPost(action, { ...payload, token }),
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error("Server receipt timed out. Original clock-out retained for retry.")), 25000); })
    ]);
  } finally { window.clearTimeout(timer); }
}
async function syncCompletedOutboxV30(manual = false) {
  if (!offlineReady || !state.auth || navigator.onLine === false) return;
  if (authExpiredV30() || recoveryV30.renewalWorker) { recoveryFailureV30(new Error("Session expired. Sign in again.")); return; }
  const worker = currentWorker(), token = state.auth.token;
  try {
    await outbox.drain(worker, async (action, payload) => {
      if (action === "saveShift" && payload.shift.requiresClockInReceipt) {
        const start = (await clockIns.list()).find(e=>e.immutable.payload.worker===worker && e.immutable.payload.clientShiftId===payload.shift.clientShiftId);
        if (!start || start.status!=="saved") throw Object.assign(new Error("Clock-in is awaiting a verified receipt. Original clock-out retained."),{needsAttention:!start || start.status==="attention"});
      }
      return sendOutboxV30(action,payload,worker,token);
    }, {
      manual,
      canSend: w => !!state.auth && currentWorker() === w && state.auth.token === token && navigator.onLine !== false,
      onChange: async () => { await hydrateOutboxV30(); saveState(); render(); },
      onError: (error, entry) => {
        if (isSessionExpiredError(error)) setConnection("error", "Needs Attention — sign in again to sync. Original records retained.");
        // Preserve V29 best-effort manager save-problem alerts; never block the durable queue on push delivery.
        if (navigator.onLine !== false && state.auth?.token === token && currentWorker() === worker) {
          void (async () => {
            const noticeKey = "save-problem:" + entry.key;
            if (await outbox.meta(noticeKey)) return;
            await sendOutboxV30("notifySaveProblem", { shift: entry.immutable.payload, error: error.message }, worker, token);
            await outbox.meta(noticeKey, { notifiedAt: new Date().toISOString() });
          })().catch(() => {});
        }
      }
    });
    await hydrateOutboxV30();
    if (!state.shifts.some(s => s.worker === worker && s.syncStatus !== "saved") && !(await clockIns.list()).some(e=>e.shift.worker===worker&&e.status!=="saved")) {
      state.lastSync = "Saved to Payroll 2.0";
      // Queue state is not evidence of a live server connection.
      if (serverVerifiedV30()) setConnection("ready", state.lastSync);
    }
    saveState();
    render();
  } catch (error) { storageFailureV30(error); }
}
function resumeOfflineSync() {
  if (document.hidden) return;
  // Run update discovery even if the employee or website sign-in needs renewal.
  if (appUpdatesV30) void appUpdatesV30.checkNow();
  else if (!serviceWorkerRegistration) void registerServiceWorker();
  if (recoveryV30.resume) return recoveryV30.resume;
  recoveryV30.resume = (async () => {
    if (navigator.onLine === false) { setConnection("error", "Offline — local records retained."); return; }
    if (!offlineReady || !state.auth) return;
    await loadBootstrap({quiet:true});
    refreshMyHoursFromAppResume();
    if (!recoveryV30.renewalWorker) await syncOutbox();
  })().finally(() => { recoveryV30.resume = null; });
  return recoveryV30.resume;
}

const SYNC_PANEL_HTML_V30 = "<section class=\"my-hours-panel\" id=\"syncQueuePanel\" aria-label=\"Clock-out synchronization\">\n  <div class=\"section-heading\"><h2>Clock-out sync</h2><button class=\"text-button\" id=\"retryClockSavesButton\" type=\"button\">Retry Sync</button></div>\n  <p id=\"queueSummary\" role=\"status\" aria-live=\"polite\">Preparing local storage\u2026</p>\n  <div id=\"queueDetails\" class=\"timeline-list\"></div>\n</section>";

function ensureSyncPanelV30() {
  if (!document.querySelector("#syncQueuePanel")) {
    const holder = document.createElement("div");
    holder.innerHTML = SYNC_PANEL_HTML_V30;
    els.reminderPanel.before(holder.firstElementChild);
  }
  document.querySelector("#retryClockSavesButton").addEventListener("click", retryFailedSaves);
}
function renderCompletedSyncPanelV30() {
  const summary = document.querySelector("#queueSummary");
  if (!summary) return;
  const rows = state.shifts.filter(s => s.worker === currentWorker());
  const pending = rows.filter(s => s.syncStatus !== "saved");
  summary.textContent = offlineError ? "Needs Attention — " + offlineError : !offlineReady ? "Preparing safe local storage…" : pending.some(s => s.syncStatus === "failed") ? "Needs Attention — original records retained on this device." : pending.length ? `Pending Sync — ${pending.length} clock-out${pending.length === 1 ? "" : "s"} recorded on this device. ${navigator.onLine === false ? "Will retry when connected." : "Automatic retry is enabled."}` : rows.length ? "Saved — recorded clock-outs confirmed by Payroll 2.0." : "No clock-outs waiting to sync.";
  document.querySelector("#retryClockSavesButton").disabled = !offlineReady || localCaptureBusy || navigator.onLine === false;
  document.querySelector("#queueDetails").innerHTML = (pending.length ? pending : rows.slice(0, 1)).map(shift => `
    <article class="entry-card">
      <div class="entry-main"><div>
        <span class="entry-title">${escapeHtml(shift.jobsite)}</span>
        <span class="entry-sub">${escapeHtml(localDateKey(new Date(shift.start)))} · ${timeLabel(shift.start)} – ${timeLabel(shift.end)}</span>
        <span class="entry-sub">Lunch: ${escapeHtml(shift.lunch)}</span>
        ${shift.crewSchedule ? `<span class="entry-sub">Crew schedule: ${escapeHtml(shift.crewSchedule.scheduledStart)} – ${escapeHtml(shift.crewSchedule.scheduledEnd)}</span>` : ""}
        ${shift.error ? `<span class="entry-sub">${escapeHtml(shift.error)}</span>` : ""}
      </div><span class="mini-pill ${syncClass(shift)}">${syncLabel(shift)}</span></div>
    </article>`).join("");
}


async function readOnlyRequestV30(action,payload,canContinue=()=>true) {
  if(!["login","bootstrap","myHours"].includes(action))throw new Error("Automatic read retry is not permitted for this action.");
  for(let attempt=0;attempt<2;attempt++){
    if(!canContinue())throw new Error("Sign-in changed; previous response ignored.");
    try {
      const data=await apiPost(action,payload,{boundedRead:true});
      if(!canContinue())throw new Error("Sign-in changed; previous response ignored.");
      return data;
    } catch(error) {
      if(!canContinue()||attempt||navigator.onLine===false||!(error.isNetworkError||error.retryable))throw error;
      await new Promise(resolve=>window.setTimeout(resolve,750));
    }
  }
}


async function tokenDigestV30(token) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
}
function offlineClockInAllowedV30() {
  const grant=offlineClockInGrant;
  return !!(state.auth&&grant&&grant.worker===currentWorker()&&Number.isFinite(grant.expiresAt)&&Date.now()<grant.expiresAt&&Date.now()>=grant.checkedAt&&Date.now()-grant.checkedAt<86400000&&payroll.employees.some(e=>e.worker===currentWorker())&&payroll.jobsites.length);
}
function clockInPayloadV30(shift) {
  return {clientShiftId:shift.id,worker:shift.worker,date:localDateKey(new Date(shift.start)),jobsite:shift.jobsite,startIso:shift.start,deviceId:shift.deviceId};
}
function renderSyncPanelV30() {
  renderCompletedSyncPanelV30();
  const pending=clockInSnapshot.filter(e=>e.shift.worker===currentWorker()&&e.status!=="saved");
  if(!pending.length)return;
  const summary=document.querySelector("#queueSummary");
  if(summary)summary.textContent=(pending.some(e=>e.status==="attention"||e.blocked)?"Needs Attention":"Pending Sync")+" — "+pending.length+" clock-in(s) retained on this device. "+summary.textContent;
  const details=document.querySelector("#queueDetails");
  if(details)details.innerHTML+=pending.map(e=>`<article class="entry-card"><div class="entry-main"><div><span class="entry-title">Clock-in: ${escapeHtml(e.shift.jobsite)}</span><span class="entry-sub">${escapeHtml(localDateKey(new Date(e.shift.start)))} · ${timeLabel(e.shift.start)}</span><span class="entry-sub">${escapeHtml(e.error||"")}</span></div><span class="mini-pill">${e.status==="attention"?"Needs Attention":"Pending Sync"}</span></div></article>`).join("");
}
async function syncOutbox(manual=false) {
  if (!offlineReady||!state.auth||navigator.onLine===false) return;
  if (authExpiredV30() || recoveryV30.renewalWorker) { recoveryFailureV30(new Error("Session expired. Sign in again.")); return; }
  if (clockSyncRunning) return clockSyncRunning;
  const worker=currentWorker(),token=state.auth.token;
  clockSyncRunning=(async()=>{
    try {
      // Interleave starts and ends chronologically; never open a later session over an unsaved prior one.
      const count=(await clockIns.list()).filter(e=>e.immutable.payload.worker===worker&&e.status!=="saved").length;
      for(let i=0;i<=count;i++) {
        if(state.auth?.token!==token||currentWorker()!==worker||navigator.onLine===false)break;
        const pending=(await clockIns.list()).filter(e=>e.immutable.payload.worker===worker&&e.status!=="saved").sort((a,b)=>Date.parse(a.shift.start)-Date.parse(b.shift.start))[0];
        if(pending){
          const prior=(await clockIns.list()).filter(e=>e.shift.worker===worker&&e.shift.id!==pending.shift.id&&Date.parse(e.shift.start)<=Date.parse(pending.shift.start));
          const ends=await outbox.list();
          const blocked=prior.some(e=>!ends.some(end=>end.shift.worker===worker&&end.shift.id===e.shift.id&&end.status==="saved"));
          if(blocked){
            await syncCompletedOutboxV30(manual);
            const refreshed=await outbox.list();
            if(prior.some(e=>!refreshed.some(end=>end.shift.worker===worker&&end.shift.id===e.shift.id&&end.status==="saved")))break;
          }
          // A different tab may hold the earliest start. Do not skip it and open a later one.
          const exclude=new Set((await clockIns.list()).filter(e=>e.key!==pending.key).map(e=>e.key));
          await clockIns.drain(worker,(a,p)=>sendOutboxV30(a,p,worker,token),{manual,maxEntries:1,exclude,canSend:()=>state.auth?.token===token&&currentWorker()===worker&&navigator.onLine!==false});
        }
        await syncCompletedOutboxV30(manual);
        if(!pending)break;
        const after=(await clockIns.list()).find(e=>e.key===pending.key);
        if(after.status!=="saved")break;
        const completed=(await outbox.list()).find(e=>e.shift.worker===worker&&e.shift.id===pending.shift.id);
        if(!completed||completed.status!=="saved")break;
      }
      await hydrateOutboxV30();saveState();render();
    } catch(error){storageFailureV30(error);}
  })().finally(()=>{clockSyncRunning=null;});
  return clockSyncRunning;
}

setup();

window.addEventListener("beforeunload", () => {
  if (syncTimer) window.clearInterval(syncTimer);
  if (renderTimer) window.clearInterval(renderTimer);
  if (operationsRefreshTimer) window.clearInterval(operationsRefreshTimer);
});

async function reconcileRestoredActiveV30(proof, worker, token) {
  if(!proof||proof.verified!==true||proof.readOnly!==true)return;
  const active=state.activeShifts?.[worker],receipt=proof.receipt,p=receipt?.payload;
  if(!active?.restored||!p||receipt.version!==30||receipt.sessionId!==active.id||p.clientShiftId!==active.id||p.worker!==worker||p.jobsite!==active.jobsite||p.startIso!==active.start||!p.endIso)return;
  const expected='CC-'+p.date.replaceAll('-','')+'-'+active.id.replace(/[^a-zA-Z0-9]/g,'').slice(0,24);
  if(receipt.submissionId!==expected||!Number.isFinite(Date.parse(p.endIso))||Date.parse(p.endIso)<Date.parse(active.start))return;
  const same=()=>state.auth?.token===token&&currentWorker()===worker&&state.activeShifts?.[worker]===active;
  const starts=await clockIns.list(),ends=await outbox.list();
  // This repair is exclusively for server-restored display state, never a local queue.
  if(!same()||starts.some(e=>e.shift.worker===worker&&e.shift.id===active.id)||ends.some(e=>e.shift.worker===worker&&e.shift.id===active.id))return;
  await outbox.meta('reconciled-restored:'+JSON.stringify([worker,active.id]),{active:{...active},proof,reconciledAt:new Date().toISOString()});
  if(!same())return;
  delete state.activeShifts[worker];
  showToast('This restored shift was already saved on the server. Its receipt is preserved.');
}

function markOperationsReadV30(phase, worker, token, data = null, error = "") {
  if (state.auth?.token !== token || currentWorker() !== worker) return;
  const prior = operationsReadV30.worker === worker && operationsReadV30.token === token
    ? operationsReadV30 : { worker, token, loadedAt: null, day: "", loading: false, error: "" };
  if (phase === "loading") operationsReadV30 = { ...prior, loading: true, error: "" };
  if (phase === "success") {
    const complete = data?.capabilities?.canUseOperations === true
      && ["employees", "clockStates", "submissions", "absences"].every(key => Array.isArray(data[key]));
    operationsReadV30 = { worker, token, loadedAt: complete ? new Date().toISOString() : null,
      day: complete ? data.today || todayKey() : "", loading: false,
      error: complete ? "" : "Complete team data was not returned. Refresh Operations to try again." };
  }
  if (phase === "error" && prior.loading) operationsReadV30 = { ...prior, loading: false, error: error || "Team data could not be refreshed." };
}
function operationsFreshnessV30() {
  const read = operationsReadV30;
  const same = read.worker === currentWorker() && read.token === state.auth?.token;
  const hasComplete = same && !!read.loadedAt && read.day === todayKey();
  let status = "unavailable", message = "Team data unavailable. Try Refresh.";
  if (navigator.onLine === false) { status = "stale"; message = hasComplete ? "Offline — showing saved team data." : "Offline — team data unavailable."; }
  else if (same && read.loading) { status = "loading"; message = "Refreshing…"; }
  else if (same && read.error) { status = "error"; message = hasComplete ? "Couldn’t refresh. Showing saved team data." : "Couldn’t load team data. Try Refresh."; }
  else if (hasComplete && Date.now() - Date.parse(read.loadedAt) <= OPERATIONS_REFRESH_MS * 2) { status = "current"; message = ""; }
  else if (hasComplete) { status = "stale"; message = "Team data may be outdated."; }
  return {status,hasComplete,lastSuccessfulAt:hasComplete?read.loadedAt:null,message};
}
function renderOperationsFreshnessV30() {
  const view = operationsFreshnessV30();
  let panel = document.querySelector("#operationsFreshness");
  if (!panel) {
    panel = document.createElement("p");panel.id = "operationsFreshness";
    panel.setAttribute("role","status");panel.setAttribute("aria-live","polite");panel.className="muted";
    document.querySelector("#operationsView .team-head").after(panel);
  }
  panel.textContent = view.message;panel.dataset.status = view.status;panel.hidden = view.status === "current";
  panel.dataset.lastSuccessfulAt = view.lastSuccessfulAt || "";panel.dataset.detail = operationsReadV30.error || "";
  document.querySelector("#operationsView").setAttribute("aria-busy",view.status === "loading" ? "true" : "false");
  if (els.refreshButton) els.refreshButton.disabled = view.status === "loading";
  return view;
}

/* Update UI only. No payroll writes, storage migration, cache deletion or automatic reload. */
const CrewClockUpdatesV30 = (() => {
  function create({registration, readProtection, online, reload, freeze, document: doc = document, events = window}) {
    let checking = null, applying = false, available = !!registration.waiting, checkError = "";
    const originalWorker=registration.active;
    const panel=doc.createElement('section');panel.id='appUpdatePanel';panel.className='app-update-notice';panel.hidden=true;panel.setAttribute('aria-label','App update');
    const message=doc.createElement('p');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    const apply=doc.createElement('button');apply.type='button';apply.textContent='Update app';apply.className='text-button';apply.hidden=true;
    panel.append(message,apply);doc.body.append(panel);
    async function protection(){try{return await readProtection() || '';}catch{return 'Local storage could not be verified. Update deferred; existing records are retained.';}}
    async function paint(){available=available||!!registration.waiting||!!(originalWorker&&registration.active&&registration.active!==originalWorker);apply.hidden=!available;const reason=await protection();apply.disabled=applying||!!reason||!online();panel.hidden=!available&&!checkError;message.textContent=available?('Update available. '+(reason||(!online()?'Reconnect before updating.':'Open when ready; records are retained.'))):checkError;}
    function observe(worker){if(!worker)return;worker.addEventListener('statechange',()=>{if(originalWorker&&worker!==originalWorker&&['installed','activating','activated'].includes(worker.state)){available=true;void paint();}});}
    registration.addEventListener('updatefound',()=>observe(registration.installing));observe(registration.installing);
    async function checkNow(){if(!online()||checking||applying)return checking;checking=(async()=>{try{await registration.update();checkError='';await paint();}catch{checkError='Couldn’t check for updates. Reconnect to retry; records retained.';await paint();}finally{checking=null;}})();return checking;}
    async function applyNow(){if(applying||!available||!online())return;applying=true;freeze(true);
      try{
        let reason=await protection();if(reason)throw Error(reason);
        const worker=registration.waiting||registration.installing||(registration.active!==originalWorker?registration.active:null);
        if(worker&&worker.state!=='activated'){await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{worker.removeEventListener('statechange',changed);reject(Error('Update not activated. Please try again later.'));},10000);function changed(){if(worker.state==='activated'){clearTimeout(timeout);worker.removeEventListener('statechange',changed);resolve();}else if(worker.state==='redundant'){clearTimeout(timeout);worker.removeEventListener('statechange',changed);reject(Error('Update unavailable. Existing records retained.'));}}worker.addEventListener('statechange',changed);worker.postMessage({type:'V30_ACTIVATE_UPDATE'});changed();});}
        if(originalWorker&&registration.active===originalWorker)throw Error('The update is still preparing. Please try again shortly.');
        reason=await protection();if(reason||!online())throw Error(reason||'Connection lost. Update deferred.');
        // This is the only reload path: explicit tap, activation complete, all guards still clear.
        reload();
      }catch(error){message.textContent='Update deferred. '+error.message;}
      finally{applying=false;freeze(false);apply.disabled=false;}
    }
    apply.addEventListener('click',()=>void applyNow());
    events.addEventListener('focus',()=>void checkNow());events.addEventListener('online',()=>void checkNow());events.addEventListener('pageshow',()=>void checkNow());
    doc.addEventListener('visibilitychange',()=>{if(!doc.hidden)void checkNow();});
    events.navigator?.serviceWorker?.addEventListener('controllerchange',()=>{available=available||!!registration.waiting||!!(originalWorker&&registration.active!==originalWorker);void paint();});
    const timer=setInterval(()=>{if((available||registration.waiting||(originalWorker&&registration.active!==originalWorker))&&!applying)void paint();},1000);void paint();void checkNow();
    return {checkNow,applyNow,paint,dispose(){clearInterval(timer);},panel};
  }
  return {create};
})();
let appUpdatesV30 = null;
let updateInputFrozenV30 = false;
async function updateProtectionV30() {
  if (recoveryV30.renewing || recoveryV30.resume || bootstrapLoading) return "A connection or sign-in check is in progress.";
  if(!offlineReady||offlineError)return 'Local storage is not ready or needs attention.';
  if(localCaptureBusy||clockSyncRunning||outbox.running||clockIns.running)return 'A save or synchronization is in progress.';
  if(Object.values(state.activeShifts||{}).some(Boolean))return 'Finish the active shift and let it sync before updating.';
  if(pendingClockOutShiftId||pendingSwitchShiftId||pendingCrewScheduleShiftId||pendingRemoveAbsenceWorker)return 'Finish or cancel the open form before updating.';
  if([...document.querySelectorAll('dialog[open], [role="dialog"]')].some(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden'))return 'Finish or cancel the open form before updating.';
  if((state.scheduleReports||[]).some(r=>r.syncStatus&&r.syncStatus!=='saved'))return 'A schedule report still needs synchronization.';
  const [ends,starts]=await Promise.all([outbox.list(),clockIns.list()]);
  if([...ends,...starts].some(e=>e.status!=='saved'))return 'Pending Sync or Needs Attention records must be resolved before updating.';
  if(starts.some(start=>!ends.some(end=>end.shift.id===start.shift.id&&end.shift.worker===start.shift.worker&&end.status==='saved')))return 'A locally stored shift has no saved clock-out yet.';
  const latest=localStorage.getItem(V30_UI_KEY);
  if(latest&&Object.values(JSON.parse(latest).activeShifts||{}).some(Boolean))return 'An active shift is stored on this device.';
  if(localCaptureBusy||clockSyncRunning||outbox.running||clockIns.running||Object.values(state.activeShifts||{}).some(Boolean))return 'A shift or save started. Update deferred.';
  return '';
}
function installUpdateSafetyV30(registration) {
  if(appUpdatesV30)return;
  for(const event of ['click','keydown','submit'])document.addEventListener(event,e=>{if(updateInputFrozenV30){e.preventDefault();e.stopImmediatePropagation();}},true);
  appUpdatesV30=CrewClockUpdatesV30.create({registration,readProtection:updateProtectionV30,online:()=>navigator.onLine!==false,reload:()=>location.reload(),freeze:value=>{updateInputFrozenV30=value;}});
}


// Recovery UI never removes credentials, changes worker identity, or mutates queued payloads.
function authExpiredV30() {
  if (!state.auth?.token) return false;
  try {
    const payload = JSON.parse(atob(state.auth.token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/')));
    return Number.isFinite(payload.exp) && Date.now() >= payload.exp;
  } catch { return false; } // Only the server can validate an opaque/legacy credential.
}
function serverVerifiedV30() {
  return navigator.onLine !== false && !!state.auth && !authExpiredV30()
    && !recoveryV30.renewalWorker && !recoveryV30.error
    && recoveryV30.token === state.auth.token && Date.now() - recoveryV30.verifiedAt < 90000;
}
function recoveryFailureV30(error) {
  recoveryV30.error = error?.message || "Server connection failed. Local records retained.";
  recoveryV30.verifiedAt = 0;
  if (isSessionExpiredError(error) || /invalid.*token|unauthorized/i.test(error?.message || "")) {
    recoveryV30.renewalWorker = currentWorker();
  }
  renderRecoveryV30();
}
async function renewSignInV30(pin) {
  if (recoveryV30.renewing || navigator.onLine === false || !state.auth) return;
  const worker = currentWorker(), oldToken = state.auth.token;
  let acceptedToken = oldToken;
  recoveryV30.renewing = true;
  renderRecoveryV30();
  try {
    const data = await readOnlyRequestV30("login", {pin}, () => currentWorker() === worker && state.auth?.token === oldToken);
    if (currentWorker() !== worker || state.auth?.token !== oldToken) return;
    if (!data.token || data.employee?.worker !== worker) throw Error("Use the PIN for " + worker + ". Existing records and identity are unchanged.");
    const originalAuth = state.auth;
    state.auth = {...originalAuth, token:data.token, expiresAt:data.expiresAt, signedInAt:new Date().toISOString()};
    acceptedToken = data.token;
    if (!saveState()) { state.auth = originalAuth; throw Error("Sign-in could not be stored. Original records retained; contact the office."); }
    recoveryV30.renewalWorker = ""; recoveryV30.error = ""; recoveryV30.token = null;
    // No capture, migration, or queue rewrite. Existing receipt checks own all retries.
    await loadBootstrap();
    if (serverVerifiedV30()) await syncOutbox();
  } catch (error) {
    if (currentWorker() !== worker || ![oldToken,acceptedToken].includes(state.auth?.token)) return;
    recoveryV30.error = error.message || "Sign-in renewal failed. Records retained.";
  } finally { recoveryV30.renewing = false; renderRecoveryV30(); }
}
function renderRecoveryV30() {
  if (!state.auth) return;
  let panel = document.querySelector('#signInRecoveryV30');
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'signInRecoveryV30'; panel.setAttribute('aria-label','Connection recovery');
    const message = document.createElement('p'); message.setAttribute('role','status');
    const pin = document.createElement('input'); pin.type='password'; pin.inputMode='numeric'; pin.maxLength=4; pin.autocomplete='off'; pin.setAttribute('aria-label','Your employee PIN');
    const renew = document.createElement('button'); renew.type='button'; renew.textContent='Renew sign-in — keep my records';
    renew.addEventListener('click',()=>{const value=pin.value;pin.value='';if(/^\d{4}$/.test(value))void renewSignInV30(value);});
    const retry = document.createElement('button'); retry.type='button'; retry.textContent='Reconnect'; retry.addEventListener('click',()=>void resumeOfflineSync());
    panel.append(message,pin,renew,retry); els.appShell.prepend(panel);
  }
  const [message,pin,renew,retry] = panel.children;
  panel.hidden = !recoveryV30.error && !recoveryV30.renewalWorker;
  message.textContent = recoveryV30.renewalWorker
    ? 'Renew sign-in as '+recoveryV30.renewalWorker+'. Saved and unsent records remain on this device. '+(isSessionExpiredError({message:recoveryV30.error})?'':recoveryV30.error)
    : recoveryV30.error + ' Your local records are retained. Reconnect to retry; if website access expired, unlock the same website without resetting this app.';
  pin.hidden=renew.hidden=!recoveryV30.renewalWorker;
  renew.disabled=recoveryV30.renewing || navigator.onLine===false;
  retry.disabled=!!recoveryV30.resume || navigator.onLine===false;
}


// Vacation is a server-read projection, never a clock or scheduling record.
function mergeCrewVacations(incoming, previous) {
  const valid = incoming?.status === "available" && incoming.date === todayKey()
    && Array.isArray(incoming.items) && incoming.items.every(v => v && typeof v.worker === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(v.start) && /^\d{4}-\d{2}-\d{2}$/.test(v.end)
      && v.start <= incoming.date && v.end >= incoming.date);
  if (valid) return {status: "available", date: incoming.date,
    items: incoming.items.map(v => ({employeeId:v.employeeId, worker:v.worker, start:v.start, end:v.end})), lastSuccessfulAt:new Date().toISOString()};
  return {status: "unavailable", date: todayKey(), items:previous?.date === todayKey() ? previous.items || [] : [],
    lastSuccessfulAt:previous?.date === todayKey() ? previous.lastSuccessfulAt : null};
}
function crewVacationFor(worker) {
  const view = payroll.vacations;
  return view?.date === todayKey() ? view.items.find(v => v.worker === worker) || null : null;
}
function crewVacationAlertsAvailable() {
  return payroll.vacations?.status === "available" && payroll.vacations.date === todayKey()
    && operationsFreshnessV30().status === "current";
}
function crewVacationHasWork(worker) {
  return !!state.activeShifts[worker] || state.shifts.some(s => s.worker === worker && localDateKey(new Date(s.start)) === todayKey())
    || payroll.submissions.some(s => s.worker === worker && s.date === todayKey())
    || payroll.clockStates.some(s => s.worker === worker && s.date === todayKey() && ["Clocked In","Clocked Out"].includes(s.status));
}
function crewVacationIndicatorV30() {
  const view = payroll.vacations, read = operationsReadV30;
  const retained = view?.date === todayKey() && !!view?.lastSuccessfulAt;
  const same = read.worker === currentWorker() && read.token === state.auth?.token;
  const fresh = retained && view.status === "available" && same && read.day === todayKey()
    && !!read.loadedAt && !read.error && navigator.onLine !== false
    && Date.now() - Date.parse(read.loadedAt) <= OPERATIONS_REFRESH_MS * 2;
  if (fresh) return ""; // An ordinary in-flight refresh does not invalidate the saved read.
  if (!retained && same && read.loading && !read.loadedAt) return "";
  return retained ? "Vacation data may be outdated" : "Vacation information unavailable";
}
function crewVacationNotice() {
  const indicator = crewVacationIndicatorV30();
  return indicator ? `<p class="vacation-notice" role="status">${escapeHtml(indicator)}. Some attendance alerts are paused.</p>` : "";
}
