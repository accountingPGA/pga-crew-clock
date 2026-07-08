const STORAGE_KEY = "pinnacle-crew-clock-ui-v1";
const APP_TIME_ZONE = "America/Vancouver";
const CONFIG_API_URL = "https://script.google.com/macros/s/AKfycbxCra1iI6QIaMAt3JT3ZB1Wlkp24nkQRxUbUbORRJ5d53kVBqfb44KCNl17FIDqUPC9/exec";

let employees = [];
let sites = [];
let jobsiteMeta = {};
let serverSubmissions = [];
let submissions = [];
let features = {};
let state = loadUiState();
let currentUser = null;
let pinBuffer = "";
let pendingLunchAction = null;
let pendingLunchSubmissionId = null;
let pendingSwitchLunch = null;
let isProcessing = false;
let toastTimer;
let renderTimer;
const expandedRouteEmployeeIds = new Set();
const collapsedAlertGroupKeys = new Set();
const ALERT_GROUPS = [
  { key: "notCheckedIn", label: "Not Checked In Yet" },
  { key: "stillClockedIn", label: "Still Clocked In" },
  { key: "lunchNotAnswered", label: "Lunch Not Answered" },
  { key: "notListedJobsite", label: "Not Listed Jobsite" },
  { key: "syncImportIssue", label: "Sync / Import Issue" }
];

const els = {
  loginScreen: document.querySelector("#loginScreen"),
  appShell: document.querySelector("#appShell"),
  pinDots: document.querySelectorAll("#pinDots span"),
  pinButtons: document.querySelectorAll("[data-pin]"),
  pinBackButton: document.querySelector("[data-pin-back]"),
  pinClearButton: document.querySelector("[data-pin-clear]"),
  loginError: document.querySelector("#loginError"),
  currentUserLabel: document.querySelector("#currentUserLabel"),
  logoutButton: document.querySelector("#logoutButton"),
  siteSelect: document.querySelector("#siteSelect"),
  liveClock: document.querySelector("#liveClock"),
  statusPill: document.querySelector("#statusPill"),
  clockTitle: document.querySelector("#clockTitle"),
  statusDetail: document.querySelector("#statusDetail"),
  syncMessage: document.querySelector("#syncMessage"),
  primaryActions: document.querySelector("#primaryActions"),
  clockButton: document.querySelector("#clockButton"),
  switchButton: document.querySelector("#switchButton"),
  syncStatus: document.querySelector("#syncStatus"),
  lunchSummary: document.querySelector("#lunchSummary"),
  todayRecordCount: document.querySelector("#todayRecordCount"),
  timelineList: document.querySelector("#timelineList"),
  entryCount: document.querySelector("#entryCount"),
  tabs: document.querySelectorAll(".tab"),
  views: document.querySelectorAll(".view"),
  managerOnly: document.querySelectorAll(".manager-only"),
  alertsTab: document.querySelector("#alertsTab"),
  alertsTabLabel: document.querySelector("#alertsTabLabel"),
  liveJobsiteList: document.querySelector("#liveJobsiteList"),
  checkedInTodayCount: document.querySelector("#checkedInTodayCount"),
  attentionList: document.querySelector("#attentionList"),
  issueCount: document.querySelector("#issueCount"),
  exportButton: document.querySelector("#exportButton"),
  lunchDialog: document.querySelector("#lunchDialog"),
  lunchYesButton: document.querySelector("#lunchYesButton"),
  lunchNoButton: document.querySelector("#lunchNoButton"),
  switchDialog: document.querySelector("#switchDialog"),
  switchSiteSelect: document.querySelector("#switchSiteSelect"),
  switchConfirmButton: document.querySelector("#switchConfirmButton"),
  switchCancelButton: document.querySelector("#switchCancelButton"),
  toast: document.querySelector("#toast")
};

function todayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function loadUiState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      selectedSite: saved.selectedSite || "",
      localSubmissions: normalizeLocalSubmissions(saved.localSubmissions || [])
    };
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return { selectedSite: "", localSubmissions: [] };
  }
}

function saveUiState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    selectedSite: state.selectedSite || "",
    localSubmissions: pruneLocalSubmissions(state.localSubmissions || [])
  }));
}

