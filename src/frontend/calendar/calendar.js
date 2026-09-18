const state = {
  me: null, // token owner: { accountId, displayName, email }
  user: null, // currently viewed user: { accountId, displayName, email }
  view: 'month', // 'month' | 'week' | 'year'
  anchor: new Date(),
  showWeekends: false,
  expectedHours: 7,
  annualVacationDaysByYear: {},
  showVacationSummary: false,
  morningStart: '09:00',
  afternoonStart: '14:00',
  jiraSite: null,
  byDate: {},
  monthByDate: {},
  selectedDate: null, // YYYY-MM-DD, drives the "week" summary block; defaults to today
  selectedDates: new Set(), // Ctrl/Cmd-click adds or removes days from this selection
  selectedWeekByDate: {},
  refreshToken: 0, // prevents slower, older Jira responses replacing the latest view
  openIssuesCache: new Map(), // per-date cached suggestions, keyed by dateStr
  oofDates: new Set(), // dates marked as out-of-office for state.user
  vacationDates: new Set(), // dates marked as vacation for state.user
  publicHolidays: new Map(), // YYYY-MM-DD -> { name, localName }
  manualHolidays: new Map(), // locally configured YYYY-MM-DD holidays
  holidayCountry: '',
  holidayMode: 'mark',
};

const OOF_STORAGE_KEY = 'logwork_oof_v1';

async function loadOofDates(accountId) {
  const { oofByAccount = {} } = await chrome.storage.local.get('oofByAccount');
  return new Set(oofByAccount[accountId] || []);
}

async function setOofDate(accountId, dateStr, isOof) {
  const { oofByAccount = {}, vacationByAccount = {} } = await chrome.storage.local.get(['oofByAccount', 'vacationByAccount']);
  const set = new Set(oofByAccount[accountId] || []);
  if (isOof) set.add(dateStr);
  else set.delete(dateStr);
  oofByAccount[accountId] = Array.from(set);
  if (isOof) {
    const vacations = new Set(vacationByAccount[accountId] || []);
    vacations.delete(dateStr);
    vacationByAccount[accountId] = Array.from(vacations);
  }
  await chrome.storage.local.set({ oofByAccount, vacationByAccount });
  return set;
}

async function loadVacationDates(accountId) {
  const { vacationByAccount = {} } = await chrome.storage.local.get('vacationByAccount');
  return new Set(vacationByAccount[accountId] || []);
}

async function setVacationDate(accountId, dateStr, isVacation) {
  const { oofByAccount = {}, vacationByAccount = {} } = await chrome.storage.local.get(['oofByAccount', 'vacationByAccount']);
  const set = new Set(vacationByAccount[accountId] || []);
  if (isVacation) set.add(dateStr);
  else set.delete(dateStr);
  vacationByAccount[accountId] = Array.from(set);
  if (isVacation) {
    const oof = new Set(oofByAccount[accountId] || []);
    oof.delete(dateStr);
    oofByAccount[accountId] = Array.from(oof);
  }
  await chrome.storage.local.set({ oofByAccount, vacationByAccount });
  return set;
}

async function loadManualHolidays() {
  const { manualHolidays = {} } = await chrome.storage.local.get('manualHolidays');
  state.manualHolidays = new Map(Object.entries(manualHolidays));
  return state.manualHolidays;
}

async function saveManualHolidays() {
  await chrome.storage.local.set({ manualHolidays: Object.fromEntries(state.manualHolidays) });
}

function renderManualHolidayList() {
  const entries = [...state.manualHolidays.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'manual-holiday-empty';
    empty.textContent = 'No manual holidays configured.';
    els.manualHolidayList.replaceChildren(empty);
    return;
  }
  els.manualHolidayList.replaceChildren(...entries.map(([dateStr, holiday]) => {
    const row = document.createElement('div');
    row.className = 'manual-holiday-row';
    const info = document.createElement('span');
    info.textContent = `${dateStr} · ${holiday.localName || holiday.name}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'manual-holiday-remove';
    remove.setAttribute('aria-label', `Remove ${holiday.localName || holiday.name}`);
    remove.textContent = '✕';
    remove.addEventListener('click', async () => {
      state.manualHolidays.delete(dateStr);
      await saveManualHolidays();
      renderManualHolidayList();
      updateHolidayModeAvailability();
      await refresh();
    });
    row.append(info, remove);
    return row;
  }));
}

function updateHolidayModeAvailability() {
  els.holidayModeInput.disabled = !state.holidayCountry && state.manualHolidays.size === 0;
}

async function migrateLegacyOofData() {
  try {
    const legacy = JSON.parse(localStorage.getItem(OOF_STORAGE_KEY) || '{}');
    if (!legacy || !Object.keys(legacy).length) return;
    const { oofByAccount = {} } = await chrome.storage.local.get('oofByAccount');
    for (const [accountId, dates] of Object.entries(legacy)) {
      oofByAccount[accountId] = Array.from(new Set([...(oofByAccount[accountId] || []), ...(Array.isArray(dates) ? dates : [])]));
    }
    await chrome.storage.local.set({ oofByAccount });
    localStorage.removeItem(OOF_STORAGE_KEY);
  } catch (error) {
    console.error('Could not migrate legacy OOF data:', error);
  }
}

const els = {
  userInput: document.getElementById('userInput'),
  userSuggestions: document.getElementById('userSuggestions'),
  viewMonthBtn: document.getElementById('viewMonthBtn'),
  viewWeekBtn: document.getElementById('viewWeekBtn'),
  viewYearBtn: document.getElementById('viewYearBtn'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  todayBtn: document.getElementById('todayBtn'),
  periodLabel: document.getElementById('periodLabel'),
  showWeekendsInput: document.getElementById('showWeekendsInput'),
  expectedHoursInput: document.getElementById('expectedHoursInput'),
  annualVacationDaysInput: document.getElementById('annualVacationDaysInput'),
  annualVacationYearLabel: document.getElementById('annualVacationYearLabel'),
  vacationSummaryToggle: document.getElementById('vacationSummaryToggle'),
  morningStartInput: document.getElementById('morningStartInput'),
  afternoonStartInput: document.getElementById('afternoonStartInput'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsCloseBtn: document.getElementById('settingsCloseBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  settingsBackdrop: document.getElementById('settingsBackdrop'),
  holidayCountryInput: document.getElementById('holidayCountryInput'),
  holidayModeInput: document.getElementById('holidayModeInput'),
  manualHolidayDateInput: document.getElementById('manualHolidayDateInput'),
  manualHolidayNameInput: document.getElementById('manualHolidayNameInput'),
  addManualHolidayBtn: document.getElementById('addManualHolidayBtn'),
  manualHolidayError: document.getElementById('manualHolidayError'),
  manualHolidayList: document.getElementById('manualHolidayList'),
  autoLogInput: document.getElementById('autoLogInput'),
  autoLogInfoIcon: document.getElementById('autoLogInfoIcon'),
  manageCredentialsBtn: document.getElementById('manageCredentialsBtn'),
  exportDataBtn: document.getElementById('exportDataBtn'),
  importDataBtn: document.getElementById('importDataBtn'),
  importDataInput: document.getElementById('importDataInput'),
  statusBar: document.getElementById('statusBar'),
  calendarWeekdays: document.getElementById('calendarWeekdays'),
  calendarGrid: document.getElementById('calendarGrid'),
  summaryContent: document.getElementById('summaryContent'),
  dayDialog: document.getElementById('dayDialog'),
  dayDialogTitle: document.getElementById('dayDialogTitle'),
  dayDialogBody: document.getElementById('dayDialogBody'),
  bulkPanel: document.getElementById('bulkPanel'),
  bulkCount: document.getElementById('bulkCount'),
  bulkSummary: document.getElementById('bulkSummary'),
  bulkError: document.getElementById('bulkError'),
  bulkActions: document.getElementById('bulkActions'),
  bulkCloseBtn: document.getElementById('bulkCloseBtn'),
  bulkOofBtn: document.getElementById('bulkOofBtn'),
  bulkVacationBtn: document.getElementById('bulkVacationBtn'),
  bulkWorklogBtn: document.getElementById('bulkWorklogBtn'),
  bulkWorklogForm: document.getElementById('bulkWorklogForm'),
  bulkIssue: document.getElementById('bulkIssue'),
  bulkHours: document.getElementById('bulkHours'),
  bulkTime: document.getElementById('bulkTime'),
  bulkComment: document.getElementById('bulkComment'),
  bulkCancelBtn: document.getElementById('bulkCancelBtn'),
  bulkSaveBtn: document.getElementById('bulkSaveBtn'),
  setupDialog: document.getElementById('setupDialog'),
  setupForm: document.getElementById('setupForm'),
  setupSite: document.getElementById('setupSite'),
  setupEmail: document.getElementById('setupEmail'),
  setupToken: document.getElementById('setupToken'),
  setupError: document.getElementById('setupError'),
  setupSubmit: document.getElementById('setupSubmit'),
  setupDialogTitle: document.getElementById('setupDialogTitle'),
  setupIntro: document.getElementById('setupIntro'),
  setupCloseBtn: document.getElementById('setupCloseBtn'),
  deleteCredentialsBtn: document.getElementById('deleteCredentialsBtn'),
};

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n) { return n.toString().padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return fmtDate(new Date()); }
function isWeekend(d) { const wd = d.getDay(); return wd === 0 || wd === 6; }
function vacationAllowanceForYear(year) {
  const value = Number(state.annualVacationDaysByYear[String(year)]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
function syncVacationEntitlementInputs(year = state.anchor.getFullYear()) {
  els.annualVacationYearLabel.textContent = String(year);
  els.annualVacationDaysInput.value = String(vacationAllowanceForYear(year));
}
function quickTimeButtonsHtml() {
  const label = (time) => time.replace(/^0/, '');
  return `<div class="time-quick-picks"><button type="button" class="time-quick-btn" data-time="${state.morningStart}">${label(state.morningStart)}</button><button type="button" class="time-quick-btn" data-time="${state.afternoonStart}">${label(state.afternoonStart)}</button></div>`;
}
function startTimeFieldHtml(inputHtml) {
  // Do not nest the quick-pick buttons inside a <label>. A click on the
  // label's empty area can otherwise activate a control unexpectedly.
  return `<div class="time-field"><span class="time-field-label">Start time</span>${quickTimeButtonsHtml()}${inputHtml}</div>`;
}
function holidayForDate(dateStr) { return state.publicHolidays.get(dateStr) || null; }
function isVacation(dateStr) { return state.vacationDates.has(dateStr); }
function isAbsence(dateStr) { return state.oofDates.has(dateStr) || isVacation(dateStr); }
function isExcludedHoliday(dateStr) { return ['exclude', 'block'].includes(state.holidayMode) && Boolean(holidayForDate(dateStr)); }
function entriesInChronologicalOrder(entries) {
  return entries.slice().sort((a, b) => {
    const byStart = new Date(a.started || 0).getTime() - new Date(b.started || 0).getTime();
    return byStart || String(a.worklogId || '').localeCompare(String(b.worklogId || ''));
  });
}
function mondayIndex(d) { return (d.getDay() + 6) % 7; }

function startOfWeek(d) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - mondayIndex(copy));
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function getRange() {
  if (state.view === 'week') {
    const start = startOfWeek(state.anchor);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { gridStart: start, gridEnd: end, dataStart: start, dataEnd: end };
  }
  if (state.view === 'year') {
    const year = state.anchor.getFullYear();
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    return { gridStart: start, gridEnd: end, dataStart: start, dataEnd: end };
  }
  const year = state.anchor.getFullYear();
  const month = state.anchor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  const gridStart = startOfWeek(firstOfMonth);
  const gridEnd = new Date(startOfWeek(lastOfMonth));
  gridEnd.setDate(gridEnd.getDate() + 6);
  return { gridStart, gridEnd, dataStart: firstOfMonth, dataEnd: lastOfMonth };
}

function setStatus(msg, isError) {
  els.statusBar.textContent = msg || '';
  els.statusBar.classList.toggle('hidden', !msg);
  els.statusBar.classList.toggle('error', !!isError);
}

async function api(path, options) {
  const response = await chrome.runtime.sendMessage({ type: 'api', path, options: options || {} });
  if (!response?.ok) throw new Error(response?.error || 'Extension service unavailable.');
  return response.data;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function secondsToHours(s) { return s / 3600; }
// Hours are entered/edited in 30-minute increments only (0.5h steps).
function roundToHalfHour(h) { return Math.round(h * 2) / 2; }
function fmtHours(h) {
  if (h === 0) return '0h';
  return (Math.round(h * 100) / 100).toString() + 'h';
}

function badgeClass(hours, expected, weekend) {
  if (weekend) return hours > 0 ? 'good' : 'none';
  if (hours <= 0) return 'bad';
  if (hours < expected) return 'warn';
  return 'good';
}

function isOwnUser() {
  return state.me && state.user && state.me.accountId === state.user.accountId;
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------

async function ensureConfigured() {
  const status = await api('/api/config/status');
  if (status.site) state.jiraSite = status.site;
  if (status.configured) return true;
  if (status.site) els.setupSite.value = status.site;
  const result = await openSetupDialog({ required: true });
  const statusAfter = await api('/api/config/status');
  if (statusAfter.site) state.jiraSite = statusAfter.site;
  return result;
}

function jiraIssueUrl(issueKey) {
  return state.jiraSite ? `https://${state.jiraSite}/browse/${encodeURIComponent(issueKey)}` : null;
}

function openSetupDialog({ required = false } = {}) {
  return new Promise((resolve) => {
    els.setupDialogTitle.textContent = required ? 'Connect to Jira' : 'Manage Jira connection';
    els.setupIntro.firstChild.textContent = required
      ? 'No saved API token found. Generate one at '
      : 'Enter a new API token to replace the current connection. Generate one at ';
    els.setupSubmit.textContent = required ? 'Connect' : 'Update connection';
    els.setupCloseBtn.classList.toggle('hidden', required);
    els.deleteCredentialsBtn.classList.toggle('hidden', required);
    els.setupDialog.showModal();
    const onSubmit = async (e) => {
      e.preventDefault();
      els.setupError.classList.add('hidden');
      els.setupSubmit.disabled = true;
      els.setupSubmit.textContent = 'Connecting...';
      try {
        await api('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            site: els.setupSite.value,
            email: els.setupEmail.value,
            apiToken: els.setupToken.value,
          }),
        });
        els.setupForm.removeEventListener('submit', onSubmit);
        els.setupCloseBtn.removeEventListener('click', onClose);
        els.setupDialog.close();
        resolve(true);
      } catch (err) {
        els.setupError.textContent = err.message;
        els.setupError.classList.remove('hidden');
      } finally {
        els.setupSubmit.disabled = false;
        els.setupSubmit.textContent = required ? 'Connect' : 'Update connection';
      }
    };
    const onClose = () => {
      els.setupForm.removeEventListener('submit', onSubmit);
      els.setupCloseBtn.removeEventListener('click', onClose);
      els.setupDialog.close();
      resolve(false);
    };
    els.setupForm.addEventListener('submit', onSubmit);
    els.setupCloseBtn.addEventListener('click', onClose);
  });
}

