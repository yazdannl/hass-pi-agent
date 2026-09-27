# Pi Agent for Home Assistant

[![Build](https://github.com/yazdannl/hass-pi-agent/actions/workflows/build.yaml/badge.svg)](https://github.com/yazdannl/hass-pi-agent/actions/workflows/build.yaml)

An AI agent with full access to your Home Assistant — manage automations, entities, dashboards, helpers, and more through a chat panel, in plain language.

Powered by [Pi](https://github.com/earendil-works/pi), an open-source coding agent, embedded in-process and served as a native web chat over the add-on's Ingress.

## Installation

### 1. Add the repository

1. Open Home Assistant.
2. Go to **Settings → Add-ons → Add-on Store**.
3. Click the **⋮** menu (top right) → **Repositories**.
4. Add this URL:
   ```
   https://github.com/yazdannl/hass-pi-agent
   ```
5. Click **Add → Close**.

> If you previously added `https://github.com/dkmaker/hass-pi-agent`, remove it and add this fork instead; both repositories define the same add-on slug.
>
> The repository uses prebuilt images from this fork's GitHub Container Registry. Before installing after a code change, run **Actions → Build and Publish Add-on** on `main` and make the resulting GHCR packages public.

### 2. Install and start

1. Find **Pi Agent for Home Assistant** in the add-on store (refresh if needed).
2. Click **Install**, then **Start**.

> **Beta channel (optional).** The same repository also lists **Pi Agent for Home Assistant (Beta)** — pre-release builds for testing new features early. Install that tile instead of (or alongside) the stable one to follow the beta channel. Its configuration is independent. If you're not actively testing, stick with the stable add-on.

### 3. Configure in the panel

1. Open **Pi Agent** from the sidebar (or **Open Web UI** on the add-on's Info tab).
2. The **welcome screen** asks you to choose a provider and model. Enter an API key, use GitHub Copilot's browser device sign-in, or configure a custom OpenAI-compatible endpoint. Pi tests the connection before saving.
3. Start chatting. Use the **⚙️ settings** button in the top bar to change the provider, model, or key later.

There are no API-key fields on the add-on's Configuration tab. Built-in provider selections and API keys are saved in add-on options; Copilot OAuth credentials and custom endpoint settings (including its optional API key) are stored in Pi's private, persistent engine directory. Setup survives restarts and updates.

## Configuration

### Provider & model

Set up entirely in the panel. The setup lists Pi's single-key providers and their model catalogs, including OpenCode Zen and OpenCode Go. GitHub Copilot uses Pi's native OAuth device sign-in. A **Custom OpenAI-compatible endpoint** option accepts a base URL, model ID, and optional API key and uses Pi's native `models.json` configuration. Other multi-credential providers (such as Amazon Bedrock, Google Vertex, and Azure OpenAI) are not included in this focused flow.

### Other add-on options

| Option | What it does |
|--------|--------------|
| **Install Conversation Integration** | Installs the Pi Agent integration so automations and Assist can call the `pi_agent.ask` service (on by default). |
| **Additional Packages** | Extra Alpine Linux packages to install at startup (e.g. `jq`, `imagemagick`). |
| **Write Guard** | Filesystem write protection: `strict` (default), `warn`, or `off`. |
| **Write Guard Allowlist** | Extra paths (globs, relative to `/homeassistant`) the agent may write to. |

## What can it do?

Pi Agent has full access to your Home Assistant instance:

- **Automations** — create, edit, debug, and manage automations.
- **Entities & Devices** — inspect states, rename, organize into areas.
- **Dashboards** — build and modify Lovelace dashboards and cards.
- **Services** — discover and call any Home Assistant service.
- **Helpers** — create input booleans, counters, timers, templates, and more.
- **Areas & Labels** — organize your smart home.
- **Add-ons** — manage installed add-ons.
- **Templates** — render and test Jinja2 templates.
- **Backups** — create and manage backups.
- **System** — view system info, restart, and reload configuration.

The chat panel follows your Home Assistant theme and interface language (English, Danish, Norwegian, Swedish, German), renders tool results as rich clickable tables, and supports `/new`, `/sessions`, and `/setup` slash commands.

## Supported architectures

- `amd64`
- `aarch64`

## License

MIT
