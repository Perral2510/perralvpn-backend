const express = require('express');
const crypto = require('node:crypto');
const {
  db, makeUserCode, publicUser, getUserById, getUserByEmail, listPlans, getPlanById,
  createOrder, getOrderByIdForUser, listOrdersForUser, cancelOrderForUser, markOrderPaid, getActiveSubscription,
  createSession, getSessionByToken, revokeSession, revokeOtherSessions,
} = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const sessionCookie = process.env.SESSION_COOKIE_NAME || 'ducanh_session';
const allowedOrigin = process.env.FRONTEND_ORIGIN || '';
const attempts = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (allowedOrigin && req.headers.origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    return res.sendStatus(204);
  }
  next();
});

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map(pair => {
    const index = pair.indexOf('=');
    return [pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim())];
  }));
}

function cookieOptions(maxAge, value = '') {
  return [
    `${sessionCookie}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    isProduction ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function setSessionCookie(res, token, maxAgeSeconds = 7 * 24 * 60 * 60) {
  res.setHeader('Set-Cookie', cookieOptions(maxAgeSeconds, token));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookieOptions(0));
}

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function rateLimitKey(req) { return `${clientIp(req)}:${normalizeEmail(req.body?.email)}`; }
function rateLimit(req, res, next) {
  const now = Date.now(); const key = rateLimitKey(req); const previous = attempts.get(key) || [];
  const recent = previous.filter(time => now - time < 10 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ ok: false, message: 'Thử đăng nhập lại sau ít phút.' });
  recent.push(now); attempts.set(key, recent); next();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}
function verifyPassword(password, encoded) {
  const [, salt, expected] = String(encoded || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function requireAuth(req, res, next) {
  const session = getSessionByToken(parseCookies(req)[sessionCookie]);
  if (!session) return res.status(401).json({ ok: false, message: 'Phiên đăng nhập đã hết hạn.' });
  req.session = session; req.user = getUserById(session.user_id); next();
}
function safeText(value, max = 120) { return String(value || '').trim().slice(0, max); }

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'ducanh-api', time: new Date().toISOString() }));

const PAYMENT_METHODS = new Set(['bank']);
const CYCLE_MONTHS = new Set([1, 3, 12]);
function paymentInfo(order) {
  return {
    method: 'bank',
    bank: process.env.PAYMENT_BANK_NAME || 'MB Bank',
    account: process.env.PAYMENT_BANK_ACCOUNT || '0123456789',
    owner: process.env.PAYMENT_BANK_OWNER || 'NGUYEN DUC ANH',
    amount: order.total,
    content: `${process.env.PAYMENT_TRANSFER_PREFIX || 'DAV'} ${order.id}`,
    demo: !(process.env.PAYMENT_BANK_ACCOUNT),
  };
}

app.get('/api/plans', (_req, res) => res.json({ ok: true, data: listPlans() }));

app.get('/api/account/billing', requireAuth, (req, res) => {
  const orders = listOrdersForUser(req.user.id);
  res.json({ ok: true, data: { activeSubscription: getActiveSubscription(req.user.id), orders: orders.slice(0, 5) } });
});

app.get('/api/account/orders', requireAuth, (req, res) => {
  res.json({ ok: true, data: listOrdersForUser(req.user.id) });
});

app.post('/api/account/orders', requireAuth, (req, res) => {
  const planId = Number(req.body.planId);
  const plan = getPlanById(planId);
  const requestedMonths = Number(req.body.cycleMonths || 1);
  const cycleMonths = plan?.is_lifetime ? 1 : requestedMonths;
  const paymentMethod = safeText(req.body.paymentMethod, 20).toLowerCase();
  const promoCode = safeText(req.body.promoCode, 40).toUpperCase();
  if (!plan) return res.status(400).json({ ok: false, message: 'Gói cước không tồn tại hoặc đã ngừng bán.' });
  if (!CYCLE_MONTHS.has(cycleMonths)) return res.status(400).json({ ok: false, message: 'Chu kỳ thanh toán không hợp lệ.' });
  if (!PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ ok: false, message: 'Phương thức thanh toán này chưa được tích hợp.' });
  const subtotal = plan.price_vnd * cycleMonths;
  const cycleDiscount = cycleMonths === 3 ? Math.round(subtotal * 0.05) : cycleMonths === 12 ? Math.round(subtotal * 0.15) : 0;
  const promoDiscount = promoCode.startsWith('DAV') ? Math.round((subtotal - cycleDiscount) * 0.1) : 0;
  const discount = cycleDiscount + promoDiscount;
  const total = Math.max(0, subtotal - discount);
  const order = createOrder({ userId: req.user.id, planId, cycleMonths, subtotal, discount, total, paymentMethod });
  res.status(201).json({ ok: true, message: 'Đã tạo đơn hàng, vui lòng chuyển khoản để chờ đối soát.', data: { order, payment: paymentInfo(order) } });
});

app.post('/api/account/orders/:id/payment-submitted', requireAuth, (req, res) => {
  const order = getOrderByIdForUser(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ ok: false, message: 'Không tìm thấy đơn hàng.' });
  if (order.status !== 'pending') return res.status(400).json({ ok: false, message: 'Đơn hàng không còn chờ thanh toán.' });
  const paymentRef = safeText(req.body.paymentRef || `manual-${Date.now()}`, 80);
  db.prepare("UPDATE orders SET payment_ref = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'pending'").run(paymentRef, order.id, req.user.id);
  res.json({ ok: true, message: 'Đã ghi nhận yêu cầu đối soát. Gói sẽ kích hoạt sau khi thanh toán được xác nhận.', data: { ...getOrderByIdForUser(order.id, req.user.id), payment: paymentInfo(order) } });
});

app.delete('/api/account/orders/:id', requireAuth, (req, res) => {
  const cancelled = cancelOrderForUser(req.params.id, req.user.id);
  if (!cancelled) return res.status(400).json({ ok: false, message: 'Đơn hàng không tồn tại hoặc không thể hủy.' });
  res.json({ ok: true, message: 'Đã hủy đơn hàng.' });
});

app.post('/api/admin/orders/:id/mark-paid', (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return res.status(503).json({ ok: false, message: 'Chưa cấu hình khóa quản trị thanh toán.' });
  if (req.get('x-admin-key') !== adminKey) return res.status(401).json({ ok: false, message: 'Không có quyền xác nhận thanh toán.' });
  const order = markOrderPaid(req.params.id);
  if (!order) return res.status(400).json({ ok: false, message: 'Đơn hàng không tồn tại hoặc không thể xác nhận.' });
  res.json({ ok: true, message: 'Đã xác nhận thanh toán và kích hoạt gói cước.', data: order });
});

app.post('/api/auth/register', rateLimit, (req, res) => {
  const name = safeText(req.body.fullName || req.body.name);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ ok: false, message: 'Họ tên không hợp lệ.' });
  if (!validEmail(email)) return res.status(400).json({ ok: false, message: 'Email không hợp lệ.' });
  if (password.length < 8) return res.status(400).json({ ok: false, message: 'Mật khẩu phải có ít nhất 8 ký tự.' });
  if (getUserByEmail(email)) return res.status(409).json({ ok: false, message: 'Email đã được đăng ký.' });
  const result = db.prepare('INSERT INTO users (user_id_code, email, password_hash, full_name, is_verified) VALUES (?, ?, ?, ?, ?)')
    .run(makeUserCode(), email, hashPassword(password), name, 0);
  const user = getUserById(result.lastInsertRowid);
  return res.status(201).json({ ok: true, message: 'Đăng ký thành công.', data: publicUser(user) });
});

app.post('/api/auth/login', rateLimit, (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ ok: false, message: 'Email hoặc mật khẩu không đúng.' });
  const session = createSession(user.id, { userAgent: req.headers['user-agent'], ipAddress: clientIp(req) });
  setSessionCookie(res, session.token);
  return res.json({ ok: true, data: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req)[sessionCookie]; const session = getSessionByToken(token);
  if (session) revokeSession(session.id);
  clearSessionCookie(res); res.json({ ok: true });
});

app.get('/api/account/me', requireAuth, (req, res) => res.json({ ok: true, data: publicUser(req.user) }));

app.put('/api/account/profile', requireAuth, (req, res) => {
  const name = safeText(req.body.name || req.body.fullName);
  const phone = safeText(req.body.phone, 30);
  if (name.length < 2) return res.status(400).json({ ok: false, message: 'Họ tên không hợp lệ.' });
  db.prepare("UPDATE users SET full_name = ?, phone_number = ?, updated_at = datetime('now') WHERE id = ?").run(name, phone || null, req.user.id);
  res.json({ ok: true, data: publicUser(getUserById(req.user.id)) });
});

app.put('/api/account/password', requireAuth, (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const latest = getUserById(req.user.id);
  if (!verifyPassword(currentPassword, latest.password_hash)) return res.status(400).json({ ok: false, message: 'Mật khẩu hiện tại không đúng.' });
  if (newPassword.length < 8) return res.status(400).json({ ok: false, message: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashPassword(newPassword), req.user.id);
  revokeOtherSessions(req.user.id, req.session.id);
  res.json({ ok: true, message: 'Đã cập nhật mật khẩu.' });
});

app.get('/api/account/sessions', requireAuth, (req, res) => {
  const rows = db.prepare("SELECT id, user_agent, ip_address, created_at, expires_at, id = ? AS current FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now') ORDER BY created_at DESC").all(req.session.id, req.user.id);
  res.json({ ok: true, data: rows });
});

app.post('/api/account/sessions/revoke-others', requireAuth, (req, res) => {
  revokeOtherSessions(req.user.id, req.session.id); res.json({ ok: true });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, message: 'API route not found.' });
});

app.listen(port, '0.0.0.0', () => console.log(`DucAnhVPN API listening on :${port}`));
