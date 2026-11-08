#!/usr/bin/env bash
set -euo pipefail

GEOSERVER_VERSION="2.25.2"
GEOSERVER_HOME="/opt/geoserver"
GEOSERVER_DATA_DIR="/opt/geoserver_data"
GEOSERVER_TMP="/tmp/geoserver-setup"
GEOSERVER_HOST="127.0.0.1"          # GeoServer only listens locally; Nginx is the only way in
GEOSERVER_PORT="8080"
GEOSERVER_UPSTREAM="${GEOSERVER_HOST}:${GEOSERVER_PORT}"

AUTH_HOME="/opt/geoserver-auth"
AUTH_ENV_FILE="/etc/geoserver-auth.env"
AUTH_BIND="127.0.0.1:5000"

# Name of the Nginx site file: /etc/nginx/sites-available/<NGINX_SITE_NAME>
# It MUST be the same name install_dide.sh uses (PROJECT_NAME="dide").
# Certbot writes the certificate lines into this same file.
NGINX_SITE_NAME="dide"
NODE_UPSTREAM="127.0.0.1:3000"
NGINX_SNIPPET="/etc/nginx/snippets/dide-geoserver.conf"
NGINX_HTTP_CONF="/etc/nginx/conf.d/dide-wfs.conf"
INCLUDE_LINE="include ${NGINX_SNIPPET};"

# GeoServer workspaces (one per audience) — re-created on every run
WS_SUPERVISOR="dide_supervisor"
WS_EXPERT="dide_expert"
WS_OPEN="dide_open"
WS_LEGACY="dide_workspace"          # created by older versions of this script → removed
DATASTORE="dide_ds"
DB_SCHEMA="public"

ENV_FILE=""
GS_ADMIN_USER=""
GS_ADMIN_PASS=""
NGINX_SERVER_NAME=""
NODE_UPSTREAM_SET=0

die()  { echo -e "\nERROR: $*" >&2; exit 1; }
log()  { echo -e "\n=== $* ==="; }
warn() { echo "WARNING: $*" >&2; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }
is_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]]; }
sql_quote_literal() { local s="$1"; s="${s//\'/\'\'}"; printf "'%s'" "$s"; }
xml_escape() { python3 -c 'import sys,html; sys.stdout.write(html.escape(sys.stdin.read(), quote=False))'; }

usage() {
  cat <<'USAGE'
Usage:
  sudo bash GEOSERVER_WFS_setup.sh --env-file /var/www/dide/DiDe-Web/.env \
       --gs-admin-user admin --gs-admin-pass geoserver [options]

Required:
  --env-file PATH            DiDe .env file (in the project folder)
  --gs-admin-user USER       GeoServer admin user (fresh install: admin)
  --gs-admin-pass PASS       GeoServer admin password (fresh install: geoserver)

Optional:
  --nginx-site NAME          Nginx site file name (default: dide — same as install_dide.sh)
  --server-name DOMAIN       Public domain (normally detected from Nginx / certbot;
                             used for the GeoServer web-UI CSRF whitelist and the printed links)
  --node-upstream HOST:PORT  Node app address (default: 127.0.0.1:<PORT from .env>)
  --geoserver-version VER    GeoServer version to install (default: 2.25.2)
  --db-schema NAME           Database schema (default: public)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2;;
    --gs-admin-user) GS_ADMIN_USER="$2"; shift 2;;
    --gs-admin-pass) GS_ADMIN_PASS="$2"; shift 2;;
    --nginx-site) NGINX_SITE_NAME="$2"; shift 2;;
    --server-name) NGINX_SERVER_NAME="$2"; shift 2;;
    --node-upstream) NODE_UPSTREAM="$2"; NODE_UPSTREAM_SET=1; shift 2;;
    --geoserver-version) GEOSERVER_VERSION="$2"; shift 2;;
    --db-schema) DB_SCHEMA="$2"; shift 2;;
    --workspace|--datastore)
      warn "$1 is no longer used (workspaces: ${WS_SUPERVISOR}, ${WS_EXPERT}, ${WS_OPEN}) — ignored."
      shift 2;;
    -h|--help) usage; exit 0;;
    *) die "Unknown argument: $1 (use --help)";;
  esac
done

GEOSERVER_ZIP_URL="https://sourceforge.net/projects/geoserver/files/GeoServer/${GEOSERVER_VERSION}/geoserver-${GEOSERVER_VERSION}-bin.zip/download"

[[ -n "$ENV_FILE" ]] || { usage; die "--env-file is required"; }
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
[[ -n "$GS_ADMIN_USER" ]] || die "--gs-admin-user is required"
[[ -n "$GS_ADMIN_PASS" ]] || die "--gs-admin-pass is required"
is_root || die "Run as root (use sudo)."

ENV_FILE="$(readlink -f "$ENV_FILE")"
PROJECT_DIR="$(dirname "$ENV_FILE")"

# -----------------------------------------------------------------------------
# .env — only the keys this script needs are read (same parsing rules as
# install_dide.sh), so no .env key can overwrite a variable of this script.
# -----------------------------------------------------------------------------
get_env_value() {
  local key="$1" val
  val="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | head -n 1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*=//" || true)"
  val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//')"
  val="$(printf '%s' "$val" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  val="$(printf '%s' "$val" | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')"
  printf '%s' "$val"
}

log "Loading settings from $ENV_FILE"
PGDATABASE="$(get_env_value PGDATABASE)"
PGUSER="$(get_env_value PGUSER)"
PGPASSWORD="$(get_env_value PGPASSWORD)"
PGHOST="$(get_env_value PGHOST)"; PGHOST="${PGHOST:-127.0.0.1}"   # same defaults as index.js
PGPORT="$(get_env_value PGPORT)"; PGPORT="${PGPORT:-5432}"
APP_PORT="$(get_env_value PORT)"
AGGREGATION_LAYER="$(get_env_value AGGREGATION_LAYER)"
CASE_STUDY="$(get_env_value CASE_STUDY)"
OPEN_DATA_RAW="$(get_env_value OPEN_DATA)"

[[ -n "$PGDATABASE" ]] || die "PGDATABASE missing in env file"
[[ -n "$PGUSER" ]]     || die "PGUSER missing in env file"
[[ -n "$PGPASSWORD" ]] || die "PGPASSWORD missing in env file"
export PGPASSWORD

# OPEN_DATA — same rule as index.js: empty → false; anything but true/false → error
case "$(printf '%s' "$OPEN_DATA_RAW" | tr '[:upper:]' '[:lower:]')" in
  true)     OPEN_DATA=1 ;;
  false|"") OPEN_DATA=0 ;;
  *) die "OPEN_DATA in .env must be true or false (current: \"$OPEN_DATA_RAW\")";;
esac

if [[ $NODE_UPSTREAM_SET -eq 0 && -n "$APP_PORT" ]]; then
  NODE_UPSTREAM="127.0.0.1:${APP_PORT}"
