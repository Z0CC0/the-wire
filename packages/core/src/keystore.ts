// Deposito delle chiavi su disco.
//
// Il file e' cifrato con una passphrase: se qualcuno ti copia il portatile,
// senza quella non ha niente. Derivazione con Argon2id — lento e affamato di
// memoria apposta, cosi' provare miliardi di passphrase costa hardware vero e
// non una GPU da gaming.
//
// Scelta deliberata di NON usare il Portachiavi macOS / DPAPI Windows: legano
// il file alla macchina e all'utente del sistema, e lo stesso deposito deve
// potersi aprire su Windows e su Mac. Una passphrase funziona ovunque allo
// stesso modo.

import { argon2id } from '@noble/hashes/argon2.js';
import type { ServerTurn } from './turn.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { casuali } from './casuale.js';
import { cat, equalCT, te, b64u, unb64u } from './codec.js';
import type { Identity } from './identity.js';
import type { Group } from './group.js';
import type { DispositivoTrasporto } from './dispositivi.js';

const MAGIC = te.encode('WIREKS');
const VERSION = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 24;

/** ~64 MB e 3 passate: circa un decimo di secondo su un portatile, anni su una farm di GPU. */
export const KDF = { t: 3, m: 65536, p: 1, dkLen: 32 } as const;

/** Lunghezza minima della passphrase. */
export const MIN_PASSPHRASE = 12;

export interface Vault {
  readonly identity: Identity;
  /**
   * Stato dei ratchet, per contatto (chiave = indirizzo esadecimale della sig
   * pubblica). Piu' di uno, e non e' un dettaglio: se due persone si scrivono
   * per prime nello stesso momento, ciascuna apre una sessione sua, e servono
   * entrambe. Tenerne una sola significa buttare la propria nel momento in cui
   * si accetta quella dell'altro, e da li' in poi nessuno dei due messaggi si
   * apre piu'.
   */
  readonly sessions: Record<string, string[]>;
  /**
   * I contatti, uno per PERSONA e non per dispositivo.
   *
   * `account` e' la chiave che tiene insieme i suoi dispositivi; `dispositivi`
   * sono quelli che ci ha fatto conoscere, ciascuno con la firma che lo lega a
   * quell'account. Un dispositivo senza firma valida non entra qui dentro.
   */
  readonly contacts: Record<
    string,
    {
      name: string;
      account: string;
      dispositivi: DispositivoTrasporto[];
      verifiedAt: number | null;
    }
  >;
  /** La chiave d'account di chi possiede questo deposito, in esadecimale.
   *  Cambia una volta sola: quando questo dispositivo viene collegato a un
   *  account che esisteva gia'. */
  account: { secret: string; publicKey: string };
  /** I propri dispositivi, questo compreso. Cresce a ogni collegamento. */
  dispositivi: DispositivoTrasporto[];
  readonly groups: Record<string, Group>;
  /** Cosa e' gia' arrivato, e da dove riprendere. Senza, ogni riavvio
   *  riconsegna i messaggi delle ultime due settimane. */
  readonly mailbox: { seen: string[]; since: number; v?: number };
  /** Per conversazione: se e' archiviata e in che posizione sta nell'elenco. */
  readonly viste: Record<string, { archiviata: boolean; ordine: number }>;
  /** Come ti vedono gli altri nei gruppi. Vuoto = si usa l'indirizzo. */
  readonly profile: { name: string };
  /** Ultimo battito ricevuto da ciascun contatto, orario nostro. Serve a poter
   *  dire "visto ieri" invece di niente dopo un riavvio. */
  readonly presenze: Record<string, number>;
  /** Il server TURN per il collegamento diretto, se l'utente ne ha scritto
   *  uno. Sta nel deposito cifrato perche' porta una password. */
  readonly rete: { turn: ServerTurn | null };
}

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  // Dodici e non otto. Argon2id con questi parametri rende ogni tentativo
  // costoso, ma otto caratteri restano pochi contro chi ha hardware serio e il
  // deposito in mano: e' l'unica difesa che regge quando il computer e' stato
  // sequestrato. Il controllo sta qui e non solo nella pagina, perche' la
  // pagina si puo' aggirare e questa funzione no.
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`passphrase troppo corta: almeno ${MIN_PASSPHRASE} caratteri`);
  }
  return argon2id(te.encode(passphrase.normalize('NFKC')), salt, { ...KDF });
}

function toJson(vault: Vault): string {
  const id = vault.identity;
  return JSON.stringify({
    v: 1,
    identity: {
      sigSecret: b64u(id.sigSecret),
      sigPublic: b64u(id.sigPublic),
      dhSecret: b64u(id.dhSecret),
      dhPublic: b64u(id.dhPublic),
      spkSecret: b64u(id.spkSecret),
      spkPublic: b64u(id.spkPublic),
      nostrSecret: b64u(id.nostrSecret),
      nostrPublic: b64u(id.nostrPublic),
      spkSignature: b64u(id.spkSignature),
      createdAt: id.createdAt,
    },
    sessions: vault.sessions,
    contacts: vault.contacts,
    account: vault.account,
    dispositivi: vault.dispositivi,
    groups: vault.groups,
    mailbox: vault.mailbox,
    viste: vault.viste,
    profile: vault.profile,
    presenze: vault.presenze,
    rete: vault.rete ?? { turn: null },
  });
}

