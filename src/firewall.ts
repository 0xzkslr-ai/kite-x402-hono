export interface IpFilterConfig {
  allowlist?: string[] | undefined;
  blocklist?: string[] | undefined;
}

export interface IpFilterVerdict {
  allowed: boolean;
  reason?: 'blocked_by_blocklist' | 'not_in_allowlist' | 'invalid_ip';
}

/**
 * Parses comma-separated IP or CIDR strings into a cleaned array.
 */
export function parseIpList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Converts an IPv4 string (e.g. "192.168.1.1") to a 32-bit unsigned integer.
 */
export function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let num = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    num = (num << 8) + byte;
  }
  return num >>> 0;
}

/**
 * Checks whether an IPv4 address falls within a given CIDR block (e.g. "10.0.0.0/8" or "192.168.1.1").
 */
export function matchIpv4Cidr(ip: string, rule: string): boolean {
  const parts = rule.split('/');
  const subnet = parts[0];
  const prefixStr = parts[1];

  if (!subnet) return false;
  const ipNum = ipv4ToNumber(ip);
  const subnetNum = ipv4ToNumber(subnet);

  if (ipNum === null || subnetNum === null) {
    return false;
  }

  if (prefixStr === undefined) {
    return ipNum === subnetNum;
  }

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  if (prefix === 0) return true;
  const mask = ((~0 << (32 - prefix)) >>> 0);
  return (ipNum & mask) === (subnetNum & mask);
}

/**
 * Checks whether an IP matches a single rule (supports IPv4 and basic IPv6 match).
 */
export function matchesIpRule(clientIp: string, rule: string): boolean {
  const normalizedClient = clientIp.trim().toLowerCase();
  const normalizedRule = rule.trim().toLowerCase();

  // Handle IPv6 / localhost
  if (normalizedClient === '::1' || normalizedRule === '::1') {
    return normalizedClient === normalizedRule;
  }

  // IPv4 or IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1)
  const cleanIp = normalizedClient.startsWith('::ffff:')
    ? normalizedClient.slice(7)
    : normalizedClient;

  return matchIpv4Cidr(cleanIp, normalizedRule);
}

/**
 * Evaluates a client IP against configured allowlists and blocklists.
 */
export function evaluateIpFilter(clientIp: string | null | undefined, config: IpFilterConfig): IpFilterVerdict {
  if (!clientIp) {
    return { allowed: false, reason: 'invalid_ip' };
  }

  const cleanIp = clientIp.trim();
  if (cleanIp.length === 0) {
    return { allowed: false, reason: 'invalid_ip' };
  }

  // 1. Check explicit blocklist first (highest priority)
  if (config.blocklist && config.blocklist.length > 0) {
    const isBlocked = config.blocklist.some((rule) => matchesIpRule(cleanIp, rule));
    if (isBlocked) {
      return { allowed: false, reason: 'blocked_by_blocklist' };
    }
  }

  // 2. Check allowlist if configured (whitelist mode)
  if (config.allowlist && config.allowlist.length > 0) {
    const isAllowed = config.allowlist.some((rule) => matchesIpRule(cleanIp, rule));
    if (!isAllowed) {
      return { allowed: false, reason: 'not_in_allowlist' };
    }
  }

  return { allowed: true };
}

/**
 * Resolves client IP address from proxy request headers.
 */
export function extractClientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0];
    const client = first ? first.trim() : '';
    if (client.length > 0) return client;
  }

  const realIp = headers.get('x-real-ip');
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }

  const cfIp = headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim().length > 0) {
    return cfIp.trim();
  }

  return null;
}
