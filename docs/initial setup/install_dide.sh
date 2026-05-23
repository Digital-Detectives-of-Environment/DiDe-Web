set -euo pipefail

PROJECT_NAME="dide"
BASE_DIR="/var/www/${PROJECT_NAME}"
PROJECT_DIR="${BASE_DIR}/${PROJECT_NAME}"

SQL_FILE="docs/initial setup/1_database_tables.sql"

log() {
  echo -e "\n[+] $1\n"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}




get_env_value() {
  local key="$1"
  local env_file="$2"
  grep -E "^${key}=" "$env_file" | head -n 1 | sed -E "s/^${key}=//"
}

require_root_sudo() {
  if ! sudo -n true 2>/dev/null; then
    log "You need sudo privileges. Run this and try again: sudo -v"
    exit 1
  fi
}

install_base_packages() {
  log "The system is being updated and essential packages are being installed..."
  sudo apt update -y
  sudo apt upgrade -y
  sudo apt install -y git curl build-essential ca-certificates gnupg lsb-release gdal-bin
}

install_postgres_postgis() {
  log "PostgreSQL + PostGIS is being installed..."
  sudo apt install -y postgresql postgresql-contrib postgis
}

install_nginx() {
  log "Nginx is being installed..."
  sudo apt install -y nginx
}

setup_firewall() {
  log "UFW is being installed and the firewall is being configured..."
  sudo apt install -y ufw
  sudo ufw allow OpenSSH
  sudo ufw allow "Nginx Full"
  sudo ufw --force enable
}

install_node22() {
  log "Node.js 22 is being installed..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs

  log "Node/NPM version control..."
  node -v
  npm -v
}



check_env_file() {
  log "Checking .env file..."
  if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo " .env file not found: $PROJECT_DIR/.env"
    echo
    echo " Now do this:"
    echo "   cd $PROJECT_DIR"
    echo "   nano .env"
    echo
    echo "Then run it again:"
    echo "   cd ~"
    echo "   ./setup_dide.sh"
    exit 1
  fi
}

read_env_vars() {
  log "Reading database settings from within the .env file..."
  ENV_FILE="$PROJECT_DIR/.env"

  PGDATABASE="$(get_env_value PGDATABASE "$ENV_FILE")"
  PGPASSWORD="$(get_env_value PGPASSWORD "$ENV_FILE")"
  PGUSER="$(get_env_value PGUSER "$ENV_FILE")"
  PGHOST="$(get_env_value PGHOST "$ENV_FILE")"
  PGPORT="$(get_env_value PGPORT "$ENV_FILE")"
  PORT="$(get_env_value PORT "$ENV_FILE")"

  POLYGON_FILE="$(get_env_value AGGREGATION_LAYER "$ENV_FILE")"
  PRIMARY_KEYS="$(get_env_value Primary_Keys "$ENV_FILE")"

  PGDATABASE="${PGDATABASE}"
  PGPASSWORD="${PGPASSWORD}"
  PGUSER="${PGUSER}"
  PGHOST="${PGHOST}"
  PGPORT="${PGPORT}"
  PORT="${PORT}"

  echo "DB_NAME       = $PGDATABASE"
  echo "DB_USER       = $PGUSER"
  echo "DB_HOST       = $PGHOST"
  echo "DB_PORT       = $PGPORT"
  echo "APP_PORT      = $PORT"
  echo "POLYGON_FILE  = ${POLYGON_FILE:-<not set>}"
  echo "PRIMARY_KEYS  = ${PRIMARY_KEYS:-<not set>}"
}

configure_postgres() {
  log "PostgreSQL user password is being set + database is being created..."

 # PostgreSQL user password
  sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '${PGPASSWORD}';"

  # Check if DB exists
  DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${PGDATABASE}'" || true)
  if [ "$DB_EXISTS" = "1" ]; then
    log "The database already exists: $PGDATABASE"
  else
    log "Creating database: $PGDATABASE"
    sudo -u postgres createdb "$PGDATABASE"
  fi

  
  log "PostGIS extension is being added (will be implemented if already available)..."
  sudo -u postgres psql -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
}

run_sql_file() {
  log "Running SQL file..."

  if [ ! -f "$PROJECT_DIR/$SQL_FILE" ]; then
    echo " SQL file not found: $PROJECT_DIR/$SQL_FILE"
    echo "Make sure this file exists in the repository."
    echo "If necessary, update the SQL_FILE variable in the script."
    exit 1
  fi

  sudo -u postgres psql -d "$PGDATABASE" -f "$PROJECT_DIR/$SQL_FILE"
  log "SQL import tamamlandı "
}

