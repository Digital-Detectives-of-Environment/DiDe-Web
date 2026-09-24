// index.js 
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const speakeasy = require('speakeasy');

const fs = require('fs');
const multer = require('multer');
const mimeTypes = require('mime-types');


const app = express();

/* ===================== GENEL ===================== */
const PORT = parseInt(process.env.PORT, 10);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = '7d';                          // hardcoded
const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAIN || '')
  .split(';')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);


// Hardcoded defaults (removed from .env)
const SHOW_GOOD_EVENTS_ON_LOGIN = true;
const SHOW_BAD_EVENTS_ON_LOGIN = false;
const MAP_MIN_ZOOM = 2;
const TABLE_PAGE_SIZE_EVENTS = 5;
const TABLE_PAGE_SIZE_TYPES = 20;
const TABLE_PAGE_SIZE_USERS = 30;


const QFIELD_SYNC_ROOT = process.env.QFIELD_SYNC_ROOT || '';              
const QFIELD_INGEST_INTERVAL_MS = parseInt(process.env.QFIELD_INGEST_INTERVAL_MS, 10);

const POLYGON_FILE  = process.env.AGGREGATION_LAYER || '';
const DEFAULT_LANG  = (process.env.DEFAULT_LANG || 'TR').toUpperCase();
const POLYGON_TABLE = POLYGON_FILE
  ? path.basename(POLYGON_FILE).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_')
  : '';

// Display_Attribute: columns to show in grid confirmation (semicolon-separated)
const DISPLAY_ATTR_RAW = (process.env.Display_Attribute || '').trim();
const DISPLAY_ATTRS = DISPLAY_ATTR_RAW ? DISPLAY_ATTR_RAW.split(';').map(s => s.trim()).filter(Boolean) : [];

// restrictGNSS: olay ekleme yöntemini kontrol eder. Bu parametre ZORUNLUDUR;
// boş bırakılamaz ve yalnızca "true" veya "false" olabilir. Boş ya da geçersiz
// bir değer verilirse sistem başlamaz (aşağıda doğrulanır).
//   restrictGNSS=True  -> Kullanıcı olay eklerken YALNIZCA GPS butonunu kullanabilir;
//                         haritaya tıklayarak olay ekleyemez ve bildirim formu açılmaz.
//   restrictGNSS=False -> Hem haritaya tıklayarak hem de GPS butonuyla olay eklenebilir.
const RESTRICT_GNSS_RAW  = String(process.env.restrictGNSS || process.env.RESTRICT_GNSS || '').trim();
const RESTRICT_GNSS_NORM = RESTRICT_GNSS_RAW.toLowerCase();
if (RESTRICT_GNSS_NORM !== 'true' && RESTRICT_GNSS_NORM !== 'false') {
  console.error(`\n[FATAL] restrictGNSS is missing or invalid in your .env file.`);
  console.error(`        This parameter is REQUIRED and must be set to either "true" or "false".`);
  console.error(`          restrictGNSS=true  -> Users can add an event ONLY by pressing the GPS button;`);
  console.error(`                                clicking on the map does nothing (no event, no report form).`);
  console.error(`          restrictGNSS=false -> Users can add an event BOTH by clicking on the map`);
  console.error(`                                and by pressing the GPS button.`);
  console.error(`        Current value: "${RESTRICT_GNSS_RAW}" (empty values are not allowed).`);
  console.error(`        System cannot start. Exiting.\n`);
  process.exit(1);
}
const RESTRICT_GNSS = RESTRICT_GNSS_NORM === 'true';

// ==================== EVENT_SUBMIT_INTERVAL_HOURS ====================
// Olay ekleyen (opener) kullanıcıların İKİ GÖNDERİ ARASINDA beklemesi gereken
// süre — SAAT cinsinden. Tam sayı ya da ondalıklı olabilir (1, 2, 24, 0.5 ...).
//   EVENT_SUBMIT_INTERVAL_HOURS=1   -> bir gönderiden sonra yenisi 1 saat sonra
//   EVENT_SUBMIT_INTERVAL_HOURS=0.5 -> 30 dakika
//   EVENT_SUBMIT_INTERVAL_HOURS=    -> (boş) bekleme YOK; istenildiği zaman eklenir
// Boş bırakılabilir; ama yazıldıysa SAYI olmak zorundadır (metin kabul edilmez).
// ==================== BUFFER_RADIUS ====================
// Olay ekleme akışında, seçilen konumun (siyah marker) çevresine çizilen tampon
// bölgenin yarıçapı — METRE cinsinden ve TAM SAYI olmalıdır.
//   BUFFER_RADIUS=10  -> 10 metre yarıçaplı tampon çizilir, içindeki kayıtlar gösterilir
//   BUFFER_RADIUS=    -> (boş) tampon çizilmez; olay ekleme akışı eskisi gibi çalışır
// Ondalıklı ya da metinsel değer kabul edilmez.
const BUFFER_RADIUS_RAW = String(process.env.BUFFER_RADIUS ?? '').trim();
let BUFFER_RADIUS = 0; // 0 = kapalı
if (BUFFER_RADIUS_RAW !== '') {
  const parsedBuf = Number(BUFFER_RADIUS_RAW);
  if (!Number.isInteger(parsedBuf) || parsedBuf <= 0) {
    console.error(`\n[FATAL] BUFFER_RADIUS is invalid in your .env file.`);
    console.error(`        It must be a positive INTEGER value in METERS, or left empty.`);
    console.error(`          BUFFER_RADIUS=10  -> 10 meter buffer around the selected location`);
    console.error(`          BUFFER_RADIUS=    -> no buffer (classic event adding flow)`);
    console.error(`        Decimal or text values are not allowed. Current value: "${BUFFER_RADIUS_RAW}".`);
    console.error(`        System cannot start. Exiting.\n`);
    process.exit(1);
  }
  BUFFER_RADIUS = parsedBuf;
}

// ==================== ROTALAMA (OSRM) ====================
// Rotalama, Docker ile ayağa kalkan üç OSRM servisinden okunur (yaya / bisiklet / araç).
// Adresler .env'den gelir; tarayıcıya ASLA açılmaz, istekler sunucu üzerinden proxy'lenir.
// Varsayılanlar docker-compose.yml ile birebir uyumludur (yalnızca 127.0.0.1'e bağlıdır).
const OSRM_URLS = {
  foot: String(process.env.OSRM_FOOT_URL || 'http://127.0.0.1:5003').trim().replace(/\/+$/, ''),
  bike: String(process.env.OSRM_BIKE_URL || 'http://127.0.0.1:5002').trim().replace(/\/+$/, ''),
  car:  String(process.env.OSRM_CAR_URL  || 'http://127.0.0.1:5001').trim().replace(/\/+$/, '')
};

// Hedefe bu kadar metre yaklaşınca "konuma yaklaştınız" uyarısı verilir (tam sayı, metre).
const ARRIVAL_THRESHOLD_RAW = String(process.env.ROUTE_ARRIVAL_THRESHOLD ?? '').trim();
let ROUTE_ARRIVAL_THRESHOLD = 10;
if (ARRIVAL_THRESHOLD_RAW !== '') {
  const parsedArr = Number(ARRIVAL_THRESHOLD_RAW);
  if (!Number.isInteger(parsedArr) || parsedArr <= 0) {
    console.error(`\n[FATAL] ROUTE_ARRIVAL_THRESHOLD is invalid in your .env file.`);
    console.error(`        It must be a positive INTEGER value in METERS (e.g. 10), or left empty (default 10).`);
    console.error(`        Current value: "${ARRIVAL_THRESHOLD_RAW}".`);
    console.error(`        System cannot start. Exiting.\n`);
    process.exit(1);
  }
  ROUTE_ARRIVAL_THRESHOLD = parsedArr;
}

// Rota sınır denetiminde kullanılan tolerans (metre). Yol geometrisi sınır çizgisine
// teğet geçtiğinde yanlışlıkla elenmesin diye sınır bu kadar genişletilerek kontrol edilir.
const ROUTE_BOUNDARY_TOLERANCE = (() => {
  const v = Number(String(process.env.ROUTE_BOUNDARY_TOLERANCE ?? '').trim());
  return (Number.isFinite(v) && v >= 0 && v <= 500) ? v : 20;
})();

// Şirket logolarının haritada görünmeye başladığı EN KÜÇÜK zoom seviyesi.
// Bu değerin altına (uzaklaştırınca) şirket logoları gizlenir; bu seviyeye gelince
// ya da yakınlaştırınca tüm şirketlerin logoları görünür olur.
const COMPANY_LOGO_MIN_ZOOM = (() => {
  const v = Number(String(process.env.COMPANY_LOGO_MIN_ZOOM ?? '').trim());
  return (Number.isFinite(v) && v >= 0 && v <= 22) ? v : 15;
})();

const EVENT_SUBMIT_INTERVAL_RAW = String(process.env.EVENT_SUBMIT_INTERVAL_HOURS ?? '').trim();
let EVENT_SUBMIT_INTERVAL_HOURS = 0; // 0 = sınır yok
if (EVENT_SUBMIT_INTERVAL_RAW !== '') {
  const parsed = Number(EVENT_SUBMIT_INTERVAL_RAW.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`\n[FATAL] EVENT_SUBMIT_INTERVAL_HOURS is invalid in your .env file.`);
    console.error(`        It must be a number in HOURS (integer or decimal), or left empty.`);
    console.error(`          EVENT_SUBMIT_INTERVAL_HOURS=1    -> one post per hour`);
    console.error(`          EVENT_SUBMIT_INTERVAL_HOURS=0.5  -> one post per 30 minutes`);
    console.error(`          EVENT_SUBMIT_INTERVAL_HOURS=     -> no waiting time between posts`);
    console.error(`        Current value: "${EVENT_SUBMIT_INTERVAL_RAW}".`);
    console.error(`        System cannot start. Exiting.\n`);
    process.exit(1);
  }
  EVENT_SUBMIT_INTERVAL_HOURS = parsed;
}

// ==================== EVENT_TYPE_VALIDITY_UNITS ====================
// "Validity period for the event type to be displayed".
// Controls which time units the supervisor is allowed to enter when creating a
// time-dependent event type. Value is a semicolon-separated list built from the
// canonical units: days, months, seconds. Any subset / combination is allowed
// (e.g. "days", "months", "seconds", "days;months", "days;months;seconds").
// Order does not matter. Singular aliases (day, month, second) are also accepted.
// If the parameter is missing or contains an invalid token, the system will NOT
// start and a meaningful English error is printed.
const EVENT_TYPE_VALIDITY_UNITS_RAW = String(process.env.EVENT_TYPE_VALIDITY_UNITS || '').trim();

// canonical unit -> conversion factor to DAYS
const VALIDITY_UNIT_TO_DAYS = {
  days: 1,
  months: 30,          // 1 month is treated as 30 days
  seconds: 1 / 86400,  // 1 day = 86400 seconds
};
// aliases -> canonical
const VALIDITY_UNIT_ALIASES = {
  day: 'days', days: 'days',
  month: 'months', months: 'months',
  second: 'seconds', seconds: 'seconds',
};

function parseValidityUnits(raw) {
  const errors = [];
  if (!raw) {
    errors.push('EVENT_TYPE_VALIDITY_UNITS is missing or empty.');
    return { units: [], errors };
  }
  const tokens = raw.split(';').map(s => s.trim()).filter(s => s.length > 0);
  if (tokens.length === 0) {
    errors.push('EVENT_TYPE_VALIDITY_UNITS contains no valid tokens (only separators / whitespace found).');
    return { units: [], errors };
  }
  const seen = new Set();
  const units = [];
  for (const tok of tokens) {
    const canonical = VALIDITY_UNIT_ALIASES[tok.toLowerCase()];
    if (!canonical) {
      errors.push(`Invalid unit "${tok}" in EVENT_TYPE_VALIDITY_UNITS. Allowed units are: days, months, seconds.`);
      continue;
    }
    if (seen.has(canonical)) {
      errors.push(`Duplicate unit "${tok}" (resolves to "${canonical}") in EVENT_TYPE_VALIDITY_UNITS.`);
      continue;
    }
    seen.add(canonical);
    units.push(canonical);
  }
  return { units, errors };
}

const { units: EVENT_TYPE_VALIDITY_UNITS, errors: EVENT_TYPE_VALIDITY_UNITS_ERRORS } = parseValidityUnits(EVENT_TYPE_VALIDITY_UNITS_RAW);

if (EVENT_TYPE_VALIDITY_UNITS_ERRORS.length > 0 || EVENT_TYPE_VALIDITY_UNITS.length === 0) {
  console.error(`\n[FATAL] EVENT_TYPE_VALIDITY_UNITS is missing or invalid in your .env file.`);
  console.error(`        This parameter is REQUIRED. It defines which time units the supervisor`);
  console.error(`        can use when creating a time-dependent event type.`);
  console.error(`        It must be a semicolon-separated list of these units: days, months, seconds.`);
  console.error(`        Examples of valid values:`);
  console.error(`          EVENT_TYPE_VALIDITY_UNITS=days`);
  console.error(`          EVENT_TYPE_VALIDITY_UNITS=months`);
  console.error(`          EVENT_TYPE_VALIDITY_UNITS=seconds`);
  console.error(`          EVENT_TYPE_VALIDITY_UNITS=days;months`);
  console.error(`          EVENT_TYPE_VALIDITY_UNITS=days;months;seconds`);
  console.error(`        Current value: "${EVENT_TYPE_VALIDITY_UNITS_RAW}"`);
  for (const err of EVENT_TYPE_VALIDITY_UNITS_ERRORS) {
    console.error(`          - ${err}`);
  }
  console.error(`        System cannot start. Exiting.\n`);
  process.exit(1);
}

// Convert a duration object {days, months, seconds} into a single float number of DAYS.
// Only keys present in EVENT_TYPE_VALIDITY_UNITS are taken into account.
function validityToDays(parts) {
  let totalDays = 0;
  for (const unit of EVENT_TYPE_VALIDITY_UNITS) {
    const v = Number(parts?.[unit]);
    if (Number.isFinite(v) && v > 0) {
      totalDays += v * VALIDITY_UNIT_TO_DAYS[unit];
    }
  }
  return totalDays;
}

// PKs auto-detected from database (populated in ensureDbSqlHelpers)
let POLYGON_PKS = [];



const FRONTEND_ORIGIN = process.env.CORS_ORIGIN;
const COOKIE_SAMESITE = 'lax';                     // hardcoded – removed from .env

// COOKIE_SECURE: production + HTTPS varsa true, aksi halde false.
// Localhost veya HTTP ortamında baseCookieFlags() zaten false'a düşürür.
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

/* ===================== DB ===================== */
const DATABASE_URL = process.env.DATABASE_URL || '';
const sslEnv = String(process.env.PGSSL || process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase();
const sslFromUrl = /sslmode=require|ssl=true/i.test(DATABASE_URL);
const needSSL = sslEnv === '1' || sslEnv === 'true' || sslEnv === 'require' || sslFromUrl;

const BASE_DB_CFG = DATABASE_URL
  ? {
      connectionString: DATABASE_URL,
      application_name: 'DiDe',
      max: parseInt(process.env.PGPOOL_MAX, 10) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: needSSL ? { rejectUnauthorized: false } : undefined,
    }
  : {
      host: process.env.PGHOST || '127.0.0.1',      // hardcoded default – removed from .env
      port: parseInt(process.env.PGPORT, 10) || 5432, // hardcoded default – removed from .env
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      application_name: 'DiDe',
      max: parseInt(process.env.PGPOOL_MAX, 10) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: needSSL ? { rejectUnauthorized: false } : undefined,
    };

const DB_CFG = BASE_DB_CFG;
const pool = new Pool(DB_CFG);


pool.on('error', (err) => {
  console.error('[PG POOL] unexpected error on idle client:', err);
});


async function ensureDbConnectionWithRetry(retry = 6, delayMs = 1500) {
  for (let i = 0; i < retry; i++) {
    try {
      await pool.query('SELECT 1');
      // DB connected
      return;
    } catch (e) {
      const last = i === retry - 1;
      console.error(`[DB] bağlantı hatası (deneme ${i + 1}/${retry}):`, e.message || e);
      if (last) {
        console.error('[DB] bağlantı kurulamadı, uygulama yine de başlıyor (istek geldiğinde tekrar denenecek).');
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
ensureDbConnectionWithRetry()
  .then(() => ensureDbSqlHelpers())
  .then(async () => {
    try {
      await pool.query(`ALTER TABLE public.event DROP COLUMN IF EXISTS photo_url CASCADE`);
      await pool.query(`ALTER TABLE public.event DROP COLUMN IF EXISTS video_url CASCADE`);
    } catch (e) {
      // ignore
    }
    try { await initBoundary(); } catch (e) { console.warn('[BOUNDARY] init error:', e.message); }
    // Rotalama: eski önbellek tablosu artık kullanılmıyor → kaldır
    try { await pool.query(`DROP TABLE IF EXISTS public.dide_route_area`); } catch (e) {}
    // Rotalama: sınırı (dide_boundary / aggregation) OSRM'in yol ağını kesmesi için dışa aktar
    try { await exportRoutingBoundary(); } catch (e) { console.warn('[ROUTE] boundary export error:', e.message); }
    // Şirket kullanıcıları: kullanıcı adı benzersizliği şirket bazında
    try { await ensureCompanyUsernameScope(); } catch (e) { console.warn('[USERS] username scope error:', e.message); }
    // Şirket tablosu / yeni kolonlar (instagram_link, deactivated_* ...) açılışta hazırlanır
    try { await ensureCompaniesSchema(); } catch (e) { console.warn('[COMPANIES] schema error:', e.message); }
  })
  .catch((e) => {
    console.error('[FATAL] Database startup error:', e && e.message ? e.message : e);
  });


/* ===================== SMTP (opsiyonel) ===================== */
let transporter = null;
const CAN_SEND_MAIL = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && (process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER));
if (CAN_SEND_MAIL) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: false,                                   // hardcoded – STARTTLS (port 587); removed from .env
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
const MAIL_FROM = `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`;


/* ===================== ORTA KATMANLAR ===================== */
app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      const allowList = FRONTEND_ORIGIN.split(',').map((s) => s.trim());
      if (allowList.includes(origin)) return cb(null, true);
      return cb(new Error('CORS engellendi: ' + origin), false);
    },
    credentials: true,
    optionsSuccessStatus: 204,
  })
);


app.use(express.json({ limit: '30mb' }));
app.use(cookieParser());

// Keep-alive: TCP baglanti tekrar kullanimi — ECONNREFUSED azaltir
app.use((_req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30');
  next();
});


const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// CASE_STUDY: .env'de tanımlı klasör adı (örn: Milano).
// Tam path: <proje_kökü>/case_study/<CASE_STUDY>/raw_data/Raster
const CASE_STUDY_RAW = String(process.env.CASE_STUDY ?? '').trim();
if (!CASE_STUDY_RAW) {
  console.error(`\n[FATAL] CASE_STUDY is not set in your .env file.`);
  console.error(`        Routing needs it: the OpenStreetMap file you downloaded must be placed at`);
  console.error(`          case_study/<CASE_STUDY>/existing_data/map.osm      (or map.osm.pbf)`);
  console.error(`        Example: CASE_STUDY=Hacettepe  ->  case_study/Hacettepe/existing_data/map.osm`);
  console.error(`        System cannot start. Exiting.\n`);
  process.exit(1);
}
const CASE_STUDY_NAME = CASE_STUDY_RAW;
const RASTER_DIR = path.join(__dirname, 'case_study', CASE_STUDY_NAME, 'raw_data', 'Raster');

// ==================== BOUNDARY (sınır) ====================
// existing_data/boundary.geojson veya boundary.geopackage dosyasından sınır verisi.
// Öncelik: Aggregation layer (POLYGON_TABLE) tanımlıysa sınır ondan belirlenir.
// Aksi halde existing_data'daki boundary dosyası kullanılır. İkisi de yoksa sınır yok (serbest).
const EXISTING_DATA_DIR = path.join(__dirname, 'case_study', CASE_STUDY_NAME, 'existing_data');
const BOUNDARY_DB_TABLE = 'dide_boundary';
let BOUNDARY_MODE = null;        // 'aggregation' | 'file' | null
let BOUNDARY_GEOJSON = null;     // file modunda ön yüze gönderilecek GeoJSON (FeatureCollection/Feature)
const { execFile } = require('child_process');


const VIDEO_EXT_WHITELIST = ['.mp4', '.m4v', '.mov', '.mkv', '.avi', '.wmv', '.3gp', '.3gpp', '.webm', '.ogg', '.ogv', '.mpeg', '.mpg'];
function hasVideoExtension(filename) {
  const ext = (path.extname(String(filename || '')).toLowerCase() || '');
  return VIDEO_EXT_WHITELIST.includes(ext);
}
function isVideoMimetype(m) {
  const mm = String(m || '').toLowerCase();
  if (!mm) return false;
  if (mm.startsWith('video/')) return true;
  return ['application/octet-stream'].includes(mm); 
}


function chooseExt(originalName, mimetype, kind /* 'photo'|'video' */) {
  let ext = path.extname(originalName || '').toLowerCase();
  if (!ext) {
    const extByMime = mimeTypes.extension(mimetype || '');
    if (extByMime) ext = '.' + extByMime.toLowerCase();
  }
  if (!ext) ext = kind === 'photo' ? '.jpg' : '.mp4';
  if (kind === 'video' && !hasVideoExtension(ext)) ext = '.mp4';
  return ext;
}
function uniqueFileName(ext) {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
}


const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const kind = req.path.includes('/photo') ? 'photo' : req.path.includes('/video') ? 'video' : 'photo';
    const ext = chooseExt(file.originalname, file.mimetype, kind);
    cb(null, uniqueFileName(ext));
  }
});


const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const mt = file.mimetype || '';
    const on = file.originalname || '';
    const isImage = mt.startsWith('image/');
    const isVideo = isVideoMimetype(mt) || hasVideoExtension(on);

    if (req.path.includes('/photo')) {
      return isImage ? cb(null, true) : cb(new Error('Sadece resim yükleyin'));
    }
    if (req.path.includes('/video')) {
      return isVideo ? cb(null, true) : cb(new Error('Sadece video yükleyin'));
    }
    cb(null, false);
  },
});

app.get(/^\/uploads\/(.+)$/, (req, res) => {
  const rest = req.params[0] || '';
  const rel = path.posix.join('uploads', rest).replace(/^\/+/, ''); // uploads/...
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(UPLOAD_DIR)) {
    return res.status(403).end();
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).end();
  }

  const size = fs.statSync(abs).size;
  const mime = mimeTypes.lookup(abs) || 'application/octet-stream';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

  if (range) {
    const m = String(range).match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size || end >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', String(size));
  return fs.createReadStream(abs).pipe(res);
});

app.get('/i18n.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'i18n', 'main.js'));
});

app.use('/i18n', express.static(path.join(__dirname, 'i18n')));

app.use(express.static(PUBLIC_DIR));


//  (SQL injection koruması için)
function assertSafeIdent(name, kind='ident') {
  const s = String(name || '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    const err = new Error(`${kind}_gecersiz`);
    err.statusCode = 400;
    throw err;
  }
  return s;
}

async function listGeomTables() {
  const q = `
    SELECT f_table_name AS table_name, type, f_geometry_column AS geom_column
    FROM public.geometry_columns
    WHERE f_table_schema='public'
    ORDER BY f_table_name;
  `;
  const { rows } = await pool.query(q);
  return rows.map(r => {
    const t = String(r.type || '').toUpperCase();
    const geomType =
      t.includes('LINE') ? 'line' :
      t.includes('POLYGON') ? 'polygon' :
      t.includes('POINT') ? 'point' : 'other';
    return { table: r.table_name, geomType, geomColumn: r.geom_column || 'geom' };
  }).filter(x => x.geomType !== 'other');
}

async function distinctValues(table, column) {
  table = assertSafeIdent(table,'table');
  column = assertSafeIdent(column,'column');
  const q = `SELECT DISTINCT ${column} AS v FROM public.${table} WHERE ${column} IS NOT NULL ORDER BY ${column}`;
  const { rows } = await pool.query(q);
  return rows.map(r => r.v);
}

async function distinctUnassignedValues(table, column) {
  table = assertSafeIdent(table,'table');
  column = assertSafeIdent(column,'column');
  const colCheck = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND LOWER(table_name)=LOWER($1) AND column_name='event_type' LIMIT 1`,
    [table]
  );
  let q;
  if (colCheck.rows.length > 0) {
    q = `SELECT DISTINCT ${column} AS v FROM public.${table} WHERE ${column} IS NOT NULL AND event_type IS NULL ORDER BY ${column}`;
  } else {
    q = `SELECT DISTINCT ${column} AS v FROM public.${table} WHERE ${column} IS NOT NULL ORDER BY ${column}`;
  }
  const { rows } = await pool.query(q);
  return rows.map(r => r.v);
}

async function ensureTargetHasOlayTuru(table) {
  table = assertSafeIdent(table,'table');
  await pool.query(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS event_type integer`);
}

// Time-dependent expiry sweep.
// Ömür artık SON KATILIM tarihinden (last_agreed_date) itibaren sayılır; bu alan
// olay eklenirken created_at ile aynıdır ve her yeni katılımda (agree) güncellenir.
// Böylece bir olaya katılım geldikçe olayın süresi, bağlı olduğu olay türünün
// süresi kadar uzar. created_at (ilk gönderim tarihi) hiç değişmez.
async function deactivateExpiredEvents(db = pool) {
  try {
    const r = await db.query(`
      UPDATE public.event e
         SET active = false,
             deactivated_at = COALESCE(e.last_agreed_date, e.created_at) + (et.valid_time * interval '1 day')
        FROM public.event_type et
       WHERE e.event_type = et.event_type_id
         AND COALESCE(e.active, true) = true
         AND COALESCE(et.time_dependent, false) = true
         AND et.valid_time IS NOT NULL
         AND et.valid_time > 0
         AND COALESCE(e.last_agreed_date, e.created_at) IS NOT NULL
         AND (COALESCE(e.last_agreed_date, e.created_at) + (et.valid_time * interval '1 day')) <= now()
    `);
    return r.rowCount || 0;
  } catch (e) {
    console.error('[expiry] deactivateExpiredEvents error:', e.message);
    return 0;
  }
}

function publicGoodBadWhere() {
  // env: showGoodEventsOnLogin / showBadEventsOnLogin
  if (SHOW_GOOD_EVENTS_ON_LOGIN && SHOW_BAD_EVENTS_ON_LOGIN) return `TRUE`;
  if (SHOW_GOOD_EVENTS_ON_LOGIN && !SHOW_BAD_EVENTS_ON_LOGIN) return `o."public_" = TRUE`;
  if (!SHOW_GOOD_EVENTS_ON_LOGIN && SHOW_BAD_EVENTS_ON_LOGIN) return `o."public_" = FALSE`;
  return `FALSE`;
}

