'use strict';

function clientIpEntryDetails(entry) {
  if (entry && typeof entry === 'object') {
    const ip = String(entry.ip || entry.IP || '').trim();
    const numericTimestamp = Number(entry.timestamp || entry.lastSeen || 0);
    if (Number.isFinite(numericTimestamp) && numericTimestamp > 0) {
      return { ip, timestamp: numericTimestamp > 1e12 ? numericTimestamp / 1000 : numericTimestamp };
    }
    const parsedTime = Date.parse(String(entry.time || entry.lastSeenAt || ''));
    return { ip, timestamp: Number.isFinite(parsedTime) ? parsedTime / 1000 : 0 };
  }

  const text = String(entry || '').trim();
  const match = text.match(/^(.*?)\s*\((\d{10,13})\)\s*$/);
  if (!match) return { ip: text, timestamp: 0 };
  const numericTimestamp = Number(match[2]);
  return { ip: match[1].trim(), timestamp: numericTimestamp > 1e12 ? numericTimestamp / 1000 : numericTimestamp };
}

function countRecentClientIps(entries, nowSeconds = Date.now() / 1000) {
  const parsed = (Array.isArray(entries) ? entries : [])
    .map(clientIpEntryDetails)
    .filter((entry) => entry.ip);
  if (!parsed.length) return 0;
  const withTimestamp = parsed.filter((entry) => entry.timestamp > 0);
  const live = withTimestamp.length
    ? withTimestamp.filter((entry) => nowSeconds - entry.timestamp <= 180 && nowSeconds - entry.timestamp >= -30)
    : parsed;
  return new Set(live.map((entry) => entry.ip)).size;
}

module.exports = { clientIpEntryDetails, countRecentClientIps };