fi

echo "Project dir        : $PROJECT_DIR"
echo "Database           : $PGDATABASE (user: $PGUSER, $PGHOST:$PGPORT)"
if [[ $OPEN_DATA -eq 1 ]]; then echo "OPEN_DATA          : true  → 2 WFS links (authenticated + open)"
else                            echo "OPEN_DATA          : false → 1 WFS link (authenticated only)"; fi
echo "AGGREGATION_LAYER  : ${AGGREGATION_LAYER:-<not set>}"

# -----------------------------------------------------------------------------
# Nginx site — must already exist (created by install_dide.sh). This script never
# creates a second, competing site (that used to break the certbot certificate).
# -----------------------------------------------------------------------------
NGINX_CONF="/etc/nginx/sites-available/${NGINX_SITE_NAME}"
if [[ ! -f "$NGINX_CONF" ]]; then
  for _f in /etc/nginx/sites-enabled/*; do
    [[ -f "$_f" ]] || continue
    if grep -q "proxy_pass[[:space:]]\+http://${NODE_UPSTREAM}" "$_f" 2>/dev/null; then
      NGINX_CONF="$(readlink -f "$_f")"; NGINX_SITE_NAME="$(basename "$NGINX_CONF")"; break
    fi
  done
fi
[[ -f "$NGINX_CONF" ]] || die "Nginx site config not found (/etc/nginx/sites-available/${NGINX_SITE_NAME}).
       Run docs/initial_setup/install_dide.sh first (it creates the site), or pass --nginx-site NAME."
echo "Nginx site config  : $NGINX_CONF"

log "Installing packages (the existing Nginx configuration is not modified)"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y unzip curl wget openjdk-17-jre-headless \
  python3 python3-venv python3-pip postgresql-client nginx

need_cmd curl; need_cmd psql; need_cmd nginx; need_cmd java; need_cmd unzip; need_cmd python3

PSQL=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -tAq)

log "Checking Postgres connectivity and DiDe tables"
"${PSQL[@]}" -c "SELECT 1;" >/dev/null || die "Cannot connect to PostgreSQL with the .env credentials."
for _t in event event_type users; do
  _ok="$("${PSQL[@]}" -c "SELECT 1 FROM information_schema.tables WHERE table_schema=$(sql_quote_literal "$DB_SCHEMA") AND table_name=$(sql_quote_literal "$_t") LIMIT 1;")"
  [[ "$_ok" == "1" ]] || die "Table ${DB_SCHEMA}.${_t} not found. Run install_dide.sh and start the app (pm2) once first."
done

valid_ident() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; }
qi() { printf '"%s"' "$1"; }   # quoted identifier (names are checked with valid_ident)

# -----------------------------------------------------------------------------
# Data mode — the same decision index.js makes:
#   AGGREGATION_LAYER set               → grid summary (opener/solver + open data)
#   AGGREGATION_LAYER + boundary file   → grid cells clipped to the boundary
#   no AGGREGATION_LAYER                → single events (points)
# -----------------------------------------------------------------------------
AGG_TABLE=""
declare -a PK_COLS=()
INTERSECTION=0
if [[ -n "$AGGREGATION_LAYER" ]]; then
  # Same table name rule as index.js (file name without extension, lowercase, [^a-z0-9_] → _)
  _b="$(basename "$AGGREGATION_LAYER")"; _b="${_b%.*}"
  AGG_TABLE="$(printf '%s' "$_b" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_]/_/g')"
  valid_ident "$AGG_TABLE" || die "Unsupported aggregation table name: $AGG_TABLE"
  _ok="$("${PSQL[@]}" -c "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$(sql_quote_literal "$AGG_TABLE") LIMIT 1;")"
  [[ "$_ok" == "1" ]] || die "Aggregation layer table public.${AGG_TABLE} not found (AGGREGATION_LAYER=${AGGREGATION_LAYER})."
  mapfile -t PK_COLS < <("${PSQL[@]}" -c "
    SELECT kcu.column_name FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema='public' AND lower(tc.table_name)=lower($(sql_quote_literal "$AGG_TABLE"))
       AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position;" | sed '/^$/d')
  [[ ${#PK_COLS[@]} -gt 0 ]] || die "Table public.${AGG_TABLE} has no PRIMARY KEY (the app requires one)."
  for _c in "${PK_COLS[@]}"; do valid_ident "$_c" || die "Unsupported primary key column name: $_c"; done

  # Boundary file → intersection mode (index.js loads it into public.dide_boundary at start-up)
  if [[ -n "$CASE_STUDY" ]]; then
    for _n in boundary.geojson boundary.geopackage boundary.gpkg boundary.json; do
      if [[ -f "${PROJECT_DIR}/case_study/${CASE_STUDY}/existing_data/${_n}" ]]; then
        _rows="$("${PSQL[@]}" -c "SELECT CASE WHEN to_regclass('public.dide_boundary') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.dide_boundary WHERE geom IS NOT NULL) END;" 2>/dev/null || echo 0)"
        if [[ "${_rows:-0}" =~ ^[0-9]+$ && "${_rows}" -gt 0 ]]; then
          INTERSECTION=1
        else
          warn "Boundary file ${_n} exists but public.dide_boundary is empty — start the app once, then re-run this script."
        fi
        break
      fi
    done
  fi
  if [[ $INTERSECTION -eq 1 ]]; then
    echo "Data mode          : grid summary (${AGG_TABLE} ∩ boundary, PK: ${PK_COLS[*]})"
  else
    echo "Data mode          : grid summary (${AGG_TABLE}, PK: ${PK_COLS[*]})"
  fi
else
  echo "Data mode          : single events (no aggregation layer)"
fi

# Aggregation PK columns that exist in the event table (the app adds them at start-up)
declare -a EVENT_PK_COLS=()
for _c in "${PK_COLS[@]}"; do
  _ok="$("${PSQL[@]}" -c "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='event' AND column_name=$(sql_quote_literal "$_c") LIMIT 1;")"
  if [[ "$_ok" == "1" ]]; then EVENT_PK_COLS+=("$_c"); fi
done

# -----------------------------------------------------------------------------
# SQL views — each reproduces the matching download of index.js.
# -----------------------------------------------------------------------------
# '["/uploads/a.jpg"]' → '["a.jpg"]'  (file names, exactly as listed in the ZIP)
RE_DIR='[^"\[\],]*/'
url_names() { printf "regexp_replace(COALESCE(%s,'[]'), '%s', '', 'g')" "$1" "$RE_DIR"; }
point_of() { printf "CASE WHEN %s.latitude IS NOT NULL AND %s.longitude IS NOT NULL THEN ST_SetSRID(ST_MakePoint(%s.longitude, %s.latitude), 4326) END" "$1" "$1" "$1" "$1"; }
# publicGoodBadWhere() in index.js (SHOW_GOOD_EVENTS_ON_LOGIN=true, SHOW_BAD_EVENTS_ON_LOGIN=false)
PUBLIC_WHERE='o."public_" = TRUE'
UID_TOKEN='%uid%'

