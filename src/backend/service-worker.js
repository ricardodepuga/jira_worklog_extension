importScripts('../shared/time-utils.js', '../shared/diagnostics-utils.js', '../shared/jira-utils.js');

const { effectiveTimeZone, instantForZonedDateTime, offsetAtZonedDateTime, formatOffset, dateAndMinutesInTimeZone, shouldUseAssignmentHistory, isDatedIssueEligible, nextDailyRunTime, planAutoWorklogs } = globalThis.JiraLogWorkTime;
const { createDiagnosticEntry, keepLatestDiagnostics } = globalThis.JiraLogWorkDiagnostics;
const { findStoryPointsFieldIds, isRetryableJiraStatus, shouldTryAlternateJiraEndpoint, activeWorkflowStatuses, effectiveStatusIds, relevantWorkflowStatuses, isLegacyBroadStatusSelection, manualIssueKeys } = globalThis.JiraLogWorkJira;

const DEFAULTS = {
  config: { site: '', email: '', apiToken: '' },
  settings: { autoLogEnabled: false, expectedHours: 7, annualVacationDays: 22, annualVacationDaysByYear: {}, lastAutoLogDate: null, allowUserSwitch: false, holidayCountry: '', holidayMode: 'mark', morningStart: '09:00', afternoonStart: '14:00', autoLogStatusIds: null, taskListStatusIds: null },
  me: null,
  oofByAccount: {},
  vacationByAccount: {},
  manualHolidays: {},
  extensionErrors: [],
  autoLogStatus: null,
};

const AUTO_LOG_MARKER = '[auto]';
const AUTO_LOG_COMMENT = `${AUTO_LOG_MARKER} Auto-logged by the LogWork scheduler`;
const HALF_HOUR_SECONDS = 1800;
const AUTO_LOG_ALARM = 'auto-log-check';
const AUTO_LOG_HOUR = 18;
const AUTO_LOG_SAFETY_RESET_KEY = 'autoLogSafetyResetV1';
const STATUS_FILTER_CLEANUP_KEY = 'statusFilterCleanupV1';

// One-time safety migration for builds affected by the old settings race.
// It intentionally requires the user to opt in to auto-log again.
const safetyMigration = chrome.storage.local.get(['settings', AUTO_LOG_SAFETY_RESET_KEY]).then(async (value) => {
  if (value[AUTO_LOG_SAFETY_RESET_KEY]) return;
  await chrome.storage.local.set({
    settings: { ...DEFAULTS.settings, ...(value.settings || {}), autoLogEnabled: false, allowUserSwitch: DEFAULTS.settings.allowUserSwitch },
    [AUTO_LOG_SAFETY_RESET_KEY]: true,
  });
});

// Early builds of configurable status filters saved the entire site-wide Jira
// status catalogue when either filter changed. Clear only those unmistakably
// broad legacy selections so the new relevant-status defaults can take over.
const storageInitialization = safetyMigration.then(async () => {
  const value = await chrome.storage.local.get(['settings', STATUS_FILTER_CLEANUP_KEY]);
  if (value[STATUS_FILTER_CLEANUP_KEY]) return;
  const settings = { ...DEFAULTS.settings, ...(value.settings || {}) };
  for (const key of ['autoLogStatusIds', 'taskListStatusIds']) {
    if (isLegacyBroadStatusSelection(settings[key])) settings[key] = null;
  }
  await chrome.storage.local.set({ settings, [STATUS_FILTER_CLEANUP_KEY]: true });
});

async function stored() {
  await storageInitialization;
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
    vacationByAccount: value.vacationByAccount || {},
    manualHolidays: value.manualHolidays || {},
    extensionErrors: Array.isArray(value.extensionErrors) ? value.extensionErrors : [],
    autoLogStatus: value.autoLogStatus || null,
  };
}

let diagnosticsWriteQueue = Promise.resolve();

function recordExtensionError(error, context) {
  const operation = diagnosticsWriteQueue.then(async () => {
    const { extensionErrors = [] } = await chrome.storage.local.get('extensionErrors');
    const entry = createDiagnosticEntry(error, context);
    await chrome.storage.local.set({ extensionErrors: keepLatestDiagnostics(extensionErrors, entry) });
    return entry;
  });
  diagnosticsWriteQueue = operation.catch(() => {});
  return operation.catch((storageError) => {
    console.error('Could not persist extension diagnostic:', storageError);
    return null;
  });
}

