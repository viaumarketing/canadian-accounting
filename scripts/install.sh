#!/bin/sh
# First-time install on the NAS. Run from the folder that holds compose.production.yaml:   sh scripts/install.sh
# It ASKS for every site-specific value (nothing about your NAS is assumed), generates the secrets, creates the data folders,
# and writes .env (mode 600). It never overwrites an existing .env.
# Non-interactive use (tests): set CA_GITHUB_REPOSITORY, CA_APP_VERSION, CA_SITE_ADDRESS, CA_DATA_DIR, CA_HTTPS_PORT, CA_HTTP_PORT.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] && { echo ".env already exists; refusing to overwrite it. Delete it only if you are sure (it holds your encryption key)."; exit 1; }
[ -f .env.production.example ] || { echo "Run this from the folder that contains .env.production.example and compose.production.yaml."; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required."; exit 1; }

ask() { # ask VAR "question" [default] [validation regex] [hint]
  var=$1; q=$2; def=${3:-}; re=${4:-.}; hint=${5:-}
  eval "preset=\${CA_$var:-}"
  while :; do
    if [ -n "$preset" ]; then val=$preset; else
      if [ -n "$def" ]; then printf '%s [%s]: ' "$q" "$def"; else printf '%s: ' "$q"; fi
      read -r val || exit 1; [ -z "$val" ] && val=$def
    fi
    if [ -n "$val" ] && printf '%s' "$val" | grep -Eq "$re"; then eval "$var=\$val"; return; fi
    echo "  Not valid. $hint"; [ -n "$preset" ] && exit 1
  done
}

echo "Canadian Accounting: first-time setup. Press Enter to accept a value in [brackets]."
ask GITHUB_REPOSITORY "GitHub owner/repository that publishes the images (e.g. yourname/canadian-accounting)" "" '^[a-z0-9][a-z0-9._-]*/[a-z0-9._-]+$' "Use lower case: owner/repository."
ask APP_VERSION "Release version to install (e.g. 1.0.0)" "" '^[0-9]+\.[0-9]+\.[0-9]+$' "Use X.Y.Z, as on the GitHub release."
ask SITE_ADDRESS "Name you will type in the browser (no https://)" "" '^[A-Za-z0-9.-]+$' "Letters, digits, dots and dashes only."
ask HTTPS_PORT "HTTPS port to publish on the NAS" "443" '^[0-9]{2,5}$' "A number such as 443 or 8443."
ask HTTP_PORT "HTTP port (only redirects to HTTPS)" "80" '^[0-9]{2,5}$' "A number such as 80 or 8080."
ask DATA_DIR "Absolute path of the folder for all data (on a NAS volume)" "" '^/' "It must start with /."
case "$DATA_DIR" in */) DATA_DIR=${DATA_DIR%/} ;; esac
if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ] && [ ! -d "$DATA_DIR/postgres" ]; then
  echo "$DATA_DIR exists and is not empty. Choose an empty folder."; exit 1
fi

for p in "$HTTPS_PORT" "$HTTP_PORT"; do
  if (command -v ss >/dev/null && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$p\$"); then
    echo "Port $p is already in use on this NAS. Run the script again and choose another one."; exit 1
  fi
done

rand() { openssl rand -base64 "$1" | tr -d '\n'; }
alnum() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
WEB_ORIGIN=""; [ "$HTTPS_PORT" != "443" ] && WEB_ORIGIN="https://$SITE_ADDRESS:$HTTPS_PORT"

umask 077
cp .env.production.example .env
set_kv() { sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; }
set_kv GITHUB_REPOSITORY "$GITHUB_REPOSITORY"
set_kv APP_VERSION "$APP_VERSION"
set_kv SITE_ADDRESS "$SITE_ADDRESS"
set_kv HTTPS_PORT "$HTTPS_PORT"
set_kv HTTP_PORT "$HTTP_PORT"
set_kv WEB_ORIGIN "$WEB_ORIGIN"
set_kv DATA_DIR "$DATA_DIR"
set_kv POSTGRES_PASSWORD "$(alnum 32)"
set_kv ENCRYPTION_KEY "$(rand 32)"
set_kv BACKUP_PASSPHRASE "$(alnum 40)"
set_kv SETUP_TOKEN "$(alnum 24)"
chmod 600 .env

mkdir -p "$DATA_DIR/postgres" "$DATA_DIR/redis" "$DATA_DIR/documents" "$DATA_DIR/backups" "$DATA_DIR/caddy/data" "$DATA_DIR/caddy/config"
echo
echo "Done. .env written (mode 600) and folders created under $DATA_DIR."
echo "Next:  docker compose -f compose.production.yaml pull && docker compose -f compose.production.yaml up -d"
echo "Then open https://$SITE_ADDRESS$( [ "$HTTPS_PORT" != 443 ] && printf ':%s' "$HTTPS_PORT") and create the administrator with the SETUP_TOKEN in .env:"
echo "  grep SETUP_TOKEN .env"
echo "IMPORTANT: copy .env to a USB stick or password manager now. Without ENCRYPTION_KEY and BACKUP_PASSPHRASE your backups cannot be used."
