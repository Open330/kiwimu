/**
 * IP address classification shared by the SSRF filter (ingest/web.ts)
 * and the server's rate-limit client key (server.ts).
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
