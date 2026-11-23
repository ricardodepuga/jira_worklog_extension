const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared/time-utils.js');

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...cls) => cls.forEach((c) => set.add(c)),
    remove: (...cls) => cls.forEach((c) => set.delete(c)),
    toggle: (c, force) => {
      const next = force === undefined ? !set.has(c) : Boolean(force);
      if (next) set.add(c);
      else set.delete(c);
      return next;
    },
    contains: (c) => set.has(c),
  };
}

function makeElement(id, tag = 'div') {
  const listeners = {};
  return {
    id,
    tagName: tag.toUpperCase(),
    value: '',
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    max: '24',
    dataset: {},
    children: [],
    classList: makeClassList(),
    addEventListener: (type, fn) => {
      (listeners[type] ||= []).push(fn);
    },
    dispatchEvent: (event) => {
      for (const fn of listeners[event.type] || []) fn(event);
    },
    click: function () {
      if (typeof this.onclick === 'function') this.onclick();
      this.dispatchEvent({ type: 'click', target: this });
    },
    replaceChildren: function (...nodes) {
      this.children = nodes;
      if (nodes.length && nodes[0].value !== undefined) {
        this.value = nodes[0].value;
      }
    },
  };
}

const elements = new Map();
const getEl = (id) => {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
};

const quickBtn0 = makeElement('quick0', 'button');
quickBtn0.dataset.time = '09:00';
quickBtn0.textContent = '9:00';
const quickBtn1 = makeElement('quick1', 'button');
quickBtn1.dataset.time = '14:00';
quickBtn1.textContent = '14:00';

getEl('time').value = '09:00';
getEl('hours').value = '1';

globalThis.document = {
  body: { className: 'is-initializing' },
  getElementById: (id) => getEl(id),
  querySelectorAll: (sel) => (sel === '.time-quick-btn' ? [quickBtn0, quickBtn1] : []),
  createElement: (tag) => makeElement('', tag),
};

let storageState = { oofByAccount: {}, vacationByAccount: {} };
let apiHandler = async (path) => {
  if (path === '/api/config/status') return { configured: false, site: null, email: null };
  return {};
};
const createdTabs = [];

globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      try {
        const data = await apiHandler(msg.path, msg.options || {});
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message, code: err.code, site: err.site };
      }
    },
    getURL: (p) => `chrome-extension://test/${p}`,
  },
  tabs: {
    create: (info) => createdTabs.push(info),
  },
  storage: {
    local: {
      get: async () => storageState,
    },
  },
};

const popup = require('../src/frontend/popup/popup.js');