function mustAuth(req, res, next){
  try{
    const token = getTokenFrom(req);
    if(!token) return res.status(401).json({ error:'unauthorized' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // {sub, role, username, email}
    return next();
  }catch{
    return res.status(401).json({ error:'unauthorized' });
  }
}
function mustSupervisor(req,res,next){
  if(!req.user || !['supervisor','admin'].includes(req.user.role)) {
    return res.status(403).json({ error:'forbidden' });
  }
  return next();
}

app.get('/api/geom-tables', mustAuth, mustSupervisor, async (req,res)=>{
  try{
    const tables = await listGeomTables();
    return res.json({ ok:true, tables });
  }catch(e){
    return res.status(500).json({ error:'sunucu_hatasi' });
  }
});
app.get('/api/public/geom-tables', async (req,res)=>{
  try{
    const tables = await listGeomTables();
    return res.json({ ok:true, tables });
  }catch(e){
    return res.status(500).json({ error:'sunucu_hatasi' });
  }
});
app.get('/api/table-columns/:table', mustAuth, mustSupervisor, async (req,res)=>{
  try{
    const table = assertSafeIdent(req.params.table,'table');
    const geomTables = await listGeomTables();
    const hit = geomTables.find(x => x.table === table);
    if(!hit) return res.status(404).json({ error:'tablo_bulunamadi' });
    const q = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
        AND column_name NOT IN ('geom','gid','ogc_fid','event_type','wkb_geometry','shape')
        AND data_type NOT IN ('USER-DEFINED')
      ORDER BY ordinal_position;
    `;
    const { rows } = await pool.query(q, [table]);
    return res.json({ ok:true, columns: rows.map(r => r.column_name) });
  }catch(e){
    const sc = e.statusCode || 500;
    return res.status(sc).json({ error: e.message || 'sunucu_hatasi' });
  }
});


app.get('/api/public/veri-tipi/list', async (req,res)=>{
  try{
    // Giriş yapmadan (public) Value eşlemesi için: layer_table -> attribute_column
    // ve event_type_id -> event_type_name. Yalnızca aktif kayıtlar; hassas alan döndürülmez.
    const q = `
      SELECT
        event_type_id,
        COALESCE(NULLIF(layer_table,''), 'asis') AS layer_table,
        COALESCE(NULLIF(attribute_column,''), 'event_type_name') AS attribute_column,
        event_type_name AS event_type,
        is_point, is_line, is_polygon
      FROM public.event_type
      WHERE active = TRUE
      ORDER BY is_point DESC, layer_table ASC, attribute_column ASC, event_type_name ASC;
    `;
    const { rows } = await pool.query(q);
    return res.json({ ok:true, rows });
  }catch(e){
    return res.status(500).json({ error:'sunucu_hatasi' });
  }
});

app.get('/api/veri-tipi/list', mustAuth, mustSupervisor, async (req,res)=>{
  try{
    const q = `
      SELECT
        event_type_id,
        COALESCE(NULLIF(layer_table,''), 'asis') AS layer_table,
        COALESCE(NULLIF(attribute_column,''), 'event_type_name') AS attribute_column,
        event_type_name AS event_type,
        CASE WHEN "public_" THEN 'Faydali' ELSE 'Faydasiz' END AS faydali_faydasiz_mi,
        created_by_name AS ekleyen,
        created_by_id,
        created_by_role_name,
        is_point, is_line, is_polygon
      FROM public.event_type
      WHERE active = TRUE
      ORDER BY is_point DESC, layer_table ASC, attribute_column ASC, event_type_name ASC;
    `;
    const { rows } = await pool.query(q);
    return res.json({ ok:true, rows });
  }catch(e){
    return res.status(500).json({ error:'sunucu_hatasi' });
  }
});

app.post('/api/veri-tipi/wizard/values', mustAuth, mustSupervisor, async (req,res)=>{
  try{
    const table = assertSafeIdent(req.body?.layer_table,'table');
    const column = assertSafeIdent(req.body?.attribute_column,'column');

    const geomTables = await listGeomTables();
    const hit = geomTables.find(x => x.table === table);
    if(!hit) return res.status(404).json({ error:'tablo_bulunamadi' });
    if(hit.geomType === 'point') return res.status(400).json({ error:'point_yasak' });

    const values = await distinctUnassignedValues(table, column);
    return res.json({ ok:true, geomType: hit.geomType, values });
  }catch(e){
    const sc = e.statusCode || 500;
    return res.status(sc).json({ error: e.message || 'sunucu_hatasi' });
  }
});

app.post('/api/veri-tipi/wizard/create', mustAuth, mustSupervisor, async (req,res)=>{
  const client = await pool.connect();
  try{
    const table = assertSafeIdent(req.body?.layer_table,'table');
    const column = assertSafeIdent(req.body?.attribute_column,'column');
    const isPublic = String(req.body?.["public"]) === 'true' || req.body?.["public"] === true;
    const selectAll = String(req.body?.select_all) === 'true' || req.body?.select_all === true;
    const valuesIn = Array.isArray(req.body?.values) ? req.body.values : [];

    const geomTables = await listGeomTables();
    const hit = geomTables.find(x => x.table === table);
    if(!hit) return res.status(404).json({ error:'tablo_bulunamadi' });
    if(hit.geomType === 'point') return res.status(400).json({ error:'point_yasak' });

    const values = selectAll ? await distinctUnassignedValues(table, column) : valuesIn;

    if(!values.length) return res.status(400).json({ error:'deger_yok' });

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout TO '3s'`);

    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS is_point boolean DEFAULT true`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS is_line boolean DEFAULT false`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS is_polygon boolean DEFAULT false`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS layer_table text`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS attribute_column text`);

    await ensureTargetHasOlayTuru(table);

    const isLine = hit.geomType === 'line';
    const isPolygon = hit.geomType === 'polygon';

    const createdById = req.user.sub;
    const createdByName = req.user.username;
    const createdByRole = req.user.role;

    const created = [];
    for(const v of values){
      const ins = await client.query(
        `INSERT INTO public.event_type
          (event_type_name, "public_", active, created_by_name, created_by_role_name, created_by_id,
           is_point, is_line, is_polygon, layer_table, attribute_column)
         VALUES
          ($1,$2,TRUE,$3,$4,$5,FALSE,$6,$7,$8,$9)
         RETURNING event_type_id`,
        [String(v), isPublic, createdByName, createdByRole, createdById, isLine, isPolygon, table, column]
      );
      const oId = ins.rows[0].event_type_id;

      // hedef tabloyu güncelle: seçilen değerlerde event_type = event_type_id
      // seçilmemiş değerler NULL
      await client.query(
        `UPDATE public.${table} SET event_type = $1 WHERE ${column} = $2 AND event_type IS NULL`,
        [oId, v]
      );
      created.push({ value:v, event_type_id:oId });
    }

    await client.query('COMMIT');
    return res.json({ ok:true, created });
  }catch(e){
    try{ await client.query('ROLLBACK'); }catch{}
    return res.status(500).json({ error:'sunucu_hatasi', detail: e.message });
  }finally{
    client.release();
  }
});

// ---------- API: update / delete (LINE/POLYGON) ----------
app.put('/api/veri-tipi/:event_type_id', mustAuth, mustSupervisor, async (req,res)=>{
  try{
    const oId = Number(req.params.event_type_id);
    const isPublic = String(req.body?.["public"]) === 'true' || req.body?.["public"] === true;

    const { rows } = await pool.query(`SELECT event_type_id, created_by_id, is_point, is_line, is_polygon FROM public.event_type WHERE event_type_id=$1`, [oId]);
    if(!rows.length) return res.status(404).json({ error:'bulunamadi' });

    const r = rows[0];
    if(r.is_point) return res.status(400).json({ error:'point_duzenlenemez' });
    if(String(r.created_by_id) !== String(req.user.sub)) return res.status(403).json({ error:'sadece_kendi_kaydi' });

    await pool.query(`UPDATE public.event_type SET "public_"=$1 WHERE event_type_id=$2`, [isPublic, oId]);
    return res.json({ ok:true });
  }catch(e){
    return res.status(500).json({ error:'sunucu_hatasi' });
  }
});

app.delete('/api/veri-tipi/:event_type_id', mustAuth, mustSupervisor, async (req,res)=>{
  try{
    const oId = Number(req.params.event_type_id);

    const { rows } = await pool.query(`SELECT event_type_id, created_by_id, is_point, layer_table FROM public.event_type WHERE event_type_id=$1`, [oId]);
    if(!rows.length) return res.status(404).json({ error:'bulunamadi' });

    const r = rows[0];
    if(r.is_point) return res.status(400).json({ error:'point_silinemez' });
    if(String(r.created_by_id) !== String(req.user.sub)) return res.status(403).json({ error:'sadece_kendi_kaydi' });

    // Reset event_type on source table so the value becomes available again
    if(r.layer_table){
      try {
        const table = assertSafeIdent(r.layer_table,'table');
        await pool.query(`UPDATE public.${table} SET event_type = NULL WHERE event_type = $1`, [oId]);
      } catch(e) { console.warn('[veri-tipi delete] source table update error:', e.message); }
    }

    // Hard delete from event_type table
    await pool.query(`DELETE FROM public.event_type WHERE event_type_id=$1`, [oId]);

    return res.json({ ok:true });
  }catch(e){
    return res.status(500).json({ error:'sunucu_hatasi' });
  }
});


app.get('/api/geo/:table', mustAuth, async (req,res)=>{
  try{
    const table = assertSafeIdent(req.params.table,'table');
    const geomTables = await listGeomTables();
    const hit = geomTables.find(x => x.table === table);
    const gc = hit ? assertSafeIdent(hit.geomColumn,'column') : 'geom';
    const q = `
      SELECT jsonb_build_object(
        'type','FeatureCollection',
        'features', COALESCE(jsonb_agg(jsonb_build_object(
          'type','Feature',
          'geometry', ST_AsGeoJSON(t.${gc})::jsonb,
          'properties', to_jsonb(t) - '${gc}'
        )), '[]'::jsonb)
      ) AS fc
      FROM public.${table} t
      WHERE t.${gc} IS NOT NULL
        AND t.event_type IS NOT NULL;
    `;
    const { rows } = await pool.query(q);
    return res.json(rows[0].fc);
  }catch(e){
    return res.status(500).json({ error:'sunucu_hatasi' });
  }
});


app.get('/api/public/geo/:table', async (req,res)=>{
  try{
    const table = assertSafeIdent(req.params.table,'table');
    const geomTables = await listGeomTables();
    const hit = geomTables.find(x => x.table === table);
    const gc = hit ? assertSafeIdent(hit.geomColumn,'column') : 'geom';
    const whereGoodBad = publicGoodBadWhere();

    const q = `
      SELECT jsonb_build_object(
        'type','FeatureCollection',
        'features', COALESCE(jsonb_agg(jsonb_build_object(
          'type','Feature',
          'geometry', ST_AsGeoJSON(t.${gc})::jsonb,
          'properties', to_jsonb(t) - '${gc}'
        )), '[]'::jsonb)
      ) AS fc
      FROM public.${table} t
      JOIN public.event_type o ON o.event_type_id = t.event_type
      WHERE t.${gc} IS NOT NULL
        AND t.event_type IS NOT NULL
        AND o.active = TRUE
        AND (${whereGoodBad});
    `;
    const { rows } = await pool.query(q);
    return res.json(rows[0].fc);
  }catch(e){
    return res.status(500).json({ error:'sunucu_hatasi' });
  }
});

app.get('/api/raster-layers', (req, res) => {
  try {
    const files = fs.readdirSync(RASTER_DIR).filter(f => /\.tiff?$/i.test(f));
    const layers = files.map(f => ({
      name: f.replace(/\.tiff?$/i, ''),
      tifUrl: '/raster/' + f
    }));
    return res.json({ ok: true, layers });
  } catch (e) {
    return res.json({ ok: true, layers: [] });
  }
});

app.get(/^\/raster\/(.+)$/, (req, res) => {
  const fileName = req.params[0] || '';
  const abs = path.join(RASTER_DIR, path.basename(fileName));
  if (!abs.startsWith(RASTER_DIR)) {
    return res.status(403).end();
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).end();
  }

  const size = fs.statSync(abs).size;
  const mime = mimeTypes.lookup(abs) || 'application/octet-stream';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

  if (range) {
    const m = String(range).match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size || end >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', String(size));
  return fs.createReadStream(abs).pipe(res);
});

/* ===================== Polygon Layer Endpoints ===================== */

// GET /api/polygon-layer  –  Serve the env-configured polygon layer as GeoJSON
app.get('/api/polygon-layer', async (req, res) => {
  if (!POLYGON_TABLE) {
    return res.json({ type: 'FeatureCollection', features: [] });
  }
  try {
    const table = assertSafeIdent(POLYGON_TABLE, 'table');
    const cols = POLYGON_PKS.length > 0 ? POLYGON_PKS.map(p => p.safeName) : [];
    // Also include Display_Attribute columns (no duplicates)
    for (const attr of DISPLAY_ATTRS) {
      const safe = assertSafeIdent(attr, 'column');
      if (!cols.includes(safe)) cols.push(safe);
    }

    const propParts = cols.map(c => `'${c}', t.${c}`).join(', ');
    const propObj = cols.length > 0 ? `jsonb_build_object(${propParts})` : `'{}'::jsonb`;

    const q = `
      SELECT jsonb_build_object(
        'type','FeatureCollection',
        'features', COALESCE(jsonb_agg(jsonb_build_object(
          'type','Feature',
          'geometry', ST_AsGeoJSON(t.geom)::jsonb,
          'properties', ${propObj}
        )), '[]'::jsonb)
      ) AS fc
      FROM public.${table} t
      WHERE t.geom IS NOT NULL;
    `;
    const { rows } = await pool.query(q);
    return res.json(rows[0].fc);
  } catch (e) {
    console.error('[polygon-layer] error:', e.message);
    return res.status(500).json({ error: 'sunucu_hatasi' });
  }
});

// GET /api/polygon/grid-data  –  Return all polygon grid rows with PK + Display columns for admin region tab
app.get('/api/polygon/grid-data', requireAuth, async (req, res) => {
  if (!POLYGON_TABLE || POLYGON_PKS.length === 0) {
    return res.json({ ok: true, rows: [], pks: [], displayAttrs: [], allColumns: [] });
  }
  try {
    const table = assertSafeIdent(POLYGON_TABLE, 'table');
    const pkCols = POLYGON_PKS.map(p => p.safeName);
    // Build unique column list: PKs + Display_Attrs (no duplicates)
    const allCols = [...pkCols];
    for (const attr of DISPLAY_ATTRS) {
      const safe = assertSafeIdent(attr, 'column');
      if (!allCols.includes(safe)) allCols.push(safe);
    }
    const selectCols = allCols.map(c => `t.${c}`).join(', ');
    const q = `SELECT ${selectCols}, ST_AsGeoJSON(ST_Centroid(t.geom))::jsonb AS centroid, ST_AsGeoJSON(t.geom)::jsonb AS geojson FROM public.${table} t WHERE t.geom IS NOT NULL ORDER BY ${pkCols[0]} ASC`;
    const { rows } = await pool.query(q);
    return res.json({
      ok: true,
      rows,
      pks: POLYGON_PKS.map(p => p.name),
      displayAttrs: DISPLAY_ATTRS,
      allColumns: allCols,
      pk1: POLYGON_PKS[0]?.name || null,
      pk2: POLYGON_PKS[1]?.name || null,
      tableName: POLYGON_TABLE
    });
  } catch (e) {
    console.error('[polygon/grid-data] error:', e.message);
    return res.status(500).json({ error: 'sunucu_hatasi' });
  }
});
app.post('/api/polygon/find', async (req, res) => {
  if (!POLYGON_TABLE) {
    return res.json({ ok: true, found: false, message: 'no_polygon_configured' });
  }
  try {
    const lat = parseFloat(req.body?.lat);
    const lng = parseFloat(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'gecersiz_koordinat' });
    }

    const table = assertSafeIdent(POLYGON_TABLE, 'table');
    const cols = POLYGON_PKS.map(p => p.safeName);

    // Also include Display_Attribute columns
    const displayCols = [];
    for (const attr of DISPLAY_ATTRS) {
      const safe = assertSafeIdent(attr, 'column');
      if (!cols.includes(safe)) displayCols.push(safe);
    }
    const allCols = [...cols, ...displayCols];

    const selectCols = allCols.length > 0 ? allCols.map(c => `t.${c}`).join(', ') + ',' : '';

    const q = `
      SELECT ${selectCols} ST_AsGeoJSON(t.geom)::jsonb AS geojson
      FROM public.${table} t
      WHERE ST_Contains(t.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
      LIMIT 1;
    `;
    const { rows } = await pool.query(q, [lng, lat]);

    if (!rows.length) {
      return res.json({ ok: true, found: false });
    }

    const row = rows[0];
    const pkValues = {};
    for (const p of POLYGON_PKS) pkValues[p.name] = row[p.safeName];

    // Display attribute values
    const displayValues = {};
    for (const attr of DISPLAY_ATTRS) {
      const safe = assertSafeIdent(attr, 'column');
      displayValues[attr] = row[safe];
    }

    return res.json({
      ok: true,
      found: true,
      pk_values: pkValues,
      display_values: displayValues,
      geometry: row.geojson
    });
  } catch (e) {
    console.error('[polygon/find] error:', e.message);
    return res.status(500).json({ error: 'sunucu_hatasi' });
  }
});

// POST /api/polygon/records  –  Get existing event records within a polygon (spatial query)
app.post('/api/polygon/records', async (req, res) => {
  if (!POLYGON_TABLE) {
    return res.json({ ok: true, records: [], count: 0 });
  }
  try {
    const pkValues = req.body?.pk_values;
    if (!pkValues || typeof pkValues !== 'object') {
      return res.status(400).json({ error: 'gecersiz_istek' });
    }

    const table = assertSafeIdent(POLYGON_TABLE, 'table');

    // Build WHERE to identify the polygon row using dynamic PKs
    const polyConditions = [];
    const vals = [];
    let idx = 1;

    for (const p of POLYGON_PKS) {
      if (pkValues[p.name] != null) {
        polyConditions.push(`p.${p.safeName} = $${idx++}`);
        vals.push(String(pkValues[p.name]));
      }
    }

    if (!polyConditions.length) {
      return res.json({ ok: true, records: [], count: 0 });
    }

    // Spatial join: find all active events whose point falls inside the polygon
    const q = `
      SELECT
        o.event_id,
        o.event_type,
        l.event_type_name AS event_type_name,
        o.description,
        o.photo_urls,
        o.video_urls,
        o.created_at,
        o.created_by_name
      FROM event o
      LEFT JOIN event_type l ON l.event_type_id = o.event_type
      JOIN public.${table} p ON ST_Contains(p.geom, o.geom)
      WHERE COALESCE(o.active, true) = true
        AND o.geom IS NOT NULL
        AND ${polyConditions.join(' AND ')}
      ORDER BY o.created_at DESC
      LIMIT 50
    `;
    const { rows } = await pool.query(q, vals);

    const records = rows.map(r => ({
      event_id: r.event_id,
      event_type: r.event_type,
      event_type_name: r.event_type_name,
      description: r.description,
      photo_urls: parseJsonText(r.photo_urls),
      video_urls: parseJsonText(r.video_urls),
      created_at: r.created_at,
      created_by_name: r.created_by_name
    }));

    return res.json({ ok: true, records, count: records.length });
  } catch (e) {
    console.error('[polygon/records] error:', e.message);
    return res.status(500).json({ error: 'sunucu_hatasi' });
  }
});

// POST /api/nearby/records – Seçilen konumun BUFFER_RADIUS metre çevresindeki aktif kayıtlar.
// Yarıçap sunucudaki .env değerinden okunur (istemciden gelen değere güvenilmez).
app.post('/api/nearby/records', requireAuth, async (req, res) => {
  try {
    if (!(BUFFER_RADIUS > 0)) return res.json({ ok: true, records: [], count: 0, radius: 0 });

    const lat = parseFloat(req.body?.lat ?? req.body?.latitude);
    const lng = parseFloat(req.body?.lng ?? req.body?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'gecersiz_istek', message: getErrorMessage(req, 'gecersiz_istek') });
    }

    const q = `
      SELECT
        o.event_id,
        o.event_type,
        l.event_type_name AS event_type_name,
        o.description,
        o.photo_urls,
        o.video_urls,
        o.created_at,
        o.created_by_name,
        ROUND(ST_Distance(o.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric, 1) AS distance_m
      FROM event o
      LEFT JOIN event_type l ON l.event_type_id = o.event_type
      WHERE COALESCE(o.active, true) = true
        AND o.geom IS NOT NULL
        AND ST_DWithin(o.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
      ORDER BY o.created_at DESC
      LIMIT 200
    `;
    const { rows } = await pool.query(q, [lng, lat, BUFFER_RADIUS]);

    const records = rows.map(r => ({
      event_id: r.event_id,
      event_type: r.event_type,
      event_type_name: r.event_type_name,
      description: r.description,
      photo_urls: parseJsonText(r.photo_urls),
      video_urls: parseJsonText(r.video_urls),
      created_at: r.created_at,
      created_by_name: r.created_by_name,
      distance_m: r.distance_m != null ? Number(r.distance_m) : null
    }));

    return res.json({ ok: true, records, count: records.length, radius: BUFFER_RADIUS });
  } catch (e) {
    console.error('[nearby/records] error:', e.message);
    return res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});
/* ===================== HELPERS ===================== */

function loadI18nTranslations() {
  const translations = {};
  const i18nDir = path.join(__dirname, 'i18n');
  try {
    const files = fs.readdirSync(i18nDir).filter(f => /^[A-Z]{2}\.js$/i.test(f));
    for (const file of files) {
      const langCode = file.replace(/\.js$/i, '').toLowerCase();
      const content = fs.readFileSync(path.join(i18nDir, file), 'utf8');
      // Extract the object assigned to window.i18nLangs.xx = { ... };
      const match = content.match(/window\.i18nLangs\.\w+\s*=\s*(\{[\s\S]*\});/);
      if (match) {
        try {
          translations[langCode] = eval('(' + match[1] + ')');
        } catch (e) {
          console.warn(`[i18n] Could not parse ${file}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[i18n] Çeviri dosyaları yüklenemedi:', e.message);
  }
  return Object.keys(translations).length > 0 ? translations : null;
}

const i18nTranslations = loadI18nTranslations();

function _detectLang(req) {
  const al = (req.headers?.['accept-language'] || '').toLowerCase();
  // Check supported languages
  const supported = i18nTranslations ? Object.keys(i18nTranslations) : ['tr', 'en'];
  for (const lang of supported) {
    if (al === lang || al.startsWith(lang)) return lang;
  }
  // body.lang
  if (req.body?.lang && supported.includes(req.body.lang.toLowerCase())) {
    return req.body.lang.toLowerCase();
  }
  // default
  return DEFAULT_LANG.toLowerCase();
}

function getErrorMessage(req, errorKey) {
  const lang = _detectLang(req);
  
  if (!i18nTranslations) {
    return errorKey;
  }
  
  return i18nTranslations[lang]?.[errorKey] || i18nTranslations.en?.[errorKey] || i18nTranslations[DEFAULT_LANG.toLowerCase()]?.[errorKey] || errorKey;
}

function signToken(user, expires = JWT_EXPIRES) {
  return jwt.sign({ sub: user.id, role: user.role, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: expires });
}
function getTokenFrom(req) {
  return (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null) || req.cookies?.token || null;
}
const norm = (s) => String(s ?? '').trim();

function baseCookieFlags(req) {
  const xfProto = req?.headers?.['x-forwarded-proto'];
  const isHttps = !!(req?.secure || (typeof xfProto === 'string' && xfProto.toLowerCase() === 'https'));

  const isLocalhostOrigin = FRONTEND_ORIGIN.split(',')
    .map((s) => s.trim().toLowerCase())
    .some((o) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o));

  let secure = COOKIE_SECURE;
  if (secure && !isHttps && isLocalhostOrigin) {
    secure = false;
  }

  let sameSite = COOKIE_SAMESITE;
  if (sameSite === 'none' && !secure) {
    sameSite = 'lax';
  }

  return {
    httpOnly: true,
    sameSite,
    secure,
    path: '/',
  };
}
function cookieOpts(days = 7, req = null) {
  return { ...baseCookieFlags(req), maxAge: days * 24 * 60 * 60 * 1000 };
}
function cookieOptsSession(req = null) {
  return { ...baseCookieFlags(req) };
}

// Bir kullanıcının olay/beğeni istatistiklerini event tablosundan yeniden hesaplar
// ve users tablosuna yazar. Beğeni değişince, olay eklenince/kapatılınca çağrılır.
//   num_events  = kullanıcının eklediği toplam olay (aktif+deaktif)
//   agreed_point = gönderilerinde aldığı toplam beğeni
//   posts_point = 2*agreed_point + (kullanıcının KENDİSİNİN silmediği olay sayısı)
//
//   Gönderi puanı (+1), kullanıcı kendi gönderisini sildiğinde geri alınır (-1).
//   Beğeni (katılım) puanları (+2/beğeni) ise gönderi silinse bile kullanıcıda KALIR —
//   bu yüzden beğeni toplamı tüm olaylar üzerinden, gönderi sayısı ise yalnızca
//   "kullanıcının kendisi silmediği" olaylar üzerinden hesaplanır.
//   (Solver/supervisor tarafından kapatılan olaylar kullanıcının puanını düşürmez.)
async function recomputeUserStats(userId) {
  if (userId == null) return;
  try {
    await pool.query(
      `UPDATE public.users u SET
         num_events  = COALESCE(own.cnt, 0),
         agreed_point = COALESCE(own.agrees, 0),
         posts_point = COALESCE(2*own.agrees + own.kept, 0) + COALESCE(given.cnt, 0)
       FROM (
         SELECT COUNT(*) AS cnt,
                COUNT(*) FILTER (
                  WHERE COALESCE(active, true) = true
                     OR deactivated_by_id IS NULL
                     OR deactivated_by_id <> created_by_id
                ) AS kept,
                COALESCE(SUM(COALESCE(num_agrees,0)),0) AS agrees
         FROM public.event
         WHERE created_by_id = $1
       ) own,
       (
         -- Kullanıcının KATILDIĞI (agree verdiği) gönderi sayısı → her katılım +1 puan.
         -- Opener ve solver için aynı şekilde işler; katılım geri alınırsa puan da düşer.
         SELECT COUNT(*) AS cnt
           FROM public.event
          WHERE COALESCE(agreed_ids, '[]'::jsonb) @> to_jsonb($1::int)
       ) given
       WHERE u.id = $1`,
      [userId]
    );
    try { _userCache.delete(userId); } catch {}
  } catch (e) {
    console.error('recomputeUserStats error for user', userId, e.message);
  }
}

function _fileExists(p){ try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }


function _findFileRecursive(root, relOrName) {
  const name = path.basename(String(relOrName || ''));
  if (!name) return null;

  if (_fileExists(relOrName)) return relOrName;

  const tryRel = path.join(root, relOrName);
  if (_fileExists(tryRel)) return tryRel;

  let hit = null;
  (function walk(dir) {
    if (hit) return;
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && path.basename(p) === name) { hit = p; return; }
    }
  })(root);
  return hit;
}

function _uniqueNameWithExt(srcFullPath, fallbackExt) {
  const ext = (path.extname(srcFullPath || '') || fallbackExt || '.bin').toLowerCase();
  return `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
}

// telefon yolu -> uploads'a kopyala -> /uploads/... olarak döndür
function _convertOnePathToUploads(absRoot, rawPath, kind /* 'photo'|'video' */) {
  if (!rawPath) return null;

  if (String(rawPath).startsWith('/uploads/')) return String(rawPath);

  const src = _findFileRecursive(absRoot, rawPath);
  if (!src) return null;

  const newName = _uniqueNameWithExt(src, kind === 'photo' ? '.jpg' : '.mp4');
  const dst = path.join(UPLOAD_DIR, newName);
  fs.copyFileSync(src, dst);
  return `/uploads/${newName}`;
}


function _parseTextJson(txt) {
  try { const v = JSON.parse(String(txt || '[]')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function _toTextJson(arr) {
  try { return JSON.stringify(Array.isArray(arr) ? arr : []); } catch { return '[]'; }
}


async function ingestQFieldFolder(absRoot) {
  if (!absRoot || !fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    throw new Error('QFIELD_SYNC_ROOT geçersiz veya erişilemiyor');
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const q = `
    SELECT event_id, photo_urls, video_urls
    FROM public.event
    WHERE (
            COALESCE(photo_urls,'[]') <> '[]' AND photo_urls NOT LIKE '%/uploads/%'
          )
       OR (
            COALESCE(video_urls,'[]') <> '[]' AND video_urls NOT LIKE '%/uploads/%'
          )
    ORDER BY event_id DESC
    LIMIT 500
  `;
  const { rows } = await pool.query(q);
  if (!rows.length) return { updated: 0 };

  let updated = 0;
  for (const r of rows) {
    const photosIn = _parseTextJson(r.photo_urls);
    const videosIn = _parseTextJson(r.video_urls);

    const photosOut = [];
    for (const it of (Array.isArray(photosIn) && photosIn.length ? photosIn : [r.photo_urls]).flat()) {
      const converted = _convertOnePathToUploads(absRoot, it, 'photo');
      if (converted) photosOut.push(converted);
    }

    const videosOut = [];
    for (const it of (Array.isArray(videosIn) && videosIn.length ? videosIn : [r.video_urls]).flat()) {
      const converted = _convertOnePathToUploads(absRoot, it, 'video');
      if (converted) videosOut.push(converted);
    }

    if (photosOut.length || videosOut.length) {
      await pool.query(
        `UPDATE public.event
           SET photo_urls = $1::text,
               video_urls = $2::text
         WHERE event_id = $3`,
        [_toTextJson(photosOut.length ? photosOut : photosIn), _toTextJson(videosOut.length ? videosOut : videosIn), r.event_id]
      );
      updated++;
    }
  }
  return { updated };
}


let _ingestBusy = false;
async function _ingestTick() {
  if (_ingestBusy) return;
  if (!QFIELD_SYNC_ROOT) return;
  _ingestBusy = true;
  try {
    const result = await ingestQFieldFolder(QFIELD_SYNC_ROOT);
    if (result?.updated) console.log(`[QFIELD] ingest: ${result.updated} kayıt güncellendi.`);
  } catch (e) {
    console.warn('[QFIELD] ingest hata:', e.message || e);
  } finally {
    _ingestBusy = false;
  }
}

function startQFieldIngestLoop() {
  if (!QFIELD_SYNC_ROOT) {
    return;
  }
  console.log(`[QFIELD] arka plan ingest aktif. Kök: ${QFIELD_SYNC_ROOT} | interval: ${QFIELD_INGEST_INTERVAL_MS}ms`);
  setInterval(_ingestTick, QFIELD_INGEST_INTERVAL_MS);

  _ingestTick();
}


function isEmailAllowed(emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase();
  const m = email.match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/);
  if (!m) return false;
  const domain = m[1];

  if (ALLOWED_EMAIL_DOMAINS.length === 0) return true;
  
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}


// Basit kullanici cache — requireAuth her istekte DB'ye gitmesini onler
const _userCache = new Map();
const USER_CACHE_TTL = 30000; // 30 saniye
function getCachedUser(id) {
  const entry = _userCache.get(id);
  if (entry && Date.now() - entry.ts < USER_CACHE_TTL) return entry.user;
  _userCache.delete(id);
  return null;
}
function setCachedUser(id, user) {
  _userCache.set(id, { user, ts: Date.now() });
  // Cache buyumesini onle
  if (_userCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _userCache) {
      if (now - v.ts > USER_CACHE_TTL) _userCache.delete(k);
    }
  }
}

async function requireAuth(req, res, next) {
  try {
    const t = getTokenFrom(req);
    if (!t) return res.status(401).json({ error: 'unauthenticated', message: getErrorMessage(req, 'unauthenticated') });
    const payload = jwt.verify(t, JWT_SECRET);

    // Onbellekten kontrol et
    let u = getCachedUser(payload.sub);
    if (!u) {
      const { rows } = await pool.query(
        `SELECT id, username, role, email, COALESCE(solver,false) AS solver, COALESCE(is_active,true) AS is_active
         FROM users WHERE id=$1`,
        [payload.sub]
      );
      if (!rows.length) {
        res.clearCookie('token', cookieOpts(0, req));
        return res.status(401).json({ error: 'unauthenticated', message: getErrorMessage(req, 'unauthenticated') });
      }
      u = rows[0];
      if (u.is_active) setCachedUser(payload.sub, u);
    }

    if (!u.is_active) {
      res.clearCookie('token', cookieOpts(0, req));
      return res.status(403).json({ error: 'user_inactive', message: getErrorMessage(req, 'user_inactive') });
    }
    req.user = { id: u.id, username: u.username, role: u.role, email: u.email, solver: (u.solver === true) };
    next();
  } catch {
    res.clearCookie('token', cookieOpts(0, req));
    return res.status(401).json({ error: 'invalid_token', message: getErrorMessage(req, 'invalid_token') });
  }
}
function requireAnyRole(roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated', message: getErrorMessage(req, 'unauthenticated') });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden', message: getErrorMessage(req, 'forbidden') });
    next();
  };
}

async function tryAuth(req, _res, next) {
  try {
    const t = getTokenFrom(req);
    if (!t) return next();
    const payload = jwt.verify(t, JWT_SECRET);

    const { rows } = await pool.query(
      `SELECT id, username, role, email, COALESCE(solver,false) AS solver, COALESCE(is_active,true) AS is_active
       FROM users WHERE id=$1`,
      [payload.sub]
    );
    if (rows.length && rows[0].is_active) {
      const u = rows[0];
      req.user = { id: u.id, username: u.username, role: u.role, email: u.email, solver: (u.solver === true) };
    }
  } catch {
    
  }
  next();
}


const PW_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^\w\s]).{8,}$/;
function isStrongPassword(pw) {
  return PW_REGEX.test(String(pw || ''));
}

/* ===================== 2FA Gizli Anahtar Şifreleme ===================== */
function getTotpKey() {
  const rawHex = process.env.TOTP_ENC_KEY || crypto.createHash('sha256').update(String(JWT_SECRET)).digest('hex');
  return Buffer.from(rawHex.slice(0, 64), 'hex');
}
function encSecret(base32Plain) {
  const key = getTotpKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(base32Plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}
function decSecret(stored) {
  try {
    if (typeof stored !== 'string' || !stored) return null;
    if (!stored.startsWith('enc:v1:')) return stored;
    const [, , ivb, ctb, tagb] = stored.split(':');
    const key = getTotpKey();
    const iv = Buffer.from(ivb, 'base64');
    const ct = Buffer.from(ctb, 'base64');
    const tag = Buffer.from(tagb, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}
function normalizeBase32(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}
// Base32 (TOTP) biçim denetimi: yalnızca A-Z ve 2-7; boşluk/tire/padding yok sayılır.
// Uzunluk 16–64 karakter olmalı (standart TOTP gizli anahtarları 16/26/32 karakterdir).
function isValidBase32Secret(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!cleaned) return false;
  if (!/^[A-Z2-7]+$/.test(cleaned)) return false;
  if (cleaned.length < 16 || cleaned.length > 64) return false;
  return true;
}

function padBase32(b32) {
  const clean = String(b32 || '');
  const rem = clean.length % 8;
  return rem === 0 ? clean : clean + '='.repeat(8 - rem);
}

/* ===================== Attachment Helpers (TEXT JSON) ===================== */
function toRelUploadPath(p) {
  const base = String(p || '').trim();
  if (!base) return null;
  if (base.startsWith('/uploads/')) return base;
  const onlyName = path.basename(base);
  return `/uploads/${onlyName}`;
}


function saveDataUrlToUploads(dataUrl, kind /* 'photo'|'video' */) {
  const m = String(dataUrl || '').match(/^data:(.*?);base64,(.*)$/);
  if (!m) throw new Error('gecersiz_dataurl');
  const mime = (m[1] || '').toLowerCase();
  const buf = Buffer.from(m[2], 'base64');

  const ext = (() => {
    if (kind === 'photo') {
      if (mime.includes('svg')) return '.svg';
      if (mime.includes('png')) return '.png';
      if (mime.includes('webp')) return '.webp';
      if (mime.includes('gif')) return '.gif';
      if (mime.includes('heic')) return '.heic';
      if (mime.includes('heif')) return '.heif';
      return '.jpg';
    }
    if (mime.includes('mp4') || mime.includes('mpeg4')) return '.mp4';
    if (mime.includes('quicktime') || mime.includes('mov')) return '.mov';
    if (mime.includes('x-matroska') || mime.includes('mkv')) return '.mkv';
    if (mime.includes('x-msvideo') || mime.includes('avi')) return '.avi';
    if (mime.includes('x-ms-wmv') || mime.includes('wmv')) return '.wmv';
    if (mime.includes('3gpp2')) return '.3gpp';
    if (mime.includes('3gpp') || mime.includes('3gp')) return '.3gp';
    if (mime.includes('m4v')) return '.m4v';
    if (mime.includes('mpeg')) return '.mpeg';
    if (mime.includes('webm')) return '.webm';
    if (mime.includes('ogg') || mime.includes('ogv')) return '.ogv';
    return '.mp4';
  })();

  const fname = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  const fp = path.join(UPLOAD_DIR, fname);
  fs.writeFileSync(fp, buf);
  return `/uploads/${fname}`;
}

function normalizeIncomingToUrlArray(input, kind /* 'photo'|'video' */) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const out = [];
  for (const v of arr) {
    if (!v) continue;

    if (typeof v === 'string' && v.startsWith('data:')) {
      try {
        out.push(saveDataUrlToUploads(v, kind));
        continue;
      } catch {}
    }

    if (typeof v === 'string') {
      const rel = toRelUploadPath(v);
      if (rel) out.push(rel);
      continue;
    }

    if (typeof v === 'object' && v.dataUrl) {
      try {
        out.push(saveDataUrlToUploads(v.dataUrl, kind));
        continue;
      } catch {}
    }
    if (typeof v === 'object') {
      const relRaw = v.path || v.url || v.href || v.relativePath || '';
      const rel = toRelUploadPath(relRaw);
      if (rel) out.push(rel);
    }
  }
  return Array.from(new Set(out));
}

// TEXT(JSON) yardımcıları
function toJsonText(arr) {
  try {
    return JSON.stringify(Array.isArray(arr) ? arr : []);
  } catch {
    return '[]';
  }
}
function parseJsonText(txt) {
  try {
    const v = JSON.parse(String(txt ?? '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/* ===================== Başlangıç Seed ===================== */
async function seedOlaylarFromEnv(pool) {
  const csv = process.env.OLAY_TURLERI_CSV;
  if (!csv) return;
  const list = csv.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return;

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const name of list) {
      await c.query('INSERT INTO event_type (event_type_name, active) VALUES ($1, true) ON CONFLICT (event_type_name) DO NOTHING', [name]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('seed error:', e);
  } finally {
    c.release();
  }
}
seedOlaylarFromEnv(pool);

/* ===================== Açılışta düz TOTP'leri şifrele ===================== */
async function migratePlainTotpOnBoot() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, two_factor_secret FROM users
       WHERE two_factor_secret IS NOT NULL
         AND two_factor_secret <> ''
         AND two_factor_secret NOT LIKE 'enc:v1:%'`
    );
    for (const r of rows) {
      const enc = encSecret(r.two_factor_secret);
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.bypass_totp_check','1',true)`);
        await client.query('UPDATE users SET two_factor_secret=$1, two_factor_enabled=TRUE WHERE id=$2', [enc, r.id]);
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        throw e;
      }
    }
  } catch (e) {
    console.error('[2FA] Açılışta şifreleme hatası:', e);
  } finally {
    client.release();
  }
}
migratePlainTotpOnBoot();

