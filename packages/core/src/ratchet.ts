// X3DH + Double Ratchet.
//
// Il messaggio N non si decifra con la chiave del messaggio N-1: ogni messaggio
// ha la sua, derivata da una catena che avanza e non torna indietro.
//   - forward secrecy: rubata una chiave, i messaggi precedenti restano illeggibili
//   - post-compromise security: dopo un giro di DH la conversazione si richiude
//     anche se l'attaccante aveva copiato tutto lo stato
//
// Riferimento: specifiche Signal "The X3DH Key Agreement Protocol" e
// "The Double Ratchet Algorithm". Le primitive vengono da @noble (audite);
// qui sopra c'e' solo la macchina a stati.

import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { cat, u32, readU32, te, b64u, unb64u, hex } from './codec.js';
import type { ContactCard, Identity } from './identity.js';

/** Oltre questo numero di messaggi persi in una catena, smettiamo di derivare chiavi.
 *  Senza il tetto, un `n` enorme scritto da un attaccante ci farebbe macinare
 *  derivazioni all'infinito: negazione di servizio gratuita. */
export const MAX_SKIP = 1000;

/**
 * Quante chiavi saltate si tengono in tutto, su tutte le catene.
 *
 * `MAX_SKIP` limita un solo salto; senza un tetto complessivo un contatto
 * potrebbe mandare una catena nuova dopo l'altra, ciascuna con mille
 * messaggi "persi", e far crescere lo stato — e il deposito — senza fine.
 * Signal tiene le ultime duemila: le piu' vecchie si lasciano andare, e un
 * messaggio che arriva dopo duemila successivi non si apre piu'. E' un prezzo
 * che nessuna conversazione vera paga.
 */
export const MAX_SKIPPED_TOTAL = 2000;

export const HEADER_BYTES = 32 + 4 + 4;

export interface Header {
  readonly dh: Uint8Array;
  readonly pn: number;
  readonly n: number;
}

interface KeyPair {
  secret: Uint8Array;
  public: Uint8Array;
}

export interface RatchetState {
  self: KeyPair;
  remote: Uint8Array | null;
  rootKey: Uint8Array;
  sendChain: Uint8Array | null;
  recvChain: Uint8Array | null;
  ns: number;
  nr: number;
  pn: number;
  /** chiavi dei messaggi arrivati fuori ordine, indicizzate da "dhRemote|n" */
  skipped: Map<string, Uint8Array>;
  /** dati autenticati ma non cifrati: lega la sessione alle due identita' */
  ad: Uint8Array;
}

// ---------- derivazioni ----------

function generateDh(): KeyPair {
  const secret = x25519.utils.randomSecretKey();
  return { secret, public: x25519.getPublicKey(secret) };
}

function dh(pair: KeyPair, remote: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(pair.secret, remote);
}

/** Avanza la root chain: nuova root key + chain key. */
function kdfRoot(rootKey: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, dhOut, rootKey, te.encode('WIRE-ROOT-1'), 64);
  return [out.subarray(0, 32), out.subarray(32, 64)];
}

/** Avanza la chain: chiave del messaggio + chain key successiva. */
function kdfChain(chainKey: Uint8Array): [Uint8Array, Uint8Array] {
  const messageKey = hmac(sha256, chainKey, Uint8Array.of(0x01));
  const next = hmac(sha256, chainKey, Uint8Array.of(0x02));
  return [messageKey, next];
}

/** Dalla chiave del messaggio: chiave di cifratura + nonce. Ogni chiave usata una volta sola. */
function messageCipher(messageKey: Uint8Array) {
  const out = hkdf(sha256, messageKey, new Uint8Array(32), te.encode('WIRE-MSG-1'), 56);
  return { key: out.subarray(0, 32), nonce: out.subarray(32, 56) };
}

// ---------- header ----------

export function encodeHeader(h: Header): Uint8Array {
  if (h.dh.length !== 32) throw new Error('header: chiave DH non di 32 byte');
  return cat(h.dh, u32(h.pn), u32(h.n));
}

export function decodeHeader(b: Uint8Array): Header {
  if (b.length !== HEADER_BYTES) throw new Error(`header di ${b.length} byte, attesi ${HEADER_BYTES}`);
  return { dh: b.subarray(0, 32), pn: readU32(b, 32), n: readU32(b, 36) };
}

// ---------- X3DH ----------

const X3DH_PAD = new Uint8Array(32).fill(0xff);

function associatedData(initiatorSig: Uint8Array, responderSig: Uint8Array): Uint8Array {
  return cat(te.encode('WIRE-AD-1'), initiatorSig, responderSig);
}

export interface InitialMessage {
  /** chiavi pubbliche che il destinatario deve conoscere per rifare il calcolo */
  readonly identitySig: Uint8Array;
  readonly identityDh: Uint8Array;
  readonly ephemeral: Uint8Array;
  /** quale prekey abbiamo usato: se il destinatario l'ha ruotata deve saperlo */
  readonly spkUsed: Uint8Array;
}