test('popup: adjusts start time and expected hours cap for full, half-day AM/PM, and split absences', async () => {
  const todayStr = popup.today();
  const submittedWorklogs = [];

  apiHandler = async (path, options = {}) => {
    if (path === '/api/config/status') return { configured: true, site: 'demo.atlassian.net', email: 'ricardo@example.com' };
    if (path === '/api/me') return { accountId: 'acc-1', displayName: 'Ricardo' };
    if (path === '/api/settings') return { expectedHours: 7, morningStart: '09:00', afternoonStart: '14:00' };
    if (path.startsWith('/api/issues/open')) {
      return [
        { key: 'PROJ-1', summary: 'First task' },
        { key: 'PROJ-2', summary: 'Second task' },
      ];
    }
    if (path === '/api/worklogs' && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      submittedWorklogs.push(payload);
      return { ok: true, worklogId: '55' };
    }
    if (path === '/api/config' && options.method === 'POST') {
      return { ok: true };
    }
    return {};
  };

  // 1. Morning OOF (0.5d) -> default start time becomes 14:00, suggested hours capped at 3.5h
  storageState = {
    oofByAccount: { 'acc-1': [`${todayStr}:am`] },
    vacationByAccount: {},
  };
  await popup.loadWorklogForm();
  assert.equal(getEl('time').value, '14:00');
  assert.equal(quickBtn1.classList.contains('active'), true);
  assert.ok(Number(getEl('hours').value) <= 3.5);

  // 2. Afternoon Vacation (0.5d) -> default start time becomes 09:00, suggested hours capped at 3.5h
  storageState = {
    oofByAccount: {},
    vacationByAccount: { 'acc-1': [`${todayStr}:pm`] },
  };
  await popup.loadWorklogForm();
  assert.equal(getEl('time').value, '09:00');
  assert.equal(quickBtn0.classList.contains('active'), true);
  assert.ok(Number(getEl('hours').value) <= 3.5);

  // 2b. Full-day OOF, Full-day Vacation, and Split AM OOF + PM Vacation -> occupiedPeriod is 'full', fallback to baseExpectedHours (7)
  for (const state of [
    { oofByAccount: { 'acc-1': [todayStr] }, vacationByAccount: {} },
    { oofByAccount: {}, vacationByAccount: { 'acc-1': [todayStr] } },
    { oofByAccount: { 'acc-1': [`${todayStr}:am`] }, vacationByAccount: { 'acc-1': [`${todayStr}:pm`] } },
  ]) {
    storageState = state;
    await popup.loadWorklogForm();
    assert.equal(getEl('hours').max, '7');
    assert.ok(Number(getEl('hours').value) >= 0.5 && Number(getEl('hours').value) <= 7);
  }

  // 2c. Invalid time in #time input falls back cleanly in updateSuggestedHours
  storageState = { oofByAccount: {}, vacationByAccount: {} };
  await popup.loadWorklogForm();
  getEl('time').value = 'invalid';
  getEl('time').dispatchEvent({ type: 'input', target: getEl('time') });
  getEl('time').value = '09:00';
  getEl('time').dispatchEvent({ type: 'change', target: getEl('time') });

  // 3. Quick time button click updates time and active state
  quickBtn1.click();
  assert.equal(getEl('time').value, '14:00');
  assert.equal(quickBtn1.classList.contains('active'), true);

  // 4. Submit worklog form (success and error paths)
  getEl('hours').value = '2.5';
  getEl('comment').value = '  Finished implementation  ';
  await getEl('form').onsubmit({ preventDefault: () => {} });
  assert.equal(submittedWorklogs.length, 1);
  assert.equal(submittedWorklogs[0].issueKey, 'PROJ-1');
  assert.equal(submittedWorklogs[0].seconds, 2.5 * 3600);
  assert.equal(submittedWorklogs[0].comment, 'Finished implementation');
  assert.equal(getEl('status').textContent, 'Worklog added successfully.');

  const prevHandler = apiHandler;
  apiHandler = async (path, options = {}) => {
    if (path === '/api/worklogs' && options.method === 'POST') {
      throw Object.assign(new Error('Worklog rejected'), { code: 'JIRA_API_ERROR', site: 'demo.atlassian.net' });
    }
    if (path === '/api/config' && options.method === 'POST') {
      throw new Error('Invalid token');
    }
    return prevHandler(path, options);
  };
  await getEl('form').onsubmit({ preventDefault: () => {} });
  assert.equal(getEl('status').textContent, 'Worklog rejected');
  assert.equal(getEl('status').className, 'error');
  await getEl('setupForm').onsubmit({ preventDefault: () => {} });
  assert.equal(getEl('status').textContent, 'Invalid token');
  apiHandler = prevHandler;

  // 5. Calendar button opens full calendar tab
  getEl('calendar').click();
  assert.equal(createdTabs.length, 1);
  assert.match(createdTabs[0].url, /calendar\.html$/);

  // 6. Setup form and error handling
  popup.showError(Object.assign(new Error('Token expired.'), { code: 'JIRA_AUTH_REQUIRED' }));
  assert.equal(getEl('setupForm').hidden, false);
  assert.match(getEl('status').textContent, /Jira browser login is not used/);

  getEl('setupSite').value = 'demo.atlassian.net';
  getEl('setupEmail').value = 'ricardo@example.com';
  getEl('setupToken').value = 'new-token';
  await getEl('setupForm').onsubmit({ preventDefault: () => {} });
  assert.equal(getEl('form').hidden, false);

  // 7. Non-auth error message, empty open issues, unconfigured init, and init error
  popup.showError(new Error('Network timeout'));
  assert.equal(getEl('status').textContent, 'Network timeout');
  assert.equal(getEl('status').className, 'error');

  apiHandler = async (path) => {
    if (path === '/api/config/status') return { configured: true, site: 'demo.atlassian.net', email: 'ricardo@example.com' };
    if (path === '/api/me') return { accountId: 'acc-1', displayName: 'Ricardo' };
    if (path === '/api/settings') return { expectedHours: 7, morningStart: '09:00', afternoonStart: '14:00' };
    if (path.startsWith('/api/issues/open')) return [];
    return {};
  };
  await popup.init();
  assert.equal(getEl('status').textContent, 'No open assigned tasks found.');

  apiHandler = async (path) => {
    if (path === '/api/config/status') return { configured: false, site: 'demo.atlassian.net', email: 'ricardo@example.com' };
    return {};
  };
  await popup.init();
  assert.equal(getEl('setupForm').hidden, false);

  apiHandler = async () => {
    throw new Error('Service worker offline');
  };
  await popup.init();
  assert.equal(getEl('status').textContent, 'Service worker offline');
});


