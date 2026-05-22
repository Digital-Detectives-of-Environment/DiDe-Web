# Case Study — Study Area Data

This folder contains **study area-specific data** to be integrated into the DiDe system. All files here are **variable** — when working with a different city or region, create a new folder under this directory (e.g. `Ankara/`, `Istanbul/`) and prepare your own data following the same structure.

> **Important:** None of the files in this folder are required for the system to run. The system can be started without them. Data is added to the PostgreSQL database while the system is running, then made visible on the site through the administration panel.

---

## Folder Structure

```
case_study/
└── Milano/                         ← Study area (example: Milan)
    ├── existing_data/              ← Vector data converted to SQL via QGIS
    │   ├── buildings.sql
    │   └── roads.sql
    ├── raw_data/                   ← Raw data sources
    │   ├── Vector/                 ← Vector data (GeoPackage, GeoJSON)
    │   │   ├── buildings.gpkg
    │   │   ├── roads.gpkg
    │   │   └── sample_batch_import.geojson
    │   └── Raster/                 ← Raster data (GeoTIFF)
    │       ├── M1.tif
    │       ├── M2.tif
    │       ├── M3.tif
    │       └── M4.tif
    └── aggregation_layer/          ← H3 grid / aggregation layer
        ├── h3_milan.sql
        └── h3_milan.geojson
```

---

## 1. `existing_data/` — Existing Data (SQL Files)

### What are these files?

`buildings.sql` and `roads.sql` are PostgreSQL/PostGIS-compatible SQL dump files containing building and road data for the Milan area. This data was downloaded in raw vector format (GeoPackage — `.gpkg`) from **OpenStreetMap (OSM)** or similar open data sources, then converted to SQL format importable into PostgreSQL using QGIS.

### How was the raw data downloaded?

1. **OpenStreetMap (OSM)** data for the Milan region was downloaded from services such as [Geofabrik](https://download.geofabrik.de/) or [BBBike](https://extract.bbbike.org/).
2. The downloaded data was opened in QGIS, filtered, and edited.
3. Relevant layers (buildings, roads) were saved in GeoPackage (`.gpkg`) format under `raw_data/Vector/`.

### Steps to create SQL files in QGIS (for PostgreSQL)

These steps describe the process of converting raw vector data into SQL files that can be imported into a PostgreSQL database using QGIS:

1. **Set up a PostgreSQL connection in QGIS:**
   - QGIS → Browser panel → **PostgreSQL** → right-click → **New Connection**
   - Host: your database IP address (localhost or server IP)
   - Port: `5432`
   - Database: the `PGDATABASE` value from your `.env` file
   - Username / Password: the `PGUSER` / `PGPASSWORD` values from your `.env` file

2. **Load the raw vector data into QGIS:**
   - Drag and drop the `.gpkg` files from `raw_data/Vector/` into QGIS.

3. **Export the layer to PostgreSQL SQL dump:**
   - Right-click the layer → **Export** → **Save Features As...**
   - Format: **PostgreSQL SQL dump**
   - File name: save as `buildings.sql` or `roads.sql`.
   - CRS: set to **EPSG:4326**.
   - Click **OK**.

4. Place the resulting `.sql` file in the `existing_data/` folder.

> **Alternative method:** You can also convert directly using `ogr2ogr`:
> ```bash
> ogr2ogr -f "PGDUMP" buildings.sql raw_data/Vector/buildings.gpkg -lco GEOMETRY_NAME=geom -t_srs EPSG:4326
> ```

---

## 2. `raw_data/` — Raw Data

### Vector/
- `buildings.gpkg` — Milan building data (GeoPackage format)
- `roads.gpkg` — Milan road data (GeoPackage format)
- `sample_batch_import.geojson` — Sample GeoJSON file for batch import

### Raster/
- `M1.tif`, `M2.tif`, `M3.tif`, `M4.tif` — GeoTIFF raster data for the Milan area (satellite imagery, land use, etc.)

These raster files are displayed as background layers on the map while the system is running. They are read from the `case_study/Milano/raw_data/Raster/` directory in the code.

---

## 3. `aggregation_layer/` — H3 Aggregation Layer

### What are these files?

- `h3_milan.geojson` — H3 hexagonal grid data for the Milan area in GeoJSON format.
- `h3_milan.sql` — The same data in PostgreSQL-importable SQL dump format.

### How were these files created?

The H3 grid files were generated using a Python script. The script produces H3 hexagonal cells within the defined study area boundaries and converts them to GeoJSON / SQL format. **These files are variable** — a different H3 file must be generated for a different study area.

### How to add the H3 file to `.env`

After running the H3 SQL file in the database, the resulting table name must be written to the `AGGREGATION_LAYER` parameter in the `.env` file. Detailed information is provided in the "Integration into the System" section below.

---

## Integration into the System — Step by Step

> **Prerequisite:** The DiDe system must be running and the PostgreSQL database must be set up. For installation instructions, see the [README.md](../README.md) in the project root directory.

### Step 1: Run SQL Files in the Database

Run the SQL files in the `existing_data/` folder in the PostgreSQL database to create the tables:

```bash
# Using pgAdmin Query Tool or psql:
psql -U postgres -d dide_db -f case_study/Milano/existing_data/buildings.sql
psql -U postgres -d dide_db -f case_study/Milano/existing_data/roads.sql
```

After running these commands, the `buildings` and `roads` tables will be created in the database. **However, these tables will not yet be visible on the frontend (website).**

### Step 2: Making Data Visible on the Site

1. Log in with a Supervisor account.
2. Go to **Administration Panel** → **Existing Data** tab.
3. On this page, the tables you added to the database (buildings, roads, etc.) will be listed.
4. For each table:
   - Select which data you want to be visible on the site.
   - If you mark it as **Public**: everyone can see it without logging in.
   - If you mark it as **Private**: only logged-in users can see it.
5. Save your selections.

The data you selected will now be visible on the map.

### Step 3: Adding the H3 Aggregation Layer

1. Run the `h3_milan.sql` file in the database:

```bash
psql -U postgres -d dide_db -f case_study/Milano/aggregation_layer/h3_milan.sql
```

2. After running this command, the `h3_milan` table will be created in the database.

3. Open the `.env` file in the project root directory and fill in the following parameters:

```env
# Write the created table name here
AGGREGATION_LAYER=h3_milan

# Specify which column in the h3_milan table will be the Primary Key
# You MUST fill in AT LEAST ONE of these 2 parameters
PK1=h3_index
PK2=
```

- `AGGREGATION_LAYER` — The table name created in the database (e.g. `h3_milan`).
- `PK1` — Determines which column in the `h3_milan` table will be the primary key. Examine the table's columns and select the appropriate one.
- `PK2` — Secondary key column (optional). Fill in if needed.
- **You must fill in at least one of these 2 parameters (`PK1`, `PK2`)**, otherwise the aggregation layer will not appear on the login screen.

4. After saving the `.env` file, restart the application:

```bash
# For localhost:
npm start

# For production (PM2):
pm2 restart dide
```

Users will now see the H3 grid on the login screen and will be able to select a region.

---

## For a Different Study Area

All files under this folder **vary according to the study area**. For example, if you are working with Ankara:

1. Create a `case_study/Ankara/` folder.
2. Create the same subfolder structure (`existing_data/`, `raw_data/`, `aggregation_layer/`).
3. Download data for Ankara and repeat the steps above.
4. Update the `AGGREGATION_LAYER`, `PK1`, `PK2` parameters in the `.env` file according to your new table.
5. Also update the map starting coordinates in the `.env` file (`MAP_INITIAL_LAT`, `MAP_INITIAL_LNG`).