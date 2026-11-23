const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Set up globals required by service-worker.js before requiring it
const storageData = {};
const alarmsMap = new Map();
const messageListeners = [];
const alarmListeners = [];
const installedListeners = [];
const startupListeners = [];
const selfListeners = {};

function resetStorage(initial = {}) {
  for (const key of Object.keys(storageData)) delete storageData[key];
  Object.assign(storageData, JSON.parse(JSON.stringify(initial)));
}

globalThis.importScripts = (...scripts) => {
  for (const rel of scripts) {
    require(path.resolve(__dirname, '../src/backend', rel));
  }
};

globalThis.self = {
  addEventListener: (type, fn) => {
    (selfListeners[type] ||= []).push(fn);
  },
};

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: storageData[keys] };
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((k) => [k, storageData[k]]));
        }
        if (keys && typeof keys === 'object') {
          const out = {};
          for (const [k, def] of Object.entries(keys)) {
            out[k] = storageData[k] !== undefined ? storageData[k] : def;
          }
          return out;
        }
        return { ...storageData };
      },
      set: async (patch) => {
        Object.assign(storageData, JSON.parse(JSON.stringify(patch)));
      },
    },
  },
  alarms: {
    create: async (name, info) => {
      alarmsMap.set(name, info);
    },
    get: async (name) => alarmsMap.get(name) || null,
    onAlarm: {
      addListener: (fn) => alarmListeners.push(fn),
    },
  },
  runtime: {
    onMessage: {
      addListener: (fn) => messageListeners.push(fn),
    },
    onInstalled: {
      addListener: (fn) => installedListeners.push(fn),
    },
    onStartup: {
      addListener: (fn) => startupListeners.push(fn),
    },
  },
};

let fetchHandler = async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null },
  json: async () => ({}),
  text: async () => '',
});

globalThis.fetch = async (url, options = {}) => fetchHandler(url, options);

const sw = require('../src/backend/service-worker.js');

function withMockedNow(isoString, fn) {
  const RealDate = Date;
  const fixedNow = new RealDate(isoString);
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate(fixedNow.getTime());
      return new RealDate(...args);
    }
    static now() {
      return fixedNow.getTime();
    }
  }
  globalThis.Date = MockDate;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.Date = RealDate;
    });
}

test('service-worker: ADF comment helpers and auto marker parsing', () => {
  assert.equal(sw.adfToText(null), null);
  assert.equal(sw.adfToText('plain comment'), 'plain comment');
  assert.equal(
    sw.adfToText({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '  hello ' }, { type: 'text', text: 'world  ' }] }],
    }),
    'hello world'
  );
  assert.equal(sw.adfToText({ type: 'doc', content: [] }), null);

  assert.equal(sw.toAdfComment(''), undefined);
  assert.deepEqual(sw.toAdfComment('work note'), {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'work note' }] }],
  });

  assert.deepEqual(sw.parseAutoMarker(null), { autoLogged: false, text: null });
  assert.deepEqual(sw.parseAutoMarker('[auto] Custom note'), { autoLogged: true, text: 'Custom note' });
  assert.deepEqual(sw.parseAutoMarker('[AUTO]   '), { autoLogged: true, text: null });
  assert.deepEqual(sw.parseAutoMarker('Auto-logged by the LogWork scheduler'), { autoLogged: true, text: null });
  assert.deepEqual(sw.parseAutoMarker('Manual note'), { autoLogged: false, text: 'Manual note' });
});