els.manageCredentialsBtn.addEventListener('click', async () => {
  const config = await api('/api/config/status');
  els.setupSite.value = config.site || '';
  els.setupEmail.value = config.email || '';
  els.setupToken.value = '';
  els.setupError.classList.add('hidden');
  const changed = await openSetupDialog();
  if (changed) location.reload();
});

els.deleteCredentialsBtn.addEventListener('click', async () => {
  if (!confirm('Remove the saved Jira credentials from this Chrome profile?')) return;
  await api('/api/config', { method: 'DELETE' });
  location.reload();
});

// ---------------------------------------------------------------------------
// User picker
// ---------------------------------------------------------------------------

async function loadMe() {
  const me = await api('/api/me');
  state.me = me;
  state.user = me;
  els.userInput.value = `${me.displayName} <${me.email}>`;
}

let searchDebounce;
els.userInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = els.userInput.value.trim();
  if (q.length < 2) {
    els.userSuggestions.classList.add('hidden');
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const results = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      renderSuggestions(results);
    } catch (err) {
      console.error(err);
    }
  }, 250);
});

document.addEventListener('click', (e) => {
  if (!els.userSuggestions.contains(e.target) && e.target !== els.userInput) {
    els.userSuggestions.classList.add('hidden');
  }
});

// Single, persistent listener for the "add worklog" task picker — looked up
// live each click rather than captured once, since the day dialog's markup
// (including #issuePickerInput/#issueSuggestions) gets fully re-rendered
// every time it opens. A previous version registered this listener fresh
// inside the "+ Add worklog" button's own click handler; because the click
// that opens the form is still bubbling up to `document` at that moment, the
// brand-new listener fired immediately for that same click and could close
// the dropdown the instant it opened (fixed here by registering once, up
// front, instead of on every open).
document.addEventListener('click', (e) => {
  const suggestionsEl = document.getElementById('issueSuggestions');
  const issueInput = document.getElementById('issuePickerInput');
  if (!suggestionsEl || !issueInput) return;
  const picker = issueInput.closest('.issue-picker');
  // The input can retain focus after a click alongside it. Use the picker
  // boundaries rather than focus state so that click also closes suggestions.
  if (!picker?.contains(e.target)) {
    suggestionsEl.classList.add('hidden');
  }
});

function renderSuggestions(results) {
  if (!results.length) {
    els.userSuggestions.classList.add('hidden');
    els.userSuggestions.innerHTML = '';
    return;
  }
  els.userSuggestions.innerHTML = results
    .map(
      (u, i) => `<div class="suggestion-item" data-idx="${i}">
        <span class="name">${escapeHtml(u.displayName)}</span>
        <span class="email">${escapeHtml(u.email || u.accountId)}</span>
      </div>`
    )
    .join('');
  els.userSuggestions.classList.remove('hidden');
  els.userSuggestions.querySelectorAll('.suggestion-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      const u = results[i];
      state.user = { accountId: u.accountId, displayName: u.displayName, email: u.email };
      els.userInput.value = `${u.displayName}${u.email ? ` <${u.email}>` : ''}`;
      els.userSuggestions.classList.add('hidden');
      refresh();
    });
  });
}

// ---------------------------------------------------------------------------
// Calendar rendering
// ---------------------------------------------------------------------------

function updatePeriodLabel() {
  if (state.view === 'week') {
    const { dataStart, dataEnd } = getRange();
    els.periodLabel.textContent = `${dataStart.getDate()} ${MONTH_LABELS[dataStart.getMonth()].slice(0, 3)} – ${dataEnd.getDate()} ${MONTH_LABELS[dataEnd.getMonth()].slice(0, 3)} ${dataEnd.getFullYear()}`;
  } else if (state.view === 'year') {
    els.periodLabel.textContent = String(state.anchor.getFullYear());
  } else {
    els.periodLabel.textContent = `${MONTH_LABELS[state.anchor.getMonth()]} ${state.anchor.getFullYear()}`;
  }
  syncVacationEntitlementInputs(state.anchor.getFullYear());
}

function weekendsHiddenNow() { return !state.showWeekends; }

function renderWeekdayHeader() {
  if (state.view === 'year') {
    els.calendarWeekdays.classList.add('hidden');
    return;
  }
  els.calendarWeekdays.classList.remove('hidden');
  const labels = weekendsHiddenNow() ? WEEKDAY_LABELS.slice(0, 5) : WEEKDAY_LABELS;
  els.calendarWeekdays.style.gridTemplateColumns = `repeat(${labels.length}, 1fr)`;
  els.calendarWeekdays.innerHTML = labels.map((d) => `<div>${d}</div>`).join('');
}

async function selectCalendarDay(dateStr, event) {
  if (event.ctrlKey || event.metaKey) {
    if (state.selectedDates.has(dateStr)) state.selectedDates.delete(dateStr);
    else state.selectedDates.add(dateStr);
    if (!state.selectedDates.size) state.selectedDates.add(dateStr);
  } else {
    state.selectedDates = new Set([dateStr]);
  }
  state.selectedDate = state.selectedDates.has(dateStr)
    ? dateStr
    : Array.from(state.selectedDates).sort().at(-1);
  els.calendarGrid.querySelectorAll('[data-date]').forEach((dayCell) => {
    dayCell.classList.toggle('selected', state.selectedDates.has(dayCell.dataset.date));
  });
  renderBulkPanel();
  const selectedWeekByDate = await resolveSelectedWeekData();
  if (state.selectedDate !== dateStr) return;
  state.selectedWeekByDate = selectedWeekByDate;
  renderSummary();
}

function wireCalendarDayInteractions(selector) {
  els.calendarGrid.querySelectorAll(selector).forEach((cell) => {
    cell.addEventListener('click', (event) => selectCalendarDay(cell.dataset.date, event));
    cell.addEventListener('dblclick', () => openDayDialog(cell.dataset.date));
  });
}

