'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');

const ZERO_BASE_HOST = 'vnpt.theworkpc.com';
const TIKTOK_HOST = 'api24-normal-alisg.tiktokv.com';
const ZERO_BASE_PLANS = new Set([
  'vina-khong-nen', 'vina-khong-nen-pro', 'vina-khong-nen-max', 'vina-khong-nen-vv', 'vina-khong-nen-mxh',
]);
const TIKTOK_PLANS = new Set(['basic-vpn', 'pro-vpn', 'vip-vpn', 'max-vpn', 'ultra-vpn']);
const COMPOSITE_PLANS = new Set(['admin', 'premium-vpn', 'business-vpn', 'enterprise-vpn', 'vip-lifetime-vpn']);

class XuiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'XuiError';
    Object.assign(this, details);
  }
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function cleanPath(value, fallback) {
  const path = String(value || fallback).trim();
  return `/${path.replace(/^\/+|\/+$/g, '')}/`;
}

function parseJsonEnv(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    throw new Error(`XUI_INBOUND_IDS_BY_PLAN không phải JSON hợp lệ: ${error.message}`);
  }
}

function randomSubId() {
  return crypto.randomBytes(24).toString('hex');
}

function createXuiConfig(env = process.env) {
  const panelBaseUrl = cleanBaseUrl(env.XUI_BASE_URL);
  const apiToken = String(env.XUI_API_TOKEN || '').trim();
  if (!panelBaseUrl || !apiToken) return null;

  const subscriptionBaseUrl = cleanBaseUrl(env.XUI_SUB_BASE_URL || panelBaseUrl);
  return {
    panelBaseUrl,
    apiToken,
    subscriptionBaseUrl,
    publicApiBaseUrl: cleanBaseUrl(env.PUBLIC_API_URL || env.APP_PUBLIC_URL),
    vlessProfiles: parseJsonEnv(env.XUI_VLESS_PROFILES, {}),
    subscriptionPath: cleanPath(env.XUI_SUB_PATH, '/sub/'),
    jsonPath: cleanPath(env.XUI_JSON_PATH, '/json/'),
    clashPath: cleanPath(env.XUI_CLASH_PATH, '/clash/'),
    timeoutMs: Math.max(1000, Number(env.XUI_TIMEOUT_MS || 10000)),
    inboundIdsByPlan: parseJsonEnv(env.XUI_INBOUND_IDS_BY_PLAN, {}),
    defaultInboundIds: String(env.XUI_DEFAULT_INBOUND_IDS || '').trim(),
    deviceLimitAsIpLimit: String(env.XUI_DEVICE_LIMIT_AS_IP_LIMIT || 'false').toLowerCase() === 'true',
    gameBlockingEnabled: String(env.XUI_GAME_BLOCKING_ENABLED || 'true').toLowerCase() !== 'false',
    gameBlockedPlanSlugs: String(env.XUI_GAME_BLOCKED_PLAN_SLUGS || 'vina-khong-nen-mxh')
      .split(',').map((slug) => slug.trim().toLowerCase()).filter(Boolean),
    gameBlockingRuleTag: String(env.XUI_GAME_BLOCKING_RULE_TAG || 'perralvpn-block-games').trim(),
    gameBlockingOutboundTag: String(env.XUI_GAME_BLOCKING_OUTBOUND_TAG || 'perralvpn-block-games').trim(),
    xrayOutboundTestUrl: String(env.XUI_OUTBOUND_TEST_URL || 'https://www.google.com/generate_204').trim(),
  };
}

