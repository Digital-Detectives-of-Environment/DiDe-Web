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
const CASE_STUDY_NAME = process.env.CASE_STUDY || 'Milano';
const RASTER_DIR = path.join(__dirname, 'case_study', CASE_STUDY_NAME, 'raw_data', 'Raster');

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
        `SELECT id, username, role, email, COALESCE(is_active,true) AS is_active
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
    req.user = { id: u.id, username: u.username, role: u.role, email: u.email };
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
      `SELECT id, username, role, email, COALESCE(is_active,true) AS is_active
       FROM users WHERE id=$1`,
      [payload.sub]
    );
    if (rows.length && rows[0].is_active) {
      const u = rows[0];
      req.user = { id: u.id, username: u.username, role: u.role, email: u.email };
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
        SELECT 1 INTO v_dummy FROM public.users u
        WHERE (lower(btrim(u.username)) = lower(COALESCE(NEW.username,'')) OR lower(btrim(u.email)) = lower(COALESCE(NEW.email,'')))
        LIMIT 1;
        IF FOUND THEN RAISE EXCEPTION 'active_username_or_email_exists' USING ERRCODE='P0002'; END IF;
      ELSIF TG_OP='UPDATE' THEN
        IF COALESCE(OLD.is_active,false)=false AND COALESCE(NEW.is_active,true)=true THEN RETURN NEW; END IF;

        IF (COALESCE(NEW.username,'') IS DISTINCT FROM COALESCE(OLD.username,''))
           OR (COALESCE(NEW.email,'') IS DISTINCT FROM COALESCE(OLD.email,'')) THEN
          SELECT 1 INTO v_dummy FROM public.users u
          WHERE u.id <> NEW.id
            AND (lower(btrim(u.username)) = lower(COALESCE(NEW.username,'')) OR lower(btrim(u.email)) = lower(COALESCE(NEW.email,'')))
          LIMIT 1;
          IF FOUND THEN RAISE EXCEPTION 'active_username_or_email_exists' USING ERRCODE='P0002'; END IF;
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

      IF NEW.role IS DISTINCT FROM 'supervisor' THEN
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
        WHERE u.role='supervisor'
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
  const name = req.body?.name || null;
  const surname = req.body?.surname || null;
  const email = norm(req.body?.email);

  if (!username || !password || !email)
    return res.status(400).json({ error: 'eksik_bilgi', message: getErrorMessage(req, 'eksik_bilgi') });
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
       LIMIT 1`,
      [input]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'accountNotFound', message: getErrorMessage(req, 'accountNotFound') });
    }

    const u = rows[0];
    if (!u.is_active) return res.status(403).json({ error: 'kullanici_pasif', message: getErrorMessage(req, 'kullanici_pasif') });

    const ok = await bcrypt.compare(password, u.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'wrongPassword', message: getErrorMessage(req, 'wrongPassword') });
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
      'SELECT id, username, email, COALESCE(is_active,true) AS is_active FROM users WHERE lower(btrim(email))=lower($1) LIMIT 1',
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
    const { rows } = await pool.query('SELECT id, reset_code, reset_expires FROM users WHERE lower(btrim(email))=lower($1) LIMIT 1', [email]);
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
      'SELECT id, reset_code, reset_expires FROM users WHERE lower(btrim(email))=lower($1) LIMIT 1',
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
app.get('/api/event_types', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT event_type_id, event_type_name, "public_" AS "public", created_by_id, created_by_name,
             is_point, is_line, is_polygon 
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
        o.description,
        o.created_by_id              AS created_by_id,
        o.created_by_name            AS created_by_username,
        o.created_by_role_name       AS created_by_role_name,
        o.created_at,
        o.updated_by_name,
        o.updated_by_role_name,
        o.photo_urls,
        o.video_urls,
        ${POLYGON_PKS.map(p => `o."${p.safeName}"`).join(',\n        ')}${POLYGON_PKS.length > 0 ? ',' : ''}
        ((o.created_by_id = $1) OR (o.created_by_name = $2)) AS is_mine
      FROM event o
      LEFT JOIN event_type l ON l.event_type_id = o.event_type
      WHERE COALESCE(o.active, true) = true
      ORDER BY o.event_id DESC
      `,
      [myId, myUser]
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
    const { p_id, event_type, description, latitude, longitude } = req.body || {};
    const lat = parseFloat(latitude), lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      return res.status(400).json({ error: 'gecersiz_koordinat', message: getErrorMessage(req, 'gecersiz_koordinat') });

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
                         photo_urls, video_urls${pkColumns})
       VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($2,$1),4326),
               $5, $6, $7, true,
               $8::text, $9::text${pkPlaceholders})
       RETURNING event_id`,
      [lat, lng, olayTuruId, description ?? null, req.user.username, req.user.role, req.user.id, toJsonText(photoUrls), toJsonText(videoUrls), ...pkVals]
    );
    const event_id = ins.rows[0].event_id;

    const pId = p_id === '' || p_id == null ? null : parseInt(p_id, 10);
    if (Number.isInteger(pId)) await pool.query('INSERT INTO kayit (p_id, event_id) VALUES ($1,$2)', [pId, event_id]);


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
app.post('/api/admin/event_types', adminOnly, async (req, res) => {
  const event_type_name = norm(req.body?.event_type_name);
  const isPublic = req.body?.["public"] === true || req.body?.["public"] === 'true';
  
  if (!event_type_name) return res.status(400).json({ error: 'o_adi_gerekli', message: getErrorMessage(req, 'o_adi_gerekli') });
  try {
    const existing = await pool.query(
      `SELECT event_type_id, active FROM event_type WHERE LOWER(event_type_name) = LOWER($1)`,
      [event_type_name]
    );
    
    if (existing.rowCount > 0) {
      return res.status(409).json({ 
        error: 'duplicate_event_type',
        message: getErrorMessage(req, 'duplicate_event_type')
      });
    }
    
    const r = await pool.query(
      `INSERT INTO event_type (event_type_name, active, "public_", created_by_name, created_by_role_name, created_by_id)
       VALUES ($1, true, $2, $3, $4, $5)
       RETURNING event_type_id, event_type_name, "public_" AS "public", created_by_name, created_by_id, created_at`,
      [event_type_name, isPublic, req.user.username, req.user.role, req.user.id]
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
              registration_date
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
                             created_by_name, created_by_role_name, created_by_id, active${pkColumns})
           VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($2,$1),4326),
                   $5, $6, $7, true${pkPlaceholders})`,
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
  } catch(e) {
    console.error('[SCHEMA] event_type column ekleme hatası:', e.message);
  } finally {
    client.release();
  }
}

ensureOlaylarSchema().then(() => {
  const server = app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

  // Yuk altinda baglanti kopmasini onle
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
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