# JiraLogWork

JiraLogWork is a Chrome extension for registering Jira worklogs quickly and reviewing them in a calendar. It runs entirely in Chrome: there is no separate server, account, or database operated by the extension.

## Main features

- Quick worklog entry from the toolbar popup.
- Month and week calendar views with daily totals and issue chips.
- Create, edit and delete your own Jira worklogs.
- Task suggestions based on Jira status history for the selected date.
- Bulk worklogs and Out of Office (OOF) for multiple selected days.
- Optional automatic worklog creation at 18:00 on eligible working days.
- Public-holiday display by country, with an optional exclusion from auto-worklog and summary calculations.
- Configurable expected daily hours and morning/afternoon start times.
- Local import and export of OOF data.

## Privacy and data handling

JiraLogWork stores its configuration, Jira API token, OOF data and preferences in `chrome.storage.local`, within the current Chrome profile. They are not synced by the extension.

The extension communicates directly with the Jira Cloud site configured by the user to read issues and worklogs and to create, edit or delete worklogs requested by the user. Jira credentials are never sent to another service.

When a public-holiday country is selected, the extension requests only that country's holiday calendar from `date.nager.at`. It does not send Jira credentials, issue information, worklogs or personal data to that service.

Exported data contains OOF dates only. It never includes Jira API tokens, issues or worklogs.

## Required permissions

- `storage` — save configuration and OOF data locally.
- `alarms` — run the optional auto-worklog check.
- Jira Cloud host access — communicate with the Jira site entered by the user.
- `date.nager.at` host access — retrieve public holidays only when a country is selected.

## Configure Jira

1. Install the extension and open the calendar.
2. Enter your Jira Cloud site, Atlassian email and API token.
3. Create an API token in [Atlassian account security settings](https://id.atlassian.com/manage-profile/security/api-tokens).
4. Use the settings panel to set expected hours, working-period start times, holidays and optional auto-worklog behaviour.

Use **Jira connection** in the settings panel to replace or remove saved credentials at any time.

## Local development

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Reload the extension after code changes.

## Project structure

```
assets/icons/             Chrome extension icons
src/backend/              Manifest V3 service worker and Jira-facing API logic
src/frontend/calendar/    Calendar UI, styles and interaction controller
src/frontend/popup/       Toolbar quick-entry UI
src/shared/               Dependency-free logic shared with tests
tests/                    Node unit tests
manifest.json             Chrome extension manifest
```

The extension intentionally uses a lightweight MVC-style separation rather than a framework: the service worker is the backend/service layer, the popup and calendar are UI controllers/views, and pure domain logic is in `src/shared`. A frontend MVC framework is not justified here because the extension has two small, independent pages and no client-side routing or server-rendered application.

## Tests

The project uses Node's built-in test runner and has no test dependencies to install.

```sh
npm test
```

Tests cover time-zone conversion, daylight-saving offsets and auto-worklog planning rules.

JiraLogWork is an independent utility and is not affiliated with Atlassian.
