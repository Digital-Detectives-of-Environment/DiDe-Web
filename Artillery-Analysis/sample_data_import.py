import os
import sys
import json
import shutil
import secrets
import time
from pathlib import Path
from typing import Any, Dict, Optional

import psycopg2
from dotenv import load_dotenv




event_type: str = "water fountain"

# If True, a copy of "Artillery-Analysis/img 1.png" is attached as photo_urls
# for EVERY inserted feature. If False, photo_urls is the JSON string "[]".
with_photo: bool = True

created_by_name: str = "ibrahim"
created_by_role: str = "user"
created_by_id: Optional[int] = None  # set to a real users.id if you have one




def find_project_root(start: Path) -> Path:
    """Walk up until we find '.env', 'index.js' or 'package.json'."""
    start = start.resolve()
    for candidate in [start, *start.parents]:
        if (candidate / ".env").exists():
            return candidate
        if (candidate / "index.js").exists():
            return candidate
        if (candidate / "package.json").exists():
            return candidate
    return start


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = find_project_root(SCRIPT_DIR)

GEOJSON_PATH = ROOT / "case_study" / "Milano" / "raw_data" / "Vector" / "One_Health_POI.geojson"
UPLOAD_DIR = ROOT / "public" / "uploads"
ENV_PATH = ROOT / ".env"


