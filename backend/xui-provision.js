'use strict';

const crypto = require('node:crypto');
const {
  getVpnProvisionByOrderId,
  getVpnSubscriptionGroupBySubscriptionId,
  listVpnSubscriptionClients,
  saveVpnSubscriptionGroup,
  deleteVpnSubscriptionClient,
  saveVpnSubscriptionClient,
  saveVpnProvision,
  updateVpnProvision,
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
  // 3x-ui calls this field "email"; keep the user's real account email visible.
  // The Xray client id remains the UUID generated below.
  const accountEmail = String(context.email || '').trim().toLowerCase();
  if (accountEmail && accountEmail.length <= 100) return accountEmail;
  const userPart = String(context.user_id_code || context.user_id).replace(/[^a-zA-Z0-9_-]/g, '-');
  return `perral-${userPart}`.slice(0, 100);
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

async function syncProvision({ xui, config, context, existingProvision = null, existingGroup = null }) {
  if (!xui || !config) throw new XuiError('Chưa cấu hình kết nối 3x-ui trên backend.');
  const inboundIds = resolveInboundIds(config, context);
  if (!inboundIds.length) {
    throw new XuiError(`Chưa cấu hình inbound cho gói ${context.plan_slug}. Đặt XUI_INBOUND_IDS_BY_PLAN hoặc XUI_DEFAULT_INBOUND_IDS.`);
  }

  const xuiEmail = makeXuiEmail(context);
  const sameClientIdentity = existingProvision?.xui_email === xuiEmail;
  const clientUuid = sameClientIdentity ? existingProvision.client_uuid : crypto.randomUUID();
  const subId = existingGroup?.sub_id || existingProvision?.sub_id || randomSubId();
  const client = buildClient(context, { clientUuid, xuiEmail, subId }, config);
  const { existing } = await findOrCreateClient(xui, client, inboundIds);
  const currentInboundIds = Array.isArray(existing?.inboundIds) ? existing.inboundIds.map(Number).filter(Number.isInteger) : [];
  const toAttach = inboundIds.filter((id) => !currentInboundIds.includes(id));
  const toDetach = currentInboundIds.filter((id) => !inboundIds.includes(id));
  await xui.attachClient(xuiEmail, toAttach);
  await xui.detachClient(xuiEmail, toDetach);

  const provision = existingProvision
    ? updateVpnProvision(existingProvision.id, { xuiEmail, clientUuid, subId, inboundIds, status: 'active', lastError: null })
    : saveVpnProvision({
      id: crypto.randomUUID(),
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
  const group = existingGroup || saveVpnSubscriptionGroup({
    id: crypto.randomUUID(), userId: context.user_id, planId: context.plan_id,
    subscriptionId: context.subscription_id, subId, status: 'active',
  });
  if (existingProvision?.xui_email && existingProvision.xui_email !== xuiEmail) {
    deleteVpnSubscriptionClient(group.id, existingProvision.xui_email);
  }
  const groupClient = saveVpnSubscriptionClient({ id: crypto.randomUUID(), groupId: group.id, xuiEmail, clientUuid });
  return { provision, group, groupClient, inboundIds, client };
}

function customVlessLinks({ xui, config, provision, clients = [] }) {
  const profile = xui.getVlessProfile(provision.plan_slug, provision.plan_id);
  if (!profile) throw new XuiError(`Chưa cấu hình VLESS profile cho gói ${provision.plan_slug || provision.plan_id}.`);
  return clients.map((client) => xui.buildVlessUrl(client.client_uuid, { ...profile, remark: client.remark || profile.remark }));
}

async function getSubscriptionPayload({ xui, config, group, provision }) {
  const source = group || provision;
  if (!source) return null;
  const clients = group ? listVpnSubscriptionClients(group.id) : [{ client_uuid: provision.client_uuid, xui_email: provision.xui_email }];
  const links = customVlessLinks({ xui, config, provision: source, clients });
  const customSubscriptionUrl = xui.buildCustomSubscriptionUrl(source.sub_id);
  if (!customSubscriptionUrl) throw new XuiError('Chưa cấu hình PUBLIC_API_URL cho custom subscription.');
  const subscriptionUrl = customSubscriptionUrl;
  return {
    subscriptionUrl,
    jsonUrl: null,
    clashUrl: null,
    vlessUrl: links[0],
    qrDataUrl: await xui.qrDataUrl(subscriptionUrl),
    links,
    warning: null,
    clients: clients.map((item) => ({ uuid: item.client_uuid, email: item.xui_email })),
  };
}

function buildCustomSubscriptionText({ xui, config, group, provision }) {
  const source = group || provision;
  const clients = group ? listVpnSubscriptionClients(group.id) : [{ client_uuid: provision.client_uuid, xui_email: provision.xui_email }];
  return `${customVlessLinks({ xui, config, provision: source, clients }).join('\n')}\n`;
}

async function addClientToGroup({ xui, config, group, inboundIds, clientEmail }) {
  if (!group) throw new XuiError('Không tìm thấy subscription group.');
  const email = String(clientEmail || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new XuiError('Email client bổ sung không hợp lệ.');
  const exists = await xui.getClient(email);
  if (exists) throw new XuiError('Email client này đã tồn tại trên 3x-ui.');
  const clientUuid = crypto.randomUUID();
  const client = buildClient({
    plan_slug: group.plan_slug, plan_id: group.plan_id, capacity: group.capacity,
    device_limit: group.device_limit, expires_at: group.expires_at,
  }, { clientUuid, xuiEmail: email, subId: group.sub_id }, config);
  await xui.addClient({ client, inboundIds });
  await xui.attachClient(email, inboundIds);
  const groupClient = saveVpnSubscriptionClient({ id: crypto.randomUUID(), groupId: group.id, xuiEmail: email, clientUuid });
  return { client, groupClient };
}

async function provisionOrder({ xui, config, context }) {
  const existing = getVpnProvisionByOrderId(context.order_id);
  const existingGroup = getVpnSubscriptionGroupBySubscriptionId(context.subscription_id);
  return syncProvision({ xui, config, context, existingProvision: existing, existingGroup });
}

module.exports = {
  getVpnProvisionByOrderId,
  getSubscriptionPayload,
  buildCustomSubscriptionText,
  addClientToGroup,
  parseQuotaBytes,
  provisionOrder,
  resolveInboundIds,
  syncProvision,
};
