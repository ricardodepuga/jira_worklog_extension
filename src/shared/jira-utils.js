(function (global) {
  'use strict';

  function findStoryPointsFieldIds(fields) {
    return (Array.isArray(fields) ? fields : [])
      .filter((field) => /^customfield_\d+$/.test(field?.id || '') && /story\s*points?/i.test(field?.name || ''))
      .sort((a, b) => {
        const rank = (field) => /^story\s*points?(?:\s+estimate)?$/i.test(field?.name || '') ? 0 : 1;
        return rank(a) - rank(b);
      })
      .map((field) => field.id);
  }

  function isRetryableJiraStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
  }

  function shouldTryAlternateJiraEndpoint(status, pathname, hasCachedBase) {
    const code = Number(status);
    if (pathname === '/myself' && [401, 403, 404].includes(code)) return true;
    return code === 401 || (!hasCachedBase && code === 403);
  }

  function activeWorkflowStatuses(statuses) {
    const terminalOrUnstarted = /\b(?:to\s*do|backlog|done|closed|resolved|cancelled|canceled|rejected|declined|archived)\b/i;
    const groups = new Map();
    for (const status of Array.isArray(statuses) ? statuses : []) {
      if (!status?.id || status.statusCategory?.name !== 'In Progress') continue;
      const rawName = String(status.name || status.id).trim();
      // Some Jira instances accumulate generated workflow states such as
      // "Sprint 44 - In Progress". Treat their stable suffix as one option.
      const name = rawName.replace(/^sprint\s+\d+\s*(?:[-–—:]\s*)?/i, '').trim() || rawName;
      if (terminalOrUnstarted.test(name)) continue;
      const key = name.toLocaleLowerCase();
      const group = groups.get(key) || { id: String(status.id), ids: [], name };
      group.ids.push(String(status.id));
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function effectiveStatusIds(configuredIds, statuses, purpose) {
    const available = activeWorkflowStatuses(statuses);
    const availableIds = new Set(available.flatMap((status) => status.ids || [status.id]));
    if (Array.isArray(configuredIds)) {
      return [...new Set(configuredIds.map(String).filter((id) => availableIds.has(id)))];
    }
    // Jira's global status catalogue commonly contains hundreds of unrelated
    // workflows. Start with the small development flow the extension has
    // historically targeted; users can opt into other relevant states.
    const defaultNames = new Set(['in progress', 'review', 'in review']);
    return available
      .filter((status) => defaultNames.has(status.name.toLocaleLowerCase()))
      .flatMap((status) => status.ids || [status.id]);
  }

  function relevantWorkflowStatuses(statuses, relevantIds, selectedIds) {
    const visibleIds = new Set([...(relevantIds || []), ...(selectedIds || [])].map(String));
    return activeWorkflowStatuses(statuses).filter((status) =>
      (status.ids || [status.id]).some((id) => visibleIds.has(String(id))));
  }

  function isLegacyBroadStatusSelection(ids) {
    return Array.isArray(ids) && new Set(ids.map(String)).size > 20;
  }

  function manualIssueKeys(query, projectKeys = []) {
    const value = String(query || '').trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_]*-\d+$/.test(value)) return [value];
    if (!/^\d+$/.test(value)) return [];
    return [...new Set((Array.isArray(projectKeys) ? projectKeys : [])
      .map((key) => String(key || '').trim().toUpperCase())
      .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key)))]
      .map((key) => `${key}-${value}`);
  }

  const api = { findStoryPointsFieldIds, isRetryableJiraStatus, shouldTryAlternateJiraEndpoint, activeWorkflowStatuses, effectiveStatusIds, relevantWorkflowStatuses, isLegacyBroadStatusSelection, manualIssueKeys };
  global.JiraLogWorkJira = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
