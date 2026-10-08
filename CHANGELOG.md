# Changelog

All notable changes to JiraLogWork are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Task filters now include a manual status synchronization action that refreshes the Jira catalogue and currently assigned active-task statuses without changing saved selections.

## [1.6.7] - 2026-10-08

### Fixed

- Jira status filters now show only statuses used by the authenticated user's assigned active tasks plus selected defaults, hide terminal or unstarted states that are incorrectly categorized as active, and consolidate sprint-generated variants under a single readable status.
- Broad site-wide selections saved by the initial status-filter implementation are automatically reset, with a manual “Reset defaults” action available in Settings.

## [1.6.6] - 2026-10-08

### Added

- Settings can now independently select the active Jira statuses used by auto-worklog and manual task suggestions; these preferences are included in export/import backups.

### Fixed

- Auto-worklog no longer selects `Verified` tasks by default, even when Jira categorizes that workflow status as In Progress.
- An outdated service worker is now reported as an incomplete extension update instead of a misleading Jira-status loading failure.

## [1.6.5] - 2026-10-07

### Fixed

- Authentication validation now retries the alternate official Jira API endpoint when `/myself` returns an ambiguous 404, and authentication errors open API credential management instead of suggesting an unrelated Jira browser login.
- The task InsertBox now resolves a manually entered full Jira key directly, or a numeric issue reference against known project keys, without changing the automatic suggestion rules.
- Edit and delete operations now revalidate the API token and rediscover the Jira API endpoint before accessing a worklog, preventing stale connection state from producing misleading issue 404 errors.
- Jira requests now always use the configured API token rather than a cached browser session, retry transient network/server failures once, and reset the selected API endpoint after connection failures.
- Empty worklog searches revalidate the Jira token connection and repeat the query once before the calendar accepts an empty period.

## [1.6.4] - 2026-10-01

### Fixed

- Switching between month and week views no longer replaces previously loaded worklogs with an empty calendar when a Jira request fails.
- Week navigation now moves the selected date together with the displayed week.
- Failed Jira task-list requests are no longer cached as empty results; the InsertBox now offers an inline retry and refreshes its short-lived cache automatically.
- Story Points discovery now supports multiple Jira fields and persists successful field IDs per site, restoring values across service-worker restarts.
- A temporary failure while loading optional Story Points metadata no longer blocks auto-log or worklog loading.
- Jira transport failures now produce a clear network message and expose the scheduled 15-minute auto-log retry in Diagnostics.

## [1.6.3] - 2026-09-25

### Added

- Settings sections are collapsed by default and remember their expanded state locally.
- Local diagnostics keep the five most recent extension errors with context and technical details.
- Settings can copy a bug report or clear the stored diagnostics.

### Fixed

- Moved the auto-worklog scheduler status into Diagnostics and fixed the clipped information icon in Settings.
- Auto-log now uses a true local 18:00 daily alarm, runs a recovery check after late browser or extension startup, and retries transient failures after 15 minutes.
- Auto-log settings display the latest check result and the reason a run was skipped.

## [1.6.2] - 2026-09-23

### Fixed

- Manual suggestions for past dates and today retain in-progress tasks that were reassigned after the user worked on them.
- Auto-log now also considers tasks assigned earlier that day and preserves the existing Review transition time cap.
- Added automatic support for both classic and scoped Atlassian API tokens without relying on the Jira browser session.
- Simplified authentication and permission error messages.
- Restored the Jira browser session as a final authentication fallback and added a direct login link when no authentication method succeeds.

## [1.6.1] - 2026-09-18

### Fixed

- Prevented tasks already in Review before the current day from receiving automatic worklogs.
- Restored compact monthly worklog rows without premature or inset page scrolling.
- Kept automatic worklog rows the same size as manual rows while preserving the robot indicator.
- Kept the daily-details dialog open after deletion and added visible deletion progress feedback.

## [1.6.0] - 2026-09-18

### Added

- Annual calendar view with compact month grids and daily worklog coverage.
- Vacation day category with annual, per-year entitlement and vacation summary.
- Manual holiday management for local or organization-specific holidays.
- Vacation and manual-holiday data in export/import backups.

### Changed

- Calendar views adapt to the available page height without page-level scrolling.
- OOF and Vacation use a compact day-category selector.
- Holiday names returned by the provider are shown directly in the calendar.
- Exported Vacation dates are grouped by account and year.

## [1.5.3] - 2026-09-17

### Added

- Chronological worklog ordering in the calendar and daily-detail view.
- Weekly view task details: start time, task key, summary and logged duration.
- Bulk OOF action that adds or clears OOF across the selected days.

### Changed

- Week view opens on the currently selected day and can hide weekends.
- Worklog creation, edits and removals preserve Jira remaining estimates.

### Fixed

- Suggested hours respect the configured expected hours per day.

## [1.5.2] - 2026-09-17

### Added

- Export and import of non-sensitive preferences alongside OOF dates.

### Fixed

- Keep the day dialog open and return to its worklog list after adding an entry.
- Keep optimistic worklogs visible while Jira indexes newly created entries.
- Improve manual start-time selection and proposed daily totals.

## [1.5.0] - 2026-09-16

### Changed

- Reorganized the source code into backend, frontend, shared logic, assets and tests.
- Added GitHub Actions to run unit tests for every pull request.

### Added

- Node built-in test runner and initial unit-test suite.

## [1.4.3] - 2026-09-16

### Fixed

- Corrected worklog timestamps by using the Jira profile time zone and daylight-saving offset instead of a fixed offset.

### Added

- Configurable morning and afternoon start times for worklog shortcuts and auto-worklog planning.
- Settings side panel for calendar, worklog, holiday, data and connection preferences.
- Extension icons and Chrome Web Store documentation.

## [1.3.1] - 2026-09-15

### Added

- Public holiday calendars by country.
- Option to exclude holidays from auto-worklog and summary calculations while retaining manual worklog entry.

## [1.2.0] - 2026-09-15

### Changed

- Historical issue suggestions now reconstruct issue status and assignment from Jira changelog data.
- Auto-worklog planning respects Review transitions and starts subsequent tasks at the transition time.

## [1.0.0] - 2026-09-01

### Added

- Initial Chrome Manifest V3 release.
- Jira worklog popup, calendar view, OOF management, bulk actions and optional auto-worklog.
