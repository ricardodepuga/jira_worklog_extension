const $ = (id) => document.getElementById(id);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
async function api(path, options = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'api', path, options });
  if (!response?.ok) throw new Error(response?.error || 'Extension service unavailable.');
  return response.data;
}
$('calendar').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('calendar.html') });

function showSetup() {
  document.body.className = 'is-setup';
  $('status').textContent = '';
  $('form').hidden = true;
  $('setupForm').hidden = false;
}

function updateSuggestedHours() {
  const [startHour, startMinute] = $('time').value.split(':').map(Number);
  if (!Number.isFinite(startHour) || !Number.isFinite(startMinute)) return;
  const now = new Date();
  const elapsedMinutes = now.getHours() * 60 + now.getMinutes() - (startHour * 60 + startMinute);
  const halfHourUnits = Math.max(1, Math.round(elapsedMinutes / 30));
  $('hours').value = Math.min(24, halfHourUnits / 2);
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
  const me = await api('/api/me');
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
      $('status').textContent = error.message;
      $('status').className = 'error';
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
    $('status').textContent = error.message;
    $('status').className = 'error';
  } finally {
    $('connect').disabled = false;
  }
};

async function init() {
  try {
    const config = await api('/api/config/status');
    if (!config.configured) {
      showSetup();
      return;
    }
    await loadWorklogForm();
  } catch (error) {
    $('status').textContent = error.message;
    $('status').className = 'error';
  }
}
init();
