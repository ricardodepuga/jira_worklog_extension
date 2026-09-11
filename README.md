# JiraLogWork Chrome Extension

Standalone Manifest V3 version of JiraLogWork. It talks directly to Jira; no Node.js server is required.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Pin JiraLogWork to the toolbar.
5. Open the calendar and enter the Jira site, email and API token.

Clicking the toolbar icon opens today's quick-entry popup. **Calendar ↗** opens the complete calendar in a browser tab.

Credentials and settings are stored in `chrome.storage.local` for this Chrome profile and are not synced.

Use **Jira Connection** in the full calendar to replace or remove saved credentials. Export Data includes OOF dates only; it never includes the API token, Jira issues, or worklogs.