function setup() {
  els.pinButtons.forEach((button) => button.addEventListener("click", () => addPinDigit(button.dataset.pin)));
  els.pinBackButton.addEventListener("click", removePinDigit);
  els.pinClearButton.addEventListener("click", clearPin);
  els.logoutButton.addEventListener("click", logout);
  els.siteSelect.addEventListener("change", () => {
    state.selectedSite = els.siteSelect.value;
    saveUiState();
    render();
  });

  els.clockButton.addEventListener("click", toggleClock);
  els.switchButton.addEventListener("click", beginSwitchJobsite);
  els.lunchYesButton.addEventListener("click", () => handleLunchAnswer(true));
  els.lunchNoButton.addEventListener("click", () => handleLunchAnswer(false));
  els.switchConfirmButton.addEventListener("click", confirmSwitchJobsite);
  els.switchCancelButton.addEventListener("click", closeSwitchDialog);
  els.exportButton.addEventListener("click", openConfiguredExport);

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("manager-only") && !isManager()) return;
      showView(tab.dataset.tab);
    });
  });

  renderSelect(els.siteSelect, sites, state.selectedSite);
  showLogin();

  window.clearInterval(renderTimer);
  renderTimer = window.setInterval(() => {
    renderClockOnly();
    if (currentUser) render();
  }, 1000);
}

async function loadConfig() {
  const data = await apiGet("config");
  normalizeConfig(data);
  if (!employees.length) throw new Error("No active employees returned from App Employees");
  if (!sites.length) throw new Error("No active jobsites returned from Lists");
  state.selectedSite = sites.includes(state.selectedSite) ? state.selectedSite : sites[0];
  saveUiState();
}

function normalizeConfig(data) {
  const loadedEmployees = Array.isArray(data?.employees) ? data.employees : [];
  const loadedJobsites = Array.isArray(data?.jobsites) ? data.jobsites : [];
  const loadedSubmissions = Array.isArray(data?.submissions) ? data.submissions : [];

  employees = loadedEmployees
    .map((employee) => ({
      id: String(employee.id || employee.employeeId || "").trim(),
      name: String(employee.name || employee.employeeName || "").trim(),
      initials: String(employee.initials || initialsFor(employee.name || employee.employeeName)).trim(),
      pin: String(employee.pin || "").trim(),
      role: String(employee.role || "employee").trim().toLowerCase()
    }))
    .filter((employee) => employee.id && employee.name && employee.pin)
    .map((employee) => ({ ...employee, role: employee.role === "manager" ? "manager" : "employee" }));

  const normalizedJobsites = loadedJobsites
    .map((site) => {
      if (typeof site === "string") return { name: site.trim(), color: "#6B7280", status: "Active" };
      return {
        name: String(site.name || site.jobsite || site.site || "").trim(),
        area: String(site.area || "").trim(),
        color: String(site.color || "#6B7280").trim(),
        status: String(site.status || "Active").trim()
      };
    })
    .filter((site) => site.name);

  sites = normalizedJobsites.map((site) => site.name);
  jobsiteMeta = normalizedJobsites.reduce((map, site) => {
    map[site.name] = site;
    return map;
  }, {});

  serverSubmissions = loadedSubmissions.map(normalizeSubmission).filter((row) => row.submissionId);
  mergeSubmissions();
  features = data?.features || {};
}

function normalizeSubmission(row) {
  const worker = String(row.worker || "").trim();
  return {
    submissionId: String(row.submissionId || row.id || "").trim(),
    submittedAt: String(row.submittedAt || "").trim(),
    employeeId: String(row.employeeId || row.workerId || safeWorkerId(worker) || "").trim(),
    employeeName: String(row.employeeName || row.name || worker || "").trim(),
    date: String(row.date || "").trim(),
    jobsite: String(row.jobsite || "").trim(),
    startTime: String(row.startTime || "").trim(),
    endTime: String(row.endTime || "").trim(),
    lunch: normalizeLunch(row.lunch),
    imported: String(row.imported || row.importStatus || "").trim(),
    importedAt: String(row.importedAt || "").trim(),
    rowNumber: Number(row.rowNumber || 0),
    localOnly: Boolean(row.localOnly),
    syncStatus: String(row.syncStatus || "").trim(),
    error: String(row.error || "").trim(),
    startIso: String(row.startIso || row.startTime || "").trim(),
    endIso: String(row.endIso || row.endTime || "").trim(),
    serverSubmissionId: String(row.serverSubmissionId || "").trim()
  };
}

