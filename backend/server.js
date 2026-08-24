const express = require('express');
const crypto = require('node:crypto');
const {
  db, makeUserCode, publicUser, getUserById, getUserByEmail, listPlans, getPlanById, getPlanBySlug,
  createOrder, getOrderByIdForUser, listOrdersForUser, cancelOrderForUser, markOrderPaid, getActiveSubscription,
  getActiveVpnProvisionContext, getVpnProvisionContext, getVpnProvisionByOrderId, getVpnProvisionByUserId,
  updateVpnProvisionStatus,
  createSession, getSessionByToken, revokeSession, revokeOtherSessions, revokeAllSessions, hashToken,
  createPasswordResetCode, getPasswordResetCode, incrementPasswordResetAttempts, consumePasswordResetCode,
} = require('./db');
const { isMailerConfigured, sendPasswordResetCode } = require('./mailer');
const { XuiError, XuiClient, createXuiConfig } = require('./xui');
const { getSubscriptionPayload, provisionOrder } = require('./xui-provision');

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const sessionCookie = process.env.SESSION_COOKIE_NAME || 'perral_session';
const allowedOrigin = process.env.FRONTEND_ORIGIN || '';
const attempts = new Map();
const xuiConfig = createXuiConfig();
const xuiClient = xuiConfig ? new XuiClient(xuiConfig) : null;

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
function resetCodeHash(code) { return hashToken(String(code || '').trim()); }
function safeCompare(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function genericResetResponse(res) {
  return res.json({ ok: true, message: 'Nếu email tồn tại, mã đặt lại mật khẩu đã được gửi.' });
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'perral-api', time: new Date().toISOString() }));

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

async function syncOrderToXui(orderId) {
  const context = getVpnProvisionContext(orderId);
  if (!context) throw new XuiError('Không tìm thấy context gói VPN để đồng bộ.');
  return provisionOrder({ xui: xuiClient, config: xuiConfig, context });
}

async function publicVpnSubscription(userId) {
  const provision = getVpnProvisionByUserId(userId);
  return provision ? getSubscriptionPayload({ xui: xuiClient, config: xuiConfig, provision }) : null;
}

app.get('/api/account/vpn', requireAuth, async (req, res) => {
  try {
    const data = await publicVpnSubscription(req.user.id);
    res.json({ ok: true, data });
  } catch (error) {
    console.error('VPN subscription read failed:', error.name || 'Error');
    res.status(error instanceof XuiError ? 503 : 500).json({ ok: false, message: 'Không thể lấy thông tin VPN lúc này.' });
  }
});