/** Lato di chi scrive per primo. Non serve che l'altro sia online. */
export function x3dhInitiate(self: Identity, peer: ContactCard): { state: RatchetState; initial: InitialMessage } {
  const ephemeral = generateDh();
  const selfDh: KeyPair = { secret: self.dhSecret, public: self.dhPublic };

  const dh1 = x25519.getSharedSecret(selfDh.secret, peer.spkPublic);
  const dh2 = x25519.getSharedSecret(ephemeral.secret, peer.dhPublic);
  const dh3 = x25519.getSharedSecret(ephemeral.secret, peer.spkPublic);
  const sk = hkdf(sha256, cat(X3DH_PAD, dh1, dh2, dh3), new Uint8Array(32), te.encode('WIRE-X3DH-1'), 32);

  const ad = associatedData(self.sigPublic, peer.sigPublic);
  const state = initSender(sk, peer.spkPublic, ad);
  return {
    state,
    initial: {
      identitySig: self.sigPublic,
      identityDh: self.dhPublic,
      ephemeral: ephemeral.public,
      spkUsed: peer.spkPublic,
    },
  };
}

/** Lato di chi riceve il primo messaggio. */
export function x3dhRespond(self: Identity, initial: InitialMessage): RatchetState {
  if (hex(initial.spkUsed) !== hex(self.spkPublic)) {
    throw new Error('prekey non riconosciuta: e' + "' stata ruotata o il messaggio non e' per noi");
  }
  const dh1 = x25519.getSharedSecret(self.spkSecret, initial.identityDh);
  const dh2 = x25519.getSharedSecret(self.dhSecret, initial.ephemeral);
  const dh3 = x25519.getSharedSecret(self.spkSecret, initial.ephemeral);
  const sk = hkdf(sha256, cat(X3DH_PAD, dh1, dh2, dh3), new Uint8Array(32), te.encode('WIRE-X3DH-1'), 32);

  const ad = associatedData(initial.identitySig, self.sigPublic);
  return initReceiver(sk, { secret: self.spkSecret, public: self.spkPublic }, ad);
}

// ---------- inizializzazione del ratchet ----------

function initSender(sharedKey: Uint8Array, remote: Uint8Array, ad: Uint8Array): RatchetState {
  const self = generateDh();
  const [rootKey, sendChain] = kdfRoot(sharedKey, dh(self, remote));
  return { self, remote, rootKey, sendChain, recvChain: null, ns: 0, nr: 0, pn: 0, skipped: new Map(), ad };
}

function initReceiver(sharedKey: Uint8Array, self: KeyPair, ad: Uint8Array): RatchetState {
  return {
    self,
    remote: null,
    rootKey: sharedKey,
    sendChain: null,
    recvChain: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: new Map(),
    ad,
  };
}

// ---------- cifratura ----------

/** Tutto cio' che viaggia in chiaro accanto al testo cifrato entra qui dentro. */
function aadFor(state: RatchetState, header: Header, extra: Uint8Array): Uint8Array {
  return cat(state.ad, encodeHeader(header), extra);
}

export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
  extraAad: Uint8Array = new Uint8Array(0)
): { header: Header; ciphertext: Uint8Array } {
  if (!state.sendChain) {
    throw new Error('nessuna catena di invio: chi riceve deve prima ricevere un messaggio');
  }
  const [messageKey, nextChain] = kdfChain(state.sendChain);
  state.sendChain = nextChain;

  const header: Header = { dh: state.self.public, pn: state.pn, n: state.ns };
  state.ns += 1;

  const { key, nonce } = messageCipher(messageKey);
  return { header, ciphertext: xchacha20poly1305(key, nonce, aadFor(state, header, extraAad)).encrypt(plaintext) };
}

// ---------- decifratura ----------

function skipKey(remote: Uint8Array, n: number): string {
  return `${hex(remote)}|${n}`;
}

function trySkipped(
  state: RatchetState,
  header: Header,
  ciphertext: Uint8Array,
  extraAad: Uint8Array
): Uint8Array | null {
  const id = skipKey(header.dh, header.n);
  const messageKey = state.skipped.get(id);
  if (!messageKey) return null;
  const { key, nonce } = messageCipher(messageKey);
  const plaintext = xchacha20poly1305(key, nonce, aadFor(state, header, extraAad)).decrypt(ciphertext);
  state.skipped.delete(id); // consumata: una chiave, un messaggio
  return plaintext;
}

function skipUntil(state: RatchetState, until: number): void {
  if (!state.recvChain) return;
  if (until - state.nr > MAX_SKIP) {
    throw new Error(`troppi messaggi saltati (${until - state.nr}): oltre il limite di ${MAX_SKIP}`);
  }
  while (state.nr < until) {
    const [messageKey, next] = kdfChain(state.recvChain);
    state.recvChain = next;
    state.skipped.set(skipKey(state.remote!, state.nr), messageKey);
    state.nr += 1;
  }
  // Una Map ricorda l'ordine d'inserimento: la prima e' la piu' vecchia.
  while (state.skipped.size > MAX_SKIPPED_TOTAL) {
    const piuVecchia = state.skipped.keys().next().value;
    if (piuVecchia === undefined) break;
    state.skipped.delete(piuVecchia);
  }
}