function renderYearGrid() {
  const year = state.anchor.getFullYear();
  const hideWeekends = weekendsHiddenNow();
  const weekdayLabels = hideWeekends ? WEEKDAY_LABELS.slice(0, 5) : WEEKDAY_LABELS;
  const months = MONTH_LABELS.map((label, month) => {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const leading = hideWeekends ? Math.min(5, mondayIndex(first)) : mondayIndex(first);
    const slots = [];
    for (let i = 0; i < leading; i += 1) slots.push('<span class="year-day empty"></span>');
    for (let day = 1; day <= last.getDate(); day += 1) {
      const date = new Date(year, month, day);
      if (hideWeekends && isWeekend(date)) continue;
      const dateStr = fmtDate(date);
      const entries = state.byDate[dateStr] || [];
      const hours = secondsToHours(entries.reduce((sum, entry) => sum + Number(entry.seconds || 0), 0));
      const isOof = state.oofDates.has(dateStr);
      const vacation = isVacation(dateStr);
      const holiday = holidayForDate(dateStr);
      const holidayName = holiday?.localName || holiday?.name || '';
      const classes = ['year-day', dateStr === todayStr() ? 'today' : '', state.selectedDates.has(dateStr) ? 'selected' : '', isOof ? 'oof' : '', vacation ? 'vacation' : '', holiday ? 'holiday' : '', entries.length ? badgeClass(hours, state.expectedHours, false) : 'none'].filter(Boolean).join(' ');
      const detail = isOof ? 'OOF' : vacation ? 'VAC' : holidayName || (entries.length ? fmtHours(hours) : '');
      slots.push(`<button type="button" class="${classes}" data-date="${dateStr}" title="${escapeHtml(holidayName || dateStr)}"><span>${day}</span><small>${escapeHtml(detail)}</small></button>`);
    }
    return `<section class="year-month"><h3>${label}</h3><div class="year-weekdays" style="grid-template-columns:repeat(${weekdayLabels.length},1fr)">${weekdayLabels.map((d) => `<span>${d.slice(0, 1)}</span>`).join('')}</div><div class="year-days" style="grid-template-columns:repeat(${weekdayLabels.length},1fr)">${slots.join('')}</div></section>`;
  });
  els.calendarGrid.classList.remove('week-view');
  els.calendarGrid.classList.add('year-view');
  els.calendarGrid.removeAttribute('style');
  els.calendarGrid.innerHTML = months.join('');
  wireCalendarDayInteractions('.year-day[data-date]');
}

function renderGrid() {
  if (state.view === 'year') {
    renderYearGrid();
    return;
  }
  const { gridStart, gridEnd, dataStart, dataEnd } = getRange();
  els.calendarGrid.classList.remove('year-view');
  els.calendarGrid.classList.toggle('week-view', state.view === 'week');
  const hideWeekends = weekendsHiddenNow();
  els.calendarGrid.style.gridTemplateColumns = `repeat(${hideWeekends ? 5 : 7}, 1fr)`;
  const today = todayStr();
  const cells = [];
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const weekend = isWeekend(cursor);
    if (hideWeekends && weekend) {
      cursor.setDate(cursor.getDate() + 1);
      continue;
    }
    const dateStr = fmtDate(cursor);
    const inRange = cursor >= dataStart && cursor <= dataEnd;
    const isFuture = dateStr > today;
    const entries = entriesInChronologicalOrder(state.byDate[dateStr] || []);
    const totalSeconds = entries.reduce((sum, e) => sum + e.seconds, 0);
    const hours = secondsToHours(totalSeconds);

    if (!inRange) {
      cells.push(`<div class="day-cell empty-slot"></div>`);
    } else {
      const isOof = state.oofDates.has(dateStr);
      const vacation = isVacation(dateStr);
      const holiday = holidayForDate(dateStr);
      const holidayName = holiday?.localName || holiday?.name || 'Holiday';
      const excludedHoliday = isExcludedHoliday(dateStr);
      const cls = [
        'day-cell',
        weekend ? 'weekend' : '',
        isFuture ? 'future' : '',
        dateStr === today ? 'today' : '',
        state.selectedDates.has(dateStr) ? 'selected' : '',
        isOof ? 'oof' : '',
        vacation ? 'vacation' : '',
        holiday ? 'holiday' : '',
        excludedHoliday ? 'holiday-blocked' : '',
      ].filter(Boolean).join(' ');

      const badge = isOof
        ? `<span class="hours-badge oof-badge">OOF</span>`
        : vacation
          ? `<span class="hours-badge vacation-badge">Vacation</span>`
        : holiday
          ? `<span class="hours-badge holiday-badge" title="${escapeHtml(holidayName)}">${escapeHtml(holidayName)}</span>`
        : entries.length || !weekend
          ? `<span class="hours-badge ${badgeClass(hours, state.expectedHours, weekend)}">${fmtHours(hours)}</span>`
          : `<span class="hours-badge none">—</span>`;

      const maxChips = state.view === 'week' ? entries.length : 3;
      const visibleEntries = entries.slice(0, maxChips);
      const hiddenCount = entries.length - visibleEntries.length;
      const chipHtml = visibleEntries
        .map((e) => state.view === 'week'
          ? `<span class="chip week-chip${e.autoLogged ? ' auto-chip' : ''}" title="${escapeHtml(e.issueSummary)}${e.autoLogged ? ' (auto-logged)' : ''}"><span class="chip-time">${extractTime(e.started)}</span><span class="chip-key">${escapeHtml(e.issueKey)}</span><span class="chip-summary">${escapeHtml(e.issueSummary)}</span><span class="chip-hours">${fmtHours(secondsToHours(e.seconds))}${e.autoLogged ? ' 🤖' : ''}</span></span>`
          : `<span class="chip${e.autoLogged ? ' auto-chip' : ''}" title="${escapeHtml(e.issueSummary)}${e.autoLogged ? ' (auto-logged)' : ''}">${escapeHtml(e.issueKey)} · ${fmtHours(secondsToHours(e.seconds))}${e.autoLogged ? ' 🤖' : ''}</span>`)
        .join('');
      const moreChip = hiddenCount > 0 ? `<span class="chip chip-more">+${hiddenCount} more</span>` : '';
      const extra = `<div class="issue-list">${chipHtml || moreChip ? chipHtml + moreChip : (state.view === 'week' ? '<span class="chip" style="opacity:.5">No entries</span>' : '')}</div>`;

      cells.push(`<div class="${cls}" data-date="${dateStr}"${holiday ? ` title="${escapeHtml(holiday.localName || holiday.name)}"` : ''}>
        <div class="date-num">${cursor.getDate()}</div>
        ${extra}
        ${badge}
      </div>`);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  els.calendarGrid.innerHTML = cells.join('');
  wireCalendarDayInteractions('.day-cell[data-date]');
}

function renderLoadingGrid() {
  if (state.view === 'year') {
    els.calendarGrid.classList.remove('week-view');
    els.calendarGrid.classList.add('year-view', 'is-loading');
    els.calendarGrid.removeAttribute('style');
    els.calendarGrid.innerHTML = MONTH_LABELS.map((label) => `<section class="year-month loading-year-month"><h3>${label}</h3><div class="year-loading"></div></section>`).join('');
    return;
  }
  const columns = weekendsHiddenNow() ? 5 : 7;
  const cellCount = state.view === 'week' ? columns : columns * 5;
  els.calendarGrid.classList.toggle('week-view', state.view === 'week');
  els.calendarGrid.classList.add('is-loading');
  els.calendarGrid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  els.calendarGrid.innerHTML = Array.from(
    { length: cellCount },
    () => `<div class="day-cell loading-cell" aria-hidden="true">
      <span class="loading-line loading-date"></span>
      <span class="loading-line loading-hours"></span>
      <span class="loading-line loading-task"></span>
    </div>`
  ).join('');
  els.summaryContent.innerHTML = '<div class="summary-loading"><span class="loading-spinner"></span> Loading period…</div>';
}

// ---------------------------------------------------------------------------
// Day dialog: view / edit / delete / add worklogs
// ---------------------------------------------------------------------------

// After a successful create/edit/delete we want the calendar to reflect it
// immediately, without waiting on a manual refresh. A plain refresh() right
// after the write isn't enough on its own: Jira's search index (used by
// GET /api/worklogs under the hood) can take several seconds to catch up
// with a worklog that was *just* created, so an immediate re-fetch can still
// come back without it. These helpers patch the already-loaded state maps
// directly so the grid/summary are correct right away; refresh() is still
// kicked off in the background afterwards to reconcile with Jira
// (picking up the real taskTotalToDateSeconds, etc.) once Jira has indexed it.
function forEachDateMap(fn) {
  new Set([state.byDate, state.monthByDate, state.selectedWeekByDate]).forEach(fn);
}

const pendingOptimisticEntries = new Map();

function injectOptimisticEntry(dateStr, entry) {
  pendingOptimisticEntries.set(String(entry.worklogId), { dateStr, entry });
  forEachDateMap((map) => {
    map[dateStr] = [...(map[dateStr] || []), entry];
  });
}

function patchOptimisticEntry(dateStr, worklogId, patch) {
  forEachDateMap((map) => {
    if (!map[dateStr]) return;
    map[dateStr] = map[dateStr].map((e) => (e.worklogId === worklogId ? { ...e, ...patch } : e));
  });
}

function removeOptimisticEntry(dateStr, worklogId) {
  pendingOptimisticEntries.delete(String(worklogId));
  forEachDateMap((map) => {
    if (!map[dateStr]) return;
    map[dateStr] = map[dateStr].filter((e) => e.worklogId !== worklogId);
  });
}

function mergePendingOptimisticEntries(byDate, rangeStart, rangeEnd) {
  for (const [worklogId, pending] of pendingOptimisticEntries) {
    if (pending.dateStr < rangeStart || pending.dateStr > rangeEnd) continue;
    const entries = byDate[pending.dateStr] || [];
    if (entries.some((entry) => String(entry.worklogId) === worklogId)) {
      pendingOptimisticEntries.delete(worklogId);
    } else {
      byDate[pending.dateStr] = [...entries, pending.entry];
    }
  }
  return byDate;
}

let reconcileTimer;
function reconcileWithJiraAfterWrite() {
  // Jira's worklog search index is eventually consistent. Keeping the
  // optimistic entry visible until a delayed refresh prevents a just-saved
  // worklog from disappearing from the calendar.
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => refresh(), 3000);
}

