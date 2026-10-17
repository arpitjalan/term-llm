---
title: "Deploy term-llm on a server"
weight: 15
description: "Build from a Git checkout, set up a domain and HTTPS, and run Personal Bot and its assistants persistently on Ubuntu."
kicker: "Deploy agents"
---

This guide deploys the Personal Bot Hub at `https://hub.example.com/hub/`, with
passkey sign-in, Docker assistants, Nginx, and automatic certificate renewal.
The executable is built **on the server from the chosen repository and branch**.
No model account is needed to start the Hub; connect a provider when creating
an assistant.

The commands target **Ubuntu 24.04 with systemd**, on amd64 or arm64. Run the
administration blocks in one root Bash session over SSH. A fresh installation
uses a dedicated account for the Hub. The system service also supports an
existing account, including a root-owned installation, without moving its state.
Use absolute deployment paths without whitespace in the examples below.
This is a manually maintained **system service**: manage it with `systemctl`,
not the separate per-user `term-llm service` commands.

For a single Web server without the assistant manager, see
[Web UI and API](/guides/web-ui-and-api/). For per-user service installation,
see [Background services](/guides/background-services/).

## Before executing this guide

An operator or assisting agent should first establish the SSH destination,
repository, branch or commit, public hostname, deployment account, and whether
existing assistants should be upgraded. Use choices already supplied by the
operator. Reading this guide does not authorize changes to another server.

Inspect before installing. Record the running services, exact executable paths,
account and XDG directories, Docker projects and mounts, public ports, and
available memory/disk. Keep a timestamped command log, distinguish completed
steps from plans, and show commands when requested. Do not dump `.env` files,
Docker environment values, process arguments, provider credentials, or transcripts
into that log.

```bash
hostnamectl --static
cat /etc/os-release
uname -m
free -h
df -h /
ss -lntp
systemctl list-units --all --type=service --no-pager '*term*llm*'
command -v git go node npm make docker nginx certbot || true
if command -v docker >/dev/null; then
  docker version --format 'server={{.Server.Version}} arch={{.Server.Arch}}'
  docker compose version
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
fi
```