class XuiClient {
  constructor(config) {
    this.config = config;
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.config.apiToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };
    try {
      const response = await fetch(`${this.config.panelBaseUrl}${path}`, {
        ...options,
        headers,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new XuiError(`3x-ui HTTP ${response.status}`, { status: response.status, payload });
      }
      if (payload && payload.success === false) {
        throw new XuiError(payload.msg || '3x-ui từ chối yêu cầu', { status: response.status, payload });
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new XuiError('Kết nối 3x-ui hết thời gian chờ.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async getXraySetting() {
    const payload = await this.request('/panel/api/xray/', { method: 'POST' });
    let value = payload?.obj ?? payload?.data ?? payload;
    if (typeof value === 'string') value = JSON.parse(value);
    if (value && typeof value.xraySetting === 'string') value.xraySetting = JSON.parse(value.xraySetting);
    if (value && value.xraySetting && typeof value.xraySetting === 'object') return value.xraySetting;
    if (value && typeof value === 'object' && (value.routing || value.inbounds || value.outbounds)) return value;
    throw new XuiError('3x-ui trả về cấu hình Xray không hợp lệ.');
  }

  async updateXraySetting(xraySetting, outboundTestUrl) {
    const form = new URLSearchParams({
      xraySetting: JSON.stringify(xraySetting),
      outboundTestUrl: String(outboundTestUrl || this.config.xrayOutboundTestUrl || 'https://www.google.com/generate_204'),
    });
    return this.request('/panel/api/xray/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: form.toString(),
    });
  }

  async getClient(email) {
    try {
      const payload = await this.request(`/panel/api/clients/get/${encodeURIComponent(email)}`);
      return payload.obj || null;
    } catch (error) {
      const message = String(error.message || '').toLowerCase();
      if (error.status === 404 || message.includes('not found') || message.includes('không tìm thấy')) return null;
      throw error;
    }
  }

  async getClientTraffic(email) {
    const payload = await this.request(`/panel/api/clients/traffic/${encodeURIComponent(email)}`);
    const value = payload.obj || payload.data || {};
    const upload = Number(value.up ?? value.upload ?? 0) || 0;
    const download = Number(value.down ?? value.download ?? 0) || 0;
    // 3x-ui's `total` field is the client's quota, not consumed traffic.
    // Usage must always be calculated from upload + download.
    return { upload, download, total: upload + download };
  }

  async getClientHwids(email) {
    const payload = await this.request(`/panel/api/clients/hwids/${encodeURIComponent(email)}`, { method: 'POST' });
    return Array.isArray(payload.obj) ? payload.obj : [];
  }

  async getClientIps(email) {
    const payload = await this.request(`/panel/api/clients/ips/${encodeURIComponent(email)}`, { method: 'POST' });
    return Array.isArray(payload.obj) ? payload.obj : [];
  }

  async resetClientTraffic(email) {
    return this.request(`/panel/api/clients/resetTraffic/${encodeURIComponent(email)}`, { method: 'POST' });
  }

  async getClientUsage(email) {
    const [client, traffic, hwids, ips] = await Promise.all([
      this.getClient(email),
      this.getClientTraffic(email),
      this.getClientHwids(email).catch(() => []),
      this.getClientIps(email).catch(() => []),
    ]);
    return { client, traffic, hwids, ips };
  }

  async addClient({ client, inboundIds }) {
    return this.request('/panel/api/clients/add', {
      method: 'POST',
      body: JSON.stringify({ client, inboundIds }),
    });
  }

  async updateClient(email, client) {
    return this.request(`/panel/api/clients/update/${encodeURIComponent(email)}`, {
      method: 'POST',
      body: JSON.stringify(client),
    });
  }

  async attachClient(email, inboundIds) {
    if (!inboundIds.length) return;
    return this.request(`/panel/api/clients/${encodeURIComponent(email)}/attach`, {
      method: 'POST',
      body: JSON.stringify({ inboundIds }),
    });
  }

  async detachClient(email, inboundIds) {
    if (!inboundIds.length) return;
    return this.request(`/panel/api/clients/${encodeURIComponent(email)}/detach`, {
      method: 'POST',
      body: JSON.stringify({ inboundIds }),
    });
  }

  async getSubLinks(subId) {
    const payload = await this.request(`/panel/api/clients/subLinks/${encodeURIComponent(subId)}`);
    return Array.isArray(payload.obj) ? payload.obj : [];
  }

  buildSubscriptionUrls(subId) {
    const encoded = encodeURIComponent(subId);
    return {
      subscriptionUrl: `${this.config.subscriptionBaseUrl}${this.config.subscriptionPath}${encoded}`,
      jsonUrl: `${this.config.subscriptionBaseUrl}${this.config.jsonPath}${encoded}`,
      clashUrl: `${this.config.subscriptionBaseUrl}${this.config.clashPath}${encoded}`,
    };
  }

  getVlessProfile(planSlug, planId) {
    const profiles = this.config.vlessProfiles || {};
    const slug = String(planSlug || '').trim().toLowerCase();
    const keys = [planSlug, String(planId)];
    if (ZERO_BASE_PLANS.has(slug)) keys.push('vina-khong-nen');
    if (TIKTOK_PLANS.has(slug) || COMPOSITE_PLANS.has(slug)) keys.push('tiktok');
    for (const key of keys) {
      if (key && profiles[key]) return profiles[key];
    }
    return null;
  }

  getVlessProfiles(planSlug, planId) {
    const slug = String(planSlug || '').trim().toLowerCase();
    const isZeroBase = ZERO_BASE_PLANS.has(slug) || COMPOSITE_PLANS.has(slug);
    const isTikTok = TIKTOK_PLANS.has(slug) || COMPOSITE_PLANS.has(slug);
    const profiles = [];
    if (!isZeroBase && !isTikTok) {
      const legacyProfile = this.getVlessProfile(planSlug, planId);
      return legacyProfile ? [legacyProfile] : [];
    }
    const zeroProfile = this.getVlessProfile('vina-khong-nen', 7) || this.getVlessProfile(planSlug, planId);
    const tiktokProfile = this.getVlessProfile('tiktok', null) || this.getVlessProfile(planSlug, planId) || zeroProfile;
    if (isZeroBase && zeroProfile) profiles.push({ ...zeroProfile, address: ZERO_BASE_HOST, remarkPrefix: '(Vina) ' });
    if (isTikTok && tiktokProfile) profiles.push({ ...tiktokProfile, address: TIKTOK_HOST, remarkPrefix: '(tiktok) ' });
    return profiles;
  }

  buildCustomSubscriptionUrl(subId) {
    if (!this.config.publicApiBaseUrl) return null;
    return `${this.config.publicApiBaseUrl}/api/account/vpn/sub/${encodeURIComponent(subId)}`;
  }

  buildVlessUrl(uuid, profile = {}) {
    const address = String(profile.address || '').trim();
    const port = Number(profile.port || 443);
    if (!address || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new XuiError('VLESS profile thiếu address hoặc port hợp lệ.');
    }
    const params = new URLSearchParams();
    for (const key of ['path', 'security', 'encryption', 'host', 'fp', 'type', 'sni', 'flow']) {
      if (profile[key] !== undefined && profile[key] !== null && String(profile[key]) !== '') params.set(key, String(profile[key]));
    }
    const query = params.toString();
    const remark = String(profile.remark || 'PerralVPN').trim();
    return `vless://${encodeURIComponent(uuid)}@${address}:${port}${query ? `?${query}` : ''}#${encodeURIComponent(remark)}`;
  }

  async qrDataUrl(url) {
    return QRCode.toDataURL(url, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  }
}

module.exports = {
  XuiError,
  XuiClient,
  createXuiConfig,
  randomSubId,
};