function normalizeLocalSubmissions(rows) {
  if (!Array.isArray(rows)) return [];
  return pruneLocalSubmissions(rows.map(normalizeSubmission).filter((row) => row.submissionId));
}

function pruneLocalSubmissions(rows) {
  const today = todayKey();
  return rows.filter((row) => row.date === today || !row.endTime);
}

function mergeSubmissions() {
  state.localSubmissions = pruneLocalSubmissions(state.localSubmissions || []);
  submissions = [...serverSubmissions, ...state.localSubmissions];
}

function updateLocalSubmissions(updater) {
  state.localSubmissions = pruneLocalSubmissions(updater(state.localSubmissions || []));
  mergeSubmissions();
  saveUiState();
}

function normalizeLunch(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "yes" || text === "true" || text === "30m" || text === "30 min") return "Yes";
  if (text === "no" || text === "false" || text === "none") return "No";
  return "";
}

async function apiGet(action) {
  const response = await fetch(`${CONFIG_API_URL}?action=${encodeURIComponent(action)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  const data = await response.json();
  if (data.success === false || data.ok === false) throw new Error(data.message || data.error || "API request failed");
  return data;
}

async function apiPost(action, payload) {
  const response = await fetch(CONFIG_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...payload })
  });

  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  const data = await response.json();
  if (data.success === false || data.ok === false) throw new Error(data.message || data.error || "API request failed");
  if (hasConfigPayload(data)) normalizeConfig(data);
  return data;
}

function hasConfigPayload(data) {
  return Array.isArray(data?.employees) || Array.isArray(data?.jobsites) || Array.isArray(data?.submissions);
}

function renderSelect(select, options, selectedValue) {
  select.innerHTML = options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("");
  select.value = selectedValue && options.includes(selectedValue) ? selectedValue : options[0] || "";
}

function initialsFor(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "??";
}

function safeWorkerId(worker) {
  return String(worker || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function addPinDigit(value) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += value;
  renderPin();
  if (pinBuffer.length === 4) window.setTimeout(authenticatePin, 160);
}

function removePinDigit() {
  pinBuffer = pinBuffer.slice(0, -1);
  renderPin();
}

function clearPin() {
  pinBuffer = "";
  els.loginError.textContent = "";
  renderPin();
}

function renderPin() {
  els.pinDots.forEach((dot, index) => dot.classList.toggle("filled", index < pinBuffer.length));
}

function authenticatePin() {
  const employee = employees.find((item) => item.pin === pinBuffer);
  if (!employee) {
    els.loginError.textContent = "Incorrect PIN. Please try again.";
    pinBuffer = "";
    renderPin();
    return;
  }

  currentUser = employee;
  pinBuffer = "";
  renderPin();
  els.loginError.textContent = "";
  showApp();
  showToast(`Welcome, ${employee.name}`);
}

function showLogin() {
  currentUser = null;
  els.loginScreen.classList.remove("app-hidden");
  els.appShell.classList.add("app-hidden");
  pinBuffer = "";
  renderPin();
}

function showApp() {
  els.loginScreen.classList.add("app-hidden");
  els.appShell.classList.remove("app-hidden");
  applyPermissions();
  showView(isManager() ? "summary" : "clock");
  render();
}

function logout() {
  if (!currentUser) return;
  if (!window.confirm("Log out? You will need to enter your PIN again.")) return;
  showLogin();
}

function isManager() {
  return String(currentUser?.role || "").toLowerCase() === "manager";
}

function applyPermissions() {
  const manager = isManager();
  document.body.classList.toggle("employee-mode", !manager);

  els.managerOnly.forEach((element) => {
    element.hidden = !manager;
    element.classList.toggle("app-hidden", !manager);
  });

  const hasExport = Boolean(features.exportUrl || features.export === true);
  els.exportButton.hidden = !manager || !hasExport;

  if (!manager) showView("clock");
  if (currentUser) {
    els.currentUserLabel.textContent = `${currentUser.name}${manager ? " (Manager)" : ""}`;
  }
}

function showView(target) {
  els.tabs.forEach((item) => item.classList.toggle("active", item.dataset.tab === target));
  els.views.forEach((view) => view.classList.toggle("active", view.id === `${target}View`));
}

function selectedEmployee() {
  return currentUser;
}

function todaySubmissions() {
  const today = todayKey();
  return submissions.filter((row) => row.date === today || !row.endTime);
}

function submissionsFor(employeeId) {
  return todaySubmissions().filter((row) => row.employeeId === employeeId);
}

function activeSubmission(employeeId) {
  return submissions.find((row) => row.employeeId === employeeId && !row.endTime);
}

async function toggleClock() {
  if (!currentUser) return showLogin();
  const current = activeSubmission(currentUser.id);

  if (current) {
    openLunchDialog("clockOut", current.submissionId);
    return;
  }

  await clockIn();
}

async function clockIn() {
  const existingOpen = activeSubmission(currentUser.id);
  if (existingOpen) return showError("You are already clocked in.");

  const jobsite = els.siteSelect.value || state.selectedSite;
  if (!jobsite) return showError("Please select a jobsite.");

  try {
    const startedAt = new Date();
    const row = localClockRow(jobsite, startedAt);
    updateLocalSubmissions((rows) => [row, ...rows.filter((item) => item.employeeId !== currentUser.id || item.endTime)]);
    state.selectedSite = jobsite;
    saveUiState();
    setSyncMessage("Clocked in. Saves at clock out.", false);
    showToast("Clocked in");
    render();
  } catch (error) {
    console.error(error);
    showError(error.message ? `Clock In failed. ${error.message}` : "Clock In failed. Please try again.");
  }
}

function localClockRow(jobsite, startedAt) {
  const startIso = startedAt.toISOString();
  return {
    submissionId: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    submittedAt: startIso,
    employeeId: currentUser.id,
    employeeName: currentUser.name,
    date: todayKey(startedAt),
    jobsite,
    startTime: startIso,
    endTime: "",
    lunch: "",
    imported: "Local",
    importedAt: "",
    rowNumber: Date.now(),
    localOnly: true,
    syncStatus: "open",
    error: "",
    startIso,
    endIso: "",
    serverSubmissionId: ""
  };
}

function beginSwitchJobsite() {
  const current = activeSubmission(currentUser?.id);
  if (!current) return showError("No open row found. Please refresh and try again.");
  openLunchDialog("switch", current.submissionId);
}

function openLunchDialog(action, submissionId) {
  pendingLunchAction = action;
  pendingLunchSubmissionId = submissionId;
  els.lunchDialog.hidden = false;
  els.lunchYesButton.focus();
}

async function handleLunchAnswer(tookLunch) {
  const action = pendingLunchAction;
  const submissionId = pendingLunchSubmissionId;
  if (!action || !submissionId) {
    closeLunchDialog();
    return;
  }

  if (action === "switch") {
    pendingSwitchLunch = tookLunch ? "Yes" : "No";
    closeLunchDialog();
    openSwitchDialog();
    return;
  }

  await clockOut(submissionId, tookLunch ? "Yes" : "No");
}

async function clockOut(submissionId, lunch) {
  const current = activeSubmission(currentUser.id);
  if (!current) {
    closeLunchDialog();
    return showError("No open row found. You are already clocked out.");
  }

  if (current.localOnly) {
    closeLunchDialog();
    await completeLocalShift(current, lunch);
    return;
  }

  await runSyncedAction(async () => {
    await apiPost("clockOut", {
      employeeId: currentUser.id,
      submissionId,
      lunch
    });
    closeLunchDialog();
    showToast("Clocked out and synced");
  });
}

function closeLunchDialog() {
  els.lunchDialog.hidden = true;
  pendingLunchAction = null;
  pendingLunchSubmissionId = null;
}

function openSwitchDialog() {
  const current = activeSubmission(currentUser?.id);
  if (!current) return showError("No open row found. Please refresh and try again.");
  const nextSite = sites.find((site) => site !== current.jobsite) || sites[0];
  renderSelect(els.switchSiteSelect, sites, nextSite);
  els.switchDialog.hidden = false;
  els.switchSiteSelect.focus();
}

function closeSwitchDialog() {
  els.switchDialog.hidden = true;
  pendingSwitchLunch = null;
}

async function confirmSwitchJobsite() {
  const current = activeSubmission(currentUser?.id);
  const nextJobsite = els.switchSiteSelect.value;

  if (!current) return showError("No open row found. Please refresh and try again.");
  if (!pendingSwitchLunch) return showError("Please answer the lunch question first.");
  if (!nextJobsite) return showError("Please select the new jobsite.");
  if (nextJobsite === current.jobsite) return showError("Select a different jobsite.");

  if (current.localOnly) {
    closeSwitchDialog();
    await completeLocalShift(current, pendingSwitchLunch, nextJobsite);
    return;
  }

  await runSyncedAction(async () => {
    await apiPost("switchJobsite", {
      employeeId: currentUser.id,
      submissionId: current.submissionId,
      lunch: pendingSwitchLunch,
      newJobsite: nextJobsite
    });
    state.selectedSite = nextJobsite;
    saveUiState();
    closeSwitchDialog();
    showToast("Jobsite switched and synced");
  });
}

async function completeLocalShift(current, lunch, nextJobsite = "") {
  const endedAt = new Date();
  const completed = {
    ...current,
    endTime: endedAt.toISOString(),
    lunch,
    syncStatus: "pending",
    error: "",
    endIso: endedAt.toISOString()
  };
  const nextOpen = nextJobsite ? localClockRow(nextJobsite, endedAt) : null;

  updateLocalSubmissions((rows) => {
    const withoutCurrent = rows.filter((row) => row.submissionId !== current.submissionId);
    return nextOpen ? [nextOpen, completed, ...withoutCurrent] : [completed, ...withoutCurrent];
  });
  if (nextJobsite) {
    state.selectedSite = nextJobsite;
    saveUiState();
  }

  setProcessing(true);
  setSyncMessage("Saving completed shift...", false);
  try {
    const saved = await saveCompletedShift(completed);
    updateLocalSubmissions((rows) => rows.map((row) => row.submissionId === completed.submissionId
      ? { ...row, syncStatus: "saved", serverSubmissionId: saved.submissionId || "", error: "" }
      : row
    ));
    setSyncMessage("Synced", false);
    showToast(nextJobsite ? "Jobsite switched" : "Clocked out and synced");
  } catch (error) {
    console.error(error);
    updateLocalSubmissions((rows) => rows.map((row) => row.submissionId === completed.submissionId
      ? { ...row, syncStatus: "failed", error: error.message || "Save failed" }
      : row
    ));
    showError(error.message ? `Not synced. ${error.message}` : "Not synced. Completed shift kept on this device.");
  } finally {
    setProcessing(false);
    render();
  }
}

async function saveCompletedShift(row) {
  const token = await ensureSessionToken();
  return apiPost("saveShift", {
    token,
    shift: {
      clientShiftId: row.submissionId,
      worker: currentUser.name,
      date: row.date,
      jobsite: row.jobsite,
      startIso: row.startIso || row.startTime,
      endIso: row.endIso || row.endTime,
      lunch: row.lunch,
      notes: ""
    }
  });
}

async function ensureSessionToken() {
  if (currentUser?.sessionToken) return currentUser.sessionToken;
  const data = await apiPost("login", { pin: currentUser.pin });
  if (!data.token) throw new Error("Session could not be verified. Please log out and sign in again.");
  currentUser.sessionToken = data.token;
  currentUser.expiresAt = data.expiresAt || "";
  return currentUser.sessionToken;
}

async function runSyncedAction(callback) {
  setProcessing(true);
  setSyncMessage("Syncing...", false);
  try {
    await callback();
    setSyncMessage("Synced", false);
    render();
  } catch (error) {
    console.error(error);
    setSyncMessage("Not synced. Please try again.", true);
    showError(error.message ? `Not synced. ${error.message}` : "Not synced. Please try again.");
  } finally {
    setProcessing(false);
  }
}

function setProcessing(processing) {
  isProcessing = processing;
  [
    els.clockButton,
    els.switchButton,
    els.lunchYesButton,
    els.lunchNoButton,
    els.switchConfirmButton,
    els.switchCancelButton,
    els.siteSelect
  ].forEach((element) => {
    if (element) element.disabled = processing;
  });
  render();
}

function setSyncMessage(message, isError) {
  els.syncMessage.textContent = message;
  els.syncMessage.classList.toggle("error", Boolean(isError));
  els.syncStatus.textContent = isError ? "Not synced" : message || "Ready";
}

function renderClockOnly() {
  els.liveClock.textContent = new Intl.DateTimeFormat([], {
    timeZone: APP_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date());
}

function render() {
  if (!currentUser) return;
  applyPermissions();
  renderClockOnly();

  const current = activeSubmission(currentUser.id);
  const mySubmissions = sortSubmissions(submissionsFor(currentUser.id));

  if (current) {
    els.statusPill.textContent = "CLOCKED IN";
    els.statusPill.className = "status-pill in";
    els.clockTitle.textContent = "Current Jobsite";
    els.statusDetail.textContent = current.jobsite;
    els.statusDetail.hidden = false;
    els.siteSelect.value = current.jobsite;
    els.siteSelect.disabled = true;
    els.clockButton.className = "primary-button stop";
    els.clockButton.innerHTML = clockIcon() + " Clock out";
    els.switchButton.hidden = false;
    els.primaryActions.classList.add("with-switch");
  } else {
    els.statusPill.textContent = "CLOCKED OUT";
    els.statusPill.className = "status-pill out";
    els.clockTitle.textContent = "Ready for Jobsite";
    els.statusDetail.textContent = "";
    els.statusDetail.hidden = true;
    els.siteSelect.disabled = isProcessing;
    els.siteSelect.value = state.selectedSite || sites[0] || "";
    els.clockButton.className = "primary-button";
    els.clockButton.innerHTML = clockIcon() + " Clock in";
    els.switchButton.hidden = true;
    els.primaryActions.classList.remove("with-switch");
  }

  els.clockButton.disabled = isProcessing;
  els.switchButton.disabled = isProcessing;
  els.lunchSummary.textContent = lunchSummaryLabel(mySubmissions, current);
  els.todayRecordCount.textContent = String(mySubmissions.length);
  els.entryCount.textContent = `${mySubmissions.length} ${mySubmissions.length === 1 ? "row" : "rows"}`;
  renderTimeline(mySubmissions);
  if (isManager()) renderManager();
}

function renderTimeline(items) {
  if (!items.length) {
    els.timelineList.innerHTML = `<p class="empty-state">No rows today</p>`;
    return;
  }

  els.timelineList.innerHTML = items
    .map((row) => {
      const status = row.endTime ? "Closed" : "Open";
      const range = `${timeLabel(row.startTime)} - ${row.endTime ? timeLabel(row.endTime) : "Now"}`;
      return `
        <article class="entry-card simple-shift-card">
          <div class="entry-main">
            <div>
              <span class="entry-title">${escapeHtml(row.jobsite)}</span>
              <span class="entry-sub">${range}</span>
              <span class="entry-sub">${lunchLabel(row)}</span>
            </div>
            <span class="mini-pill">${status}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderManager() {
  const alerts = findAlerts();
  renderDailySummary();
  renderAlerts(alerts);
  updateAlertsTab(alerts.length);
}

function renderDailySummary() {
  const todayRows = todayRowsOnly();
  const checkedInIds = new Set(todayRows.map((row) => row.employeeId));
  const activeRows = submissions.filter((row) => !row.endTime);
  const activeBySite = groupBy(activeRows, (row) => row.jobsite || "Not Listed");
  const activeSiteNames = Object.keys(activeBySite).sort((a, b) => a.localeCompare(b));

  els.checkedInTodayCount.textContent = `🟢 Checked in today: ${checkedInIds.size}`;

  const workingCards = activeSiteNames.map((site) => {
    const rows = activeBySite[site];
    const color = safeColor(jobsiteMeta[site]?.color);
    const people = rows
      .map((row) => {
        const employee = employees.find((item) => item.id === row.employeeId);
        const route = routeForEmployeeToday(row.employeeId);
        const hasTransfer = uniqueRouteSites(route).length > 1;
        const isExpanded = expandedRouteEmployeeIds.has(row.employeeId);
        const routeDetails = hasTransfer && isExpanded ? routeMarkup(route, row.jobsite) : "";
        const transferIndicator = hasTransfer ? `<span class="transfer-indicator" aria-label="Transferred today">🔄</span>` : "";
        const dataAttr = hasTransfer ? `data-route-employee="${escapeHtml(row.employeeId)}"` : "";
        const buttonHint = hasTransfer ? `role="button" tabindex="0" aria-expanded="${isExpanded}"` : "";

        return `
          <div class="jobsite-worker ${hasTransfer ? "has-route" : ""}" ${dataAttr} ${buttonHint}>
            <div class="worker-line">
              <span class="worker-name">${escapeHtml(employee?.name || row.employeeName || "Unknown")} ${transferIndicator}</span>
              <small>Since ${timeLabel(row.startTime)}</small>
            </div>
            ${routeDetails}
          </div>
        `;
      })
      .join("");

    return `
      <article class="jobsite-card" style="--site-color: ${color}">
        <header>
          <div>
            <span class="jobsite-name">${escapeHtml(site)} (${rows.length})</span>
          </div>
          <span class="site-dot" aria-hidden="true"></span>
        </header>
        <div class="jobsite-workers">${people}</div>
      </article>
    `;
  });

  els.liveJobsiteList.innerHTML = workingCards.join("") || `<p class="empty-state">No one is currently clocked in.</p>`;
  els.liveJobsiteList.querySelectorAll("[data-route-employee]").forEach((row) => {
    row.addEventListener("click", () => toggleRoute(row.dataset.routeEmployee));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleRoute(row.dataset.routeEmployee);
      }
    });
  });
}