If there is an existing installation, read [Existing agents](#existing-agents)
before changing it. Preserve its original account and directories. Changing
`HOME` or `XDG_CONFIG_HOME` can make an assistant catalog appear empty; it does
not migrate the catalog. `serve hub --config` selects a static node list, not a
different assistant workspace.

Record the operator's backup policy. Respect an explicit decision to skip volume
backups. Keep existing volumes attached either way. Database migrations can
prevent an older executable from opening upgraded data; restoring only the old
executable is **not** a supported database rollback.

On a rerun, inspect existing files and resume from the matching checkpoint.
Do not overwrite an unrelated service, regenerate credentials, append a second
TLS server block, reset a dirty checkout, or create another catalog to get past
a failed step.

## Choose the deployment values

Replace the hostname. This repository/branch example selects the Personal Bot
fork; choose the exact source requested by the operator, rather than silently
substituting an upstream release.

```bash
set -euo pipefail
DEPLOY_DOMAIN=hub.example.com
DEPLOY_EMAIL='' # Optional operator email for certificate notices.
DEPLOY_REPO=https://github.com/arpitjalan/term-llm.git
DEPLOY_BRANCH=personal-bot
DEPLOY_USER=termllm
DEPLOY_SRC=/opt/term-llm-src
DEPLOY_TOOLS=/opt/term-llm-tools
DEPLOY_BIN=/opt/term-llm/bin/term-llm
DEPLOY_WORK=/opt/term-llm-deploy

[[ "$DEPLOY_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]
install -d -m 0700 "$DEPLOY_WORK"
```

For a fresh server, create the account if it does not exist. For an existing
root-owned catalog, set `DEPLOY_USER=root` **before** this step. Do not move or
recursively change ownership of an existing account's state.

```bash
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
DEPLOY_GROUP="$(id -gn "$DEPLOY_USER")"
DEPLOY_CONFIG_HOME="$DEPLOY_HOME/.config"
DEPLOY_DATA_HOME="$DEPLOY_HOME/.local/share"
DEPLOY_CACHE_HOME="$DEPLOY_HOME/.cache"
```

If an existing service uses custom XDG directories, set the three variables to
those observed paths now. Broker initialization, the final service, and later
maintenance must use the same values.

## Install prerequisites and Docker

Install the administration tools without upgrading the entire server:

```bash
apt-get update
apt-get install --yes --no-install-recommends \
  ca-certificates curl git make python3 openssl iproute2 iptables util-linux \
  nginx certbot
```

Keep an existing working Docker installation. On a **fresh server without
Docker**, use the [official Docker Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/):

```bash
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location \
  https://download.docker.com/linux/ubuntu/gpg \
  --output /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install --yes docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

Give the selected account Docker access and verify it using a new process.
Docker group membership grants control of the host Docker daemon; this account
must be trusted to administer it.

```bash
if [ "$DEPLOY_USER" != root ]; then
  usermod -aG docker "$DEPLOY_USER"
fi
systemctl enable --now docker
runuser -u "$DEPLOY_USER" -- docker version
runuser -u "$DEPLOY_USER" -- docker compose version
```

**Checkpoint:** both Docker commands succeed as the deployment account. On a
host with an existing Docker installation but missing Compose, install its
matching Compose plugin; do not replace the running engine blindly.

## Clone and install the build tools

Use a new source directory. If the selected branch is missing, have its owner
push it first; uncommitted or unpushed local changes cannot be cloned.

```bash
test ! -e "$DEPLOY_SRC"
install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "$DEPLOY_SRC"
runuser -u "$DEPLOY_USER" -- git clone --single-branch \
  --branch "$DEPLOY_BRANCH" "$DEPLOY_REPO" "$DEPLOY_SRC"
git -c safe.directory="$DEPLOY_SRC" -C "$DEPLOY_SRC" log -1 --format='%H %s'
```

Read the checkout's `go.mod` and `frontend/README.md` before choosing tool
versions. This example derives Go's exact version from `go.mod` and selects a
Node 24 release. The tools are installed in versioned directories under `/opt`;
existing Node/Go installations and shell profiles are left alone.

The installer verifies archives against the official
[Go download metadata](https://go.dev/dl/?mode=json&include=all) and
[Node distribution checksums](https://nodejs.org/en/download). It pins the Node
version before downloading, so a new release cannot change the archive halfway
through installation.

```bash
python3 - "$DEPLOY_SRC" "$DEPLOY_TOOLS" <<'PY'
import hashlib, json, pathlib, re, shutil, subprocess, sys, tempfile, urllib.request
source, tools = map(pathlib.Path, sys.argv[1:])
tools.mkdir(parents=True, exist_ok=True)
tools.chmod(0o755)
arch = subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip()
if arch not in ('amd64', 'arm64'):
    raise SystemExit('This example supports amd64 and arm64')
go_version = 'go' + re.search(r'^go\s+(\S+)', (source/'go.mod').read_text(), re.M)[1]
def read(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()
releases = json.loads(read('https://go.dev/dl/?mode=json&include=all'))
go = next(f for r in releases if r['version'] == go_version for f in r['files']
          if f['os'] == 'linux' and f['arch'] == arch and f['kind'] == 'archive')
node_version = next(r['version'] for r in json.loads(read('https://nodejs.org/dist/index.json'))
                    if r['version'].startswith('v24.'))
node_arch = 'x64' if arch == 'amd64' else 'arm64'
node_file = f'node-{node_version}-linux-{node_arch}.tar.gz'
node_base = f'https://nodejs.org/dist/{node_version}/'
node_sha = next(line.split()[0] for line in read(node_base+'SHASUMS256.txt').decode().splitlines()
                if line.split()[-1] == node_file)
def install(url, checksum, destination):
    if destination.exists():
        return
    with tempfile.TemporaryDirectory(dir=tools) as scratch:
        scratch = pathlib.Path(scratch)
        archive = scratch/'archive.tar.gz'
        with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output)
        if hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() != checksum:
            raise SystemExit('Archive checksum mismatch')
        unpacked = scratch/'unpacked'
        unpacked.mkdir()
        subprocess.run(['tar', '--extract', '--gzip', '--no-same-owner',
                        '--file', str(archive), '--strip-components=1',
                        '--directory', str(unpacked)], check=True)
        unpacked.rename(destination)
        destination.chmod(0o755)
go_dir, node_dir = tools/go_version, tools/('node-'+node_version)
install('https://go.dev/dl/'+go['filename'], go['sha256'], go_dir)
install(node_base+node_file, node_sha, node_dir)
(tools/'env.sh').write_text(f'export PATH="{go_dir}/bin:{node_dir}/bin:$PATH"\n')
(tools/'manifest.json').write_text(json.dumps({'go': go, 'node': {
    'version': node_version, 'filename': node_file, 'sha256': node_sha}}, indent=2)+'\n')
PY
. "$DEPLOY_TOOLS/env.sh"
go version
node --version
npm --version
```

Use only tool directories created and checksum-verified by this procedure.
Inspect an unknown pre-existing directory before reusing it. Follow the
[Go installation guidance](https://go.dev/doc/install) when changing versions;
do not overlay an older Go tree.

## Build and install the executable

Build as the deployment account. Limiting Go parallelism keeps the first build
manageable on a small server; the first dependency download can take several
minutes. Keep real account state outside the checkout's `tmp/` directory.

```bash
runuser -u "$DEPLOY_USER" -- env HOME="$DEPLOY_HOME" PATH="$PATH" \
  GOMAXPROCS=2 GOFLAGS=-p=2 CGO_ENABLED=0 \
  make -C "$DEPLOY_SRC" build VERSION=personal-bot
install -d -m 0755 "$(dirname "$DEPLOY_BIN")"
install -m 0755 "$DEPLOY_SRC/term-llm" "$DEPLOY_BIN.new"
mv "$DEPLOY_BIN.new" "$DEPLOY_BIN"
"$DEPLOY_BIN" version
sha256sum "$DEPLOY_BIN" > "$DEPLOY_WORK/binary.sha256"
git -c safe.directory="$DEPLOY_SRC" -C "$DEPLOY_SRC" rev-parse HEAD \
  > "$DEPLOY_WORK/source-commit"
```

`make build` installs locked frontend dependencies and embeds the generated UI.
Plain `go build` on a fresh checkout misses that prerequisite; `go install
...@latest` also cannot build the repository's local module replacements. An
upstream installer or `term-llm upgrade` selects upstream releases, not this fork.

On Linux, if the host and Docker engine architectures match, this executable
also supplies the assistant runtime. A separate `make personal-bot-runtime` and
`--personal-bot-binary` are only needed for a separately pinned runtime or a
different Docker architecture.

**Checkpoint:** record the full source commit, reported version, binary hash,
and architecture. If performing source validation, run tests as the build
account with an isolated temporary home and preserved Go module cache. Do not
read production credentials to make tests pass. Root bypasses Unix write
permissions, so permissions tests can fail under root; rerun the affected tests
unprivileged rather than weakening the tests or modifying real configuration.

## Point the domain at the server

Create an A record for `DEPLOY_DOMAIN` pointing to the public IPv4 address. Add
an AAAA record only if IPv6 actually reaches this server. Check the result:

```bash
getent ahostsv4 "$DEPLOY_DOMAIN"
getent ahostsv6 "$DEPLOY_DOMAIN" || true
ip -brief address
```

Allow inbound SSH, TCP **80**, and TCP **443** in the server and cloud firewall.
Keep SSH access working while changing rules. Hub port 8090 and the private
broker do not need public access. Docker-published agent ports need their own
review: Docker forwarding can bypass rules intended only for host listeners.

[HTTP-01 certificate validation](https://letsencrypt.org/docs/challenge-types/)
requires public port 80. An incorrect AAAA record can cause validation failure
even when the A record is correct; fix the DNS record rather than bypassing TLS
verification.

## Issue the HTTPS certificate

Keep an existing Nginx site serving other applications. The following uses a new
site file and refuses to overwrite one with the same name. The challenge path
must remain accessible after HTTPS is enabled.

```bash
test ! -e /etc/nginx/sites-available/term-llm
install -d -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge
cat > /etc/nginx/sites-available/term-llm <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DEPLOY_DOMAIN;
    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/letsencrypt;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
ln -s /etc/nginx/sites-available/term-llm /etc/nginx/sites-enabled/term-llm
nginx -t
systemctl enable --now nginx
systemctl reload nginx
```

Use the operator's email for certificate notices when provided. An empty
`DEPLOY_EMAIL` explicitly registers without an email:

```bash
certbot_args=(certonly --webroot --webroot-path /var/lib/letsencrypt
  --cert-name "$DEPLOY_DOMAIN" --domain "$DEPLOY_DOMAIN"
  --non-interactive --agree-tos)
if [ -n "$DEPLOY_EMAIL" ]; then
  certbot_args+=(--email "$DEPLOY_EMAIL")
else
  certbot_args+=(--register-unsafely-without-email)
fi
certbot "${certbot_args[@]}"
```

**Checkpoint:** the certificate exists under
`/etc/letsencrypt/live/<domain>/`. If issuance fails, check DNS, both IP families,
port 80, and the ACME route before continuing. See the
[Certbot webroot documentation](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot).

## Initialize and protect the private broker

Personal Bot starts its shared-connection HTTPS broker immediately. It listens
on IPv4 `0.0.0.0` at a port persisted in
`<config-home>/term-llm/personal-bot-connections/broker.json`. A loopback Hub
listener does **not** make this second listener private.

For first initialization, start the real account's Hub inside an isolated
network namespace, let it generate its own broker port/certificates, then stop
it. Docker remains accessible through its Unix socket. No public listener is
created during this initialization. Skip initialization if the broker already
exists; preserve its TLS files because workers pin that trust root.

```bash
python3 - "$DEPLOY_USER" "$DEPLOY_HOME" "$DEPLOY_CONFIG_HOME" \
  "$DEPLOY_DATA_HOME" "$DEPLOY_CACHE_HOME" "$DEPLOY_BIN" "$DEPLOY_WORK" <<'PY'
import os, pathlib, signal, subprocess, sys, tempfile, time
user, home, config, data, cache, binary, work = sys.argv[1:]
broker = pathlib.Path(config)/'term-llm/personal-bot-connections/broker.json'
if not broker.exists():
    fd, log_path = tempfile.mkstemp(prefix='broker-initialization-', suffix='.log', dir=work)
    print('Private initialization log:', log_path)
    with os.fdopen(fd, 'w') as log:
        command = ['unshare', '--net', '--', 'sh', '-c',
                   'ip link set lo up; exec "$@"', 'sh',
                   'runuser', '-u', user, '--', 'env', 'HOME='+home,
                   'XDG_CONFIG_HOME='+config, 'XDG_DATA_HOME='+data,
                   'XDG_CACHE_HOME='+cache, binary, 'serve', 'hub',
                   '--personal-bot', '--host', '127.0.0.1', '--port', '8090',
                   '--base-path', '/hub', '--auth', 'none']
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log,
                                   stderr=log, start_new_session=True, cwd=home)
        try:
            deadline = time.monotonic() + 45
            while not broker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.25)
            if not broker.exists():
                raise SystemExit('Broker initialization failed; inspect '+log_path)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=45)
