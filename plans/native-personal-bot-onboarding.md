# Native Personal Bot on first install

Status: **implemented, lean scope**. The optional native setup reuses one agent
and the existing managed Web service. Hub **Create assistant** keeps Docker as
its default.

## User flow

After successful first-time interactive provider setup in chat or ask, offer an
assistant on this computer with a yes/no prompt defaulting to no. Headless
provider setup and plain binary installation do not install or start an assistant.
Existing users can run `term-llm personal-bot setup` later.

Setup creates the fixed `personal` agent and a working folder under
`<data-dir>/personal-bot/workspace`. `--purpose` and `--workspace` customize the
initial setup; `--no-start` stages it without starting the service. It installs
the existing singleton Web service with `web jobs --personal-bot`, the saved
`personal` agent path, bearer authentication, and a loopback listener. Port
`8080` is the default; `--port` selects another initial port.

Before starting, complete required subscription sign-in in the terminal.
`--no-start` skips sign-in; a staged service needs that sign-in before starting,
or a setup rerun without the flag.

The assistant runs on the computer executing the command. On a remote server,
it works with that server's files, regardless of where the browser runs. The OS
account's provider configuration, conversations, jobs, and memory remain shared.
The dedicated working folder is not an isolation boundary.

## Reuse and ownership

- Wrap existing provider setup in `cmd/personal_bot.go` for the first-run offer,
  and reuse the existing agent format for initial instructions.
- Persist `jobs` in the Web service's existing saved arguments. Reuse systemd
  user services on Linux and launchd user agents on macOS, with no new service
  registry, instance model, schema, or supervisor.
- Generate the bearer token once through the managed service secret mechanism.
  Preserve it across setup reruns and restarts. Never include it in launch
  arguments, native unit/plist files, or normal logs. Explicit retrieval remains
  `term-llm service token web`.
- Privately import environment API keys needed by the configured main, Guardian,
  and fast providers, including compatible-provider fallback names and explicit
  API-key environment references accepted by the service credential policy.
  Reuse OAuth stores without copying refresh tokens or redirecting account config.
- Preserve the existing agent, workspace, port, token, and service settings on
  rerun. Reject unrelated Web services or agent conflicts rather than adopting
  them. A failed start leaves saved setup available for a normal service retry.
- Keep `service start/status/stop/logs/token web` as the lifecycle interface.
  Service removal preserves account data and saved credentials.

## Deliberately deferred

Multiple named native assistants, isolated XDG environments, native creation
from Hub, foreground setup mode, and automatic Hub discovery or registration
remain outside this scope. Connect a running native assistant through the
existing **Connect an existing assistant** flow. Direct combined Web/Jobs
passkey mode remains unsupported; a passkey Hub can front a bearer node.

Plain release installation remains focused on installing and verifying the
binary. The separate optional `server setup` command, also available through
installer `--server-domain`, provisions a public HTTPS Hub on a fresh Linux
server and enables lingering. It reuses managed services and does not change
native Web/Jobs onboarding or Docker's default for Hub-created assistants.

For local browser use today, the managed Hub provides autostart, passkeys, and a
one-time setup link. A first-run browser choice, one-use sign-in for the native
bearer assistant, and automatic connection to a local Hub remain proposals.
macOS login behavior remains described in the background-services guide.

## Regression coverage

Use temporary homes and synthetic credentials to cover optional setup and skip,
headless behavior, initial creation and rerun, preserved token and workspace,
unrelated Web-service and agent conflicts, combined Web/Jobs launch arguments,
private provider key persistence, and staged setup. Existing Web and Hub service
installs must retain their launch and authentication behavior.
