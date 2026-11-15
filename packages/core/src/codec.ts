// Codifiche binarie e testuali usate dal protocollo.
// Tutto big-endian, tutto a lunghezza fissa dove possibile: il parsing di dati
// che arrivano dalla rete non deve mai dipendere da campi di lunghezza scritti
// dal mittente senza controllo.

export const te = new TextEncoder();
export const td = new TextDecoder();

/** Concatena piu' buffer in uno solo. */
export function cat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`u32 fuori range: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function readU32(b: Uint8Array, off: number): number {
  if (off + 4 > b.length) throw new RangeError('u32: buffer troppo corto');
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, false);
}

/** Confronto a tempo costante: mai `===` su segreti o su tag di autenticazione. */
export function equalCT(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------- base64url ----------
//
// Scritte a mano invece di usare `Buffer`, che e' di Node e in un browser non
// esiste. Sono le funzioni piu' usate di tutto il cuore — card, indirizzi,
// buste — quindi bastavano loro a tenere il programma fuori da un telefono.
// `btoa`/`atob` esistono in tutti e due i posti, ma parlano base64 normale:
// base64url e' la stessa cosa con due caratteri diversi e senza riempimento.

export function b64u(b: Uint8Array): string {
  let s = '';
  // A fette: `String.fromCharCode(...b)` su un array grande supera il numero
  // massimo di argomenti e va in errore.
  for (let i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode.apply(null, [...b.subarray(i, Math.min(i + 8192, b.length))]);
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  const normale = s.replace(/-/g, '+').replace(/_/g, '/');
  // `atob` vuole la lunghezza multipla di quattro; base64url la lascia cadere.
  const pieno = normale + '='.repeat((4 - (normale.length % 4)) % 4);
  const testo = atob(pieno);
  const out = new Uint8Array(testo.length);
  for (let i = 0; i < testo.length; i++) out[i] = testo.charCodeAt(i);
  return out;
}

const CIFRE = '0123456789abcdef';

export function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += CIFRE[x >> 4]! + CIFRE[x & 15]!;
  return s;
}

export function unhex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error('hex non valido');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------- base32 Crockford, per gli indirizzi leggibili ----------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`carattere non valido nell'indirizzo: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Spezza una stringa in gruppi, per renderla leggibile a voce. */
export function groups(s: string, size: number, sep = '-'): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.join(sep);
}