PY
```

Install a root-owned pre-start helper that protects **only the broker's port**.
It allows loopback and Docker bridge interfaces, then drops other inbound
traffic to that port. Adapt the interface rules if Docker uses another network
driver. Do not flush existing host or Docker firewall tables.

```bash
cat > "$DEPLOY_WORK/protect-broker.sh" <<'SH'
#!/bin/sh
set -eu
broker_port="$(python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    port = json.load(source)['port']
if type(port) is not int or not 1024 <= port <= 65535:
    raise SystemExit('Invalid private broker port')
print(port)
PY
)"
if ! iptables -w 10 -S TERM_LLM_BROKER >/dev/null 2>&1; then
  iptables -w 10 -N TERM_LLM_BROKER
fi
iptables -w 10 -F TERM_LLM_BROKER
iptables -w 10 -A TERM_LLM_BROKER -i lo -j ACCEPT
iptables -w 10 -A TERM_LLM_BROKER -i docker+ -j ACCEPT
iptables -w 10 -A TERM_LLM_BROKER -i br+ -j ACCEPT
iptables -w 10 -A TERM_LLM_BROKER -j DROP
if ! iptables -w 10 -C INPUT -p tcp --dport "$broker_port" -j TERM_LLM_BROKER 2>/dev/null; then
  iptables -w 10 -I INPUT 1 -p tcp --dport "$broker_port" -j TERM_LLM_BROKER
