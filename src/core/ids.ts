/** Stable random identifiers (UUID v4 shape) and timestamps. */

type RandomFill = (bytes: Uint8Array) => Uint8Array;

function defaultFill(bytes: Uint8Array): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: RandomFill } }).crypto;
  if (!c?.getRandomValues) {
    throw new Error('Secure random source unavailable (crypto.getRandomValues missing)');
  }
  return c.getRandomValues(bytes);
}

let fill: RandomFill = defaultFill;

/** Tests and the app entry point can install a random source (expo-crypto on device). */
export function setRandomSource(fn: RandomFill): void {
  fill = fn;
}

export function randomBytes(n: number): Uint8Array {
  return fill(new Uint8Array(n));
}

export function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Entity ids are URL/path safe and accepted by the server's id validator. */
export function newId(prefix: string): string {
  return `${prefix}_${uuid().replace(/-/g, '').slice(0, 20)}`;
}

export function nowIso(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}

/** Small non-cryptographic hash for idempotency keys (FNV-1a, 52-bit safe). */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}
