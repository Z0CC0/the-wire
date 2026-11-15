// Il ponte per il telefono.
//
// Su Electron l'interfaccia parla con `window.wireApi`, che manda tutto al
// processo principale. Qui non c'e' nessun processo principale: il cuore gira
// DENTRO la pagina, e questo file espone la stessa superficie chiamandolo
// direttamente.
//
// Perche' la stessa superficie: cosi' `ui/app.js` non sa dove si trova, e non
// esistono due interfacce da tenere allineate. Le cose che sul telefono non
// hanno senso — le finestre di salvataggio del sistema, il collegamento diretto
// fra due computer — semplicemente non ci sono, e l'interfaccia le salta gia'
// da sola perche' controlla se il metodo esiste.

import {
  Account,
  DEFAULT_TOPIC,
  SENZA_SERRATURA,
  SOGLIA_MAILBOX,
  type Contact,
  type Group,
  type Message,
} from '@wire/core';
import { DepositoBrowser } from '@wire/core/deposito-browser.js';

const VERSIONE = '2.1.0';
const deposito = new DepositoBrowser();

let account: Account | null = null;
const ascoltatori = new Set<(m: Message) => void>();
const problemi = new Set<(p: { dove: string; testo: string }) => void>();

function richiediAccount(): Account {
  if (!account) throw new Error('account non sbloccato');
  return account;
}

function contattoRichiesto(a: Account, id: string): Contact {
  const c = a.contact(id);
  if (!c) throw new Error('contatto inesistente');
  return c;
}

function gruppoRichiesto(a: Account, id: string): Group {
  const g = a.group(id);
  if (!g) throw new Error('gruppo inesistente');
  return g;
}

/** Cio' che l'interfaccia puo' sapere di un contatto: niente chiavi private. */
function vistaContatto(a: Account, c: Contact) {
  return {
    id: c.id,
    name: c.name,
    verified: c.verifiedAt !== null,
    address: c.id.slice(0, 12),
    archiviata: a.archiviata(c.id),
    ordine: a.ordine(c.id),
    online: a.online(c.id),
    visto: a.visto(c.id),
    // Quanti dispositivi ha: sul telefono e' l'unico posto dove si vede che
    // una persona puo' essere in piu' posti insieme.
    dispositivi: c.dispositivi.length,
  };
}

function vistaGruppo(a: Account, g: Group) {
  return {
    id: g.id,
    name: g.name,
    archiviata: a.archiviata(g.id),
    ordine: a.ordine(g.id),
    topics: g.topics.map((t) => ({ id: t.id, name: t.name })),
    members: g.members.map((m) => ({ id: m.id, name: a.memberName(g, m.id), me: m.id === a.id })),
  };
}

function segnala(dove: string, errore: unknown): void {
  const testo = errore instanceof Error ? errore.message : String(errore);
  for (const cb of problemi) cb({ dove, testo });
}

/**
 * Collega il cuore alla rete e resta in ascolto.
 *
 * Gli errori non fanno morire l'app: senza rete la rubrica e lo storico sono
 * comunque leggibili, ed e' meglio di una pagina bianca.
 */
async function avvia(a: Account): Promise<void> {
  account = a;
  a.onMessage((m) => {
    for (const cb of ascoltatori) cb(m);
  });
  try {
    await a.connect();
    a.sync().catch((e) => segnala('primo ritiro dalla mailbox', e));
  } catch (e) {
    segnala('collegamento alla mailbox', e);
  }
}

