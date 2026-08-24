const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id_code TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone_number TEXT,
    avatar TEXT,
    is_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(token_hash, revoked_at, expires_at);
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT NOT NULL,
    price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0),
    capacity TEXT NOT NULL,
    speed TEXT NOT NULL,
    device_limit INTEGER NOT NULL DEFAULT 1,
    is_lifetime INTEGER NOT NULL DEFAULT 0,
    features_json TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    cycle_months INTEGER NOT NULL CHECK (cycle_months > 0),
    subtotal_vnd INTEGER NOT NULL CHECK (subtotal_vnd >= 0),
    discount_vnd INTEGER NOT NULL DEFAULT 0 CHECK (discount_vnd >= 0),
    total_vnd INTEGER NOT NULL CHECK (total_vnd >= 0),
    payment_method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','expired')),
    payment_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT,
    UNIQUE(user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
    started_at TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status, expires_at);
`);

const PLAN_SEEDS = [
  { id: 1, slug: 'vn-basic', category: 'vn', name: 'Việt Nam Cơ Bản', nameEn: 'Vietnam Basic', price: 49000, capacity: '100GB', speed: '100Mbps', devices: 2, lifetime: 0, features: ['Node Việt Nam tốc độ cao', 'Hỗ trợ 24/7', 'Không giới hạn thời gian dùng'] },
  { id: 2, slug: 'vn-pro', category: 'vn', name: 'Việt Nam Pro', nameEn: 'Vietnam Pro', price: 89000, capacity: '300GB', speed: '300Mbps', devices: 4, lifetime: 0, features: ['Node Việt Nam + quốc tế', 'Ưu tiên băng thông', 'Hỗ trợ 24/7'] },
  { id: 3, slug: 'lifetime-standard', category: 'forever', name: 'Vĩnh Viễn Tiêu Chuẩn', nameEn: 'Lifetime Standard', price: 990000, capacity: '500GB/tháng', speed: '500Mbps', devices: 5, lifetime: 1, features: ['Không giới hạn thời gian', 'Toàn bộ node hệ thống', 'Ưu tiên hỗ trợ'] },
  { id: 4, slug: 'lifetime-premium', category: 'forever', name: 'Vĩnh Viễn Cao Cấp', nameEn: 'Lifetime Premium', price: 1990000, capacity: 'Không giới hạn', speed: '1Gbps', devices: 10, lifetime: 1, features: ['Không giới hạn dung lượng', 'Node riêng tốc độ cao', 'Hỗ trợ ưu tiên VIP'] },
  { id: 5, slug: 'global-basic', category: 'global', name: 'Global Basic', nameEn: 'Global Basic', price: 69000, capacity: '150GB', speed: '150Mbps', devices: 3, lifetime: 0, features: ['Node đa quốc gia', 'Unblock streaming quốc tế', 'Hỗ trợ 24/7'] },
  { id: 6, slug: 'global-ultra', category: 'global', name: 'Global Ultra', nameEn: 'Global Ultra', price: 149000, capacity: '1TB', speed: '700Mbps', devices: 6, lifetime: 0, features: ['Node đa quốc gia cao cấp', 'Unblock streaming quốc tế', 'Băng thông không giới hạn giờ cao điểm'] },
];
const seedPlan = db.prepare(`INSERT OR IGNORE INTO plans (id, slug, category, name, name_en, price_vnd, capacity, speed, device_limit, is_lifetime, features_json) VALUES (@id, @slug, @category, @name, @nameEn, @price, @capacity, @speed, @devices, @lifetime, @features)`);
for (const plan of PLAN_SEEDS) seedPlan.run({ ...plan, features: JSON.stringify(plan.features) });

function makeUserCode() {
  let code;
  do {
    code = `DAV-${String(crypto.randomInt(100000, 999999))}`;
  } while (db.prepare('SELECT 1 FROM users WHERE user_id_code = ?').get(code));
  return code;
}

function makeOrderCode() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  let code;
  do {
    code = `DH${date}-${crypto.randomInt(100000, 999999)}`;
  } while (db.prepare('SELECT 1 FROM orders WHERE id = ?').get(code));
  return code;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id_code,
    email: row.email,
    name: row.full_name,
    phone: row.phone_number || '',
    avatar: row.avatar || null,
    verified: Boolean(row.is_verified),
    joinDate: row.created_at,
  };
}

function parseFeatures(row) {
  try { return JSON.parse(row.features_json || '[]'); } catch { return []; }
}

function publicPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    category: row.category,
    name: row.name,
    nameEn: row.name_en,
    price: row.price_vnd,
    capacity: row.capacity,
    speed: row.speed,
    devices: row.device_limit,
    lifetime: Boolean(row.is_lifetime),
    popular: row.id === 2 || row.id === 4,
    features: parseFeatures(row),
  };
}

function publicOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id,
    planName: row.plan_name,
    cycleMonths: row.cycle_months,
    cycle: row.is_lifetime ? 'Vĩnh viễn' : (row.cycle_months === 1 ? '1 tháng' : `${row.cycle_months} tháng`),
    subtotal: row.subtotal_vnd,
    discount: row.discount_vnd,
    amount: row.total_vnd,
    total: row.total_vnd,
    paymentMethod: row.payment_method,
    status: row.status,
    paymentRef: row.payment_ref || '',
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
  };
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim().toLowerCase());
}

function getPlanById(id) {
  return db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(id);
}

function listPlans() {
  return db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY id').all().map(publicPlan);
}

function createOrder({ userId, planId, cycleMonths, subtotal, discount, total, paymentMethod }) {
  const id = makeOrderCode();
  db.prepare(`INSERT INTO orders (id, user_id, plan_id, cycle_months, subtotal_vnd, discount_vnd, total_vnd, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, planId, cycleMonths, subtotal, discount, total, paymentMethod);
  return getOrderByIdForUser(id, userId);
}