function renderAlerts(alerts) {
  els.issueCount.textContent = alerts.length ? `🔴 ${alerts.length} Alerts` : "⚠️ Alerts";
  els.issueCount.classList.toggle("alert-count", alerts.length > 0);

  if (!alerts.length) {
    els.attentionList.innerHTML = `<p class="empty-state success-state">✅ No alerts today.</p>`;
    return;
  }

  const grouped = groupBy(alerts, (alert) => alert.type);
  els.attentionList.innerHTML = ALERT_GROUPS
    .filter((group) => grouped[group.key]?.length)
    .map((group) => alertSectionMarkup(group, grouped[group.key]))
    .join("");

  els.attentionList.querySelectorAll("[data-alert-group]").forEach((section) => {
    section.addEventListener("toggle", () => {
      if (section.open) collapsedAlertGroupKeys.delete(section.dataset.alertGroup);
      else collapsedAlertGroupKeys.add(section.dataset.alertGroup);
    });
  });
}

function alertSectionMarkup(group, alerts) {
  const high = alerts.some((alert) => alert.severity === "high");
  const isOpen = !collapsedAlertGroupKeys.has(group.key);
  const items = alerts
    .map((alert) => {
      const detail = alert.detail ? `<span class="alert-detail">— ${escapeHtml(alert.detail)}</span>` : "";
      return `
        <li>
          <span class="alert-person">${escapeHtml(alert.employee)}</span>
          ${detail}
        </li>
      `;
    })
    .join("");

  return `
    <details class="alert-section ${high ? "high" : ""}" data-alert-group="${escapeHtml(group.key)}" ${isOpen ? "open" : ""}>
      <summary>
        <span>${escapeHtml(group.label)}</span>
        <span class="alert-section-count">(${alerts.length})</span>
      </summary>
      <ul class="alert-items">
        ${items}
      </ul>
    </details>
  `;
}