test('service-worker: cleanSite, validateSite, and updateSettings validations', async () => {
  assert.equal(sw.cleanSite(' https://demo.atlassian.net/ '), 'demo.atlassian.net');
  assert.doesNotThrow(() => sw.validateSite('my-team-1.atlassian.net'));
  assert.throws(() => sw.validateSite('invalid.example.com'), /valid Jira Cloud site/);

  const updated = await sw.updateSettings({
    autoLogEnabled: true,
    expectedHours: 7.5,
    annualVacationDays: 22.5,
    annualVacationDaysByYear: { 2026: 23.5 },
    holidayCountry: 'pt',
    holidayMode: 'block',
    morningStart: '08:30',
    afternoonStart: '13:30',
    autoLogStatusIds: ['3', '4', '3'],
    taskListStatusIds: null,
  });
  assert.equal(updated.autoLogEnabled, true);
  assert.equal(updated.expectedHours, 7.5);
  assert.equal(updated.annualVacationDays, 22.5);
  assert.deepEqual(updated.annualVacationDaysByYear, { 2026: 23.5 });
  assert.equal(updated.holidayCountry, 'PT');
  assert.equal(updated.holidayMode, 'exclude');
  assert.equal(updated.morningStart, '08:30');
  assert.equal(updated.afternoonStart, '13:30');
  assert.deepEqual(updated.autoLogStatusIds, ['3', '4']);
  assert.equal(updated.taskListStatusIds, null);

  await assert.rejects(() => sw.updateSettings({ expectedHours: 7.3 }), /multiple of 0.5/);
  await assert.rejects(() => sw.updateSettings({ annualVacationDays: -1 }), /multiple of 0.5/);
  await assert.rejects(() => sw.updateSettings({ annualVacationDaysByYear: [] }), /organized by year/);
  await assert.rejects(() => sw.updateSettings({ annualVacationDaysByYear: { 2026: 10.3 } }), /multiple of 0.5/);
  await assert.rejects(() => sw.updateSettings({ holidayCountry: 'PRT' }), /valid holiday country/);
  await assert.rejects(() => sw.updateSettings({ holidayMode: 'invalid' }), /valid holiday mode/);
  await assert.rejects(() => sw.updateSettings({ autoLogStatusIds: 'bad' }), /must be a list/);
  await assert.rejects(() => sw.updateSettings({ morningStart: '9:00' }), /HH:MM/);
});