function getOrderByIdForUser(id, userId) {
  const row = db.prepare(`SELECT o.*, p.name AS plan_name, p.is_lifetime AS is_lifetime FROM orders o JOIN plans p ON p.id = o.plan_id WHERE o.id = ? AND o.user_id = ?`).get(id, userId);
  return publicOrder(row);
}

function listOrdersForUser(userId) {
  return db.prepare(`SELECT o.*, p.name AS plan_name, p.is_lifetime AS is_lifetime FROM orders o JOIN plans p ON p.id = o.plan_id WHERE o.user_id = ? ORDER BY datetime(o.created_at) DESC`).all(userId).map(publicOrder);
}

function cancelOrderForUser(id, userId) {
  const result = db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'pending' AND payment_ref IS NULL`).run(id, userId);
  return result.changes > 0;
}

function markOrderPaid(orderId) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!row) return null;
  if (row.status === 'paid') return getOrderByIdForUser(orderId, row.user_id);
  if (row.status !== 'pending') return null;
  const plan = getPlanById(row.plan_id);
  if (!plan) return null;
  const now = new Date();
  const expiresAt = plan.is_lifetime ? null : new Date(now.getTime() + row.cycle_months * 30 * 24 * 60 * 60 * 1000).toISOString();
  const subscriptionId = crypto.randomUUID();
  db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'paid', updated_at = datetime('now'), paid_at = datetime('now') WHERE id = ?").run(orderId);
    db.prepare("UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'").run(row.user_id);
    db.prepare('INSERT INTO subscriptions (id, user_id, plan_id, order_id, status, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(subscriptionId, row.user_id, row.plan_id, orderId, 'active', now.toISOString(), expiresAt);
  })();
  return getOrderByIdForUser(orderId, row.user_id);
}

function getActiveSubscription(userId) {
  const row = db.prepare(`SELECT s.*, p.name AS plan_name, p.capacity, p.speed, p.device_limit, p.is_lifetime FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ? AND s.status = 'active' AND (s.expires_at IS NULL OR datetime(s.expires_at) > datetime('now')) ORDER BY datetime(s.created_at) DESC LIMIT 1`).get(userId);
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id,
    planName: row.plan_name,
    capacity: row.capacity,
    speed: row.speed,
    devices: row.device_limit,
    lifetime: Boolean(row.is_lifetime),
    status: row.status,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
  };
}

function createSession(userId, meta = {}) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, user_agent, ip_address, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sessionId, userId, hashToken(rawToken), meta.userAgent || '', meta.ipAddress || '', expiresAt);
  return { id: sessionId, token: rawToken, expiresAt };
}

function getSessionByToken(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT s.*, u.email, u.user_id_code, u.full_name, u.phone_number, u.avatar, u.is_verified, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > datetime('now')
  `).get(hashToken(token));
}

function revokeSession(id) {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").run(id);
}

function revokeOtherSessions(userId, currentSessionId) {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id != ? AND revoked_at IS NULL").run(userId, currentSessionId);
}

module.exports = {
  db, PLAN_SEEDS, makeUserCode, makeOrderCode, publicUser, publicPlan, publicOrder,
  getUserById, getUserByEmail, getPlanById, listPlans, createOrder, getOrderByIdForUser,
  listOrdersForUser, cancelOrderForUser, markOrderPaid, getActiveSubscription, createSession,
  getSessionByToken, revokeSession, revokeOtherSessions, hashToken,
};