export const wireApi = {
  runtime: 'PWA',
  versione: VERSIONE,

  /** Sul telefono la finestra la comanda il sistema, non l'app. */
  window: () => {},

  state: async () => ({
    versione: VERSIONE,
    exists: await deposito.esiste('wire.vault'),
    unlocked: account !== null,
    dataDir: 'dentro il browser',
    address: account?.address ?? null,
    uri: account?.uri ?? null,
    soglia: SOGLIA_MAILBOX,
    // Il telefono non fa da capo del trasferimento diretto.
    diretto: false,
  }),

  create: async (passphrase: string) => {
    const a = await Account.creaSuDeposito(passphrase, deposito, SENZA_SERRATURA, 'telefono');
    await avvia(a);
    return { address: a.address, uri: a.uri };
  },

  unlock: async (passphrase: string) => {
    const a = await Account.apriDeposito(passphrase, deposito, SENZA_SERRATURA);
    await avvia(a);
    return { address: a.address, uri: a.uri };
  },

  profile: () => {
    const a = richiediAccount();
    return { name: a.displayName, address: a.address, id: a.id };
  },
  setName: async (name: string) => {
    await richiediAccount().setDisplayName(name);
    return richiediAccount().displayName;
  },

  contacts: () => {
    const a = richiediAccount();
    return a.contacts().map((c) => vistaContatto(a, c));
  },
  addContact: async (uri: string, name: string) => {
    const a = richiediAccount();
    return vistaContatto(a, await a.addContact(uri, name));
  },
  removeContact: async (id: string) => {
    await richiediAccount().removeContact(id);
    return true;
  },
  svuotaConversazione: async (id: string) => {
    await richiediAccount().svuotaConversazione(id);
    return true;
  },
  archivia: async (id: string, valore: boolean) => {
    await richiediAccount().archivia(id, valore);
    return true;
  },
  riordina: async (ids: string[]) => {
    await richiediAccount().riordina(ids ?? []);
    return true;
  },
  safetyNumber: (id: string) => {
    const a = richiediAccount();
    return a.safetyNumberWith(contattoRichiesto(a, id));
  },
  markVerified: async (id: string) => {
    await richiediAccount().markVerified(id);
    return true;
  },
  riavviaSessione: async (id: string) => {
    const a = richiediAccount();
    await a.riavviaSessione(contattoRichiesto(a, id));
    return true;
  },

  history: (id: string) => {
    const a = richiediAccount();
    return a.historyWith(contattoRichiesto(a, id));
  },
  send: (id: string, text: string) => {
    const a = richiediAccount();
    return a.sendText(contattoRichiesto(a, id), text);
  },
  sync: () => richiediAccount().sync(),
  eliminaMessaggio: (messaggioId: string, perEntrambi: boolean) =>
    richiediAccount().eliminaMessaggio(messaggioId, perEntrambi === true),

  // ---------- file ----------

  perche: (id: string, dimensione: number) => {
    const a = richiediAccount();
    if (dimensione > SOGLIA_MAILBOX) {
      return 'Dal telefono si mandano file fino a 5 MB. Per quelli piu grandi serve il collegamento diretto fra due computer.';
    }
    return a.perche(contattoRichiesto(a, id), dimensione);
  },
  sendFile: async (id: string, nome: string, tipo: string, dati: string) => {
    const a = richiediAccount();
    return a.sendFile(contattoRichiesto(a, id), nome, tipo, daBase64(dati));
  },
  fileDati: async (fileId: string) => inBase64(await richiediAccount().fileBytes(fileId)),

  // ---------- gruppi ----------

  groups: () => {
    const a = richiediAccount();
    return a.groups().map((g) => vistaGruppo(a, g));
  },
  createGroup: async (name: string, memberIds: string[]) => {
    const a = richiediAccount();
    const membri = (memberIds ?? []).flatMap((id) => {
      const c = a.contact(id);
      return c ? [c] : [];
    });
    return vistaGruppo(a, await a.createGroup(name, membri));
  },
  groupHistory: async (id: string, topicId?: string) => {
    const a = richiediAccount();
    const g = gruppoRichiesto(a, id);
    // L'interfaccia mostra un nome, non un identificativo.
    return (await a.groupHistory(g, topicId)).map((m) => ({
      ...m,
      author: m.mine ? 'Tu' : a.memberName(g, m.from ?? ''),
    }));
  },
  sendGroup: async (id: string, topicId: string, text: string) => {
    const a = richiediAccount();
    const m = await a.sendGroupText(gruppoRichiesto(a, id), topicId || DEFAULT_TOPIC.id, text);
    return { ...m, author: 'Tu' };
  },
  addTopic: (id: string, name: string) => {
    const a = richiediAccount();
    return a.addTopic(gruppoRichiesto(a, id), name);
  },
  leaveGroup: async (id: string) => {
    await richiediAccount().leaveGroup(id);
    return true;
  },

  // ---------- dispositivi ----------

  /** Il telefono non mostra il codice: lo inquadra. Resta comunque
   *  disponibile come testo, per chi preferisce incollarlo. */
  codiceCollegamento: () => ({ uri: richiediAccount().codiceCollegamento(), qr: '' }),
  collegatiCome: async (codice: string) => {
    await richiediAccount().collegatiCome(codice);
    return true;
  },
  dispositivi: () => {
    const a = richiediAccount();
    return a.dispositivi.map((d) => ({
      id: d.id,
      nome: d.nome,
      aggiuntoIl: d.aggiuntoIl,
      questo: d.id === a.idDispositivo,
    }));
  },

  // ---------- avvisi ----------

  onMessage: (cb: (m: Message) => void) => {
    ascoltatori.add(cb);
    return () => ascoltatori.delete(cb);
  },
  onProblema: (cb: (p: { dove: string; testo: string }) => void) => {
    problemi.add(cb);
    return () => problemi.delete(cb);
  },
};

// ---------- byte come stringhe ----------

/** A fette: su un array grande `String.fromCharCode(...)` supera il numero
 *  massimo di argomenti e va in errore. */
function inBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode.apply(null, [...b.subarray(i, Math.min(i + 8192, b.length))]);
  }
  return btoa(s);
}

function daBase64(s: string): Uint8Array {
  const testo = atob(s);
  const out = new Uint8Array(testo.length);
  for (let i = 0; i < testo.length; i++) out[i] = testo.charCodeAt(i);
  return out;
}

(globalThis as { wireApi?: unknown }).wireApi = wireApi;
