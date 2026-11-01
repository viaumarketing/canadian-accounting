# Shared helpers for the operations scripts (sourced, not run).
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env here. Run these scripts from the folder that holds compose.production.yaml and .env." >&2; exit 1; }
[ -f compose.production.yaml ] || { echo "compose.production.yaml not found." >&2; exit 1; }
dc() { docker compose -f compose.production.yaml "$@"; }
env_get() { grep "^$1=" .env | head -n 1 | cut -d= -f2-; }
env_set() { sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; }
# Wait until a service reports healthy (or the timeout passes).
wait_healthy() {
  svc="$1"; tries="${2:-60}"
  while [ "$tries" -gt 0 ]; do
    h=$(dc ps "$svc" --format '{{.Health}}' 2>/dev/null || true)
    [ "$h" = "healthy" ] && return 0
    tries=$((tries - 1)); sleep 5
  done
  return 1
}
# Pull the release images. SKIP_PULL=1 uses images already on this machine (for example loaded with `docker load` when the NAS cannot reach the registry).
pull_images() {
  [ "${SKIP_PULL:-}" = "1" ] && return 0
  dc pull api worker web backup migrate prepare
}
# Schema compatibility level stored in the live database (empty if unknown).
db_schema_level() {
  dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT level FROM \"SchemaCompat\" WHERE id = 1"' 2>/dev/null | tr -d '[:space:]' || true
}
# Highest schema level the running api build supports (empty if unknown).
app_schema_level() {
  dc exec -T api node -e "fetch('http://127.0.0.1:4000/health').then(r=>r.json()).then(j=>console.log(j.schemaLevel??''))" 2>/dev/null | tr -d '[:space:]' || true
}