/**
 * Copia dello stato, per lavorare senza toccare l'originale.
 *
 * Le chiavi sono byte immutabili nell'uso che se ne fa qui (si sostituiscono,
 * non si modificano sul posto), quindi basta copiare la struttura e la Map.
 */
function copia(state: RatchetState): RatchetState {
  return { ...state, self: { ...state.self }, skipped: new Map(state.skipped) };
}

/** Riporta nell'originale cio' che la copia ha deciso. */
function applica(dentro: RatchetState, da: RatchetState): void {
  dentro.self = da.self;
  dentro.remote = da.remote;
  dentro.rootKey = da.rootKey;
  dentro.sendChain = da.sendChain;
  dentro.recvChain = da.recvChain;
  dentro.ns = da.ns;
  dentro.nr = da.nr;
  dentro.pn = da.pn;
  dentro.skipped = da.skipped;
}

function dhRatchet(state: RatchetState, header: Header): void {
  state.pn = state.ns;
  state.ns = 0;
  state.nr = 0;
  state.remote = header.dh;

  const [rk1, recvChain] = kdfRoot(state.rootKey, dh(state.self, state.remote));
  state.rootKey = rk1;
  state.recvChain = recvChain;

  state.self = generateDh();
  const [rk2, sendChain] = kdfRoot(state.rootKey, dh(state.self, state.remote));
  state.rootKey = rk2;
  state.sendChain = sendChain;
}

/**
 * Decifra, e cambia lo stato SOLO se la decifratura riesce.
 *
 * Prima no: il giro di DH e l'avanzamento della catena avvenivano prima di
 * controllare il tag, quindi una busta manomessa — o consegnata alla sessione
 * sbagliata — lasciava la sessione avanzata su una catena che l'altro non ha,
 * e da li' in poi niente si apriva piu'. L'Account si difendeva decifrando su
 * una copia serializzata; ora la garanzia sta qui, dove deve stare, e vale
 * per chiunque chiami questa funzione.
 */
export function ratchetDecrypt(
  state: RatchetState,
  header: Header,
  ciphertext: Uint8Array,
  extraAad: Uint8Array = new Uint8Array(0)
): Uint8Array {
  const prova = copia(state);
  const plaintext = decifraSu(prova, header, ciphertext, extraAad);
  applica(state, prova);
  return plaintext;
}

function decifraSu(state: RatchetState, header: Header, ciphertext: Uint8Array, extraAad: Uint8Array): Uint8Array {
  const fromSkipped = trySkipped(state, header, ciphertext, extraAad);
  if (fromSkipped) return fromSkipped;

  const isNewChain = !state.remote || hex(state.remote) !== hex(header.dh);
  if (isNewChain) {
    // I messaggi rimasti indietro nella catena precedente: le chiavi vanno
    // conservate ora, dopo il giro di DH non sarebbero piu' derivabili.
    if (state.remote) skipUntil(state, header.pn);
    dhRatchet(state, header);
  }
  skipUntil(state, header.n);

  if (!state.recvChain) throw new Error('nessuna catena di ricezione');
  const [messageKey, next] = kdfChain(state.recvChain);
  state.recvChain = next;
  state.nr += 1;

  const { key, nonce } = messageCipher(messageKey);
  return xchacha20poly1305(key, nonce, aadFor(state, header, extraAad)).decrypt(ciphertext);
}

// ---------- persistenza ----------

export function serializeState(s: RatchetState): string {
  return JSON.stringify({
    v: 1,
    self: { secret: b64u(s.self.secret), public: b64u(s.self.public) },
    remote: s.remote ? b64u(s.remote) : null,
    rootKey: b64u(s.rootKey),
    sendChain: s.sendChain ? b64u(s.sendChain) : null,
    recvChain: s.recvChain ? b64u(s.recvChain) : null,
    ns: s.ns,
    nr: s.nr,
    pn: s.pn,
    ad: b64u(s.ad),
    skipped: [...s.skipped].map(([k, v]) => [k, b64u(v)]),
  });
}

export function deserializeState(json: string): RatchetState {
  const o = JSON.parse(json) as Record<string, unknown>;
  if (o['v'] !== 1) throw new Error(`stato ratchet versione ${String(o['v'])}, attesa 1`);
  const self = o['self'] as { secret: string; public: string };
  return {
    self: { secret: unb64u(self.secret), public: unb64u(self.public) },
    remote: o['remote'] ? unb64u(o['remote'] as string) : null,
    rootKey: unb64u(o['rootKey'] as string),
    sendChain: o['sendChain'] ? unb64u(o['sendChain'] as string) : null,
    recvChain: o['recvChain'] ? unb64u(o['recvChain'] as string) : null,
    ns: o['ns'] as number,
    nr: o['nr'] as number,
    pn: o['pn'] as number,
    ad: unb64u(o['ad'] as string),
    skipped: new Map((o['skipped'] as [string, string][]).map(([k, v]) => [k, unb64u(v)])),
  };
}
