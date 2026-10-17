#!/bin/sh
# Optional Debian/Ubuntu provisioning. The CLI embeds this file; never run it at startup.
set -eu

fail() { printf 'Server setup: %s\n' "$*" >&2; exit 1; }
domain= email= binary= accept_tos=false
while [ "$#" -gt 0 ]; do
    if [ "$1" = --accept-acme-tos ]; then accept_tos=true; shift; continue; fi
    [ "$#" -ge 2 ] || fail "missing value for $1"
    case "$1" in
        --domain) domain=$2 ;;
        --email) email=$2 ;;
        --binary) binary=$2 ;;
        *) fail "unknown option: $1" ;;
    esac
    shift 2
done
[ "$accept_tos" = true ] || fail 'add --accept-acme-tos to accept the certificate authority subscriber agreement'
if [ -n "$email" ]; then
    case "$email" in -*|*[!a-zA-Z0-9.@_+%-]*) fail 'use a valid email address for certificate notices' ;; esac
    printf '%s\n' "$email" | grep -Eq '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' || fail 'use a valid email address for certificate notices'
fi
case "$domain" in ''|*[!a-z0-9.-]*) fail 'use a public DNS hostname such as bot.example.com, without a URL or path' ;; esac
printf '%s\n' "$domain" | LC_ALL=C grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' ||
    fail 'use a public DNS hostname such as bot.example.com, without a URL or path'
[ "${#domain}" -le 253 ] || fail 'hostname is too long'
printf '%s\n' "$domain" | awk -F. '{ for (i=1; i<=NF; i++) if (length($i)>63) exit 1 }' || fail 'a hostname label is too long'
case "${domain##*.}" in *[a-z]*) ;; *) fail 'use a public DNS hostname, not an IP address' ;; esac
case "$domain" in localhost.*) fail 'use a public DNS hostname, not localhost' ;; esac
[ -n "$binary" ] && [ -f "$binary" ] && [ -x "$binary" ] || fail '--binary must identify an installed executable'
[ "$(id -u)" -eq 0 ] || fail 'run server setup with sudo/root'
[ "$(uname -s)" = Linux ] && [ -d /run/systemd/system ] || fail 'Debian/Ubuntu with systemd is required'
. /etc/os-release
case "$ID" in debian|ubuntu) ;; *) fail 'only Debian and Ubuntu are supported; use the manual server deployment guide' ;; esac
[ -n "${VERSION_CODENAME:-}" ] || fail '/etc/os-release has no VERSION_CODENAME'

account=termllm
site=/etc/nginx/sites-available/term-llm
enabled=/etc/nginx/sites-enabled/term-llm
marker="# Managed by term-llm server setup: $domain"
renew=/etc/letsencrypt/renewal-hooks/deploy/term-llm-nginx-reload
target=/usr/local/lib/term-llm/term-llm
owned=false
saved_broker_host=
if [ -e "$site" ] || [ -L "$site" ]; then
    [ -f "$site" ] && [ ! -L "$site" ] && [ "$(head -n 1 "$site")" = "$marker" ] ||
        fail "$site already exists for another setup; it was left unchanged"
    owned=true
fi
if [ -e "$enabled" ] || [ -L "$enabled" ]; then
    [ -L "$enabled" ] && [ "$(readlink "$enabled")" = "$site" ] || fail "$enabled already exists; it was left unchanged"
fi
if [ -e "$renew" ] || [ -L "$renew" ]; then
    [ -f "$renew" ] && [ ! -L "$renew" ] && [ "$(sed -n '2p' "$renew")" = '# Managed by term-llm server setup' ] ||
        fail "$renew already exists; it was left unchanged"
fi
for unit in /etc/systemd/system/term-llm-hub.service /lib/systemd/system/term-llm-hub.service; do
    [ ! -e "$unit" ] && [ ! -L "$unit" ] || fail "$unit is an existing system Hub; migrate it explicitly before server setup"