test('service-worker: runAutoLog skips full OOF, full Vacation, and split OOF + Vacation, and logs half-days accurately', async () => {
  const createdWorklogs = [];
  fetchHandler = async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: '3', name: 'In Progress', statusCategory: { name: 'In Progress' } },
          { id: '4', name: 'Review', statusCategory: { name: 'In Progress' } },
        ],
      };
    }
    if (u.endsWith('/field')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'customfield_10016', name: 'Story Points' }],
      };
    }
    if (u.endsWith('/myself')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accountId: 'acc-1',
          displayName: 'Ricardo',
          emailAddress: 'ricardo@example.com',
          timeZone: 'Europe/Lisbon',
        }),
      };
    }
    if (u.endsWith('/search/jql')) {
      const body = JSON.parse(options.body || '{}');
      if (body.jql.includes('worklogAuthor')) {
        return { ok: true, status: 200, json: async () => ({ issues: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          issues: [
            {
              key: 'PROJ-1',
              fields: {
                summary: 'Half-day task',
                status: { id: '3', name: 'In Progress' },
                project: { key: 'PROJ' },
              },
            },
          ],
        }),
      };
    }
    if (u.includes('/worklog?adjustEstimate=leave') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      createdWorklogs.push({ url: u, payload });
      return { ok: true, status: 200, json: async () => ({ id: String(createdWorklogs.length) }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // Wednesday 2026-10-14 at 18:05 local time
  const testInstant = new Date(2026, 9, 14, 18, 5, 0).toISOString();
  const dateStr = '2026-10-14';

  const baseState = () => ({
    autoLogSafetyResetV1: true,
    statusFilterCleanupV1: true,
    config: { site: 'demo.atlassian.net', email: 'ricardo@example.com', apiToken: 'tok' },
    me: { accountId: 'acc-1', displayName: 'Ricardo', email: 'ricardo@example.com', timeZone: 'Europe/Lisbon' },
    settings: {
      autoLogEnabled: true,
      expectedHours: 7,
      morningStart: '09:00',
      afternoonStart: '14:00',
      lastAutoLogDate: null,
      holidayCountry: '',
      holidayMode: 'mark',
      autoLogStatusIds: ['3', '4'],
      taskListStatusIds: ['3', '4'],
    },
    oofByAccount: {},
    vacationByAccount: {},
    manualHolidays: {},
  });

  // 1. Split OOF (AM) + Vacation (PM) -> skipped
  await withMockedNow(testInstant, async () => {
    resetStorage({
      ...baseState(),
      oofByAccount: { 'acc-1': [`${dateStr}:am`] },
      vacationByAccount: { 'acc-1': [`${dateStr}:pm`] },
    });
    const status = await sw.runAutoLog();
    assert.equal(status.outcome, 'skipped');
    assert.match(status.message, /OOF and Vacation/);
    assert.equal(createdWorklogs.length, 0);
  });

  // 2. Full-day OOF -> skipped
  await withMockedNow(testInstant, async () => {
    resetStorage({
      ...baseState(),
      oofByAccount: { 'acc-1': [dateStr] },
    });
    const status = await sw.runAutoLog();
    assert.equal(status.outcome, 'skipped');
    assert.match(status.message, /marked OOF/);
  });

  // 3. Full-day Vacation -> skipped
  await withMockedNow(testInstant, async () => {
    resetStorage({
      ...baseState(),
      vacationByAccount: { 'acc-1': [`${dateStr}:am`, `${dateStr}:pm`] },
    });
    const status = await sw.runAutoLog();
    assert.equal(status.outcome, 'skipped');
    assert.match(status.message, /marked as Vacation/);
  });

  // 4. Morning OOF (0.5d) -> logs 3.5h starting at 14:00 (afternoonStart)
  await withMockedNow(testInstant, async () => {
    createdWorklogs.length = 0;
    resetStorage({
      ...baseState(),
      oofByAccount: { 'acc-1': [`${dateStr}:am`] },
    });
    const status = await sw.runAutoLog();
    assert.equal(status.outcome, 'success');
    assert.equal(createdWorklogs.length, 1);
    assert.equal(createdWorklogs[0].payload.timeSpentSeconds, 3.5 * 3600);
    assert.match(createdWorklogs[0].payload.started, /^2026-10-14T14:00:00\.000/);
  });

  // 5. Afternoon Vacation (0.5d) -> logs 3.5h starting at 09:00 (morningStart)
  await withMockedNow(testInstant, async () => {
    createdWorklogs.length = 0;
    resetStorage({
      ...baseState(),
      vacationByAccount: { 'acc-1': [`${dateStr}:pm`] },
    });
    const status = await sw.runAutoLog();
    assert.equal(status.outcome, 'success');
    assert.equal(createdWorklogs.length, 1);
    assert.equal(createdWorklogs[0].payload.timeSpentSeconds, 3.5 * 3600);
    assert.match(createdWorklogs[0].payload.started, /^2026-10-14T09:00:00\.000/);
  });
});

test('service-worker: handleApi routes and error diagnostics', async () => {
  fetchHandler = async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith('/myself')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accountId: 'acc-1',
          displayName: 'Ricardo',
          emailAddress: 'ricardo@example.com',
          timeZone: 'Europe/Lisbon',
        }),
      };
    }
    if (u.endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: '3', name: 'In Progress', statusCategory: { name: 'In Progress' } },
          { id: '4', name: 'Review', statusCategory: { name: 'In Progress' } },
        ],
      };
    }
    if (u.endsWith('/field')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'customfield_10016', name: 'Story Points' }],
      };
    }
    if (u.endsWith('/search/jql')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          issues: [
            {
              key: 'PROJ-10',
              fields: {
                summary: 'Test task',
                status: { id: '3', name: 'In Progress' },
                project: { key: 'PROJ' },
                customfield_10016: 5,
                timeoriginalestimate: 14400,
                timeestimate: 7200,
              },
            },
          ],
        }),
      };
    }
    if (u.includes('/issue/PROJ-10/worklog/900') && (!options.method || options.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: '900', author: { accountId: 'acc-1' } }),
      };
    }
    if (u.includes('/issue/PROJ-10/worklog/900') && options.method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ id: '900' }) };
    }
    if (u.includes('/issue/PROJ-10/worklog/900') && options.method === 'DELETE') {
      return { ok: true, status: 204, json: async () => null };
    }
    if (u.includes('/issue/PROJ-10/worklog?startAt=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          maxResults: 100,
          total: 1,
          worklogs: [
            {
              id: '900',
              author: { accountId: 'acc-1' },
              started: '2026-10-14T09:00:00.000+0100',
              timeSpentSeconds: 7200,
              timeSpent: '2h',
              comment: '[auto] Morning session',
            },
          ],
        }),
      };
    }
    if (u.includes('/issue/PROJ-10/worklog?adjustEstimate=leave') && options.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: '901' }) };
    }
    if (u.includes('/issue/PROJ-10?fields=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            timespent: 7200,
            customfield_10016: 5,
            timeoriginalestimate: 14400,
            timeestimate: 7200,
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  resetStorage({
    autoLogSafetyResetV1: true,
    statusFilterCleanupV1: true,
  });

  const cfgBefore = await sw.handleApi('/api/config/status');
  assert.equal(cfgBefore.configured, false);

  const cfgSaved = await sw.handleApi('/api/config', {
    method: 'POST',
    body: JSON.stringify({ site: 'https://demo.atlassian.net/', email: 'ricardo@example.com', apiToken: 'tok' }),
  });
  assert.equal(cfgSaved.ok, true);
  assert.equal(cfgSaved.user.accountId, 'acc-1');

  const me = await sw.handleApi('/api/me');
  assert.equal(me.accountId, 'acc-1');

  const statusFilters = await sw.handleApi('/api/status-filters?refresh=true');
  assert.ok(Array.isArray(statusFilters.statuses));

  const worklogs = await sw.handleApi('/api/worklogs?accountId=acc-1&start=2026-10-01&end=2026-10-31');
  assert.equal(worklogs.byDate['2026-10-14'].length, 1);
  assert.equal(worklogs.byDate['2026-10-14'][0].autoLogged, true);
  assert.equal(worklogs.byDate['2026-10-14'][0].comment, 'Morning session');

  const created = await sw.handleApi('/api/worklogs', {
    method: 'POST',
    body: JSON.stringify({ accountId: 'acc-1', issueKey: 'PROJ-10', date: '2026-10-14', time: '14:00', seconds: 3600, comment: 'Afternoon' }),
  });
  assert.equal(created.worklogId, '901');

  const updated = await sw.handleApi('/api/worklogs/PROJ-10/900', {
    method: 'PUT',
    body: JSON.stringify({ accountId: 'acc-1', seconds: 5400, date: '2026-10-14', time: '09:30', comment: '' }),
  });
  assert.equal(updated.ok, true);

  const deleted = await sw.handleApi('/api/worklogs/PROJ-10/900?accountId=acc-1', { method: 'DELETE' });
  assert.equal(deleted.ok, true);

  const openIssues = await sw.handleApi('/api/issues/open?accountId=acc-1&date=2026-10-14');
  assert.equal(openIssues.length, 1);

  const emptySearch = await sw.handleApi('/api/issues/search?q=a&accountId=acc-1&date=2026-10-14');
  assert.deepEqual(emptySearch, []);

  const searchRes = await sw.handleApi('/api/issues/search?q=10&accountId=acc-1&date=2026-10-14&projectKeys=PROJ');
  assert.equal(searchRes.length, 1);

  const details = await sw.handleApi('/api/issues/PROJ-10/details');
  assert.equal(details.loggedSeconds, 7200);
  assert.equal(details.storyPoints, 5);

  await sw.handleApi('/api/errors', {
    method: 'POST',
    body: JSON.stringify({ context: 'UnitTest', message: 'Test error', stack: 'stacktrace' }),
  });
  const errors = await sw.handleApi('/api/errors');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context, 'UnitTest');

  await sw.handleApi('/api/errors', { method: 'DELETE' });
  assert.deepEqual(await sw.handleApi('/api/errors'), []);

  // Holidays route (with and without country)
  fetchHandler = async (url) => {
    const u = String(url);
    if (u.includes('date.nager.at')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ date: '2026-01-01', name: 'New Year', localName: 'Ano Novo', counties: null }],
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await sw.updateSettings({ holidayCountry: 'PT' });
  const holidays = await sw.handleApi('/api/holidays?year=2026');
  assert.equal(holidays.length, 1);
  assert.equal(holidays[0].date, '2026-01-01');

  await sw.updateSettings({ holidayCountry: '' });
  assert.deepEqual(await sw.handleApi('/api/holidays?year=2026'), []);

  // Users search route (guarded by ALLOW_USER_SWITCH)
  await assert.rejects(() => sw.handleApi('/api/users/search?q=ric'), /Viewing other users is disabled/);

  // Config DELETE route
  const delCfg = await sw.handleApi('/api/config', { method: 'DELETE' });
  assert.equal(delCfg.ok, true);
  assert.equal((await sw.handleApi('/api/config/status')).configured, false);

  await assert.rejects(() => sw.handleApi('/api/unknown'), /Unknown API route/);
});