fi
SH
chmod 0700 "$DEPLOY_WORK/protect-broker.sh"
DEPLOY_BROKER="$DEPLOY_CONFIG_HOME/term-llm/personal-bot-connections/broker.json"
"$DEPLOY_WORK/protect-broker.sh" "$DEPLOY_BROKER"
```

The systemd unit below runs this helper before every Hub start, including after
reboot. If another firewall manager reloads rules while Hub is running, integrate
the same port policy with that manager and verify it again. The broker uses
IPv4; public HTTPS can use both IP families.

## Install the Hub system service

Create a private first-enrollment code file. Do not replace an existing code or
passkey store on a rerun. The file must be readable by the deployment account,
but its value must stay out of command arguments, URLs, and service logs.

```bash
DEPLOY_SETUP=/etc/term-llm-hub-setup-code
python3 - "$DEPLOY_SETUP" "$DEPLOY_USER" <<'PY'
import os, pwd, secrets, sys
account = pwd.getpwnam(sys.argv[2])
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(secrets.token_hex(16)+'\n')
os.chown(sys.argv[1], account.pw_uid, account.pw_gid)
PY

test ! -e /etc/systemd/system/term-llm-hub.service
cat > /etc/systemd/system/term-llm-hub.service <<EOF
[Unit]
Description=term-llm Personal Bot Hub
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=exec
User=$DEPLOY_USER
WorkingDirectory=$DEPLOY_HOME
Environment=HOME=$DEPLOY_HOME
Environment=XDG_CONFIG_HOME=$DEPLOY_CONFIG_HOME
Environment=XDG_DATA_HOME=$DEPLOY_DATA_HOME
Environment=XDG_CACHE_HOME=$DEPLOY_CACHE_HOME
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=TERM_LLM_SKIP_UPDATE_CHECK=1
ExecStartPre=+$DEPLOY_WORK/protect-broker.sh $DEPLOY_BROKER
ExecStart=$DEPLOY_BIN serve hub --personal-bot --host 127.0.0.1 --port 8090 --base-path /hub --auth passkey --public-url https://$DEPLOY_DOMAIN/hub/ --passkey-trusted-proxy 127.0.0.1/32 --passkey-bootstrap-token-file $DEPLOY_SETUP
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemd-analyze verify /etc/systemd/system/term-llm-hub.service
systemctl daemon-reload
```

The `+` on `ExecStartPre` runs the root-owned firewall helper with the privileges
it needs; Hub itself runs as `User`. This system service starts at boot without
user lingering. `term-llm service install` would create a different, per-user
service and refuses root; do not use it to manage this unit.

This default enables **passkeys only**. Do not add `TERM_LLM_HUB_TOKEN` merely to
make a health probe work: `/hub/healthz` is public. If the operator needs headless
Hub APIs, an explicit Hub token also enables a second full-operator bearer
authentication method. Keep it in a private systemd environment file and record
that choice separately.

## Enable the HTTPS proxy and renewal

Append this TLS configuration **once**, after certificate issuance. Ubuntu
24.04's Nginx 1.24 supports `listen ... ssl http2`; the separate `http2 on`
directive requires a newer version.

```bash
cat >> /etc/nginx/sites-available/term-llm <<EOF