function apiErrorContext(path, options = {}) {
  let pathname = 'unknown route';
  try { pathname = new URL(path, 'https://extension.local').pathname; } catch (_) {}
  return `API ${String(options.method || 'GET').toUpperCase()} ${pathname}`;
}

async function setAutoLogStatus(outcome, message, details = {}) {
  const autoLogStatus = {
    checkedAt: new Date().toISOString(),
    outcome,
    message,
    ...details,
  };
  await chrome.storage.local.set({ autoLogStatus });
  return autoLogStatus;
}

// Settings writes can arrive very close together (for example changing the
// expected hours and disabling auto-log). Serialize read-modify-write cycles
// so an older request can never overwrite a newer choice.
let settingsWriteQueue = Promise.resolve();

function updateSettings(patch) {
  const operation = settingsWriteQueue.then(async () => {
    await storageInitialization;
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
    if (patch.annualVacationDays !== undefined) {
      const n = Number(patch.annualVacationDays);
      if (!Number.isInteger(n) || n < 0 || n > 366) {
        throw new Error('Annual vacation entitlement must be a whole number of days.');
      }
      settings.annualVacationDays = n;
    }
    if (patch.annualVacationDaysByYear !== undefined) {
      if (!patch.annualVacationDaysByYear || typeof patch.annualVacationDaysByYear !== 'object' || Array.isArray(patch.annualVacationDaysByYear)) {
        throw new Error('Annual vacation entitlements must be organized by year.');
      }
      const normalized = {};
      for (const [year, rawDays] of Object.entries(patch.annualVacationDaysByYear)) {
        const days = Number(rawDays);
        if (!/^\d{4}$/.test(year) || !Number.isInteger(days) || days < 0 || days > 366) {
          throw new Error('Each annual vacation entitlement must use a valid year and a whole number of days.');
        }
        normalized[year] = days;
      }
      settings.annualVacationDaysByYear = normalized;
    }
    if (patch.holidayCountry !== undefined) {
      const country = String(patch.holidayCountry || '').trim().toUpperCase();
      if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('Choose a valid holiday country.');
      settings.holidayCountry = country;
    }
    if (patch.holidayMode !== undefined) {
      // "block" is accepted only as a migration from v1.3.0; manual
      // worklogs are never blocked by a holiday setting.
      if (!['mark', 'exclude', 'block'].includes(patch.holidayMode)) throw new Error('Choose a valid holiday mode.');
      settings.holidayMode = patch.holidayMode === 'block' ? 'exclude' : patch.holidayMode;
    }
    for (const key of ['autoLogStatusIds', 'taskListStatusIds']) {
      if (patch[key] === undefined) continue;
      if (patch[key] === null) {
        settings[key] = null;
        continue;
      }
      if (!Array.isArray(patch[key])) throw new Error('Jira status filters must be a list.');
      settings[key] = [...new Set(patch[key].map((id) => String(id).trim()).filter(Boolean))];
    }
    for (const key of ['morningStart', 'afternoonStart']) {
      if (patch[key] === undefined) continue;
      const time = String(patch[key]);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Working-period start times must use HH:MM.');
      settings[key] = time;
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

const jiraApiBaseBySite = new Map();
const jiraCloudIdBySite = new Map();

function directJiraApiBase(site) {
  return `https://${site}/rest/api/3`;
}

async function scopedJiraApiBase(site) {
  if (!jiraCloudIdBySite.has(site)) {
    const response = await jiraRequest(`https://${site}`, '/_edge/tenant_info', {});
    if (!response.ok) throw new Error('Could not determine the Jira Cloud ID.');
    const data = await response.json();
    if (!data.cloudId) throw new Error('The Jira site did not return a Cloud ID.');
    jiraCloudIdBySite.set(site, data.cloudId);
  }
  return `https://api.atlassian.com/ex/jira/${encodeURIComponent(jiraCloudIdBySite.get(site))}/rest/api/3`;
}

async function jiraRequest(base, pathname, options, authorization = null, credentials = 'omit') {
  let lastCause;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${base}${pathname}`, {
        ...options,
        credentials,
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
          ...(options.headers || {}),
        },
      });
      if (attempt === 0 && isRetryableJiraStatus(response.status)) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 3000) : 350));
        continue;
      }
      return response;
    } catch (cause) {
      lastCause = cause;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }
    }
  }
  const error = new Error('Could not reach Jira. Check the network connection.');
  error.code = 'JIRA_NETWORK_ERROR';
  error.cause = lastCause;
  if (lastCause?.stack || lastCause?.message) error.stack += `\nCaused by: ${lastCause.stack || lastCause.message}`;
  throw error;
}

function jiraConnectionError(site, status) {
  const error = new Error(status === 403
    ? 'Jira denied access. Update the saved API credentials.'
    : 'Could not authenticate with Jira. Update the saved email and API token.');
  error.code = 'JIRA_AUTH_REQUIRED';
  error.site = site;
  return error;
}

async function jiraFetch(pathname, options = {}) {
  const { config } = await stored();
  if (!config.site || !config.email || !config.apiToken) throw new Error('NOT_CONFIGURED');
  const directBase = directJiraApiBase(config.site);
  const cachedBase = jiraApiBaseBySite.get(config.site);
  let activeBase = cachedBase || directBase;
  const authorization = `Basic ${btoa(`${config.email}:${config.apiToken}`)}`;
  let response;
  try {
    response = await jiraRequest(activeBase, pathname, options, authorization);
  } catch (error) {
    jiraApiBaseBySite.delete(config.site);
    throw error;
  }

  // Classic tokens use the site URL. Scoped tokens use Atlassian's API
  // gateway and the site's Cloud ID. Atlassian does not expose the token type,
  // so try the alternate official endpoint only after an authentication error.
  if (shouldTryAlternateJiraEndpoint(response.status, pathname, Boolean(cachedBase))) {
    try {
      const alternateBase = activeBase === directBase
        ? await scopedJiraApiBase(config.site)
        : directBase;
      if (alternateBase !== activeBase) {
        const alternateResponse = await jiraRequest(alternateBase, pathname, options, authorization);
        response = alternateResponse;
        activeBase = alternateBase;
      }
    } catch (error) {
      console.warn('Could not try the alternate Jira API endpoint:', error);
    }
  }

  if (response.ok) jiraApiBaseBySite.set(config.site, activeBase);
  if (!response.ok) {
    if (isRetryableJiraStatus(response.status)) jiraApiBaseBySite.delete(config.site);
    const body = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403 || (pathname === '/myself' && response.status === 404)) {
      throw jiraConnectionError(config.site, response.status);
    }
    throw new Error(`Jira API ${response.status} ${response.statusText}: ${body.slice(0, 400)}`);
  }
  return response.status === 204 ? null : response.json();
}

const holidayCache = new Map();
async function holidaysForYear(country, year) {
  if (!country) return [];
  const key = `${country}:${year}`;
  if (!holidayCache.has(key)) {
    holidayCache.set(key, fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(country)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Holiday calendar ${response.status}.`);
        const holidays = await response.json();
        // The country setting represents national public holidays; regional
        // entries from the provider must not block every user in that country.
        return holidays.filter((holiday) => holiday.global !== false);
      })
      .catch((error) => { holidayCache.delete(key); throw error; }));
  }
  return holidayCache.get(key);
}

