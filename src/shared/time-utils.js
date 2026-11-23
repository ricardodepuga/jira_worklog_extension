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

  function roundToHalfHour(hours) {
    return Math.round(Number(hours || 0) * 2) / 2;
  }

  function normalizeAbsencePeriod(period) {
    const value = String(period ?? 'full').trim().toLowerCase();
    if (value === 'am' || value === 'morning') return 'am';
    if (value === 'pm' || value === 'afternoon') return 'pm';
    if (value === 'full' || value === '') return 'full';
    return null;
  }

  function absenceDaysForPeriod(period) {
    if (!period || period === 'none') return 0;
    const normalized = normalizeAbsencePeriod(period);
    if (normalized === 'full') return 1;
    if (normalized === 'am' || normalized === 'pm') return 0.5;
    return 0;
  }

  function parseAbsenceEntry(entry) {
    if (!entry || Array.isArray(entry)) return null;
    if (typeof entry === 'object') {
      const date = String(entry.date || '').trim();
      const period = normalizeAbsencePeriod(entry.period);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !period) return null;
      return { date, period, days: absenceDaysForPeriod(period) };
    }
    const match = /^(\d{4}-\d{2}-\d{2})(?::(full|am|pm))?$/i.exec(String(entry).trim());
    if (!match) return null;
    const period = normalizeAbsencePeriod(match[2] || 'full');
    return { date: match[1], period, days: absenceDaysForPeriod(period) };
  }

  function formatAbsenceEntry(date, period = 'full') {
    const normalized = normalizeAbsencePeriod(period) || 'full';
    return normalized === 'full' ? date : `${date}:${normalized}`;
  }

  function absenceMapFromList(entries) {
    const map = new Map();
    for (const raw of Array.isArray(entries) ? entries : []) {
      const parsed = parseAbsenceEntry(raw);
      if (!parsed) continue;
      const existing = map.get(parsed.date);
      if (!existing || existing === parsed.period || parsed.period === 'full') {
        map.set(parsed.date, parsed.period);
      } else if ((existing === 'am' && parsed.period === 'pm') || (existing === 'pm' && parsed.period === 'am')) {
        map.set(parsed.date, 'full');
      }
    }
    return map;
  }

  function serializeAbsenceMap(map) {
    return [...map.entries()]
      .filter(([date, period]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && normalizeAbsencePeriod(period))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, period]) => formatAbsenceEntry(date, period));
  }

  function mergeAbsenceLists(currentList, importedList) {
    const map = absenceMapFromList(currentList);
    for (const [date, period] of absenceMapFromList(importedList)) {
      map.set(date, period);
    }
    return serializeAbsenceMap(map);
  }

  function absencePeriodForDate(entriesOrMap, date) {
    if (!entriesOrMap || !date) return null;
    if (entriesOrMap instanceof Map) return entriesOrMap.get(date) || null;
    return absenceMapFromList(entriesOrMap).get(date) || null;
  }

  function combinedDayAbsence(oofPeriod, vacationPeriod) {
    const oof = oofPeriod && oofPeriod !== 'none' ? normalizeAbsencePeriod(oofPeriod) : null;
    const vacation = vacationPeriod && vacationPeriod !== 'none' ? normalizeAbsencePeriod(vacationPeriod) : null;
    const am = oof === 'full' || oof === 'am' ? 'oof' : (vacation === 'full' || vacation === 'am' ? 'vacation' : 'none');
    const pm = oof === 'full' || oof === 'pm' ? 'oof' : (vacation === 'full' || vacation === 'pm' ? 'vacation' : 'none');
    const oofDays = (am === 'oof' ? 0.5 : 0) + (pm === 'oof' ? 0.5 : 0);
    const vacationDays = (am === 'vacation' ? 0.5 : 0) + (pm === 'vacation' ? 0.5 : 0);
    const totalDays = oofDays + vacationDays;
    const isFull = totalDays >= 1;
    const isHalf = totalDays === 0.5;
    const isSplit = (am === 'oof' && pm === 'vacation') || (am === 'vacation' && pm === 'oof');
    const occupiedPeriod = isFull ? 'full' : (am !== 'none' ? 'am' : (pm !== 'none' ? 'pm' : null));
    const primaryType = oofDays > 0 && vacationDays > 0 ? 'split' : (oofDays > 0 ? 'oof' : (vacationDays > 0 ? 'vacation' : null));
    const resolvedOof = oofDays === 1 ? 'full' : (am === 'oof' ? 'am' : (pm === 'oof' ? 'pm' : null));
    const resolvedVacation = vacationDays === 1 ? 'full' : (am === 'vacation' ? 'am' : (pm === 'vacation' ? 'pm' : null));
    return {
      oof: resolvedOof,
      vacation: resolvedVacation,
      oofPeriod: resolvedOof,
      vacationPeriod: resolvedVacation,
      oofDays,
      vacationDays,
      totalDays,
      hasAbsence: totalDays > 0,
      isFull,
      isHalf,
      isSplit,
      occupiedPeriod,
      primaryType,
      am,
      pm,
    };
  }

  function periodsFromDayHalves(amCategory, pmCategory) {
    const norm = (cat) => {
      const value = String(cat ?? 'none').trim().toLowerCase();
      return value === 'oof' || value === 'vacation' ? value : 'none';
    };
    const am = norm(amCategory);
    const pm = norm(pmCategory);
    const oofPeriod = am === 'oof' && pm === 'oof' ? 'full' : (am === 'oof' ? 'am' : (pm === 'oof' ? 'pm' : null));
    const vacationPeriod = am === 'vacation' && pm === 'vacation' ? 'full' : (am === 'vacation' ? 'am' : (pm === 'vacation' ? 'pm' : null));
    return { oofPeriod, vacationPeriod };
  }

  function expectedHoursForDay(expectedHours, absencePeriod) {
    const base = Number.isFinite(Number(expectedHours)) && Number(expectedHours) > 0 ? Number(expectedHours) : 7;
    const normalized = absencePeriod && absencePeriod !== 'none' ? normalizeAbsencePeriod(absencePeriod) : null;
    if (normalized === 'full') return 0;
    if (normalized === 'am' || normalized === 'pm') return Math.max(0.5, roundToHalfHour(base / 2));
    return roundToHalfHour(base);
  }

  function workStartForDay(morningStart, afternoonStart, absencePeriod) {
    const morning = /^([01]\d|2[0-3]):[0-5]\d$/.test(morningStart || '') ? morningStart : '09:00';
    const afternoon = /^([01]\d|2[0-3]):[0-5]\d$/.test(afternoonStart || '') ? afternoonStart : '14:00';
    const normalized = absencePeriod && absencePeriod !== 'none' ? normalizeAbsencePeriod(absencePeriod) : null;
    return normalized === 'am' ? afternoon : morning;
  }

  function shouldUseAssignmentHistory(date, today) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date || '') && date <= today;
  }

  // Dated Jira search already establishes that the issue was assigned to the
  // requested user at some point on the selected date. Reassignment later that
  // day must not hide work the user may still need to register.
  function isDatedIssueEligible({ statusId, allowedStatusIds, wasAssignedOnDate }) {
    return Boolean(wasAssignedOnDate && Array.isArray(allowedStatusIds) && allowedStatusIds.map(String).includes(String(statusId)));
  }

  function nextDailyRunTime(nowInput, hour, recoverToday = false) {
    const now = new Date(nowInput);
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
    if (now < target) return target.getTime();
    if (recoverToday) return now.getTime() + 1000;
    target.setDate(target.getDate() + 1);
    return target.getTime();
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

  const api = { effectiveTimeZone, zonedParts, instantForZonedDateTime, offsetAtZonedDateTime, formatOffset, dateAndMinutesInTimeZone, timeToMinutes, minutesToTime, roundToHalfHour, normalizeAbsencePeriod, absenceDaysForPeriod, parseAbsenceEntry, formatAbsenceEntry, absenceMapFromList, serializeAbsenceMap, mergeAbsenceLists, absencePeriodForDate, combinedDayAbsence, periodsFromDayHalves, expectedHoursForDay, workStartForDay, shouldUseAssignmentHistory, isDatedIssueEligible, nextDailyRunTime, planAutoWorklogs };
  globalThis.JiraLogWorkTime = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