def find_photo() -> Optional[Path]:
    """Search a few sensible locations for the photo file."""
    candidates = [
        ROOT / "Artillery-Analysis" / "img" / "1.png",
        SCRIPT_DIR / "img 1.png",
        ROOT / "img 1.png",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


# DB CONNECTION 

def build_db_connection_kwargs() -> Dict[str, Any]:
    database_url = (os.getenv("DATABASE_URL") or "").strip()

    ssl_env = (
        os.getenv("PGSSL")
        or os.getenv("PGSSLMODE")
        or os.getenv("DATABASE_SSL")
        or ""
    ).lower()
    ssl_from_url = ("sslmode=require" in database_url.lower()
                    or "ssl=true" in database_url.lower())
    need_ssl = ssl_env in ("1", "true", "require") or ssl_from_url

    if database_url:
        kwargs: Dict[str, Any] = {"dsn": database_url}
    else:
        kwargs = {
            "host": os.getenv("PGHOST"),
            "port": int(os.getenv("PGPORT", "5432")),
            "user": os.getenv("PGUSER"),
            "password": os.getenv("PGPASSWORD"),
            "dbname": os.getenv("PGDATABASE"),
        }

    if need_ssl:
        kwargs["sslmode"] = "require"
    return kwargs


def open_connection():
    kw = build_db_connection_kwargs()
    if "dsn" in kw:
        dsn = kw.pop("dsn")
        return psycopg2.connect(dsn, **kw)
    return psycopg2.connect(**kw)




def resolve_event_type_id(cur, name: str) -> int:
    cur.execute(
        """
        SELECT event_type_id
        FROM public.event_type
        WHERE event_type_name = %s
          AND COALESCE(active, true) = true
        LIMIT 1
        """,
        (name,),
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(
            f"event_type_name='{name}' not found (or inactive) in public.event_type."
        )
    return int(row[0])


def copy_photo_to_uploads(src: Path, upload_dir: Path) -> str:
    """Copy `src` into upload_dir with a unique name; return '/uploads/<name>'."""
    upload_dir.mkdir(parents=True, exist_ok=True)
    ext = src.suffix or ".png"
    fname = f"{int(time.time() * 1000)}_{secrets.token_hex(6)}{ext}"
    dst = upload_dir / fname
    shutil.copyfile(src, dst)
    return f"/uploads/{fname}"


def pick_description(props: Dict[str, Any]) -> str:
    if not isinstance(props, dict):
        return ""
    for key in ("description", "name", "NAME", "Name", "amenity", "fclass"):
        v = props.get(key)
        if v not in (None, ""):
            return str(v)
    return ""

# Main
def main() -> None:
    print(f"[PATH] script dir   : {SCRIPT_DIR}")
    print(f"[PATH] project root : {ROOT}")
    print(f"[PATH] geojson      : {GEOJSON_PATH}")
    print(f"[PATH] upload dir   : {UPLOAD_DIR}")
    print(f"[PATH] .env         : {ENV_PATH}")
    print()

    if ENV_PATH.exists():
        load_dotenv(ENV_PATH)
    else:
        print(f"[WARN] .env not found at {ENV_PATH}. Falling back to process env.")
        load_dotenv()

    # ---- Photo resolution ----
    photo_path: Optional[Path] = None
    if with_photo:
        photo_path = find_photo()
        if photo_path is None:
            print("[FATAL] with_photo=True but no photo found in any of these locations:")
            for c in [
                ROOT / "Artillery-Analysis" / "img 1.png",
                SCRIPT_DIR / "img 1.png",
                ROOT / "img 1.png",
            ]:
                print(f"   - {c}   (exists={c.exists()})")

            artillery_dir = ROOT / "Artillery-Analysis"
            if artillery_dir.exists():
                print(f"\n   Files actually present in {artillery_dir}:")
                for f in sorted(artillery_dir.iterdir()):
                    tag = "  <DIR>" if f.is_dir() else f"  {f.stat().st_size} bytes"
                    print(f"     {f.name}{tag}")
            else:
                print(f"\n   The folder {artillery_dir} does NOT exist.")
            sys.exit(1)
        print(f"[PATH] photo source : {photo_path}")
        print()

    # ---- GeoJSON ----
    if not GEOJSON_PATH.exists():
        print(f"[FATAL] GeoJSON not found: {GEOJSON_PATH}")
        sys.exit(1)

    with open(GEOJSON_PATH, "r", encoding="utf-8") as f:
        gj = json.load(f)

    features = gj.get("features", []) if isinstance(gj, dict) else []
    if not features:
        print("[INFO] No features in GeoJSON, nothing to insert.")
        return

    # ---- DB ----
    conn = open_connection()
    conn.autocommit = False
    cur = conn.cursor()

    inserted = 0
    skipped = 0

    try:
        event_type_id = resolve_event_type_id(cur, event_type)
        print(f"[INFO] event_type '{event_type}' -> event_type_id={event_type_id}")

        for idx, feat in enumerate(features):
            geom = feat.get("geometry") or {}
            if geom.get("type") != "Point":
                skipped += 1
                continue
            coords = geom.get("coordinates") or []
            if len(coords) < 2:
                skipped += 1
                continue
            try:
                lng = float(coords[0])
                lat = float(coords[1])
            except (TypeError, ValueError):
                skipped += 1
                continue

            props = feat.get("properties") or {}
            description = pick_description(props)

            # ----- photo -----
            if with_photo and photo_path is not None:
                photo_url = copy_photo_to_uploads(photo_path, UPLOAD_DIR)
                photo_urls_json = json.dumps([photo_url])
            else:
                photo_urls_json = json.dumps([])
            video_urls_json = json.dumps([])

            # ----- INSERT -----
            cur.execute(
                """
                INSERT INTO public.event (
                    latitude, longitude, event_type, description, geom,
                    created_by_name, created_by_role_name, created_by_id, active,
                    photo_urls, video_urls
                ) VALUES (
                    %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                    %s, %s, %s, true,
                    %s::text, %s::text
                )
                """,
                (
                    lat, lng, event_type_id, description,
                    lng, lat,
                    created_by_name, created_by_role, created_by_id,
                    photo_urls_json, video_urls_json,
                ),
            )
            inserted += 1

            if (idx + 1) % 100 == 0:
                print(f"[PROGRESS] processed {idx + 1}/{len(features)} "
                      f"(inserted={inserted}, skipped={skipped})")

        conn.commit()
        print(f"\n[DONE] inserted={inserted}, skipped={skipped}, "
              f"total_features={len(features)}")
    except Exception as e:
        conn.rollback()
        print(f"[ERROR] Rolled back. Reason: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()