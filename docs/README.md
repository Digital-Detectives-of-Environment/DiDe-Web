# Docs — Documentation and Setup Files

This folder contains SQL files, helper scripts, and documentation images used during the DiDe project setup process.

---

## Folder Structure

```
docs/
├── initial setup/                  ← Files required for initial setup
│   ├── 1_database_tables.sql       ← Database table structure
│   ├── 2_example_experts.sql       ← Example users (optional)
│   ├── 3_DiDe_setup.txt            ← Quick setup note
│   ├── 4_adding_a_supervisor.sql   ← Supervisor creation query
│   ├── generate-2fa-secret.js      ← 2FA secret generator script
│   └── install_dide.sh             ← Automated server setup script (Ubuntu)
└── img/                            ← Documentation images
    ├── 1.jpg ... 7.jpg
    ├── qfield-1.png
    └── qfield-2.jpg
```

---

## `initial setup/` — Initial Setup Files

The files in this folder are used sequentially when **starting the system for the first time**. It is recommended to follow the numbering order.

### 1. `1_database_tables.sql` — Database Tables

This file creates the core tables required for the DiDe system to operate:

- **`users`** — User table (username, password hash, role, email, 2FA information, etc.)
- **`olaylar`** — Event types table (event name, active/inactive status, creator information)
- **`olay`** — Events table (coordinates, event type, description, photo/video URLs, geometry)

It also creates the required PostgreSQL extensions (`pgcrypto`, `postgis`) and indexes.

**Usage:**
```bash
# Run with psql:
psql -U postgres -d dide_db -f "docs/initial setup/1_database_tables.sql"

# Or paste the file contents in pgAdmin's Query Tool and execute.
```

> **This file is mandatory.** The system will not work without these tables.

---

### 2. `2_example_experts.sql` — Example Users (Optional)

Adds 8 sample `user`-role accounts to the database for testing purposes. Each user has a default password of `12345Aa`.

Example users added: `hu`, `afad1`, `afad2`, `afad3`, `hgm1`, `hgm2`, `cbs1`, `cbs2`

**Usage:**
```bash
psql -U postgres -d dide_db -f "docs/initial setup/2_example_experts.sql"
```

> This file is optional. In a real environment, you can create your own users via the registration screen or via SQL.

---

### 3. `3_DiDe_setup.txt` — Quick Setup Note

Contains brief reminder notes about installing NPM packages and configuring the `.env` file.

---

### 4. `4_adding_a_supervisor.sql` — Adding a Supervisor

SQL query used to add a Supervisor (administrator) user. Supervisor accounts require **two-factor authentication (2FA)**, so the creation process differs from regular users.

**Steps to add a supervisor:**

1. **Generate a 2FA secret code:**
   ```bash
   node "docs/initial setup/generate-2fa-secret.js"
   ```
   This command will output a BASE32 code. Note it down.

2. **Edit the SQL query:**
   Open `4_adding_a_supervisor.sql` and modify the following fields with your own information:
   - `username` — Supervisor username
   - `crypt('PASSWORD', gen_salt('bf', 10))` — Password (inside single quotes)
   - `name`, `surname`, `email` — Personal information
   - `two_factor_secret` — The BASE32 code generated in step 1

3. **Run the SQL query:**
   ```bash
   psql -U postgres -d dide_db -f "docs/initial setup/4_adding_a_supervisor.sql"
   ```

4. **Set up the Authenticator app:**
   Enter the BASE32 code into Google Authenticator or a similar app on the supervisor's phone. A 6-digit code from this app will be required during login.

> **Note:** You can add multiple supervisors. A separate BASE32 code must be generated for each one.

---

### 5. `generate-2fa-secret.js` — 2FA Secret Generator

Generates the TOTP (Time-based One-Time Password) secret code required for Supervisor accounts. Uses the `speakeasy` library.

**Usage:**
```bash
# After running npm install in the project root directory:
node "docs/initial setup/generate-2fa-secret.js"
```

The output will provide a BASE32 code and a QR code URL.

---

### 6. `install_dide.sh` — Automated Server Setup Script

An automated setup script designed to install DiDe from scratch on an Ubuntu server. It automatically performs the following:

- System update and essential package installation
- PostgreSQL + PostGIS installation
- Node.js 22 installation
- Nginx installation and reverse proxy configuration
- UFW firewall settings
- Reading database information from the `.env` file
- Creating the database and tables (runs `1_database_tables.sql`)
- Importing the aggregation layer (H3 polygon) to the database if configured
- Installing NPM packages
- Starting the application with PM2

**Usage:**
```bash
chmod +x "docs/initial setup/install_dide.sh"
sudo bash "docs/initial setup/install_dide.sh"
```

> **Prerequisite:** The `.env` file must be created in the project directory before running the script. For details, see the [README.md](../README.md) in the project root directory.

---

## `img/` — Documentation Images

Contains screenshots and explanatory images used in the project documentation. Includes QField mobile app integration visuals and general usage images.