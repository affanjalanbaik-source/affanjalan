'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = __dirname;
const dataDir = path.join(rootDir, 'data');
const uploadsDir = path.join(rootDir, 'uploads');
const previewsDir = path.join(rootDir, 'previews');
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(dataDir, 'orders.sqlite'));
const privateBeatDir = path.resolve(process.env.PRIVATE_BEAT_DIR || path.join(rootDir, 'private-beats'));

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(previewsDir, { recursive: true });
fs.mkdirSync(privateBeatDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');
const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const SESSION_SECRET = process.env.SESSION_SECRET || 'affan-sound-secret';

function getPayPalAuthHeader() {
  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  const secret = process.env.PAYPAL_CLIENT_SECRET || '';
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
}

function isPayPalConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function normalizeLicenseId(value) {
  return String(value || '').trim().toLowerCase();
}

const defaultBeats = [
  { id: 'nightshift', title: 'NIGHTSHIFT', genre: 'R&B / Trap', bpm: 142, key: 'F#m', description: 'Warm melodic trap textures built for late-night hooks and moody releases.', status: 'available' },
  { id: 'no-signal', title: 'NO SIGNAL', genre: 'Jerk', bpm: 160, key: 'C#m', description: 'Tight percussion and shape-shifting synth motion for energetic, high-impact tracks.', status: 'available' },
  { id: 'after-hours', title: 'AFTER HOURS', genre: 'Melodic Trap', bpm: 136, key: 'G#m', description: 'Cinematic melodic tension with a polished, modern release-ready flow.', status: 'available' },
  { id: 'cold-heart', title: 'COLD HEART', genre: 'R&B', bpm: 118, key: 'Am', description: 'A spacious, emotional R&B foundation with a smooth late-night feel.', status: 'available' },
  { id: 'offline', title: 'OFFLINE', genre: 'Rage', bpm: 154, key: 'Dm', description: 'Dark, aggressive movement for harder-edged hip-hop and hybrid release styles.', status: 'available' },
  { id: '2am-again', title: '2AM AGAIN', genre: 'Ambient Trap', bpm: 130, key: 'Em', description: 'Atmospheric and introspective with soft leads, tape textures, and spacious rhythm.', status: 'available' }
];

const defaultLicenses = [
  { id: 'basic', name: 'Basic Lease', price: 150, description: 'Starter usage', formats: 'MP3', terms: 'Non-exclusive lease for demos and short-term projects.', available: 1 },
  { id: 'premium', name: 'Premium Lease', price: 240, description: 'Expanded usage', formats: 'MP3 + WAV', terms: 'Broader commercial usage within a defined release scope.', available: 1 },
  { id: 'exclusive', name: 'Exclusive License', price: 600, description: 'Full exclusive rights', formats: 'MP3 + WAV + stems', terms: 'Exclusive rights are subject to availability and confirmation before capture.', available: 1 }
];

const schemaSql = `
  CREATE TABLE IF NOT EXISTS beats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    genre TEXT,
    bpm INTEGER,
    key_name TEXT,
    description TEXT,
    cover_url TEXT,
    preview_url TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    is_exclusive_sold INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT NOT NULL,
    beat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    description TEXT,
    formats TEXT,
    terms TEXT,
    available INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (beat_id, id),
    FOREIGN KEY (beat_id) REFERENCES beats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT,
    customer_email TEXT,
    total_usd REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    beat_id TEXT NOT NULL,
    license_id TEXT NOT NULL,
    title TEXT NOT NULL,
    license_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price_usd REAL NOT NULL,
    total_usd REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payment_records (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    paypal_order_id TEXT,
    paypal_capture_id TEXT,
    status TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    currency TEXT NOT NULL,
    raw_payload TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    beat_id TEXT NOT NULL,
    license_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    file_path TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );
`;

db.exec(schemaSql);

function seedCatalog() {
  const beatInsert = db.prepare('INSERT OR IGNORE INTO beats (id, title, genre, bpm, key_name, description, status) VALUES (@id, @title, @genre, @bpm, @key, @description, @status)');
  const licenseInsert = db.prepare('INSERT OR IGNORE INTO licenses (id, beat_id, name, price, description, formats, terms, available) VALUES (@id, @beat_id, @name, @price, @description, @formats, @terms, @available)');

  for (const beat of defaultBeats) {
    beatInsert.run({ ...beat, key: beat.key || '' });
    for (const license of defaultLicenses) {
      licenseInsert.run({
        id: license.id,
        beat_id: beat.id,
        name: license.name,
        price: Number(license.price || 0),
        description: license.description,
        formats: license.formats,
        terms: license.terms,
        available: 1
      });
    }
  }
}

seedCatalog();

function getBeatLicenses(beatId) {
  const rows = db.prepare('SELECT * FROM licenses WHERE beat_id = ? ORDER BY CASE id WHEN "basic" THEN 1 WHEN "premium" THEN 2 WHEN "exclusive" THEN 3 ELSE 4 END').all(beatId);
  return rows.map((row) => ({
    id: row.id,
    beatId: row.beat_id,
    name: row.name,
    price: Number(row.price || 0),
    description: row.description || '',
    formats: row.formats || '',
    terms: row.terms || '',
    available: Number(row.available || 0) === 1,
    status: Number(row.available || 0) === 1 ? 'available' : 'unavailable'
  }));
}

function getPublicCatalog() {
  const rows = db.prepare('SELECT * FROM beats WHERE status != ? ORDER BY created_at DESC').all('archived');
  return rows.map((beat) => ({
    id: beat.id,
    title: beat.title,
    genre: beat.genre,
    bpm: Number(beat.bpm || 0),
    key: beat.key_name || '',
    description: beat.description || '',
    cover: beat.cover_url || '',
    preview: beat.preview_url || '',
    status: beat.status || 'available',
    isExclusiveSold: Number(beat.is_exclusive_sold || 0) === 1,
    licenses: getBeatLicenses(beat.id)
  }));
}

function validateCart(items) {
  const list = Array.isArray(items) ? items : [];
  const normalized = [];
  let total = 0;

  for (const item of list) {
    const beatId = String(item.beatId || '').trim();
    const licenseId = normalizeLicenseId(item.licenseId);
    const quantity = Math.max(1, Number(item.quantity || item.qty || 1));

    if (!beatId || !licenseId) {
      throw new Error('Each cart item requires a beat and a selected license.');
    }

    const beat = db.prepare('SELECT * FROM beats WHERE id = ?').get(beatId);
    if (!beat) throw new Error(`Beat not found: ${beatId}`);
    if (beat.status === 'archived' || Number(beat.is_exclusive_sold) === 1) {
      throw new Error(`${beat.title} is not currently available.`);
    }

    const license = db.prepare('SELECT * FROM licenses WHERE beat_id = ? AND id = ?').get(beatId, licenseId);
    if (!license) throw new Error(`License not found for ${beat.title}: ${licenseId}`);
    if (Number(license.available || 0) !== 1) {
      throw new Error(`${beat.title} license is unavailable.`);
    }

    const subtotal = Number(license.price) * quantity;
    total += subtotal;
    normalized.push({ beatId, licenseId, quantity, beat, license, subtotal });
  }

  return { normalized, total };
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ ok: false, error: 'Administrator login required.' });
  }
  return next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const isAudio = /audio|mpeg|wav|mp3/.test(file.mimetype) || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.originalname);
      cb(null, isAudio ? previewsDir : uploadsDir);
    },
    filename: (req, file, cb) => {
      const base = String(file.originalname || 'upload').replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
      const ext = path.extname(file.originalname || '.png');
      cb(null, `${Date.now()}-${base || 'file'}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com'],
      connectSrc: ["'self'", 'https://api-m.paypal.com', 'https://api-m.sandbox.paypal.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      frameSrc: ["'self'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com']
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 8 }
}));

app.use('/uploads', express.static(uploadsDir));
app.use('/previews', express.static(previewsDir));
app.use(express.static(rootDir));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' }
}));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', currency: 'USD', paypalConfigured: isPayPalConfigured(), environment: PAYPAL_ENV });
});

app.get('/api/config', (req, res) => {
  res.json({ currency: 'USD', siteName: 'AFFANJALANBAIK', paypalConfigured: isPayPalConfigured(), environment: PAYPAL_ENV });
});

app.get('/api/catalog', (req, res) => {
  res.json({ currency: 'USD', beats: getPublicCatalog() });
});

app.get('/api/paypal/config', (req, res) => {
  if (!isPayPalConfigured()) {
    return res.status(503).json({ ok: false, error: 'PayPal Sandbox credentials are not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your environment.', clientId: '', currency: 'USD', configured: false, sandbox: true });
  }
  return res.json({ ok: true, clientId: process.env.PAYPAL_CLIENT_ID, currency: 'USD', configured: true, sandbox: PAYPAL_ENV === 'sandbox' });
});

app.post('/api/paypal/orders', async (req, res) => {
  try {
    if (!isPayPalConfigured()) {
      return res.status(503).json({ ok: false, error: 'PayPal Sandbox is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first.' });
    }

    const { items = [], customer = {} } = req.body || {};
    const { normalized, total } = validateCart(items);

    const payload = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: `affan-${Date.now()}`,
        description: 'AFFANJALANBAIK beat marketplace order',
        amount: {
          currency_code: 'USD',
          value: Number(total).toFixed(2),
          breakdown: {
            item_total: { currency_code: 'USD', value: Number(total).toFixed(2) }
          }
        },
        items: normalized.map((item) => ({
          name: `${item.beat.title} - ${item.license.name}`,
          unit_amount: { currency_code: 'USD', value: Number(item.license.price).toFixed(2) },
          quantity: String(item.quantity),
          category: 'DIGITAL_GOODS'
        }))
      }],
      application_context: {
        brand_name: 'AFFANJALANBAIK',
        landing_page: 'BILLING',
        user_action: 'PAY_NOW',
        return_url: `${PUBLIC_ORIGIN}/#checkout`,
        cancel_url: `${PUBLIC_ORIGIN}/#checkout`
      }
    };

    const response = await fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getPayPalAuthHeader(),
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.id) {
      return res.status(502).json({ ok: false, error: body.message || 'PayPal rejected the order request.', details: body });
    }

    return res.json({ ok: true, id: body.id, status: body.status, total: Number(total).toFixed(2), currency: 'USD', customer });
  } catch (error) {
    console.error('Create PayPal order error:', error);
    return res.status(400).json({ ok: false, error: error.message || 'Unable to create PayPal order.' });
  }
});

