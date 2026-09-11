const DEFAULTS = {
  config: { site: '', email: '', apiToken: '', displayOffset: '+0300' },
  settings: { autoLogEnabled: false, expectedHours: 7, lastAutoLogDate: null, allowUserSwitch: false },
  me: null,
  oofByAccount: {},
};

const AUTO_LOG_MARKER = '[auto]';
const AUTO_LOG_COMMENT = `${AUTO_LOG_MARKER} Auto-logged by the LogWork scheduler`;
const HALF_HOUR_SECONDS = 1800;
const AUTO_LOG_SAFETY_RESET_KEY = 'autoLogSafetyResetV1';

// One-time safety migration for builds affected by the old settings race.
// It intentionally requires the user to opt in to auto-log again.
const safetyMigration = chrome.storage.local.get(['settings', AUTO_LOG_SAFETY_RESET_KEY]).then(async (value) => {
  if (value[AUTO_LOG_SAFETY_RESET_KEY]) return;
  await chrome.storage.local.set({
    settings: { ...DEFAULTS.settings, ...(value.settings || {}), autoLogEnabled: false, allowUserSwitch: DEFAULTS.settings.allowUserSwitch },
    [AUTO_LOG_SAFETY_RESET_KEY]: true,
  });
});

async function stored() {
  await safetyMigration;
  const value = await chrome.storage.local.get(DEFAULTS);
  return {
    config: { ...DEFAULTS.config, ...(value.config || {}) },
    settings: {
      ...DEFAULTS.settings,
      ...(value.settings || {}),
      // Security policy, not a user preference: a stale value in storage
      // must never override what this extension build explicitly permits.
      allowUserSwitch: DEFAULTS.settings.allowUserSwitch,
    },
    me: value.me || null,
    oofByAccount: value.oofByAccount || {},
  };
}

// Settings writes can arrive very close together (for example changing the
// expected hours and disabling auto-log). Serialize read-modify-write cycles
// so an older request can never overwrite a newer choice.
let settingsWriteQueue = Promise.resolve();

function updateSettings(patch) {
  const operation = settingsWriteQueue.then(async () => {
    const { settings: persisted = {} } = await chrome.storage.local.get('settings');
    const settings = {
      ...DEFAULTS.settings,
      ...persisted,
      allowUserSwitch: DEFAULTS.settings.allowUserSwitch,
    };
    if (patch.autoLogEnabled !== undefined) settings.autoLogEnabled = patch.autoLogEnabled === true;
    if (patch.lastAutoLogDate !== undefined) settings.lastAutoLogDate = patch.lastAutoLogDate;
    if (patch.expectedHours !== undefined) {
      const n = Number(patch.expectedHours);
      if (!Number.isFinite(n) || n <= 0 || n > 24 || Math.round(n * 2) !== n * 2) {
        throw new Error('Expected hours must be a multiple of 0.5.');
      }
      settings.expectedHours = n;
    }
    await chrome.storage.local.set({ settings });
    return settings;
  });
  settingsWriteQueue = operation.catch(() => {});
  return operation;
}