/* ===================== BOUNDARY (sınır) yükleme ===================== */
function _findBoundaryFile() {
  try {
    if (!fs.existsSync(EXISTING_DATA_DIR)) return null;
    const candidates = ['boundary.geojson', 'boundary.geopackage', 'boundary.gpkg', 'boundary.json'];
    for (const name of candidates) {
      const p = path.join(EXISTING_DATA_DIR, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  } catch {}
  return null;
}

function _readGeoJsonFile(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

// GeoPackage → GeoJSON dönüşümü (ogr2ogr gerektirir; GIS sunucularında genelde mevcuttur)
function _gpkgToGeoJson(gpkgPath) {
  return new Promise((resolve) => {
    const outPath = path.join(require('os').tmpdir(), `dide_boundary_${Date.now()}.geojson`);
    execFile('ogr2ogr', ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', outPath, gpkgPath], (err) => {
      if (err) {
        console.warn('[BOUNDARY] GeoPackage read failed (is GDAL/ogr2ogr installed?). You can use existing_data/boundary.geojson instead. Detail:', err.message);
        return resolve(null);
      }
      try {
        const gj = _readGeoJsonFile(outPath);
        try { fs.unlinkSync(outPath); } catch {}
        resolve(gj);
      } catch (e) {
        console.warn('[BOUNDARY] Converted GeoJSON unreadable:', e.message);
        resolve(null);
      }
    });
  });
}

// file modunda GeoJSON geometrilerini dide_boundary tablosuna yazar (sunucu tarafı ST_Contains için)
async function _loadBoundaryIntoDb(geojson) {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.${BOUNDARY_DB_TABLE} (id serial PRIMARY KEY, geom geometry(Geometry,4326))`);
  await pool.query(`DELETE FROM public.${BOUNDARY_DB_TABLE}`);

  let geoms = [];
  if (geojson && geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
    geoms = geojson.features.map(f => f && f.geometry).filter(Boolean);
  } else if (geojson && geojson.type === 'Feature' && geojson.geometry) {
    geoms = [geojson.geometry];
  } else if (geojson && geojson.type && geojson.coordinates) {
    geoms = [geojson];
  }
  let ok = 0;
  for (const g of geoms) {
    try {
      // ST_Force2D: GeoJSON'da Z (3B) koordinat varsa Z'yi kaldırır (sütun 2B).
      // ST_MakeValid: geçersiz geometrileri onarır.
      await pool.query(
        `INSERT INTO public.${BOUNDARY_DB_TABLE} (geom)
         VALUES (ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))))`,
        [JSON.stringify(g)]
      );
      ok++;
    } catch (e) {
      console.warn('[BOUNDARY] Geometry insert failed:', e.message);
    }
  }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS dide_boundary_gix ON public.${BOUNDARY_DB_TABLE} USING GIST (geom)`); } catch {}
  return ok;
}

async function initBoundary() {
  try {
    // 1) Aggregation layer öncelikli
    if (POLYGON_TABLE && POLYGON_PKS.length > 0) {
      BOUNDARY_MODE = 'aggregation';
      console.log(`[BOUNDARY] Source: aggregation layer ("${POLYGON_TABLE}").`);
      return;
    }

    // 2) existing_data/boundary dosyası
    const file = _findBoundaryFile();
    if (!file) {
      BOUNDARY_MODE = null;
      console.log('[BOUNDARY] No aggregation layer and no boundary file → no boundary (free data entry).');
      return;
    }

    let geojson = null;
    const ext = path.extname(file).toLowerCase();
    if (ext === '.geojson' || ext === '.json') {
      geojson = _readGeoJsonFile(file);
    } else if (ext === '.geopackage' || ext === '.gpkg') {
      geojson = await _gpkgToGeoJson(file);
    }

    if (!geojson) {
      BOUNDARY_MODE = null;
      console.warn(`[BOUNDARY] "${path.basename(file)}" unreadable → no boundary (free).`);
      return;
    }

    const n = await _loadBoundaryIntoDb(geojson);
    if (n > 0) {
      BOUNDARY_MODE = 'file';
      BOUNDARY_GEOJSON = geojson;
      console.log(`[BOUNDARY] Source: file ("${path.basename(file)}", ${n} geometries). Data outside is blocked.`);
    } else {
      BOUNDARY_MODE = null;
      console.warn('[BOUNDARY] No valid geometry loaded from file → no boundary (free).');
    }
  } catch (e) {
    BOUNDARY_MODE = null;
    console.warn('[BOUNDARY] init error → no boundary (free):', e.message);
  }
}

// Bir noktanın sınır içinde olup olmadığını sunucu tarafında kontrol eder.
// Sınır yoksa (mode null) her zaman true döner (serbest).
async function isInsideBoundary(lng, lat) {
  if (!BOUNDARY_MODE) return true;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  try {
    if (BOUNDARY_MODE === 'aggregation') {
      const polyTable = assertSafeIdent(POLYGON_TABLE, 'table');
      const q = `SELECT 1 FROM public.${polyTable} WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1,$2),4326)) LIMIT 1`;
      const r = await pool.query(q, [lng, lat]);
      return r.rowCount > 0;
    } else {
      const q = `SELECT 1 FROM public.${BOUNDARY_DB_TABLE} WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1,$2),4326)) LIMIT 1`;
      const r = await pool.query(q, [lng, lat]);
      return r.rowCount > 0;
    }
  } catch (e) {
    console.warn('[BOUNDARY] isInsideBoundary error:', e.message);
    return true; // hata halinde engelleme (mevcut mantığı bozma)
  }
}