async function openDayDialog(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  els.dayDialogTitle.textContent = `${MONTH_LABELS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  renderDayDialogBody(dateStr);
  els.dayDialog.showModal();

  if (state.selectedDate !== dateStr) {
    state.selectedDate = dateStr;
    renderGrid();
    state.selectedWeekByDate = await resolveSelectedWeekData();
    renderSummary();
  }
}

function selectedDatesSorted() {
  return Array.from(state.selectedDates).sort();
}

function renderBulkPanel() {
  const dates = selectedDatesSorted();
  const visible = dates.length > 1 && isOwnUser();
  els.bulkPanel.classList.toggle('hidden', !visible);
  if (!visible) return;
  els.bulkCount.textContent = `${dates.length} days selected · Ctrl/Cmd-click to change`;
  els.bulkOofBtn.textContent = dates.some((dateStr) => state.oofDates.has(dateStr)) ? 'Clear OOF' : 'Mark OOF';
  els.bulkVacationBtn.textContent = dates.some((dateStr) => isVacation(dateStr)) ? 'Clear vacation' : 'Mark vacation';
  els.bulkSummary.replaceChildren(...dates.map((dateStr) => {
    const entries = state.byDate[dateStr] || [];
    const hours = fmtHours(secondsToHours(entries.reduce((sum, entry) => sum + entry.seconds, 0)));
    const tasks = [...new Set(entries.map((entry) => entry.issueKey))].join(', ') || 'No worklogs';
    const row = document.createElement('div');
    row.className = 'bulk-summary-row';
    row.textContent = `${dateStr} · ${hours} · ${tasks}${state.oofDates.has(dateStr) ? ' · OOF' : isVacation(dateStr) ? ' · Vacation' : ''}`;
    return row;
  }));
  els.bulkError.classList.add('hidden');
}

function clearBulkSelection() {
  const keep = state.selectedDate || todayStr();
  state.selectedDates = new Set([keep]);
  els.bulkWorklogForm.classList.add('hidden');
  els.bulkActions.classList.remove('hidden');
  renderGrid();
  renderBulkPanel();
}

els.bulkCloseBtn.addEventListener('click', clearBulkSelection);

els.bulkOofBtn.addEventListener('click', async () => {
  const dates = selectedDatesSorted();
  const clearingOof = dates.some((dateStr) => state.oofDates.has(dateStr));
  const withWorklogs = dates.filter((dateStr) => (state.byDate[dateStr] || []).length > 0);
  if (!clearingOof && withWorklogs.length) {
    els.bulkError.textContent = `OOF cannot be applied because these days already have worklogs: ${withWorklogs.join(', ')}`;
    els.bulkError.classList.remove('hidden');
    return;
  }
  els.bulkOofBtn.disabled = true;
  try {
    for (const dateStr of dates) await setOofDate(state.me.accountId, dateStr, !clearingOof);
    state.oofDates = await loadOofDates(state.me.accountId);
    state.vacationDates = await loadVacationDates(state.me.accountId);
    renderGrid();
    renderSummary();
    renderBulkPanel();
  } finally {
    els.bulkOofBtn.disabled = false;
  }
});

els.bulkVacationBtn.addEventListener('click', async () => {
  const dates = selectedDatesSorted();
  const clearingVacation = dates.some((dateStr) => isVacation(dateStr));
  const withWorklogs = dates.filter((dateStr) => (state.byDate[dateStr] || []).length > 0);
  if (!clearingVacation && withWorklogs.length) {
    els.bulkError.textContent = `Vacation cannot be applied because these days already have worklogs: ${withWorklogs.join(', ')}`;
    els.bulkError.classList.remove('hidden');
    return;
  }
  els.bulkVacationBtn.disabled = true;
  try {
    for (const dateStr of dates) await setVacationDate(state.me.accountId, dateStr, !clearingVacation);
    state.vacationDates = await loadVacationDates(state.me.accountId);
    state.oofDates = await loadOofDates(state.me.accountId);
    renderGrid();
    renderSummary();
    renderBulkPanel();
  } finally {
    els.bulkVacationBtn.disabled = false;
  }
});

els.bulkWorklogBtn.addEventListener('click', async () => {
  const dates = selectedDatesSorted();
  els.bulkError.classList.add('hidden');
  els.bulkWorklogBtn.disabled = true;
  try {
    if (dates.some((dateStr) => isAbsence(dateStr))) throw new Error('Remove OOF or Vacation from the selected days before adding worklogs.');
    const issueLists = await Promise.all(dates.map((dateStr) => api(`/api/issues/open?accountId=${encodeURIComponent(state.me.accountId)}&date=${encodeURIComponent(dateStr)}`)));
    const keySignatures = issueLists.map((issues) => issues.map((issue) => issue.key).sort().join('|'));
    if (!issueLists[0].length || !keySignatures.every((signature) => signature === keySignatures[0])) {
      throw new Error('The selected days do not have the same in-progress tasks, so a common worklog cannot be applied.');
    }
    els.bulkIssue.replaceChildren(...issueLists[0].map((issue) => {
      const option = document.createElement('option');
      option.value = issue.key;
      option.textContent = `${issue.key} — ${issue.summary}`;
      option.dataset.summary = issue.summary;
      return option;
    }));
    els.bulkHours.value = state.expectedHours;
    els.bulkTime.value = state.morningStart;
    els.bulkActions.classList.add('hidden');
    els.bulkWorklogForm.classList.remove('hidden');
  } catch (error) {
    els.bulkError.textContent = error.message;
    els.bulkError.classList.remove('hidden');
  } finally {
    els.bulkWorklogBtn.disabled = false;
  }
});

els.bulkCancelBtn.addEventListener('click', () => {
  els.bulkWorklogForm.classList.add('hidden');
  els.bulkActions.classList.remove('hidden');
});

els.bulkSaveBtn.addEventListener('click', async () => {
  const dates = selectedDatesSorted();
  const hours = roundToHalfHour(Number(els.bulkHours.value));
  if (!hours || hours <= 0) {
    els.bulkError.textContent = 'Enter valid hours in 30-minute steps.';
    els.bulkError.classList.remove('hidden');
    return;
  }
  const selectedOption = els.bulkIssue.selectedOptions[0];
  if (!selectedOption) return;
  els.bulkSaveBtn.disabled = true;
  let completed = 0;
  try {
    for (const dateStr of dates) {
      await api('/api/worklogs', {
        method: 'POST',
        body: JSON.stringify({ accountId: state.me.accountId, issueKey: selectedOption.value, date: dateStr, time: els.bulkTime.value || state.morningStart, seconds: hours * 3600, comment: els.bulkComment.value || undefined }),
      });
      completed += 1;
    }
    clearBulkSelection();
    await refresh();
  } catch (error) {
    els.bulkError.textContent = `${completed} of ${dates.length} days were saved. ${error.message}`;
    els.bulkError.classList.remove('hidden');
  } finally {
    els.bulkSaveBtn.disabled = false;
  }
});

function renderDayDialogBody(dateStr) {
  const entries = entriesInChronologicalOrder(state.byDate[dateStr] || []);
  const own = isOwnUser();
  const isOof = state.oofDates.has(dateStr);
  const vacation = isVacation(dateStr);
  const holiday = holidayForDate(dateStr);
  const excludedHoliday = isExcludedHoliday(dateStr);

  let html = '';
  // Never shown once the day has any logged task, or while the add-worklog
  // form is expanded (that form gets hidden again in wireAddEntryForm).
  const canManageAbsence = own && entries.length === 0;

  if (canManageAbsence) {
    const selectedCategory = isOof ? 'oof' : vacation ? 'vacation' : 'none';
    html += `
      <div id="oofToggleWrapper">
        <div class="absence-label">Day category</div>
        <div class="absence-selector" role="group" aria-label="Day category">
          <button type="button" data-absence="none" class="${selectedCategory === 'none' ? 'active' : ''}"><span class="absence-dot none"></span>Working day</button>
          <button type="button" data-absence="oof" class="${selectedCategory === 'oof' ? 'active' : ''}"><span class="absence-dot oof"></span>OOF</button>
          <button type="button" data-absence="vacation" class="${selectedCategory === 'vacation' ? 'active' : ''}"><span class="absence-dot vacation"></span>Vacation</button>
        </div>
      </div>`;
  }

  if (holiday) {
    const holidayName = escapeHtml(holiday.localName || holiday.name || 'Public holiday');
    html += `<div class="holiday-note${excludedHoliday ? ' blocked' : ''}">${holidayName}${excludedHoliday ? ' — excluded from auto-log and summary calculations.' : ' — worklogs are still allowed.'}</div>`;
  }

  if (!entries.length) {
    html += '<div class="no-entries">No work logged on this day.</div>';
  } else {
    const overlapFlags = findOverlappingEntries(entries);
    html += `<div id="entryList">${entries.map((e, i) => entryRowHtml(e, overlapFlags[i])).join('')}</div>`;
  }

  if (own && isAbsence(dateStr)) {
    html += `<div class="readonly-note">This day is marked as ${isOof ? 'Out of Office' : 'Vacation'} — unmark it above to add a worklog.</div>`;
  } else if (own) {
    html += `
      <div class="add-entry-section">
        <button type="button" class="add-entry-toggle" id="addEntryToggle">+ Add worklog for this day</button>
        <div id="addEntryForm" class="add-entry-form hidden"></div>
      </div>`;
  } else {
    html += `<div class="readonly-note">You can only create/edit worklogs on your own account — Jira always attributes the author to the connected API token owner.</div>`;
  }

  els.dayDialogBody.innerHTML = html;

  if (entries.length) wireEntryRows(dateStr);
  if (own && !isAbsence(dateStr)) wireAddEntryForm(dateStr);
  if (canManageAbsence) {
    document.querySelectorAll('#oofToggleWrapper [data-absence]').forEach((button) => button.addEventListener('click', async () => {
      const category = button.dataset.absence;
      state.oofDates = await setOofDate(state.user.accountId, dateStr, category === 'oof');
      state.vacationDates = await setVacationDate(state.user.accountId, dateStr, category === 'vacation');
      state.oofDates = await loadOofDates(state.user.accountId);
      renderGrid();
      renderSummary();
      renderDayDialogBody(dateStr);
    }));
  }
}

// Flags entries whose [start, end) time range overlaps another entry the
// same day, so overlapping worklogs (e.g. logged twice by mistake) stand
// out visually instead of silently sitting on top of each other.
function findOverlappingEntries(entries) {
  const ranges = entries.map((e) => {
    const startMin = timeToMinutes(extractTime(e.started));
    return { startMin, endMin: startMin + Math.round(secondsToHours(e.seconds) * 60) };
  });
  return ranges.map((a, i) =>
    ranges.some((b, j) => i !== j && a.startMin < b.endMin && b.startMin < a.endMin)
  );
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function entryRowHtml(e, overlaps) {
  const taskTotalHours = e.taskTotalToDateSeconds != null ? fmtHours(secondsToHours(e.taskTotalToDateSeconds)) : null;
  const taskDetails = [];
  if (taskTotalHours) taskDetails.push(`Task total to date: <strong class="detail-value">${taskTotalHours}</strong>`);
  if (e.storyPoints !== null && e.storyPoints !== undefined) taskDetails.push(`Story points: <strong class="detail-value">${escapeHtml(String(e.storyPoints))}</strong>`);
  if (Number(e.originalEstimateSeconds) > 0) taskDetails.push(`Estimate: <strong class="detail-value">${fmtHours(secondsToHours(e.originalEstimateSeconds))}</strong>`);
  if (Number(e.remainingEstimateSeconds) > 0) taskDetails.push(`Remaining: <strong class="detail-value">${fmtHours(secondsToHours(e.remainingEstimateSeconds))}</strong>`);
  const issueUrl = jiraIssueUrl(e.issueKey);
  const issueLinkOpen = issueUrl ? `<a class="issue-link" href="${issueUrl}" target="_blank" rel="noopener" title="Open ${escapeHtml(e.issueKey)} in Jira">` : '<span class="issue-link">';
  const issueLinkClose = issueUrl ? '</a>' : '</span>';
  const startTime = extractTime(e.started);
  const endTime = addHoursToTime(startTime, secondsToHours(e.seconds));
  return `<div class="entry-row${overlaps ? ' overlaps' : ''}" data-worklog-id="${escapeHtml(String(e.worklogId || ''))}" data-issue-key="${escapeHtml(e.issueKey)}" data-seconds="${Number(e.seconds) || 0}" data-started="${escapeHtml(e.started || '')}" data-comment="${escapeHtml(e.comment || '')}">
    <div class="entry-main">
      ${issueLinkOpen}<span class="issue-key">${escapeHtml(e.issueKey)}</span>
      <span class="summary">${escapeHtml(e.issueSummary)}</span>${issueLinkClose}
      <span class="entry-time-range"${overlaps ? ' title="Overlaps with another worklog this day"' : ''}>${startTime}–${endTime}</span>
      ${e.autoLogged ? `<span class="auto-tag" title="Created automatically by the auto-logwork scheduler">auto</span>` : ''}
      ${e.comment ? `<span class="comment">${escapeHtml(e.comment)}</span>` : ''}
      ${taskDetails.length ? `<span class="task-details">${taskDetails.join(' · ')}</span>` : ''}
    </div>
    <span class="time">${fmtHours(secondsToHours(e.seconds))}</span>
    ${isOwnUser() ? `<div class="entry-actions">
      <button type="button" class="edit-entry-btn">Edit</button>
      <button type="button" class="delete-entry-btn danger">Delete</button>
    </div>` : ''}
  </div>`;
}

function wireEntryRows(dateStr) {
  els.dayDialogBody.querySelectorAll('.entry-row').forEach((row) => {
    const editBtn = row.querySelector('.edit-entry-btn');
    const deleteBtn = row.querySelector('.delete-entry-btn');
    if (editBtn) editBtn.addEventListener('click', () => startEditEntry(row, dateStr));
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteEntry(row, dateStr));
  });
}

function extractTime(startedIso) {
  // Jira timestamps include an offset. Convert them to the same local browser
  // time zone used when a worklog is created, rather than displaying the raw
  // server-side offset.
  const instant = new Date(startedIso || '');
  if (!Number.isNaN(instant.getTime())) {
    return `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`;
  }
  const match = /T(\d{2}:\d{2})/.exec(startedIso || '');
  return match ? match[1] : '09:00';
}

function minutesToTime(minutes) {
  const safe = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function suggestedStartTime(dateStr) {
  const latestEnd = (state.byDate[dateStr] || []).reduce((latest, entry) => {
    const start = timeToMinutes(extractTime(entry.started));
    const end = start + Math.round(Number(entry.seconds || 0) / 60);
    return Math.max(latest, end);
  }, timeToMinutes(state.morningStart));
  return minutesToTime(latestEnd);
}

function suggestedHours(dateStr) {
  const loggedHours = secondsToHours((state.byDate[dateStr] || []).reduce(
    (sum, entry) => sum + Number(entry.seconds || 0),
    0
  ));
  // This is only a convenient default: the user can still enter any valid
  // duration when the remaining expected time has already been reached.
  return Math.max(0.5, roundToHalfHour(state.expectedHours - loggedHours));
}

function addHoursToTime(hhmm, hours) {
  const [h, m] = hhmm.split(':').map(Number);
  const totalMin = h * 60 + m + Math.round(hours * 60);
  const wrapped = ((totalMin % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function startEditEntry(row, dateStr) {
  const issueKey = row.dataset.issueKey;
  const worklogId = row.dataset.worklogId;
  // Re-rendering collapses the add form and any other edit form first, so
  // the dialog can never display two independent Save actions at once.
  renderDayDialogBody(dateStr);
  row = Array.from(els.dayDialogBody.querySelectorAll('.entry-row')).find(
    (candidate) => candidate.dataset.worklogId === worklogId && candidate.dataset.issueKey === issueKey
  );
  if (!row) return;
  const seconds = Number(row.dataset.seconds);
  const hours = roundToHalfHour(seconds / 3600);
  const time = extractTime(row.dataset.started);
  const comment = row.dataset.comment || '';
  const otherDaySeconds = Math.max(0, (state.byDate[dateStr] || []).reduce(
    (sum, entry) => sum + Number(entry.seconds || 0),
    0
  ) - seconds);

  // A plain <div>, not <form>: this row lives inside the day dialog's own
  // <form method="dialog">, and browsers silently drop any <form> nested
  // inside another <form> — which used to make row.querySelector('.edit-row-form')
  // return null, breaking every button here (and leaving the fields laid
  // out unstyled, flowing as if none of the .edit-row-form CSS existed).
  // Markup/classes intentionally mirror the "add worklog" form below
  // (add-entry-form / add-entry-actions) so editing looks and behaves the
  // same as adding, just pre-filled and with the task fixed.
  row.innerHTML = `
    <div class="edit-row-form add-entry-form">
      <div class="edit-row-issue">${escapeHtml(issueKey)}</div>
      <div class="hours-with-total">
        <label>Hours
          <input type="number" min="0.5" step="0.5" value="${hours}" required />
        </label>
        <div class="day-total-preview" aria-live="polite"></div>
      </div>
      ${startTimeFieldHtml(`<input type="time" value="${time}" required />`)}
      <label>Comment (optional)
        <textarea placeholder="What did you work on...">${escapeHtml(comment)}</textarea>
      </label>
      <div class="form-error hidden"></div>
      <div class="add-entry-actions">
        <button type="button" class="cancel-edit-btn">Cancel</button>
        <button type="button" class="save-edit-btn primary">Save</button>
      </div>
    </div>
  `;
  const form = row.querySelector('.edit-row-form');
  const errorEl = row.querySelector('.form-error');
  const timeInputEl = form.querySelector('input[type="time"]');
  const hoursInputEl = form.querySelector('input[type="number"]');
  const totalPreview = form.querySelector('.day-total-preview');
  const updateDayTotalPreview = () => {
    const proposedHours = roundToHalfHour(Number(hoursInputEl.value));
    totalPreview.textContent = `Total: ${fmtHours(secondsToHours(otherDaySeconds) + (proposedHours > 0 ? proposedHours : 0))}`;
  };
  hoursInputEl.addEventListener('input', updateDayTotalPreview);
  hoursInputEl.addEventListener('change', updateDayTotalPreview);
  updateDayTotalPreview();
  form.querySelectorAll('.time-quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => { timeInputEl.value = btn.dataset.time; });
  });
  row.querySelector('.cancel-edit-btn').addEventListener('click', () => renderDayDialogBody(dateStr));
  row.querySelector('.save-edit-btn').addEventListener('click', async () => {
    const hoursInput = form.querySelector('input[type="number"]');
    const commentInput = form.querySelector('textarea');
    const newSeconds = Math.round(roundToHalfHour(parseFloat(hoursInput.value)) * 3600);
    try {
      await api(`/api/worklogs/${encodeURIComponent(issueKey)}/${encodeURIComponent(worklogId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: state.me.accountId,
          seconds: newSeconds,
          date: dateStr,
          time: timeInputEl.value,
          comment: commentInput.value,
        }),
      });
      patchOptimisticEntry(dateStr, worklogId, {
        seconds: newSeconds,
        comment: commentInput.value || null,
        started: `${dateStr}T${timeInputEl.value}:00.000`,
      });
      els.dayDialog.close();
      renderGrid();
      renderSummary();
      reconcileWithJiraAfterWrite();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });
}

