const CONFIG = {
  apiUrl: window.CREW_CLOCK_CONFIG?.apiUrl || "",
  vapidPublicKey: window.CREW_CLOCK_CONFIG?.vapidPublicKey || "",
  fcmVapidKey: window.CREW_CLOCK_CONFIG?.fcmVapidKey || window.CREW_CLOCK_CONFIG?.vapidPublicKey || "",
  firebaseConfig: window.CREW_CLOCK_CONFIG?.firebaseConfig || null,
};

const STORAGE_KEY = "pga-crew-clock-payroll-v2";
const DEVICE_KEY = "pga-crew-clock-device-id";
const API_PLACEHOLDER = "PASTE_APPS_SCRIPT_WEB_APP_URL_HERE";
const VAPID_PLACEHOLDER = "PASTE_WEB_PUSH_VAPID_PUBLIC_KEY_HERE";
const APP_TIME_ZONE = "America/Vancouver";
const OPERATIONS_REFRESH_MS = 30000;
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
  primaryActions: document.querySelector("#primaryActions"),
  clockButton: document.querySelector("#clockButton"),
  switchButton: document.querySelector("#switchButton"),
  absentButton: document.querySelector("#absentButton"),
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
  alertsList: document.querySelector("#alertsList"),
  retryButton: document.querySelector("#retryButton"),
  lunchDialog: document.querySelector("#lunchDialog"),
  lunchYesButton: document.querySelector("#lunchYesButton"),
  lunchNoButton: document.querySelector("#lunchNoButton"),
  switchDialog: document.querySelector("#switchDialog"),
  switchSiteSelect: document.querySelector("#switchSiteSelect"),
  switchConfirmButton: document.querySelector("#switchConfirmButton"),
  switchCancelButton: document.querySelector("#switchCancelButton"),
  absentDialog: document.querySelector("#absentDialog"),
  absentYesButton: document.querySelector("#absentYesButton"),
  absentNoButton: document.querySelector("#absentNoButton"),
  toast: document.querySelector("#toast"),
};

let payroll = {
  employees: [],
  jobsites: [],
  absences: [],
  clockStates: [],
  submissions: [],
  loadedAt: null,
};

let state = loadState();
let pinBuffer = "";
let pendingClockOutShiftId = null;
let lunchDialogMode = "";
let pendingSwitchShiftId = null;
let pendingSwitchLunch = "";
let toastTimer;
let renderTimer;
let operationsRefreshTimer;
let bootstrapLoading = false;
let serviceWorkerRegistration = null;