/* ===================== DB Şema + Triggerlar (TEXT JSON) ===================== */
async function ensureDbSqlHelpers() {
  async function run(name, sql) {
    try {
      await pool.query(sql);
    } catch (e) {
      // Only warn on unexpected errors, not "already exists" type
      if (!e.message.includes('already exists') && !e.message.includes('does not exist')) {
        console.warn(`[DB][WARN] ${name}: ${e.message}`);
      }
    }
  }

  async function tx(name, fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
      await c.query('COMMIT');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch {}
      if (!e.message.includes('already exists') && !e.message.includes('does not exist')) {
        console.warn(`[DB][WARN] ${name}: ${e.message}`);
      }
    } finally {
      c.release();
    }
  }

  await run('create extension pgcrypto', `CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await run('create extension postgis',  `CREATE EXTENSION IF NOT EXISTS postgis`);
  await run('create schema app_api',     `CREATE SCHEMA IF NOT EXISTS app_api`);

  await run('users_username_idx', `CREATE INDEX IF NOT EXISTS users_username_idx ON public.users (lower(btrim(username)))`);
  await run('users_email_idx',    `CREATE INDEX IF NOT EXISTS users_email_idx    ON public.users (lower(btrim(email)))`);


  await run('users add is_active',          `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true`);
  await run('users add deleted_by',         `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_by text`);
  await run('users add deleted_by_role',    `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_by_role text`);
  await run('users add deleted_by_id',      `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_by_id integer`);
  await run('users add deleted_at',         `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);
  await run('users add reset_code',         `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS reset_code text`);
  await run('users add reset_expires',      `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS reset_expires timestamptz`);
  await run('users drop two_factor_hash',   `ALTER TABLE public.users DROP COLUMN IF EXISTS two_factor_hash`);
  await run('users add two_factor_secret',   `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS two_factor_secret text`);
  await run('users add two_factor_norm_hash', `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS two_factor_norm_hash text`);

  await run('event add photo_urls',          `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS photo_urls text`);
  await run('event add video_urls',          `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS video_urls text`);
  await run('event photo default',           `ALTER TABLE public.event ALTER COLUMN photo_urls SET DEFAULT '[]'`);
  await run('event photo not null',          `ALTER TABLE public.event ALTER COLUMN photo_urls SET NOT NULL`);
  await run('event video default',           `ALTER TABLE public.event ALTER COLUMN video_urls SET DEFAULT '[]'`);
  await run('event video not null',          `ALTER TABLE public.event ALTER COLUMN video_urls SET NOT NULL`);
  await run('event drop photo',              `ALTER TABLE public.event DROP COLUMN IF EXISTS photo`);
  await run('event drop video',              `ALTER TABLE public.event DROP COLUMN IF EXISTS video`);

  await run('event drop photo_url (legacy single)', `ALTER TABLE public.event DROP COLUMN IF EXISTS photo_url`);
  await run('event drop video_url (legacy single)', `ALTER TABLE public.event DROP COLUMN IF EXISTS video_url`);

  await tx('drop photo_url/video_url on any schema.event (CASCADE)', async (c) => {
    const { rows } = await c.query(`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_name = 'event'
        AND column_name IN ('photo_url','video_url')
    `);
    for (const r of rows) {
      const fq = `"${r.table_schema}"."${r.table_name}"`;
      const col = `"${r.column_name}"`;
      await c.query(`ALTER TABLE ${fq} DROP COLUMN ${col} CASCADE`);
    }
  });

  await tx('ensure photo_url/video_url fully removed', async (c) => {
    const { rows } = await c.query(`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_name = 'event'
        AND column_name IN ('photo_url','video_url')
    `);
    for (const r of rows) {
      const fq = `"${r.table_schema}"."${r.table_name}"`;
      const col = `"${r.column_name}"`;
      try { await c.query(`ALTER TABLE ${fq} ALTER COLUMN ${col} DROP DEFAULT`); } catch {}
      try { await c.query(`ALTER TABLE ${fq} ALTER COLUMN ${col} DROP NOT NULL`); } catch {}
      await c.query(`ALTER TABLE ${fq} DROP COLUMN ${col} CASCADE`);
    }
  });

  await run('event add created_by_name',     `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS created_by_name text`);
  await run('event add created_by_role_name',`ALTER TABLE public.event ADD COLUMN IF NOT EXISTS created_by_role_name text`);
  await run('event add created_by_id',       `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS created_by_id integer`);
  await run('event add active',              `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS active boolean DEFAULT true`);

  // Drop legacy polygon_pk_values column if exists
  await run('event drop polygon_pk_values',  `ALTER TABLE public.event DROP COLUMN IF EXISTS polygon_pk_values`);
  // Drop legacy PK1/PK2 columns if exist
  await run('event drop legacy PK1',         `ALTER TABLE public.event DROP COLUMN IF EXISTS "PK1"`);
  await run('event drop legacy PK2',         `ALTER TABLE public.event DROP COLUMN IF EXISTS "PK2"`);

  // ==================== AGGREGATION_LAYER VALIDATION ====================
  if (POLYGON_TABLE) {
    // Step 1: Check if the table exists in the database
    const tableCheck = await pool.query(`
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema='public' AND LOWER(table_name)=LOWER($1) LIMIT 1
    `, [POLYGON_TABLE]);

    if (tableCheck.rows.length === 0) {
      console.error(`\n[FATAL] AGGREGATION_LAYER="${POLYGON_FILE}" → table "${POLYGON_TABLE}" does NOT exist in the database.`);
      console.error(`        Please import your aggregation layer table into the database first.`);
      console.error(`        System cannot start. Exiting.\n`);
      process.exit(1);
    }

    // Step 2: Auto-detect primary key columns from database
    const pkQuery = await pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND LOWER(tc.table_name) = LOWER($1)
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `, [POLYGON_TABLE]);

    if (pkQuery.rows.length === 0) {
      console.error(`\n[FATAL] AGGREGATION_LAYER="${POLYGON_FILE}" → table "${POLYGON_TABLE}" exists but has NO PRIMARY KEY defined.`);
      console.error(`        Please define a PRIMARY KEY on this table in your database.`);
      console.error(`        Example: ALTER TABLE ${POLYGON_TABLE} ADD PRIMARY KEY (your_column);`);
      console.error(`        Composite primary keys are also supported (e.g. PRIMARY KEY (col_a, col_b, col_c)).`);
      console.error(`        System cannot start. Exiting.\n`);
      process.exit(1);
    }

    // Step 2b: Verify geometry type is Polygon/MultiPolygon (not Line/Point)
    try {
      const geomTypeCheck = await pool.query(
        `SELECT type FROM geometry_columns
         WHERE f_table_schema = 'public' AND LOWER(f_table_name) = LOWER($1) LIMIT 1`,
        [POLYGON_TABLE]
      );
      if (geomTypeCheck.rows.length > 0) {
        const geomType = (geomTypeCheck.rows[0].type || '').toUpperCase();
        if (geomType.includes('LINE') || geomType === 'LINESTRING' || geomType === 'MULTILINESTRING') {
          console.error(`\n[FATAL] AGGREGATION_LAYER="${POLYGON_FILE}" → table "${POLYGON_TABLE}" has geometry type "${geomType}".`);
          console.error(`        The AGGREGATION_LAYER must be a Polygon or MultiPolygon layer, not a Line or LineString layer.`);
          console.error(`        Please set AGGREGATION_LAYER to a polygon layer in your .env file and restart.`);
          console.error(`        System cannot start. Exiting.\n`);
          process.exit(1);
        }
        if (geomType === 'POINT' || geomType === 'MULTIPOINT') {
          console.error(`\n[FATAL] AGGREGATION_LAYER="${POLYGON_FILE}" → table "${POLYGON_TABLE}" has geometry type "${geomType}".`);
          console.error(`        The AGGREGATION_LAYER must be a Polygon or MultiPolygon layer, not a Point layer.`);
          console.error(`        System cannot start. Exiting.\n`);
          process.exit(1);
        }
      }
    } catch (geomErr) {
      console.warn(`[WARN] Could not verify geometry type of "${POLYGON_TABLE}": ${geomErr.message}`);
    }

    // Step 3: Build POLYGON_PKS from detected primary keys
    const validPks = [];
    const safeTable = assertSafeIdent(POLYGON_TABLE, 'table');
    for (const pkRow of pkQuery.rows) {
      const pkName = pkRow.column_name;
      try {
        const safePk = assertSafeIdent(pkName, 'column');
        
        // Get column type
        const colInfo = await pool.query(`
          SELECT c.data_type FROM information_schema.columns c
          WHERE c.table_schema='public' AND LOWER(c.table_name)=LOWER($1) AND LOWER(c.column_name)=LOWER($2)
        `, [POLYGON_TABLE, pkName]);

        const srcType = colInfo.rows[0]?.data_type || 'text';
        let eventColType = 'text';
        if (['integer','bigint','smallint','int','int4','int8','int2'].includes(srcType)) {
          eventColType = 'integer';
        } else if (['numeric','real','double precision','float4','float8'].includes(srcType)) {
          eventColType = 'numeric';
        }

        // Add column to event table
        await run(`event add "${pkName}"`, `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS "${safePk}" ${eventColType}`);
        validPks.push({ name: pkName, safeName: safePk, type: eventColType });
      } catch(e) {
        console.error(`[FATAL] Error processing primary key column "${pkName}": ${e.message}`);
        process.exit(1);
      }
    }
    POLYGON_PKS = validPks;

    // Step 4: Validate Display_Attribute columns exist in table
    for (const attr of DISPLAY_ATTRS) {
      const attrCheck = await pool.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND LOWER(table_name)=LOWER($1) AND LOWER(column_name)=LOWER($2)
      `, [POLYGON_TABLE, attr]);
      if (attrCheck.rows.length === 0) {
        console.error(`\n[FATAL] Display_Attribute column "${attr}" does NOT exist in table "${POLYGON_TABLE}".`);
        console.error(`        System cannot start. Exiting.\n`);
        process.exit(1);
      }
    }

    const pkNames = POLYGON_PKS.map(p => p.name).join(', ');
    const dispNames = DISPLAY_ATTRS.length > 0 ? ` | Display: [${DISPLAY_ATTRS.join(', ')}]` : '';
    console.log(`[OK] Aggregation layer "${POLYGON_TABLE}" validated. Primary Keys: [${pkNames}]${dispNames}`);
  }
  // ==================== END VALIDATION ====================

  await run('event add deactivated_by_name', `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS deactivated_by_name text`);
  await run('event add deactivated_by_role', `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS deactivated_by_role_name text`);
  await run('event add deactivated_by_id',   `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS deactivated_by_id integer`);
  await run('event add deactivated_at',      `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS deactivated_at timestamptz`);
  await run('event drop created_by legacy',  `ALTER TABLE public.event DROP COLUMN IF EXISTS created_by`);

  await run('event_type add active',             `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS active boolean DEFAULT true`);
  await run('event_type add created_by_name',    `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS created_by_name text`);
  await run('event_type add created_by_role',    `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS created_by_role_name text`);
  await run('event_type add created_by_id',      `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS created_by_id integer`);
  await run('event_type add created_at default', `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`);
  await run('event_type add deactivated_at',     `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS deactivated_at timestamptz`);
  await run('event_type drop created_by legacy', `ALTER TABLE public.event_type DROP COLUMN IF EXISTS created_by`);
  await run('event_type add created_at default', `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`);
  await run('event_type add deactivated_at',     `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS deactivated_at timestamptz`);
  await run('event_type drop created_by legacy', `ALTER TABLE public.event_type DROP COLUMN IF EXISTS created_by`);
  await run('event_type add public',               `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS "public" boolean DEFAULT false`);

  // Time-dependency support:
  //  - time_dependent: TRUE if this event type expires after a while, FALSE otherwise.
  //  - valid_time    : validity period stored as a float number of DAYS
  //                    (NULL when the event type is not time-dependent).
  await run('event_type add time_dependent',       `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS time_dependent boolean DEFAULT false`);
  await run('event_type add valid_time',           `ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS valid_time double precision`);

  // last_agreed_date: zamana bağlı olayların ömrü BU tarihten itibaren sayılır.
  //  - Olay eklendiğinde created_at ile aynı değeri alır.
  //  - Bir kullanıcı olaya KATILDIĞINDA (agree) o anki tarihe güncellenir; böylece
  //    olayın süresi, bağlı olduğu olay türünün süresi kadar UZAR.
  //  - created_at HİÇ değişmez (ilk gönderim tarihi korunur).
  await run('event add last_agreed_date',          `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS last_agreed_date timestamptz`);
  await run('event backfill last_agreed_date',     `UPDATE public.event SET last_agreed_date = created_at WHERE last_agreed_date IS NULL AND created_at IS NOT NULL`);

  // Rename event_type."public" → "public_"  (idempotent: handles new & existing installs)
  await tx('event_type rename public to public_', async (c) => {
    const has_public = await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='event_type' AND column_name='public' LIMIT 1`
    );
    if (has_public.rows.length > 0) {
      await c.query(`ALTER TABLE public.event_type RENAME COLUMN "public" TO "public_"`);
    }
    // If neither exists yet (fresh install path where add above was also skipped), ensure public_ exists
    const has_public_ = await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='event_type' AND column_name='public_' LIMIT 1`
    );
    if (has_public_.rows.length === 0) {
      await c.query(`ALTER TABLE public.event_type ADD COLUMN "public_" boolean DEFAULT false`);
    }
  });

  // event: update tracking columns
  await run('event add updated_by_name',      `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS updated_by_name text`);
  await run('event add updated_by_role_name', `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS updated_by_role_name text`);
  await run('event add updated_by_id',        `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS updated_by_id integer`);
  await run('event add updated_at',           `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS updated_at timestamptz`);

  // users: kayıt tarihi (e-posta doğrulandığı an yazılır)
  await run('users add registration_date',    `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS registration_date timestamptz`);

  // users: solver (olay kapatan) yetkisi — yalnızca 'user' rolü için anlamlıdır.
  // true iken kullanıcı olay ekleyemez, yalnızca kullanıcıların eklediği olayları kapatabilir.
  await run('users add solver',               `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS solver boolean DEFAULT false`);
  await run('users solver default false',      `UPDATE public.users SET solver=false WHERE solver IS NULL`);

  // ===== Beğeni (like) ve puanlama altyapısı =====
  // event.num_agrees  : o gönderinin (olayın) aldığı toplam beğeni sayısı (dinamik güncellenir)
  // event.agreed_ids  : gönderiyi beğenen kullanıcı ID'lerinin listesi (JSONB dizi)
  await run('event rename num_likes->num_agrees', `DO $$ BEGIN IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='event' AND column_name='num_likes') AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='event' AND column_name='num_agrees') THEN ALTER TABLE public.event RENAME COLUMN num_likes TO num_agrees; END IF; END $$;`);
  await run('event rename liked_ids->agreed_ids', `DO $$ BEGIN IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='event' AND column_name='liked_ids') AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='event' AND column_name='agreed_ids') THEN ALTER TABLE public.event RENAME COLUMN liked_ids TO agreed_ids; END IF; END $$;`);
  await run('event add num_agrees',            `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS num_agrees integer DEFAULT 0`);
  await run('event add agreed_ids',            `ALTER TABLE public.event ADD COLUMN IF NOT EXISTS agreed_ids jsonb DEFAULT '[]'::jsonb`);
  await run('event num_agrees default 0',       `UPDATE public.event SET num_agrees=0 WHERE num_agrees IS NULL`);
  await run('event agreed_ids default []',      `UPDATE public.event SET agreed_ids='[]'::jsonb WHERE agreed_ids IS NULL`);

  // users (olay ekleyen "expert" hesapları) için agregat istatistikler:
  //   num_events  : kullanıcının eklediği toplam olay sayısı (aktif + deaktif)
  //   agreed_point : kullanıcının gönderilerinde aldığı toplam beğeni sayısı
  //   posts_point : genel hesaplanan puan = SUM(2*num_agrees + 1) = 2*agreed_point + num_events
  await run('users add num_events',           `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS num_events integer DEFAULT 0`);
  await run('users rename liked_point->agreed_point', `DO $$ BEGIN IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='liked_point') AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='agreed_point') THEN ALTER TABLE public.users RENAME COLUMN liked_point TO agreed_point; END IF; END $$;`);
  await run('users add agreed_point',          `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS agreed_point integer DEFAULT 0`);
  await run('users add posts_point',          `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS posts_point integer DEFAULT 0`);

  // İlk kurulum/mevcut veriler için tek seferlik geri-doldurma (backfill)
  await run('backfill user stats', `
    UPDATE public.users u SET
      num_events  = COALESCE(sub.cnt, 0),
      agreed_point = COALESCE(sub.agrees, 0),
      posts_point = COALESCE(2*sub.agrees + sub.kept, 0)
                    + COALESCE((SELECT COUNT(*) FROM public.event e2
                                 WHERE COALESCE(e2.agreed_ids,'[]'::jsonb) @> to_jsonb(u.id)), 0)
    FROM (
      SELECT created_by_id AS uid,
             COUNT(*) AS cnt,
             COUNT(*) FILTER (
               WHERE COALESCE(active, true) = true
                  OR deactivated_by_id IS NULL
                  OR deactivated_by_id <> created_by_id
             ) AS kept,
             COALESCE(SUM(COALESCE(num_agrees,0)),0) AS agrees
      FROM public.event
      WHERE created_by_id IS NOT NULL
      GROUP BY created_by_id
    ) sub
    WHERE u.id = sub.uid
  `);

  // Hiç gönderi eklememiş ama başkalarının gönderilerine KATILMIŞ kullanıcılar için:
  // yalnızca katılım puanları (her katılım +1) yazılır.
  await run('backfill agree-given points', `
    UPDATE public.users u SET
      posts_point = COALESCE(given.cnt, 0)
    FROM (
      SELECT u2.id AS uid,
             (SELECT COUNT(*) FROM public.event e2
               WHERE COALESCE(e2.agreed_ids,'[]'::jsonb) @> to_jsonb(u2.id)) AS cnt
        FROM public.users u2
       WHERE NOT EXISTS (SELECT 1 FROM public.event e3 WHERE e3.created_by_id = u2.id)
    ) given
    WHERE u.id = given.uid AND COALESCE(given.cnt,0) > 0
  `);

  await tx('event_type unique(event_type_name)', async (c) => {
    try {
      await c.query(`ALTER TABLE public.event_type ADD CONSTRAINT event_type_name_key UNIQUE (event_type_name)`);
    } catch (e) {
      if (!/already exists|duplicate|exists/i.test(e.message)) throw e;
    }
  });

  await tx('users identity+pk', async (c) => {
    try { await c.query(`ALTER TABLE public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id)`); } catch {}
    try { await c.query(`ALTER TABLE public.users ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY`); } catch {}
  });

  await tx('event identity+pk', async (c) => {
    try { await c.query(`ALTER TABLE public.event ADD CONSTRAINT olay_pkey PRIMARY KEY (event_id)`); } catch {}
    try { await c.query(`ALTER TABLE public.event ALTER COLUMN event_id ADD GENERATED BY DEFAULT AS IDENTITY`); } catch {}
  });

  await tx('event_type identity+pk', async (c) => {
    try { await c.query(`ALTER TABLE public.event_type ADD CONSTRAINT event_type_pkey PRIMARY KEY (event_type_id)`); } catch {}
    try { await c.query(`ALTER TABLE public.event_type ALTER COLUMN event_type_id ADD GENERATED BY DEFAULT AS IDENTITY`); } catch {}
  });

  await tx('event photo_urls ARRAY->text(JSON)', async (c) => {
    try {
      const info = await c.query(`
        SELECT data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='event' AND column_name='photo_urls'
      `);
    if (info.rows[0]?.data_type === 'ARRAY') {
        await c.query(`ALTER TABLE public.event ALTER COLUMN photo_urls TYPE text USING to_json(photo_urls)::text`);
      }
    } catch (e) {
      console.warn('[DB][WARN] event photo_urls type check failed:', e.message);
    }
  });

  await tx('event video_urls ARRAY->text(JSON)', async (c) => {
    try {
      const info = await c.query(`
        SELECT data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='event' AND column_name='video_urls'
      `);
      if (info.rows[0]?.data_type === 'ARRAY') {
        await c.query(`ALTER TABLE public.event ALTER COLUMN video_urls TYPE text USING to_json(video_urls)::text`);
      }
    } catch (e) {
      console.warn('[DB][WARN] event video_urls type check failed:', e.message);
    }
  });

  await run('fn _check_password_policy', `
    CREATE OR REPLACE FUNCTION app_api._check_password_policy(pw text)
    RETURNS void LANGUAGE plpgsql AS $fn$
    BEGIN
      -- Postgres POSIX regex: lookahead yok; \w/\s yok.
      -- Kurallar: >=8, en az 1 küçük, 1 büyük, 1 sembol (harf/rakam/boşluk dışı).
      IF pw IS NULL
         OR length(pw) < 8
         OR pw !~ '[[:lower:]]'
         OR pw !~ '[[:upper:]]'
         OR pw !~ '[^[:alnum:][:space:]]'
      THEN
        RAISE EXCEPTION 'Şifre politikası: En az 8 karakter, en az bir küçük harf, en az bir büyük harf ve en az bir noktalama/simge.' USING ERRCODE='P0001';
      END IF;
    END
    $fn$;
  `);


  await run('fn _normalize_base32', `
    CREATE OR REPLACE FUNCTION app_api._normalize_base32(b32 text)
    RETURNS text LANGUAGE sql AS
    $$ SELECT NULLIF(regexp_replace(upper(COALESCE(b32,'')), '[^A-Z2-7]', '', 'g'), '') $$;
  `);

  await run('fn _sha256_hex', `
    CREATE OR REPLACE FUNCTION app_api._sha256_hex(t text)
    RETURNS text LANGUAGE sql AS
    $$ SELECT CASE WHEN t IS NULL THEN NULL ELSE encode(digest(t,'sha256'),'hex') END $$;
  `);

  await run('fn _extract_plain_from_query', `
    CREATE OR REPLACE FUNCTION app_api._extract_plain_from_query(q text)
    RETURNS text LANGUAGE plpgsql AS $fn$
    DECLARE m text;
    BEGIN
      IF q IS NULL THEN RETURN NULL; END IF;
      m := substring(q from $rx$crypt\\('([^']+)'\\s*,\\s*gen_salt\\('bf'[^\\)]*\\)\\)$rx$);
      RETURN m;
    END
    $fn$;
  `);

  await run('fn users_before_ins_upd', `
    CREATE OR REPLACE FUNCTION app_api.users_before_ins_upd()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE plain text; curq text;
    BEGIN
      IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (OLD.password_hash IS DISTINCT FROM NEW.password_hash)) THEN
        plain := current_setting('app.password_plain', true);
        IF plain IS NULL THEN
          SELECT query INTO curq FROM pg_stat_activity WHERE pid = pg_backend_pid();
          plain := app_api._extract_plain_from_query(curq);
        END IF;
        IF plain IS NULL THEN
          RAISE EXCEPTION 'Şifre doğrulaması için ya düz parolayı SQL içinde crypt(''PAROLA'', gen_salt(''bf'')) şeklinde verin ya da INSERT öncesi SELECT set_config(''app.password_plain'',''PAROLA'',true) çağırın.' USING ERRCODE='P0001';
        END IF;
        PERFORM app_api._check_password_policy(plain);
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);

  await run('fn users_prevent_global_dup', `
    CREATE OR REPLACE FUNCTION app_api.users_prevent_global_dup()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE v_dummy int;
    BEGIN
      IF NEW.username IS NOT NULL THEN NEW.username := NULLIF(btrim(NEW.username),''); END IF;
      IF NEW.email    IS NOT NULL THEN NEW.email    := NULLIF(btrim(NEW.email),   ''); END IF;

      IF TG_OP='INSERT' THEN
        -- Kullanıcı adı: rol fark etmeksizin tablo genelinde benzersiz
        SELECT 1 INTO v_dummy FROM public.users u
        WHERE lower(btrim(u.username)) = lower(COALESCE(NEW.username,''))
        LIMIT 1;
        IF FOUND THEN RAISE EXCEPTION 'active_username_or_email_exists' USING ERRCODE='P0002'; END IF;

        -- E-posta: yalnızca AYNI şirketin kullanıcıları arasında tekrarlanabilir
        IF COALESCE(NEW.email,'') <> '' THEN
          SELECT 1 INTO v_dummy FROM public.users u
          WHERE lower(btrim(u.email)) = lower(NEW.email)
            AND NOT (COALESCE(NEW.role,'') = 'company' AND u.role = 'company'
                     AND NEW.dependent_company IS NOT NULL
                     AND u.dependent_company = NEW.dependent_company)
          LIMIT 1;
          IF FOUND THEN RAISE EXCEPTION 'active_username_or_email_exists' USING ERRCODE='P0002'; END IF;
        END IF;
      ELSIF TG_OP='UPDATE' THEN
        IF COALESCE(OLD.is_active,false)=false AND COALESCE(NEW.is_active,true)=true THEN RETURN NEW; END IF;

        IF (COALESCE(NEW.username,'') IS DISTINCT FROM COALESCE(OLD.username,''))
           OR (COALESCE(NEW.email,'') IS DISTINCT FROM COALESCE(OLD.email,'')) THEN
          SELECT 1 INTO v_dummy FROM public.users u
          WHERE u.id <> NEW.id
            AND lower(btrim(u.username)) = lower(COALESCE(NEW.username,''))
          LIMIT 1;
          IF FOUND THEN RAISE EXCEPTION 'active_username_or_email_exists' USING ERRCODE='P0002'; END IF;

          IF COALESCE(NEW.email,'') <> '' THEN
            SELECT 1 INTO v_dummy FROM public.users u
            WHERE u.id <> NEW.id
              AND lower(btrim(u.email)) = lower(NEW.email)
              AND NOT (COALESCE(NEW.role,'') = 'company' AND u.role = 'company'
                       AND NEW.dependent_company IS NOT NULL
                       AND u.dependent_company = NEW.dependent_company)
            LIMIT 1;
            IF FOUND THEN RAISE EXCEPTION 'active_username_or_email_exists' USING ERRCODE='P0002'; END IF;
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);

  await run('fn users_prevent_useless_activate', `
    CREATE OR REPLACE FUNCTION app_api.users_prevent_useless_activate()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP='UPDATE'
         AND (TG_ARGV[0] IS NULL OR TG_ARGV[0] <> 'bypass')
         AND COALESCE(OLD.is_active,true)=true
         AND COALESCE(NEW.is_active,true)=true THEN
        RAISE EXCEPTION 'active liği true olan bir kullanıcının active liği true olamaz' USING ERRCODE='P0004';
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);

  await run('fn users_totp_before', `
    CREATE OR REPLACE FUNCTION app_api.users_totp_before()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE b32 text; h text; bypass text;
    BEGIN
      bypass := current_setting('app.bypass_totp_check', true);
      IF bypass = '1' THEN RETURN NEW; END IF;

      IF NEW.role NOT IN ('supervisor','company') THEN
        NEW.two_factor_secret := NULL;
        NEW.two_factor_norm_hash := NULL;
        RETURN NEW;
      END IF;

      IF NEW.two_factor_secret IS NULL OR NEW.two_factor_secret = '' THEN
        NEW.two_factor_enabled := false;
        NEW.two_factor_secret := NULL;
        NEW.two_factor_norm_hash := NULL;
        RETURN NEW;
      END IF;

      IF NEW.two_factor_secret LIKE 'enc:v1:%' THEN
        RETURN NEW;
      END IF;

      b32 := app_api._normalize_base32(NEW.two_factor_secret);
      IF b32 IS NULL OR b32 = '' THEN
        RAISE EXCEPTION 'invalid_base32' USING ERRCODE='P0003';
      END IF;

      h := app_api._sha256_hex(b32);
      PERFORM 1 FROM public.users u
        WHERE u.role IN ('supervisor','company')
          AND u.two_factor_norm_hash = h
          AND (TG_OP='INSERT' OR u.id <> NEW.id)
        LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'base32_conflict' USING ERRCODE='P0003';
      END IF;

      NEW.two_factor_norm_hash := h;
      NEW.two_factor_enabled := true;
      RETURN NEW;
    END
    $fn$;
  `);

  await run('fn users_after_status_change', `
    CREATE OR REPLACE FUNCTION app_api.users_after_status_change()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP='UPDATE' AND COALESCE(OLD.is_active,false)=false AND COALESCE(NEW.is_active,true)=true THEN
        UPDATE public.event o
          SET active = TRUE,
              deactivated_by_name = NULL,
              deactivated_by_role_name = NULL,
              deactivated_by_id = NULL,
              deactivated_at = NULL
        WHERE COALESCE(o.active,false)=false
          AND (o.created_by_id = NEW.id OR (o.created_by_id IS NULL AND o.created_by_name = NEW.username));

        IF NEW.role = 'supervisor' THEN
          UPDATE public.event_type t
            SET active = TRUE,
                deactivated_by_name = NULL,
                deactivated_by_role_name = NULL,
                deactivated_by_id = NULL,
                deactivated_at = NULL
          WHERE COALESCE(t.active,false)=false
            AND (t.created_by_id = NEW.id OR (t.created_by_id IS NULL AND t.created_by_name = NEW.username));
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);

  await run('fn users_after_ins_upd', `
    CREATE OR REPLACE FUNCTION app_api.users_after_ins_upd()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.two_factor_secret IS NOT NULL
         AND NEW.two_factor_secret <> ''
         AND NEW.two_factor_secret NOT LIKE 'enc:v1:%' THEN
        PERFORM pg_notify('encrypt_totp', NEW.id::text);
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);

  await run('fn olay_fill_deactivated_meta', `
    CREATE OR REPLACE FUNCTION app_api.olay_fill_deactivated_meta()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE actor_name text := current_setting('app.actor_name', true);
            actor_role text := current_setting('app.actor_role', true);
            actor_id   int  := NULLIF(current_setting('app.actor_id', true),'')::int;
    BEGIN
      IF COALESCE(OLD.active,true)=true AND COALESCE(NEW.active,false)=false THEN
        IF NEW.deactivated_by_name IS NULL THEN NEW.deactivated_by_name := COALESCE(actor_name, current_user); END IF;
        IF NEW.deactivated_by_role_name IS NULL THEN NEW.deactivated_by_role_name := COALESCE(actor_role, 'db_user'); END IF;
        IF NEW.deactivated_by_id IS NULL THEN NEW.deactivated_by_id := actor_id; END IF;
        IF NEW.deactivated_at IS NULL THEN NEW.deactivated_at := NOW(); END IF;
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);

  await run('fn event_type_fill_deactivated_meta', `
    CREATE OR REPLACE FUNCTION app_api.event_type_fill_deactivated_meta()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE actor_name text := current_setting('app.actor_name', true);
            actor_role text := current_setting('app.actor_role', true);
            actor_id   int  := NULLIF(current_setting('app.actor_id', true),'')::int;
    BEGIN
      IF COALESCE(OLD.active,true)=true AND COALESCE(NEW.active,false)=false THEN
        IF NEW.deactivated_by_name IS NULL THEN NEW.deactivated_by_name := COALESCE(actor_name, current_user); END IF;
        IF NEW.deactivated_by_role_name IS NULL THEN NEW.deactivated_by_role_name := COALESCE(actor_role, 'db_user'); END IF;
        IF NEW.deactivated_by_id IS NULL THEN NEW.deactivated_by_id := actor_id; END IF;
        IF NEW.deactivated_at IS NULL THEN NEW.deactivated_at := NOW(); END IF;
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);

  await run('fn users_enforce_update_rows', `
    CREATE OR REPLACE FUNCTION app_api.users_enforce_update_rows()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  `);

  await run('drop trg_users_prevent_global_dup', `DROP TRIGGER IF EXISTS trg_users_prevent_global_dup ON public.users`);
  await run('drop trg_users_before_ins_upd',     `DROP TRIGGER IF EXISTS trg_users_before_ins_upd ON public.users`);
  await run('drop trg_users_totp_before',        `DROP TRIGGER IF EXISTS trg_users_totp_before ON public.users`);
  await run('drop trg_users_guard_reactivate',   `DROP TRIGGER IF EXISTS trg_users_guard_reactivate ON public.users`);
  await run('drop trg_users_enforce_is_active_update', `DROP TRIGGER IF EXISTS trg_users_enforce_is_active_update ON public.users`);
  await run('drop trg_users_after_ins_upd',      `DROP TRIGGER IF EXISTS trg_users_after_ins_upd ON public.users`);
  await run('drop trg_olay_fill_deactivated',    `DROP TRIGGER IF EXISTS trg_olay_fill_deactivated ON public.event`);

  await run('trg_users_prevent_global_dup', `
    CREATE TRIGGER trg_users_prevent_global_dup
    BEFORE INSERT OR UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION app_api.users_prevent_global_dup()
  `);

  await run('trg_users_before_ins_upd', `
    CREATE TRIGGER trg_users_before_ins_upd
    BEFORE INSERT OR UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION app_api.users_before_ins_upd()
  `);

  await run('trg_users_totp_before', `
    CREATE TRIGGER trg_users_totp_before
    BEFORE INSERT OR UPDATE OF two_factor_secret, two_factor_enabled, role ON public.users
    FOR EACH ROW EXECUTE FUNCTION app_api.users_totp_before()
  `);

  await run('trg_users_guard_reactivate', `
    CREATE TRIGGER trg_users_guard_reactivate
    BEFORE UPDATE OF is_active ON public.users
    FOR EACH ROW EXECUTE FUNCTION app_api.users_prevent_useless_activate()
  `);

  await run('trg_users_enforce_is_active_update', `
    CREATE TRIGGER trg_users_enforce_is_active_update
    AFTER UPDATE ON public.users
    FOR EACH STATEMENT EXECUTE FUNCTION app_api.users_enforce_update_rows()
  `);

  await run('trg_users_after_ins_upd', `
    CREATE TRIGGER trg_users_after_ins_upd
    AFTER INSERT OR UPDATE OF two_factor_secret ON public.users
    FOR EACH ROW EXECUTE FUNCTION app_api.users_after_ins_upd()
  `);

  await run('trg_olay_fill_deactivated', `
    CREATE TRIGGER trg_olay_fill_deactivated
    BEFORE UPDATE OF active ON public.event
    FOR EACH ROW EXECUTE FUNCTION app_api.olay_fill_deactivated_meta()
  `);

  await run('fn app_api.create_user', `
    CREATE OR REPLACE FUNCTION app_api.create_user(
      p_username text, p_password text, p_role text, p_name text, p_surname text, p_email text
    )
    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE v_id integer;
    BEGIN
      IF p_role NOT IN ('user','supervisor','admin') THEN
        RAISE EXCEPTION 'Geçersiz rol: %', p_role USING ERRCODE='P0001';
      END IF;

      PERFORM app_api._check_password_policy(p_password);
      PERFORM set_config('app.password_plain', p_password, true);

      INSERT INTO public.users (username, password_hash, role, name, surname, email, email_verified, is_verified, is_active)
      VALUES (p_username, crypt(p_password, gen_salt('bf',10)), p_role, NULLIF(p_name,''), NULLIF(p_surname,''), p_email, TRUE, TRUE, TRUE)
      RETURNING id INTO v_id;

      PERFORM set_config('app.password_plain', NULL, true);
      RETURN v_id;
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('app.password_plain', NULL, true);
      RAISE;
    END
    $fn$;
  `);

  await run('fn app_api.set_user_totp', `
    CREATE OR REPLACE FUNCTION app_api.set_user_totp(p_user_id integer, p_base32 text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    BEGIN
      UPDATE public.users
      SET two_factor_secret = NULLIF(p_base32,''),
          two_factor_enabled = (p_base32 IS NOT NULL AND p_base32 <> '')
      WHERE id = p_user_id;
    END
    $fn$;
  `);

  await run('fn app_api.activate_user', `
    CREATE OR REPLACE FUNCTION app_api.activate_user(p_user_id integer)
    RETURNS TABLE (id integer, username text, is_active boolean)
    LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE cur record;
    BEGIN
      SELECT id, username, COALESCE(is_active,true) AS is_active
      INTO cur FROM public.users WHERE id = p_user_id FOR UPDATE;

      IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found' USING ERRCODE='P0005'; END IF;
      IF cur.is_active = TRUE THEN
        RAISE EXCEPTION 'active liği true olan bir kullanıcının active liği true olamaz' USING ERRCODE='P0004';
      END IF;

      UPDATE public.users
      SET is_active = TRUE, deleted_by=NULL, deleted_by_role=NULL, deleted_by_id=NULL, deleted_at=NULL
      WHERE id = p_user_id AND COALESCE(is_active, FALSE) = FALSE
      RETURNING id, username, is_active INTO id, username, is_active;

      RETURN NEXT;
    END
    $fn$;
  `);

  await run('fn app_api.hard_delete_user', `
    CREATE OR REPLACE FUNCTION app_api.hard_delete_user(p_user_id integer)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE v_id integer;
    BEGIN
      SELECT id INTO v_id FROM public.users WHERE id = p_user_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found' USING ERRCODE='P0005'; END IF;
      DELETE FROM public.users WHERE id = p_user_id;
    END
    $fn$;
  `);

  await run('users_supervisor_totp_norm_uniq', `
    CREATE UNIQUE INDEX IF NOT EXISTS users_supervisor_totp_norm_uniq
      ON public.users (two_factor_norm_hash)
      WHERE role='supervisor' AND two_factor_norm_hash IS NOT NULL
  `);

  await run('users_2fa_totp_norm_uniq', `
    CREATE UNIQUE INDEX IF NOT EXISTS users_2fa_totp_norm_uniq
      ON public.users (two_factor_norm_hash)
      WHERE role IN ('supervisor','company') AND two_factor_norm_hash IS NOT NULL
  `);

}


let listenClient;
async function startTotpListener() {
  try {
    listenClient = await pool.connect();
    await listenClient.query('LISTEN encrypt_totp');
    listenClient.on('notification', async (msg) => {
      const id = parseInt(msg.payload, 10);
      if (!Number.isInteger(id)) return;
      try {
        const { rows } = await listenClient.query('SELECT two_factor_secret FROM users WHERE id=$1', [id]);
        if (!rows.length) return;
        const cur = rows[0].two_factor_secret;
        if (!cur || String(cur).startsWith('enc:v1:')) return;
        const enc = encSecret(cur);

        try {
          await listenClient.query('BEGIN');
          await listenClient.query(`SELECT set_config('app.bypass_totp_check','1',true)`);
          await listenClient.query('UPDATE users SET two_factor_secret=$1, two_factor_enabled=TRUE WHERE id=$2', [enc, id]);
          await listenClient.query('COMMIT');
        } catch (e) {
          try { await listenClient.query('ROLLBACK'); } catch {}
          console.error('[2FA] NOTIFY işleme hatası:', e);
        }
      } catch (e) {
        console.error('[2FA] NOTIFY işleme hatası:', e);
      }
    });
    listenClient.on('error', (e) => {
      console.error('[LISTEN] bağlantı hatası:', e);
      setTimeout(startTotpListener, 2000);
    });
  } catch (e) {
    console.error('[LISTEN] kanal başlatılamadı:', e);
  }
}
startTotpListener();

/* ===================== Site config ===================== */
app.get('/api/config', (_req, res) => {
  // .env değişip sunucu yeniden başlatıldığında tarayıcı ESKİ değerleri
  // önbellekten döndürmesin diye config yanıtı asla cache'lenmemeli.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');

  const mapLat = parseFloat(process.env.MAP_INITIAL_LAT);
  const mapLng = parseFloat(process.env.MAP_INITIAL_LNG);
  const mapZoom = parseInt(process.env.MAP_INITIAL_ZOOM, 10);

  res.json({
    siteTitle: process.env.SITE_TITLE,
    siteLogoUrl: process.env.SITE_LOGO_URL,
    allowedDomains: ALLOWED_EMAIL_DOMAINS.length > 0 ? ALLOWED_EMAIL_DOMAINS : null,
    allowedEmailDomains: ALLOWED_EMAIL_DOMAINS,
    pageSizeEvents: TABLE_PAGE_SIZE_EVENTS,
    pageSizeTypes: TABLE_PAGE_SIZE_TYPES,
    pageSizeUsers: TABLE_PAGE_SIZE_USERS,
    mapInitialLat: Number.isFinite(mapLat) ? mapLat : 39.9334,
    mapInitialLng: Number.isFinite(mapLng) ? mapLng : 32.8597,
    mapInitialZoom: Number.isFinite(mapZoom) ? mapZoom : 6,
    mapMinZoom: MAP_MIN_ZOOM,
    showGoodEventsOnLogin: SHOW_GOOD_EVENTS_ON_LOGIN,
    showBadEventsOnLogin: SHOW_BAD_EVENTS_ON_LOGIN,
    polygonTable: POLYGON_TABLE || null,
    polygonPk1: POLYGON_PKS[0]?.name || null,
    polygonPk2: POLYGON_PKS[1]?.name || null,
    polygonPks: POLYGON_PKS.map(p => p.name),
    displayAttrs: DISPLAY_ATTRS,
    defaultLang: DEFAULT_LANG.toLowerCase(),
    restrictGnss: RESTRICT_GNSS,
    eventTypeValidityUnits: EVENT_TYPE_VALIDITY_UNITS,
    zoomLevelBoundary: String(process.env.ZOOM_LEVEL_BOUNDARY || '').trim().toLowerCase(),
    // İki gönderi arasındaki bekleme süresi (saat). 0 => sınır yok.
    eventSubmitIntervalHours: EVENT_SUBMIT_INTERVAL_HOURS > 0 ? EVENT_SUBMIT_INTERVAL_HOURS : 0,
    // Olay ekleme akışındaki tampon yarıçapı (metre). 0 => tampon yok.
    bufferRadius: BUFFER_RADIUS > 0 ? BUFFER_RADIUS : 0,
    // Rotalama: hedefe yaklaşma eşiği (metre). OSRM adresleri istemciye GÖNDERİLMEZ.
    routeArrivalThreshold: ROUTE_ARRIVAL_THRESHOLD,
    // Şirket logolarının görünmeye başladığı en küçük zoom seviyesi
    companyLogoMinZoom: COMPANY_LOGO_MIN_ZOOM,
  });
});
/* ===================== AUTH ===================== */
async function failIfAnyDuplicate(usernameRaw, emailRaw) {
  const username = norm(usernameRaw);
  const email = norm(emailRaw);

  const uq = await pool.query(
    `SELECT 1 FROM users WHERE lower(btrim(username))=lower($1) LIMIT 1`,
    [username]
  );
  const usernameTaken = uq.rowCount > 0;

  const eq = await pool.query(
    `SELECT 1 FROM users WHERE lower(btrim(email))=lower($1) LIMIT 1`,
    [email]
  );
  const emailTaken = eq.rowCount > 0;

  if (usernameTaken && emailTaken) {
    const err = new Error('both_taken');
    err.code = 'BOTH_DUP';
    throw err;
  } else if (usernameTaken) {
    const err = new Error('username_taken');
    err.code = 'USERNAME_DUP';
    throw err;
  } else if (emailTaken) {
    const err = new Error('email_taken');
    err.code = 'EMAIL_DUP';
    throw err;
  }
}

app.post('/api/auth/register', async (req, res) => {
  const username = norm(req.body?.username);
  const password = req.body?.password;
  const name = (req.body?.name || '').toString().trim() || null;
  const surname = (req.body?.surname || '').toString().trim() || null;
  const email = norm(req.body?.email);

  if (!username || !password || !email)
    return res.status(400).json({ error: 'eksik_bilgi', message: getErrorMessage(req, 'eksik_bilgi') });
  // İsim/soyisim zorunlu (başka kullanıcılarla aynı olabilir, sadece boş bırakılamaz)
  if (!name || !surname)
    return res.status(400).json({ error: 'name_surname_required', message: getErrorMessage(req, 'name_surname_required') });
  if (!isStrongPassword(password))
    return res.status(400).json({ error: 'zayif_sifre', message: getErrorMessage(req, 'zayif_sifre') });
  if (!isEmailAllowed(email)) {
    let message = getErrorMessage(req, 'gecersiz_eposta');
    if (ALLOWED_EMAIL_DOMAINS.length > 0) {
      const lang = _detectLang(req);
      if (ALLOWED_EMAIL_DOMAINS.length === 1) {
        message = lang === 'en' 
          ? `Only email addresses with ${ALLOWED_EMAIL_DOMAINS[0]} domain are allowed.`
          : `Yalnızca ${ALLOWED_EMAIL_DOMAINS[0]} alan adına sahip e-posta adresleriyle kayıt olunabilir.`;
      } else {
        message = lang === 'en'
          ? `Only email addresses with the following domains are allowed: ${ALLOWED_EMAIL_DOMAINS.join(', ')}`
          : `Yalnızca şu alan adlarına sahip e-posta adresleriyle kayıt olunabilir: ${ALLOWED_EMAIL_DOMAINS.join(', ')}`;
      }
    }
    return res.status(400).json({
      error: 'gecersiz_eposta',
      message: message,
    });
  }

  try {
    await failIfAnyDuplicate(username, email);
  } catch (e) {
    if (e.code === 'USERNAME_DUP')
      return res.status(409).json({ error: 'usernameTaken', message: getErrorMessage(req, 'usernameTaken') });
    if (e.code === 'EMAIL_DUP')
      return res.status(409).json({ error: 'emailTaken', message: getErrorMessage(req, 'emailTaken') });
    if (e.code === 'BOTH_DUP')
      return res.status(409).json({ error: 'bothTaken', message: getErrorMessage(req, 'bothTaken') });
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const verifyToken = crypto.randomBytes(20).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await client.query(`SELECT set_config('app.password_plain', $1, true)`, [password]);

    const ins = await client.query(
      `INSERT INTO users (username, password_hash, role, name, surname, email, email_verified, is_verified, verify_token, verify_expires, is_active)
       VALUES ($1, crypt($2, gen_salt('bf',10)), 'user', $3, $4, $5, false, false, $6, $7, true)
       RETURNING id, username, email`,
      [username, password, name, surname, email, verifyToken, verifyExpires]
    );

    await client.query('COMMIT');

    if (!transporter) {
      return res.status(500).json({
        error: 'eposta_gonderilemedi',
        message: getErrorMessage(req, 'eposta_gonderilemedi'),
      });
    }

    try {
      const verifyLink = `${req.protocol}://${req.get('host')}/api/auth/verify?token=${verifyToken}`;
      const lang = _detectLang(req);

      const _verifyContent = {
        en: {
          subject: 'Email Verification',
          html: `<p>Hello <b>${username}</b>,</p><p>Click <a href="${verifyLink}">here</a> to verify your account.</p><p>This link is valid for 24 hours.</p>`
        },
        tr: {
          subject: 'E-posta Doğrulama',
          html: `<p>Merhaba <b>${username}</b>,</p><p>Hesabını doğrulamak için <a href="${verifyLink}">buraya tıkla</a>.</p><p>Bağlantı 24 saat geçerlidir.</p>`
        },
        it: {
          subject: 'Verifica Email',
          html: `<p>Ciao <b>${username}</b>,</p><p>Clicca <a href="${verifyLink}">qui</a> per verificare il tuo account.</p><p>Il link è valido per 24 ore.</p>`
        }
      };
      const _vc = _verifyContent[lang] || _verifyContent.en;
      const defaultHtml = _vc.html;
      const subject = _vc.subject;

      // Read optional custom HTML from file (e.g. terms & conditions)
      let customHtml = '';
      const customFile = process.env.VERIFY_EMAIL_TEXT;
      if (customFile) {
        try {
          const filePath = path.join(__dirname, 'public', customFile);
          if (fs.existsSync(filePath)) {
            let raw = fs.readFileSync(filePath, 'utf8');
            // Replace placeholders
            const logoUrl = process.env.SITE_LOGO_URL || '';
            if (logoUrl) {
              const fullLogo = logoUrl.startsWith('http') ? logoUrl : `${req.protocol}://${req.get('host')}${logoUrl}`;
              raw = raw.replace(/\{\{SITE_LOGO_URL\}\}/g, fullLogo);
            }
            customHtml = raw;
          }
        } catch (e) {
          console.warn('[register] custom email text error:', e.message);
        }
      }

      await transporter.sendMail({
        from: MAIL_FROM,
        to: email,
        subject,
        html: defaultHtml + customHtml,
      });
    } catch (mailErr) {
      console.error('[register] mail send error:', mailErr);
      return res.status(500).json({
        error: 'eposta_gonderilemedi',
        message: getErrorMessage(req, 'eposta_gonderilemedi'),
      });
    }

    return res.json({
      ok: true,
      message: 'dogrulama_epostasi_gonderildi',
      user: { id: ins.rows[0].id, username },
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('register error:', e);
    if (e.code === 'P0001' || e.code === 'P0002') return res.status(400).json({ error: 'gecersiz', message: e.message });
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  } finally {
    try { await client.query(`SELECT set_config('app.password_plain', NULL, true)`); } catch {}
    client.release();
  }
});

