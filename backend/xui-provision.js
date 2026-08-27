'use strict';

const crypto = require('node:crypto');
const {
  getVpnProvisionByOrderId,
  getVpnProvisionByUserId,
  getVpnSubscriptionGroupBySubscriptionId,
  listVpnSubscriptionClients,
  saveVpnSubscriptionGroup,
  deleteVpnSubscriptionClient,
  saveVpnSubscriptionClient,
  saveVpnProvision,
  updateVpnProvision,
  rotateVpnClientUuids,
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
  const slug = String(context.plan_slug || '').trim().toLowerCase();
  const directKeys = [context.plan_slug, String(context.plan_id)];
  const logicalKeys = [];
  if (/^vina-khong-nen(?:-(?:pro|max|vv|mxh))?$/i.test(slug)) logicalKeys.push('vina-khong-nen');
  if (/^(?:basic-vpn|pro-vpn|vip-vpn|max-vpn|ultra-vpn)$/i.test(slug)) {
    logicalKeys.push(map.tiktok !== undefined ? 'tiktok' : 'vina-khong-nen');
  }
  if (/^(?:admin|premium-vpn|business-vpn|enterprise-vpn|vip-lifetime-vpn)$/i.test(slug)) {
    const compositeKeys = ['vina-khong-nen', 'tiktok'].filter((key) => map[key] !== undefined);
    logicalKeys.push(...(compositeKeys.length ? compositeKeys : ['vina-khong-nen']));
  }

  const configuredDirectKeys = directKeys.filter((key) => key && map[key] !== undefined);
  const keys = configuredDirectKeys.length ? [...new Set(configuredDirectKeys)] : [...new Set(logicalKeys)];
  const configuredIds = keys.flatMap((key) => {
    if (map[key] === undefined) return [];
    return Array.isArray(map[key])
      ? map[key].map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : parseInboundIdList(map[key]);
  });
  const ids = [...new Set(configuredIds)];
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

function planDisplayName(context) {
  return String(context.plan_name || context.plan_slug || 'VPN').replace(/\s+/g, ' ').trim().slice(0, 80) || 'VPN';
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
    comment: `PerralVPN - ${planDisplayName(context)}`,
  };
}

function existingClientIdentity(existing) {
  return existing?.client || existing;
}

