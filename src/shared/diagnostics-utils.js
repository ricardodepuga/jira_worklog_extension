(function (global) {
  'use strict';

  function cleanText(value, maxLength) {
    return String(value || '').replace(/\s+$/g, '').slice(0, maxLength);
  }

  function createDiagnosticEntry(error, context, timestamp = new Date().toISOString(), id = null) {
    const source = error instanceof Error
      ? error
      : { message: error?.message || String(error || 'Unknown error'), stack: error?.stack || '' };
    return {
      id: id || `${timestamp}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp,
      context: cleanText(context || 'Extension', 120),
      message: cleanText(source.message || source.name || 'Unknown error', 600),
      stack: cleanText(source.stack || '', 2000),
    };
  }

  function keepLatestDiagnostics(entries, entry, limit = 5) {
    const existing = Array.isArray(entries) ? entries : [];
    return [...existing, entry].slice(-Math.max(1, limit));
  }

  const api = { createDiagnosticEntry, keepLatestDiagnostics };
  global.JiraLogWorkDiagnostics = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