app.get('/api/auth/verify', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).send('Geçersiz bağlantı.');
  try {
    const { rows } = await pool.query('SELECT id, verify_expires FROM users WHERE verify_token=$1', [token]);
    if (!rows.length) return res.status(400).send('Invalid or used link.');
    if (new Date(rows[0].verify_expires) < new Date()) return res.status(400).send('Link has expired.');

    await pool.query('UPDATE users SET email_verified=true, is_verified=true, verify_token=null, verify_expires=null, registration_date=NOW() WHERE id=$1', [
      rows[0].id,
    ]);
    res.send('Email verified. You can now log in.');
  } catch (e) {
    console.error('verify error:', e);
    res.status(500).send('Sunucu hatası.');
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { usernameOrEmail, password, totp } = req.body || {};
  if (!usernameOrEmail || !password)
    return res.status(400).json({ error: 'eksik_bilgi', message: getErrorMessage(req, 'eksik_bilgi') });

  try {
    const input = norm(usernameOrEmail);
    const { rows } = await pool.query(
      `SELECT id, username, password_hash, role, email, email_verified,
              two_factor_enabled, two_factor_secret, two_factor_norm_hash,
              COALESCE(is_active,true) AS is_active
       FROM users
       WHERE (lower(btrim(username))=lower($1) OR lower(btrim(email))=lower($1))
       ORDER BY id DESC
       LIMIT 25`,
      [input]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'accountNotFound', message: getErrorMessage(req, 'accountNotFound') });
    }

    // Şirket kullanıcıları şirket bazında benzersiz olduğundan aynı kullanıcı adı / e-posta
    // birden fazla hesaba ait olabilir. Doğru hesap ŞİFRE ile (gerekirse TOTP ile) seçilir.
    const activeRows = rows.filter(r => r.is_active);
    if (!activeRows.length) return res.status(403).json({ error: 'kullanici_pasif', message: getErrorMessage(req, 'kullanici_pasif') });

    const pwMatches = [];
    for (const cand of activeRows) {
      try { if (await bcrypt.compare(password, cand.password_hash || '')) pwMatches.push(cand); } catch {}
    }
    if (!pwMatches.length) return res.status(401).json({ error: 'wrongPassword', message: getErrorMessage(req, 'wrongPassword') });

    let u = pwMatches[0];
    if (pwMatches.length > 1 && totp) {
      // Aynı ad + aynı şifreli birden fazla hesap: TOTP'yi doğrulayan hesabı seç
      const tokenTry = String(totp).replace(/\s+/g, '');
      for (const cand of pwMatches) {
        try {
          if (!cand.two_factor_secret) continue;
          const sec = padBase32(normalizeBase32(decSecret(String(cand.two_factor_secret))));
          if (sec && speakeasy.totp.verify({ secret: sec, encoding: 'base32', token: tokenTry, digits: 6, step: 30, window: 2 })) { u = cand; break; }
        } catch {}
      }
    }
    if (!u.email_verified) return res.status(403).json({ error: 'emailNotVerified', message: getErrorMessage(req, 'emailNotVerified') });

    if (u.two_factor_enabled) {
      if (!u.two_factor_secret) return res.status(401).json({ error: 'totp_gerekli', message: getErrorMessage(req, 'totp_gerekli') });
      if (!totp) return res.status(401).json({ error: 'totp_gerekli', message: getErrorMessage(req, 'totp_gerekli') });

      const secretPlain = decSecret(String(u.two_factor_secret));
      const secretNorm = normalizeBase32(secretPlain);
      const secretB32 = padBase32(secretNorm);
      const tokenNorm = String(totp).replace(/\s+/g, '');

      const verified = !!secretB32 && speakeasy.totp.verify({
        secret: secretB32,
        encoding: 'base32',
        token: tokenNorm,
        digits: 6,
        step: 30,
        window: 2,
      });

      if (!verified) return res.status(401).json({ error: 'totp_gecersiz', message: getErrorMessage(req, 'totp_gecersiz') });

      if (u.two_factor_secret && !String(u.two_factor_secret).startsWith('enc:v1:')) {
        const enc = encSecret(secretNorm);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.bypass_totp_check','1',true)`);
          await client.query('UPDATE users SET two_factor_secret=$1, two_factor_enabled=TRUE WHERE id=$2', [enc, u.id]);
          await client.query('COMMIT');
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch {}
          console.error('login-side totp encrypt error:', e);
        } finally {
          client.release();
        }
      }
    }

    const token = signToken(u);
    const homePath = (u.role === 'admin' || u.role === 'supervisor') ? '/admin' : '/';

    return res.json({
      ok: true,
      token,
      token_type: 'Bearer',
      home_path: homePath,
      user: { id: u.id, username: u.username, role: u.role, email: u.email }
    });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});

app.post('/api/auth/remember', requireAuth, async (_req, res) => {
  return res.status(410).json({ ok: false, removed: true, message: 'remember_kaldirildi' });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { ...cookieOpts(0, req) });
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, me: req.user });
});

/* ===================== ŞİFREMİ UNUTTUM ===================== */
function generateResetCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