function updateAlertsTab(count) {
  if (!els.alertsTabLabel) return;
  els.alertsTab.classList.toggle("has-alerts", count > 0);
  els.alertsTabLabel.innerHTML = count
    ? `<span class="alert-tab-icon">🔴</span> ${count} Alerts`
    : `<span class="alert-tab-icon">⚠️</span> Alerts`;
}

function findAlerts() {
  const alerts = [];
  const todayRows = todayRowsOnly();
  const employeeIdsWithRows = new Set(todayRows.map((row) => row.employeeId));

  employees.forEach((employee) => {
    if (!employeeIdsWithRows.has(employee.id)) {
      alerts.push({
        type: "notCheckedIn",
        employeeId: employee.id,
        employee: employee.name,
        message: "Not Checked In Yet",
        severity: "medium"
      });
    }
  });

  todayRows.forEach((row) => {
    if (!row.endTime && isStillClockedTooLong(row)) {
      alerts.push({
        type: "stillClockedIn",
        employeeId: row.employeeId,
        employee: employeeName(row),
        message: "Still Clocked In",
        detail: row.jobsite || "Not Listed",
        severity: "high"
      });
    }

    if (row.endTime && !row.lunch) {
      alerts.push({
        type: "lunchNotAnswered",
        employeeId: row.employeeId,
        employee: employeeName(row),
        message: "Lunch Not Answered",
        detail: row.jobsite || "Not Listed",
        severity: "medium"
      });
    }

    if (String(row.jobsite || "").trim().toLowerCase() === "not listed") {
      alerts.push({
        type: "notListedJobsite",
        employeeId: row.employeeId,
        employee: employeeName(row),
        message: "Not Listed jobsite",
        severity: "medium"
      });
    }

    if (hasImportIssue(row)) {
      alerts.push({
        type: "syncImportIssue",
        employeeId: row.employeeId,
        employee: employeeName(row),
        message: "Sync/import issue",
        severity: "high"
      });
    }
  });

  return alerts;
}

