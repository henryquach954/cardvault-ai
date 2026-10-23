/**
 * UUID generation that works outside a secure context.
 *
 * `crypto.randomUUID()` is restricted to secure contexts: HTTPS, or the
 * special-cased `localhost`. Reaching the dev server from a phone means
 * `http://192.168.1.x:5173`, which is NEITHER -- so randomUUID is undefined
 * there and every call site throws. That is precisely the configuration this
 * app is meant to be used in, so relying on it would crash the app on the
 * device it was built for.
 *
 * `crypto.getRandomValues()` has no such restriction, so a v4 UUID is built
 * from it directly. Math.random is the last resort, used only if the Web
 * Crypto API is missing entirely.
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  (i + 0x100).toString(16).slice(1)
);

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const webcrypto = globalThis.crypto;

  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(bytes);
    return bytes;
  }

  // No Web Crypto at all. Not cryptographically strong, but these ids are
  // database keys, not secrets, and a working app beats a crashed one.
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** An RFC 4122 version 4 UUID. */
export function newId(): string {
  const webcrypto = globalThis.crypto;

  // Prefer the native implementation wherever it genuinely exists.
  if (typeof webcrypto?.randomUUID === 'function') {
    return webcrypto.randomUUID();
  }

  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx

  return (
    HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] + '-' +
    HEX[b[4]] + HEX[b[5]] + '-' +
    HEX[b[6]] + HEX[b[7]] + '-' +
    HEX[b[8]] + HEX[b[9]] + '-' +
    HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] + HEX[b[15]]
  );
}