app.post('/api/account/vpn/sync', requireAuth, async (req, res) => {
  const context = getActiveVpnProvisionContext(req.user.id);
  if (!context) return res.status(400).json({ ok: false, message: 'Bạn chưa có gói VPN đang hoạt động.' });
  try {
    await syncOrderToXui(context.order_id);
    const data = await publicVpnSubscription(req.user.id);
    res.json({ ok: true, message: 'Đã đồng bộ gói VPN với máy chủ.', data });
  } catch (error) {
    const existing = getVpnProvisionByOrderId(context.order_id);
    if (existing) updateVpnProvisionStatus(context.order_id, 'error', '3x-ui synchronization failed');
    console.error('VPN synchronization failed:', error.name || 'Error');
    res.status(error instanceof XuiError ? 503 : 500).json({ ok: false, message: 'Lỗi server' });
  }
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

app.post('/api/admin/grant-plan', async (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return res.status(503).json({ ok: false, message: 'Chưa cấu hình khóa quản trị thanh toán.' });
  if (req.get('x-admin-key') !== adminKey) return res.status(401).json({ ok: false, message: 'Không có quyền cấp gói.' });

  const identifier = String(req.body.email || req.body.userId || '').trim();
  const planSlug = String(req.body.planSlug || '').trim();
  const user = identifier.includes('@') ? getUserByEmail(identifier) : db.prepare('SELECT * FROM users WHERE user_id_code = ?').get(identifier);
  const plan = getPlanBySlug(planSlug);
  if (!user) return res.status(404).json({ ok: false, message: 'Không tìm thấy tài khoản.' });
  if (!plan) return res.status(404).json({ ok: false, message: 'Không tìm thấy gói VPN hoặc gói đã ngừng bán.' });

  const order = createOrder({
    userId: user.id,
    planId: plan.id,
    cycleMonths: 1,
    subtotal: plan.price_vnd,
    discount: plan.price_vnd,
    total: 0,
    paymentMethod: 'admin_grant',
  });
  const paidOrder = markOrderPaid(order.id);
  if (!paidOrder) return res.status(500).json({ ok: false, message: 'Không thể tạo subscription audit.' });
  try {
    await syncOrderToXui(order.id);
    const vpn = await publicVpnSubscription(user.id);
    return res.json({ ok: true, message: 'Đã cấp gói VPN và đồng bộ client 3x-ui.', data: { order: paidOrder, vpn } });
  } catch (error) {
    console.error('Direct VPN grant failed:', error.name || 'Error');
    return res.status(502).json({ ok: false, message: 'Đã tạo subscription nhưng chưa provision được client 3x-ui.', data: { order: paidOrder, vpnSync: 'error' } });
  }
});

app.post('/api/admin/orders/:id/mark-paid', async (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return res.status(503).json({ ok: false, message: 'Chưa cấu hình khóa quản trị thanh toán.' });
  if (req.get('x-admin-key') !== adminKey) return res.status(401).json({ ok: false, message: 'Không có quyền xác nhận thanh toán.' });
  const order = markOrderPaid(req.params.id);
  if (!order) return res.status(400).json({ ok: false, message: 'Đơn hàng không tồn tại hoặc không thể xác nhận.' });
  try {
    await syncOrderToXui(req.params.id);
    res.json({ ok: true, message: 'Đã xác nhận thanh toán, kích hoạt và đồng bộ gói cước.', data: { order, vpnSync: 'active' } });
  } catch (error) {
    console.error('VPN provisioning after payment failed:', error.name || 'Error');
    res.status(502).json({ ok: false, message: 'Đã xác nhận thanh toán nhưng chưa đồng bộ được client 3x-ui. Có thể bấm Đồng bộ lại sau khi kiểm tra cấu hình.', data: { order, vpnSync: 'error' } });
  }
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

app.post('/api/auth/request-password-reset', rateLimit, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!validEmail(email)) return res.status(400).json({ ok: false, message: 'Email không hợp lệ.' });
  if (!isMailerConfigured()) return res.status(503).json({ ok: false, message: 'Chức năng email chưa được cấu hình trên máy chủ.' });

  const user = getUserByEmail(email);
  // Keep the same response for unknown emails to prevent account enumeration.
  if (!user) return genericResetResponse(res);

  const code = String(crypto.randomInt(100000, 1000000));
  const expiresMinutes = Number(process.env.RESET_CODE_EXPIRES_MINUTES || 10);
  const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();
  createPasswordResetCode(email, resetCodeHash(code), expiresAt);

  try {
    await sendPasswordResetCode({ to: email, code, expiresMinutes });
  } catch (error) {
    console.error('Password reset email failed:', error.message);
    return res.status(502).json({ ok: false, message: 'Không thể gửi email lúc này. Vui lòng thử lại sau.' });
  }
  return genericResetResponse(res);
});

app.post('/api/auth/reset-password', rateLimit, (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = safeText(req.body.code, 12);
  const newPassword = String(req.body.newPassword || '');
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, message: 'Email hoặc mã xác nhận không hợp lệ.' });
  if (newPassword.length < 8) return res.status(400).json({ ok: false, message: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });

  const reset = getPasswordResetCode(email);
  if (!reset || reset.attempts >= 5 || new Date(reset.expires_at).getTime() <= Date.now()) {
    return res.status(400).json({ ok: false, message: 'Mã không hợp lệ hoặc đã hết hạn.' });
  }
  if (!safeCompare(reset.code_hash, resetCodeHash(code))) {
    incrementPasswordResetAttempts(reset.id);
    return res.status(400).json({ ok: false, message: 'Mã không hợp lệ hoặc đã hết hạn.' });
  }

  const user = getUserByEmail(email);
  if (!user) return res.status(400).json({ ok: false, message: 'Mã không hợp lệ hoặc đã hết hạn.' });
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashPassword(newPassword), user.id);
    consumePasswordResetCode(reset.id);
    revokeAllSessions(user.id);
  })();
  return res.json({ ok: true, message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.' });
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

app.listen(port, '0.0.0.0', () => console.log(`PerralVPN API listening on :${port}`));
