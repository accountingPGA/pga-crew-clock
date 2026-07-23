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

let payroll = {
  employees: [],
  jobsites: [],
  absences: [],
  clockStates: [],
  submissions: [],
  myHours: [],
  myHoursMessage: "",
  myHoursLoadedAt: null,
  myHoursLoading: false,
  capabilities: {
    canUseOperations: false,
    canUseAlerts: false,
  },
  payrollPeriod: {
    configured: false,
    start: "",
    end: "",
  },
  loadedAt: null,
};

let state = loadState();
let pinBuffer = "";
let pendingClockOutShiftId = null;
let lunchDialogMode = "";
let pendingSwitchShiftId = null;
let pendingSwitchLunch = "";
let pendingRemoveAbsenceWorker = "";
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
    expandedAlertSections: {},
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
      const hydrated = { ...defaultState(), ...parsed, activeShifts: parsed.activeShifts || {}, expandedAlertSections: parsed.expandedAlertSections || {}, expandedTransfers: parsed.expandedTransfers || {} };
      if (!hydrated.auth?.worker || !hydrated.activeShifts?.[hydrated.auth.worker]) {
        hydrated.selectedJobsite = "";
      }
      return hydrated;
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
  els.markEmployeeAbsentButton.addEventListener("click", openEmployeeAbsentDialog);
  els.notificationButton.addEventListener("click", enableClockReminders);
  els.enableRemindersButton.addEventListener("click", enableClockReminders);
  els.retryButton.addEventListener("click", retryFailedSaves);
  els.lunchYesButton.addEventListener("click", () => handleLunchAnswer("Yes"));
  els.lunchNoButton.addEventListener("click", () => handleLunchAnswer("No"));
  els.switchConfirmButton.addEventListener("click", switchJobsite);
  els.switchCancelButton.addEventListener("click", closeSwitchDialog);
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
    const data = await apiPost("bootstrap", { token: state.auth?.token });
    payroll = {
      employees: arrayOrEmpty(data.employees),
      jobsites: arrayOrEmpty(data.jobsites),
      absences: arrayOrEmpty(data.absences),
      clockStates: arrayOrEmpty(data.clockStates),
      submissions: arrayOrEmpty(data.submissions),
      myHours: payroll.myHours,
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
    }
    if (state.selectedJobsite && !payroll.jobsites.some((jobsite) => jobsite.jobsite === state.selectedJobsite)) {
      state.selectedJobsite = "";
    }
    if (state.absenceDate === todayKey() && !payroll.absences.some((entry) => entry.worker === currentWorker() && entry.date === todayKey() && entry.status === "Absent")) {
      state.absenceDate = "";
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

async function loadMyHours(options = {}) {
  if (!state.auth || !apiReady()) return;
  payroll.myHoursLoading = true;
  if (options.renderBefore !== false && state.activeTab === "myHours") render();
  try {
    const data = await apiPost("myHours", { token: state.auth.token });
    payroll.myHours = arrayOrEmpty(data.rows);
    payroll.myHoursMessage = data.message || "";
    payroll.payrollPeriod = data.payrollPeriod || payroll.payrollPeriod || {};
    payroll.myHoursLoadedAt = new Date().toISOString();
  } catch (error) {
    payroll.myHours = [];
    payroll.myHoursMessage = error.message || "Could not load My Hours.";
  } finally {
    payroll.myHoursLoading = false;
    if (options.renderAfter !== false && state.activeTab === "myHours") render();
  }
}

function refreshOperationsIfOpen() {
  if (state.auth && canUseOperations() && state.activeTab === "operations") {
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
  if (!canAccessTab(tab)) tab = firstAllowedTab();
  state.activeTab = tab;
  saveState();
  render();
  if (tab === "operations" || tab === "alerts") loadBootstrap({ quiet: true });
  if (tab === "myHours") loadMyHours({ quiet: true });
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
  if (isAbsentToday()) return showToast("You have been marked absent for today. Please contact your foreman or the office if this is incorrect.");
  const current = currentActiveShift();
  if (current) {
    openLunchDialog("clockOut", current.id);
    return;
  }

  const selectedJobsite = findJobsite(state.selectedJobsite);
  if (!selectedJobsite) return showToast("Select a jobsite before clocking in.");

  const nextShift = {
    id: newId(),
    worker: currentWorker(),
    jobsite: selectedJobsite.jobsite,
    start: new Date().toISOString(),
  };
  setConnection("loading", "Opening shift");
  try {
    await recordClockState("Clocked In", nextShift);
    state.activeShifts[currentWorker()] = nextShift;
    saveState();
    setConnection("ready", "Clocked in");
    await loadMyHours({ quiet: true, renderBefore: false, renderAfter: false });
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
  state.shifts.unshift(completed);
  state.lastSync = "Saving";
  saveState();
  render();
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

  completed.nextOpenShift = {
    id: newId(),
    worker: currentWorker(),
    jobsite: nextJobsite,
    start: now,
    travelFrom: current.jobsite,
  };
  state.shifts.unshift(completed);
  state.lastSync = "Saving";
  closeSwitchDialog();
  saveState();
  render();
  const result = await saveCompletedShift(completed);
  if (result?.ok) showToast("New jobsite started");
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
    applyCompletedShiftSideEffects(shift);
    state.lastSync = "Saved to Payroll 2.0";
    await loadMyHours({ quiet: true, renderBefore: false, renderAfter: false });
    saveState();
    setConnection("ready", "Saved to Payroll 2.0");
    return { ok: true, data };
  } catch (error) {
    if (isSessionExpiredError(error)) {
      handleExpiredSessionSave(shift);
      return { ok: false, error };
    }
    updateShiftSync(shift.id, { syncStatus: "failed", error: error.message });
    await notifySaveProblem(shift, error);
    state.lastSync = "Save failed, try again";
    saveState();
    setConnection("error", "Save failed, try again");
    return { ok: false, error };
  } finally {
    render();
  }
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
    clientShiftId: shift.id,
    worker: shift.worker,
    date: localDateKey(new Date(shift.start)),
    jobsite: shift.jobsite,
    startIso: shift.start,
    endIso: shift.end,
    lunch: shift.lunch === "Yes" ? "Yes" : "No",
    notes: "",
    clearOpenShift: !!shift.clearOpenShift,
    nextOpenShift: shift.nextOpenShift ? {
      clientShiftId: shift.nextOpenShift.id,
      worker: shift.nextOpenShift.worker,
      date: localDateKey(new Date(shift.nextOpenShift.start)),
      jobsite: shift.nextOpenShift.jobsite,
      startIso: shift.nextOpenShift.start,
      deviceId: state.deviceId || "",
    } : null,
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
  const canShowEmployeeAbsentAction = !current && !absent && canMarkEmployeeAbsent();
  const connectionStatus = clockConnectionStatus();
  const connectionReady = connectionStatus.state === "ready";

  els.liveClock.textContent = new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  }).format(new Date());
  els.statusPanel.style.setProperty("--site-color", site?.colour || "#007f73");
  els.siteSwatch.style.background = selectedJobsite?.colour || "#8a94a6";
  els.clockButton.disabled = current
    ? !connectionReady || !canClock || absent
    : !connectionReady || !canClock || absent || !selectedJobsite;
  els.switchButton.disabled = !connectionReady || !canClock;
  const siteSelectDisabled = !connectionReady || !!current || !canClock || absent;
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

  if (!apiReady()) {
    els.statusDetail.textContent = current ? "" : "Where are you working today?";
  } else if (!payroll.jobsites.length) {
    els.statusDetail.textContent = current ? "" : "Where are you working today?";
  } else if (absent) {
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
}

function renderTodayClockStatusCards() {
  const summary = dailyTimeSummaryFor(currentWorker(), todayKey());
  els.todayClockIn.textContent = summary.clockInAt ? timeLabel(summary.clockInAt) : "Not Clocked In";
  const clockOut = clockOutDisplay(summary);
  els.todayClockOut.textContent = clockOut.text;
  els.todayClockOutCard.classList.toggle("pending", clockOut.state === "pending");
  els.todayClockOutCard.classList.toggle("complete", clockOut.state === "complete");
  els.todayClockOutCard.classList.toggle("incomplete", clockOut.state === "incomplete");
}

function clockOutDisplay(summary) {
  if (summary.pending) return { text: "Pending", state: "pending" };
  if (summary.clockOutAt) return { text: timeLabel(summary.clockOutAt), state: "complete" };
  if (summary.clockInAt) return { text: "Not Clocked Out", state: "incomplete" };
  return { text: "—", state: "empty" };
}

function clockConnectionStatus() {
  if (!apiReady()) {
    return { state: "offline", text: "🔴 Offline", className: "problem" };
  }
  if (bootstrapLoading) {
    return { state: "connecting", text: "🟡 Connecting...", className: "connecting" };
  }
  if (state.lastSync === "Connection failed" || els.connectionBar.classList.contains("error")) {
    return { state: "offline", text: "🔴 Offline", className: "problem" };
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
  `;
  const rows = myHoursRowsForDisplay();
  if (!rows.length) {
    els.myHoursList.innerHTML = `<p class="empty-state">No clock records in the current payroll period</p>`;
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
  `;
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

  const today = todayKey();
  if (dateWithinPeriod(today, period)) {
    const todaySummary = dailyTimeSummaryFor(currentWorker(), today);
    if (todaySummary.clockInAt || todaySummary.clockOutAt || todaySummary.pending) {
      const summary = byDate[today] || emptyDailyTimeSummary(today);
      summary.clockInAt = earliestTime(summary.clockInAt, todaySummary.clockInAt);
      summary.clockOutAt = latestTime(summary.clockOutAt, todaySummary.clockOutAt);
      summary.pending = summary.pending || todaySummary.pending;
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
        canRemoveAbsence: canMarkEmployeeAbsent(),
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
        ${person.canRemoveAbsence
          ? `<button class="mini-pill absence-remove-button" type="button" data-worker="${escapeHtml(person.worker)}">Undo Absent</button>`
          : `<span class="mini-pill ${person.statusClass}">${escapeHtml(person.status)}</span>`}
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
      people: section.people,
    })),
  })));
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

  const switchedPeople = switchedJobsitePeople();

  return [
    {
      key: "notClockedIn",
      title: "Not Clocked In",
      actionable: true,
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
      key: "stillClockedIn",
      title: "Still Clocked In",
      actionable: true,
      people: isAfterStillClockedInAlertTime() ? [...activeMap.values()].sort(compareAlertPeople) : [],
    },
    {
      key: "saveProblems",
      title: "Save Problems",
      actionable: true,
      people: failed.concat(pending)
        .map((shift) => ({
          worker: shift.worker,
          status: shift.syncStatus === "pending" ? "Pending Save" : "Save Failed",
          statusClass: shift.syncStatus === "pending" ? "pending" : "failed",
          detail: shift.error || (shift.syncStatus === "pending" ? "Waiting to save" : "Save failed, try again"),
        }))
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
      sections: ["notClockedIn", "stillClockedIn", "saveProblems"].map((key) => byKey.get(key)),
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
        <span class="alert-count">${section.people.length}</span>
      </summary>
      <div class="alert-people">
        ${section.people.length ? section.people.map(renderAlertPerson).join("") : `<p class="empty-state">No items right now.</p>`}
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
  const statusText = mode === "ready"
    ? "Connected to Payroll 2.0"
    : mode === "error"
      ? "Lost connection to Payroll 2.0"
      : "Connecting to Payroll 2.0";
  els.connectionText.textContent = statusText;
  els.connectionBar.dataset.detail = message || "";
  els.connectionBar.setAttribute("aria-label", message ? `${statusText}: ${message}` : statusText);
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
