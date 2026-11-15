// Piu' dispositivi, una persona sola.
//
// Fino a qui un'identita' era un dispositivo. Va bene finche' il programma sta
// su un computer solo, e smette di andare bene appena si vuole scrivere anche
// dal telefono.
//
// Perche' non basta copiare le chiavi sul telefono. Il Double Ratchet e' una
// sessione fra DUE DISPOSITIVI, non fra due persone: due copie della stessa
// identita' farebbero avanzare lo stesso ratchet da due parti, bruciando gli
// stessi numeri di messaggio. E' esattamente il difetto che ha reso muta una
// conversazione vera — moltiplicato, e senza possibilita' di rimedio.
//
// Quindi ogni dispositivo tiene chiavi sue, e chi ti scrive cifra una volta per
// ciascuno. E' il modello di Signal, ridotto all'osso.
//
// Cosa tiene insieme i dispositivi: una CHIAVE D'ACCOUNT, che il primo
// dispositivo genera e passa agli altri quando li colleghi. Ogni dispositivo
// viene firmato con quella chiave, quindi chi ti scrive puo' verificare da solo
// che un dispositivo sia davvero tuo, senza fidarsi di chi glielo racconta.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { casuali } from './casuale.js';
import { b64u, cat, hex, td, te, unb64u } from './codec.js';
import { CARD_BYTES, decodeCard, encodeCard, verifyCard, type ContactCard } from './identity.js';

/** Un dispositivo di qualcuno: la sua card, e la firma che lo lega all'account. */
export interface Dispositivo {
  /** Indirizzo del dispositivo: esadecimale della sua chiave di firma. */
  readonly id: string;
  readonly card: ContactCard;
  /** Come lo chiama chi lo possiede. Solo per farlo riconoscere a occhio. */
  readonly nome: string;
  /** Firma della chiave d'account su questo dispositivo. */
  readonly firma: Uint8Array;
  readonly aggiuntoIl: number;
}

/** La chiave che tiene insieme i dispositivi di una persona. */
export interface ChiaveAccount {
  readonly secret: Uint8Array;
  readonly publicKey: Uint8Array;
}

export function creaChiaveAccount(): ChiaveAccount {
  const secret = casuali(32);
  return { secret, publicKey: ed25519.getPublicKey(secret) };
}

/**
 * Cosa firma la chiave d'account.
 *
 * La card per intero, non il solo identificativo: firmare l'identificativo
 * lascerebbe libero di sostituire le chiavi sotto lo stesso nome. Dentro c'e'
 * anche l'account, o una firma fatta per un account potrebbe essere riusata in
 * un altro.
 */
function daFirmare(accountPublic: Uint8Array, card: ContactCard): Uint8Array {
  return cat(te.encode('WIRE-DISPOSITIVO-1'), accountPublic, encodeCard(card));
}

export function firmaDispositivo(
  chiave: ChiaveAccount,
  card: ContactCard,
  nome: string,
  aggiuntoIl = Date.now()
): Dispositivo {
  return {
    id: hex(card.sigPublic),
    card,
    nome: nome.trim().slice(0, 60),
    firma: ed25519.sign(daFirmare(chiave.publicKey, card), chiave.secret),
    aggiuntoIl,
  };
}

/**
 * Un dispositivo e' davvero di quell'account?
 *
 * Due controlli, e servono tutti e due: la card deve essere firmata da se'
 * stessa (che lega prekey e indirizzo di mailbox alla sua identita'), e
 * l'account deve aver firmato la card. Saltare il primo lascerebbe passare un
 * dispositivo con una prekey altrui.
 */
export function dispositivoValido(accountPublic: Uint8Array, d: Dispositivo): boolean {
  if (d.id !== hex(d.card.sigPublic)) return false;
  if (!verifyCard(d.card)) return false;
  try {
    return ed25519.verify(d.firma, daFirmare(accountPublic, d.card), accountPublic);
  } catch {
    return false;
  }
}

/** Solo i dispositivi che reggono il controllo, senza doppioni. */
export function dispositiviValidi(accountPublic: Uint8Array, elenco: readonly Dispositivo[]): Dispositivo[] {
  const visti = new Set<string>();
  const out: Dispositivo[] = [];
  for (const d of elenco) {
    if (visti.has(d.id) || !dispositivoValido(accountPublic, d)) continue;
    visti.add(d.id);
    out.push(d);
  }
  // In ordine di identificativo: due programmi devono ottenere lo stesso
  // insieme nello stesso ordine, o il numero di sicurezza non coincide.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const IMPRONTA_GIRI = 4096;

/**
 * L'impronta di una persona: copre l'account E tutti i suoi dispositivi.
 *
 * E' la parte che conta di piu' di questo file. Se l'impronta coprisse solo la
 * chiave d'account, aggiungere un dispositivo non cambierebbe niente di
 * visibile — e un dispositivo compromesso potrebbe aggiungere un dispositivo
 * dell'attaccante senza che nessuno se ne accorga, leggendo tutto da li' in
 * avanti.
 *
 * Coprendo l'insieme, il numero di sicurezza CAMBIA appena l'insieme cambia.
 * Costa un fastidio reale — vi tocca riconfrontare le cifre ogni volta che
 * collegate un telefono — ed e' il prezzo di poter accorgersi di un dispositivo
 * che non avete messo voi.
 */
export function improntaAccount(accountPublic: Uint8Array, dispositivi: readonly Dispositivo[]): Uint8Array {
  const ordinati = [...dispositivi].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let acc = cat(te.encode('WIRE-ACCOUNT-1'), accountPublic, ...ordinati.map((d) => encodeCard(d.card)));
  // Iterata come l'impronta di una card sola: rende cara la ricerca di due
  // insiemi diversi che producano le stesse cifre.
  for (let i = 0; i < IMPRONTA_GIRI; i++) acc = sha256(acc);
  return acc;
}

/**
 * Da un'impronta alle trenta cifre che si leggono a voce.
 *
 * Stessa forma del numero di sicurezza di prima — sei gruppi da cinque — cosi'
 * chi lo ha gia' confrontato una volta non deve imparare niente di nuovo.
 */
function cifreDaImpronta(impronta: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 30; i += 5) {
    let v = 0n;
    for (let j = 0; j < 5; j++) v = (v << 8n) | BigInt(impronta[i + j]!);
    out += (v % 100000n).toString().padStart(5, '0');
  }
  return out;
}

