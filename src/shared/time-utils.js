(() => {
  function effectiveTimeZone(timeZone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone }).format();
      return timeZone;
    } catch (_) {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
  }

  function zonedParts(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
  }

  function instantForZonedDateTime(date, time, timeZone) {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    let instant = desired;
    for (let i = 0; i < 2; i += 1) {
      const actual = zonedParts(instant, timeZone);
      const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
      instant = desired - (actualAsUtc - instant);
    }
    return instant;
  }

  function offsetAtZonedDateTime(date, time, timeZone) {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    return Math.round((Date.UTC(year, month - 1, day, hour, minute) - instantForZonedDateTime(date, time, timeZone)) / 60000);
  }

  function formatOffset(minutes) {
    const sign = minutes >= 0 ? '+' : '-';
    const absolute = Math.abs(minutes);
    return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}${String(absolute % 60).padStart(2, '0')}`;
  }

  function dateAndMinutesInTimeZone(iso, timeZone) {
    const value = zonedParts(new Date(iso).getTime(), timeZone);
    return { date: `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`, minutes: value.hour * 60 + value.minute };
  }

  function timeToMinutes(hhmm) {
    const match = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
    return match ? Number(match[1]) * 60 + Number(match[2]) : 9 * 60;
  }

  function minutesToTime(minutes) {
    const safe = Math.max(0, Math.min(1439, Math.round(minutes)));
    return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
  }

  function splitUnits(total, count) {
    if (!count) return [];
    const base = Math.floor(total / count);
    const remainder = total - base * count;
    return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
  }

  function shouldUseAssignmentHistory(date, today) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date || '') && date <= today;
  }

  // Dated Jira search already establishes that the issue was assigned to the
  // requested user at some point on the selected date. Reassignment later that
  // day must not hide work the user may still need to register.
  function isDatedIssueEligible({ statusCategoryName, wasAssignedOnDate }) {
    return Boolean(wasAssignedOnDate && statusCategoryName === 'In Progress');
  }

  // `issues` has { key, isReview, reviewMinute }. A review transition made on
  // the auto-log date caps work on that issue and advances the following task
  // to the exact transition time. Issues already in Review before that date
  // are not work performed on the auto-log date and must be ignored.
  function planAutoWorklogs(issues, hours, morningStart, halfHourSeconds = 1800) {
    let remainingUnits = Math.round(hours * 2);
    const eligibleIssues = issues.filter((issue) => !issue.isReview || issue.reviewMinute !== null);
    if (!eligibleIssues.length || !remainingUnits) return [];
    const reviewed = eligibleIssues.filter((issue) => issue.reviewMinute !== null).sort((a, b) => a.reviewMinute - b.reviewMinute);
    const ongoing = eligibleIssues.filter((issue) => issue.reviewMinute === null);
    const plan = [];
    let cursor = timeToMinutes(morningStart || '09:00');

    for (const issue of reviewed) {
      if (remainingUnits <= 0) break;
      const availableUnits = Math.max(0, Math.floor((issue.reviewMinute - cursor) / 30));
      const units = Math.min(availableUnits, remainingUnits);
      if (units > 0) plan.push({ issueKey: issue.key, time: minutesToTime(cursor), seconds: units * halfHourSeconds });
      remainingUnits -= units;
      cursor = Math.max(cursor, issue.reviewMinute);
    }

    splitUnits(remainingUnits, ongoing.length).forEach((units, index) => {
      if (units <= 0) return;
      plan.push({ issueKey: ongoing[index].key, time: minutesToTime(cursor), seconds: units * halfHourSeconds });
      cursor += units * 30;
    });
    return plan;
  }

  const api = { effectiveTimeZone, zonedParts, instantForZonedDateTime, offsetAtZonedDateTime, formatOffset, dateAndMinutesInTimeZone, timeToMinutes, minutesToTime, shouldUseAssignmentHistory, isDatedIssueEligible, planAutoWorklogs };
  globalThis.JiraLogWorkTime = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