import_polygon_file() {
  if [ -z "${POLYGON_FILE:-}" ]; then
    log "POLYGON_FILE is not set in .env, skipping polygon import."
    return 0
  fi

  local ABS_POLY_PATH="${PROJECT_DIR}/${POLYGON_FILE}"

  if [ ! -f "$ABS_POLY_PATH" ]; then
    echo " Polygon file not found: $ABS_POLY_PATH"
    echo " Make sure the file exists in the project directory."
    echo " POLYGON_FILE value in .env: $POLYGON_FILE"
    exit 1
  fi

  if [ -z "${PRIMARY_KEYS:-}" ]; then
    log "Primary_Keys is not set in .env, skipping PK column validation."
  else
    # Parse semicolon-separated PK list
    IFS=';' read -ra PK_ARRAY <<< "$PRIMARY_KEYS"
    for PK_COL in "${PK_ARRAY[@]}"; do
      PK_COL="$(echo "$PK_COL" | tr -d '[:space:]')"
      [ -z "$PK_COL" ] && continue
      COL_EXISTS=$(sudo -u postgres psql -tAc \
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${POLY_TABLE}' AND column_name='${PK_COL}'" \
        "$PGDATABASE" || true)
      if [ "$COL_EXISTS" != "1" ]; then
        echo " WARNING: Primary Key column '${PK_COL}' not found in table '${POLY_TABLE}'."
        echo " Available columns:"
        sudo -u postgres psql -tAc \
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${POLY_TABLE}' ORDER BY ordinal_position" \
          "$PGDATABASE"
      else
        echo " ✓ Primary Key column '${PK_COL}' found in table '${POLY_TABLE}'"
      fi
    done
  fi

  log "Polygon table '${POLY_TABLE}' is ready (Primary_Keys=${PRIMARY_KEYS:-<not set>})"

  # Derive table name from filename (lowercase, no extension)
  local POLY_BASENAME
  POLY_BASENAME="$(basename "$ABS_POLY_PATH")"
  local POLY_TABLE
  POLY_TABLE="$(echo "${POLY_BASENAME%.*}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_]/_/g')"

  log "Importing polygon file into PostGIS table: ${POLY_TABLE} ..."

  # Check if table already exists
  TABLE_EXISTS=$(sudo -u postgres psql -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='${POLY_TABLE}'" \
    "$PGDATABASE" || true)

  if [ "$TABLE_EXISTS" = "1" ]; then
    log "Polygon table '${POLY_TABLE}' already exists, skipping import."
  else
    # Use ogr2ogr to import GeoJSON / Shapefile / GeoPackage into PostGIS
    sudo -u postgres ogr2ogr \
      -f "PostgreSQL" \
      "PG:host=${PGHOST} port=${PGPORT} dbname=${PGDATABASE} user=postgres password=${PGPASSWORD}" \
      "$ABS_POLY_PATH" \
      -nln "$POLY_TABLE" \
      -lco GEOMETRY_NAME=geom \
      -lco FID=gid \
      -lco PRECISION=NO \
      -t_srs EPSG:4326 \
      -nlt PROMOTE_TO_MULTI \
      --config OGR_TRUNCATE NO \
      2>&1 || {
        echo " ogr2ogr import failed for: $ABS_POLY_PATH"
        exit 1
      }

    log "Polygon file imported successfully into table: ${POLY_TABLE}"
  fi

  # Ensure PostGIS spatial index exists
  sudo -u postgres psql -d "$PGDATABASE" -c \
    "CREATE INDEX IF NOT EXISTS idx_${POLY_TABLE}_geom ON public.${POLY_TABLE} USING GIST (geom);" \
    2>/dev/null || true
}

install_project_deps() {
  log "Installing NPM packages..."
  cd "$PROJECT_DIR"
  npm install
}

setup_pm2() {
  log "PM2 is being installed and the application is being launched..."
  sudo npm install -g pm2

  cd "$PROJECT_DIR"


  pm2 delete "$PROJECT_NAME" >/dev/null 2>&1 || true
  pm2 start index.js --name "$PROJECT_NAME"
  pm2 status
  pm2 save
  sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u dide --hp /home/ubuntu
}

setup_nginx() {
  log "Nginx reverse proxy is being configured..."

  NGINX_SITE="/etc/nginx/sites-available/${PROJECT_NAME}"

  sudo tee "$NGINX_SITE" >/dev/null <<EOF
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

  sudo ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/${PROJECT_NAME}"
  sudo rm -f /etc/nginx/sites-enabled/default || true

  sudo nginx -t
  sudo systemctl reload nginx

  log "Nginx aktif "
}

final_info() {
  log "Installation completed "
  echo " Project directory: $PROJECT_DIR"
  echo " PM2 name: $PROJECT_NAME"
  echo
  echo "Control commands:"
  echo "  pm2 status"
  echo "  sudo systemctl status nginx --no-pager"
  echo
  echo "IF you need to update the project:"
  echo "  cd $PROJECT_DIR"
  echo "  git pull"
  echo "  npm install"
  echo "  pm2 restart $PROJECT_NAME"
}
main() {
  require_root_sudo
  install_base_packages
  install_postgres_postgis
  install_nginx
  setup_firewall
  install_node22
  check_env_file
  read_env_vars
  configure_postgres
  run_sql_file
  import_polygon_file
  install_project_deps
  setup_pm2
  setup_nginx
  final_info
}

main