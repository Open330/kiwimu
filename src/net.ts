/**
 * IP address classification shared by the server's rate-limit client key and
 * the outbound web-ingest SSRF filter.
 */

/**
 * True if the address is private/internal/loopback.
 * Accepts IPv4 dotted-quad and IPv6 (with or without brackets,
 * including IPv4-mapped `::ffff:a.b.c.d` forms).
 */
export function isPrivateIp(ip: string): boolean {
  let addr = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (addr.startsWith("::ffff:")) {
    // IPv4-mapped: either dotted (::ffff:127.0.0.1) or the WHATWG-canonical
    // hex-group form (::ffff:7f00:1) — normalize both to dotted-quad.
    const rest = addr.slice(7);
    if (rest.includes(":")) {
      const [hiHex, loHex] = rest.split(":");
      const hi = parseInt(hiHex || "0", 16);
      const lo = parseInt(loHex || "0", 16);
      if (rest.split(":").length === 2 && !Number.isNaN(hi) && !Number.isNaN(lo)) {
        addr = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      }
    } else {
      addr = rest;
    }
  }

  const ipv4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 127 ||                          // 127.0.0.0/8 loopback
      a === 10 ||                           // 10.0.0.0/8
      a === 0 ||                            // 0.0.0.0/8 "this network"
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12
      (a === 192 && b === 168) ||           // 192.168.0.0/16
      (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local (cloud metadata)
      (a === 100 && b >= 64 && b <= 127)    // 100.64.0.0/10 CGNAT
    );
  }

  if (addr.includes(":")) {
    if (addr === "::" || addr === "::1") return true;   // unspecified / loopback
    if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(addr)) return true;            // fe80::/10 link-local
    return false;
  }

  return false;
}

function parseIpv4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function parseIpv6(ip: string): number[] | undefined {
  let address = ip.toLowerCase();
  const lastColon = address.lastIndexOf(":");
  const lastPart = address.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    const ipv4 = parseIpv4(lastPart);
    if (!ipv4) return undefined;
    address = `${address.slice(0, lastColon + 1)}${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return [];
    const groups = half.split(":");
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
    return groups.map((group) => parseInt(group, 16));
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;

  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : undefined;
}

/**
 * True only for addresses safe as direct outbound Internet destinations.
 * This is intentionally stricter than `!isPrivateIp`: documentation,
 * multicast, benchmark, unspecified and other non-global ranges must never
 * be fetched even though they are not all private LAN addresses.
 */
export function isPublicIp(ip: string): boolean {
  const address = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (
      a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 2 || b === 168 || (b === 31 && c === 196) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    ) return false;
    return true;
  }

  const ipv6 = parseIpv6(address);
  if (!ipv6) return false;
  const [first, second] = ipv6;
  // Global IPv6 unicast is 2000::/3. This excludes IPv4-compatible/mapped,
  // loopback, ULA, link-local, multicast and IPv4 translation prefixes.
  if ((first! & 0xe000) !== 0x2000) return false;
  // IANA non-globally-reachable IPv6 special-purpose allocations within it.
  if (first === 0x2001 && second! <= 0x01ff) return false; // 2001::/23
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // deprecated 6to4 embedding
  if (first === 0x3fff && second! <= 0x0fff) return false; // documentation
  return true;
}
