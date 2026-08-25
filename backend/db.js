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
  CREATE TABLE IF NOT EXISTS password_reset_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_password_reset_email ON password_reset_codes(email, used_at, expires_at);
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
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_ref ON orders(payment_ref) WHERE payment_ref IS NOT NULL;
  CREATE TABLE IF NOT EXISTS sepay_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sepay_id TEXT NOT NULL UNIQUE,
    order_id TEXT REFERENCES orders(id),
    notification_type TEXT NOT NULL,
    order_status TEXT,
    transaction_status TEXT,
    payment_method TEXT,
    transaction_id TEXT,
    transaction_amount_vnd INTEGER,
    order_amount_vnd INTEGER,
    currency TEXT,
    transaction_date TEXT,
    raw_payload TEXT NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received','processed','ignored','error')),
    processing_error TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sepay_transactions_order_id ON sepay_transactions(order_id, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sepay_transactions_status ON sepay_transactions(processing_status, received_at DESC);
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
  CREATE TABLE IF NOT EXISTS vpn_provisions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL UNIQUE REFERENCES subscriptions(id) ON DELETE CASCADE,
    xui_email TEXT NOT NULL UNIQUE,
    client_uuid TEXT NOT NULL,
    sub_id TEXT NOT NULL UNIQUE,
    inbound_ids_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','expired')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vpn_provisions_user_status ON vpn_provisions(user_id, status, updated_at);
  CREATE TABLE IF NOT EXISTS vpn_subscription_groups (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    subscription_id TEXT NOT NULL UNIQUE REFERENCES subscriptions(id) ON DELETE CASCADE,
    sub_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','error')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vpn_groups_user_status ON vpn_subscription_groups(user_id, status, updated_at);
  CREATE TABLE IF NOT EXISTS vpn_subscription_clients (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES vpn_subscription_groups(id) ON DELETE CASCADE,
    xui_email TEXT NOT NULL UNIQUE,
    client_uuid TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vpn_group_clients_group ON vpn_subscription_clients(group_id, updated_at);
`);

const PLAN_SEEDS = [
  { id: 7, slug: 'vina-khong-nen', category: 'vn', name: 'VINA KHÔNG NỀN', nameEn: 'VINA KHÔNG NỀN', price: 15000, capacity: '100GB', speed: '100Mbps', devices: 2, lifetime: 1, features: ['Node Việt Nam tốc độ cao', 'Hỗ trợ 24/7', 'Không giới hạn thời gian dùng'] },
];
const seedPlan = db.prepare(`INSERT INTO plans (id, slug, category, name, name_en, price_vnd, capacity, speed, device_limit, is_lifetime, features_json, is_active) VALUES (@id, @slug, @category, @name, @nameEn, @price, @capacity, @speed, @devices, @lifetime, @features, 1) ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, category = excluded.category, name = excluded.name, name_en = excluded.name_en, price_vnd = excluded.price_vnd, capacity = excluded.capacity, speed = excluded.speed, device_limit = excluded.device_limit, is_lifetime = excluded.is_lifetime, features_json = excluded.features_json, is_active = 1`);
for (const plan of PLAN_SEEDS) seedPlan.run({ ...plan, features: JSON.stringify(plan.features) });
// Backfill the group/client view from the original one-client provision table.
db.exec(`
  INSERT OR IGNORE INTO vpn_subscription_groups (id, user_id, plan_id, subscription_id, sub_id, status, created_at, updated_at)
  SELECT 'legacy-' || v.id, v.user_id, s.plan_id, v.subscription_id, v.sub_id,
         CASE WHEN v.status IN ('active', 'expired', 'error') THEN v.status ELSE 'error' END,
         v.created_at, v.updated_at
  FROM vpn_provisions v JOIN subscriptions s ON s.id = v.subscription_id;
  INSERT OR IGNORE INTO vpn_subscription_clients (id, group_id, xui_email, client_uuid, created_at, updated_at)
  SELECT 'legacy-client-' || v.id, 'legacy-' || v.id, v.xui_email, v.client_uuid, v.created_at, v.updated_at
  FROM vpn_provisions v WHERE EXISTS (SELECT 1 FROM vpn_subscription_groups g WHERE g.id = 'legacy-' || v.id);
`);
// Keep historical orders/subscriptions queryable, but remove legacy plans from the storefront and new purchases.
db.prepare("UPDATE plans SET is_active = CASE WHEN slug = 'vina-khong-nen' THEN 1 ELSE 0 END").run();

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

function getPlanBySlug(slug) {
  return db.prepare('SELECT * FROM plans WHERE slug = ? AND is_active = 1').get(String(slug || '').trim());
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

function markOrderPaid(orderId, paymentRef = null) {
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
    db.prepare("UPDATE orders SET status = 'paid', payment_ref = COALESCE(?, payment_ref), updated_at = datetime('now'), paid_at = datetime('now') WHERE id = ?").run(paymentRef, orderId);
    db.prepare("UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'").run(row.user_id);
    db.prepare("UPDATE vpn_provisions SET status = 'expired', updated_at = datetime('now') WHERE user_id = ? AND status = 'active'").run(row.user_id);
    db.prepare("UPDATE vpn_subscription_groups SET status = 'expired', updated_at = datetime('now') WHERE user_id = ? AND status = 'active'").run(row.user_id);
    db.prepare('INSERT INTO subscriptions (id, user_id, plan_id, order_id, status, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(subscriptionId, row.user_id, row.plan_id, orderId, 'active', now.toISOString(), expiresAt);
  })();
  return getOrderByIdForUser(orderId, row.user_id);
}

function insertSepayTransaction({
  sepayId,
  orderId = null,
  notificationType,
  orderStatus = null,
  transactionStatus = null,
  paymentMethod = null,
  transactionId = null,
  transactionAmountVnd = null,
  orderAmountVnd = null,
  currency = null,
  transactionDate = null,
  rawPayload,
}) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO sepay_transactions
      (sepay_id, order_id, notification_type, order_status, transaction_status, payment_method,
       transaction_id, transaction_amount_vnd, order_amount_vnd, currency, transaction_date, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(sepayId), orderId, notificationType, orderStatus, transactionStatus, paymentMethod,
    transactionId, transactionAmountVnd, orderAmountVnd, currency, transactionDate,
    typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload),
  );
  return { inserted: result.changes > 0, transaction: db.prepare('SELECT * FROM sepay_transactions WHERE sepay_id = ?').get(String(sepayId)) };
}

function updateSepayTransaction(sepayId, { orderId, processingStatus, processingError = null }) {
  db.prepare(`
    UPDATE sepay_transactions
    SET order_id = COALESCE(?, order_id), processing_status = ?, processing_error = ?,
        processed_at = CASE WHEN ? IN ('processed', 'ignored', 'error') THEN datetime('now') ELSE processed_at END
    WHERE sepay_id = ?
  `).run(orderId || null, processingStatus, processingError, processingStatus, String(sepayId));
  return db.prepare('SELECT * FROM sepay_transactions WHERE sepay_id = ?').get(String(sepayId));
}

function getSepayTransactionById(sepayId) {
  return db.prepare('SELECT * FROM sepay_transactions WHERE sepay_id = ?').get(String(sepayId));
}

function getOrderById(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(String(orderId));
}

function getVpnProvisionContext(orderId) {
  return db.prepare(`
    SELECT o.id AS order_id, o.user_id, o.plan_id, o.status AS order_status,
           s.id AS subscription_id, s.status AS subscription_status, s.started_at, s.expires_at,
           u.user_id_code, u.email, p.slug AS plan_slug, p.name AS plan_name,
           p.capacity, p.device_limit, p.is_lifetime
    FROM orders o
    JOIN users u ON u.id = o.user_id
    JOIN plans p ON p.id = o.plan_id
    JOIN subscriptions s ON s.order_id = o.id
    WHERE o.id = ?
  `).get(orderId);
}

function getVpnProvisionByOrderId(orderId) {
  return db.prepare('SELECT * FROM vpn_provisions WHERE order_id = ?').get(orderId);
}

function getActiveVpnProvisionContext(userId) {
  return db.prepare(`
    SELECT o.id AS order_id, o.user_id, o.plan_id, o.status AS order_status,
           s.id AS subscription_id, s.status AS subscription_status, s.started_at, s.expires_at,
           u.user_id_code, u.email, p.slug AS plan_slug, p.name AS plan_name,
           p.capacity, p.speed, p.device_limit, p.is_lifetime
    FROM subscriptions s
    JOIN orders o ON o.id = s.order_id
    JOIN users u ON u.id = s.user_id
    JOIN plans p ON p.id = s.plan_id
    WHERE s.user_id = ? AND s.status = 'active'
      AND (s.expires_at IS NULL OR datetime(s.expires_at) > datetime('now'))
    ORDER BY datetime(s.created_at) DESC LIMIT 1
  `).get(userId);
}

function getVpnProvisionByUserId(userId) {
  return db.prepare(`
    SELECT v.*, s.status AS subscription_status, s.started_at, s.expires_at,
           p.slug AS plan_slug, p.name AS plan_name, p.capacity, p.speed, p.device_limit, p.is_lifetime
    FROM vpn_provisions v
    JOIN subscriptions s ON s.id = v.subscription_id
    JOIN plans p ON p.id = s.plan_id
    WHERE v.user_id = ? AND v.status = 'active' AND s.status = 'active'
      AND (s.expires_at IS NULL OR datetime(s.expires_at) > datetime('now'))
    ORDER BY datetime(v.updated_at) DESC LIMIT 1
  `).get(userId);
}

function getVpnProvisionBySubId(subId) {
  return db.prepare(`
    SELECT v.*, s.status AS subscription_status, s.started_at, s.expires_at,
           p.slug AS plan_slug, p.name AS plan_name, p.capacity, p.speed, p.device_limit, p.is_lifetime
    FROM vpn_provisions v
    JOIN subscriptions s ON s.id = v.subscription_id
    JOIN plans p ON p.id = s.plan_id
    WHERE v.sub_id = ? AND v.status = 'active' AND s.status = 'active'
      AND (s.expires_at IS NULL OR datetime(s.expires_at) > datetime('now'))
    LIMIT 1
  `).get(subId);
}

function getVpnSubscriptionGroupByUserId(userId) {
  return db.prepare(`
    SELECT g.*, s.status AS subscription_status, s.started_at, s.expires_at,
           p.slug AS plan_slug, p.name AS plan_name, p.capacity, p.speed, p.device_limit, p.is_lifetime
    FROM vpn_subscription_groups g
    JOIN subscriptions s ON s.id = g.subscription_id
    JOIN plans p ON p.id = g.plan_id
    WHERE g.user_id = ? AND g.status = 'active' AND s.status = 'active'
      AND (s.expires_at IS NULL OR datetime(s.expires_at) > datetime('now'))
    ORDER BY datetime(g.updated_at) DESC LIMIT 1
  `).get(userId);
}

function getVpnSubscriptionGroupBySubscriptionId(subscriptionId) {
  return db.prepare(`
    SELECT g.*, s.status AS subscription_status, s.started_at, s.expires_at,
           p.slug AS plan_slug, p.name AS plan_name, p.capacity, p.speed, p.device_limit, p.is_lifetime
    FROM vpn_subscription_groups g
    JOIN subscriptions s ON s.id = g.subscription_id
    JOIN plans p ON p.id = g.plan_id
    WHERE g.subscription_id = ? LIMIT 1
  `).get(subscriptionId);
}

function getVpnSubscriptionGroupBySubId(subId) {
  return db.prepare(`
    SELECT g.*, s.status AS subscription_status, s.started_at, s.expires_at,
           p.slug AS plan_slug, p.name AS plan_name, p.capacity, p.speed, p.device_limit, p.is_lifetime
    FROM vpn_subscription_groups g
    JOIN subscriptions s ON s.id = g.subscription_id
    JOIN plans p ON p.id = g.plan_id
    WHERE g.sub_id = ? AND g.status = 'active' AND s.status = 'active'
      AND (s.expires_at IS NULL OR datetime(s.expires_at) > datetime('now'))
    LIMIT 1
  `).get(subId);
}

function rotateVpnSubscriptionGroupSubId(groupId, subId) {
  db.prepare("UPDATE vpn_subscription_groups SET sub_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'active'")
    .run(subId, groupId);
  return db.prepare('SELECT * FROM vpn_subscription_groups WHERE id = ?').get(groupId);
}

function listVpnSubscriptionClients(groupId) {
  return db.prepare('SELECT * FROM vpn_subscription_clients WHERE group_id = ? ORDER BY datetime(created_at) ASC').all(groupId);
}

function saveVpnSubscriptionGroup({ id, userId, planId, subscriptionId, subId, status = 'active' }) {
  db.prepare(`
    INSERT INTO vpn_subscription_groups (id, user_id, plan_id, subscription_id, sub_id, status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET
      user_id = excluded.user_id, plan_id = excluded.plan_id, sub_id = excluded.sub_id,
      status = excluded.status, updated_at = datetime('now')
  `).run(id, userId, planId, subscriptionId, subId, status);
  return getVpnSubscriptionGroupBySubscriptionId(subscriptionId);
}

function deleteVpnSubscriptionClient(groupId, xuiEmail) {
  db.prepare('DELETE FROM vpn_subscription_clients WHERE group_id = ? AND xui_email = ?').run(groupId, xuiEmail);
}

function saveVpnSubscriptionClient({ id, groupId, xuiEmail, clientUuid }) {
  db.prepare(`
    INSERT INTO vpn_subscription_clients (id, group_id, xui_email, client_uuid)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(xui_email) DO UPDATE SET
      group_id = excluded.group_id, client_uuid = excluded.client_uuid, updated_at = datetime('now')
  `).run(id, groupId, xuiEmail, clientUuid);
  return db.prepare('SELECT * FROM vpn_subscription_clients WHERE xui_email = ?').get(xuiEmail);
}

function saveVpnProvision({ id, userId, orderId, subscriptionId, xuiEmail, clientUuid, subId, inboundIds, status = 'active', lastError = null }) {
  db.prepare(`
    INSERT INTO vpn_provisions
      (id, user_id, order_id, subscription_id, xui_email, client_uuid, sub_id, inbound_ids_json, status, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(xui_email) DO UPDATE SET
      user_id = excluded.user_id,
      order_id = excluded.order_id,
      subscription_id = excluded.subscription_id,
      client_uuid = excluded.client_uuid,
      sub_id = excluded.sub_id,
      inbound_ids_json = excluded.inbound_ids_json,
      status = excluded.status,
      last_error = excluded.last_error,
      updated_at = datetime('now')
  `).run(id, userId, orderId, subscriptionId, xuiEmail, clientUuid, subId, JSON.stringify(inboundIds), status, lastError);
  return getVpnProvisionByOrderId(orderId);
}

function updateVpnProvisionStatus(orderId, status, lastError = null) {
  db.prepare("UPDATE vpn_provisions SET status = ?, last_error = ?, updated_at = datetime('now') WHERE order_id = ?")
    .run(status, lastError, orderId);
  return getVpnProvisionByOrderId(orderId);
}

function updateVpnProvision(id, { xuiEmail, clientUuid, subId, inboundIds, status = 'active', lastError = null }) {
  db.prepare(`
    UPDATE vpn_provisions
    SET xui_email = ?, client_uuid = ?, sub_id = ?, inbound_ids_json = ?, status = ?, last_error = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(xuiEmail, clientUuid, subId, JSON.stringify(inboundIds), status, lastError, id);
  return db.prepare('SELECT * FROM vpn_provisions WHERE id = ?').get(id);
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

function revokeAllSessions(userId) {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(userId);
}

function createPasswordResetCode(email, codeHash, expiresAt) {
  db.prepare("DELETE FROM password_reset_codes WHERE email = ? OR datetime(expires_at) <= datetime('now')").run(email);
  const result = db.prepare('INSERT INTO password_reset_codes (email, code_hash, expires_at) VALUES (?, ?, ?)').run(email, codeHash, expiresAt);
  return result.lastInsertRowid;
}

function getPasswordResetCode(email) {
  return db.prepare("SELECT * FROM password_reset_codes WHERE email = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1").get(email);
}

function incrementPasswordResetAttempts(id) {
  db.prepare('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
}

function consumePasswordResetCode(id) {
  db.prepare("UPDATE password_reset_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(id);
}

module.exports = {
  db, PLAN_SEEDS, makeUserCode, makeOrderCode, publicUser, publicPlan, publicOrder,
  getUserById, getUserByEmail, getPlanById, getPlanBySlug, listPlans, createOrder, getOrderById, getOrderByIdForUser,
  listOrdersForUser, cancelOrderForUser, markOrderPaid, insertSepayTransaction, updateSepayTransaction, getSepayTransactionById, getVpnProvisionContext, getActiveVpnProvisionContext,
  getVpnProvisionByOrderId, getVpnProvisionByUserId, getVpnProvisionBySubId, getVpnSubscriptionGroupByUserId, getVpnSubscriptionGroupBySubscriptionId, getVpnSubscriptionGroupBySubId, rotateVpnSubscriptionGroupSubId, listVpnSubscriptionClients, saveVpnSubscriptionGroup, deleteVpnSubscriptionClient, saveVpnSubscriptionClient, saveVpnProvision, updateVpnProvision, updateVpnProvisionStatus,
  getActiveSubscription, createSession,
  getSessionByToken, revokeSession, revokeOtherSessions, revokeAllSessions, hashToken,
  createPasswordResetCode, getPasswordResetCode, incrementPasswordResetAttempts, consumePasswordResetCode,
};