join_cols() { local pfx="$1"; shift; local out="" c; for c in "$@"; do out+="${out:+, }${pfx}$(qi "$c")"; done; printf '%s' "$out"; }

# Supervisor — Admin panel → Events → download: all ACTIVE events, full columns
sql_supervisor_events() {
  local pk=""
  if [[ ${#EVENT_PK_COLS[@]} -gt 0 ]]; then pk=", $(join_cols 'o.' "${EVENT_PK_COLS[@]}")"; fi
  cat <<SQL
SELECT o.event_id, o.latitude, o.longitude, l.event_type_name AS event_type, o.description,
       o.created_by_name, o.created_by_id, o.created_at,
       $(url_names o.photo_urls) AS photo_urls, $(url_names o.video_urls) AS video_urls${pk},
       o.updated_by_name, o.updated_by_id, o.updated_at,
       COALESCE(o.num_agrees, 0) AS num_agrees, o.last_agreed_date, o.direction,
       $(point_of o) AS geom
  FROM public.event o
  LEFT JOIN public.event_type l ON l.event_type_id = o.event_type
 WHERE COALESCE(o.active, true) = true
SQL
}

# Opener/solver, no aggregation layer — profile → download: events I added (points)
sql_expert_events() {
  cat <<SQL
SELECT o.event_id, o.latitude, o.longitude, l.event_type_name AS event_type, o.description,
       COALESCE(o.active, true) AS active, o.deactivated_by_name, o.deactivated_at, o.created_at,
       $(url_names o.photo_urls) AS photo_urls, $(url_names o.video_urls) AS video_urls,
       COALESCE(o.num_agrees, 0) AS num_agrees, o.last_agreed_date, o.direction,
       COALESCE(o.geom, $(point_of o)) AS geom
  FROM public.event o
  LEFT JOIN public.event_type l ON l.event_type_id = o.event_type
 WHERE o.created_by_id = ${UID_TOKEN}
SQL
}

# Citizen, no aggregation layer — open data: public ACTIVE events, no personal data
sql_open_events() {
  cat <<SQL
SELECT e.event_id, e.latitude, e.longitude, o.event_type_name AS event_type, e.description,
       e.created_at, $(url_names e.photo_urls) AS photo_urls,
       COALESCE(e.num_agrees, 0) AS num_agrees, e.direction,
       ST_SetSRID(ST_MakePoint(e.longitude, e.latitude), 4326) AS geom
  FROM public.event e
  JOIN public.event_type o ON o.event_type_id = e.event_type
 WHERE COALESCE(e.active, true) = true
   AND COALESCE(o.active, true) = true
   AND (${PUBLIC_WHERE})
   AND e.latitude IS NOT NULL AND e.longitude IS NOT NULL
SQL
}

# Grid summary — same as buildGridSummary() in index.js
#   events are counted per grid cell (ev = event, o = event_type); in intersection
#   mode only events inside the boundary count and the cells are clipped to it.
_grid_cte() {
  local where="$1" pkp b_cte="" b_from="" b_cond=""
  pkp="$(join_cols 'p.' "${PK_COLS[@]}")"
  if [[ $INTERSECTION -eq 1 ]]; then
    b_cte="b AS (SELECT ST_Union(ST_MakeValid(geom)) AS u FROM public.dide_boundary WHERE geom IS NOT NULL),"
    b_from=", b"
    b_cond="AND ST_Contains(b.u, ev.geom)"
  fi
  cat <<SQL
WITH ${b_cte}
evx AS (
  SELECT ${pkp}, COALESCE(o.event_type_name, '—') AS type_name,
         COALESCE(ev.active, true) AS is_active
    FROM public.event ev
    JOIN public.event_type o ON o.event_type_id = ev.event_type
    JOIN public.$(qi "$AGG_TABLE") p ON ST_Contains(p.geom, ev.geom)${b_from}
   WHERE ev.geom IS NOT NULL
     ${b_cond}
     AND (${where})
)
SQL
}

# grid_events — one feature per grid cell; $2=1 → also active_count / closed_count
sql_grid_events() {
  local where="$1" with_status="$2" pk cpk geom_expr b_from="" join_cond="" c status=""
  pk="$(join_cols '' "${PK_COLS[@]}")"
  cpk="$(join_cols 'c.' "${PK_COLS[@]}")"
  for c in "${PK_COLS[@]}"; do join_cond+="${join_cond:+ AND }t.$(qi "$c") = c.$(qi "$c")"; done
  if [[ $INTERSECTION -eq 1 ]]; then
    geom_expr="CASE WHEN ST_CoveredBy(t.geom, b.u) THEN t.geom ELSE ST_CollectionExtract(ST_Intersection(ST_MakeValid(t.geom), b.u), 3) END"
    b_from=", b"
  else
    geom_expr="t.geom"
  fi
  if [[ "$with_status" == "1" ]]; then status=", c.active_count, (c.event_count - c.active_count) AS closed_count"; fi
  _grid_cte "$where"
  cat <<SQL
, c AS (
  SELECT ${pk}, COUNT(*)::int AS event_count,
         SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int AS active_count
    FROM evx GROUP BY ${pk}
)
SELECT ${cpk}, c.event_count${status},
       ST_Multi(g.geom)::geometry(MultiPolygon, 4326) AS geom
  FROM c
  JOIN LATERAL (
    SELECT ${geom_expr} AS geom
      FROM public.$(qi "$AGG_TABLE") t${b_from}
     WHERE ${join_cond} AND t.geom IS NOT NULL
     LIMIT 1
  ) g ON TRUE
 WHERE g.geom IS NOT NULL AND NOT ST_IsEmpty(g.geom) AND ST_Area(g.geom) > 0
SQL
}

# grid_event_types — normalized table: one row per grid cell × event type (no geometry)
sql_grid_types() {
  local where="$1" with_status="$2" pk status=""
  pk="$(join_cols '' "${PK_COLS[@]}")"
  if [[ "$with_status" == "1" ]]; then status=",
       SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int AS active_count,
       SUM(CASE WHEN is_active THEN 0 ELSE 1 END)::int AS closed_count"; fi
  _grid_cte "$where"
  cat <<SQL
SELECT ${pk}, type_name AS event_type, COUNT(*)::int AS "count"${status}
  FROM evx
 GROUP BY ${pk}, type_name
SQL
}

# Profile (opener/solver): events the user ADDED or CLOSED (ME_GRID_WHERE in index.js)
EXPERT_GRID_WHERE="ev.created_by_id = ${UID_TOKEN} OR ev.deactivated_by_id = ${UID_TOKEN}"
OPEN_GRID_WHERE="COALESCE(ev.active, true) = true AND COALESCE(o.active, true) = true AND (${PUBLIC_WHERE})"

# Every SQL view is validated against the database BEFORE GeoServer is touched
check_sql() {
  local name="$1" sql="$2"
  sql="${sql//"$UID_TOKEN"/0}"
  if ! "${PSQL[@]}" -c "SELECT * FROM (${sql}) AS vtable LIMIT 0;" >/dev/null 2>/tmp/dide_sqlcheck.txt; then
    cat /tmp/dide_sqlcheck.txt >&2
    die "SQL check failed for layer ${name}"
  fi
}
log "Validating SQL views against the database"
check_sql events "$(sql_supervisor_events)"
if [[ -n "$AGG_TABLE" ]]; then
  check_sql grid_events      "$(sql_grid_events "$EXPERT_GRID_WHERE" 1)"
  check_sql grid_event_types "$(sql_grid_types  "$EXPERT_GRID_WHERE" 1)"
  check_sql open_grid_events "$(sql_grid_events "$OPEN_GRID_WHERE" 0)"
  check_sql open_grid_types  "$(sql_grid_types  "$OPEN_GRID_WHERE" 0)"
else
  check_sql my_events   "$(sql_expert_events)"
  check_sql open_events "$(sql_open_events)"
fi
rm -f /tmp/dide_sqlcheck.txt
echo "OK"

# -----------------------------------------------------------------------------
# GeoServer installation + systemd service
# -----------------------------------------------------------------------------
log "Creating system users and directories"
adduser --system --group --home "$GEOSERVER_HOME" --shell /usr/sbin/nologin geoserver >/dev/null 2>&1 || true
adduser --system --group --home "$AUTH_HOME" --shell /usr/sbin/nologin geoserver-auth >/dev/null 2>&1 || true
mkdir -p "$GEOSERVER_HOME" "$GEOSERVER_DATA_DIR" "$GEOSERVER_TMP" "$AUTH_HOME"
chown -R geoserver:geoserver "$GEOSERVER_DATA_DIR" "$GEOSERVER_TMP"
chown -R geoserver-auth:geoserver-auth "$AUTH_HOME"

if [[ ! -f "$GEOSERVER_HOME/start.jar" ]]; then
  log "Downloading and installing GeoServer ${GEOSERVER_VERSION}"
  tmpzip="/tmp/geoserver-${GEOSERVER_VERSION}-bin.zip"
  rm -f "$tmpzip"
  wget -q -O "$tmpzip" "$GEOSERVER_ZIP_URL" || die "GeoServer download failed: $GEOSERVER_ZIP_URL"
  rm -rf "$GEOSERVER_TMP/geoserver-unpack"; mkdir -p "$GEOSERVER_TMP/geoserver-unpack"
  unzip -q "$tmpzip" -d "$GEOSERVER_TMP/geoserver-unpack"
  _jar="$(find "$GEOSERVER_TMP/geoserver-unpack" -maxdepth 2 -name start.jar | head -n 1)"
  [[ -n "$_jar" ]] || die "start.jar not found in the GeoServer archive"
  inner_dir="$(dirname "$_jar")"
  rm -rf "${GEOSERVER_HOME:?}"/*
  shopt -s dotglob; mv "$inner_dir"/* "$GEOSERVER_HOME"/; shopt -u dotglob
  rm -rf "$tmpzip" "$GEOSERVER_TMP/geoserver-unpack"
fi
chown -R geoserver:geoserver "$GEOSERVER_HOME"

# Java heap from RAM: 25 % (256 MB … 2 GB). The old fixed 2 GB heap starved
# Node / PostgreSQL on small servers → the site answered with 502/504.
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
XMX=$(( MEM_MB / 4 ))
if (( XMX < 256 )); then XMX=256; fi
if (( XMX > 2048 )); then XMX=2048; fi
XMS=$(( XMX < 256 ? XMX : 256 ))

# Public domain(s): --server-name, server_name lines of the site, certbot folders
declare -a _DOMAINS=()
if [[ -n "$NGINX_SERVER_NAME" ]]; then _DOMAINS+=("$NGINX_SERVER_NAME"); fi
while read -r _d; do
  [[ -z "$_d" || "$_d" == "_" || "$_d" == "localhost" || "$_d" == "example.com" ]] && continue
  _DOMAINS+=("$_d")
done < <(grep -oP '^\s*server_name\s+\K[^;]+' "$NGINX_CONF" 2>/dev/null | tr ' \t' '\n\n' | sed '/^$/d' | sort -u || true)
for _le in /etc/letsencrypt/live/*/; do
  [[ -d "$_le" ]] || continue
  _c="$(basename "$_le")"; [[ "$_c" == "README" ]] && continue
  _DOMAINS+=("$_c")
done
PRIMARY_DOMAIN=""
CSRF_WHITELIST=""
if [[ ${#_DOMAINS[@]} -gt 0 ]]; then
  PRIMARY_DOMAIN="${_DOMAINS[0]}"
  CSRF_WHITELIST="$(printf '%s\n' "${_DOMAINS[@]}" | awk '!seen[$0]++' | paste -sd, -)"
fi
CSRF_ENV_LINE=""
if [[ -n "$CSRF_WHITELIST" ]]; then CSRF_ENV_LINE="Environment=GEOSERVER_CSRF_WHITELIST=${CSRF_WHITELIST}"; fi

log "Configuring systemd service for GeoServer (heap ${XMX} MB, listening on ${GEOSERVER_UPSTREAM} only)"
cat >/etc/systemd/system/geoserver.service <<EOF
[Unit]
Description=GeoServer (Jetty) for DiDe
After=network.target postgresql.service

[Service]
User=geoserver
Group=geoserver
WorkingDirectory=${GEOSERVER_HOME}
Environment=GEOSERVER_DATA_DIR=${GEOSERVER_DATA_DIR}
${CSRF_ENV_LINE}
Environment=LANG=C.UTF-8
Environment=LC_ALL=C.UTF-8
ExecStart=/usr/bin/java -Xms${XMS}m -Xmx${XMX}m \\
  -Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8 \\
  -Dorg.geotools.referencing.forceXY=true \\
  -DGEOSERVER_DATA_DIR=${GEOSERVER_DATA_DIR} \\
  -jar start.jar jetty.http.host=${GEOSERVER_HOST} jetty.http.port=${GEOSERVER_PORT}
Restart=on-failure
RestartSec=5
TimeoutStartSec=300
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable geoserver >/dev/null 2>&1
systemctl restart geoserver

GS_REST="http://${GEOSERVER_UPSTREAM}/geoserver/rest"
GS_AUTH="${GS_ADMIN_USER}:${GS_ADMIN_PASS}"

log "Waiting for the GeoServer REST API (the first start can take a few minutes)"
_ready=0
for _i in $(seq 1 120); do
  _code="$(curl -s -o /dev/null -w '%{http_code}' -u "$GS_AUTH" "${GS_REST}/about/version.json" || true)"
  if [[ "$_code" == "200" ]]; then _ready=1; break; fi
  if [[ "$_code" == "401" ]]; then die "GeoServer rejected --gs-admin-user / --gs-admin-pass (HTTP 401)."; fi
  sleep 3
done
[[ $_ready -eq 1 ]] || die "GeoServer did not start in time. Check: journalctl -u geoserver -n 100"
echo "GeoServer is up."

# -----------------------------------------------------------------------------
# Auth service — checks DiDe user name + password for the /wfs link
# -----------------------------------------------------------------------------
log "Writing auth service env file"
cat >"$AUTH_ENV_FILE" <<EOF
PGHOST=${PGHOST}
PGPORT=${PGPORT}
PGDATABASE=${PGDATABASE}
PGUSER=${PGUSER}
PGPASSWORD=${PGPASSWORD}
DIDE_SCHEMA=${DB_SCHEMA}
AUTH_CACHE_TTL=60
EOF
chown root:geoserver-auth "$AUTH_ENV_FILE"
chmod 640 "$AUTH_ENV_FILE"

log "Installing auth service (Flask/Gunicorn)"
cat >"${AUTH_HOME}/app.py" <<'PY'
"""DiDe WFS auth service (called by Nginx auth_request).

200 + headers  X-DiDe-WS: supervisor | expert   X-DiDe-UID: <users.id>
401            missing / wrong credentials (Nginx then asks for user name + password)
403            forbidden request (not GET/HEAD, or a client-supplied "viewparams")

Roles (same as the web app):
  supervisor, admin       → supervisor data (Admin panel → Events → download)
  user (opener / solver)  → own data (profile → download my data)
"""
import base64
import hashlib
import os
import threading
import time
from urllib.parse import parse_qsl, urlsplit

import bcrypt
import psycopg2
from flask import Flask, Response, request

app = Flask(__name__)


def env(name, default=None):
    v = os.getenv(name)
    return v if v not in (None, "") else default


SCHEMA = env("DIDE_SCHEMA", "public")
CACHE_TTL = int(env("AUTH_CACHE_TTL", "60"))
_cache = {}
_lock = threading.Lock()


def get_conn():
    return psycopg2.connect(
        host=env("PGHOST", "127.0.0.1"), port=int(env("PGPORT", "5432")),
        dbname=env("PGDATABASE"), user=env("PGUSER"), password=env("PGPASSWORD"),
        connect_timeout=5,
    )


def lookup(username, password):
    """('supervisor' | 'expert', user_id) or None."""
    sql = (
        f'SELECT id, password_hash, lower(role) FROM "{SCHEMA}".users '
        "WHERE lower(btrim(username)) = lower(btrim(%s)) "
        "AND COALESCE(is_active, true) = true "
        "AND COALESCE(email_verified, false) = true "
        "AND lower(role) IN ('user', 'supervisor', 'admin') "
        "ORDER BY id DESC LIMIT 25"
    )
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, (username,))
            rows = cur.fetchall()
    finally:
        conn.close()
    for uid, pw_hash, role in rows:
        if not pw_hash:
            continue
        h = pw_hash if isinstance(pw_hash, (bytes, bytearray)) else str(pw_hash).encode("utf-8")
        try:
            if bcrypt.checkpw(password.encode("utf-8"), h):
                return ("supervisor" if role in ("supervisor", "admin") else "expert", int(uid))
        except Exception:
            continue
    return None


def cached_lookup(username, password):
    # GIS clients send the credentials with every request; bcrypt is slow on purpose
    key = hashlib.sha256(f"{username}\0{password}".encode("utf-8")).hexdigest()
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    res = lookup(username, password)
    if res:
        with _lock:
            if len(_cache) > 5000:
                _cache.clear()
            _cache[key] = (now + CACHE_TTL, res)
    return res


def parse_basic_auth(header):
    if not header or not header.lower().startswith("basic "):
        return None, None
    try:
        decoded = base64.b64decode(header.split(" ", 1)[1].strip()).decode("utf-8")
        if ":" not in decoded:
            return None, None
        u, p = decoded.split(":", 1)
        return u, p
    except Exception:
        return None, None


@app.get("/auth")
def auth():
    method = request.headers.get("X-Original-Method", "GET").upper()
    if method not in ("GET", "HEAD"):
        return Response("Forbidden", status=403)
    # The data of each user is selected with a server-side view parameter (uid);
    # a client must never be able to send its own one.
    query = urlsplit(request.headers.get("X-Original-URI", "")).query
    for k, _ in parse_qsl(query, keep_blank_values=True):
        if k.strip().lower() == "viewparams":
            return Response("Forbidden", status=403)

    u, p = parse_basic_auth(request.headers.get("Authorization", ""))
    if not u or p is None:
        return Response("Unauthorized", status=401)
    try:
        res = cached_lookup(u, p)
    except Exception:
        return Response("Unauthorized", status=401)
    if not res:
        return Response("Unauthorized", status=401)
    ws, uid = res
    resp = Response("OK", status=200)
    resp.headers["X-DiDe-WS"] = ws
    resp.headers["X-DiDe-UID"] = str(uid)
    return resp


@app.get("/health")
def health():
    return Response("OK", status=200)
PY
chown geoserver-auth:geoserver-auth "${AUTH_HOME}/app.py"

if [[ ! -x "${AUTH_HOME}/venv/bin/python" ]]; then
  sudo -u geoserver-auth python3 -m venv "${AUTH_HOME}/venv"
fi
sudo -u geoserver-auth "${AUTH_HOME}/venv/bin/pip" install -q --upgrade pip
sudo -u geoserver-auth "${AUTH_HOME}/venv/bin/pip" install -q flask gunicorn psycopg2-binary bcrypt

cat >/etc/systemd/system/geoserver-auth.service <<EOF
[Unit]
Description=DiDe WFS Auth Service (Flask/Gunicorn)
After=network.target postgresql.service

[Service]
User=geoserver-auth
Group=geoserver-auth
WorkingDirectory=${AUTH_HOME}
EnvironmentFile=${AUTH_ENV_FILE}
ExecStart=${AUTH_HOME}/venv/bin/gunicorn --bind ${AUTH_BIND} --workers 2 --threads 4 --timeout 30 app:app
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable geoserver-auth >/dev/null 2>&1
systemctl restart geoserver-auth

# -----------------------------------------------------------------------------
# GeoServer configuration through REST (localhost only)
# -----------------------------------------------------------------------------
gs_req() {   # METHOD URL [XML_FILE] → prints the HTTP code (response body in /tmp/gs_resp.txt)
  local method="$1" url="$2" file="${3:-}"
  if [[ -n "$file" ]]; then
    curl -sS -o /tmp/gs_resp.txt -w "%{http_code}" -u "$GS_AUTH" -X "$method" \
      -H "Content-Type: text/xml" --data-binary @"$file" "$url" || echo 000
  else
    curl -sS -o /tmp/gs_resp.txt -w "%{http_code}" -u "$GS_AUTH" -X "$method" "$url" || echo 000
  fi
}
gs_ok() { [[ "$1" == "200" || "$1" == "201" ]]; }

log "Setting the GeoServer proxy base URL from request headers (works for http and https, before or after certbot)"
_code="$(gs_req GET "${GS_REST}/settings.xml")"
if gs_ok "$_code"; then
  # All existing settings are kept (a partial PUT would null charset → "Null charset name")
  if python3 - /tmp/gs_resp.txt /tmp/gs_settings.xml <<'PYS'
import sys
import xml.etree.ElementTree as ET
tree = ET.parse(sys.argv[1]); root = tree.getroot()
s = root if root.tag == "settings" else root.find("settings")
def setv(tag, val):
    e = s.find(tag)
    if e is None:
        e = ET.SubElement(s, tag)
    e.text = val
setv("proxyBaseUrl", "${X-Forwarded-Proto}://${X-Forwarded-Host}/geoserver")
setv("useHeadersProxyURL", "true")
c = s.find("charset")
if c is None or not (c.text or "").strip():
    setv("charset", "UTF-8")
tree.write(sys.argv[2], encoding="utf-8")
PYS
  then
    _code="$(gs_req PUT "${GS_REST}/settings" /tmp/gs_settings.xml)"
    gs_ok "$_code" || { warn "could not set the proxy base URL (HTTP $_code)"; cat /tmp/gs_resp.txt >&2 || true; }
  else
    warn "could not parse GeoServer settings"
  fi
else
  warn "could not read GeoServer settings (HTTP $_code)"
fi

# Workspaces are re-created on every run → always match the current .env / mode
recreate_workspace() {
  local ws="$1" code xpass
  gs_req DELETE "${GS_REST}/workspaces/${ws}?recurse=true" >/dev/null
  printf '<workspace><name>%s</name></workspace>' "$ws" >/tmp/gs_ws.xml
  code="$(gs_req POST "${GS_REST}/workspaces" /tmp/gs_ws.xml)"
  gs_ok "$code" || { cat /tmp/gs_resp.txt >&2; die "could not create workspace ${ws} (HTTP $code)"; }

  xpass="$(printf '%s' "$PGPASSWORD" | xml_escape)"
  cat >/tmp/gs_ds.xml <<EOF
<dataStore>
  <name>${DATASTORE}</name>
  <type>PostGIS</type>
  <enabled>true</enabled>
  <connectionParameters>
    <entry key="dbtype">postgis</entry>
    <entry key="host">${PGHOST}</entry>
    <entry key="port">${PGPORT}</entry>
    <entry key="database">${PGDATABASE}</entry>
    <entry key="schema">${DB_SCHEMA}</entry>
    <entry key="user">${PGUSER}</entry>
    <entry key="passwd">${xpass}</entry>
    <entry key="Expose primary keys">true</entry>
    <entry key="validate connections">true</entry>
    <entry key="Test while idle">true</entry>
    <entry key="min connections">1</entry>
    <entry key="max connections">5</entry>
    <entry key="Loose bbox">true</entry>
  </connectionParameters>
</dataStore>
EOF
  code="$(gs_req POST "${GS_REST}/workspaces/${ws}/datastores" /tmp/gs_ds.xml)"
  rm -f /tmp/gs_ds.xml
  gs_ok "$code" || { cat /tmp/gs_resp.txt >&2; die "could not create the datastore in ${ws} (HTTP $code)"; }
}

# publish_view WS NAME TITLE SQL GEOM_TYPE(Point|MultiPolygon|none) USES_UID(0|1) KEY_COLUMNS...
PUBLISH_ERRORS=0
publish_view() {
  local ws="$1" name="$2" title="$3" sql="$4" gtype="$5" uses_uid="$6"; shift 6
  local keys="" k geom="" param="" bbox base code
  for k in "$@"; do keys+="        <keyColumn>${k}</keyColumn>"$'\n'; done
  if [[ "$gtype" != "none" ]]; then
    geom="        <geometry><name>geom</name><type>${gtype}</type><srid>4326</srid></geometry>"
  fi
  if [[ "$uses_uid" == "1" ]]; then
    param="        <parameter><name>uid</name><defaultValue>0</defaultValue><regexpValidator>^[0-9]+\$</regexpValidator></parameter>"
  fi
  bbox="<minx>-180</minx><maxx>180</maxx><miny>-90</miny><maxy>90</maxy><crs>EPSG:4326</crs>"
  cat >/tmp/gs_ft.xml <<EOF
<featureType>
  <name>${name}</name>
  <nativeName>${name}</nativeName>
  <title>$(printf '%s' "$title" | xml_escape)</title>
  <srs>EPSG:4326</srs>
  <projectionPolicy>FORCE_DECLARED</projectionPolicy>
  <nativeBoundingBox>${bbox}</nativeBoundingBox>
  <latLonBoundingBox>${bbox}</latLonBoundingBox>
  <enabled>true</enabled>
  <metadata>
    <entry key="JDBC_VIRTUAL_TABLE">
      <virtualTable>
        <name>${name}</name>
        <sql>$(printf '%s' "$sql" | xml_escape)</sql>
        <escapeSql>false</escapeSql>
${keys}${geom}
${param}
      </virtualTable>
    </entry>
  </metadata>
</featureType>
EOF
  base="${GS_REST}/workspaces/${ws}/datastores/${DATASTORE}/featuretypes"
  code="$(gs_req POST "$base" /tmp/gs_ft.xml)"
  if gs_ok "$code"; then
    echo "  published ${ws}:${name}"
    # Real extent for layers that do not depend on the user (non-fatal)
    if [[ "$gtype" != "none" && "$uses_uid" == "0" ]]; then
      printf '<featureType><enabled>true</enabled></featureType>' >/tmp/gs_ft_bbox.xml
      gs_req PUT "${base}/${name}?recalculate=nativebbox,latlonbbox" /tmp/gs_ft_bbox.xml >/dev/null || true
    fi
  else
    warn "failed to publish ${ws}:${name} (HTTP $code)"
    cat /tmp/gs_resp.txt >&2 || true
    PUBLISH_ERRORS=$((PUBLISH_ERRORS + 1))
  fi
}

if [[ "$(gs_req GET "${GS_REST}/workspaces/${WS_LEGACY}.xml")" == "200" ]]; then
  log "Removing legacy workspace '${WS_LEGACY}' (old single layer — replaced by the new workspaces)"
  gs_req DELETE "${GS_REST}/workspaces/${WS_LEGACY}?recurse=true" >/dev/null || true
fi

log "Publishing supervisor data (workspace ${WS_SUPERVISOR})"
recreate_workspace "$WS_SUPERVISOR"
publish_view "$WS_SUPERVISOR" events "DiDe events — supervisor export (active events)" \
  "$(sql_supervisor_events)" Point 0 event_id

log "Publishing opener / solver data (workspace ${WS_EXPERT})"
recreate_workspace "$WS_EXPERT"
if [[ -n "$AGG_TABLE" ]]; then
  publish_view "$WS_EXPERT" grid_events "DiDe — my reports summarised by grid cell" \
    "$(sql_grid_events "$EXPERT_GRID_WHERE" 1)" MultiPolygon 1 "${PK_COLS[@]}"
  publish_view "$WS_EXPERT" grid_event_types "DiDe — my reports by grid cell and event type" \
    "$(sql_grid_types "$EXPERT_GRID_WHERE" 1)" none 1 "${PK_COLS[@]}" event_type
else
  publish_view "$WS_EXPERT" events "DiDe — my events" "$(sql_expert_events)" Point 1 event_id
fi

if [[ $OPEN_DATA -eq 1 ]]; then
  log "Publishing open data (workspace ${WS_OPEN})"
  recreate_workspace "$WS_OPEN"
  if [[ -n "$AGG_TABLE" ]]; then
    publish_view "$WS_OPEN" grid_events "DiDe open data — public events summarised by grid cell" \
      "$(sql_grid_events "$OPEN_GRID_WHERE" 0)" MultiPolygon 0 "${PK_COLS[@]}"
    publish_view "$WS_OPEN" grid_event_types "DiDe open data — public events by grid cell and event type" \
      "$(sql_grid_types "$OPEN_GRID_WHERE" 0)" none 0 "${PK_COLS[@]}" event_type
  else
    publish_view "$WS_OPEN" events "DiDe open data — public events" "$(sql_open_events)" Point 0 event_id
  fi
else
  log "OPEN_DATA=false → no public WFS link (workspace ${WS_OPEN} removed if it existed)"
  gs_req DELETE "${GS_REST}/workspaces/${WS_OPEN}?recurse=true" >/dev/null || true
fi
rm -f /tmp/gs_ft.xml /tmp/gs_ft_bbox.xml /tmp/gs_ws.xml /tmp/gs_settings.xml /tmp/gs_resp.txt

# -----------------------------------------------------------------------------
# Nginx — own files + ONE include line in the DiDe site (site config is never rewritten)
# -----------------------------------------------------------------------------
log "Writing Nginx snippet ${NGINX_SNIPPET}"
NGINX_BAK="${NGINX_CONF}.bak.$(date +%Y%m%d%H%M%S)"
cp -p "$NGINX_CONF" "$NGINX_BAK"
SNIPPET_BAK=""; HTTPCONF_BAK=""
if [[ -f "$NGINX_SNIPPET" ]];   then SNIPPET_BAK="$(mktemp)";  cp -p "$NGINX_SNIPPET" "$SNIPPET_BAK"; fi
if [[ -f "$NGINX_HTTP_CONF" ]]; then HTTPCONF_BAK="$(mktemp)"; cp -p "$NGINX_HTTP_CONF" "$HTTPCONF_BAK"; fi

restore_nginx() {
  cp -p "$NGINX_BAK" "$NGINX_CONF"
  if [[ -n "$SNIPPET_BAK" ]]; then cp -p "$SNIPPET_BAK" "$NGINX_SNIPPET"; else rm -f "$NGINX_SNIPPET"; fi
  if [[ -n "$HTTPCONF_BAK" ]]; then cp -p "$HTTPCONF_BAK" "$NGINX_HTTP_CONF"; else rm -f "$NGINX_HTTP_CONF"; fi
}

RATE_LIMIT=0
if grep -Eq '^\s*include\s+/etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf 2>/dev/null; then
  RATE_LIMIT=1
  cat >"$NGINX_HTTP_CONF" <<'EOF'
# Managed by GEOSERVER_WFS_setup.sh — re-run the script instead of editing.
limit_req_zone $binary_remote_addr zone=dide_wfs_auth:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=dide_wfs_open:10m rate=2r/s;
EOF
else
  rm -f "$NGINX_HTTP_CONF"
fi
LR_AUTH="# (no rate limit: /etc/nginx/conf.d is not included by nginx.conf)"
LR_OPEN="$LR_AUTH"
if [[ $RATE_LIMIT -eq 1 ]]; then
  LR_AUTH="limit_req zone=dide_wfs_auth burst=60 nodelay; limit_req_status 429;"
  LR_OPEN="limit_req zone=dide_wfs_open burst=30 nodelay; limit_req_status 429;"
fi

PROXY_HDRS='proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;'

if [[ $OPEN_DATA -eq 1 ]]; then
  OPEN_BLOCK="    location ~ ^/(wfs-open|geoserver/${WS_OPEN}/(ows|wfs))/?\$ {
        limit_except GET { deny all; }
        ${LR_OPEN}
        proxy_set_header Authorization \"\";
        ${PROXY_HDRS}
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_pass http://${GEOSERVER_UPSTREAM}/geoserver/${WS_OPEN}/ows\$is_args\$args;
    }"
else
  OPEN_BLOCK="    # OPEN_DATA=false → no public WFS link
    location ~ ^/(wfs-open|geoserver/${WS_OPEN}/(ows|wfs))/?\$ { return 404; }"
fi

mkdir -p "$(dirname "$NGINX_SNIPPET")"
cat >"$NGINX_SNIPPET" <<EOF
# Managed by GEOSERVER_WFS_setup.sh — re-run the script instead of editing.
# Included from the DiDe server block(s) in ${NGINX_CONF}

    # ── Credential check (DiDe users) ──
    location = /_dide_wfs_auth {
        internal;
        proxy_pass http://${AUTH_BIND}/auth;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization \$http_authorization;
        proxy_set_header X-Original-URI \$request_uri;
        proxy_set_header X-Original-Method \$request_method;
        proxy_connect_timeout 5s;
        proxy_read_timeout 20s;
    }

    # ── 1) Authenticated WFS:  /wfs ──
    #   opener / solver → workspace ${WS_EXPERT}  (only their own data; uid is set by the server)
    #   supervisor      → workspace ${WS_SUPERVISOR}
    #   /geoserver/${WS_EXPERT}|${WS_SUPERVISOR}/ows are the URLs GeoServer writes into
    #   GetCapabilities — they go through exactly the same check.
    location ~ ^/(wfs|geoserver/(${WS_EXPERT}|${WS_SUPERVISOR})/(ows|wfs))/?\$ {
        limit_except GET { deny all; }
        ${LR_AUTH}
        auth_request /_dide_wfs_auth;
        auth_request_set \$dide_ws \$upstream_http_x_dide_ws;
        auth_request_set \$dide_uid \$upstream_http_x_dide_uid;
        error_page 401 = @dide_wfs_401;
        proxy_set_header Authorization "";
        ${PROXY_HDRS}
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_pass http://${GEOSERVER_UPSTREAM}/geoserver/dide_\$dide_ws/ows?\$args&viewparams=uid:\$dide_uid;
    }

    # ── 2) Open data WFS (no authentication):  /wfs-open ──
${OPEN_BLOCK}

    location @dide_wfs_401 {
        add_header WWW-Authenticate 'Basic realm="DiDe WFS", charset="UTF-8"' always;
        return 401;
    }

    # ── Every other GeoServer service is closed to the internet ──
    location ~ ^/geoserver/(ows|wfs|wms|wcs|wps|wmts|tms|gwc|rest|ogc|${WS_LEGACY})(/|\$) { return 404; }
    location ~ ^/geoserver/[^/]+/(ows|wfs|wms|wcs|wps|wmts|gwc)(/|\$) { return 404; }
    location ~ ^/geoserver/[^/]+/[^/]+/(ows|wfs|wms|wcs|wps|wmts)(/|\$) { return 404; }

    # ── GeoServer web admin UI ──
    location /geoserver/ {
        ${PROXY_HDRS}
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_pass http://${GEOSERVER_UPSTREAM}/geoserver/;
    }
EOF

log "Adding the include line to ${NGINX_CONF} (certificate / certbot lines are not touched)"
if ! python3 - "$NGINX_CONF" "$INCLUDE_LINE" <<'PYEOF'
import re
import sys

conf_path, include_line = sys.argv[1], sys.argv[2]
with open(conf_path, encoding="utf-8") as f:
    lines = f.read().split("\n")

def code_of(line):
    return line.split("#", 1)[0]

# 1) Remove what OLD versions of this script injected (same locations → "duplicate location").
out, skip = [], False
for line in lines:
    if "WFS Auth (injected by GEOSERVER_WFS_setup.sh)" in line:
        skip = True
        continue
    if skip:
        if "End WFS blocks" in line:
            skip = False
        continue
    out.append(line)
legacy = re.compile(r"^\s*location\s+(=\s*/_auth_wfs|/geoserver/|\^~\s*/wfs|\^~\s*/geoserver/wfs|@wfs_401)\s*\{.*\}\s*$")
lines = [l for l in out if not legacy.match(l)]

# 2) Certbot sometimes writes "}server {" on one line → split it.
fixed = []
for line in lines:
    m = re.match(r"^(\s*\})\s*(server\b.*)$", line)
    if m:
        fixed.append(m.group(1)); fixed.append(m.group(2))
    else:
        fixed.append(line)
lines = fixed

# 3) Top-level server blocks.
blocks, depth, start = [], 0, None
for i, line in enumerate(lines):
    c = code_of(line)
    if depth == 0 and "{" in c and re.match(r"^\s*server\b", c):
        start = i
    depth += c.count("{") - c.count("}")
    if start is not None and depth == 0:
        blocks.append((start, i)); start = None

def text(s, e):
    return "\n".join(code_of(l) for l in lines[s:e + 1])

# Blocks that serve the app (location /). A certbot redirect-only block is left alone.
targets = [(s, e) for (s, e) in blocks if re.search(r"location\s+/\s*\{", text(s, e))]
if not targets:
    targets = [(s, e) for (s, e) in blocks if re.search(r"listen\s+(\[::\]:)?443", text(s, e))]
if not targets:
    print("No DiDe server block found", file=sys.stderr)
    sys.exit(3)

added = 0
for (s, e) in sorted(targets, reverse=True):
    if include_line in text(s, e):
        continue
    lines.insert(e, "    " + include_line + "  # DiDe GeoServer WFS (GEOSERVER_WFS_setup.sh)")
    added += 1

with open(conf_path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print(f"include line added to {added} server block(s) ({len(targets)} DiDe block(s) found)")
PYEOF
then
  restore_nginx
  die "Could not find the DiDe server block in ${NGINX_CONF} — original restored, site unchanged."
fi

if ! nginx -t; then
  restore_nginx
  die "nginx -t failed → original config restored (${NGINX_BAK}); the site is unchanged.
       If the error mentions a duplicate location (/geoserver/, /wfs ...), remove that block
       from ${NGINX_CONF} — this script now manages it — and run the script again."
fi
rm -f "$SNIPPET_BAK" "$HTTPCONF_BAK"
systemctl enable nginx >/dev/null 2>&1 || true
if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl restart nginx; fi

# -----------------------------------------------------------------------------
# Checks + summary
# -----------------------------------------------------------------------------
log "Sanity checks"
_ws_list=("$WS_SUPERVISOR" "$WS_EXPERT")
if [[ $OPEN_DATA -eq 1 ]]; then _ws_list+=("$WS_OPEN"); fi
for _ws in "${_ws_list[@]}"; do
  _c="$(curl -s -o /dev/null -w '%{http_code}' "http://${GEOSERVER_UPSTREAM}/geoserver/${_ws}/ows?service=WFS&request=GetCapabilities" || true)"
  echo "  GeoServer ${_ws} GetCapabilities : HTTP ${_c}"
done
sleep 1
_c="$(curl -s -o /dev/null -w '%{http_code}' "http://${AUTH_BIND}/health" || true)"
echo "  Auth service                       : HTTP ${_c}"
if grep -Eq '^\s*ssl_certificate\s' "$NGINX_CONF" && [[ -n "$PRIMARY_DOMAIN" ]]; then
  BASE_URL="https://${PRIMARY_DOMAIN}"
  _c="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "${PRIMARY_DOMAIN}:443:127.0.0.1" "${BASE_URL}/wfs?service=WFS&request=GetCapabilities" || true)"
elif [[ -n "$PRIMARY_DOMAIN" ]]; then
  BASE_URL="http://${PRIMARY_DOMAIN}"
  _c="$(curl -s -o /dev/null -w '%{http_code}' --resolve "${PRIMARY_DOMAIN}:80:127.0.0.1" "${BASE_URL}/wfs?service=WFS&request=GetCapabilities" || true)"
else
  BASE_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
  _c="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/wfs?service=WFS&request=GetCapabilities" || true)"
fi
echo "  /wfs without password (expect 401) : HTTP ${_c}"

echo ""
echo "================================================================="
if [[ $PUBLISH_ERRORS -gt 0 ]]; then
  echo " Done, but ${PUBLISH_ERRORS} layer(s) had errors (see above)."
else
  echo " Done."
fi
echo "================================================================="
echo " 1) Authenticated WFS (opener / solver / supervisor):"
echo "      ${BASE_URL}/wfs"
echo "      QGIS: Layer → Add Layer → Add WFS Layer → New → URL above,"
echo "            Authentication → Basic → DiDe user name + password"
if [[ $OPEN_DATA -eq 1 ]]; then
  echo ""
  echo " 2) Open data WFS (no authentication, OPEN_DATA=true):"
  echo "      ${BASE_URL}/wfs-open"
fi
echo ""
echo " GeoServer admin UI : ${BASE_URL}/geoserver/web/  (change the admin password!)"
echo " Nginx backup       : ${NGINX_BAK}"
echo " Re-run this script after changing OPEN_DATA, AGGREGATION_LAYER or the boundary file."
echo "================================================================="