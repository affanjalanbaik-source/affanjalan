'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = __dirname;
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(rootDir, 'data', 'orders.sqlite'));
const publicUploadDir = path.resolve(process.env.PUBLIC_UPLOAD_DIR || path.join(rootDir, 'uploads', 'covers'));
const privateBeatDir = path.resolve(process.env.PRIVATE_BEAT_DIR || path.join(rootDir, 'private-beats'));
const publicPreviewDir = path.resolve(process.env.PUBLIC_PREVIEW_DIR || path.join(rootDir, 'uploads', 'previews'));

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(publicUploadDir, { recursive: true });
fs.mkdirSync(publicPreviewDir, { recursive: true });
fs.mkdirSync(privateBeatDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');
const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();

const formatMoney = (value) => Number(value || 0).toFixed(2);
const currency = 'USD';
const urlSafe = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'beat';

const unauthorizedResponse = (message = 'Unauthorized') => ({ ok: false, error: message });

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json(unauthorizedResponse('Administrator login required.'));
  }
  return next();
}

function getDefaultLicenseAssignments() {
  return [
    { id: 'basic', name: 'Basic Lease', price: 150, description: 'Basic commercial lease', formats: 'MP3', terms: 'Non-exclusive usage for a single release. Contact the producer for expanded rights.', available: 1 },
    { id: 'premium', name: 'Premium Lease', price: 240, description: 'Premium lease for larger project usage', formats: 'MP3, WAV', terms: 'Expanded usage rights with a single-project release window. Contact the producer for specific terms.', available: 1 },
    { id: 'exclusive', name: 'Exclusive License', price: 600, description: 'Full exclusive rights transfer', formats: 'MP3, WAV, stems', terms: 'Exclusive rights are subject to availability and confirmation before order capture.', available: 1 }
  ];
}

const defaultBeats = [
  { id: 'nightshift', title: 'NIGHTSHIFT', genre: 'R&B / Trap', bpm: 142, key: 'F#m', description: 'Warm melodic trap textures built for late-night hooks and moody releases.', cover_url: '', preview_url: '', status: 'available', is_exclusive_sold: 0 },
  { id: 'no-signal', title: 'NO SIGNAL', genre: 'Jerk', bpm: 160, key: 'C#m', description: 'Tight percussion and shape-shifting synth motion for energetic, high-impact tracks.', cover_url: '', preview_url: '', status: 'available', is_exclusive_sold: 0 },
  { id: 'after-hours', title: 'AFTER HOURS', genre: 'Melodic Trap', bpm: 136, key: 'G#m', description: 'Cinematic melodic tension with a polished, modern release-ready flow.', cover_url: '', preview_url: '', status: 'available', is_exclusive_sold: 0 },
  { id: 'cold-heart', title: 'COLD HEART', genre: 'R&B', bpm: 118, key: 'Am', description: 'A spacious, emotional R&B foundation with a smooth late-night feel.', cover_url: '', preview_url: '', status: 'available', is_exclusive_sold: 0 },
  { id: 'offline', title: 'OFFLINE', genre: 'Rage', bpm: 154, key: 'Dm', description: 'Dark, aggressive movement for harder-edged hip-hop and hybrid release styles.', cover_url: '', preview_url: '', status: 'available', is_exclusive_sold: 0 },
  { id: '2am-again', title: '2AM AGAIN', genre: 'Ambient Trap', bpm: 130, key: 'Em', description: 'Atmospheric and introspective with soft leads, tape textures, and spacious rhythm.', cover_url: '', preview_url: '', status: 'available', is_exclusive_sold: 0 }
];

const createSchemaSql = `
  CREATE TABLE IF NOT EXISTS beats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    genre TEXT,
    bpm INTEGER,
    key_name TEXT,
    description TEXT,
    cover_url TEXT,
    preview_url TEXT,
    status TEXT DEFAULT 'available',
    is_exclusive_sold INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT,
    beat_id TEXT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    description TEXT,
    formats TEXT,
    terms TEXT,
    available INTEGER DEFAULT 1,
    PRIMARY KEY (beat_id, id),
    FOREIGN KEY (beat_id) REFERENCES beats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT,
    customer_email TEXT,
    total_usd REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    beat_id TEXT NOT NULL,
    license_id TEXT NOT NULL,
    token TEXT NOT NULL,
    file_path TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );
`;

db.exec(createSchemaSql);

