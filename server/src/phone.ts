import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';

export type Address = { address: string; kind: 'tailscale' | 'lan'; iface: string };

const octets = (a: string) => a.split('.').map(Number);
/** 100.64.0.0/10 is Tailscale's (CGNAT) range. */
const isTailscale = (a: string, iface: string) => { const [x, y] = octets(a); return iface.startsWith('tailscale') || (x === 100 && y >= 64 && y < 128); };
const isPrivate = (a: string) => { const [x, y] = octets(a); return x === 10 || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168); };

/** Addresses a phone could use to reach this machine: Tailscale and private-network IPv4 only, never public ones. */
export function phoneAddresses(ifaces = networkInterfaces()): Address[] {
  const out: Address[] = [];
  for (const [iface, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (isTailscale(i.address, iface)) out.push({ address: i.address, kind: 'tailscale', iface });
      else if (isPrivate(i.address)) out.push({ address: i.address, kind: 'lan', iface });
    }
  }
  return out;
}

/** One-time login codes for the phone QR: short-lived and single use, so a photo of the QR is worthless later. */
export class Pairing {
  private codes = new Map<string, number>();
  private ttlMs: number;
  private now: () => number;
  constructor(ttlMs = 5 * 60_000, now = Date.now) { this.ttlMs = ttlMs; this.now = now; }
  issue(): { code: string; expiresAt: number } {
    const t = this.now();
    for (const [c, exp] of this.codes) if (exp <= t) this.codes.delete(c);
    const code = randomBytes(18).toString('base64url');
    const expiresAt = t + this.ttlMs;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }
  redeem(code: string): boolean {
    const exp = this.codes.get(code);
    this.codes.delete(code);
    return exp !== undefined && exp > this.now();
  }
}