function cleanSite(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function validateSite(site) {
  if (!/^[a-z0-9-]+\.atlassian\.net$/i.test(site)) {
    throw new Error('Enter a valid Jira Cloud site, for example your-company.atlassian.net.');
  }
}

async function jiraFetch(pathname, options = {}) {
  const { config } = await stored();
  if (!config.site || !config.email || !config.apiToken) throw new Error('NOT_CONFIGURED');
  const response = await fetch(`https://${config.site}/rest/api/3${pathname}`, {
    ...options,
    headers: {
      Authorization: `Basic ${btoa(`${config.email}:${config.apiToken}`)}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Jira API ${response.status} ${response.statusText}: ${body.slice(0, 400)}`);
  }
  return response.status === 204 ? null : response.json();
}

async function resolveMe() {
  const data = await jiraFetch('/myself');
  const { config } = await stored();
  const me = { accountId: data.accountId, displayName: data.displayName, email: data.emailAddress || config.email };
  await chrome.storage.local.set({ me });
  return me;
}

function adfToText(comment) {
  if (!comment) return null;
  if (typeof comment === 'string') return comment;
  const walk = (node) => node?.type === 'text' ? (node.text || '') : Array.isArray(node?.content) ? node.content.map(walk).join('') : '';
  return walk(comment).trim() || null;
}

function toAdfComment(text) {
  return text ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } : undefined;
}

function parseAutoMarker(text) {
  if (!text) return { autoLogged: false, text };
  // Be tolerant of whitespace/casing introduced by Jira's ADF conversion,
  // and recognise the scheduler's legacy comment even if its prefix was lost.
  const marker = /^\s*\[auto\]\s*/i;
  if (marker.test(text)) return { autoLogged: true, text: text.replace(marker, '').trim() || null };
  if (/^\s*Auto-logged by the LogWork scheduler\s*$/i.test(text)) {
    return { autoLogged: true, text: null };
  }
  return { autoLogged: false, text };
}

async function findIssuesWithWorklogs(accountId, start, end) {
  const jql = `worklogAuthor = "${accountId}" AND worklogDate >= "${start}" AND worklogDate <= "${end}" ORDER BY updated DESC`;
  const issues = [];
  let nextPageToken;
  do {
    const data = await jiraFetch('/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields: ['summary', 'project'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
    });
    issues.push(...(data.issues || []));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
  return issues;
}

async function issueWorklogs(issueKey) {
  const entries = [];
  let startAt = 0;
  for (;;) {
    const data = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/worklog?startAt=${startAt}&maxResults=100`);
    entries.push(...(data.worklogs || []));
    if (startAt + data.maxResults >= data.total) break;
    startAt += data.maxResults;
  }
  return entries;
}

async function getWorklogs(accountId, start, end) {
  const issues = await findIssuesWithWorklogs(accountId, start, end);
  const byDate = {};
  for (const issue of issues) {
    const own = (await issueWorklogs(issue.key))
      .filter((w) => w.author?.accountId === accountId)
      .map((w) => ({ ...w, day: w.started.slice(0, 10) }));
    for (const worklog of own) {
      if (worklog.day < start || worklog.day > end) continue;
      const marker = parseAutoMarker(adfToText(worklog.comment));
      (byDate[worklog.day] ||= []).push({
        issueKey: issue.key,
        issueSummary: issue.fields?.summary || '',
        projectKey: issue.fields?.project?.key || '',
        seconds: worklog.timeSpentSeconds,
        timeSpent: worklog.timeSpent,
        comment: marker.text,
        autoLogged: marker.autoLogged,
        worklogId: worklog.id,
        started: worklog.started,
        taskTotalToDateSeconds: own.filter((w) => w.day <= worklog.day).reduce((sum, w) => sum + w.timeSpentSeconds, 0),
      });
    }
  }
  return { accountId, start, end, byDate };
}

async function ownAccount(accountId) {
  const { me } = await stored();
  if (!me || me.accountId !== accountId) throw new Error('Worklogs can only be changed for the token owner.');
}

async function assertWorklogOwned(issueKey, worklogId) {
  const { me } = await stored();
  if (!me) throw new Error('NOT_CONFIGURED');
  const worklog = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`);
  if (worklog.author?.accountId !== me.accountId) {
    throw new Error('Only the author of this worklog can change it.');
  }
}

async function readableAccount(accountId) {
  const state = await stored();
  const requested = accountId || state.me?.accountId;
  if (!state.me || !requested) throw new Error('NOT_CONFIGURED');
  if (requested !== state.me.accountId && !state.settings.allowUserSwitch) {
    throw new Error('Viewing other users is disabled.');
  }
  return requested;
}

async function buildStarted(date, time) {
  const { config } = await stored();
  const hhmm = /^\d{2}:\d{2}$/.test(time || '') ? time : '09:00';
  return `${date}T${hhmm}:00.000${config.displayOffset || '+0300'}`;
}

async function createWorklog(issueKey, date, time, seconds, comment) {
  return jiraFetch(`/issue/${encodeURIComponent(issueKey)}/worklog`, {
    method: 'POST',
    body: JSON.stringify({ started: await buildStarted(date, time), timeSpentSeconds: Math.round(seconds), ...(comment ? { comment: toAdfComment(comment) } : {}) }),
  });
}

const DONE = ['Done', 'Closed', 'Resolved', 'Cancelled', "Won't Do", 'Rejected'];
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function searchIssues(accountId, date) {
  const historical = /^\d{4}-\d{2}-\d{2}$/.test(date) && date < todayStr();
  const done = DONE.map((s) => `"${s}"`).join(',');
  const jql = historical
    ? `assignee WAS "${accountId}" ON "${date}" AND status WAS NOT IN (${done}) ON "${date}" ORDER BY updated DESC`
    : `assignee = "${accountId}" AND statusCategory != Done ORDER BY updated DESC`;
  const data = await jiraFetch('/search/jql', { method: 'POST', body: JSON.stringify({ jql, fields: ['summary', 'status', 'project'], maxResults: 25 }) });
  return (data.issues || []).map((i) => ({ key: i.key, summary: i.fields?.summary || '', status: i.fields?.status?.name || '', projectKey: i.fields?.project?.key || '' }));
}

async function inProgressIssues(accountId) {
  const jql = `assignee = "${accountId}" AND statusCategory = "In Progress" ORDER BY updated DESC`;
  const data = await jiraFetch('/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, fields: ['summary'], maxResults: 50 }),
  });
  return (data.issues || []).map((issue) => ({ key: issue.key, summary: issue.fields?.summary || '' }));
}