app.post('/api/paypal/orders/:id/capture', async (req, res) => {
  try {
    if (!isPayPalConfigured()) {
      return res.status(503).json({ ok: false, error: 'PayPal Sandbox is not configured. Setup is required before purchase verification.' });
    }

    const { id } = req.params;
    const { items = [], customer = {} } = req.body || {};
    const { normalized, total } = validateCart(items);

    const response = await fetch(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: getPayPalAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.id) {
      return res.status(502).json({ ok: false, error: body.message || 'Unable to capture PayPal order.', details: body });
    }

    if (body.status !== 'COMPLETED') {
      return res.status(402).json({ ok: false, error: 'The PayPal order has not been completed.', status: body.status || 'PENDING' });
    }

    const capture = body.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) {
      return res.status(400).json({ ok: false, error: 'PayPal capture response does not contain payment details.' });
    }

    const captureAmount = Number(capture.amount?.value || 0);
    if (Math.abs(captureAmount - total) > 0.02) {
      return res.status(400).json({ ok: false, error: 'Captured amount does not match the store total. Payment verification failed.' });
    }

    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO orders (id, customer_name, customer_email, total_usd, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(orderId, customer.name || 'Customer', customer.email || 'customer@example.com', total, 'PAID', now);

    const itemInsert = db.prepare('INSERT INTO order_items (id, order_id, beat_id, license_id, title, license_name, quantity, unit_price_usd, total_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const item of normalized) {
      const itemId = crypto.randomUUID();
      itemInsert.run(itemId, orderId, item.beatId, item.licenseId, item.beat.title, item.license.name, item.quantity, Number(item.license.price), item.subtotal);
      if (item.licenseId === 'exclusive') {
        db.prepare('UPDATE beats SET is_exclusive_sold = 1, status = ? WHERE id = ?').run('sold-exclusive', item.beatId);
      }
    }

    db.prepare('INSERT INTO payment_records (id, order_id, paypal_order_id, paypal_capture_id, status, amount_usd, currency, raw_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), orderId, body.id, capture.id || '', 'PAID', captureAmount, capture.amount?.currency_code || 'USD', JSON.stringify(body), now);

    const downloads = [];
    for (const item of normalized) {
      const filePath = path.join(privateBeatDir, `${item.beatId}-${item.licenseId}.zip`);
      const token = crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
      db.prepare('INSERT INTO downloads (id, order_id, beat_id, license_id, token, file_path, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), orderId, item.beatId, item.licenseId, token, filePath, expiresAt, now);
      downloads.push({ title: item.beat.title, license: item.license.name, url: `/api/download/${token}`, expiresAt });
    }

    return res.json({ ok: true, status: 'PAID', orderId, captureId: capture.id || '', amount: Number(captureAmount).toFixed(2), currency: 'USD', downloads });
  } catch (error) {
    console.error('Capture PayPal order error:', error);
    return res.status(400).json({ ok: false, error: error.message || 'Unable to verify the PayPal payment.' });
  }
});

app.get('/api/download/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM downloads WHERE token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ ok: false, error: 'Download token not found.' });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ ok: false, error: 'This secure download link has expired.' });
  }
  if (!row.file_path || !fs.existsSync(row.file_path)) {
    return res.status(404).json({ ok: false, error: 'The licensed asset is not available for download yet.' });
  }
  return res.download(row.file_path, path.basename(row.file_path));
});

