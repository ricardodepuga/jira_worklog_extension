const state = {
  me: null, // token owner: { accountId, displayName, email }
  user: null, // currently viewed user: { accountId, displayName, email }
  view: 'month', // 'month' | 'week'
  anchor: new Date(),
  showWeekends: false, // only affects month view
  expectedHours: 7,
  jiraSite: null,
  byDate: {},
  monthByDate: {},
  selectedDate: null, // YYYY-MM-DD, drives the "week" summary block; defaults to today
  selectedWeekByDate: {},
  refreshToken: 0, // prevents slower, older Jira responses replacing the latest view
  openIssuesCache: new Map(), // per-date cached suggestions, keyed by dateStr
  oofDates: new Set(), // dates marked as out-of-office for state.user
};

const OOF_STORAGE_KEY = 'logwork_oof_v1';

async function loadOofDates(accountId) {
  const { oofByAccount = {} } = await chrome.storage.local.get('oofByAccount');
  return new Set(oofByAccount[accountId] || []);
}

async function setOofDate(accountId, dateStr, isOof) {
  const { oofByAccount = {} } = await chrome.storage.local.get('oofByAccount');
  const set = new Set(oofByAccount[accountId] || []);
  if (isOof) set.add(dateStr);
  else set.delete(dateStr);
  oofByAccount[accountId] = Array.from(set);
  await chrome.storage.local.set({ oofByAccount });
  return set;
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
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  todayBtn: document.getElementById('todayBtn'),
  periodLabel: document.getElementById('periodLabel'),
  showWeekendsInput: document.getElementById('showWeekendsInput'),
  expectedHoursInput: document.getElementById('expectedHoursInput'),
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
  // Keep the dropdown open as long as the search field still has focus,
  // rather than only comparing against e.target: a click that focuses the
  // field can, in some input pipelines, dispatch a second click event whose
  // target is an unrelated ancestor, which momentarily made this listener
  // close the dropdown it had just opened. Focus state is the more stable
  // signal here — it only actually changes when the user really does click
  // (or tab) away.
  if (document.activeElement === issueInput) return;
  if (!suggestionsEl.contains(e.target)) {
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
  } else {
    els.periodLabel.textContent = `${MONTH_LABELS[state.anchor.getMonth()]} ${state.anchor.getFullYear()}`;
  }
}

function weekendsHiddenNow() {
  return state.view === 'month' && !state.showWeekends;
}

function renderWeekdayHeader() {
  const labels = weekendsHiddenNow() ? WEEKDAY_LABELS.slice(0, 5) : WEEKDAY_LABELS;
  els.calendarWeekdays.style.gridTemplateColumns = `repeat(${labels.length}, 1fr)`;
  els.calendarWeekdays.innerHTML = labels.map((d) => `<div>${d}</div>`).join('');
}