function employeeName(row) {
  return employees.find((item) => item.id === row.employeeId)?.name || row.employeeName || "Unknown";
}

function toggleRoute(employeeId) {
  if (expandedRouteEmployeeIds.has(employeeId)) expandedRouteEmployeeIds.delete(employeeId);
  else expandedRouteEmployeeIds.add(employeeId);
  renderManager();
}

function routeForEmployeeToday(employeeId) {
  return sortSubmissionsAscending(submissionsFor(employeeId))
    .map((row) => ({ time: timeLabel(row.startTime), site: row.jobsite || "Not Listed" }))
    .filter((item, index, list) => index === 0 || item.site !== list[index - 1].site);
}

function uniqueRouteSites(route) {
  return [...new Set(route.map((item) => item.site))];
}

function routeMarkup(route, currentSite) {
  return `
    <div class="route-details">
      <span class="route-title">Today's route</span>
      ${route
        .map((item) => `
          <div class="route-row">
            <span>${escapeHtml(item.time)}</span>
            <span class="${item.site === currentSite ? "current-route-site" : ""}">${escapeHtml(item.site)}</span>
          </div>
        `)
        .join("")}
    </div>
  `;
}

function lunchSummaryLabel(rows, current) {
  if (current) return "Pending";
  const completed = rows.filter((row) => row.endTime).sort((a, b) => sortValue(b) - sortValue(a));
  if (!completed.length) return "-";
  return completed[0].lunch === "Yes" ? "30m" : "None";
}

