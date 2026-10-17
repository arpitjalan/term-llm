---
title: "Background services"
weight: 17
description: "Install Web and Hub as per-user systemd or launchd services, with passkeys or custom server arguments."
kicker: "Deploy agents"
---

`term-llm service` keeps a personal Web UI, a Hub, or both running without an
open terminal. Linux uses **systemd user services**; macOS uses **LaunchAgents**.
The OS supervises the ordinary `serve` process—there is no separate daemon or
internal watchdog. Run these commands as your normal user, **not with sudo**.

## Quick start

Configure term-llm normally first, then:

```bash
term-llm service install web
# Optional: install a separate Hub alongside it.
term-llm service install hub
```

Omitting the kind on `install` defaults to `web`. New installs use:

| | Web | Hub |
|---|---|---|
| Browser URL | `http://localhost:8080/ui/` | `http://localhost:8090/hub/` |
| Bind address | `127.0.0.1` | `127.0.0.1` |
| Authentication | Passkey | Passkey |
| State | Existing account/Web state | Existing account/Hub state |

The installer finds the executable, records the account environment and working
directory, installs the native definition, enables autostart, starts the service,
and checks the local HTTP backend. It offers to open the browser when interactive.
No model request is made: **provider credentials and public HTTPS reachability
are not established by the local HTTP check**.

If no passkey has been enrolled, installation prints a one-time setup link in an
interactive terminal. Open it and create a passkey; a manual code is also printed
as a fallback. The browser removes the link's `#setup` secret before making API
requests, so it is absent from HTTP request URLs. Keep the whole link private.
Existing compatible Web/Hub passkeys and sessions are reused.

```bash
term-llm service open web
term-llm service open hub
```

Subsequent browser visits use the existing session or the normal passkey sign-in
page. The service CLI does not introduce another login protocol.

### Unfinished enrollment and recovery

```bash
# Generate a fresh first-enrollment capability and restart the service.
term-llm service setup web

# If all existing passkeys are inaccessible, explicitly authorize recovery.
term-llm service recover web
```

`setup` never deletes existing passkeys; when already enrolled, it directs you to
sign in. `recover` requires an existing credential store and uses the existing
recovery flow. Both operations can restart the server and interrupt active work.

The temporary capability is stored in a private service file, **not in the
unit/plist or service logs**. Its enrollment window lasts ten minutes after the
server reads it. Restarting an uncompleted enrollment renews that window with the
same supplied secret; `setup`/`recover` explicitly replace it. After successful
enrollment, the next managed server startup detects the added credential and
removes the consumed temporary file rather than renewing its authority.

Links and codes are not printed to redirected output by default. Automation can
explicitly use `--print-setup-link` on `install` or `setup`, or
`--print-setup-code` on `install`, `setup`, or `recover`; treat that output as a
temporary enrollment credential. `--yes` only suppresses the browser prompt;
it does **not** permit secret disclosure.

## Custom server arguments

Arguments after `--` are additional flags for the corresponding `serve` command:

```bash
term-llm service install web -- --auth bearer --port 8081

term-llm service install hub -- \
  --auth passkey --public-url https://hub.example.com/hub/
```

The installer parses the actual `serve web`/`serve hub` flag definitions. Existing
server compatibility rules still apply: Web passkeys do not support Hub reverse
registration, so use bearer mode for a Hub-connected Web node.