async function excludedHolidayForDate(date) {
  const { settings, manualHolidays } = await stored();
  if (!['exclude', 'block'].includes(settings.holidayMode) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (manualHolidays[date]) return manualHolidays[date];
  if (!settings.holidayCountry) return null;
  const holidays = await holidaysForYear(settings.holidayCountry, date.slice(0, 4));
  return holidays.find((holiday) => holiday.date === date) || null;
}

async function resolveMe() {
  const data = await jiraFetch('/myself');
  const { config } = await stored();
  const me = { accountId: data.accountId, displayName: data.displayName, email: data.emailAddress || config.email, timeZone: data.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone };
  await chrome.storage.local.set({ me });
  return me;
}

async function revalidateJiraConnection() {
  const { config } = await stored();
  // Force endpoint discovery again. This mirrors the successful page-refresh
  // path and prevents a stale classic/scoped API-base choice from turning a
  // valid issue/worklog request into a misleading Jira 404.
  jiraApiBaseBySite.delete(config.site);
  return resolveMe();
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
  const storyPointsFieldIds = await optionalStoryPointsFieldIds();
  const fields = ['summary', 'project', 'timeoriginalestimate', 'timeestimate', ...storyPointsFieldIds];
  const search = async () => {
    const issues = [];
    let nextPageToken;
    do {
      const data = await jiraFetch('/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
      });
      issues.push(...(data.issues || []));
      nextPageToken = data.nextPageToken;
    } while (nextPageToken);
    return issues;
  };

  let issues = await search();
  if (!issues.length) {
    // A long-lived calendar page can outlive the service worker connection.
    // Revalidate the token owner, discard the selected API base and repeat the
    // query once before accepting an empty period as genuine.
    const { config } = await stored();
    jiraApiBaseBySite.delete(config.site);
    await jiraFetch('/myself');
    issues = await search();
  }
  return { issues, storyPointsFieldIds };
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
  const { issues, storyPointsFieldIds } = await findIssuesWithWorklogs(accountId, start, end);
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
        storyPoints: storyPointsFieldIds.map((fieldId) => issue.fields?.[fieldId]).find((value) => value !== null && value !== undefined) ?? null,
        originalEstimateSeconds: issue.fields?.timeoriginalestimate ?? null,
        remainingEstimateSeconds: issue.fields?.timeestimate ?? null,
      });
    }
  }
  for (const entries of Object.values(byDate)) {
    entries.sort((a, b) => new Date(a.started).getTime() - new Date(b.started).getTime());
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
  const { settings, me } = await stored();
  const hhmm = /^\d{2}:\d{2}$/.test(time || '') ? time : settings.morningStart;
  const timeZone = effectiveTimeZone(me?.timeZone);
  return `${date}T${hhmm}:00.000${formatOffset(offsetAtZonedDateTime(date, hhmm, timeZone))}`;
}