async function deleteEntry(row, dateStr) {
  const issueKey = row.dataset.issueKey;
  const worklogId = row.dataset.worklogId;
  if (!confirm(`Delete the worklog entry for ${issueKey}?`)) return;
  try {
    await api(`/api/worklogs/${encodeURIComponent(issueKey)}/${encodeURIComponent(worklogId)}?accountId=${encodeURIComponent(state.me.accountId)}`, {
      method: 'DELETE',
    });
    removeOptimisticEntry(dateStr, worklogId);
    els.dayDialog.close();
    renderGrid();
    renderSummary();
    reconcileWithJiraAfterWrite();
  } catch (err) {
    alert(`Could not delete: ${err.message}`);
  }
}

async function loadOpenIssuesForDate(dateStr) {
  if (state.openIssuesCache.has(dateStr)) return state.openIssuesCache.get(dateStr);
  let issues = [];
  try {
    issues = await api(`/api/issues/open?accountId=${encodeURIComponent(state.me.accountId)}&date=${encodeURIComponent(dateStr)}`);
  } catch (err) {
    console.error(err);
  }
  state.openIssuesCache.set(dateStr, issues);
  return issues;
}

function wireAddEntryForm(dateStr) {
  const toggle = document.getElementById('addEntryToggle');
  const formContainer = document.getElementById('addEntryForm');

  toggle.addEventListener('click', () => {
    toggle.classList.add('hidden');
    formContainer.classList.remove('hidden');
    document.getElementById('oofToggleWrapper')?.classList.add('hidden');
    formContainer.innerHTML = `
      <label>Task
        <div class="issue-picker">
          <input type="text" id="issuePickerInput" placeholder="Search by key or title..." autocomplete="off" />
          <div id="issueSuggestions" class="issue-suggestions hidden"></div>
        </div>
      </label>
      <div id="selectedIssueLabel" style="font-size:12px;color:var(--muted);"></div>
      <div id="issueDetailInfo" class="issue-detail-info hidden"></div>
      <div class="hours-with-total">
        <label>Hours
          <input type="number" id="addHoursInput" min="0.5" step="0.5" value="${suggestedHours(dateStr)}" required />
        </label>
        <div id="addDayTotal" class="day-total-preview" aria-live="polite"></div>
      </div>
      ${startTimeFieldHtml(`<input type="time" id="addTimeInput" value="${suggestedStartTime(dateStr)}" required />`)}
      <label>Comment (optional)
        <textarea id="addCommentInput" placeholder="What did you work on..."></textarea>
      </label>
      <div id="addEntryError" class="form-error hidden"></div>
      <div class="add-entry-actions">
        <button type="button" id="cancelAddEntry">Cancel</button>
        <button type="button" id="saveAddEntry" class="primary">Save</button>
      </div>
    `;

    formContainer.querySelectorAll('.time-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('addTimeInput').value = btn.dataset.time;
      });
    });

    const hoursInput = document.getElementById('addHoursInput');
    const totalPreview = document.getElementById('addDayTotal');
    const existingSeconds = (state.byDate[dateStr] || []).reduce((sum, entry) => sum + Number(entry.seconds || 0), 0);
    const updateDayTotalPreview = () => {
      const proposedHours = roundToHalfHour(Number(hoursInput.value));
      if (!proposedHours || proposedHours < 0) {
        totalPreview.textContent = `Total: ${fmtHours(secondsToHours(existingSeconds))}`;
        return;
      }
      totalPreview.textContent = `Total: ${fmtHours(secondsToHours(existingSeconds) + proposedHours)}`;
    };
    hoursInput.addEventListener('input', updateDayTotalPreview);
    hoursInput.addEventListener('change', updateDayTotalPreview);
    updateDayTotalPreview();

    let selectedIssue = null;
    const issueInput = document.getElementById('issuePickerInput');
    const suggestionsEl = document.getElementById('issueSuggestions');
    const selectedLabel = document.getElementById('selectedIssueLabel');
    const detailInfo = document.getElementById('issueDetailInfo');

    const isPastDay = dateStr < todayStr();
    const openGroupLabel = isPastDay ? 'In progress on that day' : 'Currently open';

    function renderIssueOptions(openIssues, searchResults) {
      const parts = [];
      if (openIssues.length) {
        parts.push(`<div class="group-label">${openGroupLabel}</div>`);
        parts.push(openIssues.map(issueOptionHtml).join(''));
      }
      if (searchResults && searchResults.length) {
        parts.push('<div class="group-label">Search results</div>');
        parts.push(searchResults.map(issueOptionHtml).join(''));
      }
      if (!parts.length) {
        suggestionsEl.classList.add('hidden');
        return;
      }
      suggestionsEl.innerHTML = parts.join('');
      suggestionsEl.classList.remove('hidden');
      suggestionsEl.querySelectorAll('.issue-suggestion-item').forEach((el) => {
        el.addEventListener('click', async () => {
          selectedIssue = { key: el.dataset.key, summary: el.dataset.summary };
          issueInput.value = '';
          selectedLabel.replaceChildren(
            document.createTextNode('Selected: '),
            Object.assign(document.createElement('span'), { className: 'issue-key', textContent: selectedIssue.key }),
            document.createTextNode(` — ${selectedIssue.summary}`)
          );
          suggestionsEl.classList.add('hidden');
          await showIssueDetails(selectedIssue.key);
        });
      });
    }

    async function showIssueDetails(issueKey) {
      detailInfo.classList.remove('hidden');
      detailInfo.textContent = 'Loading task details...';
      try {
        const details = await api(`/api/issues/${encodeURIComponent(issueKey)}/details`);
        const loggedHours = fmtHours(secondsToHours(details.loggedSeconds || 0));
        const storyPoints = details.storyPoints === null || details.storyPoints === undefined ? '—' : details.storyPoints;
        detailInfo.textContent = `Logged so far: ${loggedHours} · Story points: ${storyPoints}`;
      } catch (err) {
        detailInfo.textContent = `Could not load task details: ${err.message}`;
      }
    }

    function issueOptionHtml(issue) {
      return `<div class="issue-suggestion-item" data-key="${escapeHtml(issue.key)}" data-summary="${escapeHtml(issue.summary)}">
        <span class="key">${escapeHtml(issue.key)}</span>${escapeHtml(issue.summary)}<span class="status">${escapeHtml(issue.status || '')}</span>
      </div>`;
    }

    let openIssues = [];
    let openIssuesLoaded = false;

    // Wire listeners synchronously (no await before this point) so a fast
    // click-then-focus from the user is never missed while the fetch below
    // is still in flight — that race made the dropdown appear "stuck"
    // invisible until an unrelated click forced a re-render.
    issueInput.addEventListener('focus', () => {
      if (!openIssuesLoaded) {
        suggestionsEl.innerHTML = '<div class="group-label">Loading…</div>';
        suggestionsEl.classList.remove('hidden');
        return;
      }
      renderIssueOptions(openIssues, null);
    });
    let searchDebounce2;
    issueInput.addEventListener('input', () => {
      clearTimeout(searchDebounce2);
      const q = issueInput.value.trim();
      if (q.length < 2) {
        renderIssueOptions(openIssues, null);
        return;
      }
      searchDebounce2 = setTimeout(async () => {
        try {
          const results = await api(`/api/issues/search?q=${encodeURIComponent(q)}&accountId=${encodeURIComponent(state.me.accountId)}&date=${encodeURIComponent(dateStr)}`);
          renderIssueOptions(openIssues, results);
        } catch (err) {
          console.error(err);
        }
      }, 250);
    });

    loadOpenIssuesForDate(dateStr).then((issues) => {
      openIssues = issues;
      openIssuesLoaded = true;
      if (document.activeElement === issueInput) renderIssueOptions(openIssues, null);
    });

    document.getElementById('cancelAddEntry').addEventListener('click', () => renderDayDialogBody(dateStr));
    document.getElementById('saveAddEntry').addEventListener('click', async () => {
      const errorEl = document.getElementById('addEntryError');
      errorEl.classList.add('hidden');
      if (!selectedIssue) {
        errorEl.textContent = 'Pick a task from the list.';
        errorEl.classList.remove('hidden');
        return;
      }
      const hours = roundToHalfHour(parseFloat(document.getElementById('addHoursInput').value));
      if (!hours || hours <= 0) {
        errorEl.textContent = 'Enter a number of hours (in 30-minute steps).';
        errorEl.classList.remove('hidden');
        return;
      }
      const time = document.getElementById('addTimeInput').value || state.morningStart;
      const comment = document.getElementById('addCommentInput').value;
      try {
        const seconds = Math.round(hours * 3600);
        const result = await api('/api/worklogs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: state.me.accountId,
            issueKey: selectedIssue.key,
            date: dateStr,
            time,
            seconds,
            comment: comment || undefined,
          }),
        });
        injectOptimisticEntry(dateStr, {
          issueKey: selectedIssue.key,
          issueSummary: selectedIssue.summary,
          projectKey: '',
          seconds,
          timeSpent: null,
          comment: comment || null,
          autoLogged: false,
          worklogId: result.worklogId,
          started: `${dateStr}T${time}:00.000`,
          taskTotalToDateSeconds: null,
          storyPoints: null,
          originalEstimateSeconds: null,
          remainingEstimateSeconds: null,
        });
        renderGrid();
        renderSummary();
        // Return to the day's normal entry table, but keep the dialog open
        // so the user can immediately inspect or add another worklog.
        renderDayDialogBody(dateStr);
        reconcileWithJiraAfterWrite();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function computeStats(dataMap, rangeStart, rangeEnd) {
  const today = todayStr();
  let totalSeconds = 0;
  let weekdaysConsidered = 0;
  let weekdaysWithWork = 0;
  let oofCount = 0;
  const missing = [];

  const cursor = new Date(rangeStart);
  while (cursor <= rangeEnd) {
    const dateStr = fmtDate(cursor);
    if (dateStr <= today) {
      const entries = dataMap[dateStr] || [];
      const seconds = entries.reduce((s, e) => s + e.seconds, 0);
      totalSeconds += seconds;
      if (!isWeekend(cursor)) {
        if (isAbsence(dateStr)) {
          oofCount += 1;
        } else if (isExcludedHoliday(dateStr)) {
          oofCount += 1;
        } else {
          weekdaysConsidered += 1;
          if (seconds > 0) weekdaysWithWork += 1;
          else missing.push({ dateStr, label: `${MONTH_LABELS[cursor.getMonth()].slice(0, 3)} ${cursor.getDate()}` });
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const totalHours = secondsToHours(totalSeconds);
  const expectedTotal = weekdaysConsidered * state.expectedHours;
  const coveragePct = expectedTotal > 0 ? Math.round((totalHours / expectedTotal) * 100) : 0;

  return { totalHours, weekdaysConsidered, weekdaysWithWork, oofCount, missing, expectedTotal, coveragePct };
}

function statsBlockHtml(title, stats) {
  return `
    <div class="summary-block">
      <div class="summary-block-main">
        <div class="summary-block-title">${title}</div>
        <div class="summary-stats">
          <div class="stat">
            <span class="value">${fmtHours(stats.totalHours)}</span>
            <span class="label">Total logged</span>
          </div>
          <div class="stat ${stats.coveragePct < 90 ? 'bad' : 'good'}">
            <span class="value">${stats.coveragePct}%</span>
            <span class="label">Coverage (expected ${fmtHours(stats.expectedTotal)})</span>
          </div>
          <div class="stat">
            <span class="value">${stats.weekdaysWithWork}/${stats.weekdaysConsidered}</span>
            <span class="label">Workdays with entries</span>
          </div>
          ${stats.oofCount > 0 ? `<div class="stat">
            <span class="value">${stats.oofCount}</span>
            <span class="label">OOF / vacation / holidays</span>
          </div>` : ''}
        </div>
      </div>
      <div class="missing-days">
        ${stats.missing.length
          ? `<span class="missing-label">No entries:</span><div class="missing-days-chips">${stats.missing.map((m) => `<span class="missing-day-chip" data-date="${m.dateStr}">${m.label}</span>`).join('')}</div>`
          : '<span class="no-gaps">No gaps 🎉</span>'}
      </div>
    </div>`;
}

function vacationSummaryHtml(year) {
  const today = todayStr();
  const vacationDates = [...state.vacationDates]
    .filter((dateStr) => dateStr.startsWith(`${year}-`))
    .filter((dateStr) => !isWeekend(new Date(`${dateStr}T12:00:00`)))
    .sort();
  const taken = vacationDates.filter((dateStr) => dateStr <= today);
  const planned = vacationDates.filter((dateStr) => dateStr > today);
  const committed = taken.length + planned.length;
  const allowance = vacationAllowanceForYear(year);
  const remaining = Math.max(0, allowance - committed);
  const overbooked = Math.max(0, committed - allowance);
  const nextDates = planned.slice(0, 5).map((dateStr) => {
    const date = new Date(`${dateStr}T12:00:00`);
    return `${date.getDate()} ${MONTH_LABELS[date.getMonth()].slice(0, 3)}`;
  });
  return `<div class="summary-block vacation-summary">
    <div class="summary-block-main">
      <div class="summary-block-title">Vacation allowance · ${year}</div>
      <div class="summary-stats">
        <div class="stat"><span class="value">${allowance}</span><span class="label">Total days</span></div>
        <div class="stat"><span class="value">${taken.length}</span><span class="label">Days taken</span></div>
        <div class="stat"><span class="value">${planned.length}</span><span class="label">Days planned</span></div>
        <div class="stat ${overbooked ? 'bad' : 'good'}"><span class="value">${remaining}</span><span class="label">Days available</span></div>
      </div>
    </div>
    <div class="missing-days">${overbooked ? `<span class="missing-label">Overbooked by ${overbooked} day${overbooked === 1 ? '' : 's'}.</span>` : nextDates.length ? `<span class="missing-label">Next planned:</span><div class="missing-days-chips">${nextDates.map((label) => `<span class="missing-day-chip">${label}</span>`).join('')}</div>` : '<span class="no-gaps">No future vacation days marked.</span>'}</div>
  </div>`;
}

function renderSummary() {
  const isYearView = state.view === 'year';
  els.vacationSummaryToggle.classList.toggle('hidden', !isYearView);
  if (isYearView) {
    els.vacationSummaryToggle.textContent = state.showVacationSummary ? 'Worklog details' : 'Vacation details';
    if (state.showVacationSummary) {
      els.summaryContent.innerHTML = vacationSummaryHtml(state.anchor.getFullYear());
      return;
    }
  } else {
    state.showVacationSummary = false;
  }
  const selectedWeekStart = startOfWeek(new Date(state.selectedDate + 'T00:00:00'));
  const selectedWeekEnd = new Date(selectedWeekStart);
  selectedWeekEnd.setDate(selectedWeekEnd.getDate() + 6);
  const weekStats = computeStats(state.selectedWeekByDate, selectedWeekStart, selectedWeekEnd);
  const weekLabel = `Week of ${MONTH_LABELS[selectedWeekStart.getMonth()].slice(0, 3)} ${selectedWeekStart.getDate()} – ${MONTH_LABELS[selectedWeekEnd.getMonth()].slice(0, 3)} ${selectedWeekEnd.getDate()}`;

  const monthStart = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
  const monthEnd = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 0);
  const monthStats = computeStats(state.monthByDate, monthStart, monthEnd);
  const monthLabel = `${MONTH_LABELS[state.anchor.getMonth()]} ${state.anchor.getFullYear()}`;

  const html =
    statsBlockHtml(weekLabel, weekStats) +
    '<div class="summary-divider"></div>' +
    statsBlockHtml(monthLabel, monthStats);

  els.summaryContent.innerHTML = html;
  els.summaryContent.querySelectorAll('.missing-day-chip').forEach((chip) => {
    chip.addEventListener('click', () => openDayDialog(chip.dataset.date));
  });
}

// ---------------------------------------------------------------------------
// Refresh / navigation
// ---------------------------------------------------------------------------

async function resolveSelectedWeekData() {
  const { dataStart } = getRange();
  const selectedWeekStart = startOfWeek(new Date(state.selectedDate + 'T00:00:00'));
  const selectedWeekEnd = new Date(selectedWeekStart);
  selectedWeekEnd.setDate(selectedWeekEnd.getDate() + 6);
  const monthStart = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
  const monthEnd = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 0);
  const weekMatchesDisplayed = state.view === 'week' && fmtDate(selectedWeekStart) === fmtDate(dataStart);
  const weekWithinMonth = selectedWeekStart >= monthStart && selectedWeekEnd <= monthEnd;
  if (weekMatchesDisplayed) return state.byDate;
  if (weekWithinMonth) return state.monthByDate;
  return fetchWorklogRange(selectedWeekStart, selectedWeekEnd);
}

async function fetchWorklogRange(rangeStart, rangeEnd) {
  try {
    const data = await api(
      `/api/worklogs?accountId=${encodeURIComponent(state.user.accountId)}&start=${fmtDate(rangeStart)}&end=${fmtDate(rangeEnd)}`
    );
    return mergePendingOptimisticEntries(data.byDate || {}, fmtDate(rangeStart), fmtDate(rangeEnd));
  } catch (err) {
    setStatus(`Error loading worklogs: ${err.message}`, true);
    return {};
  }
}

async function loadHolidaysForRange(rangeStart, rangeEnd) {
  state.publicHolidays = new Map(
    [...state.manualHolidays.entries()].filter(([dateStr]) => dateStr >= fmtDate(rangeStart) && dateStr <= fmtDate(rangeEnd))
  );
  if (!state.holidayCountry) return;
  const years = new Set();
  for (let y = rangeStart.getFullYear(); y <= rangeEnd.getFullYear(); y += 1) years.add(y);
  try {
    const groups = await Promise.all([...years].map((year) => api(`/api/holidays?year=${year}`)));
    for (const holiday of groups.flat()) {
      if (!state.publicHolidays.has(holiday.date)) state.publicHolidays.set(holiday.date, holiday);
    }
  } catch (error) {
    setStatus(`Could not load public holidays: ${error.message}`, true);
  }
}

async function refresh() {
  if (!state.user) return;
  const token = ++state.refreshToken;
  if (!state.selectedDate) state.selectedDate = todayStr();
  if (!state.selectedDates.size) state.selectedDates.add(state.selectedDate);
  updatePeriodLabel();
  renderWeekdayHeader();
  state.oofDates = await loadOofDates(state.user.accountId);
  state.vacationDates = await loadVacationDates(state.user.accountId);
  renderLoadingGrid();

  const { dataStart, dataEnd } = getRange();
  setStatus('Loading worklogs from Jira…');
  const [byDate] = await Promise.all([fetchWorklogRange(dataStart, dataEnd), loadHolidaysForRange(dataStart, dataEnd)]);
  if (token !== state.refreshToken) return;
  state.byDate = byDate;
  setStatus('');

  const monthStart = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
  const monthEnd = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 0);
  const monthByDate = state.view === 'month' ? state.byDate : await fetchWorklogRange(monthStart, monthEnd);
  if (token !== state.refreshToken) return;
  state.monthByDate = monthByDate;

  const selectedWeekByDate = await resolveSelectedWeekData();
  if (token !== state.refreshToken) return;
  state.selectedWeekByDate = selectedWeekByDate;

  els.calendarGrid.classList.remove('is-loading');
  renderGrid();
  renderSummary();
  renderBulkPanel();
}

function updateWeekendsToggleAvailability() {
  els.showWeekendsInput.disabled = false;
}

els.viewMonthBtn.addEventListener('click', () => {
  state.view = 'month';
  els.viewMonthBtn.classList.add('active');
  els.viewWeekBtn.classList.remove('active');
  els.viewYearBtn.classList.remove('active');
  updateWeekendsToggleAvailability();
  refresh();
});

els.viewWeekBtn.addEventListener('click', () => {
  // Week view follows the date the user was working with, rather than the
  // first day of the currently displayed month.
  state.anchor = new Date(`${state.selectedDate || todayStr()}T12:00:00`);
  state.view = 'week';
  els.viewWeekBtn.classList.add('active');
  els.viewMonthBtn.classList.remove('active');
  els.viewYearBtn.classList.remove('active');
  updateWeekendsToggleAvailability();
  refresh();
});

els.viewYearBtn.addEventListener('click', () => {
  state.anchor = new Date(`${state.selectedDate || todayStr()}T12:00:00`);
  state.view = 'year';
  els.viewYearBtn.classList.add('active');
  els.viewMonthBtn.classList.remove('active');
  els.viewWeekBtn.classList.remove('active');
  updateWeekendsToggleAvailability();
  refresh();
});

els.showWeekendsInput.addEventListener('change', () => {
  state.showWeekends = els.showWeekendsInput.checked;
  renderWeekdayHeader();
  renderGrid();
});

els.prevBtn.addEventListener('click', () => {
  if (state.view === 'week') state.anchor.setDate(state.anchor.getDate() - 7);
  else if (state.view === 'year') {
    state.anchor.setFullYear(state.anchor.getFullYear() - 1);
    state.selectedDate = fmtDate(state.anchor);
    state.selectedDates = new Set([state.selectedDate]);
  }
  else {
    const selectedDay = state.selectedDate ? Number(state.selectedDate.slice(8, 10)) : state.anchor.getDate();
    const target = new Date(state.anchor.getFullYear(), state.anchor.getMonth() - 1, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(selectedDay, lastDay));
    state.anchor = target;
    state.selectedDate = fmtDate(target);
    state.selectedDates = new Set([state.selectedDate]);
  }
  state.anchor = new Date(state.anchor);
  refresh();
});

els.nextBtn.addEventListener('click', () => {
  if (state.view === 'week') state.anchor.setDate(state.anchor.getDate() + 7);
  else if (state.view === 'year') {
    state.anchor.setFullYear(state.anchor.getFullYear() + 1);
    state.selectedDate = fmtDate(state.anchor);
    state.selectedDates = new Set([state.selectedDate]);
  }
  else {
    const selectedDay = state.selectedDate ? Number(state.selectedDate.slice(8, 10)) : state.anchor.getDate();
    const target = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(selectedDay, lastDay));
    state.anchor = target;
    state.selectedDate = fmtDate(target);
    state.selectedDates = new Set([state.selectedDate]);
  }
  state.anchor = new Date(state.anchor);
  refresh();
});