function renderGrid() {
  const { gridStart, gridEnd, dataStart, dataEnd } = getRange();
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
    const entries = state.byDate[dateStr] || [];
    const totalSeconds = entries.reduce((sum, e) => sum + e.seconds, 0);
    const hours = secondsToHours(totalSeconds);

    if (!inRange) {
      cells.push(`<div class="day-cell empty-slot"></div>`);
    } else {
      const isOof = state.oofDates.has(dateStr);
      const cls = [
        'day-cell',
        weekend ? 'weekend' : '',
        isFuture ? 'future' : '',
        dateStr === today ? 'today' : '',
        dateStr === state.selectedDate ? 'selected' : '',
        isOof ? 'oof' : '',
      ].filter(Boolean).join(' ');

      const badge = isOof
        ? `<span class="hours-badge oof-badge">OOF</span>`
        : entries.length || !weekend
          ? `<span class="hours-badge ${badgeClass(hours, state.expectedHours, weekend)}">${fmtHours(hours)}</span>`
          : `<span class="hours-badge none">—</span>`;

      const maxChips = state.view === 'week' ? entries.length : 3;
      const visibleEntries = entries.slice(0, maxChips);
      const hiddenCount = entries.length - visibleEntries.length;
      const chipHtml = visibleEntries
        .map((e) => `<span class="chip${e.autoLogged ? ' auto-chip' : ''}" title="${escapeHtml(e.issueSummary)}${e.autoLogged ? ' (auto-logged)' : ''}">${escapeHtml(e.issueKey)} · ${fmtHours(secondsToHours(e.seconds))}${e.autoLogged ? ' 🤖' : ''}</span>`)
        .join('');
      const moreChip = hiddenCount > 0 ? `<span class="chip chip-more">+${hiddenCount} more</span>` : '';
      const extra = `<div class="issue-list">${chipHtml || moreChip ? chipHtml + moreChip : (state.view === 'week' ? '<span class="chip" style="opacity:.5">No entries</span>' : '')}</div>`;

      cells.push(`<div class="${cls}" data-date="${dateStr}">
        <div class="date-num">${cursor.getDate()}</div>
        ${extra}
        ${badge}
      </div>`);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  els.calendarGrid.innerHTML = cells.join('');
  els.calendarGrid.querySelectorAll('.day-cell[data-date]').forEach((cell) => {
    cell.addEventListener('click', async () => {
      const dateStr = cell.dataset.date;
      state.selectedDate = dateStr;
      els.calendarGrid.querySelectorAll('.day-cell.selected').forEach((selected) => selected.classList.remove('selected'));
      cell.classList.add('selected');
      const selectedWeekByDate = await resolveSelectedWeekData();
      // Ignore a slower result if another day was selected meanwhile.
      if (state.selectedDate !== dateStr) return;
      state.selectedWeekByDate = selectedWeekByDate;
      renderSummary();
    });
    cell.addEventListener('dblclick', () => openDayDialog(cell.dataset.date));
  });
}

function renderLoadingGrid() {
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

function injectOptimisticEntry(dateStr, entry) {
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
  forEachDateMap((map) => {
    if (!map[dateStr]) return;
    map[dateStr] = map[dateStr].filter((e) => e.worklogId !== worklogId);
  });
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

function renderDayDialogBody(dateStr) {
  const entries = state.byDate[dateStr] || [];
  const own = isOwnUser();
  const isOof = state.oofDates.has(dateStr);

  let html = '';
  // Never shown once the day has any logged task, or while the add-worklog
  // form is expanded (that form gets hidden again in wireAddEntryForm).
  const canMarkOof = own && entries.length === 0;

  if (canMarkOof) {
    html += `
      <div id="oofToggleWrapper">
        <label class="oof-toggle">
          <input type="checkbox" id="oofCheckbox" ${isOof ? 'checked' : ''} />
          Mark as Out of Office
        </label>
      </div>`;
  }

  if (!entries.length) {
    html += '<div class="no-entries">No work logged on this day.</div>';
  } else {
    const overlapFlags = findOverlappingEntries(entries);
    html += `<div id="entryList">${entries.map((e, i) => entryRowHtml(e, overlapFlags[i])).join('')}</div>`;
  }

  if (own && isOof) {
    html += `<div class="readonly-note">This day is marked as Out of Office — unmark it above to add a worklog.</div>`;
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
  if (own && !isOof) wireAddEntryForm(dateStr);
  if (canMarkOof) {
    document.getElementById('oofCheckbox').addEventListener('change', async (e) => {
      state.oofDates = await setOofDate(state.user.accountId, dateStr, e.target.checked);
      renderGrid();
      renderSummary();
      // Toggling OOF flips whether adding a worklog is allowed on this day,
      // so the dialog body needs a full re-render, not just the checkbox.
      renderDayDialogBody(dateStr);
    });
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
      ${taskTotalHours ? `<span class="task-total">Task total to date: ${taskTotalHours}</span>` : ''}
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
  // startedIso looks like 2026-09-01T09:00:00.000+0300
  const match = /T(\d{2}:\d{2})/.exec(startedIso || '');
  return match ? match[1] : '09:00';
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
      <label>Hours
        <input type="number" min="0.5" step="0.5" value="${hours}" required />
      </label>
      <label>Start time
        <div class="time-quick-picks">
          <button type="button" class="time-quick-btn" data-time="09:00">9:00</button>
          <button type="button" class="time-quick-btn" data-time="14:00">14:00</button>
        </div>
        <input type="time" value="${time}" required />
      </label>
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
      refresh(); // background reconcile
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
    refresh(); // background reconcile
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
      <label>Hours
        <input type="number" id="addHoursInput" min="0.5" step="0.5" value="${state.expectedHours}" required />
      </label>
      <label>Start time
        <div class="time-quick-picks">
          <button type="button" class="time-quick-btn" data-time="09:00">9:00</button>
          <button type="button" class="time-quick-btn" data-time="14:00">14:00</button>
        </div>
        <input type="time" id="addTimeInput" value="09:00" required />
      </label>
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
          const results = await api(`/api/issues/search?q=${encodeURIComponent(q)}`);
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
      const time = document.getElementById('addTimeInput').value || '09:00';
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
        });
        els.dayDialog.close();
        renderGrid();
        renderSummary();
        refresh(); // background reconcile once Jira's search index catches up
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
        if (state.oofDates.has(dateStr)) {
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
            <span class="label">OOF days</span>
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

function renderSummary() {
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
    return data.byDate || {};
  } catch (err) {
    setStatus(`Error loading worklogs: ${err.message}`, true);
    return {};
  }
}

async function refresh() {
  if (!state.user) return;
  const token = ++state.refreshToken;
  if (!state.selectedDate) state.selectedDate = todayStr();
  updatePeriodLabel();
  renderWeekdayHeader();
  state.oofDates = await loadOofDates(state.user.accountId);
  renderLoadingGrid();

  const { dataStart, dataEnd } = getRange();
  setStatus('Loading worklogs from Jira…');
  const byDate = await fetchWorklogRange(dataStart, dataEnd);
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
}

function updateWeekendsToggleAvailability() {
  els.showWeekendsInput.disabled = state.view !== 'month';
}

els.viewMonthBtn.addEventListener('click', () => {
  state.view = 'month';
  els.viewMonthBtn.classList.add('active');
  els.viewWeekBtn.classList.remove('active');
  updateWeekendsToggleAvailability();
  refresh();
});

els.viewWeekBtn.addEventListener('click', () => {
  state.view = 'week';
  els.viewWeekBtn.classList.add('active');
  els.viewMonthBtn.classList.remove('active');
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
  else {
    const selectedDay = state.selectedDate ? Number(state.selectedDate.slice(8, 10)) : state.anchor.getDate();
    const target = new Date(state.anchor.getFullYear(), state.anchor.getMonth() - 1, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(selectedDay, lastDay));
    state.anchor = target;
    state.selectedDate = fmtDate(target);
  }
  state.anchor = new Date(state.anchor);
  refresh();
});

els.nextBtn.addEventListener('click', () => {
  if (state.view === 'week') state.anchor.setDate(state.anchor.getDate() + 7);
  else {
    const selectedDay = state.selectedDate ? Number(state.selectedDate.slice(8, 10)) : state.anchor.getDate();
    const target = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(selectedDay, lastDay));
    state.anchor = target;
    state.selectedDate = fmtDate(target);
  }
  state.anchor = new Date(state.anchor);
  refresh();
});

els.todayBtn.addEventListener('click', () => {
  state.anchor = new Date();
  state.selectedDate = todayStr();
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

// Export local OOF markings without exporting credentials or Jira data.
els.exportDataBtn.addEventListener('click', async () => {
  const { oofByAccount: oof = {} } = await chrome.storage.local.get('oofByAccount');
  const payload = {
    format: 'jiralogwork-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    oof,
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

// Merges (never overwrites/discards) imported OOF dates into the local
// store, per account — accepts both the wrapped export format above and a
// bare { accountId: [dates] } map for backward compatibility.
els.importDataInput.addEventListener('change', async () => {
  const file = els.importDataInput.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const oofData = parsed && parsed.oof ? parsed.oof : parsed;
    if (!oofData || typeof oofData !== 'object') throw new Error('Unrecognized file format.');

    const { oofByAccount: current = {} } = await chrome.storage.local.get('oofByAccount');
    for (const [accountId, dates] of Object.entries(oofData)) {
      const merged = new Set([...(current[accountId] || []), ...(Array.isArray(dates) ? dates : [])]);
      current[accountId] = Array.from(merged);
    }
    await chrome.storage.local.set({ oofByAccount: current });

    state.oofDates = await loadOofDates(state.user.accountId);
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