app.get('/api/admin/session', (req, res) => {
  res.json({ loggedIn: Boolean(req.session && req.session.admin), username: req.session && req.session.admin ? req.session.admin : null });
});

app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return res.status(403).json({ ok: false, error: 'Admin credentials are not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment.' });
  }

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid administrator credentials.' });
  }

  req.session.admin = username;
  res.json({ ok: true, message: 'Login successful.' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true, message: 'Logged out.' }));
});

function saveBeat(req, res) {
  try {
    const id = String(req.body.id || '').trim() || crypto.randomUUID();
    const title = String(req.body.title || '').trim();
    const genre = String(req.body.genre || '').trim();
    const bpm = Number(req.body.bpm || 0);
    const key = String(req.body.key || '').trim();
    const description = String(req.body.description || '').trim();
    const status = String(req.body.status || 'available').trim();
    const coverFile = req.files?.cover?.[0];
    const previewFile = req.files?.preview?.[0];
    const coverUrl = coverFile ? `/uploads/${path.basename(coverFile.path)}` : (req.body.cover_url || '');
    const previewUrl = previewFile ? `/previews/${path.basename(previewFile.path)}` : (req.body.preview_url || '');

    db.prepare(`INSERT INTO beats (id, title, genre, bpm, key_name, description, cover_url, preview_url, status, is_exclusive_sold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, genre = excluded.genre, bpm = excluded.bpm, key_name = excluded.key_name, description = excluded.description, cover_url = excluded.cover_url, preview_url = excluded.preview_url, status = excluded.status`).run(
      id,
      title,
      genre,
      bpm,
      key,
      description,
      coverUrl,
      previewUrl,
      status
    );

    const priceRows = [
      { id: 'basic', name: 'Basic Lease', price: Number(req.body.basic_price || req.body.basicPrice || 150), description: 'Starter usage', formats: 'MP3', terms: 'Non-exclusive usage for demos and early releases.', available: 1 },
      { id: 'premium', name: 'Premium Lease', price: Number(req.body.premium_price || req.body.premiumPrice || 240), description: 'Expanded usage', formats: 'MP3 + WAV', terms: 'Broader commercial usage within a defined release scope.', available: 1 },
      { id: 'exclusive', name: 'Exclusive License', price: Number(req.body.exclusive_price || req.body.exclusivePrice || 600), description: 'Full exclusive rights', formats: 'MP3 + WAV + stems', terms: 'Exclusive rights require confirmation before capture.', available: 1 }
    ];

    const upsertLicense = db.prepare(`INSERT INTO licenses (id, beat_id, name, price, description, formats, terms, available) VALUES (@id, @beat_id, @name, @price, @description, @formats, @terms, @available) ON CONFLICT(beat_id, id) DO UPDATE SET name = excluded.name, price = excluded.price, description = excluded.description, formats = excluded.formats, terms = excluded.terms, available = excluded.available`);
    for (const row of priceRows) {
      upsertLicense.run({
        id: row.id,
        beat_id: id,
        name: row.name,
        price: row.price,
        description: row.description,
        formats: row.formats,
        terms: row.terms,
        available: 1
      });
    }

    return res.json({ ok: true, id, message: 'Beat and pricing saved.' });
  } catch (error) {
    console.error('Admin beat save failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Unable to save beat.' });
  }
}