app.post('/api/auth/forgot/start', async (req, res) => {
  const email = norm(req.body?.email);
  if (!email) return res.status(400).json({ error: 'eksik_bilgi', message: getErrorMessage(req, 'eksik_bilgi') });

  try {
    const { rows } = await pool.query(
      'SELECT id, username, email, COALESCE(is_active,true) AS is_active FROM users WHERE lower(btrim(email))=lower($1) AND role IS DISTINCT FROM \'company\' ORDER BY id LIMIT 1',
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: 'accountNotFound',
        message: getErrorMessage(req, 'accountNotFound'),
      });
    }

    const u = rows[0];

    if (!u.is_active) {
      return res.status(403).json({
        error: 'kullanici_pasif',
        message: getErrorMessage(req, 'kullanici_pasif'),
      });
    }

    const code = generateResetCode();
    const expires = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query('UPDATE users SET reset_code=$1, reset_expires=$2 WHERE id=$3', [code, expires, u.id]);

    if (transporter) {
      try {
        const resetLang = _detectLang(req);
        const _resetContent = {
          en: {
            subject: 'Password Reset Code',
            html: `<p>Hello <b>${u.username}</b>,</p><p>Your password reset code is: <b>${code}</b></p><p>The code is valid for <b>5 minutes</b>.</p>`
          },
          tr: {
            subject: 'Parola Sıfırlama Kodu',
            html: `<p>Merhaba <b>${u.username}</b>,</p><p>Parola sıfırlama kodunuz: <b>${code}</b></p><p>Kod <b>5 dakika</b> boyunca geçerlidir.</p>`
          },
          it: {
            subject: 'Codice di Reset Password',
            html: `<p>Ciao <b>${u.username}</b>,</p><p>Il tuo codice di reset della password è: <b>${code}</b></p><p>Il codice è valido per <b>5 minuti</b>.</p>`
          }
        };
        const _rc = _resetContent[resetLang] || _resetContent.en;
        await transporter.sendMail({
          from: MAIL_FROM,
          to: u.email,
          subject: _rc.subject,
          html: _rc.html,
        });
      } catch (e) {
        console.error('reset mail error:', e);
        return res.status(500).json({ error: 'eposta_gonderilemedi', message: getErrorMessage(req, 'eposta_gonderilemedi') });
      }
    }

    res.json({ ok: true, message: 'Kod gönderildi.' });
  } catch (e) {
    console.error('forgot/start error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});

app.post('/api/auth/forgot/verify', async (req, res) => {
  const email = norm(req.body?.email);
  const code = norm(req.body?.code);
  if (!email || !code) return res.status(400).json({ error: 'eksik_bilgi', message: getErrorMessage(req, 'eksik_bilgi') });
  try {
    const { rows } = await pool.query('SELECT id, reset_code, reset_expires FROM users WHERE lower(btrim(email))=lower($1) AND role IS DISTINCT FROM \'company\' ORDER BY id LIMIT 1', [email]);
    if (!rows.length) return res.status(404).json({ error: 'accountNotFound', message: getErrorMessage(req, 'accountNotFound') });

    const u = rows[0];
    if (!u.reset_code || !u.reset_expires || new Date(u.reset_expires) < new Date()) {
      return res.status(400).json({ error: 'codeExpired', message: getErrorMessage(req, 'codeExpired') });
    }
    if (String(u.reset_code) !== String(code)) {
      return res.status(400).json({ error: 'invalidCode', message: getErrorMessage(req, 'invalidCode') });
    }
    res.json({ ok: true, verified: true });
  } catch (e) {
    console.error('forgot/verify error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});

app.post('/api/auth/forgot/reset', async (req, res) => {
  const email = norm(req.body?.email);
  const code = norm(req.body?.code);
  const newPw = req.body?.new_password;
  const newPw2 = req.body?.new_password_confirm;

  if (!email || !code || !newPw || !newPw2) {
    return res.status(400).json({ error: 'eksik_bilgi', message: getErrorMessage(req, 'eksik_bilgi') });
  }
  if (newPw !== newPw2) {
    return res.status(400).json({ error: 'sifre_eslesmiyor', message: getErrorMessage(req, 'sifre_eslesmiyor') });
  }
  if (!isStrongPassword(newPw)) {
    return res.status(400).json({
      error: 'zayif_sifre',
      message: getErrorMessage(req, 'zayif_sifre')
    });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT id, reset_code, reset_expires FROM users WHERE lower(btrim(email))=lower($1) AND role IS DISTINCT FROM \'company\' ORDER BY id LIMIT 1',
      [email]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'accountNotFound', message: getErrorMessage(req, 'accountNotFound') });
    }

    const u = rows[0];
    if (!u.reset_code || !u.reset_expires || new Date(u.reset_expires) < new Date()) {
      return res.status(400).json({ error: 'codeExpired', message: getErrorMessage(req, 'codeExpired') });
    }
    if (String(u.reset_code) !== String(code)) {
      return res.status(400).json({ error: 'invalidCode', message: getErrorMessage(req, 'invalidCode') });
    }

    await client.query('BEGIN');

    await client.query(`SELECT set_config('app.password_plain', $1, true)`, [newPw]);

    await client.query(
      `DO $blk$
       BEGIN
         PERFORM app_api._check_password_policy(current_setting('app.password_plain', true));
       END
       $blk$;`
    );

    await client.query(
      `UPDATE users
         SET password_hash = crypt(current_setting('app.password_plain', true), gen_salt('bf',10)),
             reset_code    = NULL,
             reset_expires = NULL
       WHERE id = $1`,
      [u.id]
    );

    await client.query('COMMIT');

    return res.json({ ok: true, message: 'Şifrenizi sıfırladınız. Giriş yapabilirsiniz.' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    if (e && (e.code === 'P0001' || e.code === 'P0002')) {
      return res.status(400).json({ error: 'gecersiz', message: e.message });
    }
    console.error('forgot/reset error:', e);
    return res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  } finally {
    try { await client.query(`SELECT set_config('app.password_plain', NULL, true)`); } catch {}
    client.release();
  }
});


/* ===================== Public  ===================== */
// Giriş yapılmamış (public/login) ekranın Layers panelinde kullanılır: sadece
// AKTİF ve PUBLIC (herkese açık) olay türlerini döner, kimlik doğrulama
// gerektirmez. Kimliği doğrulanmış kullanıcı/süpervizör/admin ekranlarında bunun
// yerine aşağıdaki /api/event_types (tüm aktif türler, public/private ayrımı
// olmadan) kullanılır.
app.get('/api/public/event_types', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT event_type_id, event_type_name, "public_" AS "public",
             is_point, is_line, is_polygon,
             COALESCE(time_dependent, false) AS time_dependent, valid_time
      FROM event_type
      WHERE COALESCE(active,true)=true AND COALESCE("public_",false)=true
      ORDER BY event_type_id
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/public/event_types error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});

app.get('/api/event_types', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT event_type_id, event_type_name, "public_" AS "public", created_by_id, created_by_name,
             is_point, is_line, is_polygon,
             COALESCE(time_dependent, false) AS time_dependent, valid_time
      FROM event_type 
      WHERE COALESCE(active,true)=true 
      ORDER BY event_type_id
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/event_types error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});

app.get('/api/events_all', tryAuth, async (req, res) => {
  const isAnon = !req.user;

  if (isAnon) {
    const showGood = SHOW_GOOD_EVENTS_ON_LOGIN;
    const showBad = SHOW_BAD_EVENTS_ON_LOGIN;
    
    
    if (!showGood && !showBad) {
      return res.status(401).json({ error: 'unauthenticated', message: getErrorMessage(req, 'unauthenticated') });
    }
  }

  try {
    // Deactivate any time-dependent events whose lifetime has elapsed so they
    // dynamically disappear from the map and the query below (active=true only).
    await deactivateExpiredEvents();

    const myId = req.user?.id || 0;
    const myUser = req.user?.username || '';
    
    const r = await pool.query(
      `
      SELECT
        o.event_id,
        o.latitude,
        o.longitude,
        o.event_type AS event_type_id,
        l.event_type_name     AS event_type_name,
        l."public_"      AS event_type_public,
        COALESCE(l.time_dependent, false) AS event_type_time_dependent,
        l.valid_time          AS event_type_valid_time,
        o.description,
        o.created_by_id              AS created_by_id,
        o.created_by_name            AS created_by_username,
        o.created_by_role_name       AS created_by_role_name,
        o.created_at,
        o.updated_by_name,
        o.updated_by_role_name,
        o.photo_urls,
        o.video_urls,
        COALESCE(o.num_agrees, 0) AS num_agrees,
        (COALESCE(o.agreed_ids, '[]'::jsonb) @> to_jsonb($3::int)) AS i_agreed,
        ${POLYGON_PKS.map(p => `o."${p.safeName}"`).join(',\n        ')}${POLYGON_PKS.length > 0 ? ',' : ''}
        ((o.created_by_id = $1) OR (o.created_by_name = $2)) AS is_mine
      FROM event o
      LEFT JOIN event_type l ON l.event_type_id = o.event_type
      WHERE COALESCE(o.active, true) = true
      ORDER BY o.event_id DESC
      `,
      [myId, myUser, myId]
    );

    let rows = r.rows.map((row) => {
      const mapped = {
        ...row,
        photo_urls: parseJsonText(row.photo_urls),
        video_urls: parseJsonText(row.video_urls),
      };
      // Add dynamic PK values
      for (const p of POLYGON_PKS) {
        mapped[p.name] = row[p.safeName] ?? null;
      }
      return mapped;
    });

    if (isAnon) {
      const showGood = SHOW_GOOD_EVENTS_ON_LOGIN;
      const showBad = SHOW_BAD_EVENTS_ON_LOGIN;
      
      rows = rows.filter(row => {
        const isGood = row.event_type_public === true || row.event_type_public === 'true' || row.event_type_public === 1;
        
        if (showGood && showBad) return true; 
        if (showGood && isGood) return true;  
        if (showBad && !isGood) return true;  
        return false;
      });
      
      rows = rows.map((row) => ({
        ...row,
        created_by_id: null,
        created_by_username: null,
        updated_by_name: null,
        updated_by_role_name: null,
        is_mine: false,
      }));
      
    }

    res.json(rows);
  } catch (e) {
    console.error('GET /api/events_all error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});

/* =============== Beğeni (Like) toggle ===============
   Yalnızca 'user' rolündeki hesaplar (olay ekleyen + solver) beğenebilir.
   Aynı kullanıcı tekrar isterse beğeniyi geri alır (toggle).
   num_agrees ve agreed_ids dinamik güncellenir; gönderi sahibinin puanı yeniden hesaplanır. */
app.post('/api/event/:id/agree', requireAuth, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'agree_only_users', message: getErrorMessage(req, 'agree_only_users') });
  }

  const uid = req.user.id;
  // BUFFER_RADIUS tanımlıysa katılım (agree) yalnızca kullanıcının konumunun bu
  // yarıçap içinde olduğu noktalar için yapılabilir. Konum istemciden gelir.
  const bLat = Number(req.body?.lat), bLng = Number(req.body?.lng);
  const hasLoc = Number.isFinite(bLat) && Number.isFinite(bLng) && Math.abs(bLat) <= 90 && Math.abs(bLng) <= 180;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT event_id, created_by_id, COALESCE(num_agrees,0) AS num_agrees,
              COALESCE(agreed_ids,'[]'::jsonb) AS agreed_ids,
              CASE WHEN $2::float8 IS NULL OR geom IS NULL THEN NULL
                   ELSE ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326)::geography)
              END AS dist_m
         FROM event
        WHERE event_id=$1 AND COALESCE(active,true)=true
        FOR UPDATE`,
      [id, hasLoc ? bLat : null, hasLoc ? bLng : null]
    );
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    }

    // Kullanıcı kendi eklediği gönderiyi beğenemez.
    if (cur.rows[0].created_by_id != null && Number(cur.rows[0].created_by_id) === Number(uid)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'cannot_agree_own', message: getErrorMessage(req, 'cannot_agree_own') });
    }

    let ids = [];
    try { ids = Array.isArray(cur.rows[0].agreed_ids) ? cur.rows[0].agreed_ids.map(Number) : JSON.parse(cur.rows[0].agreed_ids).map(Number); } catch { ids = []; }
    const already = ids.includes(uid);

    // Tampon kontrolü (yalnızca yeni katılımda; GPS sapması için küçük bir pay bırakılır)
    if (!already && BUFFER_RADIUS > 0) {
      const dist = cur.rows[0].dist_m;
      if (dist == null || Number(dist) > BUFFER_RADIUS + 5) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'agree_out_of_range', message: getErrorMessage(req, 'agree_out_of_range') });
      }
    }
    let agreed;
    if (already) {
      ids = ids.filter(x => x !== uid);
      agreed = false;
    } else {
      ids.push(uid);
      agreed = true;
    }
    const newCount = ids.length;

    // YENİ bir katılımda son katılım tarihi güncellenir → zamana bağlı olayın ömrü,
    // bağlı olduğu olay türünün süresi kadar bu tarihten itibaren yeniden başlar.
    // Katılım geri alındığında tarih DEĞİŞMEZ (süre kısalmaz), created_at ise hiç değişmez.
    if (agreed) {
      await client.query(
        `UPDATE event SET num_agrees=$2, agreed_ids=$3::jsonb, last_agreed_date=now() WHERE event_id=$1`,
        [id, newCount, JSON.stringify(ids)]
      );
    } else {
      await client.query(
        `UPDATE event SET num_agrees=$2, agreed_ids=$3::jsonb WHERE event_id=$1`,
        [id, newCount, JSON.stringify(ids)]
      );
    }
    await client.query('COMMIT');

    // Gönderi sahibinin puanını güncelle
    try { await recomputeUserStats(cur.rows[0].created_by_id); } catch {}
    // Katılan kullanıcının kendi puanı da güncellenir (her katılım +1 puan)
    try { if (uid !== cur.rows[0].created_by_id) await recomputeUserStats(uid); } catch {}

    res.json({ ok: true, event_id: id, num_agrees: newCount, agreed });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /api/event/:id/agree error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  } finally {
    client.release();
  }
});


/* ===================== Basit ZIP yazıcı (bağımlılık yok) =====================
   Kullanıcının kendi verisini (GeoJSON + photos/ + videos/) tek dosyada
   indirebilmesi için "store" (sıkıştırmasız) ZIP üretir. Fotoğraf/video zaten
   sıkıştırılmış formatlarda olduğundan sıkıştırma kaybı önemsizdir. */
const _CRC32_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function _crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = _CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function _dosDateTime(d) {
  const dt = (d instanceof Date && !isNaN(d)) ? d : new Date();
  const time = ((dt.getHours() & 0x1f) << 11) | ((dt.getMinutes() & 0x3f) << 5) | ((dt.getSeconds() / 2) & 0x1f);
  const date = (((dt.getFullYear() - 1980) & 0x7f) << 9) | (((dt.getMonth() + 1) & 0x0f) << 5) | (dt.getDate() & 0x1f);
  return { time, date };
}
// entries: [{ name: 'photos/a.jpg', data: Buffer, mtime?: Date, dir?: true }]
function buildZipBuffer(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.dir ? (e.name.endsWith('/') ? e.name : e.name + '/') : e.name, 'utf8');
    const data = e.dir ? Buffer.alloc(0) : (Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || ''));
    const crc = _crc32(data);
    const { time, date } = _dosDateTime(e.mtime);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // UTF-8 dosya adı bayrağı
    lh.writeUInt16LE(0, 8);             // method: store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(e.dir ? 0x10 : 0, 38);   // external attrs: klasör bayrağı
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

/* =============== Profil: istatistikler =============== */
/* ===================== LİDERLİK TABLOSU (LEADERBOARD) =====================
   Rol ayrımı yapmadan (opener + solver) olay ekleyen 'user' hesapları arasında
   KAZANILAN puana (users.posts_point) göre sıralama. Harcanan puan (QR indirimi)
   sıralamayı düşürmez; liderlik tablosu kazanılan puanı gösterir.
   Giriş yapılmışsa kullanıcının kendi sırası ve puanı da döner. */
app.get('/api/leaderboard', tryAuth, async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = 10;
    if (limit > 50) limit = 50;

    const top = await pool.query(
      `SELECT username, COALESCE(posts_point,0)::int AS points
         FROM public.users
        WHERE role='user' AND COALESCE(is_active,true)=true AND username IS NOT NULL
        ORDER BY COALESCE(posts_point,0) DESC, lower(btrim(username)) ASC
        LIMIT $1`,
      [limit]
    );
    const entries = top.rows.map((r, i) => ({ rank: i + 1, username: r.username, points: r.points }));

    let me = null;
    if (req.user && req.user.role === 'user') {
      const mine = await pool.query(
        `SELECT username, COALESCE(posts_point,0)::int AS points FROM public.users WHERE id=$1`,
        [req.user.id]
      );
      if (mine.rowCount) {
        const u = mine.rows[0];
        const rk = await pool.query(
          `SELECT COUNT(*)::int + 1 AS rank
             FROM public.users
            WHERE role='user' AND COALESCE(is_active,true)=true AND username IS NOT NULL
              AND (COALESCE(posts_point,0) > $1
                   OR (COALESCE(posts_point,0) = $1 AND lower(btrim(username)) < lower(btrim($2))))`,
          [u.points, u.username]
        );
        me = { rank: rk.rows[0].rank, username: u.username, points: u.points };
      }
    }

    res.json({ ok: true, limit, entries, me });
  } catch (e) {
    console.error('GET /api/leaderboard error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.get('/api/me/stats', requireAuth, async (req, res) => {
  try {
    // En güncel değerler için önce yeniden hesapla (olay ekleyen kullanıcılar için)
    if (req.user.role === 'user' && req.user.solver !== true) {
      try { await recomputeUserStats(req.user.id); } catch {}
    }
    const { rows } = await pool.query(
      `SELECT username, name, surname, role, COALESCE(solver,false) AS solver,
              COALESCE(num_events,0) AS num_events,
              COALESCE(agreed_point,0) AS agreed_point,
              COALESCE(posts_point,0) AS posts_point
         FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });

    const u = rows[0];
    // Sipariş harcaması: profildeki gösterilen puan = posts_point − Σ orders.points_spent
    // (Her başarılı siparişte eşik puan kadar düşer; kazandıkça posts_point artar.)
    let spent = 0;
    try {
      const t = await pool.query(`SELECT to_regclass('public.orders') AS t`);
      if (t.rows[0].t) {
        const s = await pool.query(`SELECT COALESCE(SUM(points_spent),0)::int AS s FROM public.orders WHERE person_placing_order=$1`, [u.username]);
        spent = s.rows[0].s || 0;
      }
    } catch {}
    const effectivePosts = Math.max(0, (u.posts_point || 0) - spent);
    // Solver için "silinen olay" sayısını da hesapla (kendi kapattıkları)
    let closed_count = 0;
    if (u.solver === true) {
      const c = await pool.query(`SELECT COUNT(*)::int AS c FROM event WHERE deactivated_by_id=$1`, [req.user.id]);
      closed_count = c.rows[0].c;
    }
    res.json({
      username: u.username,
      name: u.name || '',
      surname: u.surname || '',
      role: u.role,
      solver: u.solver === true,
      num_events: u.num_events,
      agreed_point: u.agreed_point,
      posts_point: effectivePosts,
      closed_count
    });
  } catch (e) {
    console.error('GET /api/me/stats error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

/* =============== Profil: gönderilerim / sildiklerim ===============
   Olay ekleyen kullanıcı  -> kendi eklediği olaylar (aktif + deaktif)
   Solver (olay kapatan)    -> kendi kapattığı (deactivated_by_id) olaylar */
app.get('/api/me/posts', requireAuth, async (req, res) => {
  try {
    const isSolver = (req.user.role === 'user' && req.user.solver === true);
    const whereClause = isSolver ? `o.deactivated_by_id = $1` : `o.created_by_id = $1`;
    const r = await pool.query(
      `SELECT
         o.event_id, o.latitude, o.longitude,
         o.event_type AS event_type_id,
         l.event_type_name AS event_type_name,
         COALESCE(l.time_dependent,false) AS event_type_time_dependent,
         o.description,
         o.created_at,
         o.deactivated_at,
         COALESCE(o.active,true) AS active,
         COALESCE(o.num_agrees,0) AS num_agrees,
         (COALESCE(o.agreed_ids,'[]'::jsonb) @> to_jsonb($1::int)) AS i_agreed,
         o.created_by_id,
         o.created_by_name AS created_by_username,
         o.created_by_role_name AS created_by_role_name,
         o.photo_urls, o.video_urls,
         ((o.created_by_id = $1)) AS is_mine
       FROM event o
       LEFT JOIN event_type l ON l.event_type_id = o.event_type
       WHERE ${whereClause}
       ORDER BY COALESCE(o.deactivated_at, o.created_at) DESC NULLS LAST, o.event_id DESC`,
      [req.user.id]
    );
    const rows = r.rows.map(row => ({
      ...row,
      photo_urls: parseJsonText(row.photo_urls),
      video_urls: parseJsonText(row.video_urls),
    }));
    res.json({ solver: isSolver, posts: rows });
  } catch (e) {
    console.error('GET /api/me/posts error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});


/* =============== Profil: kendi verimi indir (ZIP) ===============
   Olay ekleyen (opener) kullanıcı, kendi eklediği noktaları GeoJSON olarak ve
   bu noktalara eklediği fotoğraf/videoları photos/ ve videos/ klasörlerinde
   (uploads'taki dosya adlarıyla) tek bir ZIP dosyasında indirir. */
app.get('/api/me/export', requireAuth, async (req, res) => {
  try {
    // Hem opener hem solver kendi eklediği verileri indirebilir
    if (req.user.role !== 'user') {
      return res.status(403).json({ error: 'yetkisiz', message: getErrorMessage(req, 'yetkisiz') });
    }

    const { rows } = await pool.query(
      `SELECT o.event_id,
              o.latitude,
              o.longitude,
              l.event_type_name              AS event_type_name,
              o.description,
              ST_AsGeoJSON(o.geom)           AS geom_json,
              COALESCE(o.active, true)       AS active,
              o.deactivated_by_name,
              o.deactivated_at,
              o.created_at,
              o.photo_urls,
              o.video_urls,
              COALESCE(o.num_agrees, 0)      AS num_agrees,
              COALESCE(o.agreed_ids, '[]'::jsonb) AS agreed_ids
         FROM event o
         LEFT JOIN event_type l ON l.event_type_id = o.event_type
        WHERE o.created_by_id = $1
        ORDER BY o.event_id`,
      [req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'olay_yok', message: getErrorMessage(req, 'olay_yok') });
    }

    const photoFiles = new Map(); // dosya adı -> mutlak yol (tekrarlar tek kez)
    const videoFiles = new Map();
    const collect = (raw, bucket) => {
      let list = [];
      try { list = JSON.parse(String(raw || '[]')); } catch { list = []; }
      if (!Array.isArray(list)) list = [];
      const out = [];
      for (const u of list) {
        const name = path.basename(String(u || ''));
        if (!name) continue;
        out.push(name);
        const abs = path.join(UPLOAD_DIR, name);
        if (!abs.startsWith(UPLOAD_DIR)) continue;
        if (_fileExists(abs)) bucket.set(name, abs);
      }
      return out;
    };

    const features = rows.map((r) => {
      const photos = collect(r.photo_urls, photoFiles);
      const videos = collect(r.video_urls, videoFiles);
      let geometry = null;
      try { geometry = r.geom_json ? JSON.parse(r.geom_json) : null; } catch { geometry = null; }
      if (!geometry && Number.isFinite(parseFloat(r.longitude)) && Number.isFinite(parseFloat(r.latitude))) {
        geometry = { type: 'Point', coordinates: [parseFloat(r.longitude), parseFloat(r.latitude)] };
      }
      return {
        type: 'Feature',
        geometry,
        properties: {
          event_id: r.event_id,
          latitude: r.latitude != null ? parseFloat(r.latitude) : null,
          longitude: r.longitude != null ? parseFloat(r.longitude) : null,
          event_type: r.event_type_name || null,   // ham ID değil, okunabilir tür adı
          description: r.description ?? null,
          active: r.active === true,
          deactivated_by_name: r.deactivated_by_name ?? null,
          deactivated_at: r.deactivated_at ?? null,
          created_at: r.created_at ?? null,
          photo_urls: photos,                      // ZIP içindeki photos/ dosya adları
          video_urls: videos,                      // ZIP içindeki videos/ dosya adları
          num_agrees: r.num_agrees,
          agreed_ids: r.agreed_ids
        }
      };
    });

    const geojson = {
      type: 'FeatureCollection',
      features,
      metadata: {
        username: req.user.username,
        total_events: features.length,
        export_date: new Date().toISOString()
      }
    };

    const entries = [
      { name: 'events.geojson', data: Buffer.from(JSON.stringify(geojson, null, 2), 'utf8') },
      { name: 'photos/', dir: true },
      { name: 'videos/', dir: true }
    ];
    for (const [name, abs] of photoFiles) {
      try { entries.push({ name: `photos/${name}`, data: fs.readFileSync(abs), mtime: fs.statSync(abs).mtime }); } catch {}
    }
    for (const [name, abs] of videoFiles) {
      try { entries.push({ name: `videos/${name}`, data: fs.readFileSync(abs), mtime: fs.statSync(abs).mtime }); } catch {}
    }

    const zip = buildZipBuffer(entries);
    const safeUser = String(req.user.username || 'user').replace(/[^a-zA-Z0-9_.-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="my_events_${safeUser}_${Date.now()}.zip"`);
    res.setHeader('Content-Length', String(zip.length));
    return res.end(zip);
  } catch (e) {
    console.error('GET /api/me/export error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

/* =============== Sınır (boundary) — yalnızca giriş yapınca =============== */
app.get('/api/boundary', async (req, res) => {
  try {
    if (!BOUNDARY_MODE) return res.json({ enabled: false });

    if (BOUNDARY_MODE === 'file') {
      return res.json({ enabled: true, source: 'file', geojson: BOUNDARY_GEOJSON });
    }

    // aggregation: birleşik (dissolve) sınırı GeoJSON olarak döndür
    const polyTable = assertSafeIdent(POLYGON_TABLE, 'table');
    const r = await pool.query(`SELECT ST_AsGeoJSON(ST_Union(geom)) AS gj FROM public.${polyTable}`);
    const gjStr = r.rows[0] && r.rows[0].gj;
    if (!gjStr) return res.json({ enabled: false });
    return res.json({
      enabled: true,
      source: 'aggregation',
      geojson: { type: 'Feature', properties: {}, geometry: JSON.parse(gjStr) }
    });
  } catch (e) {
    console.error('GET /api/boundary error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});



/* ===================== ROTALAMA (OSRM proxy + sınır kısıtı) =====================
   Güvenlik notları:
   - OSRM adresleri yalnızca sunucuda bilinir; tarayıcıya gönderilmez ve istemciden
     gelen hiçbir veri URL'in host kısmına giremez (SSRF yok). İstemciden yalnızca
     sayısal koordinatlar ve sabit bir mod anahtarı ('foot' | 'bike' | 'car') alınır.
   - Basit hız sınırı uygulanır (IP başına dakikada N istek).
   - docker-compose.yml içindeki OSRM portları yalnızca 127.0.0.1'e bağlanır. */

/* --- Rotalama servislerinin durumu + Docker ile otomatik başlatma --- */
let __osrmStatus = { foot: false, bike: false, car: false, checkedAt: 0 };

async function osrmPing(baseUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    // Rastgele bir koordinat çifti: servis ayakta değilse istek hata verir.
    const r = await fetch(`${baseUrl}/route/v1/driving/13.388,52.517;13.397,52.529?overview=false`, { signal: ctrl.signal });
    return r.ok || r.status === 400;   // 400 = servis ayakta, koordinat kapsam dışı
  } catch { return false; }
  finally { clearTimeout(timer); }
}

async function refreshOsrmStatus() {
  const [foot, bike, car] = await Promise.all([
    osrmPing(OSRM_URLS.foot), osrmPing(OSRM_URLS.bike), osrmPing(OSRM_URLS.car)
  ]);
  __osrmStatus = { foot, bike, car, checkedAt: Date.now() };
  return __osrmStatus;
}

// Docker açıksa rotalama konteynerlerini uygulamayla birlikte ayağa kaldırır.
// Sabit komut çalıştırılır; hiçbir kullanıcı girdisi komuta karışmaz.
// .env'de OSRM_AUTOSTART=false yazılarak kapatılabilir.
// Rotalama için gereken harita dosyası: case_study/<CASE_STUDY>/existing_data/map.osm(.pbf)
function osrmSourceMapFile() {
  const pbf = path.join(EXISTING_DATA_DIR, 'map.osm.pbf');
  const osm = path.join(EXISTING_DATA_DIR, 'map.osm');
  if (_fileExists(pbf)) return pbf;
  if (_fileExists(osm)) return osm;
  return null;
}

// map.osm / map.osm.pbf içinde gerçekten YOL verisi var mı? (Overpass'tan yalnızca
// sınır/bina indirildiyse OSRM boş bir graf üretir ve hiçbir rota çıkmaz.)
// XML (.osm) dosyalarında hızlıca 'k="highway"' aranır; .pbf ikili olduğu için atlanır.
function checkRoutingMapFile() {
  const file = osrmSourceMapFile();
  if (!file) return { ok: false, reason: 'missing' };
  if (file.endsWith('.pbf')) return { ok: true, reason: 'pbf', file };
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.statSync(file).size;
    const buf = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8');
    const hasHighway = head.includes('k="highway"');
    if (!hasHighway && size <= buf.length) return { ok: false, reason: 'no_highways', file, size };
    if (!hasHighway) {
      // Büyük dosyada baştaki 8 MB'ta yol yoksa büyük ihtimalle yol verisi yok; yine de engelleme
      return { ok: true, reason: 'unknown', file, size };
    }
    return { ok: true, reason: 'ok', file, size };
  } catch (e) {
    return { ok: true, reason: 'unreadable', file };
  }
}

function logRoutingMapStatus() {
  const st = checkRoutingMapFile();
  if (st.reason === 'missing') {
    console.warn(`[ROUTE] Map file not found: ${path.join(EXISTING_DATA_DIR, 'map.osm')} (or map.osm.pbf).`);
    console.warn('[ROUTE] Routing will not work until you place your OpenStreetMap export there.');
    return st;
  }
  if (st.reason === 'no_highways') {
    console.error('\n[ROUTE] WARNING: your map file contains NO ROAD DATA (no "highway" tags).');
    console.error(`[ROUTE]   File: ${st.file}`);
    console.error('[ROUTE]   It looks like a boundary/building export, so OSRM cannot build a road network');
    console.error('[ROUTE]   and NO ROUTE can ever be produced.');
    console.error('[ROUTE]   Export the ROADS of your area instead, e.g. with Overpass Turbo:');
    console.error('[ROUTE]     [out:xml][timeout:60];');
    console.error('[ROUTE]     (way["highway"]({{bbox}}););');
    console.error('[ROUTE]     (._;>;);');
    console.error('[ROUTE]     out body;');
    console.error('[ROUTE]   then Export > "raw OSM data" and save it as map.osm\n');
    return st;
  }
  console.log(`[ROUTE] Routing map source: ${st.file}`);
  return st;
}

function autoStartOsrmContainers() {
  if (String(process.env.OSRM_AUTOSTART || 'true').toLowerCase() === 'false') {
    console.log('[ROUTE] OSRM autostart disabled (OSRM_AUTOSTART=false).');
    return;
  }
  const composeFile = path.join(__dirname, 'docker-compose.yml');
  if (!_fileExists(composeFile)) {
    console.warn('[ROUTE] docker-compose.yml not found → routing containers not started.');
    return;
  }
  logRoutingMapStatus();
  const run = (args, cb) => execFile('docker', args, { cwd: __dirname, timeout: 120000 }, cb);
  run(['compose', 'version'], (err) => {
    if (err) {
      console.warn('[ROUTE] Docker (compose) not available → routing services will not start automatically.');
      console.warn('[ROUTE] Start Docker and run "docker compose up -d" in the project folder.');
      return;
    }
    console.log('[ROUTE] Starting OSRM routing containers (docker compose up -d) ...');
    run(['compose', 'up', '-d'], (e2, stdout, stderr) => {
      if (e2) {
        console.warn('[ROUTE] "docker compose up -d" failed:', (stderr || e2.message || '').toString().trim().split('\n').slice(-3).join(' | '));
        return;
      }
      console.log('[ROUTE] Routing containers are up. First run downloads and prepares map data; this can take a while.');
      setTimeout(() => { refreshOsrmStatus().then(st => console.log('[ROUTE] OSRM status:', st)); }, 8000);
    });
  });
}

/* --- Rotalama sınırı ---
   Ayrı bir veritabanı tablosu KULLANILMAZ. Sınır varsa (boundary.geojson → dide_boundary
   tablosu; aggregation layer varsa onun poligonları), bu sınır bir GeoJSON dosyasına
   yazılır:  case_study/<CASE_STUDY>/existing_data/.routing_boundary.geojson
   osrm-prepare bu dosyayı görürse map.osm.pbf'yi osmium ile bu sınırdan KESER ve yol
   ağını yalnızca sınırın içindeki yollardan kurar → rota sınır dışına hiç çıkamaz.
   Sınır yoksa dosya silinir ve map.osm.pbf'deki TÜM yol ağı kullanılır. */
function routingBoundaryFilePath() {
  return path.join(EXISTING_DATA_DIR, '.routing_boundary.geojson');
}

async function exportRoutingBoundary() {
  const file = routingBoundaryFilePath();
  const dropFile = (why) => {
    if (_fileExists(file)) { try { fs.unlinkSync(file); } catch {} }
    if (why) console.log(`[ROUTE] ${why}`);
  };

  if (!BOUNDARY_MODE) {
    dropFile('No boundary → routing uses the full road network.');
    return;
  }
  // Sınır zaten existing_data/boundary.geojson olarak duruyorsa EK BİR DOSYA ÜRETİLMEZ;
  // osrm-prepare yol ağını doğrudan o dosyaya göre keser.
  if (BOUNDARY_MODE === 'file') {
    dropFile('Boundary file found → osrm-prepare clips the road network with boundary.geojson (no extra file).');
    return;
  }
  // Aggregation layer modunda sınır yalnızca veritabanındadır; osmium'un kesebilmesi için
  // poligonlar bir GeoJSON dosyasına yazılır (rotalamanın sınırını da gösterir).
  const srcTable = (BOUNDARY_MODE === 'aggregation')
    ? assertSafeIdent(POLYGON_TABLE, 'table')
    : BOUNDARY_DB_TABLE;
  // Sınır, küçük bir toleransla genişletilir (sınıra teğet yollar kesilmesin) ve
  // osmium'un hızlı çalışması için sadeleştirilir.
  const r = await pool.query(
    `SELECT ST_AsGeoJSON(
              ST_SimplifyPreserveTopology(
                ST_Buffer(ST_Union(ST_MakeValid(geom))::geography, $1)::geometry,
                0.00005
              ), 7
            ) AS g
       FROM public.${srcTable}
      WHERE geom IS NOT NULL`,
    [ROUTE_BOUNDARY_TOLERANCE]
  );
  const g = r.rows[0] && r.rows[0].g;
  if (!g) { console.warn('[ROUTE] Boundary geometry is empty → routing uses the full road network.'); return; }
  const content = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { name: 'dide_routing_boundary' }, geometry: JSON.parse(g) }]
  });
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch {}
  if (old !== content) {
    fs.writeFileSync(file, content, 'utf8');
    console.log(`[ROUTE] Routing boundary written (${BOUNDARY_MODE}): ${file}`);
    console.log('[ROUTE] osrm-prepare will clip the road network to this boundary automatically.');
  } else {
    console.log('[ROUTE] Routing boundary unchanged.');
  }
}

// Basit hız sınırı: IP başına dakikada 40 rota isteği
const __routeHits = new Map();
function routeRateLimited(ip) {
  const now = Date.now();
  const rec = __routeHits.get(ip) || { n: 0, until: now + 60000 };
  if (now > rec.until) { rec.n = 0; rec.until = now + 60000; }
  rec.n++;
  __routeHits.set(ip, rec);
  if (__routeHits.size > 5000) { for (const [k, v] of __routeHits) if (now > v.until) __routeHits.delete(k); }
  return rec.n > 40;
}

async function osrmFetch(baseUrl, profile, from, to) {
  // Koordinatlar sayıya çevrilip sabit formatla yazılır → URL'e istemci metni girmez.
  const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const url = `${baseUrl}/route/v1/${profile}/${coords}` +
              `?alternatives=3&overview=full&geometries=geojson&steps=false&annotations=false`;
  // NOT: yanıttaki waypoints[].distance, verilen noktanın en yakın YOLA olan uzaklığıdır.
  // Çok büyükse nokta, rotalama haritasının kapsadığı alanın dışındadır.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { error: 'service' };
    const d = await r.json();
    if (!d || d.code !== 'Ok' || !Array.isArray(d.routes) || !d.routes.length) {
      return { error: (d && d.code === 'NoSegment') ? 'offmap' : 'noroute' };
    }
    return { routes: d.routes, waypoints: Array.isArray(d.waypoints) ? d.waypoints : [] };
  } catch (e) {
    return { error: 'service' };
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/route/status — profillerin durumu + harita dosyası teşhisi
// Tarayıcıdan açıp rotalamanın neden çalışmadığını görebilirsiniz.
app.get('/api/route/status', async (req, res) => {
  try {
    if (Date.now() - __osrmStatus.checkedAt > 20000) await refreshOsrmStatus();
    const mapCheck = checkRoutingMapFile();
    res.json({
      ok: true,
      services: { foot: __osrmStatus.foot, bike: __osrmStatus.bike, car: __osrmStatus.car },
      // geriye dönük uyumluluk
      foot: __osrmStatus.foot, bike: __osrmStatus.bike, car: __osrmStatus.car,
      map_file: mapCheck.file || null,
      map_ok: mapCheck.ok,
      map_reason: mapCheck.reason
    });
  } catch (e) {
    res.json({ ok: false, foot: false, bike: false, car: false });
  }
});

// POST /api/route  { mode: 'foot'|'bike'|'car', from:{lat,lng}, to:{lat,lng} }
app.post('/api/route', tryAuth, async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
    if (routeRateLimited(ip)) {
      return res.status(429).json({ error: 'rate_limited', message: getErrorMessage(req, 'rate_limited') });
    }

    const modeKey = String(req.body?.mode || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(OSRM_URLS, modeKey)) {
      return res.status(400).json({ error: 'gecersiz_istek', message: getErrorMessage(req, 'gecersiz_istek') });
    }

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
    const from = { lat: num(req.body?.from?.lat), lng: num(req.body?.from?.lng) };
    const to   = { lat: num(req.body?.to?.lat),   lng: num(req.body?.to?.lng) };
    const valid = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
                         p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
    if (!valid(from) || !valid(to)) {
      return res.status(400).json({ error: 'gecersiz_koordinat', message: getErrorMessage(req, 'gecersiz_koordinat') });
    }

    // Sınır varsa: başlangıç noktası (kullanıcının konumu) sınırın dışındaysa rota verilmez.
    if (BOUNDARY_MODE) {
      const insideStart = await isInsideBoundary(from.lng, from.lat);
      if (!insideStart) {
        return res.status(422).json({ error: 'route_start_outside', message: getErrorMessage(req, 'route_start_outside') });
      }
    }

    const profile = (modeKey === 'car') ? 'driving' : (modeKey === 'bike' ? 'cycling' : 'walking');
    const osrm = await osrmFetch(OSRM_URLS[modeKey], profile, from, to);
    if (osrm.error === 'service') {
      return res.status(503).json({ error: 'route_service_unavailable', message: getErrorMessage(req, 'route_service_unavailable') });
    }
    if (osrm.error === 'offmap') {
      return res.status(422).json({ error: 'route_off_map', message: getErrorMessage(req, 'route_off_map') });
    }
    if (osrm.error || !osrm.routes) {
      return res.status(404).json({ error: 'route_not_found', message: getErrorMessage(req, 'route_not_found') });
    }

    // Noktalar rotalama haritasının kapsadığı alanın dışındaysa OSRM onları çok uzaktaki
    // bir yola "yapıştırır". Böyle durumlarda anlamsız/sıfır uzunluklu rota yerine
    // kullanıcıya açık bir mesaj döndürülür.
    const maxSnap = Number(process.env.ROUTE_MAX_SNAP_DISTANCE || 500);
    const snaps = (osrm.waypoints || []).map(w => Number(w && w.distance)).filter(Number.isFinite);
    if (snaps.length && snaps.some(d => d > maxSnap)) {
      return res.status(422).json({
        error: 'route_off_map',
        message: getErrorMessage(req, 'route_off_map'),
        snap_distance: Math.round(Math.max(...snaps))
      });
    }

    // OSRM rotaları en kısa/optimum olandan başlayarak gelir. Sınır varsa yol ağı
    // zaten sınırdan kesilerek hazırlandığı için dönen her rota sınırın içindedir.
    for (const rt of osrm.routes) {
      const geom = rt && rt.geometry;
      if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates) || geom.coordinates.length < 2) continue;
      // Dejenere (sıfıra yakın) rota: başlangıç ve bitiş aynı yola yapışmış demektir
      if (!(Number(rt.distance) > 5)) continue;
      return res.json({
        ok: true,
        mode: modeKey,
        distance: Math.round(Number(rt.distance) || 0),
        duration: Math.round(Number(rt.duration) || 0),
        geometry: geom,
        arrival_threshold: ROUTE_ARRIVAL_THRESHOLD
      });
    }

    return res.status(404).json({ error: 'route_not_found', message: getErrorMessage(req, 'route_not_found') });
  } catch (e) {
    console.error('POST /api/route error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});

/* =============== QField: GeoJSON =============== */
app.get('/api/qfield/events', tryAuth, async (req, res) => {
  const ALLOW_PUBLIC_EVENTS = String(process.env.SHOW_EVENTS_ON_LOGIN || 'false') === 'true';
  const isAnon = !req.user;
  if (isAnon && !ALLOW_PUBLIC_EVENTS) {
    return res.status(401).json({ error: 'unauthenticated', message: getErrorMessage(req, 'unauthenticated') });
  }

  try {
    const r = await pool.query(`
      SELECT
        o.event_id,
        o.latitude, o.longitude,
        o.description,
        o.event_type,
        l.event_type_name AS event_type_name,
        o.photo_urls,
        o.video_urls,
        o.created_by_id,
        o.created_by_name
      FROM event o
      LEFT JOIN event_type l ON l.event_type_id = o.event_type
      WHERE COALESCE(o.active,true)=true
      ORDER BY o.event_id DESC
    `);

    const features = r.rows.map((row) => {
      const baseProps = {
        event_id: row.event_id,
        event_type_id: row.event_type,
        event_type_name: row.event_type_name,
        description: row.description,
        photo_urls: parseJsonText(row.photo_urls),
        video_urls: parseJsonText(row.video_urls),
      };
      const props = isAnon
        ? baseProps
        : { ...baseProps, created_by_id: row.created_by_id, created_by_username: row.created_by_name };

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [Number(row.longitude), Number(row.latitude)]
        },
        properties: props
      };
    });

    res.json({ type: 'FeatureCollection', features });
  } catch (e) {
    console.error('GET /api/qfield/events error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});


/* ===================== Olay Ekleme / Güncelleme (TEXT JSON) ===================== */
app.post('/api/submit_olay', requireAuth, async (req, res) => {
  try {
    // Solver (olay kapatan) kullanıcılar olay ekleyemez; yalnızca olay kapatabilir.
    if (req.user.role === 'user' && req.user.solver === true) {
      return res.status(403).json({ error: 'solver_cannot_add', message: getErrorMessage(req, 'solver_cannot_add') });
    }
    // İki gönderi arasındaki bekleme süresi (.env: EVENT_SUBMIT_INTERVAL_HOURS).
    // Boş/0 ise sınır yoktur. Yalnızca 'user' (olay ekleyen) hesapları için geçerlidir.
    if (req.user.role === 'user' && EVENT_SUBMIT_INTERVAL_HOURS > 0) {
      try {
        const last = await pool.query(
          `SELECT created_at FROM public.event
            WHERE created_by_id = $1 AND created_at IS NOT NULL
            ORDER BY created_at DESC LIMIT 1`,
          [req.user.id]
        );
        if (last.rowCount) {
          const lastAt = new Date(last.rows[0].created_at).getTime();
          const nextAt = lastAt + EVENT_SUBMIT_INTERVAL_HOURS * 3600 * 1000;
          const remainMs = nextAt - Date.now();
          if (Number.isFinite(remainMs) && remainMs > 0) {
            return res.status(429).json({
              error: 'submit_interval_wait',
              message: getErrorMessage(req, 'submit_interval_wait'),
              interval_hours: EVENT_SUBMIT_INTERVAL_HOURS,
              retry_after_seconds: Math.ceil(remainMs / 1000),
              next_allowed_at: new Date(nextAt).toISOString()
            });
          }
        }
      } catch (e) {
        console.error('[submit_olay] submit interval check error:', e.message);
      }
    }

    const { p_id, event_type, description, latitude, longitude } = req.body || {};
    const lat = parseFloat(latitude), lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      return res.status(400).json({ error: 'gecersiz_koordinat', message: getErrorMessage(req, 'gecersiz_koordinat') });

    // Sınır (file modu) kontrolü: sınır dışına veri eklenemez.
    // Aggregation modu zaten aşağıdaki polygon-PK mantığıyla kısıtlanır (mevcut davranış korunur).
    if (BOUNDARY_MODE === 'file') {
      const inside = await isInsideBoundary(lng, lat);
      if (!inside) {
        return res.status(403).json({ error: 'outside_boundary', message: getErrorMessage(req, 'outside_boundary') });
      }
    }

    let olayTuruId = null;
    if (event_type !== '' && event_type != null) {
      const asNum = parseInt(event_type, 10);
      if (!Number.isNaN(asNum)) {
        const t = await pool.query('SELECT 1 FROM event_type WHERE event_type_id=$1 AND COALESCE(active,true)=true', [asNum]);
        if (!t.rowCount) return res.status(400).json({ error: 'gecersiz_event_type', message: getErrorMessage(req, 'gecersiz_event_type') });
        olayTuruId = asNum;
      } else {
        const q = await pool.query('SELECT event_type_id FROM event_type WHERE event_type_name=$1 AND COALESCE(active,true)=true', [String(event_type)]);
        if (!q.rowCount) return res.status(400).json({ error: 'gecersiz_event_type', message: getErrorMessage(req, 'gecersiz_event_type') });
        olayTuruId = q.rows[0].event_type_id;
      }
    }

    const photoIncoming = req.body?.photo_urls ?? req.body?.photo ?? req.body?.photo_attachments ?? null;
    const videoIncoming = req.body?.video_urls ?? req.body?.video ?? req.body?.video_attachments ?? null;

    const photoUrls = normalizeIncomingToUrlArray(photoIncoming, 'photo');
    const videoUrls = normalizeIncomingToUrlArray(videoIncoming, 'video');

    // Build dynamic PK columns based on validated Primary_Keys
    let pkColumns = '';
    let pkPlaceholders = '';
    const pkVals = [];
    let pkIdx = 10; // next placeholder index after $9

    if (POLYGON_PKS.length > 0 && POLYGON_TABLE) {
      // Find which polygon contains this point and get its PK values
      const foundPkValues = {};
      try {
        const polyTable = assertSafeIdent(POLYGON_TABLE, 'table');
        const selectCols = POLYGON_PKS.map(p => p.safeName);
        const polyQ = `SELECT ${selectCols.join(', ')} FROM public.${polyTable} WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) LIMIT 1`;
        const polyR = await pool.query(polyQ, [lng, lat]);
        if (polyR.rows.length > 0) {
          for (const p of POLYGON_PKS) {
            foundPkValues[p.name] = polyR.rows[0][p.safeName];
          }
        }
      } catch (e) {
        console.warn('[submit_olay] polygon PK lookup error:', e.message);
      }

      for (const p of POLYGON_PKS) {
        pkColumns += `, "${p.safeName}"`;
        pkPlaceholders += `, $${pkIdx++}`;
        const val = foundPkValues[p.name];
        if (p.type === 'integer') {
          pkVals.push(val != null ? parseInt(val, 10) : null);
        } else {
          pkVals.push(val != null ? String(val) : null);
        }
      }
    }

    const ins = await pool.query(
      `INSERT INTO event (latitude, longitude, event_type, description, geom,
                         created_by_name, created_by_role_name, created_by_id, active,
                         photo_urls, video_urls, last_agreed_date${pkColumns})
       VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($2,$1),4326),
               $5, $6, $7, true,
               $8::text, $9::text, now()${pkPlaceholders})
       RETURNING event_id`,
      [lat, lng, olayTuruId, description ?? null, req.user.username, req.user.role, req.user.id, toJsonText(photoUrls), toJsonText(videoUrls), ...pkVals]
    );
    const event_id = ins.rows[0].event_id;

    const pId = p_id === '' || p_id == null ? null : parseInt(p_id, 10);
    if (Number.isInteger(pId)) await pool.query('INSERT INTO kayit (p_id, event_id) VALUES ($1,$2)', [pId, event_id]);

    // Yeni olay eklendi → ekleyen kullanıcının istatistiklerini güncelle
    try { await recomputeUserStats(req.user.id); } catch {}

    res.json({ success: true, event_id, photo_urls: photoUrls, video_urls: videoUrls });
  } catch (e) {
    console.error('submit_olay error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.patch('/api/event/:id', requireAuth, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });

  // Permission check: find who created this event
  try {
    const ownerCheck = await pool.query(
      `SELECT created_by_id, created_by_name, created_by_role_name FROM event WHERE event_id=$1 AND COALESCE(active,true)=true`,
      [id]
    );
    if (!ownerCheck.rowCount) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });

    const evt = ownerCheck.rows[0];
    const isMine = (evt.created_by_id === req.user.id) || (evt.created_by_name === req.user.username);
    const evtRole = evt.created_by_role_name || '';

    let allowed = false;
    if (req.user.role === 'admin') {
      allowed = true;
    } else if (req.user.role === 'user') {
      // Users can update own events + supervisor-created events
      allowed = isMine || evtRole === 'supervisor';
    } else if (req.user.role === 'supervisor') {
      // Supervisors can update own events + other supervisor events
      allowed = isMine || evtRole === 'supervisor';
    }

    if (!allowed) {
      return res.status(403).json({ error: 'yetkisiz', message: getErrorMessage(req, 'yetkisiz') });
    }
  } catch (e) {
    console.error('permission check error:', e);
    return res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }

  const { latitude, longitude, event_type, description } = req.body || {};
  const fields = [];
  const vals = [];
  let idx = 1;

  if (latitude != null) { fields.push(`latitude=$${idx++}`); vals.push(parseFloat(latitude)); }
  if (longitude != null) { fields.push(`longitude=$${idx++}`); vals.push(parseFloat(longitude)); }

  if (req.body?.photo_urls !== undefined || req.body?.photo !== undefined || req.body?.photo_attachments !== undefined) {
    const photoIncoming = req.body?.photo_urls ?? req.body?.photo ?? req.body?.photo_attachments ?? [];
    const photos = normalizeIncomingToUrlArray(photoIncoming, 'photo');
    fields.push(`photo_urls=$${idx++}::text`); vals.push(toJsonText(photos));
  }
  if (req.body?.video_urls !== undefined || req.body?.video !== undefined || req.body?.video_attachments !== undefined) {
    const videoIncoming = req.body?.video_urls ?? req.body?.video ?? req.body?.video_attachments ?? [];
    const videos = normalizeIncomingToUrlArray(videoIncoming, 'video');
    fields.push(`video_urls=$${idx++}::text`); vals.push(toJsonText(videos));
  }

  if (event_type !== undefined) {
    if (event_type === '' || event_type == null) {
      fields.push(`event_type=NULL`);
    } else {
      const asNum = parseInt(event_type, 10);
      if (Number.isNaN(asNum)) return res.status(400).json({ error: 'gecersiz_event_type', message: getErrorMessage(req, 'gecersiz_event_type') });
      const t = await pool.query('SELECT 1 FROM event_type WHERE event_type_id=$1 AND COALESCE(active,true)=true', [asNum]);
      if (!t.rowCount) return res.status(400).json({ error: 'gecersiz_event_type', message: getErrorMessage(req, 'gecersiz_event_type') });
      fields.push(`event_type=$${idx++}`);
      vals.push(asNum);
    }
  }
  if (description !== undefined) {
    fields.push(`description=$${idx++}`);
    vals.push(description ?? null);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'alan_yok', message: getErrorMessage(req, 'alan_yok') });

  if (latitude != null || longitude != null) {
    const lat = latitude != null ? parseFloat(latitude) : null;
    const lng = longitude != null ? parseFloat(longitude) : null;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      fields.push(`geom=ST_SetSRID(ST_MakePoint(${lng},${lat}),4326)`);

      // Recalculate PK1/PK2 based on new position
      if (POLYGON_TABLE && POLYGON_PKS.length > 0) {
        try {
          const polyTable = assertSafeIdent(POLYGON_TABLE, 'table');
          const selectCols = POLYGON_PKS.map(p => p.safeName);
          const polyQ = `SELECT ${selectCols.join(', ')} FROM public.${polyTable} WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) LIMIT 1`;
          const polyR = await pool.query(polyQ, [lng, lat]);
          if (polyR.rows.length > 0) {
            for (const p of POLYGON_PKS) {
              fields.push(`"${p.safeName}"=$${idx++}`);
              if (p.type === 'integer') {
                vals.push(parseInt(polyR.rows[0][p.safeName], 10));
              } else {
                vals.push(String(polyR.rows[0][p.safeName]));
              }
            }
          } else {
            for (const p of POLYGON_PKS) {
              fields.push(`"${p.safeName}"=NULL`);
            }
          }
        } catch (e) {
          console.warn('[PATCH event] polygon PK recalc error:', e.message);
        }
      }
    }
  }

  try {
    let where = `event_id=$${idx++} AND COALESCE(active,true)=true`;
    vals.push(id);

    // Güncelleme takip alanları
    fields.push(`updated_by_name=$${idx++}`);     vals.push(req.user.username || null);
    fields.push(`updated_by_role_name=$${idx++}`); vals.push(req.user.role || null);
    fields.push(`updated_by_id=$${idx++}`);        vals.push(req.user.id || null);
    fields.push(`updated_at=NOW()`);

    const q = `UPDATE event SET ${fields.join(', ')} WHERE ${where} RETURNING event_id, photo_urls, video_urls`;
    const r = await pool.query(q, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });


    res.json({
      ok: true,
      event_id: r.rows[0].event_id,
      photo_urls: parseJsonText(r.rows[0].photo_urls),
      video_urls: parseJsonText(r.rows[0].video_urls)
    });
  } catch (e) {
    console.error('update event error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.delete('/api/event/:id', requireAuth, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });

  // Solver (olay kapatan) kullanıcı YALNIZCA zamana bağlı olay türlerinden eklenen
  // olayları kapatabilir. Diğer türlere erişimi engellenir.
  if (req.user.role === 'user' && req.user.solver === true) {
    try {
      const chk = await pool.query(
        `SELECT COALESCE(et.time_dependent, false) AS time_dependent
           FROM event e
           LEFT JOIN event_type et ON et.event_type_id = e.event_type
          WHERE e.event_id = $1 AND COALESCE(e.active, true) = true`,
        [id]
      );
      if (!chk.rowCount) {
        return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
      }
      const td = chk.rows[0].time_dependent;
      const isTd = (td === true || td === 'true' || td === 1);
      if (!isTd) {
        return res.status(403).json({ error: 'solver_only_time_dependent', message: getErrorMessage(req, 'solver_only_time_dependent') });
      }
    } catch (e) {
      console.error('solver time-dependent check error:', e);
      return res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.actor_name',$1,true),
              set_config('app.actor_role',$2,true),
              set_config('app.actor_id',$3,true)`,
      [req.user.username, req.user.role, String(req.user.id)]
    );

    const r = await client.query(
      `UPDATE event
       SET active=false,
           deactivated_by_name=$2,
           deactivated_by_role_name=$3,
           deactivated_by_id=$4,
           deactivated_at=NOW()
       WHERE event_id=$1 AND COALESCE(active,true)=true
       RETURNING event_id, created_by_id`,
      [id, req.user.username, req.user.role, req.user.id]
    );
    await client.query('COMMIT');

    if (!r.rowCount) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });

    // Gönderi sahibinin puanını tazele: kullanıcı KENDİ gönderisini sildiyse
    // gönderi puanı (+1) geri alınır; beğeni (katılım) puanları korunur.
    try { await recomputeUserStats(r.rows[0].created_by_id); } catch {}

    res.set('X-UI-Remove', '1');
    res.json({ ok: true, event_id: r.rows[0].event_id, ui_remove: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('delete event error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  } finally {
    client.release();
  }
});

/* ===================== Admin / Supervisor ===================== */
const adminOnly = [requireAuth, requireAnyRole(['admin', 'supervisor'])];
// Shared duplicate check used by both the validation endpoint and create endpoint.
// Returns null when the name is free, otherwise an { status, error } describing which
// of the three distinct error situations occurred.
async function checkEventTypeName(event_type_name) {
  if (!event_type_name) {
    // Name was not entered at all.
    return { status: 400, error: 'o_adi_gerekli' };
  }
  const existing = await pool.query(
    `SELECT event_type_id, COALESCE(active, true) AS active
       FROM event_type
      WHERE LOWER(event_type_name) = LOWER($1)`,
    [event_type_name]
  );
  if (existing.rowCount > 0) {
    const anyActive = existing.rows.some(r => r.active === true);
    if (anyActive) {
      // An active event type with this name already exists.
      return { status: 409, error: 'duplicate_active_event_type' };
    }
    // Exists in DB but every matching record is inactive (active = false).
    return { status: 409, error: 'duplicate_inactive_event_type' };
  }
  return null;
}

// Pre-flight validation: the frontend calls this BEFORE opening the
// "is this event type time-dependent?" screen so that the three distinct
// errors (empty name / active duplicate / inactive duplicate) can be shown
// as separate popups without creating anything yet.
app.post('/api/admin/event_types/validate', adminOnly, async (req, res) => {
  const event_type_name = norm(req.body?.event_type_name);
  try {
    const problem = await checkEventTypeName(event_type_name);
    if (problem) {
      return res.status(problem.status).json({ error: problem.error, message: getErrorMessage(req, problem.error) });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('validate event_type error:', e);
    return res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.post('/api/admin/event_types', adminOnly, async (req, res) => {
  const event_type_name = norm(req.body?.event_type_name);
  const isPublic = req.body?.["public"] === true || req.body?.["public"] === 'true';

  // time-dependency inputs
  const timeDependent = req.body?.time_dependent === true || req.body?.time_dependent === 'true';
  let validTime = null;
  if (timeDependent) {
    const vt = Number(req.body?.valid_time);
    if (!Number.isFinite(vt) || vt <= 0) {
      // A time-dependent event type must have a positive validity period (in days).
      return res.status(400).json({ error: 'gecersiz_valid_time', message: getErrorMessage(req, 'gecersiz_valid_time') });
    }
    validTime = vt;
  }

  try {
    const problem = await checkEventTypeName(event_type_name);
    if (problem) {
      return res.status(problem.status).json({ error: problem.error, message: getErrorMessage(req, problem.error) });
    }

    const r = await pool.query(
      `INSERT INTO event_type (event_type_name, active, "public_", created_by_name, created_by_role_name, created_by_id, time_dependent, valid_time)
       VALUES ($1, true, $2, $3, $4, $5, $6, $7)
       RETURNING event_type_id, event_type_name, "public_" AS "public", created_by_name, created_by_id, created_at, time_dependent, valid_time`,
      [event_type_name, isPublic, req.user.username, req.user.role, req.user.id, timeDependent, validTime]
    );
    res.json({ ok: true, created: r.rows[0] });
  } catch (e) {
    console.error('admin add event_type error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.patch('/api/admin/event_type/:id', adminOnly, async (req, res) => {
  const id = +req.params.id;
  const event_type_name = norm(req.body?.event_type_name);
  const isPublic = req.body?.["public"];
  
  if (!Number.isInteger(id) || (!event_type_name && isPublic === undefined)) {
    return res.status(400).json({ error: 'gecersiz_istek', message: getErrorMessage(req, 'gecersiz_istek') });
  }
  
  try {
    const existing = await pool.query('SELECT * FROM event_type WHERE event_type_id = $1', [id]);
    
    if (!existing.rowCount) {
      return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    }
    
    if (req.user.role === 'supervisor' && existing.rows[0].created_by_id !== req.user.id) {
      return res.status(403).json({ error: 'yetkisiz', message: getErrorMessage(req, 'yetkisiz') });
    }
    
    if (event_type_name) {
      const duplicate = await pool.query(
        'SELECT * FROM event_type WHERE event_type_name = $1 AND event_type_id != $2 AND COALESCE(active,true)=true',
        [event_type_name, id]
      );
      
      if (duplicate.rowCount) {
        return res.status(400).json({ error: 'isim_mevcut', message: getErrorMessage(req, 'isim_mevcut') });
      }
    }
    
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (event_type_name) {
      updates.push(`event_type_name = $${paramIndex++}`);
      values.push(event_type_name);
    }
    
    if (isPublic !== undefined) {
      updates.push(`"public_" = $${paramIndex++}`);
      values.push(isPublic === true || isPublic === 'true');
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'alan_yok', message: getErrorMessage(req, 'alan_yok') });
    }
    
    updates.push(`created_at = NOW()`);
    values.push(id);
    
    const sql = `UPDATE event_type SET ${updates.join(', ')} WHERE event_type_id = $${paramIndex} RETURNING event_type_id, event_type_name, "public_" AS "public", created_at`;
    const r = await pool.query(sql, values);
    
    res.json({ ok: true, message: 'Olay türü güncellendi', updated: r.rows[0] });
  } catch (e) {
    console.error('admin patch event_type error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.delete('/api/admin/event_type/:id', adminOnly, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `SELECT set_config('app.actor_name',$1,true),
                set_config('app.actor_role',$2,true),
                set_config('app.actor_id',$3,true)`,
        [req.user.username, req.user.role, String(req.user.id)]
      );

      let whereClause = 'event_type_id=$1 AND COALESCE(active,true)=true';
      const params = [id, req.user.username, req.user.role, req.user.id];
      
      if (req.user.role === 'supervisor') {
        whereClause += ' AND (created_by_id=$5 OR (created_by_id IS NULL AND created_by_name=$2))';
        params.push(req.user.id);
      }

      const rType = await client.query(
        `UPDATE event_type
         SET active=false,
             deactivated_by_name=$2,
             deactivated_by_role_name=$3,
             deactivated_by_id=$4,
             deactivated_at=NOW()
         WHERE ${whereClause}
         RETURNING event_type_id`,
        params
      );
      
      if (!rType.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'bulunamadi_veya_pasif', message: getErrorMessage(req, 'bulunamadi_veya_pasif') });
      }

      const rOlay = await client.query(
        `UPDATE event
         SET active=false,
             deactivated_by_name=$2,
             deactivated_by_role_name=$3,
             deactivated_by_id=$4,
             deactivated_at=NOW()
         WHERE event_type=$1 AND COALESCE(active,true)=true
         RETURNING event_id`,
        [id, req.user.username, req.user.role, req.user.id]
      );

      await client.query('COMMIT');
      res.json({ ok: true, cascaded: true, deactivatedTypeId: id, deactivatedOlayCount: rOlay.rowCount });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('admin delete event_type error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.delete('/api/admin/event/:id', adminOnly, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.actor_name',$1,true),
                set_config('app.actor_role',$2,true),
                set_config('app.actor_id',$3,true)`,
        [req.user.username, req.user.role, String(req.user.id)]
      );

      const r = await client.query(
        `UPDATE event
         SET active=false,
             deactivated_by_name=$2,
             deactivated_by_role_name=$3,
             deactivated_by_id=$4,
             deactivated_at=NOW()
         WHERE event_id=$1 AND COALESCE(active,true)=true
         RETURNING event_id`,
        [id, req.user.username, req.user.role, req.user.id]
      );
      await client.query('COMMIT');

      if (!r.rowCount) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
      res.set('X-UI-Remove', '1');
      res.json({ ok: true, deletedId: id, ui_remove: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('admin delete event error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.get('/api/admin/users', adminOnly, async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || '0') === '1';
    res.set('Cache-Control', 'no-store');

    const where = includeInactive ? 'TRUE' : 'COALESCE(is_active,true)=true';
    const { rows } = await pool.query(
      `SELECT id, username, name, surname, email, role, email_verified, is_verified,
              COALESCE(is_active, true) AS is_active, deleted_by, deleted_by_role, deleted_by_id, deleted_at,
              registration_date, COALESCE(solver, false) AS solver,
              COALESCE(num_events, 0)  AS num_events,
              COALESCE(agreed_point, 0) AS agreed_point,
              COALESCE(posts_point, 0) AS posts_point
       FROM users
       WHERE ${where}
       ORDER BY id`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/users error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.post('/api/admin/users', adminOnly, async (req, res) => {
  const username = norm(req.body?.username);
  const password = req.body?.password;
  const role = req.body?.role;
  const name = req.body?.name || null;
  const surname = req.body?.surname || null;
  const email = norm(req.body?.email);
  const base32Raw = norm(req.body?.BASE32Code || req.body?.base32 || req.body?.base32Code || req.body?.totp || '');

  if (!username || !password || !role || !email) return res.status(400).json({ error: 'gecersiz_istek', message: getErrorMessage(req, 'gecersiz_istek') });
  if (!['supervisor', 'admin', 'user'].includes(role)) return res.status(400).json({ error: 'gecersiz_rol', message: getErrorMessage(req, 'gecersiz_rol') });
  if (!isStrongPassword(password)) return res.status(400).json({ error: 'zayif_sifre', message: getErrorMessage(req, 'zayif_sifre') });
  if (!isEmailAllowed(email)) {
    let message = getErrorMessage(req, 'gecersiz_eposta');
    if (ALLOWED_EMAIL_DOMAINS.length > 0) {
      const lang = _detectLang(req);
      if (ALLOWED_EMAIL_DOMAINS.length === 1) {
        message = lang === 'en'
          ? `Only email addresses with ${ALLOWED_EMAIL_DOMAINS[0]} domain are allowed.`
          : `Yalnızca ${ALLOWED_EMAIL_DOMAINS[0]} alan adına sahip e-posta adresleriyle kayıt olunabilir.`;
      } else {
        message = lang === 'en'
          ? `Only email addresses with the following domains are allowed: ${ALLOWED_EMAIL_DOMAINS.join(', ')}`
          : `Yalnızca şu alan adlarına sahip e-posta adresleriyle kayıt olunabilir: ${ALLOWED_EMAIL_DOMAINS.join(', ')}`;
      }
    }
    return res.status(400).json({
      error: 'gecersiz_eposta',
      message: message,
    });
  }

  try {
    await failIfAnyDuplicate(username, email);
  } catch (e) {
    if (e.code === 'USERNAME_DUP')
      return res.status(409).json({ error: 'usernameTaken', message: getErrorMessage(req, 'usernameTaken') });
    if (e.code === 'EMAIL_DUP')
      return res.status(409).json({ error: 'emailTaken', message: getErrorMessage(req, 'emailTaken') });
    if (e.code === 'BOTH_DUP')
      return res.status(409).json({ error: 'bothTaken', message: getErrorMessage(req, 'bothTaken') });
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.password_plain', $1, true)`, [password]);

    const hashPw = await bcrypt.hash(password, 10);

    let twoFactorSecretPlain = null;
    let twoFactorEnabled = false;
    if (role === 'supervisor' && base32Raw) {
      twoFactorSecretPlain = normalizeBase32(base32Raw);
      twoFactorEnabled = true;
    }

    const r = await client.query(
      `INSERT INTO users (username, password_hash, role, name, surname, email, email_verified, is_verified, is_active,
                          two_factor_norm_hash, two_factor_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,true,true,true,$7,$8)
       RETURNING id, username, role`,
      [username, hashPw, role, name, surname, email, twoFactorSecretPlain, twoFactorEnabled]
    );

    await client.query('COMMIT');
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    if (e.code === 'P0001' || e.code === 'P0002' || e.code === 'P0003') {
      return res.status(400).json({ error: 'gecersiz', message: e.message });
    }
    if (e.code === '23505') {
      return res.status(409).json({ error: 'base32_cakisma', message: getErrorMessage(req, 'base32_cakisma') });
    }
    console.error('admin create user error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  } finally {
    try { await client.query(`SELECT set_config('app.password_plain', NULL, true)`); } catch {}
    client.release();
  }
});

// Solver (olay kapatan) yetkisini aç/kapa. Yalnızca 'user' rolündeki hesaplar için geçerlidir.
// solver=true iken kullanıcı olay ekleyemez, yalnızca kullanıcı olaylarını kapatabilir.
app.patch('/api/admin/users/:id/solver', adminOnly, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });

  const raw = req.body?.solver;
  const solver = (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'yes');

  try {
    const found = await pool.query('SELECT id, role FROM users WHERE id=$1', [id]);
    if (!found.rowCount) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });

    const victimRole = found.rows[0].role;
    // Solver bayrağı sadece normal kullanıcı (event-adder) hesapları için anlamlı.
    if (victimRole !== 'user') {
      return res.status(400).json({ error: 'solver_only_for_users', message: getErrorMessage(req, 'solver_only_for_users') });
    }

    const upd = await pool.query(
      `UPDATE users SET solver=$2 WHERE id=$1 RETURNING id, username, role, COALESCE(solver,false) AS solver`,
      [id, solver]
    );

    // Onbelleği temizle ki değişiklik anında etkili olsun (30sn TTL beklemeden).
    try { _userCache.delete(id); } catch {}

    res.json({ ok: true, user: upd.rows[0] });
  } catch (e) {
    console.error('PATCH /api/admin/users/:id/solver error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.delete('/api/admin/users/:id', adminOnly, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query('SELECT id, username, role FROM users WHERE id=$1', [id]);
    if (!u.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    }
    const victimId = u.rows[0].id;
    const victimUsername = u.rows[0].username;
    const victimRole = u.rows[0].role;

    if (req.user.role === 'supervisor') {
      const isSelf = victimId === req.user.id;
      if (!isSelf && victimRole === 'supervisor') {
        await client.query('ROLLBACK');
        return res.status(403).json({ 
          error: 'yetkisiz', 
          message: getErrorMessage(req, 'yetkisiz')
        });
      }
    }

    await client.query(
      `SELECT set_config('app.actor_name',$1,true),
              set_config('app.actor_role',$2,true),
              set_config('app.actor_id',$3,true)`,
      [req.user.username, req.user.role, String(req.user.id)]
    );

    const r = await client.query(
      `UPDATE users
       SET is_active=false,
           deleted_by=$2,
           deleted_by_role=$3,
           deleted_by_id=$4,
           deleted_at=NOW()
       WHERE id=$1 AND COALESCE(is_active,true)=true
       RETURNING id`,
      [victimId, req.user.username, req.user.role, req.user.id]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'bulunamadi_veya_pasif', message: getErrorMessage(req, 'bulunamadi_veya_pasif') });
    }


    await client.query(
      `UPDATE event
       SET active=false,
           deactivated_by_name=$3,
           deactivated_by_role_name=$4,
           deactivated_by_id=$5,
           deactivated_at=NOW()
       WHERE COALESCE(active,true)=true
         AND (created_by_id=$1 OR (created_by_id IS NULL AND created_by_name=$2))`,
      [victimId, victimUsername, req.user.username, req.user.role, req.user.id]
    );

    if (victimRole === 'supervisor') {
      const typeResult = await client.query(
        `SELECT event_type_id FROM event_type 
         WHERE COALESCE(active,true)=true
           AND (created_by_id=$1 OR (created_by_id IS NULL AND created_by_name=$2))`,
        [victimId, victimUsername]
      );
      
      const typeIds = typeResult.rows.map(r => r.event_type_id);

      if (typeIds.length > 0) {
        await client.query(
          `UPDATE event_type
           SET active=false,
               deactivated_by_name=$2,
               deactivated_by_role_name=$3,
               deactivated_by_id=$4,
               deactivated_at=NOW()
           WHERE event_type_id = ANY($1::int[])`,
          [typeIds, req.user.username, req.user.role, req.user.id]
        );

        await client.query(
          `UPDATE event
           SET active=false,
               deactivated_by_name=$4,
               deactivated_by_role_name=$5,
               deactivated_by_id=$6,
               deactivated_at=NOW()
           WHERE COALESCE(active,true)=true
             AND event_type = ANY($1::int[])
             AND (created_by_id=$2 OR (created_by_id IS NULL AND created_by_name=$3))`,
          [typeIds, victimId, victimUsername, req.user.username, req.user.role, req.user.id]
        );
      }
    }

    await client.query(
      `UPDATE event
       SET deactivated_by_name=$3,
           deactivated_by_role_name=$4,
           deactivated_by_id=$5,
           deactivated_at=COALESCE(deactivated_at, NOW())
       WHERE COALESCE(active,false)=false
         AND (created_by_id=$1 OR (created_by_id IS NULL AND created_by_name=$2))
         AND (deactivated_by_name IS NULL OR deactivated_by_role_name IS NULL OR deactivated_by_id IS NULL)`,
      [victimId, victimUsername, req.user.username, req.user.role, req.user.id]
    );

    if (victimRole === 'supervisor') {
      await client.query(
        `UPDATE event_type
         SET deactivated_by_name=$3,
             deactivated_by_role_name=$4,
             deactivated_by_id=$5,
             deactivated_at=COALESCE(deactivated_at, NOW())
         WHERE COALESCE(active,false)=false
           AND (created_by_id=$1 OR (created_by_id IS NULL AND created_by_name=$2))
           AND (deactivated_by_name IS NULL OR deactivated_by_role_name IS NULL OR deactivated_by_id IS NULL)`,
        [victimId, victimUsername, req.user.username, req.user.role, req.user.id]
      );
    }


    await client.query('COMMIT');

    const isSelf = req.user && Number(req.user.id) === victimId;
    if (isSelf) {
      res.clearCookie('token', cookieOpts(0, req));
      res.set('X-Logged-Out', '1');
    }
    res.set('X-UI-Remove', '1');
    res.set('X-Data-Changed', 'users,event,event_type');
    res.set('X-UI-Refetch', '/api/events_all,/api/event_types,/api/admin/users');

    return res.json({
      ok: true,
      deletedId: victimId,
      selfDeleted: !!isSelf,
      loggedOut: !!isSelf,
      ui_remove: true,
      message: isSelf ? 'Kendinizi sildiniz, giriş ekranına yönlendiriliyorsunuz.' : 'Kullanıcı pasifleştirildi.',
      data_changed: ['users','event','event_type'],
      refetch: ['/api/events_all','/api/event_types','/api/admin/users']
    });

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('admin delete user error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  } finally {
    try {
      await pool.query(
        `SELECT set_config('app.actor_name',NULL,true); SELECT set_config('app.actor_role',NULL,true); SELECT set_config('app.actor_id',NULL,true);`
      );
    } catch {}
    client.release();
  }
});

app.post('/api/admin/users/:id/activate', adminOnly, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let activated;
    try {
      const r = await client.query('SELECT * FROM app_api.activate_user($1)', [id]);
      activated = r.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === 'P0005') return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
      if (e.code === 'P0004')
        return res.status(409).json({ error: 'zaten_aktif', message: getErrorMessage(req, 'zaten_aktif') });
      if (e.code === 'P0006') return res.status(404).json({ error: 'bulunamadi_veya_zaten_aktif', message: getErrorMessage(req, 'bulunamadi_veya_zaten_aktif') });
      throw e;
    }

    const u = await client.query('SELECT id, username, role FROM users WHERE id=$1', [activated.id]);
    const username = u.rows[0].username;
    const role = u.rows[0].role;

    const rRestore = await client.query(
      `UPDATE event
       SET active=true,
           deactivated_by_name=NULL,
           deactivated_by_role_name=NULL,
           deactivated_by_id=NULL,
           deactivated_at=NULL
       WHERE COALESCE(active,false)=false
         AND (created_by_id=$1 OR (created_by_id IS NULL AND created_by_name=$2))`,
      [activated.id, username]
    );

    let restoredTypes = 0;
    if (role === 'supervisor') {
      const t = await client.query(
        `UPDATE event_type
         SET active=true,
             deactivated_by_name=NULL,
             deactivated_by_role_name=NULL,
             deactivated_by_id=NULL,
             deactivated_at=NULL
         WHERE COALESCE(active,false)=false
           AND (created_by_id=$1 OR (created_by_id IS NULL AND created_by_name=$2))`,
        [activated.id, username]
      );
      restoredTypes = t.rowCount;
    }

    await client.query('COMMIT');
    res.json({ ok: true, reactivatedUserId: activated.id, restoredOlayCount: rRestore.rowCount, restoredOlayTypeCount: restoredTypes });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('admin activate user error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  } finally {
    client.release();
  }
});

app.post('/api/admin/users/:id/totp', adminOnly, async (req, res) => {
  const id = +req.params.id;
  const base32 = norm(req.body?.base32 || req.body?.BASE32Code || req.body?.base32Code || req.body?.totp);
  if (!Number.isInteger(id) || !base32) return res.status(400).json({ error: 'gecersiz_istek', message: getErrorMessage(req, 'gecersiz_istek') });
  try {
    const base32Norm = normalizeBase32(base32);
    await pool.query('UPDATE users SET two_factor_norm_hash=$1, two_factor_enabled=TRUE WHERE id=$2', [base32Norm, id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505' || e.code === 'P0003') {
      return res.status(409).json({
        error: 'base32_cakisma',
        message: getErrorMessage(req, 'base32_cakisma'),
      });
    }
    console.error('admin set totp error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

app.delete('/api/admin/users/:id/hard', adminOnly, async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });

  try {
    await pool.query('SELECT app_api.hard_delete_user($1)', [id]);
    return res.json({ ok: true, hardDeletedId: id });
  } catch (e) {
    if (e.code === 'P0005') {
      return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    }
    console.error('hard delete user error:', e);
    return res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

/* ===================== Export Endpoint (GeoJSON) ===================== */
app.post('/api/export/geojson', requireAuth, async (req, res) => {
  try {
    let eventIds = req.body?.eventIds || req.body?.events || [];
    
    
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: 'bos_liste', message: getErrorMessage(req, 'bos_liste') });
    }
    
    const validIds = eventIds
      .map(id => {
        if (typeof id === 'object' && id !== null && id.event_id) {
          return parseInt(id.event_id, 10);
        }
        return parseInt(id, 10);
      })
      .filter(id => !isNaN(id) && id > 0);
    
    
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'gecersiz_idler', message: getErrorMessage(req, 'gecersiz_idler') });
    }

    // Dynamically discover all columns in the event table
    const colResult = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'event'
      ORDER BY ordinal_position
    `);
    const allColumns = colResult.rows.map(r => r.column_name);
    // Exclude geometry and raw event_type source columns from properties.
    // - event_type      → ham FK; yerine join'den "event" (event_type_name) olarak ekleniyor
    // - event_type_name → event tablosunda varsa bile join sonucu "event" olarak ekleniyor
    // - event_type_good → yerine "public" anahtarıyla ekleniyor (aşağıda loop + join)
    const excludeFromProps = ['geom', 'event_type', 'event_type_good', 'event_type_name'];
    const propColumns = allColumns.filter(c => !excludeFromProps.includes(c));
    
    const placeholders = validIds.map((_, i) => `$${i + 1}`).join(',');
    
    // Build SELECT with all columns + event_type join
    const selectCols = propColumns.map(c => `o."${c}"`).join(', ');
    
    const query = `
      SELECT 
        ${selectCols},
        l.event_type_name AS event_type_name,
        l."public_" AS event_type_public
      FROM event o
      LEFT JOIN event_type l ON l.event_type_id = o.event_type
      WHERE o.event_id IN (${placeholders})
        AND COALESCE(o.active, true) = true
      ORDER BY o.event_id DESC
    `;
    
    const { rows } = await pool.query(query, validIds);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'olay_yok', message: getErrorMessage(req, 'olay_yok') });
    }
    
    
    const features = rows.map(row => {
      // Build properties from all columns dynamically
      const properties = {};
      for (const col of propColumns) {
        if (col === 'latitude' || col === 'longitude') continue; // coordinates go in geometry
        // Çift güvence: event_type kaynak sütunları asla properties'e yazılmasın
        if (col === 'event_type' || col === 'event_type_good' || col === 'event_type_name') continue;
        let val = row[col];
        // Parse JSON text fields
        if (col === 'photo_urls' || col === 'video_urls') {
          try { val = JSON.parse(String(val || '[]')); } catch { val = []; }
        }
        properties[col] = val;
      }
      // "event_type" → event_type_name join'inden (okunabilir tip adı)
      properties.event_type = row.event_type_name || null;
      // "public_" → event_type tablosundaki public_ flag'inden
      properties.public_ = row.event_type_public || false;

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [parseFloat(row.longitude), parseFloat(row.latitude)]
        },
        properties
      };
    });
    
    const geojson = {
      type: 'FeatureCollection',
      features: features,
      metadata: {
        total_events: features.length,
        export_date: new Date().toISOString(),
        columns: [
          ...propColumns.filter(c => c !== 'latitude' && c !== 'longitude'),
          'event_type',
          'public_'
        ]
      }
    };
    
    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Content-Disposition', `attachment; filename="events_${Date.now()}.geojson"`);
    res.json(geojson);
    
  } catch (e) {
    console.error('GeoJSON export error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') + ': ' + e.message });
  }
});

/* ===================== GeoJSON Import ===================== */
app.post('/api/import/geojson', adminOnly, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { features, event_type_id, description_column } = req.body;
    if (!Array.isArray(features) || features.length === 0) {
      return res.status(400).json({ error: 'empty', message: getErrorMessage(req, 'bos_liste') });
    }
    // event_type_id is optional; null = no event type (visible after login)
    const eventTypeId = event_type_id ? parseInt(event_type_id, 10) : null;
    if (event_type_id && isNaN(eventTypeId)) {
      return res.status(400).json({ error: 'missing_type', message: getErrorMessage(req, 'gecersiz_event_type') });
    }

    const hasGrid = !!(POLYGON_TABLE && POLYGON_PKS.length > 0);
    let inserted = 0, skipped = 0;

    for (const f of features) {
      if (!f.geometry || f.geometry.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) {
        skipped++;
        continue;
      }
      const [lng, lat] = f.geometry.coordinates;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skipped++; continue; }

      const description = description_column && f.properties
        ? String(f.properties[description_column] ?? '') : '';

      // Grid boundary check
      const foundPkValues = {};
      if (hasGrid) {
        try {
          const polyTable = assertSafeIdent(POLYGON_TABLE, 'table');
          const selectCols = POLYGON_PKS.map(p => p.safeName);
          const polyQ = `SELECT ${selectCols.join(', ')} FROM public.${polyTable} WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) LIMIT 1`;
          const polyR = await pool.query(polyQ, [lng, lat]);
          if (polyR.rows.length === 0) {
            skipped++;
            continue; // outside grid
          }
          for (const p of POLYGON_PKS) {
            foundPkValues[p.name] = polyR.rows[0][p.safeName];
          }
        } catch (e) {
          console.warn('[import] polygon check error:', e.message);
          skipped++;
          continue;
        }
      }

      // Build INSERT
      let pkColumns = '', pkPlaceholders = '';
      const baseVals = [lat, lng, eventTypeId, description || null, req.user.username, req.user.role, req.user.id];
      let pkIdx = 8;

      for (const p of POLYGON_PKS) {
        pkColumns += `, "${p.safeName}"`;
        pkPlaceholders += `, $${pkIdx++}`;
        const val = foundPkValues[p.name];
        if (p.type === 'integer') {
          baseVals.push(val != null ? parseInt(val, 10) : null);
        } else {
          baseVals.push(val != null ? String(val) : null);
        }
      }

      try {
        await pool.query(
          `INSERT INTO event (latitude, longitude, event_type, description, geom,
                             created_by_name, created_by_role_name, created_by_id, active, last_agreed_date${pkColumns})
           VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($2,$1),4326),
                   $5, $6, $7, true, now()${pkPlaceholders})`,
          baseVals
        );
        inserted++;
      } catch (e) {
        console.warn('[import] insert error:', e.message);
        skipped++;
      }
    }

    res.json({ ok: true, inserted, skipped, total: features.length });
  } catch (e) {
    console.error('GeoJSON import error:', e);
    res.status(500).json({ error: 'sunucu_hatasi', message: getErrorMessage(req, 'sunucu_hatasi') });
  }
});

/* ===================== Şirketler (company) altyapısı ===================== */
// Tablolar yalnızca ihtiyaç anında (ilk şirket / ilk sipariş) oluşturulur.
/* Şirket bağlantısı (Instagram / web): boşsa NULL; şema yoksa https:// eklenir.
   Yalnızca http/https kabul edilir (javascript: gibi şemalar engellenir). */
function normalizeLink(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  if (!/^https?:\/\//i.test(v)) return null;
  return v.slice(0, 500);
}

// Şema bir kez hazırlanır; sonraki çağrılar aynı söze (promise) bağlanır.
let __companiesSchemaReady = null;
function ensureCompaniesSchema() {
  if (!__companiesSchemaReady) {
    __companiesSchemaReady = _ensureCompaniesSchema().catch((e) => {
      __companiesSchemaReady = null;      // hata olursa bir sonraki istekte yeniden denensin
      throw e;
    });
  }
  return __companiesSchemaReady;
}

async function _ensureCompaniesSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.companies (
      company_id serial PRIMARY KEY,
      company_name text NOT NULL,
      logo_url text,
      latitude double precision,
      longitude double precision,
      discount_percentage integer,
      discount_threshold_point integer,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by_name text,
      deactivated_at timestamptz,
      deactivated_by_name text
    )
  `);
  // Menü özelliği kaldırıldı → eski kurulumlarda kolon düşürülür.
  try { await pool.query(`ALTER TABLE public.companies DROP COLUMN IF EXISTS menu`); } catch (e) {}
  // Şirketin Instagram (ya da web) bağlantısı — zorunlu değildir
  try { await pool.query(`ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS instagram_link text`); } catch (e) {}
}

// users.dependent_company: ilk şirket kullanıcısı eklendiğinde oluşur (companies FK)
async function ensureUsersDependentCompany() {
  await ensureCompaniesSchema();
  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS dependent_company integer`);
  try {
    await pool.query(`ALTER TABLE public.users ADD CONSTRAINT users_dependent_company_fk
      FOREIGN KEY (dependent_company) REFERENCES public.companies(company_id) ON DELETE SET NULL`);
  } catch (e) { /* zaten var */ }
  await ensureCompanyUsernameScope();
}

/* Kullanıcı adı / e-posta benzersizliği:
   - KULLANICI ADI: rol fark etmeksizin TÜM users tablosunda benzersizdir (eski mantık).
   - E-POSTA: aynı şirketin (dependent_company) kullanıcıları arasında TEKRARLANABİLİR;
     bunun dışında (başka şirketler, opener/solver kullanıcılar, supervisor'lar) benzersizdir.
   Bu kurallar hem uygulama içinde hem de app_api.users_prevent_global_dup tetikleyicisinde
   uygulanır. */
async function ensureCompanyUsernameScope() {
  // Önceki sürümde denenen kısmi indeksler kaldırılır (kullanıcı adı yine global benzersiz)
  try { await pool.query(`DROP INDEX IF EXISTS public.users_username_noncompany_uniq`); } catch (e) {}
  try { await pool.query(`DROP INDEX IF EXISTS public.users_company_username_uniq`); } catch (e) {}
  // Tetikleyicinin dependent_company kolonuna güvenle bakabilmesi için kolon garanti edilir
  try { await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS dependent_company integer`); } catch (e) {}
  // Kullanıcı adı: tablo genelinde benzersiz (orders FK'si de buna bağlıdır)
  try { await pool.query(`ALTER TABLE public.users ADD CONSTRAINT users_username_key UNIQUE (username)`); } catch (e) { /* zaten var */ }
  try {
    await pool.query(`ALTER TABLE public.orders ADD CONSTRAINT orders_person_fk
      FOREIGN KEY (person_placing_order) REFERENCES public.users(username)`);
  } catch (e) { /* orders yoksa / zaten var */ }
}

// orders: ilk sipariş oluşturulduğunda oluşur
async function ensureOrdersSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.orders (
      order_id serial PRIMARY KEY,
      company_id integer,
      person_placing_order text,
      order_amount_before_discount numeric(12,2),
      order_amount_after_discount numeric(12,2),
      discount_percentage integer,
      points_spent integer NOT NULL DEFAULT 0,
      order_date timestamptz NOT NULL DEFAULT now()
    )
  `);
  // companies tablosu daha eski bir yapıyla oluşmuş olabilir → indirim kolonlarını tamamla
  // (harita pop-up'ında "kaç puana yüzde kaç indirim" bilgisi bu kolonlardan okunur).
  try { await pool.query(`ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS discount_percentage integer`); } catch (e) {}
  try { await pool.query(`ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS discount_threshold_point integer`); } catch (e) {}
  try { await pool.query(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS company_id integer`); } catch (e) {}
  try { await pool.query(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS points_spent integer NOT NULL DEFAULT 0`); } catch (e) {}
  // Siparişler panelinde (Companies > Siparişler) gösterilen sütunlar: tablo daha önce
  // eksik/eski bir yapıyla oluşmuş olsa bile eksik kolonları tamamla, boş dönmesin.
  try { await pool.query(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS person_placing_order text`); } catch (e) {}
  try { await pool.query(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_amount_before_discount numeric(12,2)`); } catch (e) {}
  try { await pool.query(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_amount_after_discount numeric(12,2)`); } catch (e) {}
  try { await pool.query(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_percentage integer`); } catch (e) {}
  try { await pool.query(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_date timestamptz NOT NULL DEFAULT now()`); } catch (e) {}
  // Ürün/menü seçimi kaldırıldı (tutar elle giriliyor) → items kolonu düşürülür.
  try { await pool.query(`ALTER TABLE public.orders DROP COLUMN IF EXISTS items`); } catch (e) {}
  // QR'ı okutan şirket kullanıcısının kullanıcı adı (users.username)
  try { await pool.query(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS scanned_by text`); } catch (e) {}
  try { await pool.query(`ALTER TABLE public.users ADD CONSTRAINT users_username_key UNIQUE (username)`); } catch (e) { /* zaten var */ }
  try {
    await pool.query(`ALTER TABLE public.orders ADD CONSTRAINT orders_company_fk
      FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE SET NULL`);
  } catch (e) { /* zaten var / companies yoksa */ }
  try {
    await pool.query(`ALTER TABLE public.orders ADD CONSTRAINT orders_person_fk
      FOREIGN KEY (person_placing_order) REFERENCES public.users(username)`);
  } catch (e) { /* username unique değilse FK kurulamaz; kolon metin olarak kalır */ }
}

async function companiesTableExists() {
  const r = await pool.query(`SELECT to_regclass('public.companies') AS t`);
  return !!(r.rows[0] && r.rows[0].t);
}

// Şirket oluştur (supervisor/admin)
app.post('/api/admin/companies', requireAuth, requireAnyRole(['supervisor', 'admin']), async (req, res) => {
  try {
    const name = String(req.body?.company_name || '').trim();
    const logo = String(req.body?.logo_url || '').trim();
    const insta = normalizeLink(req.body?.instagram_link);
    const lat = Number(req.body?.latitude);
    const lng = Number(req.body?.longitude);
    if (!name)  return res.status(400).json({ error: 'company_name_required',  message: getErrorMessage(req, 'company_name_required') });
    if (!logo)  return res.status(400).json({ error: 'company_logo_required',  message: getErrorMessage(req, 'company_logo_required') });
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'company_coords_required', message: getErrorMessage(req, 'company_coords_required') });
    }
    await ensureCompaniesSchema();
    const r = await pool.query(
      `INSERT INTO public.companies (company_name, logo_url, latitude, longitude, created_by_name, instagram_link)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING company_id, company_name, logo_url, latitude, longitude, instagram_link,
                 COALESCE(active,true) AS active, created_at, created_by_name`,
      [name, logo, lat, lng, req.user.username, insta]
    );
    res.json({ ok: true, company: r.rows[0] });
  } catch (e) {
    console.error('POST /api/admin/companies error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Rastgele Base32 (TOTP) anahtarı üretir (supervisor/admin) — şirket kullanıcısı eklerken "otomatik oluştur" için
app.get('/api/admin/base32/new', requireAuth, requireAnyRole(['supervisor', 'admin']), async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({ length: 20 });
    res.json({ ok: true, base32: secret.base32 });
  } catch (e) {
    console.error('GET /api/admin/base32/new error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Şirket güncelle: isim ve/veya logo (supervisor/admin)
app.patch('/api/admin/companies/:id', requireAuth, requireAnyRole(['supervisor', 'admin']), async (req, res) => {
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });
    if (!(await companiesTableExists())) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });

    const sets = []; const vals = []; let i = 1;
    if (req.body?.company_name != null) {
      const name = String(req.body.company_name).trim();
      if (!name) return res.status(400).json({ error: 'company_name_required', message: getErrorMessage(req, 'company_name_required') });
      sets.push(`company_name=$${i++}`); vals.push(name);
    }
    if (req.body?.logo_url != null) {
      const logo = String(req.body.logo_url).trim();
      if (!logo) return res.status(400).json({ error: 'company_logo_required', message: getErrorMessage(req, 'company_logo_required') });
      sets.push(`logo_url=$${i++}`); vals.push(logo);
    }
    if (req.body?.instagram_link != null) {
      // Boş gönderilirse bağlantı kaldırılır (NULL)
      sets.push(`instagram_link=$${i++}`); vals.push(normalizeLink(req.body.instagram_link));
    }
    if (!sets.length) return res.status(400).json({ error: 'gecersiz_istek', message: getErrorMessage(req, 'gecersiz_istek') });
    vals.push(id);
    const r = await pool.query(
      `UPDATE public.companies SET ${sets.join(', ')} WHERE company_id=$${i}
       RETURNING company_id, company_name, logo_url, latitude, longitude, instagram_link,
                 COALESCE(active,true) AS active, created_at, created_by_name`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    res.json({ ok: true, company: r.rows[0] });
  } catch (e) {
    console.error('PATCH /api/admin/companies/:id error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Şirket sil (soft delete — supervisor/admin)
app.delete('/api/admin/companies/:id', requireAuth, requireAnyRole(['supervisor', 'admin']), async (req, res) => {
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });
    if (!(await companiesTableExists())) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    const r = await pool.query(
      `UPDATE public.companies
          SET active=false,
              deactivated_at=now(),
              deactivated_by_name=$2
        WHERE company_id=$1 AND COALESCE(active,true)=true
        RETURNING company_id`,
      [id, req.user.username]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/admin/companies/:id error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Şirket listesi (supervisor/admin)
app.get('/api/admin/companies', requireAuth, requireAnyRole(['supervisor', 'admin']), async (req, res) => {
  try {
    if (!(await companiesTableExists())) return res.json([]);
    // Yeni kolonlar (ör. instagram_link) eski kurulumlarda eksik olabilir → garanti et
    try { await ensureCompaniesSchema(); } catch (e) { console.warn('[COMPANIES] schema:', e.message); }
    const r = await pool.query(
      `SELECT company_id, company_name, logo_url, latitude, longitude, instagram_link,
              COALESCE(active,true) AS active, created_at, created_by_name
       FROM public.companies WHERE COALESCE(active,true)=true ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/admin/companies error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Şirket detayı (supervisor/admin)
app.get('/api/admin/companies/:id', requireAuth, requireAnyRole(['supervisor', 'admin']), async (req, res) => {
  try {
    if (!(await companiesTableExists())) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    try { await ensureCompaniesSchema(); } catch (e) { console.warn('[COMPANIES] schema:', e.message); }
    const r = await pool.query(
      `SELECT company_id, company_name, logo_url, latitude, longitude, instagram_link,
              discount_percentage, discount_threshold_point, COALESCE(active,true) AS active,
              created_at, created_by_name
       FROM public.companies WHERE company_id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('GET /api/admin/companies/:id error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Tüm haritalar için aktif şirketler (giriş yapılmadan da erişilir) — logolu marker
app.get('/api/companies', tryAuth, async (req, res) => {
  try {
    if (!(await companiesTableExists())) return res.json([]);
    try { await ensureCompaniesSchema(); } catch (e) { console.warn('[COMPANIES] schema:', e.message); }
    const r = await pool.query(
      `SELECT company_id, company_name, logo_url, latitude, longitude, instagram_link,
              discount_percentage, discount_threshold_point
       FROM public.companies
       WHERE COALESCE(active,true)=true AND latitude IS NOT NULL AND longitude IS NOT NULL`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/companies error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Bir şirketin kullanıcıları (company rolü)
app.get('/api/admin/companies/:id/users', adminOnly, async (req, res) => {
  try {
    const col = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='dependent_company'`);
    if (!col.rows.length) return res.json([]);
    const r = await pool.query(
      `SELECT id, username, name, surname, email
         FROM users
        WHERE dependent_company=$1 AND role='company' AND COALESCE(is_active,true)=true
        ORDER BY id`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('GET company users error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Şirkete company rolünde kullanıcı ekle (2FA/base32 zorunlu)
app.post('/api/admin/companies/:id/users', adminOnly, async (req, res) => {
  const companyId = +req.params.id;
  if (!Number.isInteger(companyId)) return res.status(400).json({ error: 'gecersiz_id', message: getErrorMessage(req, 'gecersiz_id') });
  const username = norm(req.body?.username);
  const password = req.body?.password;
  const name = req.body?.name || null;
  // company rolünde soyad istenmez (NULL). E-posta ZORUNLUDUR; ancak şirket kullanıcıları
  // arasında (ve diğer kullanıcılarla) aynı e-posta tekrar kullanılabilir.
  const surname = null;
  const email = norm(req.body?.email);
  const base32Raw = norm(req.body?.BASE32Code || req.body?.base32 || req.body?.base32Code || req.body?.totp || '');

  if (!email) return res.status(400).json({ error: 'email_required', message: getErrorMessage(req, 'email_required') });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'gecersiz_eposta', message: getErrorMessage(req, 'gecersiz_eposta') });
  if (!username || !password || !base32Raw) return res.status(400).json({ error: 'gecersiz_istek', message: getErrorMessage(req, 'gecersiz_istek') });
  if (!isStrongPassword(password)) return res.status(400).json({ error: 'zayif_sifre', message: getErrorMessage(req, 'zayif_sifre') });
  if (!isValidBase32Secret(base32Raw)) return res.status(400).json({ error: 'base32_gecersiz', message: getErrorMessage(req, 'base32_gecersiz') });

  try {
    if (!(await companiesTableExists())) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    const c = await pool.query(`SELECT company_id FROM public.companies WHERE company_id=$1 AND COALESCE(active,true)=true`, [companyId]);
    if (!c.rows.length) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
  } catch (e) {
    return res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }

  await ensureUsersDependentCompany();

  // Kullanıcı adı: rol fark etmeksizin TÜM kullanıcılar arasında benzersiz olmalı.
  // E-posta: yalnızca AYNI şirketin kullanıcıları arasında tekrarlanabilir; diğer
  // şirketlerin kullanıcıları, opener/solver kullanıcılar ve supervisor'lar ile aynı olamaz.
  try {
    const uq = await pool.query(`SELECT 1 FROM users WHERE lower(btrim(username))=lower($1) LIMIT 1`, [username]);
    if (uq.rowCount) return res.status(409).json({ error: 'usernameTaken', message: getErrorMessage(req, 'usernameTaken') });

    const eq = await pool.query(
      `SELECT 1 FROM users
        WHERE lower(btrim(email))=lower($1)
          AND NOT (role='company' AND dependent_company=$2)
        LIMIT 1`,
      [email, companyId]
    );
    if (eq.rowCount) return res.status(409).json({ error: 'emailTakenOutsideCompany', message: getErrorMessage(req, 'emailTakenOutsideCompany') });
  } catch (e) {
    return res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }

  // E-posta NULL kaydedilebilsin diye (eski kurulumlarda NOT NULL olabilir)
  try { await pool.query(`ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL`); } catch (e) {}
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.password_plain', $1, true)`, [password]);
    const hashPw = await bcrypt.hash(password, 10);
    const twoFactorSecretPlain = normalizeBase32(base32Raw);
    const r = await client.query(
      `INSERT INTO users (username, password_hash, role, name, surname, email, email_verified, is_verified, is_active,
                          two_factor_secret, two_factor_enabled, dependent_company)
       VALUES ($1,$2,'company',$3,$4,$5,true,true,true,$6,true,$7)
       RETURNING id, username, role, dependent_company`,
      [username, hashPw, name, surname, email, twoFactorSecretPlain, companyId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    if (e.code === 'P0001' || e.code === 'P0002' || e.code === 'P0003') return res.status(400).json({ error: 'gecersiz', message: e.message });
    if (e.code === '23505' && String(e.constraint || '') === 'users_username_key') {
      return res.status(409).json({ error: 'usernameTaken', message: getErrorMessage(req, 'usernameTaken') });
    }
    if (e.code === '23505') return res.status(409).json({ error: 'base32_cakisma', message: getErrorMessage(req, 'base32_cakisma') });
    console.error('create company user error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  } finally {
    try { await client.query(`SELECT set_config('app.password_plain', NULL, true)`); } catch {}
    client.release();
  }
});

// Bir şirketin siparişleri
app.get('/api/admin/companies/:id/orders', adminOnly, async (req, res) => {
  try {
    await ensureOrdersSchema();
    const r = await pool.query(
      `SELECT order_id, person_placing_order, scanned_by, order_amount_before_discount, order_amount_after_discount,
              discount_percentage, points_spent, order_date
         FROM public.orders WHERE company_id=$1 ORDER BY order_date DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('GET company orders error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Giriş yapan company kullanıcısının şirketi + menü/indirim ayarları
app.get('/api/company/me', requireAuth, requireAnyRole(['company']), async (req, res) => {
  try {
    const u = await pool.query(`SELECT dependent_company FROM users WHERE id=$1`, [req.user.id]);
    const cid = u.rows[0] && u.rows[0].dependent_company;
    if (!cid) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    const c = await pool.query(
      `SELECT company_id, company_name, logo_url, discount_percentage, discount_threshold_point
         FROM public.companies WHERE company_id=$1`, [cid]);
    if (!c.rows.length) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    res.json({ username: req.user.username, company: c.rows[0] });
  } catch (e) {
    console.error('GET /api/company/me error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Company kullanıcısının kendi şirketinin siparişleri (profil tablosu gibi responsive gösterim için)
app.get('/api/company/orders', requireAuth, requireAnyRole(['company']), async (req, res) => {
  try {
    const u = await pool.query(`SELECT dependent_company FROM users WHERE id=$1`, [req.user.id]);
    const cid = u.rows[0] && u.rows[0].dependent_company;
    if (!cid) return res.json([]);
    await ensureOrdersSchema();
    const r = await pool.query(
      `SELECT order_id, person_placing_order, order_amount_before_discount, order_amount_after_discount,
              discount_percentage, order_date
         FROM public.orders WHERE company_id=$1 ORDER BY order_date DESC`,
      [cid]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/company/orders error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Company kullanıcısı menü/indirim/eşik ayarlarını kaydeder
app.patch('/api/company/config', requireAuth, requireAnyRole(['company']), async (req, res) => {
  try {
    const u = await pool.query(`SELECT dependent_company FROM users WHERE id=$1`, [req.user.id]);
    const cid = u.rows[0] && u.rows[0].dependent_company;
    if (!cid) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    let dp = req.body && req.body.discount_percentage;
    dp = (dp != null && dp !== '' && Number.isFinite(Number(dp))) ? Math.max(0, Math.min(100, Math.round(Number(dp)))) : null;
    let thr = req.body && req.body.discount_threshold_point;
    thr = (thr != null && thr !== '' && Number.isFinite(Number(thr))) ? Math.max(0, Math.round(Number(thr))) : null;
    await pool.query(
      `UPDATE public.companies SET discount_percentage=$1, discount_threshold_point=$2 WHERE company_id=$3`,
      [dp, thr, cid]
    );
    res.json({ ok: true, discount_percentage: dp, discount_threshold_point: thr });
  } catch (e) {
    console.error('PATCH /api/company/config error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

/* ===================== QR (indirim) altyapısı ===================== */
function _b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signQrToken(payload) {
  const body = _b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = _b64url(crypto.createHmac('sha256', JWT_SECRET).update(body).digest());
  return body + '.' + sig;
}
function verifyQrToken(token) {
  try {
    if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = _b64url(crypto.createHmac('sha256', JWT_SECRET).update(body).digest());
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!json || typeof json !== 'object') return null;
    if (json.exp && (Date.now() / 1000) > Number(json.exp)) return null;
    return json;
  } catch { return null; }
}
// Kullanıcının harcanabilir puanı = posts_point − toplam harcanan (orders.points_spent)
async function userEffectivePoints(username) {
  const u = await pool.query(
    `SELECT id, username, name, surname, COALESCE(posts_point,0) AS posts_point
       FROM users WHERE lower(btrim(username))=lower($1) AND role IS DISTINCT FROM 'company' LIMIT 1`, [username]);
  if (!u.rows.length) return null;
  const row = u.rows[0];
  let spent = 0;
  const t = await pool.query(`SELECT to_regclass('public.orders') AS t`);
  if (t.rows[0].t) {
    const s = await pool.query(`SELECT COALESCE(SUM(points_spent),0)::int AS s FROM public.orders WHERE person_placing_order=$1`, [row.username]);
    spent = s.rows[0].s || 0;
  }
  return { id: row.id, username: row.username, name: row.name || '', surname: row.surname || '', posts_point: row.posts_point, spent, effective: Math.max(0, row.posts_point - spent) };
}

// Opener/solver: kendi puanına göre tek kullanımlık QR üretir (5 dk geçerli)
app.post('/api/qr/generate', requireAuth, requireAnyRole(['user']), async (req, res) => {
  try {
    const eff = await userEffectivePoints(req.user.username);
    const points = eff ? eff.effective : 0;
    const payload = { u: req.user.username, p: points, exp: Math.floor(Date.now() / 1000) + 300, n: crypto.randomBytes(9).toString('hex') };
    res.json({ ok: true, token: signQrToken(payload), points, expires_in: 300 });
  } catch (e) {
    console.error('POST /api/qr/generate error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

async function _companyCfgFor(userId) {
  const cu = await pool.query(`SELECT dependent_company FROM users WHERE id=$1`, [userId]);
  const cid = cu.rows[0] && cu.rows[0].dependent_company;
  if (!cid) return null;
  const cc = await pool.query(`SELECT company_id, discount_percentage, discount_threshold_point FROM companies WHERE company_id=$1`, [cid]);
  if (!cc.rows.length) return null;
  return cc.rows[0];
}

// Company: QR okut → uygunluk + kullanıcı bilgisi + menü döner
app.post('/api/company/scan', requireAuth, requireAnyRole(['company']), async (req, res) => {
  try {
    const payload = verifyQrToken(req.body && req.body.token);
    if (!payload || !payload.u) return res.status(400).json({ error: 'qr_invalid', message: getErrorMessage(req, 'qr_invalid') });
    const cfg = await _companyCfgFor(req.user.id);
    if (!cfg) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    if (cfg.discount_threshold_point == null || cfg.discount_percentage == null) {
      return res.status(400).json({ error: 'company_params_missing', message: getErrorMessage(req, 'company_params_missing') });
    }
    const eff = await userEffectivePoints(payload.u);
    if (!eff) return res.status(404).json({ error: 'accountNotFound', message: getErrorMessage(req, 'accountNotFound') });
    res.json({
      ok: true,
      eligible: eff.effective >= cfg.discount_threshold_point,
      username: eff.username, name: eff.name, surname: eff.surname,
      points: eff.effective, threshold: cfg.discount_threshold_point,
      discount_percentage: cfg.discount_percentage
    });
  } catch (e) {
    console.error('POST /api/company/scan error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  }
});

// Company: sipariş oluştur (atomik) + eşik kadar puan düş (points_spent) + QR tek kullanımlık
app.post('/api/company/order', requireAuth, requireAnyRole(['company']), async (req, res) => {
  const payload = verifyQrToken(req.body && req.body.token);
  if (!payload || !payload.u || !payload.n) return res.status(400).json({ error: 'qr_invalid', message: getErrorMessage(req, 'qr_invalid') });
  // Ürün/menü seçimi kaldırıldı: şirket kullanıcısı hesap tutarını elle girer.
  // "200,5" ve "200.5" aynı değer olarak kabul edilir; metin değer reddedilir.
  const amountRaw = (req.body && (req.body.amount ?? req.body.order_amount));
  const amount = Number(String(amountRaw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
    return res.status(400).json({ error: 'invalidAmount', message: getErrorMessage(req, 'invalidAmount') });
  }

  let cfg;
  try {
    cfg = await _companyCfgFor(req.user.id);
    if (!cfg) return res.status(404).json({ error: 'bulunamadi', message: getErrorMessage(req, 'bulunamadi') });
    if (cfg.discount_threshold_point == null || cfg.discount_percentage == null) {
      return res.status(400).json({ error: 'company_params_missing', message: getErrorMessage(req, 'company_params_missing') });
    }
  } catch (e) { return res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') }); }

  await ensureOrdersSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS public.used_qr_nonces (nonce text PRIMARY KEY, used_at timestamptz NOT NULL DEFAULT now())`);
    try {
      await client.query(`INSERT INTO public.used_qr_nonces (nonce) VALUES ($1)`, [payload.n]);
    } catch (dup) {
      await client.query('ROLLBACK');
      if (dup.code === '23505') return res.status(409).json({ error: 'qr_used', message: getErrorMessage(req, 'qr_used') });
      throw dup;
    }
    const ur = await client.query(`SELECT id, username, COALESCE(posts_point,0) AS posts_point FROM users WHERE lower(btrim(username))=lower($1) AND role IS DISTINCT FROM 'company' FOR UPDATE`, [payload.u]);
    if (!ur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'accountNotFound', message: getErrorMessage(req, 'accountNotFound') }); }
    const uname = ur.rows[0].username;
    const sp = await client.query(`SELECT COALESCE(SUM(points_spent),0)::int AS s FROM public.orders WHERE person_placing_order=$1`, [uname]);
    const effective = Math.max(0, ur.rows[0].posts_point - (sp.rows[0].s || 0));
    if (effective < cfg.discount_threshold_point) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'not_eligible', message: getErrorMessage(req, 'not_eligible') }); }
    const before = Math.round(amount * 100) / 100;
    const after = Math.round(before * (1 - cfg.discount_percentage / 100) * 100) / 100;
    const ins = await client.query(
      `INSERT INTO public.orders (company_id, person_placing_order, order_amount_before_discount, order_amount_after_discount, discount_percentage, points_spent, scanned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING order_id`,
      // scanned_by: QR'ı okutan şirket kullanıcısının users.username değeri
      [cfg.company_id, uname, before, after, cfg.discount_percentage, cfg.discount_threshold_point, req.user.username]
    );
    await client.query('COMMIT');
    res.json({ ok: true, order_id: ins.rows[0].order_id, amount_before: before, amount_after: after, discount_percentage: cfg.discount_percentage, points_spent: cfg.discount_threshold_point, remaining_points: effective - cfg.discount_threshold_point });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /api/company/order error:', e);
    res.status(500).json({ error: 'veritabani_hatasi', message: getErrorMessage(req, 'veritabani_hatasi') });
  } finally {
    client.release();
  }
});

/* ===================== Upload Uçları ===================== */
app.post('/api/upload/photo', requireAuth, upload.array('files', 10), (req, res) => {
  try {
    if (req.files && req.files.length) {
      const urls = (req.files || []).map((f) => `/uploads/${path.basename(f.path)}`);
      return res.json({ ok: true, urls, url: urls[0] || null });
    }
    if (req.is('application/json') && req.body && req.body.dataUrl) {
      const url = saveDataUrlToUploads(req.body.dataUrl, 'photo');
      return res.json({ ok: true, urls: [url], url });
    }
    return res.status(400).json({ error: 'yukleme_hatasi', message: getErrorMessage(req, 'yukleme_hatasi') });
  } catch (e) {
    console.error('upload photo error:', e);
    res.status(400).json({ error: 'yukleme_hatasi', message: getErrorMessage(req, 'yukleme_hatasi') });
  }
});

app.post('/api/upload/video', requireAuth, upload.array('files', 10), (req, res) => {
  try {
    if (req.files && req.files.length) {
      const urls = (req.files || []).map((f) => `/uploads/${path.basename(f.path)}`);
      return res.json({ ok: true, urls, url: urls[0] || null });
    }
    if (req.is('application/json') && req.body && req.body.dataUrl) {
      const url = saveDataUrlToUploads(req.body.dataUrl, 'video');
      return res.json({ ok: true, urls: [url], url });
    }
    return res.status(400).json({ error: 'yukleme_hatasi', message: getErrorMessage(req, 'yukleme_hatasi') });
  } catch (e) {
    console.error('upload video error:', e);
    res.status(400).json({ error: 'yukleme_hatasi', message: getErrorMessage(req, 'yukleme_hatasi') });
  }
});


app.get('/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.set('Content-Type', 'text/plain').send('OK');
  } catch {
    res.status(500).send('DB NOK');
  }
});

app.get(
  ['/login', '/register', '/forgot', '/admin', '/supervisor', '/panel', '/dashboard'],
  (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
);

/* ===================== Server ===================== */
async function ensureOlaylarSchema(){
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS is_point boolean DEFAULT true`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS is_line boolean DEFAULT false`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS is_polygon boolean DEFAULT false`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS layer_table text`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS attribute_column text`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS time_dependent boolean DEFAULT false`);
    await client.query(`ALTER TABLE public.event_type ADD COLUMN IF NOT EXISTS valid_time double precision`);
    // Menü/ürün özelliği kaldırıldı → ilgili kolonlar açılışta düşürülür (varsa).
    try { await client.query(`ALTER TABLE public.companies DROP COLUMN IF EXISTS menu`); } catch (e) {}
    try { await client.query(`ALTER TABLE public.orders DROP COLUMN IF EXISTS items`); } catch (e) {}
  } catch(e) {
    console.error('[SCHEMA] event_type column ekleme hatası:', e.message);
  } finally {
    client.release();
  }
}

ensureOlaylarSchema().then(() => {
  // Rotalama (OSRM) konteynerlerini Docker açıksa otomatik başlat
  try { autoStartOsrmContainers(); } catch (e) { console.warn('[ROUTE] autostart error:', e.message); }
  // Harita dosyasının durumunu (yol verisi var mı?) konsola yaz
  try { if (String(process.env.OSRM_AUTOSTART || 'true').toLowerCase() === 'false') logRoutingMapStatus(); } catch {}

  const server = app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

  // Yuk altinda baglanti kopmasini onle
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // Time-dependent expiry: run once at startup and then periodically so events
  // are deactivated (active=false, deactivated_at set) promptly even when no one
  // is refreshing the map. The reads (/api/events_all) also sweep on demand.
  deactivateExpiredEvents().catch(() => {});
  setInterval(() => { deactivateExpiredEvents().catch(() => {}); }, 60 * 1000);
});

// QField ve LISTEN/NOTIFY sadece worker 0'da calissin (tekrar onleme)
if (process.env.WORKER_ID === '0') {
  startQFieldIngestLoop();
}

const shutdown = async () => {
  try { if (listenClient) listenClient.release(); } catch {}
  try { await pool.end(); } catch {}
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);