done
if getent passwd "$account" >/dev/null; then
    [ "$(getent passwd "$account" | cut -d: -f5)" = 'term-llm server' ] || fail "account $account already exists and is not managed by server setup"
    account_home=$(getent passwd "$account" | cut -d: -f6)
    spec="$account_home/.config/term-llm/services/hub/service.json"
    if [ -e "$spec" ]; then
        [ "$owned" = true ] || fail "existing Hub state in $account_home needs explicit migration"
        command -v python3 >/dev/null || fail 'python3 is required to inspect the existing Hub; install it and rerun'
        saved_broker_host=$(python3 - "$spec" "https://$domain/" <<'PY'
import ipaddress, json, sys
with open(sys.argv[1]) as source:
    saved = json.load(source)
args = saved.get('args', [])
if saved.get('kind') != 'hub' or saved.get('auth') != 'passkey' or saved.get('url') != sys.argv[2] or saved.get('host') != '127.0.0.1' or saved.get('port') != 8090 or '--personal-bot' not in args:
    raise SystemExit('Existing Hub service differs from this server setup; it was left unchanged.')
host = ''
for index, arg in enumerate(args):
    if arg == '--personal-bot-broker-host':
        host = args[index+1] if index+1 < len(args) else ''
    elif arg.startswith('--personal-bot-broker-host='):
        host = arg.split('=', 1)[1]
try:
    address = ipaddress.IPv4Address(host)
except ValueError:
    raise SystemExit('Existing Hub has no valid private broker address; migrate it explicitly.')
if not address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified or address.is_reserved:
    raise SystemExit('Existing Hub broker address is not private; migrate it explicitly.')
print(address)
PY
)
    elif [ -d "$account_home/.config/term-llm/containers" ] || [ -d "$account_home/.local/share/term-llm/hub" ]; then
        fail "existing assistant state in $account_home needs explicit migration"
    fi
    unit="$account_home/.config/systemd/user/term-llm-hub.service"
    if [ -e "$unit" ] || [ -L "$unit" ]; then
        [ -f "$spec" ] && [ -f "$unit" ] && [ ! -L "$unit" ] && grep -Fq 'Managed by term-llm service' "$unit" ||
            fail "$unit is an unrelated user service; it was left unchanged"
    fi
fi
root_config="${XDG_CONFIG_HOME:-$HOME/.config}/term-llm"
root_data="${XDG_DATA_HOME:-$HOME/.local/share}/term-llm"
# The normal binary update check may create this single harmless file before setup.
if [ -d "$root_config" ] && [ -n "$(find "$root_config" -mindepth 1 -maxdepth 1 ! \( -name update-state.json -type f \) -print -quit)" ]; then
    fail "root-owned term-llm state exists at $root_config; use the migration guide instead of creating another catalog"
fi
[ ! -d "$root_data" ] || [ -z "$(ls -A "$root_data")" ] || fail "root-owned term-llm state exists at $root_data; use the migration guide instead of creating another catalog"
for other in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -f "$other" ] || continue
    [ "$other" = "$enabled" ] || ! grep -Fq "$domain" "$other" || fail "$other already uses $domain; it was left unchanged"
done
if command -v ss >/dev/null; then
    if [ "$owned" = false ] && [ -n "$(ss -H -ltn 'sport = :8090')" ]; then
        fail 'port 8090 is occupied; stop or migrate that listener first'
    fi
    for port in 80 443; do
        listeners=$(ss -H -ltnp "sport = :$port")
        [ -z "$listeners" ] || ! printf '%s\n' "$listeners" | grep -v '"nginx"' >/dev/null ||
            fail "port $port is used by another server; configure its HTTPS proxy manually"
    done
fi
if [ -e /usr/local/lib/term-llm ]; then
    [ -d /usr/local/lib/term-llm ] && [ ! -L /usr/local/lib/term-llm ] || fail '/usr/local/lib/term-llm must be a regular directory'
fi
if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target" ] && [ ! -L "$target" ] && [ "$owned" = true ] || fail "$target already exists; it was left unchanged"
fi

printf 'Configuring https://%s/. DNS must point here and public ports 80/443 must be reachable.\n' "$domain"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends ca-certificates curl nginx certbot iproute2 util-linux dbus-user-session python3
if ! command -v docker >/dev/null; then
    if [ -e /etc/apt/sources.list.d/docker.sources ]; then
        grep -Fq '# Managed by term-llm server setup' /etc/apt/sources.list.d/docker.sources ||
            fail 'an existing Docker repository needs attention; install Docker with Compose, then rerun'
    else
        [ ! -e /etc/apt/keyrings/docker.asc ] && [ ! -e /etc/apt/sources.list.d/docker.list ] ||
            fail 'an existing Docker repository needs attention; install Docker with Compose, then rerun'
        install -m 0755 -d /etc/apt/keyrings
        curl --fail --silent --show-error --location "https://download.docker.com/linux/$ID/gpg" --output /etc/apt/keyrings/docker.asc.new
        mv /etc/apt/keyrings/docker.asc.new /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
        cat > /etc/apt/sources.list.d/docker.sources <<EOF
