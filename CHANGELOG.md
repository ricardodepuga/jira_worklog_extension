# Changelog

All notable changes to JiraLogWork are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