let storyPointsFieldId;
async function issueDetails(issueKey) {
  if (storyPointsFieldId === undefined) {
    const fields = await jiraFetch('/field');
    storyPointsFieldId = fields.find((f) => /story point/i.test(f.name || ''))?.id || null;
  }
  const wanted = ['timespent', ...(storyPointsFieldId ? [storyPointsFieldId] : [])];
  const issue = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}?fields=${wanted.join(',')}`);
  return { key: issueKey, loggedSeconds: issue.fields?.timespent || 0, storyPoints: storyPointsFieldId ? issue.fields?.[storyPointsFieldId] ?? null : null };
}

async function handleApi(path, options = {}) {
  const url = new URL(path, 'https://extension.local');
  const body = options.body ? JSON.parse(options.body) : {};
  const state = await stored();
  if (url.pathname === '/api/config/status') return { configured: Boolean(state.config.site && state.config.email && state.config.apiToken), site: state.config.site || null, email: state.config.email || null };
  if (url.pathname === '/api/config' && options.method === 'POST') {
    const candidate = { site: cleanSite(body.site), email: String(body.email || '').trim(), apiToken: String(body.apiToken || '').trim(), displayOffset: body.displayOffset || state.config.displayOffset };
    if (!candidate.site || !candidate.email || !candidate.apiToken) throw new Error('Fill in site, email and API token.');
    validateSite(candidate.site);
    const previous = state.config;
    await chrome.storage.local.set({ config: candidate, me: null });
    try { return { ok: true, user: await resolveMe() }; }
    catch (error) { await chrome.storage.local.set({ config: previous, me: state.me }); throw error; }
  }
  if (url.pathname === '/api/config' && options.method === 'DELETE') {
    await chrome.storage.local.set({ config: { ...DEFAULTS.config }, me: null });
    return { ok: true };
  }
  if (url.pathname === '/api/me') return state.me || resolveMe();
  if (url.pathname === '/api/settings' && (!options.method || options.method === 'GET')) return state.settings;
  if (url.pathname === '/api/settings' && options.method === 'POST') {
    const settings = await updateSettings(body);
    return { ok: true, ...settings };
  }
  if (url.pathname === '/api/users/search') {
    if (!state.settings.allowUserSwitch) throw new Error('Viewing other users is disabled.');
    const q = url.searchParams.get('q') || '';
    if (q.length < 2) return [];
    const users = await jiraFetch(`/user/search?query=${encodeURIComponent(q)}&maxResults=10`);
    return users.filter((u) => u.accountType === 'atlassian').map((u) => ({ accountId: u.accountId, displayName: u.displayName, email: u.emailAddress || null, avatarUrl: u.avatarUrls?.['24x24'] || null }));
  }
  if (url.pathname === '/api/worklogs' && (!options.method || options.method === 'GET')) {
    const accountId = await readableAccount(url.searchParams.get('accountId'));
    return getWorklogs(accountId, url.searchParams.get('start'), url.searchParams.get('end'));
  }
  if (url.pathname === '/api/worklogs' && options.method === 'POST') {
    await ownAccount(body.accountId);
    const made = await createWorklog(body.issueKey, body.date, body.time, body.seconds, body.comment);
    return { ok: true, worklogId: made.id };
  }
  const worklogMatch = url.pathname.match(/^\/api\/worklogs\/([^/]+)\/([^/]+)$/);
  if (worklogMatch && options.method === 'PUT') {
    await ownAccount(body.accountId);
    const [, issueKey, worklogId] = worklogMatch;
    await assertWorklogOwned(issueKey, worklogId);
    await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`, { method: 'PUT', body: JSON.stringify({ timeSpentSeconds: Math.round(body.seconds), ...(body.comment !== undefined ? { comment: toAdfComment(body.comment) || { type: 'doc', version: 1, content: [] } } : {}), ...(body.date && body.time ? { started: await buildStarted(body.date, body.time) } : {}) }) });
    return { ok: true };
  }
  if (worklogMatch && options.method === 'DELETE') {
    await ownAccount(url.searchParams.get('accountId'));
    await assertWorklogOwned(worklogMatch[1], worklogMatch[2]);
    await jiraFetch(`/issue/${encodeURIComponent(worklogMatch[1])}/worklog/${encodeURIComponent(worklogMatch[2])}`, { method: 'DELETE' });
    return { ok: true };
  }
  if (url.pathname === '/api/issues/open') {
    const accountId = await readableAccount(url.searchParams.get('accountId'));
    return searchIssues(accountId, url.searchParams.get('date'));
  }
  if (url.pathname === '/api/issues/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return [];
    const escaped = q.replace(/"/g, '\\"');
    const jql = /^[A-Za-z][A-Za-z0-9]+-\d*$/.test(q) ? `key = "${q.toUpperCase()}" OR summary ~ "${escaped}*" ORDER BY updated DESC` : `summary ~ "${escaped}*" ORDER BY updated DESC`;
    const data = await jiraFetch('/search/jql', { method: 'POST', body: JSON.stringify({ jql, fields: ['summary', 'status', 'project'], maxResults: 15 }) });
    return (data.issues || []).map((i) => ({ key: i.key, summary: i.fields?.summary || '', status: i.fields?.status?.name || '', projectKey: i.fields?.project?.key || '' }));
  }
  const detailMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/details$/);
  if (detailMatch) return issueDetails(decodeURIComponent(detailMatch[1]));
  throw new Error(`Unknown API route: ${url.pathname}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'api') return false;
  handleApi(message.path, message.options || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

function splitUnits(total, count) {
  if (!count) return [];
  const base = Math.floor(total / count), remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

function autoPlan(issues, hours) {
  const units = Math.round(hours * 2);
  if (!issues.length || !units) return [];
  if (issues.length === 1) return [{ issueKey: issues[0].key, time: '09:00', seconds: units * HALF_HOUR_SECONDS }];
  const morningCount = Math.ceil(issues.length / 2);
  const [amTotal, pmTotal] = splitUnits(units, 2);
  return [
    ...splitUnits(amTotal, morningCount).map((u, i) => ({ issueKey: issues[i].key, time: '09:00', seconds: u * HALF_HOUR_SECONDS })),
    ...splitUnits(pmTotal, issues.length - morningCount).map((u, i) => ({ issueKey: issues[morningCount + i].key, time: '14:00', seconds: u * HALF_HOUR_SECONDS })),
  ].filter((x) => x.seconds > 0);
}

async function runAutoLog() {
  const state = await stored();
  const date = todayStr();
  const now = new Date();
  if (!state.settings.autoLogEnabled || !state.me || state.settings.lastAutoLogDate === date || now.getHours() < 18 || [0, 6].includes(now.getDay())) return;
  if ((state.oofByAccount[state.me.accountId] || []).includes(date)) return;
  const existing = await getWorklogs(state.me.accountId, date, date);
  if ((existing.byDate[date] || []).length) return;
  const inProgress = await inProgressIssues(state.me.accountId);
  const plan = autoPlan(inProgress, state.settings.expectedHours);
  for (const item of plan) {
    // The user may disable auto-log while Jira queries are still in flight.
    // Re-check immediately before every external write.
    const latest = await stored();
    if (!latest.settings.autoLogEnabled) return;
    await createWorklog(item.issueKey, date, item.time, item.seconds, AUTO_LOG_COMMENT);
  }
  if (plan.length) await updateSettings({ lastAutoLogDate: date });
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('auto-log-check', { periodInMinutes: 15 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('auto-log-check', { periodInMinutes: 15 }));
let autoLogRunning = false;
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'auto-log-check' || autoLogRunning) return;
  autoLogRunning = true;
  try {
    await runAutoLog();
  } catch (error) {
    console.error(error);
  } finally {
    autoLogRunning = false;
  }
});