# Managed by term-llm server setup
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    fi
    apt-get update
    apt-get install --yes docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker compose version >/dev/null 2>&1 || fail 'Docker exists but Compose v2 is missing; install its matching Compose plugin and rerun'
systemctl enable --now docker
if ! getent passwd "$account" >/dev/null; then
    useradd --create-home --comment 'term-llm server' --shell /bin/sh "$account"
fi
usermod -aG docker "$account"
account_home=$(getent passwd "$account" | cut -d: -f6)
uid=$(id -u "$account")
as_user() {
    runuser -u "$account" -- env -i HOME="$account_home" USER="$account" LOGNAME="$account" XDG_CONFIG_HOME="$account_home/.config" \
        XDG_DATA_HOME="$account_home/.local/share" XDG_CACHE_HOME="$account_home/.cache" \
        XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$@"
}
as_user docker version >/dev/null || fail 'the service account cannot reach Docker'
broker_host=$(as_user docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
printf '%s\n' "$broker_host" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || fail 'Docker bridge has no IPv4 gateway; configure a private broker address manually'
case "$broker_host" in 10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*) ;; *) fail 'Docker bridge needs a private IPv4 gateway for the connection broker' ;; esac
[ -z "$saved_broker_host" ] || [ "$saved_broker_host" = "$broker_host" ] || fail 'Docker bridge gateway changed; update the saved private broker address explicitly before rerunning'
dropin="/etc/systemd/system/user@$uid.service.d/term-llm.conf"
if [ -e "$dropin" ] || [ -L "$dropin" ]; then
    [ -f "$dropin" ] && [ ! -L "$dropin" ] && [ "$(head -n 1 "$dropin")" = '# Managed by term-llm server setup' ] ||
        fail "$dropin already exists; it was left unchanged"
fi
install -d -m 0755 "$(dirname "$dropin")"
cat > "$dropin" <<'EOF'
# Managed by term-llm server setup
[Unit]
After=docker.service
Wants=docker.service
EOF
systemctl daemon-reload
loginctl enable-linger "$account"
systemctl start "user@$uid.service"
install -d -m 0755 /usr/local/lib/term-llm
chown root:root /usr/local/lib/term-llm
restart_hub=false
if [ "$binary" != "$target" ] && ! cmp -s "$binary" "$target"; then
    [ ! -f "$account_home/.config/term-llm/services/hub/service.json" ] || restart_hub=true
    install -m 0755 "$binary" "$target.new"
    mv -f "$target.new" "$target"
fi

install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled /var/lib/letsencrypt/.well-known/acme-challenge
if [ "$owned" = false ]; then
    cat > "$site" <<EOF
$marker
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ { root /var/lib/letsencrypt; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
fi
[ -L "$enabled" ] || ln -s "$site" "$enabled"
nginx -t
systemctl enable --now nginx
systemctl reload nginx
set -- certonly --webroot --webroot-path /var/lib/letsencrypt --cert-name "$domain" --domain "$domain" --non-interactive --agree-tos --keep-until-expiring
if [ -n "$email" ]; then set -- "$@" --email "$email"; else set -- "$@" --register-unsafely-without-email; fi
certbot "$@" || fail 'certificate issuance failed; check domain A/AAAA DNS and inbound port 80, then rerun'
if ! grep -Fq "ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;" "$site"; then
    cat >> "$site" <<EOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $domain;
    ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 32m;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
fi
nginx -t
systemctl reload nginx
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > "$renew" <<'EOF'
#!/bin/sh
# Managed by term-llm server setup
set -eu
/usr/sbin/nginx -t
/bin/systemctl reload nginx
EOF
chmod 0755 "$renew"
systemctl enable --now certbot.timer

# The existing service owns its passkeys, private enrollment file, and launch spec.
spec="$account_home/.config/term-llm/services/hub/service.json"
if [ -f "$spec" ]; then
    as_user "$target" service install hub --yes --print-setup-link
else
    as_user "$target" service install hub --yes --print-setup-link -- --personal-bot --auth passkey \
        --host 127.0.0.1 --port 8090 --public-url "https://$domain/" --passkey-trusted-proxy 127.0.0.1/32 \
        --personal-bot-broker-host "$broker_host"
fi
[ "$restart_hub" = false ] || as_user "$target" service restart hub
curl --fail --silent --show-error "https://$domain/healthz" >/dev/null || fail 'Hub started but public HTTPS health check failed; check Nginx and DNS'
printf '\nHub starts automatically at boot. Open https://%s/ after enrolling your passkey.\n' "$domain"