function defaultState() {
  return {
    day: todayKey(),
    deviceId: getOrCreateDeviceId(),
    auth: null,
    selectedJobsite: "",
    activeShifts: {},
    shifts: [],
    absenceDate: "",
    expandedTransfers: {},
    notificationEndpoint: "",
    reminderStatus: "",
    activeTab: "clock",
    lastSync: "Ready",
  };
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return defaultState();
  try {
    const parsed = JSON.parse(saved);
    if (parsed.day === todayKey()) {
      return { ...defaultState(), ...parsed, activeShifts: parsed.activeShifts || {}, expandedTransfers: parsed.expandedTransfers || {} };
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return defaultState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getOrCreateDeviceId() {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const deviceId = newId();
  localStorage.setItem(DEVICE_KEY, deviceId);
  return deviceId;
}

function apiReady() {
  return CONFIG.apiUrl && CONFIG.apiUrl !== API_PLACEHOLDER;
}

async function apiGet(action) {
  if (!apiReady()) throw new Error("Add the Apps Script Web App URL in index.html.");
  const url = new URL(CONFIG.apiUrl);
  url.searchParams.set("action", action);
  url.searchParams.set("_", Date.now().toString());
  const response = await fetch(url.toString(), { method: "GET" });
  return parseApiResponse(response);
}

async function apiPost(action, payload = {}) {
  if (!apiReady()) throw new Error("Add the Apps Script Web App URL in index.html.");
  const body = new URLSearchParams();
  body.set("payload", JSON.stringify({ action, ...payload }));
  const response = await fetch(CONFIG.apiUrl, {
    method: "POST",
    body,
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Payroll 2.0 returned an unreadable response.");
  }
  if (data.ok === false) throw new Error(data.error || "Payroll 2.0 request failed.");
  return data;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function setup() {
  els.keypad.addEventListener("click", (event) => {
    const key = event.target.closest("button")?.dataset.key;
    if (key) handlePinKey(key);
  });
  window.addEventListener("keydown", handleKeyboardPin);
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
  els.enableRemindersButton.addEventListener("click", enableClockReminders);
  els.retryButton.addEventListener("click", retryFailedSaves);
  els.lunchYesButton.addEventListener("click", () => handleLunchAnswer("Yes"));
  els.lunchNoButton.addEventListener("click", () => handleLunchAnswer("No"));
  els.switchConfirmButton.addEventListener("click", switchJobsite);
  els.switchCancelButton.addEventListener("click", closeSwitchDialog);
  els.absentYesButton.addEventListener("click", markAbsentToday);
  els.absentNoButton.addEventListener("click", closeAbsentDialog);

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  });

  registerServiceWorker();
  renderTimer = window.setInterval(render, 1000);
  operationsRefreshTimer = window.setInterval(refreshOperationsIfOpen, OPERATIONS_REFRESH_MS);
  if (state.auth) {
    showApp();
    loadBootstrap();
  } else {
    showLogin("");
  }
  render();
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
  setLoginMessage("Checking PIN...");
  try {
    const data = await apiPost("login", { pin: pinBuffer });
    state.auth = {
      token: data.token,
      worker: data.employee.worker,
      role: data.employee.role || "Employee",
      attendanceRequired: data.employee.attendanceRequired || "No",
      expiresAt: data.expiresAt,
      signedInAt: new Date().toISOString(),
    };
    state.lastSync = "Signed in";
    state.activeTab = "clock";
    pinBuffer = "";
    saveState();
    renderPinDots();
    showApp();
    await loadBootstrap();
    showToast(`Signed in as ${state.auth.worker}`);
  } catch (error) {
    const message = error.message === "DUPLICATE_PIN"
      ? "Duplicate PIN detected. Please contact the office."
      : error.message || "PIN not accepted";
    pinBuffer = "";
    renderPinDots();
    setLoginMessage(message, true);
  }
}

async function loadBootstrap(options = {}) {
  if (bootstrapLoading) return;
  bootstrapLoading = true;
  if (!options.quiet) setConnection("loading", "Refreshing Payroll 2.0");
  try {
    const data = await apiGet("bootstrap");
    payroll = {
      employees: arrayOrEmpty(data.employees),
      jobsites: arrayOrEmpty(data.jobsites),
      absences: arrayOrEmpty(data.absences),
      clockStates: arrayOrEmpty(data.clockStates),
      submissions: arrayOrEmpty(data.submissions),
      loadedAt: new Date().toISOString(),
    };
    const employee = currentEmployee();
    if (employee && state.auth) {
      state.auth.attendanceRequired = employee.attendanceRequired || state.auth.attendanceRequired || "No";
    }
    if (!payroll.jobsites.some((jobsite) => jobsite.jobsite === state.selectedJobsite)) {
      state.selectedJobsite = payroll.jobsites[0]?.jobsite || "";
    }
    restoreCurrentOpenShift();
    state.lastSync = "Ready";
    saveState();
    if (!options.quiet) setConnection("ready", "Connected to Payroll 2.0");
  } catch (error) {
    state.lastSync = "Connection failed";
    if (!options.quiet) setConnection("error", error.message);
  } finally {
    bootstrapLoading = false;
    render();
  }
}

function refreshOperationsIfOpen() {
  if (state.auth && isManagerMode() && state.activeTab === "operations") {
    loadBootstrap({ quiet: true });
  }
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
  state.auth = null;
  state.activeTab = "clock";
  saveState();
  showLogin("");
}

function setActiveTab(tab) {
  state.activeTab = tab;
  saveState();
  render();
  if (tab === "operations" || tab === "alerts") loadBootstrap({ quiet: true });
}

function currentWorker() {
  return state.auth?.worker || "";
}

function currentRole() {
  return state.auth?.role || "Employee";
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
  const role = currentRole().toLowerCase();
  return ["admin", "manager", "supervisor", "foreman", "lead", "operations", "office"].some((word) => role.includes(word));
}

function canEnableDeviceNotifications() {
  return attendanceRequiredFor() || isManagerMode();
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

function currentActiveShift() {
  return state.activeShifts[currentWorker()] || null;
}

function completedRowsFor(worker = currentWorker()) {
  return state.shifts.filter((shift) => shift.worker === worker && localDateKey(new Date(shift.start)) === todayKey());
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

  const existing = state.activeShifts[worker];
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
    || !!activeShiftFor(worker)
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
  if (!state.auth) return;
  if (!payroll.jobsites.length) return showToast("No active jobsites in Payroll 2.0");
  if (isAbsentToday()) return showToast("Undo absence before clocking in");
  const current = currentActiveShift();
  if (current) {
    openLunchDialog("clockOut", current.id);
    return;
  }

  const nextShift = {
    id: newId(),
    worker: currentWorker(),
    jobsite: state.selectedJobsite || payroll.jobsites[0].jobsite,
    start: new Date().toISOString(),
  };
  setConnection("loading", "Opening shift");
  try {
    await recordClockState("Clocked In", nextShift);
    state.activeShifts[currentWorker()] = nextShift;
    saveState();
    setConnection("ready", "Clocked in");
    render();
    showToast("Clocked in");
  } catch (error) {
    setConnection("error", error.message || "Clock In failed");
    showToast("Clock In failed");
  }
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

  closeLunchDialog();
  const completed = {
    ...current,
    end: new Date().toISOString(),
    lunch,
    clearOpenShift: true,
    syncStatus: "pending",
  };
  delete state.activeShifts[currentWorker()];
  state.shifts.unshift(completed);
  state.lastSync = "Saving";
  saveState();
  render();
  try {
    await recordClockState("Clocked Out", completed);
  } catch (error) {
    setConnection("error", error.message || "Open shift close failed");
  }
  await saveCompletedShift(completed);
}

function closeLunchDialog() {
  pendingClockOutShiftId = null;
  pendingSwitchShiftId = null;
  pendingSwitchLunch = "";
  lunchDialogMode = "";
  els.lunchDialog.hidden = true;
}

function openSwitchDialog() {
  const current = currentActiveShift();
  if (!current) return;
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
    undoAbsenceToday();
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

async function undoAbsenceToday() {
  setLocalAbsence(false);
  saveState();
  render();
  setConnection("loading", "Undoing absence");
  try {
    await apiPost("undoAbsence", {
      token: state.auth?.token,
      date: todayKey(),
    });
    payroll.clockStates = payroll.clockStates.filter((entry) => !(entry.worker === currentWorker() && entry.date === todayKey()));
    setConnection("ready", "Absence removed");
    showToast("Absence removed");
  } catch (error) {
    setLocalAbsence(true);
    saveState();
    setConnection("error", error.message);
    showToast("Could not undo absence");
  } finally {
    render();
  }
}

async function switchJobsite() {
  const current = currentActiveShift();
  const nextJobsite = els.switchSiteSelect.value;
  if (!current) return closeSwitchDialog();
  if (current.id !== pendingSwitchShiftId) return closeSwitchDialog();
  if (!nextJobsite || nextJobsite === current.jobsite) return showToast("Select a different jobsite");

  const now = new Date().toISOString();
  const completed = {
    ...current,
    end: now,
    lunch: pendingSwitchLunch === "Yes" ? "Yes" : "No",
    travelTo: nextJobsite,
    syncStatus: "pending",
  };

  const nextShift = {
    id: newId(),
    worker: currentWorker(),
    jobsite: nextJobsite,
    start: now,
    travelFrom: current.jobsite,
  };
  state.activeShifts[currentWorker()] = nextShift;
  state.selectedJobsite = nextJobsite;
  state.shifts.unshift(completed);
  state.lastSync = "Saving";
  closeSwitchDialog();
  saveState();
  render();
  try {
    await recordClockState("Clocked In", nextShift);
  } catch (error) {
    setConnection("error", error.message || "Open shift update failed");
    showToast("Open shift update failed");
  }
  await saveCompletedShift(completed);
  showToast("New jobsite started");
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
  updateShiftSync(shift.id, { syncStatus: "pending", error: "" });
  setConnection("loading", "Saving to Payroll 2.0");
  try {
    const data = await apiPost("saveShift", {
      token: state.auth?.token,
      shift: toSubmissionPayload(shift),
    });
    updateShiftSync(shift.id, {
      syncStatus: "saved",
      submissionId: data.submissionId,
      error: "",
    });
    state.lastSync = "Saved to Payroll 2.0";
    saveState();
    setConnection("ready", "Saved to Payroll 2.0");
  } catch (error) {
    if (isSessionExpiredError(error)) {
      handleExpiredSessionSave(shift);
      return;
    }
    updateShiftSync(shift.id, { syncStatus: "failed", error: error.message });
    await notifySaveProblem(shift, error);
    state.lastSync = "Save failed, try again";
    saveState();
    setConnection("error", "Save failed, try again");
  } finally {
    render();
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
  const failed = state.shifts.filter((shift) => shift.syncStatus === "failed");
  if (!failed.length) return showToast("No failed saves");
  for (const shift of failed) {
    await saveCompletedShift(shift);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register("./service-worker.js");
  } catch {
    serviceWorkerRegistration = null;
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

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    state.reminderStatus = "Clock reminders were not enabled.";
    saveState();
    render();
    return;
  }

  try {
    const registration = serviceWorkerRegistration || await navigator.serviceWorker.register("./service-worker.js");
    if (hasFcmConfig()) {
      await enableFcmReminders(registration);
    } else {
      await enableNativeWebPushReminders(registration);
    }

    state.reminderStatus = "Clock reminders enabled on this device.";
    saveState();
    render();
    showToast("Clock reminders enabled");
  } catch (error) {
    state.reminderStatus = error.message || "Could not enable reminders.";
    saveState();
    render();
  }
}

async function enableFcmReminders(registration) {
  const [{ initializeApp, getApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-messaging.js`),
  ]);
  if (isSupported && !(await isSupported())) {
    throw new Error("Clock reminders are not supported on this browser.");
  }

  const firebaseApp = getApps().length ? getApp() : initializeApp(CONFIG.firebaseConfig);
  const messaging = getMessaging(firebaseApp);
  const fcmToken = await getToken(messaging, {
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
    clientShiftId: shift.id,
    worker: shift.worker,
    date: localDateKey(new Date(shift.start)),
    jobsite: shift.jobsite,
    startIso: shift.start,
    endIso: shift.end,
    lunch: shift.lunch === "Yes" ? "Yes" : "No",
    notes: "",
    clearOpenShift: !!shift.clearOpenShift,
  };
}

function render() {
  if (!state.auth) {
    renderPinDots();
    return;
  }
  showApp();
  renderShell();
  renderClock();
  if (isManagerMode()) {
    renderOperations();
    renderAlerts();
  }
}

function renderShell() {
  els.workerName.textContent = currentWorker();
  els.workerRole.textContent = currentRole() || "Employee";
  const manager = isManagerMode();
  els.managerTabs.hidden = !manager;
  if (!manager) state.activeTab = "clock";
  renderAlertsTabIndicator();
  els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.activeTab));
  els.views.forEach((view) => {
    const key = view.id.replace("View", "");
    view.classList.toggle("active", key === state.activeTab || (!manager && key === "clock"));
  });
}

function renderAlertsTabIndicator() {
  if (!els.alertsTab) return;
  if (!isManagerMode()) {
    els.alertsTab.textContent = "Alerts";
    return;
  }
  const count = alertItemCount(buildAlertSections());
  els.alertsTab.textContent = count ? `Alerts 🔴 ${count}` : "Alerts";
}

function renderClock() {
  renderJobsiteSelect(els.siteSelect, state.selectedJobsite);
  const current = currentActiveShift();
  const rows = completedRowsFor();
  const lastRow = rows[0];
  const site = findJobsite(current?.jobsite || state.selectedJobsite);
  const canClock = payroll.jobsites.length > 0;
  const absent = isAbsentToday();
  const canMarkAbsent = absent || !hasClockedInToday();

  els.liveClock.textContent = new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  }).format(new Date());
  els.statusPanel.style.setProperty("--site-color", site?.colour || "#007f73");
  els.siteSwatch.style.background = site?.colour || "#007f73";
  els.clockButton.disabled = !canClock || absent;
  els.switchButton.disabled = !canClock;
  els.siteSelect.disabled = !!current || !canClock || absent;
  els.absentButton.hidden = !canMarkAbsent;
  els.absentButton.textContent = absent ? "Undo Absence" : "Mark Absent Today";
  renderReminderPanel();

  if (!apiReady()) {
    els.statusPill.textContent = "Setup needed";
    els.statusPill.className = "status-pill out";
    els.clockTitle.textContent = "Add Web App URL";
    els.statusDetail.textContent = "Deploy the backend and paste the URL in index.html.";
  } else if (!payroll.jobsites.length) {
    els.statusPill.textContent = "No jobsites";
    els.statusPill.className = "status-pill out";
    els.clockTitle.textContent = "Waiting for jobsites";
    els.statusDetail.textContent = "Add Active jobsites in Payroll 2.0.";
  } else if (absent) {
    els.statusPill.textContent = "Absent";
    els.statusPill.className = "status-pill out";
    els.clockTitle.textContent = "Absent Today";
    els.statusDetail.textContent = "No payroll hours created.";
    els.clockButton.className = "primary-button";
    els.clockButton.innerHTML = clockIcon() + " Clock In";
    els.switchButton.hidden = true;
    els.primaryActions.classList.remove("with-switch");
  } else if (current) {
    els.statusPill.textContent = "Clocked in";
    els.statusPill.className = "status-pill";
    els.clockTitle.textContent = shiftDurationLabel(current);
    els.statusDetail.textContent = current.jobsite;
    els.clockButton.className = "primary-button stop";
    els.clockButton.innerHTML = clockIcon() + " Clock Out";
    els.switchButton.hidden = false;
    els.primaryActions.classList.add("with-switch");
  } else {
    els.statusPill.textContent = "Clocked out";
    els.statusPill.className = "status-pill out";
    els.clockTitle.textContent = "Ready for jobsite";
    els.statusDetail.textContent = state.selectedJobsite || "Select jobsite";
    els.clockButton.className = "primary-button";
    els.clockButton.innerHTML = clockIcon() + " Clock In";
    els.switchButton.hidden = true;
    els.primaryActions.classList.remove("with-switch");
  }

  els.syncStatus.textContent = syncStatusText();
  els.lunchStatus.textContent = current ? "Pending" : lastRow ? lastRow.lunch : "Pending";
  els.rowCount.textContent = String(rows.length);
  els.entryCount.textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  renderCompletedRows(rows);
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
              <span class="entry-sub">${timeLabel(shift.start)} - ${timeLabel(shift.end)}</span>
              <span class="entry-sub">Lunch: ${escapeHtml(shift.lunch)}</span>
              ${travel ? `<span class="entry-sub">${escapeHtml(travel)}</span>` : ""}
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
  els.reminderPanel.hidden = !canEnable;
  if (!canEnable) return;

  const permission = "Notification" in window ? Notification.permission : "unsupported";
  const enabled = permission === "granted" && !!state.notificationEndpoint;
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
  const totalHours = summarize(completed.concat(activeEntries)).workMs;

  els.clockedInCount.textContent = String(clockedInWorkers.size);
  els.clockedOutCount.textContent = String([...clockedOutWorkers].filter((worker) => !clockedInWorkers.has(worker) && !absentWorkers.has(worker)).length);
  els.teamHours.textContent = durationLabel(totalHours);

  const groups = buildOperationsGroups(absentWorkers);
  els.teamList.innerHTML = groups.length
    ? groups.map(renderOperationsGroup).join("")
    : `<p class="empty-state">No clocked-in, clocked-out, or absent employees today</p>`;
  bindTransferExpansionState();
}

function buildOperationsGroups(absentWorkers) {
  const groups = new Map();
  const absentGroup = {
    jobsite: "Absent Today",
    colour: "#b42318",
    people: [],
    absent: true,
  };

  payroll.employees.forEach((employee) => {
    const stateRow = payroll.clockStates.find((entry) => entry.worker === employee.worker && entry.date === todayKey());
    const active = state.activeShifts[employee.worker] || (stateRow?.status === "Clocked In" ? {
      worker: employee.worker,
      jobsite: stateRow.jobsite,
      start: stateRow.clockInAt,
    } : null);
    const activeForHistory = active || null;
    const recent = latestCompletedSegmentFor(employee.worker);
    const transferHistory = transferHistoryFor(employee.worker, activeForHistory);
    const absent = absentWorkers.has(employee.worker);
    const clockedOut = !!recent || stateRow?.status === "Clocked Out";

    if (!active && !absent && !clockedOut) return;

    if (absent) {
      absentGroup.people.push({
        worker: employee.worker,
        status: "Absent",
        statusClass: "absent",
        clockIn: "",
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
      status: active ? "Clocked In" : "Clocked Out",
      statusClass: active ? "" : "out",
      clockIn: active?.start || recent?.start || stateRow?.clockInAt || "",
      switched: transferHistory.length > 0,
      transferHistory,
    });
  });

  const jobsiteGroups = [...groups.values()]
    .filter((group) => group.people.length)
    .sort((a, b) => a.jobsite.localeCompare(b.jobsite));

  if (absentGroup.people.length) jobsiteGroups.push(absentGroup);
  return jobsiteGroups;
}

function renderOperationsGroup(group) {
  const colour = escapeAttribute(group.colour || "#007f73");
  return `
    <section class="jobsite-group" style="--row-site-color:${colour}">
      <header class="jobsite-group-header">
        <span class="jobsite-colour" aria-hidden="true"></span>
        <strong>${escapeHtml(group.jobsite)}</strong>
        <span>${group.people.length}</span>
      </header>
      <div class="jobsite-crew">
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
      </div>
      <span class="person-status-stack">
        <span class="mini-pill ${person.statusClass}">${escapeHtml(person.status)}</span>
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
  const sections = buildAlertSections().filter((section) => section.people.length);
  if (!sections.length) {
    els.alertsList.innerHTML = `<p class="empty-state">✓ Everyone is accounted for today.</p>`;
    return;
  }

  els.alertsList.innerHTML = sections.map(renderAlertSection).join("");
}

function buildAlertSections() {
  const failed = state.shifts.filter((shift) => shift.syncStatus === "failed");
  const pending = state.shifts.filter((shift) => shift.syncStatus === "pending");
  const absentWorkers = new Set(payroll.absences
    .filter((entry) => entry.date === todayKey() && entry.status === "Absent")
    .map((entry) => entry.worker));
  if (isAbsentToday()) absentWorkers.add(currentWorker());

  const activeMap = new Map();
  payroll.clockStates
    .filter((entry) => entry.date === todayKey() && entry.status === "Clocked In")
    .forEach((entry) => {
      activeMap.set(entry.worker, {
        worker: entry.worker,
        status: "Still Clocked In",
        statusClass: "",
        jobsite: entry.jobsite,
        clockIn: entry.clockInAt,
      });
    });

  return [
    {
      title: "🔴 Not Clocked In",
      people: activeAttendanceEmployees()
        .filter((employee) => !hasAttendanceClockInToday(employee.worker) && !absentWorkers.has(employee.worker))
        .map((employee) => ({
          worker: employee.worker,
          status: "Not Clocked In",
          statusClass: "pending",
        }))
        .sort(compareAlertPeople),
    },
    {
      title: "🟢 Absent Today",
      people: [...absentWorkers]
        .map((worker) => ({
          worker,
          status: "Absent",
          statusClass: "absent",
        }))
        .sort(compareAlertPeople),
    },
    {
      title: "🔴 Still Clocked In (after the final reminder time only)",
      people: isAfterStillClockedInAlertTime() ? [...activeMap.values()].sort(compareAlertPeople) : [],
    },
    {
      title: "🔴 Save Problems",
      people: failed.concat(pending)
        .map((shift) => ({
          worker: shift.worker,
          status: shift.syncStatus === "pending" ? "Pending Save" : "Save Failed",
          statusClass: shift.syncStatus === "pending" ? "pending" : "failed",
          detail: shift.error || (shift.syncStatus === "pending" ? "Waiting to save" : "Save failed, try again"),
        }))
        .sort(compareAlertPeople),
    },
  ];
}

function alertItemCount(sections) {
  return sections.reduce((total, section) => total + section.people.length, 0);
}

function compareAlertPeople(a, b) {
  return a.worker.localeCompare(b.worker);
}

function renderAlertSection(section) {
  return `
    <section class="alert-section">
      <header class="alert-section-header">
        <strong>${escapeHtml(section.title)}</strong>
        <span>${section.people.length}</span>
      </header>
      <div class="alert-people">
        ${section.people.map(renderAlertPerson).join("")}
      </div>
    </section>
  `;
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
        </div>
        <span class="mini-pill ${person.statusClass || ""}">${escapeHtml(person.status)}</span>
      </div>
    </article>
  `;
}

function renderJobsiteSelect(select, selectedValue) {
  const options = payroll.jobsites.map((jobsite) => {
    return `<option value="${escapeHtml(jobsite.jobsite)}">${escapeHtml(jobsite.jobsite)}</option>`;
  });
  select.innerHTML = options.length ? options.join("") : `<option value="">No active jobsites</option>`;
  select.value = selectedValue || payroll.jobsites[0]?.jobsite || "";
}

function syncStatusText() {
  const rows = completedRowsFor();
  const failed = rows.filter((shift) => shift.syncStatus === "failed").length;
  const pending = rows.filter((shift) => shift.syncStatus === "pending").length;
  if (failed) return "Save failed, try again";
  if (pending) return "Saving";
  return state.lastSync || "Ready";
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
  if (shift.syncStatus === "saved") return "Saved";
  if (shift.syncStatus === "failed") return "Save failed";
  return "Saving";
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
  els.connectionBar.className = `connection-bar ${mode === "ready" ? "ready" : mode === "error" ? "error" : ""}`;
  els.connectionText.textContent = message;
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

setup();

window.addEventListener("beforeunload", () => {
  if (renderTimer) window.clearInterval(renderTimer);
  if (operationsRefreshTimer) window.clearInterval(operationsRefreshTimer);
});