function lunchLabel(row) {
  if (!row.endTime) return "Lunch pending";
  if (row.lunch === "Yes") return "Lunch: 30m";
  if (row.lunch === "No") return "Lunch: None";
  return "Lunch: missing";
}

function sortSubmissions(rows) {
  return rows.slice().sort((a, b) => sortValue(b) - sortValue(a));
}

function sortSubmissionsAscending(rows) {
  return rows.slice().sort((a, b) => sortValue(a) - sortValue(b));
}

function sortValue(row) {
  if (Number.isFinite(row.rowNumber) && row.rowNumber > 0) return row.rowNumber;
  const parsed = Date.parse(`${row.date || todayKey()} ${row.startTime || ""}`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function todayRowsOnly() {
  const today = todayKey();
  return submissions.filter((row) => row.date === today);
}

function isStillClockedTooLong(row) {
  const start = submissionDateTime(row, row.startTime);
  if (!start) return false;
  return Date.now() - start.getTime() >= 12 * 60 * 60 * 1000;
}

function submissionDateTime(row, timeValue) {
  const date = row.date || todayKey();
  const text = String(timeValue || "").trim();
  if (!text) return null;
  const parsed = new Date(`${date} ${text}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hasImportIssue(row) {
  const imported = String(row.imported || "").toLowerCase();
  const importedAt = String(row.importedAt || "").toLowerCase();
  return /error|fail|issue|sync/.test(`${imported} ${importedAt}`);
}

function groupBy(items, getKey) {
  return items.reduce((map, item) => {
    const key = getKey(item);
    if (!map[key]) map[key] = [];
    map[key].push(item);
    return map;
  }, {});
}

function safeColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#6B7280";
}

function timeLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /[T:-]/.test(text)) {
    return new Intl.DateTimeFormat([], {
      timeZone: APP_TIME_ZONE,
      hour: "numeric",
      minute: "2-digit"
    }).format(parsed);
  }
  return text;
}

function openConfiguredExport() {
  if (!isManager() || !features.exportUrl) return;
  window.open(features.exportUrl, "_blank", "noopener");
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function showError(message) {
  setSyncMessage(message, true);
  showToast(message);
}

function clockIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v7l4 2"/><circle cx="12" cy="12" r="9"/></svg>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function start() {
  try {
    await loadConfig();
    setup();
  } catch (error) {
    console.error(error);
    document.body.innerHTML = `
      <main class="app-shell config-error-shell">
        <section class="config-error-card">
          <h1>Crew Clock</h1>
          <h2>Connection issue</h2>
          <p>The app could not load employees and jobsites from Google Sheets.</p>
          <p class="muted">${escapeHtml(error.message || "Unknown error")}</p>
          <button class="primary-button" type="button" onclick="location.reload()">Try again</button>
        </section>
      </main>
    `;
  }
}

start();