/**
 * Le sessanta cifre fra due persone.
 *
 * L'ordine e' deciso dalle cifre stesse, non da chi guarda: i due schermi
 * devono mostrare la stessa sequenza, o confrontarle non proverebbe niente.
 */
export function numeroDaImpronte(a: Uint8Array, b: Uint8Array): string {
  const ca = cifreDaImpronta(a);
  const cb = cifreDaImpronta(b);
  const [primo, secondo] = ca < cb ? [ca, cb] : [cb, ca];
  return (primo + secondo).replace(/(.{5})(?=.)/g, '$1 ');
}

/**
 * La card di una persona: la sua chiave d'account e tutti i suoi dispositivi.
 *
 * E' cio' che ci si scambia per potersi scrivere. Sostituisce la card singola,
 * che descriveva un dispositivo solo — e per questo un deposito della versione
 * precedente non si puo' convertire: nessuno dei due aveva una chiave
 * d'account, e non si puo' inventarla per conto di qualcun altro.
 */
export interface CardAccount {
  readonly account: Uint8Array;
  readonly dispositivi: readonly Dispositivo[];
}

const PREFISSO = 'wire:2:';

export function cardAccountToUri(c: CardAccount): string {
  const corpo = {
    a: hex(c.account),
    d: c.dispositivi.map(perTrasporto),
  };
  return PREFISSO + b64u(te.encode(JSON.stringify(corpo)));
}

/**
 * Rilegge una card, e tiene solo i dispositivi che reggono il controllo.
 *
 * Chi la manda decide cosa scriverci; qui si verifica ogni firma prima di
 * accettare qualunque cosa. Una card senza nemmeno un dispositivo valido non
 * e' una card: e' una riga a cui non si puo' scrivere.
 */
export function cardAccountFromUri(uri: string): CardAccount {
  const s = uri.trim();
  if (!s.startsWith(PREFISSO)) throw new Error('URI non valido: atteso wire:2:<dati>');
  let corpo: { a?: unknown; d?: unknown };
  try {
    corpo = JSON.parse(td.decode(unb64u(s.slice(PREFISSO.length)))) as { a?: unknown; d?: unknown };
  } catch {
    throw new Error('URI non leggibile');
  }
  if (typeof corpo.a !== 'string' || corpo.a.length !== 64 || /[^0-9a-f]/.test(corpo.a)) {
    throw new Error('URI: chiave d account non valida');
  }
  const account = unhexStretto(corpo.a, 32);
  if (!Array.isArray(corpo.d) || corpo.d.length === 0 || corpo.d.length > MAX_DISPOSITIVI) {
    throw new Error('URI: elenco dispositivi non valido');
  }
  const letti: Dispositivo[] = [];
  for (const t of corpo.d) {
    try {
      letti.push(daTrasporto(t as DispositivoTrasporto));
    } catch {
      // Un dispositivo malformato si salta: il resto della card resta buono.
    }
  }
  const dispositivi = dispositiviValidi(account, letti);
  if (!dispositivi.length) throw new Error('URI: nessun dispositivo con una firma valida');
  return { account, dispositivi };
}

/** Piu' di cosi' non e' una persona con dei dispositivi, e' qualcosa che
 *  prova a farci occupare memoria e tempo di verifica. */
export const MAX_DISPOSITIVI = 16;

// ---------- come viaggia ----------

/**
 * Il roster in forma trasportabile, per infilarlo in un payload.
 *
 * Le card in esadecimale invece che in base64url: qui dentro finiscono in un
 * JSON che passa dal ratchet, e l'esadecimale non ha caratteri che a qualcuno
 * venga voglia di sfuggire.
 */
export interface DispositivoTrasporto {
  readonly id: string;
  readonly nome: string;
  readonly card: string;
  readonly firma: string;
  readonly aggiuntoIl: number;
}

export function perTrasporto(d: Dispositivo): DispositivoTrasporto {
  return { id: d.id, nome: d.nome, card: hex(encodeCard(d.card)), firma: hex(d.firma), aggiuntoIl: d.aggiuntoIl };
}

/** Rifa' un dispositivo da come e' arrivato. Getta se la forma non torna: cio'
 *  che arriva dall'altra parte non e' mai gia' valido per definizione. */
export function daTrasporto(t: DispositivoTrasporto): Dispositivo {
  const card = decodeCard(unhexStretto(t.card, CARD_BYTES));
  return {
    id: t.id,
    card,
    nome: String(t.nome ?? '').slice(0, 60),
    firma: unhexStretto(t.firma, 64),
    aggiuntoIl: typeof t.aggiuntoIl === 'number' && Number.isFinite(t.aggiuntoIl) ? t.aggiuntoIl : 0,
  };
}

function unhexStretto(s: unknown, byteAttesi: number): Uint8Array {
  if (typeof s !== 'string' || s.length !== byteAttesi * 2 || /[^0-9a-f]/.test(s)) {
    throw new Error(`dispositivo: attesi ${byteAttesi} byte in esadecimale`);
  }
  const out = new Uint8Array(byteAttesi);
  for (let i = 0; i < byteAttesi; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
