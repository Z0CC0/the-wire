// Identita' di THE WIRE.
//
// Nessuna registrazione, nessun server: l'identita' e' un insieme di chiavi
// generate in locale. Tre ruoli distinti invece di una chiave sola riusata:
//   - Ed25519    firma (prekey, annunci)
//   - X25519     scambio Diffie-Hellman di X3DH
//   - secp256k1  indirizzo di mailbox (Nostr usa Schnorr su questa curva)
// Riusare la stessa chiave per ruoli diversi si puo' fare, ma richiede
// conversioni delicate: qualche decina di byte in piu' toglie di mezzo
// un'intera categoria di errori.

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { base32, cat, groups, te, b64u, unb64u, hex } from './codec.js';

export const CARD_BYTES = 32 * 4 + 64; // sig, dh, spk, nostr, firma

/** Chiavi private: non escono da questo processo se non cifrate (vedi keystore). */
export interface Identity {
  readonly sigSecret: Uint8Array;
  readonly sigPublic: Uint8Array;
  readonly dhSecret: Uint8Array;
  readonly dhPublic: Uint8Array;
  /** Prekey firmata: permette a chi ti scrive di iniziare mentre sei offline. */
  readonly spkSecret: Uint8Array;
  readonly spkPublic: Uint8Array;
  /** Indirizzo di mailbox. Derivato dalla chiave di firma: un solo seme da salvare. */
  readonly nostrSecret: Uint8Array;
  readonly nostrPublic: Uint8Array;
  /** Copre spkPublic || nostrPublic: entrambi vanno legati all'identita'. */
  readonly spkSignature: Uint8Array;
  readonly createdAt: number;
}

/** La parte pubblica: e' questo che ti scambi di persona (QR o link). */
export interface ContactCard {
  readonly sigPublic: Uint8Array;
  readonly dhPublic: Uint8Array;
  readonly spkPublic: Uint8Array;
  readonly nostrPublic: Uint8Array;
  readonly spkSignature: Uint8Array;
}

/**
 * La chiave della mailbox non e' indipendente: la deriviamo dalla chiave di
 * firma. Cosi' un backup del solo seme ricostruisce tutto, e non c'e' un
 * secondo segreto che si puo' perdere da solo.
 */
export function deriveNostrSecret(sigSecret: Uint8Array): Uint8Array {
  for (let i = 0; i < 256; i++) {
    const candidate = hkdf(sha256, sigSecret, te.encode('WIRE-NOSTR-1'), Uint8Array.of(i), 32);
    // Non ogni sequenza di 32 byte e' uno scalare valido su secp256k1.
    if (secp256k1.utils.isValidSecretKey(candidate)) return candidate;
  }
  throw new Error('derivazione della chiave mailbox fallita');
}

/** Cio' che la firma della card protegge. */
function signedPart(spkPublic: Uint8Array, nostrPublic: Uint8Array): Uint8Array {
  return cat(te.encode('WIRE-SPK-1'), spkPublic, nostrPublic);
}

export function createIdentity(now = Date.now()): Identity {
  const sigSecret = ed25519.utils.randomSecretKey();
  const sigPublic = ed25519.getPublicKey(sigSecret);
  const dhSecret = x25519.utils.randomSecretKey();
  const dhPublic = x25519.getPublicKey(dhSecret);
  const spkSecret = x25519.utils.randomSecretKey();
  const spkPublic = x25519.getPublicKey(spkSecret);
  const nostrSecret = deriveNostrSecret(sigSecret);
  const nostrPublic = schnorr.getPublicKey(nostrSecret);
  const spkSignature = ed25519.sign(signedPart(spkPublic, nostrPublic), sigSecret);
  return {
    sigSecret, sigPublic, dhSecret, dhPublic,
    spkSecret, spkPublic, nostrSecret, nostrPublic,
    spkSignature, createdAt: now,
  };
}

export function cardOf(id: Identity): ContactCard {
  return {
    sigPublic: id.sigPublic,
    dhPublic: id.dhPublic,
    spkPublic: id.spkPublic,
    nostrPublic: id.nostrPublic,
    spkSignature: id.spkSignature,
  };
}

