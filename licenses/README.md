# DiDe — Data Licenses

This folder holds the **data licenses** that DiDe adds to every ZIP export.
Each type of user downloads a different level of detail, so each gets a different license.

> The file `LICENSE` in the project root is the **software (code) license (GPL-3.0)**.
> It is **not** a data license and must stay where it is.

## Files

| File | Who downloads | Where in the app | What the export contains |
|---|---|---|---|
| `citizen_license.txt` | **Citizen**: any visitor, not logged in | Map → **Open data** button (only when `OPEN_DATA=true`) | Active reports of public event types; no account data; photos |
| `expert_license.txt` | **Expert**: opener / solver | Profile → **Download my data** | The user's own reports (also closed ones), photos and videos |
| `supervisor_license.txt` | **Supervisor** / admin | Management panel → **Events** → download | All active reports listed in the panel, **with usernames and user IDs** (confidential), photos |

**Location privacy:** when an aggregation layer (`AGGREGATION_LAYER`) is configured, the citizen and
expert exports contain **no individual reports**: the ZIP holds `grid_events.geojson` (one polygon feature per
grid cell with its key column(s), `event_count` and `counts_by_type`; the expert export also has
`active_count` / `closed_count`) plus the license — no coordinates, descriptions, photos or videos.
The supervisor export is unchanged: individual reports with exact coordinates and grid keys.

In short, the stricter the data, the stricter the license:

- **Citizen**: open, non-commercial use with attribution; no re-identification.
- **Expert**: own content stays the user's; protect third parties and the user's own location history.
- **Supervisor**: confidential internal data; purpose limitation, minimisation, retention and incident duties.

## Configuration (`.env`)

Write only the **file name**. The file is read from this `license/` folder.

```env
LICENSE_CITIZEN=citizen_license.txt
LICENSE_EXPERT=expert_license.txt
LICENSE_SUPERVISOR=supervisor_license.txt
```

- The license is added to the ZIP under the same file name.
- Files are read at every download, so after editing a license **no restart is needed**.
  After changing a `.env` value, restart the app (e.g. `pm2 restart all`).
- At startup the console shows `[OK] LICENSE_CITIZEN: license/citizen_license.txt` and so on.
  A `[WARN]` line means the variable is missing or the file was not found. In that case,
  the ZIPs for that user type are downloaded **without** a license.
- Migration: if a role variable is not set but the old single `LICENSE=...` (a file in the
  project root) still is, the old file is used for that role and a warning is printed.
  Once the three new variables are set, the old `LICENSE` variable and its file can be removed.

## Editing the licenses

You can replace the texts with your own, for example after a legal review.
Keep in mind:

- Describe what the export **actually contains**. If you add or remove fields in an export,
  update the matching license.
- When you change the terms, raise the version number at the top.
  Data downloaded earlier stays under the version that was delivered with it.
- These texts are a practical starting point, **not legal advice**.
  Have them reviewed by a lawyer, especially regarding KVKK (Law No. 6698) and the EU GDPR,
  before relying on them.