Managed listeners remain loopback-only. For a fresh Debian/Ubuntu server,
[optional server setup](/guides/server-deployment/#optional-setup-on-a-fresh-server)
configures HTTPS and autostart together. Other deployments configure their
reverse proxy separately. A passkey public URL fixes the relying-party identity;
use the same stable hostname after installation. The public URL and mount must
match. The service persists an explicit mount so unrelated shell/config changes
do not redirect its cookies or enrollment paths.

For a managed service, `--personal-bot-binary` requires an absolute path. Other
relative server paths resolve against the recorded working directory (home by
default). Use absolute paths or explicitly choose `--working-directory`:

```bash
term-llm service install hub --working-directory "$HOME/hub" -- \
  --config "$HOME/hub/nodes.yaml"
```

### Native Personal Bot

For the optional native assistant with conversations and scheduled routines, use
[`term-llm personal-bot setup`](/guides/personal-bot/#set-up-an-assistant-on-this-computer).
It configures the existing Web service with a dedicated working folder and a
stable bearer token, preserving saved settings on rerun. It shares the account's
configuration and data; there is still only one managed Web service.

Manual Web installs can also persist the Jobs platform alongside Web:

```bash
term-llm service install web -- jobs --personal-bot --auth bearer --agent personal
```

This requires an existing `personal` agent. The combined Web/Jobs runtime uses
bearer authentication; direct passkey mode is unsupported. Use the normal Web
service lifecycle and `term-llm service token web` to retrieve its saved token.

### Personal Bot Hub

For the assistant manager on macOS or Linux, build this checkout with Docker
running, then install the Hub with its Linux runtime:

```bash
make personal-bot-runtime
./term-llm service install hub -- \
  --personal-bot \
  --personal-bot-binary "${XDG_DATA_HOME:-$HOME/.local/share}/term-llm/personal-bot/term-llm-linux"
```

The build target produces the native server and a Linux runtime matching the
Docker engine's architecture. Its runtime path is persistent; a failed build
leaves the previous runtime intact. The service saves these arguments, so normal
operation needs no repeated startup flags:

```bash
./term-llm service start hub
./term-llm service status hub
./term-llm service open hub
./term-llm service stop hub
```

Installation records the exact server executable. This example uses the binary
in the checkout, so keep that checkout and rebuild at the same path. If you use
an installed binary elsewhere, update the executable listed by
`term-llm service status hub` before restarting it.

Use the same account configuration and data directories as the existing Hub.
Assistant definitions and provider connections live under
`${XDG_CONFIG_HOME:-$HOME/.config}/term-llm`; Hub data lives under
`${XDG_DATA_HOME:-$HOME/.local/share}/term-llm`. The installer records these
locations. `serve hub --config` specifies static nodes; it does not select an
assistant storage directory. Keep real account state outside disposable `tmp`
directories.

If assistants appear to be missing, compare the paths in the Hub startup log with
the original installation before creating another workspace. Use
`./term-llm service logs hub` to read that output. Changing the listening port
does not restore a different assistant catalog.

After `make personal-bot-runtime`, restart the Hub service. To apply the new
runtime to an assistant, wait for its active work to finish, then **Stop** and
**Start** it in **Manage**. The assistant's **Restart** action uses its existing
container image. Conversations and files remain in persistent Docker volumes.
Stopping the Hub itself does not stop those containers.

### DigitalOcean Droplet or Linux server

On a fresh Debian/Ubuntu systemd server, use
[`term-llm server setup`](/guides/server-deployment/#optional-setup-on-a-fresh-server)
to provision HTTPS, Docker, and the managed Hub together. It runs the Hub as
`termllm` and enables lingering automatically. The following manual quick start
applies when those prerequisites are already configured under your own account.

For a complete deployment from a fresh server, including cloning the source,
DNS, HTTPS, firewall rules, and existing assistant upgrades, follow
[Server deployment](/guides/server-deployment/). The commands below are the
service-installation quick start once those prerequisites are in place.

Use a Linux server with systemd, an installed term-llm build, and Docker with
Docker Compose. Sign in over SSH as the normal account that will own the Hub;
that account must be able to run Docker. Run `term-llm service` as that account,
without `sudo`. See [Installation](/getting-started/installation/) for release
and source-build options.

Before installing, point a stable domain at the server and configure an HTTPS
reverse proxy using the [Hub proxy example](/guides/hub/#reverse-proxy-example).
Replace `hub.example.com` below with that domain. The example keeps the backend
on `127.0.0.1:8090` and preserves the `/hub/` path:

```bash
sudo loginctl enable-linger "$USER"
term-llm service install hub --yes -- \
  --personal-bot \
  --public-url https://hub.example.com/hub/ \
  --passkey-trusted-proxy 127.0.0.1/32
term-llm service status hub
```

Lingering lets this account's user services start at boot and remain available
after SSH logout. The installer does not enable it automatically. Systemd
supervises the Hub and restarts it after failures, subject to its restart limit.
Arrange for Docker to start at boot too; running assistants use Docker's own
restart policy.

On Linux with a matching Docker architecture, the Hub's installed executable
also supplies the assistant runtime. No separate `--personal-bot-binary` is
needed. If the Docker engine uses a different architecture, use the matching
runtime built by `make personal-bot-runtime` as shown above.

Open the printed **one-time HTTPS setup link on your own computer** and enroll
the first passkey. `term-llm service open hub` launches a browser on
the machine where the command runs, so it is usually unnecessary over SSH.
`--yes` skips that browser prompt while retaining the interactive setup link.
Installation checks the local HTTP backend; verify the public proxy and a provider-backed
conversation separately. Domain, certificate, proxy, and firewall setup remain
server administration steps. The private shared-connection broker needs Docker
network access; see [ChatGPT connections](/guides/personal-bot/#reuse-a-chatgpt-connection).

For routine operation, use `term-llm service start hub`,
`term-llm service status hub`, and `term-llm service logs hub`. After replacing
the installed binary, use `term-llm service restart hub`; then **Stop** and
**Start** each assistant when its active work has finished to rebuild its runtime
image. If you installed with `--personal-bot-binary`,
update that separate runtime file too. Keep the account configuration, data,
and Docker volumes when updating or reinstalling; a binary update does not move
the saved workspace.

### Bearer credentials and Hub registration

Bearer-mode installs generate a stable token if one has not been supplied or
stored previously. It is never printed during normal installation or startup.
Explicitly reveal it when needed for the existing browser/API login:

```bash
term-llm service token web
```

Do not place secrets after `--`. Flags such as `--token` and
`--hub-registration-token` are rejected in persisted launch arguments. Use masked
input instead:

```bash
term-llm service install web \
  --secret TERM_LLM_SERVE_TOKEN \
  --secret TERM_LLM_HUB_REGISTRATION_TOKEN -- \
  --auth bearer \
  --hub-url https://hub.example.com/hub/ \
  --hub-node-id my-laptop \
  --hub-connect reverse \
  --hub-register
```

To enable incoming registration on a managed Hub, provision
`TERM_LLM_HUB_REGISTRATION_TOKEN` with `--secret` or `--secrets-file`. A passkey Hub
can also accept an explicitly provisioned `TERM_LLM_HUB_TOKEN` for its existing API
compatibility mode; the installer does not create that second credential by default.

For automation, use a mode-0600 file:

```text
TERM_LLM_SERVE_TOKEN=your-existing-web-token
TERM_LLM_HUB_REGISTRATION_TOKEN=your-hub-registration-token
OPENAI_API_KEY=your-provider-key
```

```bash
term-llm service install web --secrets-file ./service-secrets.env -- \
  --auth bearer --port 8081
```

This is **literal `KEY=value`**, not a shell script: no `export`, interpolation,
or quote removal. Duplicate keys are errors. Only credential-like variable names
are allowed (such as `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`); loader hooks,
PATH/HOME overrides, and bootstrap/recovery variables are not accepted here.
Enrollment secrets are owned by the setup/recovery flow.

### Where credentials live

- **macOS:** per-service generic-password items in the user's Keychain. The
  installer uses `/usr/bin/security` with encoded input over stdin, never a
  password in subprocess arguments. It verifies readback and never silently
  falls back to plaintext. Unlock/access approval may be required. The native
  tool controls item access; this is not an application-signing isolation claim.
- **Linux:** mode-0600 files inside the private service directory. A desktop
  keyring is not required, allowing operation without an unlocked desktop.

The launch specification contains only credential names. Values are resolved by
the internal runner and passed to the server, not written to the unit/plist.
Uninstall deliberately preserves these credentials, but removes any temporary
setup/recovery capability.

Keychain input is bounded by Apple's command-line protocol; unusually large
credentials are rejected rather than truncated or placed in arguments. Validate
unattended access on the intended macOS account.

## Environment and existing state

The default working directory is home, not an implicit agent workspace grant.
The specification records HOME, PATH, XDG config/data/cache locations and selected
locale/shell settings. It does **not** source shell profiles or capture the entire
environment. Dynamic desktop/session endpoints come from the native supervisor.

New installs save explicit XDG locations, including the default home-based
directories when those variables are unset. Reinstalling preserves the saved
environment. Use the same account and `XDG_CONFIG_HOME` for service management
commands so they can find the saved specification. `term-llm service status hub`
reports the saved executable, working directory, configuration directory, and
data directory.

Persistent provider configuration and secret references continue to work when
available to that user session. Terminal-only credentials are not imported
silently: the installer warns about their names. If needed, import them with
`--secret NAME` or `--secrets-file`. Changing a credential used by a running server
requires a restart.

## Lifecycle and maintenance

```bash
term-llm service status             # list Web and Hub
term-llm service logs web
term-llm service logs hub --follow
term-llm service stop web           # stop AND disable autostart
term-llm service start web          # enable autostart and start
term-llm service restart web        # enabled service only; interrupts active work
term-llm service uninstall hub      # preserve user data and saved setup
```

For startup failures, enable diagnostics:

```bash
term-llm service start web --debug
term-llm service restart hub --debug
```

`--debug` writes startup checks, executable and working-directory paths, and
native service-manager commands and their outcomes to stderr. On failure it also
collects native lifecycle status and the last 60 service log lines. Readiness
errors include the last HTTP health-check result. Debug mode does not change the
saved service configuration or enable server debug logging. Credentials and the
native environment are not dumped, but service logs may contain sensitive data;
review the output before sharing it.

If exactly one native service is installed, commands can infer its kind. When
both exist, specify `web` or `hub` for individual operations.

A bare reinstall preserves the existing custom arguments, account environment,
and credentials:

```bash
term-llm service install web
```

Supplying arguments after `--` explicitly replaces the launch arguments. An
unchanged reinstall does not force a restart; changed settings, credential input,
or enrollment provisioning take effect through a restart. `--binary` selects the
executable, and `--working-directory` changes the working directory. Saved PATH
and XDG settings can be inspected in the private specification; reinstall does
not silently replace a custom account environment.

No updates are downloaded or scheduled. After replacing the binary, restart when
it is safe to interrupt active work:

```bash
term-llm upgrade
term-llm service restart web
```

### Preview without touching the OS

```bash
term-llm service install hub --dry-run
term-llm service install web --no-start -- --auth bearer --port 8081
```

`--dry-run` prints the plan and native definition without creating files or
credentials. `--no-start` writes files but does not enable/start the service.

Existing manually managed definitions—including the older systemd example—are
**not overwritten or adopted automatically**. Migrate them explicitly after
backing up their configuration and stopping them yourself. A port conflict also
fails rather than killing another process or silently selecting a different port.

## Platform behavior and files

| | Linux | macOS |
|---|---|---|
| Supervisor | systemd user manager | launchd GUI user domain |
| Native identity | `term-llm-web.service`, `term-llm-hub.service` | `com.term-llm.web`, `com.term-llm.hub` |
| Native files | `$XDG_CONFIG_HOME/systemd/user/` | `~/Library/LaunchAgents/` |
| Logs | user journal | private `service.log` beside the specification |

Specifications live under `$XDG_CONFIG_HOME/term-llm/services/{web,hub}/service.json`
(falling back to `~/.config`). LaunchAgent log rotation is not provisioned by this
initial implementation; monitor log size or arrange rotation separately.

Closing a terminal does not stop either service. Linux operation before login or
after logout requires user lingering:

```bash
sudo loginctl enable-linger "$USER"
```

`service install` does not change this account-wide policy, and uninstall does
not undo it. Optional `server setup` enables it for the dedicated Hub account.
A macOS LaunchAgent starts at login and requires that user session; it is not a
pre-login system daemon. Neither platform makes a sleeping machine continuously
available. There are no root installs, arbitrary instance profiles, automatic
local-node registration, or automatic updates.