els.todayBtn.addEventListener('click', () => {
  state.anchor = new Date();
  state.selectedDate = todayStr();
  state.selectedDates = new Set([state.selectedDate]);
  refresh();
});

els.expectedHoursInput.addEventListener('change', () => {
  const v = roundToHalfHour(parseFloat(els.expectedHoursInput.value));
  state.expectedHours = isNaN(v) || v <= 0 ? 7 : v;
  els.expectedHoursInput.value = state.expectedHours;
  renderGrid();
  renderSummary();
  // Expected hours/day also drives the extension's background auto-log job.
  api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedHours: state.expectedHours }),
  }).catch((err) => console.error(err));
});

els.annualVacationDaysInput.addEventListener('change', () => {
  const year = String(state.anchor.getFullYear());
  const value = Math.round(parseFloat(els.annualVacationDaysInput.value));
  state.annualVacationDaysByYear[year] = isNaN(value) || value < 0 ? 0 : value;
  els.annualVacationDaysInput.value = state.annualVacationDaysByYear[year];
  renderSummary();
  api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annualVacationDaysByYear: state.annualVacationDaysByYear }),
  }).catch((err) => console.error(err));
});

els.vacationSummaryToggle.addEventListener('click', () => {
  state.showVacationSummary = !state.showVacationSummary;
  renderSummary();
});