async function createWorklog(issueKey, date, time, seconds, comment) {
  // Do not let Jira's default worklog behavior alter the issue estimate.
  return jiraFetch(`/issue/${encodeURIComponent(issueKey)}/worklog?adjustEstimate=leave`, {
    method: 'POST',
    body: JSON.stringify({ started: await buildStarted(date, time), timeSpentSeconds: Math.round(seconds), ...(comment ? { comment: toAdfComment(comment) } : {}) }),
  });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let jiraStatusesPromise;
async function getJiraStatuses() {
  if (!jiraStatusesPromise) {
    jiraStatusesPromise = jiraFetch('/status').catch((error) => {
      jiraStatusesPromise = null;
      throw error;
    });
  }
  return jiraStatusesPromise;
}

async function statusFilter(purpose) {
  const [state, statuses] = await Promise.all([stored(), getJiraStatuses()]);
  const settingKey = purpose === 'autoLog' ? 'autoLogStatusIds' : 'taskListStatusIds';
  const ids = effectiveStatusIds(state.settings[settingKey], statuses, purpose);
  return { ids, idSet: new Set(ids), statuses: activeWorkflowStatuses(statuses) };
}

async function assignedActiveStatusIds(accountId) {
  const jql = `assignee = ${quoteJqlValue(accountId)} AND statusCategory = "In Progress" ORDER BY updated DESC`;
  const data = await jiraFetch('/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, fields: ['status'], maxResults: 100 }),
  });
  return [...new Set((data.issues || []).map((issue) => String(issue.fields?.status?.id || '')).filter(Boolean))];
}

function quoteJqlValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function fetchIssueChangelog(issueKey) {
  const histories = [];
  let startAt = 0;
  for (;;) {
    const page = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${startAt}&maxResults=100`);
    const values = page.values || page.histories || [];
    histories.push(...values);
    if (startAt + (page.maxResults || values.length) >= page.total || !values.length) break;
    startAt += page.maxResults || values.length;
  }
  return histories;
}

async function wasEligibleAtDateCutoff(issue, date, allowedStatusIds) {
  const [state, statuses, histories] = await Promise.all([
    stored(),
    getJiraStatuses(),
    fetchIssueChangelog(issue.key),
  ]);
  const cutoff = instantForZonedDateTime(date, '23:59', effectiveTimeZone(state.me?.timeZone)) + 59999;
  let statusId = issue.fields?.status?.id || null;
  let statusName = issue.fields?.status?.name || null;
  const ordered = histories.slice().sort((a, b) => new Date(b.created) - new Date(a.created));
  for (const history of ordered) {
    if (new Date(history.created).getTime() <= cutoff) continue;
    for (const item of history.items || []) {
      if (String(item.field).toLowerCase() !== 'status') continue;
      statusId = item.from || null;
      statusName = item.fromString || null;
    }
  }
  const status = statuses.find((candidate) =>
    (statusId && String(candidate.id) === String(statusId)) ||
    (!statusId && statusName && candidate.name === statusName)
  );
  return isDatedIssueEligible({
    statusId: status?.id,
    allowedStatusIds,
    // The dated JQL candidate set already guarantees this condition.
    wasAssignedOnDate: true,
  });
}

async function searchIssues(accountId, date, query = '', projectKeys = [], purpose = 'taskList') {
  const today = todayStr();
  const datedAssignment = shouldUseAssignmentHistory(date, today);
  const q = query.trim();
  const directKeys = manualIssueKeys(q, projectKeys);
  const filter = await statusFilter(purpose);
  if (!filter.ids.length) return [];
  const statusJql = `status in (${filter.ids.map(quoteJqlValue).join(', ')})`;
  let jql;
  if (directKeys.length) {
    // An explicitly entered key is a manual override of the assignment/date
    // suggestion rules. Keep the product rule that To Do and Done issues are
    // not valid worklog suggestions.
    jql = `key in (${directKeys.map(quoteJqlValue).join(', ')}) AND ${statusJql} ORDER BY updated DESC`;
  } else if (datedAssignment) {
    // Do not pre-filter dated status through JQL. The changelog/current status
    // below is the source of truth, while WAS keeps tasks reassigned that day.
    jql = `assignee WAS "${accountId}" ON "${date}" ORDER BY updated DESC`;
  } else {
    jql = `assignee = "${accountId}" AND ${statusJql} ORDER BY updated DESC`;
  }
  if (q && !directKeys.length) {
    const escaped = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const filter = /^[A-Za-z][A-Za-z0-9]+-\d*$/.test(q)
      ? `(key = "${q.toUpperCase()}" OR summary ~ "${escaped}*")`
      : `summary ~ "${escaped}*"`;
    jql = jql.replace(' ORDER BY updated DESC', ` AND ${filter} ORDER BY updated DESC`);
  }
  const data = await jiraFetch('/search/jql', { method: 'POST', body: JSON.stringify({ jql, fields: ['summary', 'status', 'project'], maxResults: 100 }) });
  const candidates = data.issues || [];
  const issues = directKeys.length || !datedAssignment
    ? candidates.filter((issue) => filter.idSet.has(String(issue.fields?.status?.id || '')))
    : date === today
      // For today, Jira already returns the current status category. Avoid a
      // changelog request per suggestion; only past dates need reconstruction.
      ? candidates.filter((issue) => isDatedIssueEligible({
        statusId: issue.fields?.status?.id,
        allowedStatusIds: filter.ids,
        wasAssignedOnDate: true,
      }))
      : (await Promise.all(candidates.map(async (issue) => ({ issue, eligible: await wasEligibleAtDateCutoff(issue, date, filter.ids) })))).filter((result) => result.eligible).map((result) => result.issue);
  return issues.map((i) => ({ key: i.key, summary: i.fields?.summary || '', status: i.fields?.status?.name || '', projectKey: i.fields?.project?.key || '' }));
}

async function inProgressIssues(accountId, date) {
  return searchIssues(accountId, date, '', [], 'autoLog');
}

const storyPointsFieldIdsBySite = new Map();
async function getStoryPointsFieldIds() {
  const { config } = await stored();
  const site = config.site;
  if (storyPointsFieldIdsBySite.has(site)) return storyPointsFieldIdsBySite.get(site);

  const { storyPointsFieldsBySite = {} } = await chrome.storage.local.get('storyPointsFieldsBySite');
  if (Array.isArray(storyPointsFieldsBySite[site]) && storyPointsFieldsBySite[site].length) {
    storyPointsFieldIdsBySite.set(site, storyPointsFieldsBySite[site]);
    return storyPointsFieldsBySite[site];
  }

  const fields = await jiraFetch('/field');
  const ids = findStoryPointsFieldIds(fields);
  storyPointsFieldIdsBySite.set(site, ids);
  if (ids.length) {
    await chrome.storage.local.set({ storyPointsFieldsBySite: { ...storyPointsFieldsBySite, [site]: ids } });
  }
  return ids;
}

async function optionalStoryPointsFieldIds() {
  try {
    return await getStoryPointsFieldIds();
  } catch (error) {
    // Story Points enrich the calendar but are not required to read, create or
    // validate worklogs. Continue without them and retry discovery later.
    console.warn('Could not load the optional Jira Story Points field:', error);
    return [];
  }
}

async function issueDetails(issueKey) {
  const storyPointsFieldIds = await optionalStoryPointsFieldIds();
  const wanted = ['timespent', 'timeoriginalestimate', 'timeestimate', ...storyPointsFieldIds];
  const issue = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}?fields=${wanted.join(',')}`);
  return {
    key: issueKey,
    loggedSeconds: issue.fields?.timespent || 0,
    storyPoints: storyPointsFieldIds.map((fieldId) => issue.fields?.[fieldId]).find((value) => value !== null && value !== undefined) ?? null,
    originalEstimateSeconds: issue.fields?.timeoriginalestimate ?? null,
    remainingEstimateSeconds: issue.fields?.timeestimate ?? null,
  };
}