function seedCatalog() {
  const insertBeat = db.prepare(`INSERT OR IGNORE INTO beats (id, title, genre, bpm, key_name, description, cover_url, preview_url, status, is_exclusive_sold) VALUES (@id, @title, @genre, @bpm, @key_name, @description, @cover_url, @preview_url, @status, @is_exclusive_sold)`);
  const insertLicense = db.prepare(`INSERT OR IGNORE INTO licenses (id, beat_id, name, price, description, formats, terms, available) VALUES (@id, @beat_id, @name, @price, @description, @formats, @terms, @available)`);

  for (const beat of defaultBeats) {
    insertBeat.run({
      ...beat,
      cover_url: beat.cover_url || '',
      preview_url: beat.preview_url || '',
      status: beat.status || 'available',
      is_exclusive_sold: Number(beat.is_exclusive_sold || 0)
    });

    for (const license of getDefaultLicenseAssignments()) {
      insertLicense.run({
        ...license,
        beat_id: beat.id,
        available: Number(license.available || 1)
      });
    }
  }
}

seedCatalog();

function toBeatRow(row) {
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    bpm: Number(row.bpm || 0),
    key: row.key_name || '',
    description: row.description || '',
    cover: row.cover_url || '',
    preview: row.preview_url || '',
    status: row.status || 'available',
    isExclusiveSold: Number(row.is_exclusive_sold || 0) === 1,
    createdAt: row.created_at
  };
}

function toLicenseRow(row) {
  return {
    id: row.id,
    beatId: row.beat_id,
    name: row.name,
    price: Number(row.price || 0),
    description: row.description || '',
    formats: row.formats || '',
    terms: row.terms || '',
    available: Number(row.available || 0) === 1,
    status: Number(row.available || 0) === 1 ? 'available' : 'unavailable'
  };
}

function getBeatLicenses(beatId) {
  const rows = db.prepare('SELECT * FROM licenses WHERE beat_id = ? ORDER BY CASE id WHEN "basic" THEN 1 WHEN "premium" THEN 2 WHEN "exclusive" THEN 3 ELSE 4 END').all(beatId);
  return rows.map(toLicenseRow);
}

