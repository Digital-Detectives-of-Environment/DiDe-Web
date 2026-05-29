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
- [Environment Variables](#environment-variables)
- [Quick Start (Localhost)](#quick-start--localhost)
- [Adding Supervisors and Users](#adding-supervisors-and-users)
- [Production Deployment (Ubuntu Server)](#production-deployment--ubuntu-server)
- [Data Integration (Case Study)](#data-integration--case-study)
- [WFS Service Setup](#wfs-service-setup)
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

**Aggregation Layer** — Hexagonal grid-based region selection and region-based event management.

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

### For Localhost (Local Development)

- **Node.js** v18 or higher (v22+ recommended)
- **PostgreSQL** v13 or higher + **PostGIS** extension
- **npm**
- **pgAdmin 4** — Required for running SQL queries on your local machine. Download from [pgadmin.org](https://www.pgadmin.org/download/).
- **OS:** Windows, Linux, or macOS

> **Note for localhost users:** All SQL operations in this guide (creating databases, running table scripts, adding data) are performed through the **pgAdmin 4** graphical interface. Instructions below describe exactly where to click in pgAdmin 4.

### For Production (Ubuntu Server)

- **Ubuntu** 22.04 or 24.04 LTS
- **A registered domain name** — Required to obtain an SSL certificate. Without a domain, HTTPS/SSL cannot be configured.
- All other dependencies (Node.js, PostgreSQL, Nginx, etc.) are installed automatically by the setup script.

> **Note for production users:** All SQL operations on Ubuntu Server are performed through the **terminal** (psql command-line tool). There is no graphical interface on the server.

#### PostgreSQL Installation (Localhost only)

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

#### pgAdmin 4 Installation (Localhost only)

Download and install pgAdmin 4 from [pgadmin.org/download](https://www.pgadmin.org/download/). It is available for Windows, macOS, and Linux.

After installation, open pgAdmin 4 and connect to your local PostgreSQL server:
1. In the left panel, right-click **Servers** → **Register** → **Server**
2. Under the **General** tab, give it a name (e.g. `Local`)
3. Under the **Connection** tab: Host = `127.0.0.1`, Port = `5432`, Username = `postgres`
4. Enter your PostgreSQL password and click **Save**

---

## Environment Variables

Create a `.env` file in the project root directory. Parameters marked as **hardcoded** do not need to be added to `.env` — they are set automatically in the application code.

```env
# ── SERVER ──
PORT=3000                                          # Port the application runs on
                                                   # Example: PORT=3000
CORS_ORIGIN=http://localhost:3000                  # Comma-separated list of allowed frontend origins
                                                   # Example (production): CORS_ORIGIN=https://yourdomain.com

# ── POSTGRESQL DATABASE ──
PGUSER=postgres                                    # PostgreSQL username
PGPASSWORD=your_password                           # PostgreSQL password
PGDATABASE=dide_db                                 # Name of the database
PGPOOL_MAX=150                                     # Max number of DB connections in the pool
                                                   

# ── JWT SECURITY ──
JWT_SECRET=dev-secret                              # Secret key used to sign JWT tokens — must be a long random string in production
                                                   # Example: JWT_SECRET=xK9#mP2$qL8vRn5wYz
# ── EMAIL VERIFICATION ──
VERIFY_EMAIL_TEXT=terms_conditions.html            # HTML file displayed during email verification
                                                   # Example: VERIFY_EMAIL_TEXT=terms_conditions.html
# ── SMTP EMAIL ──
SMTP_HOST=smtp.gmail.com                           # SMTP server hostname
SMTP_PORT=587                                      
SMTP_USER=your@gmail.com                           # Sender email address
SMTP_PASS=app_password                             # SMTP password or Gmail App Password  Example: SMTP_PASS=abcdefghijklmnop
SMTP_FROM_NAME=DiDe                                # Display name shown in the From field of outgoing emails
SMTP_FROM_EMAIL=your@gmail.com                     # Sender email address
                                                  
# ── SITE SETTINGS ──
SITE_TITLE=DiDe                                    # Browser tab title and page heading
SITE_LOGO_URL=/DiDe-Logo.png                       # Path to the logo 

# ── ALLOWED EMAIL DOMAINS FOR REGISTRATION ──
ALLOWED_EMAIL_DOMAIN=                              # Semicolon-separated list of allowed email domains; leave empty to allow all
                                                   # Example: ALLOWED_EMAIL_DOMAIN=hacettepe.edu.tr;gmail.com
# ── MAP SETTINGS ──
MAP_INITIAL_LAT=45.4642                            # Map center latitude on first load for Milano (45.4642)
MAP_INITIAL_LNG=9.1900                             # Map center longitude on first load for Milano (9.1900)
MAP_INITIAL_ZOOM=12                                # Initial zoom level (1 = world, 12= Campus, 18 = street level)

# ── LANGUAGE SETTING ──
DEFAULT_LANG=IT                                    # Default UI language; must match a file name in the i18n/ folder  

# ── CASE STUDY (RASTER LAYER) ──
CASE_STUDY=Milano                                  # Folder name under case_study/; TIF files are read from case_study/<CASE_STUDY>/raw_data/Raster/
                                                   # Example: CASE_STUDY=Ankara  → reads from case_study/Ankara/raw_data/Raster/
# ── GIS / AGGREGATION SETTINGS ──
AGGREGATION_LAYER=                                 # PostGIS table name for the aggregation/hexagonal grid layer; leave empty to disable
                                                   # Example: AGGREGATION_LAYER=h3_milan
Display_Attribute=                                 # Column(s) shown in the aggregation grid info popup (semicolon-separated)
                                                   # Example: Display_Attribute=h3_index;district_name

# ── QFIELD SYNC ──
QFIELD_SYNC_ROOT=                                  # Absolute path to the QField sync folder; leave empty to disable
                                                   # Example: QFIELD_SYNC_ROOT=/var/www/dide/qfield-sync
```

> **For Gmail users:** Enable 2-Step Verification in your Google Account, then generate an App Password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and use it as `SMTP_PASS`.

---

## Quick Start — Localhost

Follow these steps in order to clone the project and run it on your local machine.

### Step 1: Clone the Repository

```bash
git clone https://github.com/Digital-Detectives-of-Environment/DiDe-Web.git
cd DiDe-Web/
```

### Step 2: Install NPM Packages

```bash
npm install
```

### Step 3: Create the Database and Core Tables (pgAdmin 4)

All database operations on localhost are done through **pgAdmin 4**.

**3a — Create the database:**
1. Open pgAdmin 4 and connect to your local server
2. In the left panel, right-click **Databases** → **Create** → **Database**
3. Enter `dide_db` as the database name and click **Save**


**3b — Create the core tables:**
1. In pgAdmin 4, with `dide_db` selected, open the **Query Tool**
2. Click **File** → **Open File** in the Query Tool toolbar
3. Navigate to `docs/initial setup/1_database_tables.sql` and open it
4. Click **▶ Execute** (or press `F5`) to run the script

This creates the `users`, `event_type`, and `event` tables.

### Step 4: Create the `.env` File

Create a `.env` file in the project root directory. For all parameters and their descriptions, see the [Environment Variables](#environment-variables) section above.

### Step 5: Start the Application

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

*On localhost (pgAdmin 4):*
1. Open pgAdmin 4 → select `dide_db` → open the **Query Tool**
2. Click **File** → **Open File**, navigate to `docs/initial setup/2_example_experts.sql`, and open it
3. Click **▶ Execute** to run. This adds 8 test users (default password: `12345Aa`).

*On Ubuntu Server (terminal):*
```bash
sudo -u postgres psql -d dide_db -f "docs/initial setup/2_example_experts.sql"
```

**Method 3 — Manual SQL:**

*On localhost (pgAdmin 4):*
1. Open pgAdmin 4 → select `dide_db` → open the **Query Tool**
2. Paste the SQL below and click **▶ Execute**:

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

*On Ubuntu Server (terminal):*
```bash
sudo -u postgres psql -d dide_db -c "
INSERT INTO public.users (username, password_hash, role, email, email_verified, is_verified, is_active)
VALUES (
  'your_username',
  crypt('YourPassword123.', gen_salt('bf', 10)),
  'user',
  'example@email.com',
  true, true, true
);"
```

### Adding a Supervisor

Supervisor accounts require **two-factor authentication (2FA)**, so the creation process is different:

**Step 1 — Generate a 2FA secret code:**
```bash
node "docs/initial setup/generate-2fa-secret.js"
```
Note down the BASE32 code from the output.

**Step 2 — Add the supervisor to the database:**

*On localhost (pgAdmin 4):*
1. Open pgAdmin 4 → select `dide_db` → open the **Query Tool**
2. Paste the SQL below (replace the placeholder values) and click **▶ Execute**:

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

*On Ubuntu Server (terminal):*
```bash
sudo -u postgres psql -d dide_db -c "
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
);"
```

**Step 3 — Set up the Authenticator app:**
Enter the BASE32 code into Google Authenticator or a similar app on the supervisor's phone. A 6-digit verification code from this app will be required during login.

For detailed examples, see the `4_adding_a_supervisor.sql` explanation in [docs/README.md](docs/README.md).

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
git clone https://github.com/Digital-Detectives-of-Environment/DiDe-Web.git
cd dide
```

### 3. Create the `.env` File

```bash
nano .env
```

Create your `.env` file using the parameters described in the [Environment Variables](#environment-variables) section above. Key values to update for production:

- `CORS_ORIGIN=https://yourdomain.com`
- `JWT_SECRET=a-very-strong-random-key`

> `COOKIE_SECURE` is automatically set to `true` in production (when `NODE_ENV=production`). You do not need to add it to `.env`.

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

DiDe uses **Let's Encrypt** with **Certbot** to obtain a free SSL/TLS certificate. Let's Encrypt is a free, automated certificate authority — it issues certificates based on domain ownership verification. This means **you must have a registered domain name** pointing to your server's IP address before running these commands.

```bash
sudo apt update
sudo apt install -y snapd
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d yourdomain.com
```

Certbot will automatically detect your Nginx configuration and configure HTTPS. The certificate is valid for 90 days and **renews automatically** via a system timer.

After obtaining the certificate, your site will be accessible at `https://yourdomain.com`. The `COOKIE_SECURE` flag is handled automatically by the application — no `.env` change is needed.

---

## Data Integration — Case Study

While the system is running, you can integrate study area-specific data (buildings, roads, H3 grid, etc.) into the system. All study area data is kept in the `case_study/` folder.

> The steps below apply to both **localhost** and **production**. SQL execution method differs by environment — use pgAdmin 4 on localhost, and the terminal on Ubuntu Server.

### Adding Existing Data

**1. Run the SQL files in the database:**

*On localhost (pgAdmin 4):*
1. Open pgAdmin 4 → select `dide_db` → open the **Query Tool**
2. Click **File** → **Open File**, navigate to the SQL file, and open it
3. Click **▶ Execute** to run

```
case_study/Milano/existing_data/buildings.sql
case_study/Milano/existing_data/roads.sql
```

*On Ubuntu Server (terminal):*
```bash
sudo -u postgres psql -d dide_db -f case_study/Milano/existing_data/buildings.sql
sudo -u postgres psql -d dide_db -f case_study/Milano/existing_data/roads.sql
```

**2.** Log in as a Supervisor → **Administration Panel** → **Existing Data** tab.

**3.** Select the added tables and configure their visibility:
- **Public** → visible to everyone without logging in
- **Private** → visible only to logged-in users

### Adding the Aggregation Layer

**1. Run the H3 SQL file:**

*On localhost (pgAdmin 4):*
1. Open pgAdmin 4 → select `dide_db` → open the **Query Tool**
2. Click **File** → **Open File**, navigate to `case_study/Milano/aggregation_layer/h3_milan.sql`, and open it
3. Click **▶ Execute** to run

*On Ubuntu Server (terminal):*
```bash
sudo -u postgres psql -d dide_db -f case_study/Milano/aggregation_layer/h3_milan.sql
```

**2.** Update the `.env` file:
```env
AGGREGATION_LAYER=h3_milan
Display_Attribute=h3_index
```

**3.** Restart the application:
```bash
# Localhost
npm start

# Ubuntu Server
pm2 restart dide
```

For details, see [case_study/README.md](case_study/README.md).

---

## WFS Service Setup

To set up a WFS (Web Feature Service) with GeoServer in a production environment, use the `GEOSERVER_WFS_setup.sh` script in the project root directory.

### Prerequisites

- DiDe must be running in a production environment (Nginx + PM2 active)
- The `.env` file must be configured

### Setup Steps

**1. Run the script:**
```bash
sudo bash GEOSERVER_WFS_setup.sh \
  --env-file /var/www/dide/dide/.env \
  --gs-admin-user admin \
  --gs-admin-pass geoserver
```

> **Important:** The `--gs-admin-pass` value above is the initial GeoServer admin password used during setup. After installation is complete, **change this password immediately** through the GeoServer web interface: open `http://YOUR_SERVER_IP/geoserver/` in a browser → log in with your admin credentials → **Security** → **Users, Groups, Roles** → edit the `admin` user → set a new strong password.

### What the Script Does

- Installs **Java 17 (JRE)**
- Downloads, installs, and creates a systemd service for **GeoServer**
- Creates a **Flask/Gunicorn**-based authentication service (authenticates WFS requests against DiDe users)
- Adds WFS location blocks to the **Nginx** configuration (`/wfs`, `/geoserver/wfs`)
- Creates a **PostGIS datastore** in GeoServer
- Publishes the `event` table (active events) as a **WFS layer**

### WFS Access

After setup:

```bash
# GeoServer admin panel (in browser):
http://SERVER_IP/geoserver/

# WFS GetCapabilities (GeoServer UI — no auth):
http://SERVER_IP/geoserver/wfs?service=WFS&request=GetCapabilities

# WFS with DiDe user authentication (Basic Auth):
curl -u "username:password" "http://SERVER_IP/wfs?service=WFS&request=GetCapabilities"
```

WFS is protected by the credentials of active users with the `supervisor` role in the DiDe database. You can connect from QGIS or other GIS software using Basic Auth.

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
- Use HTTPS — obtain an SSL certificate with Certbot (see [SSL Certificate](#6-ssl-certificate-https))
- Never commit your `.env` file to version control
- Use a strong PostgreSQL password
- Configure the server firewall (UFW)
- Change the default GeoServer admin password after setup

---

## Project Structure

```
dide/
├── index.js                    ← Main server file (Express.js)
├── package.json                ← NPM dependencies
├── .env                        ← Environment variables (must be created — never commit)
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
│   └── Milano/                 ← Example: Milan study area (set via CASE_STUDY in .env)
│       ├── existing_data/      ← SQL data files
│       ├── raw_data/           ← Raw data (Vector + Raster TIF files)
│       └── aggregation_layer/  ← aggregation layer files
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


</div>