async function handleApi(path, options = {}) {
  const url = new URL(path, 'https://extension.local');
  const body = options.body ? JSON.parse(options.body) : {};
  const state = await stored();
  if (url.pathname === '/api/errors' && (!options.method || options.method === 'GET')) return state.extensionErrors;
  if (url.pathname === '/api/errors' && options.method === 'DELETE') {
    await chrome.storage.local.set({ extensionErrors: [] });
    return { ok: true };
  }
  if (url.pathname === '/api/errors' && options.method === 'POST') {
    await recordExtensionError({ message: body.message, stack: body.stack }, body.context || 'Calendar');
    return { ok: true };
  }
  if (url.pathname === '/api/auto-log/status') return state.autoLogStatus;
  if (url.pathname === '/api/config/status') return { configured: Boolean(state.config.site && state.config.email && state.config.apiToken), site: state.config.site || null, email: state.config.email || null };
  if (url.pathname === '/api/config' && options.method === 'POST') {
    const candidate = { site: cleanSite(body.site), email: String(body.email || '').trim(), apiToken: String(body.apiToken || '').trim() };
    if (!candidate.site || !candidate.email || !candidate.apiToken) throw new Error('Fill in site, email and API token.');
    validateSite(candidate.site);
    const previous = state.config;
    await chrome.storage.local.set({ config: candidate, me: null });
    jiraStatusesPromise = null;
    try { return { ok: true, user: await resolveMe() }; }
    catch (error) { await chrome.storage.local.set({ config: previous, me: state.me }); throw error; }
  }
  if (url.pathname === '/api/config' && options.method === 'DELETE') {
    await chrome.storage.local.set({ config: { ...DEFAULTS.config }, me: null });
    jiraStatusesPromise = null;
    return { ok: true };
  }
  // Always validate the saved token when a popup/calendar session starts.
  // `me` remains cached for background jobs, but must not be treated as proof
  // that credentials which worked previously are still valid now.
  if (url.pathname === '/api/me') return resolveMe();
  if (url.pathname === '/api/settings' && (!options.method || options.method === 'GET')) return state.settings;
  if (url.pathname === '/api/settings' && options.method === 'POST') {
    const settings = await updateSettings(body);
    if (body.autoLogEnabled === true) await scheduleAutoLogAlarm(true);
    return { ok: true, ...settings };
  }
  if (url.pathname === '/api/status-filters') {
    if (url.searchParams.get('refresh') === 'true') jiraStatusesPromise = null;
    const statuses = await getJiraStatuses();
    const autoLogStatusIds = effectiveStatusIds(state.settings.autoLogStatusIds, statuses, 'autoLog');
    const taskListStatusIds = effectiveStatusIds(state.settings.taskListStatusIds, statuses, 'taskList');
    const relevantIds = state.me?.accountId ? await assignedActiveStatusIds(state.me.accountId) : [];
    return {
      statuses: relevantWorkflowStatuses(statuses, relevantIds, [...autoLogStatusIds, ...taskListStatusIds]),
      autoLogStatusIds,
      taskListStatusIds,
    };
  }
  if (url.pathname === '/api/holidays') {
    const country = state.settings.holidayCountry;
    const year = Number(url.searchParams.get('year'));
    if (!country || !Number.isInteger(year) || year < 1900 || year > 2100) return [];
    return holidaysForYear(country, year);
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
    await revalidateJiraConnection();
    await ownAccount(body.accountId);
    const [, issueKey, worklogId] = worklogMatch;
    await assertWorklogOwned(issueKey, worklogId);
    await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}?adjustEstimate=leave`, { method: 'PUT', body: JSON.stringify({ timeSpentSeconds: Math.round(body.seconds), ...(body.comment !== undefined ? { comment: toAdfComment(body.comment) || { type: 'doc', version: 1, content: [] } } : {}), ...(body.date && body.time ? { started: await buildStarted(body.date, body.time) } : {}) }) });
    return { ok: true };
  }
  if (worklogMatch && options.method === 'DELETE') {
    await revalidateJiraConnection();
    await ownAccount(url.searchParams.get('accountId'));
    await assertWorklogOwned(worklogMatch[1], worklogMatch[2]);
    await jiraFetch(`/issue/${encodeURIComponent(worklogMatch[1])}/worklog/${encodeURIComponent(worklogMatch[2])}?adjustEstimate=leave`, { method: 'DELETE' });
    return { ok: true };
  }
  if (url.pathname === '/api/issues/open') {
    const accountId = await readableAccount(url.searchParams.get('accountId'));
    return searchIssues(accountId, url.searchParams.get('date'));
  }
  if (url.pathname === '/api/issues/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return [];
    const accountId = await readableAccount(url.searchParams.get('accountId'));
    const projectKeys = (url.searchParams.get('projectKeys') || '').split(',').filter(Boolean);
    return searchIssues(accountId, url.searchParams.get('date'), q, projectKeys);
  }
  const detailMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/details$/);
  if (detailMatch) return issueDetails(decodeURIComponent(detailMatch[1]));
  throw new Error(`Unknown API route: ${url.pathname}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'api') return false;
  handleApi(message.path, message.options || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch(async (error) => {
      await recordExtensionError(error, apiErrorContext(message.path, message.options));
      sendResponse({ ok: false, error: error.message, code: error.code, site: error.site });
    });
  return true;
});