function getCatalog() {
  const rows = db.prepare('SELECT * FROM beats WHERE status != ? ORDER BY created_at DESC').all('sold-exclusive');
  const beats = rows.map(toBeatRow);
  const licensesByBeat = {};
  for (const beat of beats) {
    licensesByBeat[beat.id] = getBeatLicenses(beat.id);
  }
  return { beats, licensesByBeat };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isAudio = /audio|mpeg|wav|mp3/.test(file.mimetype) || /\.(mp3|wav|ogg|aac|m4a)$/i.test(file.originalname);
    cb(null, isAudio ? publicPreviewDir : publicUploadDir);
  },
  filename: (req, file, cb) => {
    const safeBase = urlSafe(file.originalname.replace(/\.[^.]+$/, ''));
    const extension = path.extname(file.originalname) || '.png';
    cb(null, `${Date.now()}-${safeBase}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname) return cb(new Error('Invalid file'));
    cb(null, true);
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://www.paypal.com", "https://www.sandbox.paypal.com"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api-m.sandbox.paypal.com', 'https://api-m.paypal.com'],
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
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' }
});
app.use('/api', limiter);

app.use('/uploads', express.static(publicUploadDir));
app.use('/previews', express.static(publicPreviewDir));

function paypalConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function getPayPalAuthHeader() {
  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  const secret = process.env.PAYPAL_CLIENT_SECRET || '';
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', currency, paypalConfigured: paypalConfigured(), environment: PAYPAL_ENV });
});

app.get('/api/config', (req, res) => {
  res.json({ currency, siteName: 'AFFANJALANBAIK', tagLine: 'FIND YOUR SOUND', paypalConfigured: paypalConfigured(), environment: PAYPAL_ENV });
});

app.get('/api/catalog', (req, res) => {
  res.json(getCatalog());
});

app.get('/api/licenses', (req, res) => {
  const rows = db.prepare('SELECT * FROM licenses ORDER BY beat_id, id').all();
  res.json(rows.map(toLicenseRow));
});

app.get('/api/paypal/config', (req, res) => {
  if (!paypalConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'PayPal Sandbox credentials are not configured yet. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env before checkout can work.',
      clientId: '',
      currency: 'USD',
      setupRequired: true,
      configured: false
    });
  }

  return res.json({
    ok: true,
    clientId: process.env.PAYPAL_CLIENT_ID,
    currency: 'USD',
    sandbox: PAYPAL_ENV === 'sandbox',
    configured: true,
    setupRequired: false
  });
});

function validateCartItems(items) {
  const normalized = [];
  let total = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const beatId = String(item.beatId || '').trim();
    const licenseId = String(item.licenseId || '').trim();
    const quantity = Math.max(1, Number(item.quantity || item.qty || 1));
    const beat = db.prepare('SELECT * FROM beats WHERE id = ?').get(beatId);
    const license = db.prepare('SELECT * FROM licenses WHERE beat_id = ? AND id = ?').get(beatId, licenseId);

    if (!beat || !license) {
      throw new Error(`Invalid catalog item: ${beatId}/${licenseId}`);
    }
    if (beat.status === 'sold-exclusive' || beat.is_exclusive_sold === 1) {
      throw new Error(`${beat.title} is no longer available for purchase.`);
    }
    if (!license.available) {
      throw new Error(`${beat.title} is not available for ${license.name}.`);
    }
    if (licenseId === 'exclusive') {
      const exclusiveBeat = db.prepare('SELECT is_exclusive_sold FROM beats WHERE id = ?').get(beatId);
      if (exclusiveBeat && Number(exclusiveBeat.is_exclusive_sold) === 1) {
        throw new Error(`${beat.title} has already been sold exclusively.`);
      }
    }

    const subtotal = Number(license.price) * quantity;
    total += subtotal;
    normalized.push({ beatId, licenseId, quantity, beat, license, subtotal });
  }

  return { normalized, total };
}

app.post('/api/paypal/orders', async (req, res) => {
  try {
    if (!paypalConfigured()) {
      return res.status(503).json({ ok: false, error: 'PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to continue.' });
    }

    const { items = [], customer = {} } = req.body || {};
    const { normalized, total } = validateCartItems(items);

    const payload = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: `affan-${Date.now()}`,
        description: 'AFFANJALANBAIK digital beat marketplace order',
        amount: {
          currency_code: 'USD',
          value: formatMoney(total),
          breakdown: {
            item_total: { currency_code: 'USD', value: formatMoney(total) }
          }
        },
        items: normalized.map((entry) => ({
          name: `${entry.beat.title} - ${entry.license.name}`,
          unit_amount: { currency_code: 'USD', value: formatMoney(entry.license.price) },
          quantity: String(entry.quantity),
          sku: `${entry.beat.id}-${entry.licenseId}`,
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

    return res.json({ ok: true, id: body.id, status: body.status, total: formatMoney(total), currency: 'USD' });
  } catch (error) {
    console.error('Create PayPal order failed:', error);
    return res.status(400).json({ ok: false, error: error.message || 'Unable to create PayPal order.' });
  }
});

app.post('/api/paypal/orders/:id/capture', async (req, res) => {
  try {
    if (!paypalConfigured()) {
      return res.status(503).json({ ok: false, error: 'PayPal Sandbox is not configured. Follow the setup guide and add credentials before charging customers.' });
    }

    const { id } = req.params;
    const response = await fetch(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getPayPalAuthHeader(),
        Accept: 'application/json'
      }
    });

    const body = await response.json();
    if (!response.ok || !body.id) {
      return res.status(502).json({ ok: false, error: body.message || 'PayPal capture failed.', details: body });
    }

    if (body.status !== 'COMPLETED') {
      return res.status(402).json({ ok: false, error: 'The PayPal order is not fully captured. No files are available yet.', status: body.status });
    }

    const purchaseUnit = body.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    const amountUSD = Number(capture?.amount?.value || 0);
    const currencyCode = capture?.amount?.currency_code || 'USD';

    if (currencyCode !== 'USD') {
      return res.status(400).json({ ok: false, error: 'Only USD payments are accepted.' });
    }

    const cart = Array.isArray(req.body?.items) && req.body.items.length ? req.body.items : JSON.parse(req.body?.items || '[]');
    const { normalized } = validateCartItems(cart.length ? cart : []);
    const unitValue = normalized.reduce((sum, item) => sum + item.subtotal, 0);

    if (Math.abs(amountUSD - unitValue) > 0.02) {
      return res.status(400).json({ ok: false, error: 'PayPal total does not match the database price. Payment rejected for integrity.' });
    }

    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO orders (id, customer_name, customer_email, total_usd, status, created_at) VALUES (?, ?, ?, ?, 'PAID', ?)`)
      .run(orderId, req.body?.customer?.name || 'Customer', req.body?.customer?.email || 'customer@example.com', amountUSD, now);

    const insertItem = db.prepare(`INSERT INTO order_items (id, order_id, beat_id, license_id, title, license_name, quantity, unit_price_usd, total_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const paymentInsert = db.prepare(`INSERT INTO payment_records (id, order_id, paypal_order_id, paypal_capture_id, status, amount_usd, currency, raw_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const itemIds = [];
    for (const item of normalized) {
      const itemId = crypto.randomUUID();
      itemIds.push(itemId);
      insertItem.run(itemId, orderId, item.beatId, item.licenseId, item.beat.title, item.license.name, item.quantity, Number(item.license.price), item.subtotal);
    }

    paymentInsert.run(
      crypto.randomUUID(),
      orderId,
      body.id,
      capture?.id || '',
      'PAID',
      amountUSD,
      currencyCode,
      JSON.stringify(body),
      now
    );

    const transaction = db.transaction(() => {
      for (const item of normalized) {
        if (item.licenseId === 'exclusive') {
          db.prepare('UPDATE beats SET is_exclusive_sold = 1, status = ? WHERE id = ? AND is_exclusive_sold = 0').run('sold-exclusive', item.beatId);
        }
      }
    });
    transaction();

    const downloads = [];
    for (const item of normalized) {
      const filePath = `${privateBeatDir}/${item.beatId}-${item.licenseId}.zip`;
      if (fs.existsSync(filePath)) {
        const token = crypto.randomBytes(24).toString('hex');
        const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
        const downloadId = crypto.randomUUID();
        db.prepare(`INSERT INTO downloads (id, order_id, beat_id, license_id, token, file_path, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(downloadId, orderId, item.beatId, item.licenseId, token, filePath, expiresAt, now);
        downloads.push({
          title: item.beat.title,
          license: item.license.name,
          url: `/api/download/${token}`,
          expiresAt
        });
      }
    }

    if (!downloads.length) {
      downloads.push({
        title: 'Secure delivery setup required',
        license: 'Configured by admin',
        url: '/admin',
        message: 'Digital file delivery is not configured until the owner uploads private beat assets and maps them in the server configuration.'
      });
    }

    return res.json({
      ok: true,
      status: 'PAID',
      orderId,
      captureId: capture?.id || '',
      amount: formatMoney(amountUSD),
      currency: 'USD',
      downloads
    });
  } catch (error) {
    console.error('Capture PayPal order failed:', error);
    return res.status(400).json({ ok: false, error: error.message || 'Unable to verify or capture payment.' });
  }
});

app.get('/api/download/:token', (req, res) => {
  const token = req.params.token;
  const row = db.prepare('SELECT * FROM downloads WHERE token = ?').get(token);
  if (!row) return res.status(404).json({ ok: false, error: 'Download token not found.' });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ ok: false, error: 'This download link has expired.' });
  }
  if (!fs.existsSync(row.file_path)) {
    return res.status(404).json({ ok: false, error: 'The licensed file has not been uploaded yet.' });
  }
  const fileName = `${path.basename(row.file_path)}`;
  res.download(row.file_path, fileName);
});

app.get('/api/admin/session', (req, res) => {
  res.json({ loggedIn: Boolean(req.session && req.session.admin), username: req.session?.admin || null });
});

app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return res.status(403).json({ ok: false, error: 'Admin credentials are not configured. Add ADMIN_USERNAME and ADMIN_PASSWORD to the environment before using /admin.' });
  }

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid administrator credentials.' });
  }

  req.session.admin = username;
  return res.json({ ok: true, message: 'Login successful.' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true, message: 'Logged out.' });
  });
});

app.get('/api/admin/beats', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM beats ORDER BY created_at DESC').all();
  const beats = rows.map(toBeatRow);
  const licensesByBeat = {};
  for (const beat of beats) {
    licensesByBeat[beat.id] = getBeatLicenses(beat.id);
  }
  res.json({ beats, licensesByBeat });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM licenses ORDER BY beat_id, id').all();
  res.json({ licenses: rows.map(toLicenseRow) });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const list = orders.map((order) => ({
    id: order.id,
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    totalUsd: Number(order.total_usd),
    status: order.status,
    createdAt: order.created_at,
    items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)
  }));
  res.json({ orders: list });
});

app.delete('/api/admin/beats/:id', requireAdmin, (req, res) => {
  const beatId = req.params.id;
  db.prepare('UPDATE beats SET status = ?, is_exclusive_sold = 0 WHERE id = ?').run('archived', beatId);
  res.json({ ok: true, message: 'Beat archived successfully.' });
});

app.post('/api/admin/beats', requireAdmin, upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'preview', maxCount: 1 }
]), (req, res) => {
  try {
    const payload = req.body || {};
    const beatId = payload.id ? String(payload.id).trim() || urlSafe(payload.title) : urlSafe(payload.title);
    const title = String(payload.title || '').trim();
    const genre = String(payload.genre || '').trim();
    const bpm = Number(payload.bpm || 0);
    const keyName = String(payload.key || '').trim();
    const description = String(payload.description || '').trim();
    const status = String(payload.status || 'available').trim();
    const coverFile = req.files?.cover?.[0];
    const previewFile = req.files?.preview?.[0];
    const coverUrl = coverFile ? `/uploads/${path.basename(coverFile.path)}` : (payload.cover_url || '');
    const previewUrl = previewFile ? `/previews/${path.basename(previewFile.path)}` : (payload.preview_url || '');

    db.prepare(`INSERT INTO beats (id, title, genre, bpm, key_name, description, cover_url, preview_url, status, is_exclusive_sold) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, genre = excluded.genre, bpm = excluded.bpm, key_name = excluded.key_name, description = excluded.description, cover_url = excluded.cover_url, preview_url = excluded.preview_url, status = excluded.status`).run(
      beatId,
      title,
      genre,
      bpm,
      keyName,
      description,
      coverUrl,
      previewUrl,
      status
    );

    const basicPrice = Number(payload.basic_price || payload.basicPrice || 150);
    const premiumPrice = Number(payload.premium_price || payload.premiumPrice || 240);
    const exclusivePrice = Number(payload.exclusive_price || payload.exclusivePrice || 600);
    const licenseRows = [
      { id: 'basic', name: 'Basic Lease', price: basicPrice, description: 'Starter usage license', formats: 'MP3', terms: 'Non-exclusive lease terms for short-term use.', available: 1 },
      { id: 'premium', name: 'Premium Lease', price: premiumPrice, description: 'Extended usage lease', formats: 'MP3, WAV', terms: 'Expanded usage terms for release-ready projects.', available: 1 },
      { id: 'exclusive', name: 'Exclusive License', price: exclusivePrice, description: 'Exclusive rights transfer', formats: 'MP3, WAV, stems', terms: 'Exclusive terms require confirmation before capture and are removed from public catalog after successful verified payment.', available: 1 }
    ];

    const upsertLicense = db.prepare(`INSERT INTO licenses (id, beat_id, name, price, description, formats, terms, available) VALUES (@id, @beat_id, @name, @price, @description, @formats, @terms, @available)
      ON CONFLICT(beat_id, id) DO UPDATE SET name = excluded.name, price = excluded.price, description = excluded.description, formats = excluded.formats, terms = excluded.terms, available = excluded.available`);

    for (const row of licenseRows) {
      upsertLicense.run({
        id: row.id,
        beat_id: beatId,
        name: row.name,
        price: row.price,
        description: row.description,
        formats: row.formats,
        terms: row.terms,
        available: row.available
      });
    }

    res.json({ ok: true, beatId, message: 'Beat saved successfully.' });
  } catch (error) {
    console.error('Beat save failed:', error);
    res.status(500).json({ ok: false, error: error.message || 'Unable to save beat.' });
  }
});

app.put('/api/admin/beats/:id', requireAdmin, upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'preview', maxCount: 1 }
]), (req, res) => {
  req.body.id = req.params.id;
  return app._router.handle(req, res);
});

app.put('/api/admin/licenses/:beatId/:licenseId', requireAdmin, (req, res) => {
  const beatId = req.params.beatId;
  const licenseId = req.params.licenseId;
  const price = Number(req.body.price || 0);
  const description = String(req.body.description || '').trim();
  const formats = String(req.body.formats || '').trim();
  const terms = String(req.body.terms || '').trim();
  const available = Number(req.body.available ?? 1) === 1 ? 1 : 0;

  db.prepare(`UPDATE licenses SET price = ?, description = ?, formats = ?, terms = ?, available = ? WHERE beat_id = ? AND id = ?`)
    .run(price, description, formats, terms, available, beatId, licenseId);

  res.json({ ok: true, message: 'License updated.' });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(rootDir, 'admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(rootDir, 'admin.html'));
});

app.get('/paypal-checkout.js', (req, res) => {
  res.sendFile(path.join(rootDir, 'paypal-checkout.js'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ ok: false, error: 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`AFFANJALANBAIK server listening on http://localhost:${port}`);
  console.log(`Admin login: ${ADMIN_USERNAME ? 'configured' : 'requires ADMIN_USERNAME and ADMIN_PASSWORD in .env'}`);
});