map \$http_upgrade \$term_llm_connection_upgrade {
    default upgrade;
    '' close;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DEPLOY_DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$DEPLOY_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DEPLOY_DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 32m;
    location = / { return 302 /hub/; }
    location = /hub { return 308 /hub/; }
    location /hub/ {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$term_llm_connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    location / { return 404; }
}
EOF
nginx -t
systemctl reload nginx
systemctl enable --now term-llm-hub

install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/term-llm-nginx-reload <<'SH'
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/bin/systemctl reload nginx
SH
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/term-llm-nginx-reload
systemctl enable --now certbot.timer
systemctl list-timers certbot.timer --no-pager
certbot renew --cert-name "$DEPLOY_DOMAIN" --dry-run --run-deploy-hooks
```

The upstream `proxy_pass` has **no trailing slash**: Hub must receive `/hub/`.
WebSocket upgrade headers and disabled response buffering support live streams;
the proxy overwrites client-supplied forwarding headers. Hub trusts only the
loopback proxy, and its configured public URL fixes the passkey origin. See
[Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html) and
[Certbot renewal](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates).

## Enroll the administrator and verify the deployment

First check the backend and public HTTPS without bypassing certificate checks:

```bash
systemctl is-active docker nginx term-llm-hub
curl --fail --silent --show-error --max-time 5 --retry 12 --retry-delay 1 \
  --retry-connrefused --retry-max-time 30 http://127.0.0.1:8090/hub/healthz
curl --fail --silent --show-error --max-time 5 --retry 12 --retry-delay 1 \
  --retry-connrefused --retry-max-time 30 "https://$DEPLOY_DOMAIN/hub/healthz"
curl --fail --silent --show-error --output /dev/null \
  "https://$DEPLOY_DOMAIN/hub/auth/setup"
```

Open `https://<domain>/hub/` in a browser and verify that the setup screen and
assets render. Reading the setup page with GET is safe for a smoke check;
posting the setup code consumes its one-time capability.

The enrollment window lasts **ten minutes after Hub reads the setup file**.
Near handoff, refresh it and let the operator read the code privately:

```bash
systemctl restart term-llm-hub
cat "$DEPLOY_SETUP"
```

The operator pastes the code into the setup page and creates their passkey.
An assisting agent should hand over this credential creation step. Once the
operator has enrolled successfully, remove only the temporary code file:

```bash
rm -- "$DEPLOY_SETUP"
```

The unit can retain the flag: after enrollment the unused bootstrap file is not
read. Do not delete `auth.json` or `sessions.json` to renew an expired setup code
or recover a lost passkey; use the documented
[Hub authentication and recovery flow](/guides/hub/#passkey-authentication).

In the Hub, create an assistant, select a provider connection, and start it.
The first runtime image build can take several minutes. Verify:

1. The Hub and assistant open through the public HTTPS hostname.
2. A harmless provider-backed conversation succeeds and remains after refresh.
3. Routines can read existing schedules or create a schedule chosen by the operator.
4. The private broker is reachable from the Docker network, while an external
   TCP connection to its persisted port is refused or times out.
5. After an idle assistant restart, the expected executable, files, conversations,
   and schedules remain. Test a full server reboot only when authorized; a
   container restart does not establish full reboot behavior.

Keep provider keys, ChatGPT sign-in, and passkey creation with the operator.
Report an unperformed provider conversation or reboot as unperformed, rather
than treating a passing health endpoint as proof of them.

## Update a source deployment

Use the same account, source, branch, installed executable, and XDG paths.
Build before interrupting the running service:

```bash
runuser -u "$DEPLOY_USER" -- git -C "$DEPLOY_SRC" status --short
runuser -u "$DEPLOY_USER" -- git -C "$DEPLOY_SRC" remote get-url origin
runuser -u "$DEPLOY_USER" -- git -C "$DEPLOY_SRC" branch --show-current
# Refuse a dirty checkout, another remote, or another checked-out branch.
test -z "$(runuser -u "$DEPLOY_USER" -- git -C "$DEPLOY_SRC" status --porcelain)"
test "$(runuser -u "$DEPLOY_USER" -- git -C "$DEPLOY_SRC" remote get-url origin)" = "$DEPLOY_REPO"
test "$(runuser -u "$DEPLOY_USER" -- git -C "$DEPLOY_SRC" branch --show-current)" = "$DEPLOY_BRANCH"
runuser -u "$DEPLOY_USER" -- git -C "$DEPLOY_SRC" pull --ff-only origin "$DEPLOY_BRANCH"
. "$DEPLOY_TOOLS/env.sh"
runuser -u "$DEPLOY_USER" -- env HOME="$DEPLOY_HOME" PATH="$PATH" \
  GOMAXPROCS=2 GOFLAGS=-p=2 CGO_ENABLED=0 \
  make -C "$DEPLOY_SRC" build VERSION=personal-bot
install -m 0755 "$DEPLOY_SRC/term-llm" "$DEPLOY_BIN.new"
```

Wait for relevant active work to finish, follow the agreed backup policy, then
atomically rename the staged executable and restart:

```bash
mv "$DEPLOY_BIN.new" "$DEPLOY_BIN"
systemctl restart term-llm-hub
curl --fail --silent --show-error --max-time 5 --retry 12 --retry-delay 1 \
  --retry-connrefused --retry-max-time 30 "https://$DEPLOY_DOMAIN/hub/healthz"
"$DEPLOY_BIN" version
```

Re-read the new checkout's tool requirements before building an upgrade. Do not
use `git reset --hard` to discard unexplained source changes. Updating Hub does
not update already-running assistant images. For assistants created by Personal
Bot, wait for work to finish, then **Stop** and **Start** in Manage; **Restart**
uses the existing image. Update a separate `--personal-bot-binary` too if one
was configured.

## Existing agents

Existing `contain` workspaces appear as Hub nodes even if the Personal Bot manager
did not create them. Their presence on the dashboard does not convert them into
manager-owned assistants. Keep their metadata account and original Docker
projects, ports, credentials, mounts, and restart policies.

### Inspect before choosing an upgrade method

Inspect each actual container and its mounts. `docker inspect --size` reports
writable-layer size; `docker diff` shows changes outside volumes. Recreating a
container from its original image discards those writable-layer changes even
when its named home volume survives. Do not run `contain rebuild` to select a
fork: the bundled legacy image recipe can download upstream releases instead.

For a legacy runit container, establish these values from inspection rather than
assuming that every installation uses the example paths:

| Item | Legacy agent image convention |
|---|---|
| User and persistent home | `agent`, `/home/agent` |
| Persisted services | `/home/agent/.config/term-llm/services/{webui,jobs}` |
| Runtime services | `/etc/sv/{webui,jobs}` |
| Web listener and mount | container port 8081, `/chat` |
| Separate legacy jobs listener | loopback port 8080 |
| Boot hook | `/home/agent/.config/term-llm/init.sh` |

Before stopping anything, record session/job counts and establish that work is
idle. Read authenticated `GET <web-base>/v1/sessions/status` and count
`sessions[].active_run`; read the jobs API or the jobs database read-only for
`queued`, `claimed`, `running`, and `cancel_requested` runs. Retrieve tokens
privately in-process from the existing environment; print only counts and status.
Do not use an old version's unverified SIGUSR2 handling for the first upgrade.

Inventory program-job definitions, hooks, and custom tools for direct references
to the old `localhost:8080` API. Repoint those callers to the combined server's
API base, including `/chat`, and supply the existing bearer credential privately.
The wrapper below sets defaults for clients that honor `TERM_LLM_JOBS_SERVER`;
it cannot redirect a hard-coded `curl http://127.0.0.1:8080/...` command. Update
explicit endpoint/token environment overrides as well if they still select the
old listener. Complete this inventory before disabling it.

### Keep custom containers and pin the executable in their volumes

For the legacy layout above, this approach preserves both the current container's
writable layer and its home volume:

1. Stop **both** old web and jobs services using `sv -w 60 down`, and verify no
   live server process remains. Never let old and new executables write the same
   database concurrently.
2. Install the server-built static executable as
   `/home/agent/.local/lib/term-llm-personal-bot/term-llm`, owned by `agent`, mode
   `0755`. Stage and rename it rather than writing over a running executable.
3. Install the wrapper below as `/home/agent/.local/bin/term-llm`, also owned by
   `agent`, mode `0755`. Point `/usr/local/bin/term-llm` at that wrapper.
4. Change the **persisted and runtime** `webui/run` to invoke the wrapper with
   `serve web jobs --personal-bot`. Preserve its existing agent, provider,
   bearer token, mount, port, file roots, widgets, and permission settings.
5. Put a `down` file in **both** persisted `services/jobs/` and runtime
   `/etc/sv/jobs/`. The separate jobs manager must stay disabled when the combined
   server owns its database.
6. Append the link-restoration block below to the existing volume `init.sh`.
   Preserve custom initialization; do not replace the whole file.
7. Start only `webui` with `sv up`, then verify version/hash, health, Personal Bot
   UI, saved counts, and `term-llm jobs active --json` as `agent`.

The wrapper redirects `term-llm jobs` and other clients that honor its environment
variables, including noninteractive CLI calls, Docker exec, and scheduled
programs. A `.bashrc` change alone does not cover those callers. It uses the
existing token dynamically, without embedding its value in a script:

```sh
#!/bin/sh
export TERM_LLM_JOBS_SERVER="${TERM_LLM_JOBS_SERVER:-http://127.0.0.1:8081${WEB_BASE_PATH:-/chat}}"
export TERM_LLM_JOBS_TOKEN="${TERM_LLM_JOBS_TOKEN:-${WEB_TOKEN:-}}"
exec /home/agent/.local/lib/term-llm-personal-bot/term-llm "$@"
```

Add this idempotent block to the existing boot hook, which runs as root:

```sh
# BEGIN managed personal-bot runtime
if [ -x /home/agent/.local/bin/term-llm ]; then
  ln -sfn /home/agent/.local/bin/term-llm /usr/local/bin/term-llm
fi
# END managed personal-bot runtime
```

Read the existing updater before modifying it. Retarget any self-update path to
the selected fork and branch, use a separate source directory if its existing
checkout has other work, and install into the persistent executable location.
An upstream updater that overwrites `/usr/local/bin/term-llm` can undo the wrapper.
Verify container Go/Node/Make prerequisites and the updater skill's timeout before
claiming self-update works; an initial frontend/Go build can exceed 120 seconds.
Never hard-reset a user's source tree to make the updater succeed.

Upgrade one idle agent first, verify it, and restart that container once to prove
the volume boot hook restores the new runtime and keeps the separate jobs service
down. Continue with other idle agents only after that check succeeds. Finally
open every node through the Hub and verify its routines as well as its chat UI.

## Troubleshooting and handoff

| Symptom | Check |
|---|---|
| Certificate issuance fails | Public DNS including AAAA, port 80, ACME webroot, and cloud firewall. |
| Nginx rejects `http2 on` | Use the Nginx 1.24-compatible listener shown above. |
| HTTPS returns 502 | `systemctl status term-llm-hub`; loopback `/hub/healthz`; public URL/mount consistency. |
| Streams stall or disconnect | Proxy buffering, WebSocket headers, timeouts, and any additional proxy hop. |
| Passkey setup expired | Before enrollment, restart Hub to reopen its ten-minute window; keep the hostname stable. |
| Assistants appear missing | Original account, HOME/XDG directories, and container resolver; not the listening port. |
| Shared connections fail | Broker port, pinned TLS files, Docker-to-host access, and firewall rules. |
| Routines unavailable | Combined `serve web jobs`, correct base path/token in jobs clients, old jobs service disabled. |
| Restart returns an old version | Exact supervisor executable, volume wrapper, boot hook, image, and upstream self-updater. |
| SSH signing intermittently fails | Reuse a working authenticated connection or retry a failed connection; verify what actually ran before replaying mutations. |

At handoff, report the public URL, full source commit, installed executable,
service account and directories, supervisor commands, enrollment method,
certificate renewal status, and checks actually performed. Include a redacted
command log, backup decision, preserved agent/job counts, and any untested
provider conversation, updater, or reboot. Never include credentials in the
handoff document.

Routine service commands for this guide are:

```bash
systemctl status term-llm-hub
journalctl -u term-llm-hub -n 50 --no-pager
systemctl restart term-llm-hub
```

Treat logs as private operational data. Review and redact them before sharing.