test('service-worker: runAutoLog edge cases (disabled, before 18:00, weekend, holiday, already logged, review transitions)', async () => {
  const baseState = () => ({
    autoLogSafetyResetV1: true,
    statusFilterCleanupV1: true,
    config: { site: 'demo.atlassian.net', email: 'ricardo@example.com', apiToken: 'tok' },
    me: { accountId: 'acc-1', displayName: 'Ricardo', email: 'ricardo@example.com', timeZone: 'Europe/Lisbon' },
    settings: {
      autoLogEnabled: true,
      expectedHours: 7,
      morningStart: '09:00',
      afternoonStart: '14:00',
      lastAutoLogDate: null,
      holidayCountry: '',
      holidayMode: 'exclude',
      autoLogStatusIds: ['3', '4'],
      taskListStatusIds: ['3', '4'],
    },
    oofByAccount: {},
    vacationByAccount: {},
    manualHolidays: {},
  });

  // 1. Disabled auto-log
  resetStorage({ ...baseState(), settings: { ...baseState().settings, autoLogEnabled: false } });
  let res = await sw.runAutoLog();
  assert.equal(res.outcome, 'skipped');
  assert.match(res.message, /disabled/i);

  // 2. Before 18:00 local time
  await withMockedNow(new Date(2026, 9, 14, 15, 0, 0).toISOString(), async () => {
    resetStorage(baseState());
    res = await sw.runAutoLog();
    assert.equal(res.outcome, 'skipped');
    assert.match(res.message, /Waiting until 18:00/i);
  });

  // 3. Weekend (Saturday 2026-10-17 at 18:30)
  await withMockedNow(new Date(2026, 9, 17, 18, 30, 0).toISOString(), async () => {
    resetStorage(baseState());
    res = await sw.runAutoLog();
    assert.equal(res.outcome, 'skipped');
    assert.match(res.message, /weekend/i);
  });

  // 4. Already completed for today
  await withMockedNow(new Date(2026, 9, 14, 18, 30, 0).toISOString(), async () => {
    resetStorage({ ...baseState(), settings: { ...baseState().settings, lastAutoLogDate: '2026-10-14' } });
    res = await sw.runAutoLog();
    assert.equal(res.outcome, 'skipped');
    assert.match(res.message, /already completed/i);
  });

  // 5. Excluded manual holiday
  await withMockedNow(new Date(2026, 9, 14, 18, 30, 0).toISOString(), async () => {
    resetStorage({
      ...baseState(),
      manualHolidays: { '2026-10-14': { date: '2026-10-14', name: 'Company Day', localName: 'Company Day' } },
    });
    res = await sw.runAutoLog();
    assert.equal(res.outcome, 'skipped');
    assert.match(res.message, /holiday/i);
  });

  // 6. Excluded public holiday via holidayCountry ('PT')
  await withMockedNow(new Date(2026, 0, 1, 18, 30, 0).toISOString(), async () => {
    fetchHandler = async (url) => {
      if (String(url).includes('date.nager.at')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ date: '2026-01-01', name: 'New Year', localName: 'Ano Novo', counties: null }],
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    resetStorage({
      ...baseState(),
      settings: { ...baseState().settings, holidayCountry: 'PT', holidayMode: 'exclude' },
    });
    res = await sw.runAutoLog();
    assert.equal(res.outcome, 'skipped');
    assert.match(res.message, /excluded holiday/);
  });

  // 7. Review transition minute splitting in autoPlan (1 In Progress + 1 moved to Review at 14:30)
  await withMockedNow(new Date(2026, 9, 14, 18, 30, 0).toISOString(), async () => {
    const created = [];
    fetchHandler = async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: '3', name: 'In Progress', statusCategory: { name: 'In Progress' } },
            { id: '4', name: 'In Review', statusCategory: { name: 'In Progress' } },
          ],
        };
      }
      if (u.endsWith('/field')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (u.endsWith('/search/jql')) {
        const body = JSON.parse(options.body || '{}');
        if (body.jql.includes('worklogAuthor')) {
          return { ok: true, status: 200, json: async () => ({ issues: [] }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            issues: [
              { key: 'PROJ-1', fields: { summary: 'Task 1', status: { id: '3', name: 'In Progress' }, project: { key: 'PROJ' } } },
              { key: 'PROJ-2', fields: { summary: 'Task 2', status: { id: '4', name: 'In Review' }, project: { key: 'PROJ' } } },
            ],
          }),
        };
      }
      if (u.includes('/issue/PROJ-2/changelog')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            maxResults: 100,
            total: 1,
            values: [
              {
                created: '2026-10-14T14:30:00.000+0100',
                items: [{ field: 'status', from: '3', to: '4', fromString: 'In Progress', toString: 'In Review' }],
              },
            ],
          }),
        };
      }
      if (u.includes('/worklog?adjustEstimate=leave') && options.method === 'POST') {
        created.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ id: String(created.length) }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    resetStorage(baseState());
    res = await sw.runAutoLog();
    assert.equal(res.outcome, 'success');
    assert.equal(created.length, 2);
  });
});