async function findOrCreateClient(xui, client, inboundIds, { resetTraffic = false } = {}) {
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
  if (resetTraffic && existing) await xui.resetClientTraffic(client.email);
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
  const { existing } = await findOrCreateClient(xui, client, inboundIds, { resetTraffic: !existingProvision });
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

function buildMxhTcpOnlyConfig(xraySetting, { clientEmails, udpDenyRuleTag, udpDenyOutboundTag }) {
  const config = xraySetting && typeof xraySetting === 'object' ? structuredClone(xraySetting) : {};
  const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  const existingOutbound = outbounds.find((item) => item && item.tag === udpDenyOutboundTag);
  if (existingOutbound && existingOutbound.protocol !== 'blackhole') {
    throw new XuiError(`Outbound ${udpDenyOutboundTag} đã tồn tại nhưng không phải blackhole.`);
  }
  if (!existingOutbound && clientEmails.length) {
    outbounds.push({ tag: udpDenyOutboundTag, protocol: 'blackhole', settings: { response: { type: 'none' } } });
  }

  const routing = config.routing && typeof config.routing === 'object' ? config.routing : {};
  const currentRules = Array.isArray(routing.rules) ? routing.rules : [];
  const managedRuleTags = new Set([udpDenyRuleTag, 'perralvpn-block-games']);
  const preservedRules = currentRules.filter((rule) => !managedRuleTags.has(rule?.ruleTag));
  if (clientEmails.length) {
    preservedRules.unshift({
      type: 'field',
      user: clientEmails,
      network: 'udp',
      outboundTag: udpDenyOutboundTag,
      ruleTag: udpDenyRuleTag,
    });
  }
  const referencedOutboundTags = new Set(preservedRules.map((rule) => rule?.outboundTag).filter(Boolean));
  config.outbounds = outbounds.filter((outbound) => (
    outbound?.tag !== 'perralvpn-block-games'
    || outbound?.tag === udpDenyOutboundTag
    || outbound?.protocol !== 'blackhole'
    || referencedOutboundTags.has(outbound.tag)
  ));
  routing.rules = preservedRules;
  config.routing = routing;
  return config;
}

async function syncMxhTcpOnly({ xui, config, clientEmails = [] }) {
  if (!config?.mxhTcpOnlyEnabled) return { enabled: false, clientCount: 0 };
  const uniqueEmails = [...new Set(clientEmails.map((email) => String(email).trim().toLowerCase()).filter(Boolean))];
  const current = await xui.getXraySetting();
  const currentRules = Array.isArray(current?.routing?.rules) ? current.routing.rules : [];
  const currentOutbounds = Array.isArray(current?.outbounds) ? current.outbounds : [];
  const hasManagedRule = currentRules.some((rule) => ['perralvpn-mxh-udp-deny', 'perralvpn-block-games'].includes(rule?.ruleTag));
  const hasManagedOutbound = currentOutbounds.some((outbound) => ['perralvpn-mxh-udp-deny', 'perralvpn-block-games'].includes(outbound?.tag));
  if (!uniqueEmails.length && !hasManagedRule && !hasManagedOutbound) return { enabled: true, clientCount: 0, skipped: true };
  const next = buildMxhTcpOnlyConfig(current, {
    clientEmails: uniqueEmails,
    udpDenyRuleTag: config.mxhUdpDenyRuleTag,
    udpDenyOutboundTag: config.mxhUdpDenyOutboundTag,
  });
  await xui.updateXraySetting(next, config.xrayOutboundTestUrl);
  return { enabled: true, clientCount: uniqueEmails.length };
}

function customVlessLinks({ xui, config, provision, clients = [] }) {
  const profiles = typeof xui.getVlessProfiles === 'function'
    ? xui.getVlessProfiles(provision.plan_slug, provision.plan_id)
    : [xui.getVlessProfile(provision.plan_slug, provision.plan_id)].filter(Boolean);
  if (!profiles.length) throw new XuiError(`Chưa cấu hình VLESS profile cho gói ${provision.plan_slug || provision.plan_id}.`);
  const planName = planDisplayName(provision);
  const hasMultipleProfiles = profiles.length > 1;
  return clients.flatMap((client) => profiles.map((profile) => {
    const prefix = hasMultipleProfiles ? String(profile.remarkPrefix || '') : '';
    const remark = `${prefix}PerralVPN - ${planName}`;
    return xui.buildVlessUrl(client.client_uuid, { ...profile, remark });
  }));
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

function isPerralOwnedClient(identity, stored, group) {
  if (!identity) return false;
  if (String(identity.id || '') === String(stored.client_uuid || '')) return true;
  if (String(identity.subId || identity.subID || '') === String(group.sub_id || '')) return true;
  return /^PerralVPN(?:\s|-)/i.test(String(identity.comment || identity.remark || ''));
}

async function rotateSubscriptionClientUuids({ xui, config, group }) {
  if (!xui || !config) throw new XuiError('Chưa cấu hình kết nối 3x-ui trên backend.');
  if (!group) throw new XuiError('Không tìm thấy subscription group đang hoạt động.');
  const storedClients = listVpnSubscriptionClients(group.id);
  if (!storedClients.length) throw new XuiError('Subscription chưa có client để reset.');
  const updated = [];
  const rollback = async () => {
    await Promise.allSettled(updated.map(({ xuiEmail, oldClient }) => xui.updateClient(xuiEmail, oldClient)));
  };
  try {
    for (const stored of storedClients) {
      const existing = await xui.getClient(stored.xui_email);
      const identity = existing?.client || existing;
      if (!isPerralOwnedClient(identity, stored, group)) {
        throw new XuiError(`Không thể xác minh client 3x-ui của ${stored.xui_email}; giữ nguyên kết nối hiện tại.`);
      }
      const nextUuid = crypto.randomUUID();
      const nextClient = buildClient({
        plan_slug: group.plan_slug,
        plan_name: group.plan_name,
        plan_id: group.plan_id,
        capacity: group.capacity,
        device_limit: group.device_limit,
        expires_at: group.expires_at,
      }, { clientUuid: nextUuid, xuiEmail: stored.xui_email, subId: group.sub_id }, config);
      await xui.updateClient(stored.xui_email, nextClient);
      updated.push({ xuiEmail: stored.xui_email, oldClient: identity, clientUuid: nextUuid });
    }
    const primaryProvision = getVpnProvisionByUserId(group.user_id);
    const primary = updated.find((item) => item.xuiEmail === primaryProvision?.xui_email) || updated[0];
    const rotatedGroup = rotateVpnClientUuids({
      groupId: group.id,
      subscriptionId: group.subscription_id,
      clients: updated,
      primaryClientUuid: primary.clientUuid,
    });
    return { group: rotatedGroup, clients: updated };
  } catch (error) {
    await rollback();
    throw error;
  }
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
  rotateSubscriptionClientUuids,
  addClientToGroup,
  parseQuotaBytes,
  provisionOrder,
  resolveInboundIds,
  syncProvision,
  buildMxhTcpOnlyConfig,
  syncMxhTcpOnly,
};
