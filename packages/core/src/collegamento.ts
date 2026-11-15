// Collegare un secondo dispositivo.
//
// Il codice che il primo dispositivo mostra e il secondo inquadra. Dentro c'e'
// la CHIAVE PRIVATA dell'account, e va detto senza girarci intorno: chiunque
// fotografi quel codice mentre e' sullo schermo diventa un tuo dispositivo, e
// da li' legge tutto quello che ti scrivono.
//
// Per questo il codice porta una scadenza, e chi lo mostra dovrebbe tenerlo
// aperto il tempo di inquadrarlo e non un minuto di piu'. Non e' una misura
// crittografica — chi ha gia' fotografato lo schermo ha gia' vinto — ma
// restringe la finestra in cui uno schermo dimenticato acceso resta pericoloso.
//
// Perche' la chiave privata deve passare di qui: senza, il nuovo dispositivo
// non potrebbe firmarsi da solo come tuo, ne' firmare quelli che collegherai
// domani. L'alternativa sarebbe far dipendere ogni collegamento futuro dal
// primo dispositivo, e quel dispositivo prima o poi si perde.

import { b64u, hex, td, te, unb64u, unhex } from './codec.js';
import { CARD_BYTES, decodeCard, encodeCard, verifyCard, type ContactCard } from './identity.js';

const PREFISSO = 'wire-collega:1:';

/** Quanto vale un codice. Oltre, si rifa'. */
export const VALIDITA_CODICE_MS = 5 * 60 * 1000;

export interface CodiceCollegamento {
  /** La chiave privata dell'account: e' cio' che rende il codice pericoloso. */
  readonly accountSecret: Uint8Array;
  /** La card del dispositivo che invita, per potergli rispondere. */
  readonly card: ContactCard;
  /** Fino a quando vale. */
  readonly scadenza: number;
}

export function codiceToUri(c: CodiceCollegamento): string {
  const corpo = {
    k: hex(c.accountSecret),
    c: hex(encodeCard(c.card)),
    s: c.scadenza,
  };
  return PREFISSO + b64u(te.encode(JSON.stringify(corpo)));
}

/**
 * Rilegge un codice, e rifiuta quelli scaduti.
 *
 * `adesso` si passa dall'esterno per poter provare la scadenza senza aspettare
 * cinque minuti.
 */
export function codiceFromUri(uri: string, adesso = Date.now()): CodiceCollegamento {
  const s = uri.trim();
  if (!s.startsWith(PREFISSO)) throw new Error('non e un codice di collegamento');
  let corpo: { k?: unknown; c?: unknown; s?: unknown };
  try {
    corpo = JSON.parse(td.decode(unb64u(s.slice(PREFISSO.length)))) as typeof corpo;
  } catch {
    throw new Error('codice di collegamento illeggibile');
  }
  if (typeof corpo.k !== 'string' || corpo.k.length !== 64 || /[^0-9a-f]/.test(corpo.k)) {
    throw new Error('codice: chiave d account non valida');
  }
  if (typeof corpo.c !== 'string' || corpo.c.length !== CARD_BYTES * 2 || /[^0-9a-f]/.test(corpo.c)) {
    throw new Error('codice: card non valida');
  }
  const card = decodeCard(unhex(corpo.c));
  if (!verifyCard(card)) throw new Error('codice: la card non e firmata da se stessa');
  const scadenza = typeof corpo.s === 'number' && Number.isFinite(corpo.s) ? corpo.s : 0;
  if (scadenza <= adesso) throw new Error('codice scaduto: fanne uno nuovo sul primo dispositivo');
  return { accountSecret: unhex(corpo.k), card, scadenza };
}

/** Un codice nuovo, valido cinque minuti. */
export function nuovoCodice(accountSecret: Uint8Array, card: ContactCard, adesso = Date.now()): CodiceCollegamento {
  return { accountSecret, card, scadenza: adesso + VALIDITA_CODICE_MS };
}