test('service-worker: jiraFetch retries, alternate cloudId discovery, auth errors, past/future searchIssues, alarms, and runtime listeners', async () => {
  resetStorage({
    autoLogSafetyResetV1: false,
    statusFilterCleanupV1: false,
    config: { site: 'demo.atlassian.net', email: 'ricardo@example.com', apiToken: 'tok' },
    me: { accountId: 'acc-1', displayName: 'Ricardo', email: 'ricardo@example.com', timeZone: 'Europe/Lisbon' },
    settings: {
      autoLogEnabled: true,
      expectedHours: 7,
      morningStart: '09:00',
      afternoonStart: '14:00',
      lastAutoLogDate: null,
      holidayCountry: '',
      holidayMode: 'mark',
      autoLogStatusIds: ['3'],
      taskListStatusIds: ['3'],
    },
  });

  // 1. Trigger installed & startup listeners (runs migrateAutoLogSafetyDefault)
  for (const fn of installedListeners) fn();
  for (const fn of startupListeners) fn();
  await new Promise((r) => setTimeout(r, 15));

  // 2. Test jiraFetch retry on 503 with Retry-After: 0, then 200
  let attempts = 0;
  fetchHandler = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '0' : null) },
        text: async () => 'temporarily unavailable',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ accountId: 'acc-1', displayName: 'Ricardo', emailAddress: 'ricardo@example.com', timeZone: 'UTC' }),
    };
  };
  const meAfterRetry = await sw.handleApi('/api/me');
  assert.equal(meAfterRetry.accountId, 'acc-1');
  assert.equal(attempts, 2);

  // 3. Test jiraFetch fallback to alternate cloudId endpoint when primary returns 401 and tenant_info returns cloudId
  fetchHandler = async (url) => {
    const u = String(url);
    if (u.includes('/_edge/tenant_info')) {
      return { ok: true, status: 200, json: async () => ({ cloudId: 'cloud-123' }) };
    }
    if (u.includes('api.atlassian.com/ex/jira/cloud-123')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ accountId: 'acc-1', displayName: 'Ricardo Cloud', emailAddress: 'ricardo@example.com', timeZone: 'UTC' }),
      };
    }
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: { get: () => null },
      text: async () => 'Unauthorized',
    };
  };
  const meViaCloudId = await sw.handleApi('/api/me');
  assert.equal(meViaCloudId.displayName, 'Ricardo Cloud');

  // 4. Test jiraFetch 403 -> JIRA_AUTH_REQUIRED error and 500 -> Jira API error
  fetchHandler = async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    headers: { get: () => null },
    text: async () => 'Forbidden',
  });
  await assert.rejects(
    () => sw.handleApi('/api/me'),
    (err) => err.code === 'JIRA_AUTH_REQUIRED' && err.site === 'demo.atlassian.net'
  );

  fetchHandler = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    headers: { get: () => null },
    text: async () => 'Database down',
  });
  await assert.rejects(() => sw.handleApi('/api/me'), /Jira API 500 Internal Server Error: Database down/);

  // 5. Test past date eligibility cutoff (`date < today`) and future date in searchIssues & openIssuesForUser
  await withMockedNow(new Date(2026, 9, 14, 12, 0, 0).toISOString(), async () => {
    fetchHandler = async (url) => {
      const u = String(url);
      if (u.endsWith('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: '3', name: 'In Progress', statusCategory: { name: 'In Progress' } },
            { id: '1', name: 'Done', statusCategory: { name: 'Done' } },
          ],
        };
      }
      if (u.endsWith('/search/jql')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            issues: [
              {
                key: 'PROJ-PAST',
                fields: {
                  summary: 'Historical task',
                  created: '2026-10-01T09:00:00.000+0100',
                  status: { id: '3', name: 'In Progress' },
                  assignee: { accountId: 'acc-1' },
                  project: { key: 'PROJ' },
                },
              },
            ],
          }),
        };
      }
      if (u.includes('/issue/PROJ-PAST/changelog')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            maxResults: 100,
            total: 1,
            values: [
              {
                created: '2026-10-12T10:00:00.000+0100',
                items: [{ field: 'status', from: '3', to: '3', fromString: 'In Progress', toString: 'In Progress' }],
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const pastOpen = await sw.handleApi('/api/issues/open?accountId=acc-1&date=2026-10-10');
    assert.equal(pastOpen.length, 1);
    assert.equal(pastOpen[0].key, 'PROJ-PAST');

    const pastSearch = await sw.handleApi('/api/issues/search?q=Historical&accountId=acc-1&date=2026-10-10');
    assert.equal(pastSearch.length, 1);

    const futureSearch = await sw.handleApi('/api/issues/search?q=Historical&accountId=acc-1&date=2026-10-20');
    assert.equal(futureSearch.length, 1);
  });

  // 6. Test assertWorklogOwned mismatch & readableAccount mismatch
  fetchHandler = async (url) => {
    if (String(url).endsWith('/myself')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ accountId: 'acc-1', displayName: 'Ricardo', emailAddress: 'ricardo@example.com', timeZone: 'UTC' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: '900', author: { accountId: 'someone-else' } }),
    };
  };
  await assert.rejects(
    () => sw.handleApi('/api/worklogs/PROJ-10/900?accountId=acc-1', { method: 'DELETE' }),
    /Only the author of this worklog can change it/
  );
  await assert.rejects(
    () => sw.handleApi('/api/worklogs?accountId=other-user&start=2026-10-01&end=2026-10-07'),
    /Viewing other users is disabled/
  );

  // 7. Test POST /api/settings and POST /api/status-filters via handleApi
  const settingsRes = await sw.handleApi('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ expectedHours: 8 }),
  });
  assert.equal(settingsRes.expectedHours, 8);

  const statusFilterRes = await sw.handleApi('/api/status-filters', {
    method: 'POST',
    body: JSON.stringify({ autoLogStatusIds: ['3'], taskListStatusIds: ['3'] }),
  });
  assert.deepEqual(statusFilterRes.autoLogStatusIds, ['3']);

  // 8. Test runtime.onMessage listener (success, API error, and non-api message)
  assert.ok(messageListeners.length > 0);
  const onMsg = messageListeners[0];
  assert.equal(onMsg({ type: 'other' }, {}, () => {}), false);

  const okResponse = await new Promise((resolve) => {
    const keepChannel = onMsg({ type: 'api', path: '/api/settings', options: { method: 'GET' } }, {}, resolve);
    assert.equal(keepChannel, true);
  });
  assert.equal(okResponse.ok, true);

  const errResponse = await new Promise((resolve) => {
    onMsg({ type: 'api', path: '/api/unknown-route', options: { method: 'POST' } }, {}, resolve);
  });
  assert.equal(errResponse.ok, false);
  assert.match(errResponse.error, /Unknown API route/);

  // 9. Test self error / unhandledrejection listeners and alarm listener
  for (const fn of selfListeners.error || []) fn({ error: new Error('Worker error') });
  for (const fn of selfListeners.unhandledrejection || []) fn({ reason: new Error('Unhandled promise') });
  for (const fn of alarmListeners) {
    await fn({ name: 'other-alarm' });
    await fn({ name: 'daily-auto-worklog' });
  }
});


