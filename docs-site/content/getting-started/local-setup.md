---
title: "Local setup"
weight: 4
featured: true
description: "Run an agent on your computer after closing the terminal, keep its bearer token, and connect it to a Hub."
kicker: "Always-on agents"
next:
  label: Background service reference
  url: /guides/background-services/
---

This walkthrough sets up a browser assistant that keeps running when you close
your terminal. Its login token is saved automatically, so restarting it does not
mean signing in with a new token.

Use **macOS** or **Linux with systemd**, and run the commands as your normal user.
Docker is not needed for this local setup. Your computer must stay on and awake
for the agent to answer questions or run background work.

## 1. Install term-llm and connect a provider

On macOS with Homebrew:

```bash
brew install samsaffron/tap/term-llm
```

For Linux or another installation method, follow [Installation](/getting-started/installation/).
If you already installed term-llm, continue with:

```bash
term-llm version
term-llm ask "Say hello in one sentence."
```

On a first interactive run, follow the provider setup prompts. You should receive
an answer before continuing. [Providers and setup](/getting-started/providers-and-setup/)
explains API keys, supported subscriptions, and local models. A local model server
must remain running too.

## 2. Install the background service

For a first installation, use the command below. If you already have a managed
Web service, check `term-llm service status web` and open it with
`term-llm service open web` first. Keep its saved authentication, agent, port,
and other settings; arguments after `--` replace those settings. See
[service maintenance](/guides/background-services/#lifecycle-and-maintenance)
before changing an existing service.

```bash
term-llm service install web -- --auth bearer
```

The installer saves the launch settings, generates a stable bearer token, and
starts the Web service. macOS uses launchd; Linux uses a systemd user service.
The default browser address is `http://localhost:8080/ui/`.

If the provider needs an API key that exists only in your terminal environment,
the installer reports its variable name. Import it with a private prompt, using
your provider's actual variable name. For example, for OpenAI:

```bash
term-llm service install web --secret OPENAI_API_KEY
```

Paste the key at the prompt. The service saves it privately; later starts do not
need the terminal that originally held the key. Existing saved OAuth sign-ins
continue to use their normal credential stores.

If you already have `term-llm serve web` running on port 8080, stop that process
with **Ctrl+C** first. The service does not take over an occupied port. To choose
another port on initial installation, use:

```bash
term-llm service install web -- --auth bearer --port 8081
```

There is one managed Web service per operating-system user account. Installing
it again updates that service; it does not create a second agent process.

## 3. Open the assistant and sign in

```bash
term-llm service token web
term-llm service open web
```

The first command explicitly displays your saved bearer token. Copy it into the
browser's sign-in form. Treat the token like a password; anyone who has it can
access the assistant. Bookmark the browser address, not a URL containing a token.

On **macOS**, the service token is saved in your login Keychain. On **Linux**, it
is saved in a private service credential file readable only by your account.
Restarts and ordinary reinstalls reuse it. You do not need to put the token in a
shell profile or remember to export it every time.

Send a small message in the browser to confirm the provider works from the
service. The installer's health check proves the local server is running; it
does not make a model request.

## 4. Close the terminal and come back

Close the terminal window, then reopen the bookmarked browser address. The
assistant should still respond. From a new terminal, check it with:

```bash
term-llm service status web
```

The service starts at login and restarts after failures. It does not keep a
sleeping or powered-off computer available. On macOS, the LaunchAgent needs your
logged-in user session. On Linux, keeping a user service running after logout or
starting it before login requires enabling lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

Use `sudo` only for that system policy command, not for `term-llm service`.

## 5. Manage it later

| What you want | Command |
|---|---|
| Open the browser | `term-llm service open web` |
| Check status | `term-llm service status web` |
| Show the saved login token | `term-llm service token web` |
| Read recent logs | `term-llm service logs web` |
| Follow new logs | `term-llm service logs web --follow` |
| Restart after an update | `term-llm service restart web` |
| Stop and disable autostart | `term-llm service stop web` |
| Enable autostart and start again | `term-llm service start web` |

Stopping the service keeps saved conversations, configuration, and credentials.
Restarting interrupts active work, so wait for important work to finish first.

To select an existing named agent, pass it when installing the service, for
example:

```bash
term-llm service install web -- --auth bearer --agent developer
```

Arguments after `--` replace the service's saved server arguments. Repeat any
custom port or other server flags you want to keep. See [Agents](/guides/agents/)
for creating your own agent instructions.

## Native Personal Bot and scheduled routines

Builds with the native Personal Bot setup command offer a shortcut that creates
a dedicated working folder, configures an assistant, and runs browser chat and
scheduled routines together:

```bash
term-llm personal-bot setup
term-llm service token web
term-llm service open web
```

This shortcut is part of the Personal Bot development work. If your installed
release does not recognize `personal-bot setup`, use the Web service steps above;
they do not depend on the newer command. A [source build](/getting-started/installation/#build-from-source)
must include the Personal Bot changes to use the shortcut.

Use this as an alternative initial setup. It shares the one managed Web service
slot and leaves an unrelated existing Web service unchanged. Rerunning a
compatible setup preserves its working folder, agent, port, and bearer token.
See [Personal Bot setup](/guides/personal-bot/#set-up-an-assistant-on-this-computer)
for provider sign-in and routines.

## Add a Hub or more assistants

A Hub gives several assistants one dashboard. You can install it alongside the
Web service:

```bash
term-llm service install hub -- --auth bearer
term-llm service token hub
term-llm service open hub
```

Its default address is `http://localhost:8090/hub/`. The Hub has its own saved
token, separate from the Web assistant's token. Add the local Web assistant in
the Hub dashboard using its browser URL, including `/ui/`, and the token from
`term-llm service token web`. The Hub saves that connection so you do not need to
re-enter the assistant's token on each visit.

Builds with the Personal Bot manager also support **Create assistant** for
separate Docker assistants. Start Docker with Linux containers and Compose v2,
then follow [container assistant setup](/guides/personal-bot/#keep-the-hub-running-as-a-service).
With automatic runtime preparation, Docker builds the Linux runtime on macOS;
you do not manually compile a Linux binary or need Go installed on that machine.
The first start needs internet access and can take several minutes.

Each Docker assistant has its own saved token and persistent volumes. Closing a
terminal does not stop it. Docker must remain running, and the Hub must stay
available for dashboard access and shared provider connections. See
[Background services](/guides/background-services/) for authentication choices,
existing-token imports, logs, and recovery.

## If something does not work

- **The port is occupied:** stop the foreground server you previously started,
  or choose a different service port.
- **The page opens but the provider fails:** check the service logs and import
  any required terminal-only API key with `--secret NAME`. Keep a local model
  server running if you use one.
- **You forgot the login token:** run `term-llm service token web`, or use `hub`
  for the Hub's token. You do not need to generate a replacement.
- **You already installed the service with passkeys:** open it and use the
  passkey login. `service token` applies to bearer-mode services; do not change
  your authentication method merely to follow this walkthrough.
- **It stops after logout or sleep:** check the account-session and power
  requirements in step 4. Terminal closure and computer shutdown are different.
- **An existing token must stay the same:** import it through the private prompt
  described in [Bearer credentials](/guides/background-services/#bearer-credentials-and-hub-registration)
  before switching an existing server to a service.