/**
 * Verifica che prekey e indirizzo di mailbox siano davvero firmati
 * dall'identita' che dicono. Senza questo controllo chiunque puo' sostituire
 * la prekey e leggere il primo messaggio, o dirottare la mailbox su di se'.
 * E' il punto in cui X3DH regge o cade.
 */
export function verifyCard(card: ContactCard): boolean {
  const lens = [card.sigPublic, card.dhPublic, card.spkPublic, card.nostrPublic];
  if (lens.some((k) => k?.length !== 32)) return false;
  if (card.spkSignature?.length !== 64) return false;
  try {
    return ed25519.verify(card.spkSignature, signedPart(card.spkPublic, card.nostrPublic), card.sigPublic);
  } catch {
    return false;
  }
}

// ---------- trasporto della card ----------

export function encodeCard(card: ContactCard): Uint8Array {
  return cat(card.sigPublic, card.dhPublic, card.spkPublic, card.nostrPublic, card.spkSignature);
}

export function decodeCard(bytes: Uint8Array): ContactCard {
  if (bytes.length !== CARD_BYTES) throw new Error(`card di ${bytes.length} byte, attesi ${CARD_BYTES}`);
  return {
    sigPublic: bytes.subarray(0, 32),
    dhPublic: bytes.subarray(32, 64),
    spkPublic: bytes.subarray(64, 96),
    nostrPublic: bytes.subarray(96, 128),
    spkSignature: bytes.subarray(128, 192),
  };
}

/** URI da mettere in un QR o da incollare in qualunque canale. */
export function cardToUri(card: ContactCard): string {
  return `wire:1:${b64u(encodeCard(card))}`;
}

export function cardFromUri(uri: string): ContactCard {
  const m = /^wire:1:([A-Za-z0-9_-]+)$/.exec(uri.trim());
  if (!m || !m[1]) throw new Error('URI non valido: atteso wire:1:<dati>');
  const card = decodeCard(unb64u(m[1]));
  if (!verifyCard(card)) throw new Error('firma della card non valida: manomessa o corrotta');
  return card;
}

/** Indirizzo di mailbox in esadecimale, come lo vuole Nostr. */
export function mailboxAddress(card: ContactCard): string {
  return hex(card.nostrPublic);
}

// ---------- indirizzo e impronta ----------

/** Indirizzo breve e leggibile. Serve a nominare, non a fidarsi. */
export function addressOf(card: ContactCard): string {
  const h = sha256(cat(te.encode('WIRE-ADDR-1'), card.sigPublic, card.dhPublic));
  return groups(base32(h.subarray(0, 10)), 4);
}

const FP_ROUNDS = 4096;

function fingerprintDigits(card: ContactCard): string {
  // Copre tutte e tre le chiavi pubbliche: leggere il numero a voce verifica
  // anche l'indirizzo di mailbox, non solo l'identita' crittografica.
  const material = cat(card.sigPublic, card.dhPublic, card.nostrPublic);
  let h = cat(te.encode('WIRE-FP-1'), material);
  // Iterazione ripetuta come in Signal: cercare una collisione parziale che
  // produca le stesse cifre mostrate all'utente costa 4096 volte tanto.
  for (let i = 0; i < FP_ROUNDS; i++) h = sha256(cat(h, material));
  let out = '';
  for (let i = 0; i < 30; i += 5) {
    let v = 0n;
    for (let j = 0; j < 5; j++) v = (v << 8n) | BigInt(h[i + j]!);
    out += (v % 100000n).toString().padStart(5, '0');
  }
  return out;
}

/**
 * Numero di sicurezza: le due parti lo leggono a voce e devono vedere lo stesso.
 * E' l'unico momento in cui l'uomo-nel-mezzo viene escluso davvero. L'ordine e'
 * deterministico, cosi' entrambi vedono le cifre nella stessa sequenza.
 */
export function safetyNumber(a: ContactCard, b: ContactCard): string {
  const da = fingerprintDigits(a);
  const db = fingerprintDigits(b);
  const [first, second] = da < db ? [da, db] : [db, da];
  return groups(first + second, 5, ' ');
}