function fromJson(json: string): Vault {
  const o = JSON.parse(json) as Record<string, unknown>;
  if (o['v'] !== 1) throw new Error(`deposito versione ${String(o['v'])}, attesa 1`);
  const i = o['identity'] as Record<string, string | number>;
  return {
    identity: {
      sigSecret: unb64u(i['sigSecret'] as string),
      sigPublic: unb64u(i['sigPublic'] as string),
      dhSecret: unb64u(i['dhSecret'] as string),
      dhPublic: unb64u(i['dhPublic'] as string),
      spkSecret: unb64u(i['spkSecret'] as string),
      spkPublic: unb64u(i['spkPublic'] as string),
      nostrSecret: unb64u(i['nostrSecret'] as string),
      nostrPublic: unb64u(i['nostrPublic'] as string),
      spkSignature: unb64u(i['spkSignature'] as string),
      createdAt: i['createdAt'] as number,
    },
    // I depositi scritti prima tenevano una stringa sola per contatto: si
    // legge come elenco di uno, e da li' in avanti cresce se serve.
    sessions: Object.fromEntries(
      Object.entries((o['sessions'] as Record<string, string | string[]>) ?? {}).map(([id, v]) => [
        id,
        typeof v === 'string' ? [v] : Array.isArray(v) ? v : [],
      ])
    ),
    contacts: (o['contacts'] as Vault['contacts']) ?? {},
    account: (o['account'] as Vault['account']) ?? { secret: '', publicKey: '' },
    dispositivi: (o['dispositivi'] as Vault['dispositivi']) ?? [],
    groups: (o['groups'] as Vault['groups']) ?? {},
    mailbox: (o['mailbox'] as Vault['mailbox']) ?? { seen: [], since: 0 },
    viste: (o['viste'] as Vault['viste']) ?? {},
    profile: (o['profile'] as Vault['profile']) ?? { name: '' },
    presenze: (o['presenze'] as Vault['presenze']) ?? {},
    // I depositi scritti prima non lo hanno: nessun server, come prima.
    rete: (o['rete'] as Vault['rete']) ?? { turn: null },
  };
}

/**
 * Struttura del file:
 *   "WIREKS" | versione(1) | salt(16) | nonce(24) | testo cifrato
 * L'intestazione in chiaro fa da dato autenticato: chi cambia la versione o il
 * salt per farci derivare una chiave diversa rompe il tag e non decifra nulla.
 */
export function sealVault(vault: Vault, passphrase: string): Uint8Array {
  const salt = casuali(SALT_BYTES);
  const key = deriveKey(passphrase, salt);
  const out = resealVault(vault, key, salt);
  key.fill(0);
  return out;
}

/**
 * Risigilla riusando la chiave gia' derivata. Argon2id costa un paio di secondi:
 * pagarli a ogni salvataggio renderebbe l'app inusabile. Li paghiamo una volta
 * allo sblocco, poi restiamo su XChaCha20 che e' istantaneo.
 * Il salt resta lo stesso — cambia il nonce, che e' cio' che non deve ripetersi.
 */
export function resealVault(vault: Vault, key: Uint8Array, salt: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('chiave del deposito non di 32 byte');
  if (salt.length !== SALT_BYTES) throw new Error('salt del deposito di lunghezza errata');
  const nonce = casuali(NONCE_BYTES);
  const head = cat(MAGIC, Uint8Array.of(VERSION), salt, nonce);
  return cat(head, xchacha20poly1305(key, nonce, head).encrypt(te.encode(toJson(vault))));
}

/** Sottochiave per lo storico: derivata, mai la stessa del deposito. */
export function historyKey(vaultKey: Uint8Array): Uint8Array {
  return hkdf(sha256, vaultKey, new Uint8Array(32), te.encode('WIRE-HIST-1'), 32);
}

export interface OpenedVault {
  readonly vault: Vault;
  /** Da tenere in memoria per i salvataggi successivi. Non finisce mai su disco. */
  readonly key: Uint8Array;
  readonly salt: Uint8Array;
}

export function openVault(bytes: Uint8Array, passphrase: string): Vault {
  return openVaultKeyed(bytes, passphrase).vault;
}

export function openVaultKeyed(bytes: Uint8Array, passphrase: string): OpenedVault {
  const headLen = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES;
  if (bytes.length < headLen + 16) throw new Error('file del deposito troncato');
  if (!equalCT(bytes.subarray(0, MAGIC.length), MAGIC)) throw new Error('non e' + "' un deposito THE WIRE");

  const version = bytes[MAGIC.length]!;
  if (version !== VERSION) throw new Error(`deposito versione ${version}, questa build legge la ${VERSION}`);

  const salt = bytes.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
  const nonce = bytes.subarray(MAGIC.length + 1 + SALT_BYTES, headLen);
  const head = bytes.subarray(0, headLen);
  const key = deriveKey(passphrase, salt);
  try {
    const plain = xchacha20poly1305(key, nonce, head).decrypt(bytes.subarray(headLen));
    return { vault: fromJson(new TextDecoder().decode(plain)), key, salt: Uint8Array.from(salt) };
  } catch {
    key.fill(0);
    // Un solo messaggio per passphrase sbagliata e per file manomesso: distinguerli
    // direbbe a chi prova a indovinare quando ha trovato un file valido.
    throw new Error('passphrase errata o file danneggiato');
  }
}
