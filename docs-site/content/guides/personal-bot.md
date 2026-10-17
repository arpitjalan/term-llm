---
title: "Personal Bot"
weight: 8
description: "Run the assistant-focused browser experience for an internal demo."
kicker: "Assistant workspace"
---

Personal Bot is an alternative browser interface for term-llm. It brings
conversations, ongoing work, and routines into one assistant-focused workspace,
using the existing conversation and jobs runtimes. The Hub can also create and
manage separate container assistants or connect existing assistants from the
browser. This version is intended for an internal demo operated by one trusted
team.

## Set up an assistant on this computer

After first-time interactive provider setup in chat or ask, term-llm offers an
optional native assistant. Answer **no** (the default) to continue without
installing a service, or set it up later:

```bash
term-llm personal-bot setup
```

On macOS and Linux, setup creates the `personal` agent and installs the existing
Web service with the Personal Bot interface and Jobs platform. The Web UI and
scheduled routines run together under the operating system's service manager.
Docker is not required. Plain binary installation does not create an assistant
or start a service; the separate optional
[server setup](/guides/server-deployment/#optional-setup-on-a-fresh-server)
explicitly provisions a public Hub.

The default working folder is
`${XDG_DATA_HOME:-$HOME/.local/share}/term-llm/personal-bot/workspace`. Choose
another folder or initial instructions when first setting it up:

```bash
term-llm personal-bot setup --workspace "$HOME/assistant" \
  --purpose "Help organize my documents and ongoing work."
# Save the setup without starting it yet.
term-llm personal-bot setup --no-start
```

The default browser port is `8080`; use `--port` during initial setup if it is
already in use. The listener stays on loopback.

This assistant uses the account's provider configuration, conversations, jobs,
and memory. Its working folder does not isolate it from the host account. Setup
privately imports any required provider API keys from the current environment;
existing OAuth credential stores remain authoritative.

Setup completes any required subscription sign-in in the terminal before
starting the service. `--no-start` also skips sign-in: complete it before using
`service start web`, or rerun setup without `--no-start` to sign in and start.

Setup saves a stable bearer token through the existing service credential
store. Rerunning preserves the agent, working folder, port, and token; it refuses
to replace an unrelated Web service. Use the normal service commands afterward:

```bash
term-llm service status web
term-llm service start web
term-llm service stop web
term-llm service logs web
term-llm service token web
```

The last command explicitly reveals the token for browser sign-in or
[connecting the assistant to a Hub](#connect-an-existing-assistant). Setup does
not register it with a Hub automatically. See
[background services](/guides/background-services/) for login, autostart, and
remote-access behavior. Hub **Create assistant** continues to use Docker.

## Set up container assistants from the browser

For a persistent installation on macOS or Linux, use the
[background service](#keep-the-hub-running-as-a-service) below. For a DigitalOcean
Droplet or another Linux server, follow the
[server deployment guide](/guides/server-deployment/)
for optional automated HTTPS setup or a source deployment, keeping the Hub
running after logout or reboot. To run the management interface manually, install
Docker Engine with Docker Compose v2, start Docker, and run:

```bash
term-llm serve hub --personal-bot
```

The Hub prepares the Linux runtime automatically. On Linux, it reuses the
running server executable. On macOS and Windows, it builds the matching runtime
inside Docker from source bundled with the server, using the Docker engine's
CPU architecture. An installed release does not need Go or a source checkout on
the host. The first start needs internet access to download the container images
and build dependencies; later starts reuse the prepared runtime image.

The Hub root shows **Your agents**. Its **Hub dashboard** navigation link opens
the regular multi-node dashboard at `<hub-mount>/dashboard/` (for example,
`/hub/dashboard/` when the Hub is mounted at `/hub`). Use **Your agents** there
to return to the manager. Both views share the existing Hub login and agent
connections; see [Hub dashboards](/guides/hub/#dashboard-and-personal-bot-manager).

No model provider, local agent, or existing container is required to start the
Hub. Open the address it prints and use the Hub access token to sign in. For a
remote server, use a domain with HTTPS and the Hub's existing
[bearer or passkey authentication](/guides/hub/). Keep the Hub process running
under a service supervisor so management remains available after disconnecting
from the server.

In the browser:

1. Choose **Create assistant**, give it a name, and describe its purpose. The
   purpose becomes the assistant's instructions.
2. Connect OpenAI or Anthropic with an API key, or choose a ChatGPT connection:
   **Use existing connection**, **Import saved sign-in**, or **Connect new account**.
   A new ChatGPT sign-in uses a device code in another browser tab and becomes
   reusable by other assistants. Saved API keys are explicitly
   marked unverified; a working web interface does not prove model access or
   billing is enabled.
3. Choose **Start assistant**. The first start builds the runtime image and can
   take several minutes. You can leave the page and return while it starts.
4. Once the assistant is ready, click its card to open it. Use **Your agents**
   to return to the management page. **Manage** opens its configuration.

**Create assistant** uses Docker by default. Each new assistant is a managed
contain workspace with its own persistent data, selected provider connection,
generated web token, and automatically selected loopback port. Hub discovers it
through the same contain resolver as existing workspaces
and proxies its UI without giving the browser its web token. Existing contain
agents also appear; they can be opened without converting their configuration.

The page offers start, stop, and restart for assistants it created. Stopping an
assistant preserves its data and pauses its scheduled work. The MVP does not
offer destructive deletion or arbitrary container settings. Provider connections
can be changed while an assistant is stopped.

## Connect an existing assistant

In **Your agents**, choose **Connect an existing assistant** to add a running
`term-llm serve` assistant or an existing deployment. Enter its name, web URL
including its mount path (for example, `http://127.0.0.1:8080/ui/`), and bearer
token. Use **Test connection** to check access before saving.

The URL must be reachable from the Hub server. `127.0.0.1` refers to the Hub's
computer; it does not refer to the laptop running your browser. For a private
assistant behind a firewall or NAT, use the existing
[Hub reverse connection](/guides/hub/#nodes) flow.

The Hub saves the connection and its bearer token in its private node store and
supplies the token to the assistant server-side. It does not return the saved
token to the browser. Use a stable token supplied through
`TERM_LLM_SERVE_TOKEN`; an automatically generated token changes when a directly
started server restarts. For an existing managed bearer Web service,
`term-llm service token web` explicitly reveals its saved token.

Connected assistants appear in **Your agents**, alongside managed Docker
assistants. Existing nodes from the Hub dashboard, static configuration, and
reverse connections appear there too. Open their cards to use them. Start,
stop, restart, provider setup, and updates remain the responsibility of the
existing deployment; the Hub's Docker management controls apply to assistants
created through **Create assistant**.

A native assistant runs under the account and on the computer where its
`serve` process runs. It can use that computer's permitted files and installed
tools. Use `serve web jobs --personal-bot` for the Personal Bot interface with
routines, as shown [below](#start-a-single-personal-bot-directly). Connecting an
assistant does not change its interface, provider credentials, storage, or
permissions.

## Keep the Hub running as a service

For local browser use on macOS or Linux with Docker running, install the managed
Hub:

```bash
term-llm service install hub -- --personal-bot
# After enrolling your passkey, reopen it with:
term-llm service open hub
```

Installation offers to open a one-time passkey setup link. After enrollment,
bookmark `http://localhost:8090/hub/`: the service starts at login, and subsequent
visits use the existing browser session or passkey. There is no bearer token to
copy for Hub sign-in. The native Web/Jobs assistant above still uses its stable
bearer token and is connected to a Hub explicitly.

On macOS, Docker prepares the Linux assistant runtime automatically when the
server includes bundled source. `make build` includes that source; no separate
runtime build is needed for this path.

To install a build from this checkout, with Docker running:

```bash
make build
./term-llm service install hub -- --personal-bot
```

The build includes the frontend and the source needed to prepare a Linux runtime
automatically. Installation records the server arguments and account environment
so later starts use the same workspace. Follow the printed browser URL and
passkey setup instructions.

This source-build example saves the checkout's server executable path. Keep that
binary in place, or install using a durable executable path.
`term-llm service status hub` shows which executable the service uses. The
[server deployment guide](/guides/server-deployment/)
also covers using an installed Linux executable directly as the runtime and
upgrading existing Docker assistants.

Use these commands thereafter:

```bash
./term-llm service start hub
./term-llm service status hub
./term-llm service open hub
./term-llm service stop hub
```

Stopping the Hub service does not stop its Docker assistants. Start Docker
Desktop or the Docker service before starting or managing assistants. See
[background services](/guides/background-services/) for autostart, authentication,
logs, and remote access.

### Keep the same saved workspace

Assistant definitions and shared provider connections belong to the Hub account's
configuration directory: `${XDG_CONFIG_HOME:-$HOME/.config}/term-llm`. The Hub's
node database belongs to its data directory:
`${XDG_DATA_HOME:-$HOME/.local/share}/term-llm`. Each assistant's conversations and
files live in its persistent Docker volumes.

Use the same configuration and data locations when returning to an existing Hub.
Changing `XDG_CONFIG_HOME` can show an empty assistant list even while the original
Docker assistants and their saved conversations still exist. Changing a port does
not select or recover a workspace. Do not keep a real Hub's account state in a
checkout's `tmp` directory, and do not copy or merge provider connection files to
repair an empty list.

`serve hub --config` selects a **static node list**, not the assistant storage
directory. To investigate missing assistants, check the storage paths in the Hub
startup output and compare them with the existing installation. For a managed
service, inspect:

```bash
./term-llm service status hub
./term-llm service logs hub
```

### Apply a new build

```bash
make build
./term-llm service restart hub
```

These commands update a service installed with this checkout's server. If
`term-llm service status hub` lists a different server
executable, update that executable before restarting the service.

Wait for active assistant work to finish. For each assistant, choose **Stop** and
then **Start** in **Manage** to apply the updated runtime. **Restart** restarts its
current container image. Stopping and starting preserves its saved conversations
and files.

## Choose an appearance

Choose **Theme** in the assistant manager, or open an assistant's
**Settings → Interface → Theme**. Six presets are available: **Sage Light**,
**Sage Dark**, **Catppuccin Mocha**, **Dracula**, **Nord**, and **Tokyo Night**.
**System** follows your device's light or dark appearance using the Sage palette.

The same palette covers the sidebar, conversation, composer, settings, and
assistant manager. Your choice is saved in this browser and shared across
assistants on the same server address; it does not change anyone else's theme.

## Reuse a ChatGPT connection

Sign in once, then choose **Use existing connection** when setting up another
assistant. Each assistant keeps its own instructions, conversations, files, and
model selection. Shared connections currently support ChatGPT; OpenAI and
Anthropic API keys remain per-assistant.

**Import saved sign-in** offers the server's saved term-llm ChatGPT login and
existing contain assistants in the current configuration. Importing keeps the
original credential store as the authority. It does not copy its refresh token
to other assistants or sign the original agent out. Container imports support
the standard named home volume mounted at `/home/agent` with the `agent` user.
The original container may be stopped; its home volume must still exist.
Changing a managed assistant's provider preserves its saved ChatGPT sign-in, so
other assistants that imported that sign-in can continue using it. Changing
providers does not sign out the original account.

The Hub manages a private connection catalog and an authenticated HTTPS session
broker. Workers receive short-lived access tokens only. Refreshes use the
original store's term-llm file locks, including when a temporary helper accesses
an imported container's home volume. Keep source runtimes updated so they use
the same refresh-lock protocol. Removing the original sign-in, signing it out,
or deleting its volume makes connections that depend on it unavailable.

The Hub must stay running for shared connections to issue or renew sessions.
The broker keeps its port and certificate across restarts under
`<config-dir>/personal-bot-connections`. Workers reach it through
`host.docker.internal`; Linux Compose adds the host-gateway mapping. Allow this
private port from the Docker network in the host firewall; it does not need to
be exposed through your public reverse proxy or allowed from the internet.
Workers pin the broker certificate and authenticate with separate scoped
credentials. Back up the connection catalog and TLS files with the Hub's other
private configuration. Custom runtime images must include this checkout's
shared-connection support and the `auth chatgpt-session` helper.

The managed runtime runs `serve web jobs --personal-bot` together. The automatic
runtime uses the Hub's executable on Linux or its bundled source on other host
operating systems, so it includes the same server features and frontend.

Administrators can override automatic preparation with
`--personal-bot-binary /absolute/path/to/term-llm-linux` or supply a compatible
prebuilt runtime with `--personal-bot-image`. The explicit binary must be a Linux
amd64 or arm64 executable; the Hub selects its container platform automatically.
For a source checkout, `make personal-bot-runtime` remains available to prepare
this optional override. These are
server startup options; browser users cannot choose images, host paths, or
commands. A prebuilt image must provide `/usr/local/bin/term-llm`, an `agent`
user with UID 1000, `gosu`, `/bin/sh`, and the usual shell file utilities. Use
the bundled `internal/contain/personal-bot/Dockerfile` as the image contract.

ChatGPT device sign-in depends on device authorization being available for the
account. If it is unavailable, use a supported API key connection. Anthropic API
keys and a Claude subscription are different credentials; this interface does
not sign in to Claude Code.

## Start a single Personal Bot directly

Build this checkout and [configure a provider](/getting-started/providers-and-setup/)
on the server, then start the web and jobs runtimes together:

```bash
make build
./term-llm serve web jobs --personal-bot
```

Open the URL printed by the server and follow its authentication instructions.
The usual browser path is `/ui/`. The `--personal-bot` flag selects this interface;
omitting it opens the existing web workspace. The flag requires the `web` platform.

The browser and background work share the server's configured provider and stored
data. Colleagues do not need to install term-llm or configure their own provider
credentials. The server process must remain running for work to continue when a
browser closes.

## Use the workspace

- **Home:** start a conversation, give the assistant instructions, and return to
  saved conversations. Messages and results use the existing streamed transcript.
- **All conversations:** browse and search saved conversations, including older
  work that is no longer in the recent list.
- **Activity:** review work and open the conversation associated with a result or
  a request for input.
- **Routines:** define repeatable instructions, choose a schedule, run them manually,
  and pause or resume scheduled work. Routines require the `jobs` runtime.
- **Widgets:** open the local web applications you created, see their status, and
  stop running widgets. Use **Refresh widgets** after adding or changing a widget
  manifest. Widgets open in the current tab; the browser's Back button returns to
  the assistant. See [Web UI widgets](/guides/widgets/) for setup and storage.

Keep the first demonstration focused on one complete workflow: send a request,
return to its saved result, then create and run a simple routine. A routine's
workspace and assistant must be available on the server. Headless jobs retain the
existing workspace permission rules; selecting a directory does not grant file
access. Before scheduling file-based work, confirm and remember the workspace in
an interactive conversation. See the [job runner guide](/guides/job-runner/) for
those requirements.

## Run the browser smoke test

The dedicated smoke starts a real local server using the deterministic debug
provider. It needs no model account or API key and isolates its configuration,
workspace, and databases under the repository's ignored `tmp/` directory.

```bash
make frontend-deps
scripts/personal_bot_smoke.sh
```

The smoke builds the frontend and server, then checks desktop and mobile browser
flows. To test a binary already built from this checkout without rebuilding:

```bash
TERM_LLM_SMOKE_BINARY=./term-llm scripts/personal_bot_smoke.sh
```

Screenshots and failure traces remain under the printed `tmp/personal-bot-smoke.*`
results directory. The temporary server stops and its isolated home and workspace
are removed after the run. Chrome on macOS or Chromium on `PATH` can be used without
downloading another browser; `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects an explicit
browser executable.

## Internal deployment

For the container setup, run the Hub as a supervised service behind a domain with
HTTPS. Use a stable Hub bearer token through `TERM_LLM_HUB_TOKEN`, or configure
Hub passkeys. Docker restarts running assistants automatically, while their
volumes retain conversations and jobs. Back up both the contain definitions and
the volumes; definitions include private credentials.

For the direct single-assistant setup, use bearer authentication with a stable
token supplied through `TERM_LLM_SERVE_TOKEN`; the combined
`serve web jobs` runtime does not support direct `--auth passkey`. A
[Hub with passkey authentication](/guides/hub/) can front a combined bearer node
when passkey sign-in is needed. See the existing
[authentication documentation](/guides/web-ui-and-api/#authentication) for the
setup details. `--no-auth` is only supported on a loopback listener for local
development.

This version shares operator access to assistants, conversations, routines, and
permissions. Separate containers provide separate workspaces, not individual
employee accounts or tenant isolation. Docker installation, server updates,
backups, and disaster recovery remain administrator tasks.

## Test browser provisioning

With Docker available, the management smoke starts a Hub with an empty isolated
configuration, creates assistants through the browser, checks provider setup and
container lifecycle, and opens the proxied Personal Bot UI:

```bash
scripts/personal_bot_manager_smoke.sh
```

It uses a synthetic API key to test private persistence, then switches only its
temporary fixture to the debug provider before starting the runtime. It does not
use a real model account. The connection smoke also imports synthetic server and
container credentials, shares one source between two workers, verifies the source
remains authoritative after updates and stopping it, and reloads the Hub while
preserving assignments. These credentials are never sent to a model provider.
The script removes its own containers and volumes on
exit, and leaves logs and browser artifacts under `tmp/`.