els.autoLogInput.addEventListener('change', async () => {
  try {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoLogEnabled: els.autoLogInput.checked }),
    });
  } catch (err) {
    els.autoLogInput.checked = !els.autoLogInput.checked; // revert on failure
    setStatus(`Could not update auto-log setting: ${err.message}`, true);
  }
});

function setSettingsPanelOpen(open) {
  els.settingsPanel.classList.toggle('open', open);
  els.settingsPanel.setAttribute('aria-hidden', String(!open));
  els.settingsBackdrop.classList.toggle('hidden', !open);
}

els.settingsBtn.addEventListener('click', () => setSettingsPanelOpen(true));
els.settingsCloseBtn.addEventListener('click', () => setSettingsPanelOpen(false));
els.settingsBackdrop.addEventListener('click', () => setSettingsPanelOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && els.settingsPanel.classList.contains('open')) setSettingsPanelOpen(false);
});

async function saveWorkingPeriods() {
  const previousMorning = state.morningStart;
  const previousAfternoon = state.afternoonStart;
  state.morningStart = els.morningStartInput.value || previousMorning;
  state.afternoonStart = els.afternoonStartInput.value || previousAfternoon;
  try {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ morningStart: state.morningStart, afternoonStart: state.afternoonStart }),
    });
  } catch (error) {
    state.morningStart = previousMorning;
    state.afternoonStart = previousAfternoon;
    els.morningStartInput.value = previousMorning;
    els.afternoonStartInput.value = previousAfternoon;
    setStatus(`Could not update working periods: ${error.message}`, true);
  }
}