self.addEventListener('error', (event) => {
  void recordExtensionError(event.error || event.message, 'Service worker');
});
self.addEventListener('unhandledrejection', (event) => {
  void recordExtensionError(event.reason, 'Service worker promise');
});

async function reviewTransitionMinute(issue, date, timeZone) {
  if (!/review/i.test(issue.status)) return null;
  const histories = await fetchIssueChangelog(issue.key);
  const transitions = [];
  for (const history of histories) {
    const local = dateAndMinutesInTimeZone(history.created, timeZone);
    if (local.date !== date) continue;
    if ((history.items || []).some((item) => String(item.field).toLowerCase() === 'status' && /review/i.test(item.toString || ''))) {
      transitions.push(local.minutes);
    }
  }
  return transitions.length ? Math.min(...transitions) : null;
}

async function autoPlan(issues, hours, date, timeZone, morningStart) {
  const enriched = await Promise.all(issues.map(async (issue) => ({
    ...issue,
    isReview: /review/i.test(issue.status),
    reviewMinute: await reviewTransitionMinute(issue, date, timeZone),
  })));
  return planAutoWorklogs(enriched, hours, morningStart, HALF_HOUR_SECONDS);
}

async function runAutoLog() {
  const state = await stored();
  const date = todayStr();
  const now = new Date();
  const skip = (message) => setAutoLogStatus('skipped', message, { date });
  await setAutoLogStatus('checking', 'Checking whether auto-log should run.', { date });
  if (!state.settings.autoLogEnabled) return skip('Auto-log is disabled.');
  if (!state.me) return skip('No authenticated Jira user is available.');
  if (state.settings.lastAutoLogDate === date) return skip('Auto-log has already completed today.');
  if (now.getHours() < AUTO_LOG_HOUR) return skip(`Waiting until ${AUTO_LOG_HOUR}:00.`);
  if ([0, 6].includes(now.getDay())) return skip('Skipped because today is a weekend.');
  if ((state.oofByAccount[state.me.accountId] || []).includes(date)) return skip('Skipped because today is marked OOF.');
  if ((state.vacationByAccount[state.me.accountId] || []).includes(date)) return skip('Skipped because today is marked as Vacation.');
  if (await excludedHolidayForDate(date)) return skip('Skipped because today is an excluded holiday.');
  const existing = await getWorklogs(state.me.accountId, date, date);
  if ((existing.byDate[date] || []).length) return skip('Skipped because today already has one or more worklogs.');
  const inProgress = await inProgressIssues(state.me.accountId, date);
  const plan = await autoPlan(inProgress, state.settings.expectedHours, date, effectiveTimeZone(state.me?.timeZone), state.settings.morningStart);
  if (!plan.length) return skip('No tasks matched the configured auto-worklog statuses for today.');
  for (const item of plan) {
    // The user may disable auto-log while Jira queries are still in flight.
    // Re-check immediately before every external write.
    const latest = await stored();
    if (!latest.settings.autoLogEnabled) return skip('Stopped because auto-log was disabled while running.');
    await createWorklog(item.issueKey, date, item.time, item.seconds, AUTO_LOG_COMMENT);
  }
  await updateSettings({ lastAutoLogDate: date });
  return setAutoLogStatus('success', `Created ${plan.length} automatic worklog${plan.length === 1 ? '' : 's'}.`, { date, worklogCount: plan.length });
}

