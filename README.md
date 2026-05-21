# DiDe

<div align="center">

![DiDe Logo](https://img.shields.io/badge/DiDe-Location--Based%20Reporting%20Platform-blue?style=for-the-badge)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-13+-316192?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Bootstrap](https://img.shields.io/badge/Bootstrap-5.x-7952B3?style=for-the-badge&logo=bootstrap&logoColor=white)](https://getbootstrap.com/)

**An open-source, location-based event reporting and monitoring platform built on PostgreSQL/PostGIS. Users submit reports via web or mobile, and administrators track and manage them through an interactive map interface.**

[Features](#features) •
[Quick Start (Localhost)](#quick-start--localhost) •
[Production Deployment (Ubuntu)](#production-deployment--ubuntu-server) •
[Data Integration](#data-integration--case-study) •
[WFS Service](#wfs-service-setup) •
[Environment Variables](#environment-variables)

</div>

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [System Requirements](#system-requirements)
- [Quick Start (Localhost)](#quick-start--localhost)
- [Data Integration (Case Study)](#data-integration--case-study)
- [Adding Supervisors and Users](#adding-supervisors-and-users)
- [Production Deployment (Ubuntu Server)](#production-deployment--ubuntu-server)
- [WFS Service Setup](#wfs-service-setup)
- [Environment Variables](#environment-variables)
- [Security](#security)
- [Project Structure](#project-structure)

---

## Features

**Map-Based Event Management** — Interactive map using Leaflet.js, report submission by clicking on the map or using live location, marker clustering.

**Multimedia Support** — Photo/video upload, direct camera capture, video recording, lightbox preview.

**Voice Input** — Voice descriptions using the Web Speech API.

**Role-Based Access Control** — User (submit reports), Supervisor (manage all reports, event types, users, and existing data integration).

**Filtering & Export** — Filter by date range, event type, user, email domain; GeoJSON export.

**Multi-Language Support** — Dynamic language system (default language configurable via `.env`; TR, EN, IT and more can be added).

**Existing Data Integration** — Display existing geographic data from PostgreSQL (buildings, roads, etc.) on the map as Public or Private layers.

**H3 Aggregation Layer** — Hexagonal grid-based region selection and region-based event management.

**Raster Layer Support** — Display GeoTIFF files as background layers on the map.

**Security** — JWT tokens, 2FA/TOTP, email verification, bcrypt password hashing, XSS and SQL injection protection.

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| Backend | Node.js, Express.js |
| Database | PostgreSQL + PostGIS |
| Authentication | JWT, bcrypt, Speakeasy (TOTP) |
| Frontend | Vanilla JavaScript, Bootstrap 5, Leaflet.js |
| Email | Nodemailer |
| File Handling | Multer |

---

## System Requirements

- **Node.js** v18 or higher (v22+ recommended)
- **PostgreSQL** v13 or higher + **PostGIS** extension
- **npm**
- **OS:** Windows, Linux, or macOS

---

## Quick Start — Localhost

Follow these steps in order to clone the project and run it on your local machine.

### Step 1: Clone the Repository

```bash
git clone https://github.com/banbar/dide.git
cd dide
```

### Step 2: Install NPM Packages

```bash
npm install
```

### Step 3: Install PostgreSQL

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib postgis
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

**macOS:**
```bash
brew install postgresql postgis
brew services start postgresql
```

**Windows:** Download and install from [postgresql.org](https://www.postgresql.org/download/windows/). Install PostGIS via Stack Builder.

### Step 4: Create the Database

```bash
# Enter the PostgreSQL console
psql -U postgres

# Create the database
CREATE DATABASE dide_db;

# Add PostGIS extensions
\c dide_db
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\q
```

### Step 5: Create the Core Tables

```bash
psql -U postgres -d dide_db -f "docs/initial setup/1_database_tables.sql"
```

This creates the `users`, `olaylar` (event types), and `olay` (events) tables. For details, see [docs/README.md](docs/README.md).

### Step 6: Create the `.env` File

Create a `.env` file in the project root directory. For all parameters, see [Environment Variables](#environment-variables). Minimum configuration for local development:

```env
PORT=3000
CORS_ORIGIN=http://localhost:3000

PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSWORD=
PGDATABASE=

JWT_SECRET=dev-secret
JWT_EXPIRES=7d

COOKIE_SAMESITE=lax
COOKIE_SECURE=false

FORCE_EMAIL_VERIFY=false

SITE_TITLE=DiDe
SITE_LOGO_URL=/DiDe-Logo.png

MAP_INITIAL_LAT=45.4642
MAP_INITIAL_LNG=9.1900
MAP_INITIAL_ZOOM=6
MAP_MIN_ZOOM=2

DEFAULT_LANG=TR

AGGREGATION_LAYER=
PK1=
PK2=
```

### Step 7: Start the Application

```bash
npm start
```

Open your browser and navigate to `http://localhost:3000`. The system will be up and running.

---

## Adding Supervisors and Users

When the system is first installed, there are no users. Users and supervisors must be added manually.

### Adding Regular Users

**Method 1 — Via the Registration Screen:**
Go to the site and click the **Sign Up** button to create a new user.

**Method 2 — Batch SQL Import:**
```bash
psql -U postgres -d dide_db -f "docs/initial setup/2_example_experts.sql"
```
This adds 8 test users (default password: `12345Aa`).

**Method 3 — Manual SQL:**
```sql
INSERT INTO public.users (username, password_hash, role, email, email_verified, is_verified, is_active)
VALUES (
  'your_username',
  crypt('YourPassword123.', gen_salt('bf', 10)),
  'user',
  'example@email.com',
  true, true, true
);
```

### Adding a Supervisor

Supervisor accounts require **two-factor authentication (2FA)**, so the creation process is different:

1. **Generate a 2FA secret code:**
```bash
node "docs/initial setup/generate-2fa-secret.js"
```
Note down the BASE32 code from the output.

2. **Add the supervisor to the database:**
```sql
INSERT INTO public.users (
    username, password_hash, role, name, surname, email,
    email_verified, is_verified, is_active,
    two_factor_secret, two_factor_enabled
) VALUES (
    'supervisor_name',
    crypt('StrongPassword123.', gen_salt('bf', 10)),
    'supervisor',
    'FirstName', 'LastName', 'supervisor@example.com',
    TRUE, TRUE, TRUE,
    'GENERATED_BASE32_CODE',
    TRUE
);
```

3. **Set up the Authenticator app:**
Enter the BASE32 code into Google Authenticator or a similar app on the supervisor's phone. A 6-digit verification code from this app will be required during login.

For detailed examples, see the `4_adding_a_supervisor.sql` explanation in [docs/README.md](docs/README.md).

---

## Data Integration — Case Study

While the system is running, you can integrate study area-specific data (buildings, roads, H3 grid, etc.) into the system. All study area data is kept in the `case_study/` folder.

### Adding Existing Data

1. Run the SQL files in the database:
```bash
psql -U postgres -d dide_db -f case_study/Milano/existing_data/buildings.sql
psql -U postgres -d dide_db -f case_study/Milano/existing_data/roads.sql
```

2. Log in as a Supervisor → **Administration Panel** → **Existing Data** tab.

3. Select the added tables and configure their visibility:
   - **Public** → visible to everyone without logging in
   - **Private** → visible only to logged-in users

### Adding the H3 Aggregation Layer

1. Run the H3 SQL file:
```bash
psql -U postgres -d dide_db -f case_study/Milano/aggregation_layer/h3_milan.sql
```

2. Update the `.env` file:
```env
AGGREGATION_LAYER=h3_milan
PK1=h3_index
PK2=
```

3. Restart the application (`npm start` or `pm2 restart dide`).

For details, see [case_study/README.md](case_study/README.md).

---

## Production Deployment — Ubuntu Server

Follow these steps to deploy DiDe in a production environment on Ubuntu 22.04/24.04 LTS.

### 1. Connect to the Server

```bash
ssh -i your-key.pem ubuntu@SERVER_IP
```

### 2. Prepare the Project Directory

```bash
sudo mkdir -p /var/www/dide
sudo chown -R ubuntu:ubuntu /var/www/dide
cd /var/www/dide
git clone https://github.com/banbar/dide.git dide
cd dide
```

### 3. Create the `.env` File

```bash
nano .env
# Paste your environment variables (see "Environment Variables" section)
# For production, change these:
#   CORS_ORIGIN=https://yourdomain.com
#   COOKIE_SECURE=true
#   COOKIE_SAMESITE=strict
#   JWT_SECRET=a-very-strong-random-key
```

### 4. Run the Automated Setup Script

```bash
chmod +x "docs/initial setup/install_dide.sh"
sudo bash "docs/initial setup/install_dide.sh"
```

The script will automatically:
- Update the system and install Node.js 22, PostgreSQL, PostGIS, Nginx, UFW
- Read database information from `.env` and create the database and tables
- Install NPM packages
- Start the application with PM2
- Configure Nginx as a reverse proxy (port 80 → application port)

### 5. Post-Installation Checks

```bash
pm2 status
sudo systemctl status nginx --no-pager
sudo -u postgres psql -d dide_db -c "SELECT count(*) FROM users;"
```

### 6. SSL Certificate (HTTPS)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

The certificate will be renewed automatically. Update `COOKIE_SECURE=true` in your `.env` file.

### 7. Connecting QGIS to the Server Database

To open PostgreSQL for external connections on the server:

```bash
# Edit PostgreSQL configuration
sudo nano /etc/postgresql/16/main/postgresql.conf
# Set: listen_addresses = '*'

sudo nano /etc/postgresql/16/main/pg_hba.conf
# Add: host all all YOUR_IP/32 scram-sha-256

sudo systemctl restart postgresql

# Open port 5432 in the firewall (only for your IP)
sudo ufw allow from YOUR_IP to any port 5432
```

In QGIS: **Browser → PostgreSQL → New Connection** → enter the server IP, port 5432, and the credentials from your `.env`.

---

## WFS Service Setup

To set up a WFS (Web Feature Service) with GeoServer in a production environment, use the `GEOSERVER_WFS_setup.sh` script in the project root directory.

### Prerequisites

- DiDe must be running in a production environment (Nginx + PM2 active)
- The `.env` file must be configured

### Setup Steps

1. **Run the script:**
```bash
sudo bash GEOSERVER_WFS_setup.sh \
  --env-file /var/www/dide/dide/.env \
  --gs-admin-user admin \
  --gs-admin-pass geoserver_password
```

2. **Optional parameters:**
```bash
  --workspace dide_workspace \          # GeoServer workspace name
  --datastore dide_datastore \          # Datastore name
  --server-name yourdomain.com \        # SSL domain name
  --geoserver-version 2.25.2            # GeoServer version
```

### What the Script Does

- Installs **Java 17 (JRE)**
- Downloads, installs, and creates a systemd service for **GeoServer**
- Creates a **Flask/Gunicorn**-based authentication service (authenticates WFS requests against DiDe users)
- Adds WFS location blocks to the **Nginx** configuration (`/wfs`, `/geoserver/wfs`)
- Creates a **PostGIS datastore** in GeoServer
- Publishes the `olay` table (active events) as a **WFS layer**

### WFS Access

After setup:

```bash
# GeoServer admin panel (in browser):
http://SERVER_IP/geoserver/

# WFS GetCapabilities (no auth — GeoServer UI):
http://SERVER_IP/geoserver/wfs?service=WFS&request=GetCapabilities

# WFS with DiDe user authentication (Basic Auth):
curl -u "username:password" "http://SERVER_IP/wfs?service=WFS&request=GetCapabilities"
```

WFS is protected by the credentials of active users with the `supervisor` role in the DiDe database. You can connect from QGIS or other GIS software using Basic Auth.

---

## Environment Variables

Create a `.env` file in the project root directory:

```env
# ── SERVER ──
PORT=3000
CORS_ORIGIN=http://localhost:3000

# ── POSTGRESQL DATABASE ──
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_password
PGDATABASE=dide_db
PGPOOL_MAX=10

# ── JWT SECURITY ──
JWT_SECRET=change-this-secret-key
JWT_EXPIRES=7d

# ── COOKIE SETTINGS ──
COOKIE_SAMESITE=lax
COOKIE_SECURE=false                     # Set to true in production

# ── EMAIL VERIFICATION ──
FORCE_EMAIL_VERIFY=true
VERIFY_EMAIL_TEXT=terms_conditions.html

# ── SMTP EMAIL ──
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@gmail.com
SMTP_PASS=app_password
SMTP_FROM_NAME=DiDe
SMTP_FROM_EMAIL=your@gmail.com

# ── SITE SETTINGS ──
SITE_TITLE=DiDe
SITE_LOGO_URL=/DiDe-Logo.png

# ── ALLOWED EMAIL DOMAINS FOR REGISTRATION ──
ALLOWED_EMAIL_DOMAIN=gmail.com;outlook.com

# ── TABLE PAGINATION ──
TABLE_PAGE_SIZE_EVENTS=25
TABLE_PAGE_SIZE_TYPES=20
TABLE_PAGE_SIZE_USERS=30

# ── MAP SETTINGS ──
MAP_INITIAL_LAT=45.4642
MAP_INITIAL_LNG=9.1900
MAP_INITIAL_ZOOM=6
MAP_MIN_ZOOM=2

# ── EVENT VISIBILITY (LOGGED-OUT USERS) ──
SHOW_GOOD_EVENTS_ON_LOGIN=true
SHOW_BAD_EVENTS_ON_LOGIN=false

# ── LANGUAGE SETTING ──
DEFAULT_LANG=TR                         # TR, EN, IT, etc. (file name in i18n/)

# ── GIS / AGGREGATION SETTINGS ──
AGGREGATION_LAYER=                      # e.g. h3_milan
PK1=                                    # Primary key column (fill in at least one)
PK2=                                    # Secondary key column (optional)
```

> **For Gmail users:** Enable 2-Step Verification in your Google Account, then generate an App Password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and use it as `SMTP_PASS`.

---

## Security

- Passwords hashed with **bcrypt** (10 salt rounds)
- **JWT** token-based authentication
- **2FA / TOTP** support for Supervisor accounts
- **Email verification** system
- **SQL injection protection** via parameterized queries
- **CORS** configuration
- **File upload** security checks

**Production recommendations:**
- Always change `JWT_SECRET` to a strong random value
- Use HTTPS (`COOKIE_SECURE=true`)
- Never commit your `.env` file to version control
- Use a strong PostgreSQL password
- Configure the server firewall (UFW)

---

## Project Structure

```
dide/
├── index.js                    ← Main server file (Express.js)
├── package.json                ← NPM dependencies
├── .env                        ← Environment variables (must be created)
├── GEOSERVER_WFS_setup.sh      ← WFS service setup script
├── i18n/                       ← Multi-language translation files
│   ├── main.js                 ← i18n manager
│   ├── TR.js                   ← Turkish translation
│   ├── EN.js                   ← English translation
│   └── IT.js                   ← Italian translation
├── public/                     ← Frontend files
│   ├── index.html              ← Main page
│   ├── app.js                  ← Frontend application logic
│   ├── index.css               ← Stylesheet
│   ├── uploads/                ← User uploads (photos/videos)
│   └── *.svg, *.png            ← Icon and logo files
├── case_study/                 ← Study area data
│   └── Milano/                 ← Example: Milan study area
│       ├── existing_data/      ← SQL data files
│       ├── raw_data/           ← Raw data (Vector + Raster)
│       └── aggregation_layer/  ← H3 grid files
├── docs/                       ← Documentation and setup files
│   ├── initial setup/          ← Initial setup SQL and scripts
│   └── img/                    ← Documentation images
└── qfield-DiDe/                ← QField mobile integration files
```

---

## License

This project is distributed under the [GNU General Public License v3.0](LICENSE).

---

<div align="center">

![GitHub stars](https://img.shields.io/github/stars/banbar/dide?style=social)
![GitHub forks](https://img.shields.io/github/forks/banbar/dide?style=social)
![GitHub issues](https://img.shields.io/github/issues/banbar/dide)
![GitHub last commit](https://img.shields.io/github/last-commit/banbar/dide)

</div>