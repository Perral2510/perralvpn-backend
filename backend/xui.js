'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');

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
    return profiles[planSlug] || profiles[String(planId)] || null;
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
