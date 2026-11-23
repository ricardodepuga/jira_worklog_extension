const { absencePeriodForDate, combinedDayAbsence, expectedHoursForDay, workStartForDay } = globalThis.JiraLogWorkTime;
const $ = (id) => document.getElementById(id);
let expectedHoursPerDay = 7;
let savedConnection = null;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
async function api(path, options = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'api', path, options });
  if (!response?.ok) {
    const error = new Error(response?.error || 'Extension service unavailable.');
    error.code = response?.code;
    error.site = response?.site;
    throw error;
  }
  return response.data;
}
$('calendar').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/frontend/calendar/calendar.html') });

function showError(error) {
  const status = $('status');
  status.className = 'error';
  if (error.code !== 'JIRA_AUTH_REQUIRED') {
    status.textContent = error.message;
    return;
  }
  showSetup(`${error.message} The Jira browser login is not used.`);
}

function formatTimeLabel(time) { return time.replace(/^0/, ''); }
function applyWorkingPeriods(settings, absencePeriod = null) {
  const morning = settings.morningStart || '09:00';
  const afternoon = settings.afternoonStart || '14:00';
  const buttons = document.querySelectorAll('.time-quick-btn');
  [[buttons[0], morning], [buttons[1], afternoon]].forEach(([button, time]) => {
    button.dataset.time = time;
    button.textContent = formatTimeLabel(time);
  });
  $('time').value = workStartForDay(morning, afternoon, absencePeriod);
}

function showSetup(message = '') {
  document.body.className = 'is-setup';
  $('status').className = message ? 'error' : '';
  $('status').textContent = message;
  if (savedConnection) {
    $('setupSite').value = savedConnection.site || '';
    $('setupEmail').value = savedConnection.email || '';
  }
  $('setupToken').value = '';
  $('form').hidden = true;
  $('setupForm').hidden = false;
}

function updateSuggestedHours() {
  const [startHour, startMinute] = $('time').value.split(':').map(Number);
  if (!Number.isFinite(startHour) || !Number.isFinite(startMinute)) return;
  const now = new Date();
  const elapsedMinutes = now.getHours() * 60 + now.getMinutes() - (startHour * 60 + startMinute);
  const halfHourUnits = Math.max(1, Math.round(elapsedMinutes / 30));
  $('hours').value = Math.min(expectedHoursPerDay, halfHourUnits / 2);
  document.querySelectorAll('.time-quick-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.time === $('time').value);
  });
}

document.querySelectorAll('.time-quick-btn').forEach((button) => {
  button.addEventListener('click', () => {
    $('time').value = button.dataset.time;
    updateSuggestedHours();
  });
});
$('time').addEventListener('change', updateSuggestedHours);

async function loadWorklogForm() {
  const [me, settings, storage] = await Promise.all([
    api('/api/me'),
    api('/api/settings'),
    chrome.storage.local.get(['oofByAccount', 'vacationByAccount']),
  ]);
  const todayDate = today();
  const dayAbsence = combinedDayAbsence(
    absencePeriodForDate(storage.oofByAccount?.[me.accountId], todayDate),
    absencePeriodForDate(storage.vacationByAccount?.[me.accountId], todayDate),
  );
  const absencePeriod = dayAbsence.occupiedPeriod;
  const configuredExpectedHours = Number(settings.expectedHours);
  const baseExpectedHours = Number.isFinite(configuredExpectedHours) && configuredExpectedHours > 0
    ? configuredExpectedHours
    : 7;
  expectedHoursPerDay = expectedHoursForDay(baseExpectedHours, absencePeriod) || baseExpectedHours;
  $('hours').max = String(baseExpectedHours);
  applyWorkingPeriods(settings, absencePeriod);
  const issues = await api(`/api/issues/open?accountId=${encodeURIComponent(me.accountId)}&date=${today()}`);
  $('setupForm').hidden = true;
  if (!issues.length) {
    $('status').textContent = 'No open assigned tasks found.';
    return;
  }
  $('issue').replaceChildren(...issues.map((issue) => {
    const option = document.createElement('option');
    option.value = issue.key;
    option.textContent = `${issue.key} — ${issue.summary}`;
    return option;
  }));
  $('status').className = '';
  $('status').textContent = `${me.displayName} · ${today()}`;
  document.body.className = 'is-worklog';
  $('form').hidden = false;
  updateSuggestedHours();
  $('form').onsubmit = async (event) => {
    event.preventDefault();
    $('save').disabled = true;
    $('status').className = '';
    $('status').textContent = 'Adding worklog…';
    try {
      await api('/api/worklogs', {
        method: 'POST',
        body: JSON.stringify({
          accountId: me.accountId,
          issueKey: $('issue').value,
          date: today(),
          time: $('time').value,
          seconds: Number($('hours').value) * 3600,
          comment: $('comment').value.trim(),
        }),
      });
      $('status').textContent = 'Worklog added successfully.';
      $('comment').value = '';
    } catch (error) {
      showError(error);
    } finally {
      $('save').disabled = false;
    }
  };
}

$('setupForm').onsubmit = async (event) => {
  event.preventDefault();
  $('connect').disabled = true;
  $('status').className = '';
  $('status').textContent = 'Connecting to Jira…';
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        site: $('setupSite').value,
        email: $('setupEmail').value,
        apiToken: $('setupToken').value,
      }),
    });
    $('setupToken').value = '';
    await loadWorklogForm();
  } catch (error) {
    showError(error);
  } finally {
    $('connect').disabled = false;
  }
};

async function init() {
  try {
    const config = await api('/api/config/status');
    savedConnection = config;
    if (!config.configured) {
      showSetup();
      return;
    }
    await loadWorklogForm();
  } catch (error) {
    showError(error);
  }
}
init();

if (typeof module !== 'undefined') {
  module.exports = {
    today,
    api,
    showError,
    formatTimeLabel,
    applyWorkingPeriods,
    showSetup,
    updateSuggestedHours,
    loadWorklogForm,
    init,
  };
}