function nextAutoLogTime(recoverToday) {
  return nextDailyRunTime(new Date(), AUTO_LOG_HOUR, recoverToday);
}

async function scheduleAutoLogAlarm(recoverToday = false) {
  await chrome.alarms.create(AUTO_LOG_ALARM, { when: nextAutoLogTime(recoverToday) });
}

async function ensureAutoLogAlarm() {
  const alarm = await chrome.alarms.get(AUTO_LOG_ALARM);
  // Replace the legacy 15-minute periodic alarm with a fixed local 18:00
  // one-shot alarm. One-shot scheduling is recalculated daily so DST changes
  // do not shift the execution hour.
  if (!alarm || alarm.periodInMinutes) await scheduleAutoLogAlarm(true);
}

chrome.runtime.onInstalled.addListener(() => { void scheduleAutoLogAlarm(true); });
chrome.runtime.onStartup.addListener(() => { void scheduleAutoLogAlarm(true); });
let autoLogRunning = false;
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_LOG_ALARM || autoLogRunning) return;
  autoLogRunning = true;
  let retry = false;
  try {
    await runAutoLog();
  } catch (error) {
    retry = true;
    const message = error?.code === 'JIRA_NETWORK_ERROR'
      ? 'Could not reach Jira. Retry scheduled in 15 minutes.'
      : error?.message || 'Auto-log failed.';
    await setAutoLogStatus('error', message, { date: todayStr(), retryAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    await recordExtensionError(error, 'Auto-log alarm');
    console.error(error);
  } finally {
    autoLogRunning = false;
    if (retry) await chrome.alarms.create(AUTO_LOG_ALARM, { when: Date.now() + 15 * 60 * 1000 });
    else await scheduleAutoLogAlarm(false);
  }
});

void ensureAutoLogAlarm();