els.morningStartInput.addEventListener('change', saveWorkingPeriods);
els.afternoonStartInput.addEventListener('change', saveWorkingPeriods);

async function saveHolidaySettings() {
  const previousCountry = state.holidayCountry;
  const previousMode = state.holidayMode;
  state.holidayCountry = els.holidayCountryInput.value;
  state.holidayMode = els.holidayModeInput.value;
  updateHolidayModeAvailability();
  try {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holidayCountry: state.holidayCountry, holidayMode: state.holidayMode }),
    });
    await refresh();
  } catch (err) {
    state.holidayCountry = previousCountry;
    state.holidayMode = previousMode;
    els.holidayCountryInput.value = previousCountry;
    els.holidayModeInput.value = previousMode;
    updateHolidayModeAvailability();
    setStatus(`Could not update holiday settings: ${err.message}`, true);
  }
}

els.holidayCountryInput.addEventListener('change', saveHolidaySettings);
els.holidayModeInput.addEventListener('change', saveHolidaySettings);

els.addManualHolidayBtn.addEventListener('click', async () => {
  const dateStr = els.manualHolidayDateInput.value;
  const name = els.manualHolidayNameInput.value.trim();
  els.manualHolidayError.classList.add('hidden');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !name) {
    els.manualHolidayError.textContent = 'Choose a date and enter a holiday name.';
    els.manualHolidayError.classList.remove('hidden');
    return;
  }
  state.manualHolidays.set(dateStr, { date: dateStr, name, localName: name, manual: true });
  await saveManualHolidays();
  els.manualHolidayDateInput.value = '';
  els.manualHolidayNameInput.value = '';
  renderManualHolidayList();
  updateHolidayModeAvailability();
  await refresh();
});

// The popup is shown on hover/focus via CSS (:hover, :focus-within), but a
// click toggle is added too so it also works on touch devices where hover
// doesn't apply.
els.autoLogInfoIcon.addEventListener('click', (e) => {
  // The icon lives inside the toggle's <label>, so a plain click would also
  // forward to (and flip) the checkbox — preventDefault stops that native
  // label behavior; stopPropagation keeps the "click outside closes it"
  // document listener below from immediately closing what we just opened.
  e.preventDefault();
  e.stopPropagation();
  els.autoLogInfoIcon.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!els.autoLogInfoIcon.contains(e.target)) els.autoLogInfoIcon.classList.remove('open');
});

// A click on the dialog element itself is a click on its backdrop. Clicks
// inside the dialog target one of its descendants and leave it open.
els.dayDialog.addEventListener('click', (event) => {
  if (event.target === els.dayDialog) els.dayDialog.close();
});

document.getElementById('dayDialogCloseBtn').addEventListener('click', () => {
  els.dayDialog.close();
});

// Enter in a time/number field must only commit that field value — never
// submit and close the dialog.
els.dayDialog.addEventListener('submit', (event) => event.preventDefault());

// Export local absence markings and non-sensitive preferences. Credentials,
// account identity and automatic write settings are deliberately excluded.
els.exportDataBtn.addEventListener('click', async () => {
  const [{ oofByAccount: oof = {}, vacationByAccount: vacations = {}, manualHolidays = {} }, settings] = await Promise.all([
    chrome.storage.local.get(['oofByAccount', 'vacationByAccount', 'manualHolidays']),
    api('/api/settings'),
  ]);
  const vacationsByYear = Object.fromEntries(Object.entries(vacations).map(([accountId, dates]) => {
    const years = {};
    for (const dateStr of Array.isArray(dates) ? dates : []) (years[dateStr.slice(0, 4)] ||= []).push(dateStr);
    for (const values of Object.values(years)) values.sort();
    return [accountId, years];
  }));
  const payload = {
    format: 'jiralogwork-export',
    version: 5,
    exportedAt: new Date().toISOString(),
    oof,
    vacations: vacationsByYear,
    manualHolidays,
    preferences: {
      expectedHours: settings.expectedHours,
      annualVacationDaysByYear: settings.annualVacationDaysByYear || {},
      morningStart: settings.morningStart,
      afternoonStart: settings.afternoonStart,
      holidayCountry: settings.holidayCountry,
      holidayMode: settings.holidayMode,
      showWeekends: state.showWeekends,
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jiralogwork-export-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

els.importDataBtn.addEventListener('click', () => {
  els.importDataInput.value = '';
  els.importDataInput.click();
});

// Merges (never overwrites/discards) imported absence dates into the local
// store, per account — accepts both the wrapped export format above and a
// bare { accountId: [dates] } map for backward compatibility. Preferences
// are restored only from the explicit safe allow-list below.
els.importDataInput.addEventListener('change', async () => {
  const file = els.importDataInput.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const oofData = parsed?.oof || (parsed?.format === 'jiralogwork-export' ? {} : parsed);
    const vacationData = parsed?.vacations || {};
    const manualHolidayData = parsed?.manualHolidays || {};
    if (!oofData || typeof oofData !== 'object') throw new Error('Unrecognized file format.');

    const { oofByAccount: current = {}, vacationByAccount: currentVacations = {}, manualHolidays: currentManualHolidays = {} } = await chrome.storage.local.get(['oofByAccount', 'vacationByAccount', 'manualHolidays']);
    for (const [accountId, dates] of Object.entries(oofData)) {
      const merged = new Set([...(current[accountId] || []), ...(Array.isArray(dates) ? dates : [])]);
      current[accountId] = Array.from(merged);
    }
    for (const [accountId, datesOrYears] of Object.entries(vacationData)) {
      const importedDates = Array.isArray(datesOrYears)
        ? datesOrYears
        : Object.values(datesOrYears || {}).flatMap((dates) => Array.isArray(dates) ? dates : []);
      const merged = new Set([...(currentVacations[accountId] || []), ...importedDates]);
      currentVacations[accountId] = Array.from(merged);
    }
    for (const [dateStr, holiday] of Object.entries(manualHolidayData)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && holiday && typeof holiday === 'object') currentManualHolidays[dateStr] = holiday;
    }
    await chrome.storage.local.set({ oofByAccount: current, vacationByAccount: currentVacations, manualHolidays: currentManualHolidays });

    const preferences = parsed?.preferences;
    if (preferences && typeof preferences === 'object') {
      const safeSettings = {};
      for (const key of ['expectedHours', 'annualVacationDays', 'annualVacationDaysByYear', 'morningStart', 'afternoonStart', 'holidayCountry', 'holidayMode']) {
        if (preferences[key] !== undefined) safeSettings[key] = preferences[key];
      }
      if (Object.keys(safeSettings).length) await api('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(safeSettings),
      });
      if (typeof preferences.showWeekends === 'boolean') {
        state.showWeekends = preferences.showWeekends;
        els.showWeekendsInput.checked = state.showWeekends;
      }
      await loadSettings();
      updateWeekendsToggleAvailability();
      renderWeekdayHeader();
    }

    state.oofDates = await loadOofDates(state.user.accountId);
    state.vacationDates = await loadVacationDates(state.user.accountId);
    await loadManualHolidays();
    renderManualHolidayList();
    updateHolidayModeAvailability();
    renderGrid();
    renderSummary();
    setStatus('Data imported successfully.');
    setTimeout(() => setStatus(''), 3000);
  } catch (err) {
    setStatus(`Could not import file: ${err.message}`, true);
  }
});

// Loads settings persisted in chrome.storage for the background auto-log job.
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    els.autoLogInput.checked = Boolean(s.autoLogEnabled);
    if (s.expectedHours) {
      state.expectedHours = s.expectedHours;
      els.expectedHoursInput.value = s.expectedHours;
    }
    state.annualVacationDaysByYear = { ...(s.annualVacationDaysByYear || {}) };
    const currentYear = String(new Date().getFullYear());
    if (!(currentYear in state.annualVacationDaysByYear) && Number.isFinite(Number(s.annualVacationDays)) && Number(s.annualVacationDays) >= 0) {
      state.annualVacationDaysByYear[currentYear] = Number(s.annualVacationDays);
      api('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annualVacationDaysByYear: state.annualVacationDaysByYear }),
      }).catch((err) => console.error(err));
    }
    syncVacationEntitlementInputs(state.anchor.getFullYear());
    state.morningStart = s.morningStart || '09:00';
    state.afternoonStart = s.afternoonStart || '14:00';
    els.morningStartInput.value = state.morningStart;
    els.afternoonStartInput.value = state.afternoonStart;
    state.holidayCountry = s.holidayCountry || '';
    state.holidayMode = ['exclude', 'block'].includes(s.holidayMode) ? 'exclude' : 'mark';
    els.holidayCountryInput.value = state.holidayCountry;
    els.holidayModeInput.value = state.holidayMode;
    await loadManualHolidays();
    renderManualHolidayList();
    updateHolidayModeAvailability();
    // User switching remains disabled by default in this first extension build.
    els.userInput.disabled = !s.allowUserSwitch;
    els.userInput.title = s.allowUserSwitch
      ? 'Search for another Jira user.'
      : 'Viewing another user is disabled in this extension build.';
  } catch (err) {
    console.error(err);
  }
}

(async function init() {
  await migrateLegacyOofData();
  updateWeekendsToggleAvailability();
  renderWeekdayHeader();
  try {
    await ensureConfigured();
  } catch (err) {
    setStatus(`Error checking configuration: ${err.message}`, true);
  }
  try {
    await loadMe();
  } catch (err) {
    setStatus(`Error loading default user: ${err.message}`, true);
    return;
  }
  await loadSettings();
  await refresh();
})();
