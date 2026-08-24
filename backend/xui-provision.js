'use strict';

const crypto = require('node:crypto');
const {
  getVpnProvisionByOrderId,
  saveVpnProvision,
} = require('./db');
const { XuiError, randomSubId } = require('./xui');

const GB = 1024 ** 3;

function parseQuotaBytes(capacity) {
  const text = String(capacity || '').toLowerCase().replaceAll(',', '');
  if (!text || text.includes('không giới hạn') || text.includes('unlimited')) return 0;
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(tb|gb)/);
  if (!match) return 0;
  const value = Number(match[1]);
  const multiplier = match[2] === 'tb' ? 1024 : 1;
  return Math.round(value * multiplier * GB);
}

function parseInboundIdList(value) {
  return String(value || '')
    .split(',')
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
}

function resolveInboundIds(config, context) {
  const map = config.inboundIdsByPlan || {};
  const configured = map[context.plan_slug] ?? map[String(context.plan_id)];
  const ids = Array.isArray(configured) ? configured.map(Number).filter((id) => Number.isInteger(id) && id > 0) : parseInboundIdList(configured);
  const fallback = ids.length ? ids : parseInboundIdList(config.defaultInboundIds);
  return [...new Set(fallback)];
}

function makeXuiEmail(context) {
  const userPart = String(context.user_id_code || context.user_id).replace(/[^a-zA-Z0-9_-]/g, '-');
  const orderPart = String(context.order_id).replace(/[^a-zA-Z0-9_-]/g, '-');
  return `perral-${userPart}-${orderPart}`.slice(0, 100);
}

function expiryTimestamp(context) {
  return context.expires_at ? Date.parse(context.expires_at) : 0;
}

function buildClient(context, { clientUuid, xuiEmail, subId }, config) {
  const quotaBytes = parseQuotaBytes(context.capacity);
  const deviceLimit = Number(context.device_limit || 0);
  return {
    id: clientUuid,
    email: xuiEmail,
    totalGB: quotaBytes,
    expiryTime: expiryTimestamp(context),
    limitIp: config.deviceLimitAsIpLimit ? deviceLimit : 0,
    limitHwid: deviceLimit,
    reset: /\/tháng|\/month|monthly/i.test(String(context.capacity || '')) ? 30 : 0,
    enable: true,
    subId,
    comment: `PerralVPN ${context.plan_slug} ${context.order_id}`,
  };
}

function existingClientIdentity(existing) {
  return existing?.client || existing;
}

async function findOrCreateClient(xui, client, inboundIds) {
  let existing = await xui.getClient(client.email);
  const existedBeforeCreate = Boolean(existing);
  if (!existing) {
    try {
      await xui.addClient({ client, inboundIds });
      existing = await xui.getClient(client.email);
    } catch (error) {
      // A concurrent retry may have won the create race. Re-read once and
      // only continue if the resulting client is really present.
      const raced = await xui.getClient(client.email).catch(() => null);
      if (!raced) throw error;
      existing = raced;
    }
  }
  const identity = existingClientIdentity(existing);
  if (!identity) throw new XuiError('3x-ui trả về client rỗng sau khi tạo.');
  if (existedBeforeCreate) {
    const ownedByPerral = identity.id === client.id || String(identity.comment || '').startsWith('PerralVPN ');
    if (!ownedByPerral) {
      throw new XuiError('Email client 3x-ui đã tồn tại nhưng không thuộc PerralVPN; dừng để tránh ghi đè client khác.');
    }
  }
  await xui.updateClient(client.email, client);
  return { existing, identity };
}

async function syncProvision({ xui, config, context, existingProvision = null }) {
  if (!xui || !config) throw new XuiError('Chưa cấu hình kết nối 3x-ui trên backend.');
  const inboundIds = resolveInboundIds(config, context);
  if (!inboundIds.length) {
    throw new XuiError(`Chưa cấu hình inbound cho gói ${context.plan_slug}. Đặt XUI_INBOUND_IDS_BY_PLAN hoặc XUI_DEFAULT_INBOUND_IDS.`);
  }

  const xuiEmail = existingProvision?.xui_email || makeXuiEmail(context);
  const clientUuid = existingProvision?.client_uuid || crypto.randomUUID();
  const subId = existingProvision?.sub_id || randomSubId();
  const client = buildClient(context, { clientUuid, xuiEmail, subId }, config);
  const { existing } = await findOrCreateClient(xui, client, inboundIds);
  const currentInboundIds = Array.isArray(existing?.inboundIds) ? existing.inboundIds.map(Number).filter(Number.isInteger) : [];
  const toAttach = inboundIds.filter((id) => !currentInboundIds.includes(id));
  const toDetach = currentInboundIds.filter((id) => !inboundIds.includes(id));
  await xui.attachClient(xuiEmail, toAttach);
  await xui.detachClient(xuiEmail, toDetach);

  const provision = saveVpnProvision({
    id: existingProvision?.id || crypto.randomUUID(),
    userId: context.user_id,
    orderId: context.order_id,
    subscriptionId: context.subscription_id,
    xuiEmail,
    clientUuid,
    subId,
    inboundIds,
    status: 'active',
    lastError: null,
  });
  return { provision, inboundIds, client };
}

async function getSubscriptionPayload({ xui, config, provision }) {
  if (!provision) return null;
  const urls = xui.buildSubscriptionUrls(provision.sub_id);
  let links = [];
  let warning = null;
  try {
    links = await xui.getSubLinks(provision.sub_id);
  } catch (error) {
    warning = 'Không lấy được các link riêng từ 3x-ui; URL subscription vẫn được tạo theo cấu hình sub path.';
  }
  return {
    subscriptionUrl: urls.subscriptionUrl,
    jsonUrl: urls.jsonUrl,
    clashUrl: urls.clashUrl,
    qrDataUrl: await xui.qrDataUrl(urls.subscriptionUrl),
    links,
    warning,
    client: {
      uuid: provision.client_uuid,
      inboundIds: JSON.parse(provision.inbound_ids_json || '[]'),
      status: provision.status,
      syncedAt: provision.updated_at,
    },
  };
}

async function provisionOrder({ xui, config, context }) {
  const existing = getVpnProvisionByOrderId(context.order_id);
  return syncProvision({ xui, config, context, existingProvision: existing });
}

module.exports = {
  getVpnProvisionByOrderId,
  getSubscriptionPayload,
  parseQuotaBytes,
  provisionOrder,
  resolveInboundIds,
  syncProvision,
};