app.get('/api/admin/beats', requireAdmin, (req, res) => {
  const beats = db.prepare('SELECT * FROM beats ORDER BY created_at DESC').all();
  const byBeat = {};
  for (const beat of beats) byBeat[beat.id] = getBeatLicenses(beat.id);
  res.json({ beats: beats.map((beat) => ({ id: beat.id, title: beat.title, genre: beat.genre, bpm: Number(beat.bpm || 0), key: beat.key_name || '', description: beat.description || '', cover: beat.cover_url || '', preview: beat.preview_url || '', status: beat.status, isExclusiveSold: Number(beat.is_exclusive_sold || 0) === 1 })), licensesByBeat: byBeat });
});

app.post('/api/admin/beats', requireAdmin, upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'preview', maxCount: 1 }]), saveBeat);
app.put('/api/admin/beats/:id', requireAdmin, upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'preview', maxCount: 1 }]), (req, res) => { req.body.id = req.params.id; return saveBeat(req, res); });

app.delete('/api/admin/beats/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE beats SET status = ? WHERE id = ?').run('archived', req.params.id);
  res.json({ ok: true, message: 'Beat archived from the storefront.' });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const payload = orders.map((order) => ({
    id: order.id,
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    totalUsd: Number(order.total_usd || 0),
    status: order.status,
    createdAt: order.created_at,
    items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)
  }));
  res.json({ orders: payload });
});

app.get('/admin', (req, res) => { res.sendFile(path.join(rootDir, 'admin.html')); });
app.get('/', (req, res) => { res.sendFile(path.join(rootDir, 'index.html')); });

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ ok: false, error: 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`AFFANJALANBAIK server running at http://localhost:${port}`);
  console.log(`Admin login: ${ADMIN_USERNAME ? 'configured' : 'requires ADMIN_USERNAME and ADMIN_PASSWORD in .env'}`);
});
