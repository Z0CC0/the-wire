// Formato di quello che viaggia sulla rete.
//
// Tutto a lunghezza fissa tranne il testo cifrato in coda: non c'e' nessun campo
// di lunghezza scritto dal mittente, quindi non c'e' niente da falsificare per
// far leggere al parser piu' byte di quanti ne esistano.
//
// Chi guarda il traffico vede: la sigla, la versione, delle chiavi pubbliche
// effimere e del rumore. Nessun nome, nessun testo, nessun destinatario.

import { cat, equalCT, te } from './codec.js';
import { HEADER_BYTES, decodeHeader, encodeHeader, type Header, type InitialMessage } from './ratchet.js';

export const MAGIC = te.encode('WIRE');
export const VERSION = 1;

export const TYPE_MESSAGE = 1;
export const TYPE_PREKEY = 2;

const PREKEY_BYTES = 32 * 4;
const PREFIX = MAGIC.length + 2;

export interface Envelope {
  readonly header: Header;
  readonly ciphertext: Uint8Array;
  /** presente solo sul primo messaggio di una sessione */
  readonly initial?: InitialMessage;
}

export const EMPTY = new Uint8Array(0);

/**
 * Serializzazione del blocco X3DH. Finisce anche nei dati autenticati della
 * cifratura: un campo che viaggia e non e' autenticato e' un campo che qualcuno
 * puo' riscrivere per strada. Legandolo al tag, non c'e' niente da riscrivere.
 */
export function encodePrekeyBlock(initial: InitialMessage | undefined): Uint8Array {
  if (!initial) return EMPTY;
  return cat(initial.identitySig, initial.identityDh, initial.ephemeral, initial.spkUsed);
}

export function encodeEnvelope(env: Envelope): Uint8Array {
  const kind = Uint8Array.of(VERSION, env.initial ? TYPE_PREKEY : TYPE_MESSAGE);
  return cat(MAGIC, kind, encodePrekeyBlock(env.initial), encodeHeader(env.header), env.ciphertext);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.length < PREFIX + HEADER_BYTES) throw new Error('busta troppo corta');
  if (!equalCT(bytes.subarray(0, MAGIC.length), MAGIC)) throw new Error('non e' + "' una busta THE WIRE");

  const version = bytes[MAGIC.length]!;
  if (version !== VERSION) throw new Error(`busta versione ${version}, questa build parla la ${VERSION}`);

  const type = bytes[MAGIC.length + 1]!;
  let off = PREFIX;
  let initial: InitialMessage | undefined;

  if (type === TYPE_PREKEY) {
    if (bytes.length < off + PREKEY_BYTES + HEADER_BYTES) throw new Error('busta prekey troncata');
    initial = {
      identitySig: bytes.subarray(off, off + 32),
      identityDh: bytes.subarray(off + 32, off + 64),
      ephemeral: bytes.subarray(off + 64, off + 96),
      spkUsed: bytes.subarray(off + 96, off + 128),
    };
    off += PREKEY_BYTES;
  } else if (type !== TYPE_MESSAGE) {
    throw new Error(`tipo di busta sconosciuto: ${type}`);
  }

  const header = decodeHeader(bytes.subarray(off, off + HEADER_BYTES));
  const ciphertext = bytes.subarray(off + HEADER_BYTES);
  if (ciphertext.length < 16) throw new Error('busta senza tag di autenticazione');

  return initial ? { header, ciphertext, initial } : { header, ciphertext };
}
