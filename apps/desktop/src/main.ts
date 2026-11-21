// THE WIRE — faccia desktop.
//
// Il processo principale e' l'unico che tocca chiavi e disco. Le facce che
// stanno sopra — la finestra di Electron e il telefono collegato da remoto —
// ricevono solo dati gia' decifrati.
//
// Le operazioni sono dichiarate UNA volta, in `azioni`. Da li' si servono sia
// l'IPC della finestra sia il server remoto: due strade non possono divergere
// se partono dalla stessa tabella.

import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from 'electron';
import { join } from 'node:path';
import { open, readFile, stat, writeFile, type FileHandle } from 'node:fs/promises';
import {
  Account,
  identificativo,
  nomeFileBackup,
  nomeFileSicuro,
  DEFAULT_TOPIC,
  SOGLIA_MAILBOX,
  type Contact,
  type Group,
  type Message,
} from '@wire/core';
import { cartellaPredefinita } from '@wire/core/deposito-file.js';
import { qrSvg } from './qr.js';

// Il bundle finale e' CommonJS, non ESM: `__dirname` esiste, e con lui
// funzionano anche le dipendenze CommonJS (`ws`, `qrcode`) che in un bundle ESM
// morirebbero al primo `require` interno. `import.meta.url` qui non esisterebbe.
declare const __dirname: string;
const here = __dirname;
const appRoot = join(here, '..', '..', '..');
const cartellaUi = join(appRoot, 'ui');

// Electron mette la sua cache in %APPDATA%/<productName>, cioe' esattamente
// dove sta il deposito delle chiavi. Sono due cose diverse con cicli di vita
// diversi: la cache si puo' cancellare, il deposito no.
app.setPath('userData', join(cartellaPredefinita(), 'electron'));

/**
 * Gli indirizzi locali visibili nella negoziazione del collegamento diretto.
 *
 * Chromium, per difendere chi naviga, sostituisce gli indirizzi locali con un
 * nome `.local` inventato: un sito qualunque non deve sapere che indirizzo hai
 * sulla tua rete. Qui pero' quel nome non lo risolve nessuno, e il risultato e'
 * che i due programmi non si trovano mai per la strada corta.
 *
 * Cosa cambia in pratica, misurato su questo computer: senza, l'unico candidato
 * era `57deef98-….local`. Con, compaiono `192.168.1.6` e `100.88.46.10` — il
 * secondo e' Tailscale, e due indirizzi Tailscale si raggiungono senza dover
 * bucare nessun NAT, perche' ci ha gia' pensato lui.
 *
 * Serve perche' senza indirizzi locali veri la strada corta — stessa rete,
 * o rete di casa con NAT che rimanda al mittente — non esiste. (Il NAT di
 * questa rete, rimisurato con un solo socket verso piu' server STUN, non e'
 * simmetrico: stessa porta esterna verso tutti, uguale a quella locale. La
 * misura precedente era di due connessioni separate, e non provava niente.)
 *
 * Cosa si concede: chi riceve un file da noi vede i nostri indirizzi di rete
 * locale. E' un contatto verificato con cui si sta gia' scambiando un file, non
 * una pagina web qualunque, ed e' l'informazione minima perche' due computer si
 * trovino.
 */
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

/**
 * Cosa la pagina puo' caricare ed eseguire.
 *
 * `default-src 'none'` come base: si concede solo cio' che serve davvero.
 * `img-src` accetta anche `data:` perche' le anteprime delle immagini arrivano
 * cosi'. `connect-src` resta vuoto: il traffico verso i relay lo fa il
 * processo principale, la pagina non deve parlare con nessuno — tranne il
 * collegamento diretto dei file, che non passa da `connect-src`.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * I percorsi scelti dall'utente, tenuti qui e mai dati alla finestra.
 *
 * La finestra riceve un gettone e lo ripassa; a quale file corrisponda lo sa
 * solo questo processo. Cosi' un difetto nella pagina non puo' far scrivere
 * niente da nessun'altra parte.
 */
const destinazioni = new Map<string, string>();

/**
 * Quanti gettoni si tengono insieme.
 *
 * Un gettone e' il permesso di scrivere in un punto preciso del disco: finito
 * il trasferimento non serve piu', e la finestra lo chiude da sola. Il tetto
 * copre il caso in cui non lo faccia — una pagina che si blocca, un
 * trasferimento interrotto male — perche' un permesso dimenticato che resta
 * valido e' esattamente cio' che non deve succedere.
 */
const MAX_DESTINAZIONI = 32;

/**
 * I file aperti in scrittura, uno per gettone.
 *
 * Prima ogni pezzo da 64 KB apriva il file, scriveva e lo richiudeva: misurato,
 * sono 24 secondi di sola apertura e chiusura su un file da 4 GB, contro 3 se
 * lo si tiene aperto. Si chiude quando il trasferimento finisce.
 */
const aperti = new Map<string, FileHandle>();

/** L'ultimo percorso scelto, che la finestra mette nel registro per poter
 *  riprendere piu' tardi. */
let ultimoPercorso = '';

async function chiudiFile(gettone: string): Promise<void> {
  const h = aperti.get(gettone);
  if (!h) return;
  aperti.delete(gettone);
  try {
    await h.close();
  } catch {
    /* gia' chiuso, o disco sparito: non c'e' niente da salvare qui */
  }
}

/** Il file di questo gettone, aperto in coda, riusando quello di prima. */
async function fileDi(gettone: string): Promise<FileHandle> {
  const gia = aperti.get(gettone);
  if (gia) return gia;
  const h = await open(perGettone(gettone), 'a');
  aperti.set(gettone, h);
  return h;
}

function perGettone(gettone: string): string {
  const percorso = destinazioni.get(gettone);
  if (!percorso) throw new Error('destinazione sconosciuta: rifai la scelta del file');
  return percorso;
}

let win: BrowserWindow | null = null;
let account: Account | null = null;

/**
 * Un relay che va in timeout non deve chiudere il programma.
 *
 * I relay sono volontari: che uno smetta di rispondere e' la normalita', non
 * un'emergenza. Senza queste due reti di sicurezza un socket scaduto arriva fino
 * in cima come eccezione non gestita, Electron mostra "A JavaScript error
 * occurred in the main process" e l'app si chiude — perdendo una conversazione
 * per colpa di un server di qualcun altro.
 *
 * Non si nasconde niente: tutto finisce nel log, e la finestra viene avvisata
 * cosi' puo' dirlo a chi sta guardando.
 */
function segnala(dove: string, errore: unknown): void {
  const testo = errore instanceof Error ? errore.message : String(errore);
  console.error(`[wire] ${dove}: ${testo}`);
  win?.webContents.send('wire:problema', { dove, testo });
}

process.on('uncaughtException', (e) => segnala('eccezione non gestita', e));
process.on('unhandledRejection', (e) => segnala('promessa non gestita', e));

function requireAccount(): Account {
  if (!account) throw new Error('account non sbloccato');
  return account;
}

/** Cio' che una faccia puo' sapere di un contatto: niente chiavi private. */
function toView(a: Account, c: Contact) {
  return {
    id: c.id,
    name: c.name,
    verified: c.verifiedAt !== null,
    address: c.id.slice(0, 12),
    archiviata: a.archiviata(c.id),
    ordine: a.ordine(c.id),
    online: a.online(c.id),
    visto: a.visto(c.id),
  };
}

function groupView(a: Account, g: Group) {
  return {
    id: g.id,
    name: g.name,
    archiviata: a.archiviata(g.id),
    ordine: a.ordine(g.id),
    topics: g.topics.map((t) => ({ id: t.id, name: t.name })),
    members: g.members.map((m) => ({ id: m.id, name: a.memberName(g, m.id), me: m.id === a.id })),
  };
}

function requireContact(a: Account, id: string): Contact {
  const c = a.contacts().find((x) => x.id === id);
  if (!c) throw new Error('contatto inesistente');
  return c;
}

function requireGroup(a: Account, id: string): Group {
  const g = a.group(id);
  if (!g) throw new Error('gruppo inesistente');
  return g;
}

// ---------- la tabella delle operazioni ----------

type Azione = (...args: never[]) => unknown;

const azioni: Record<string, Azione> = {
  state: async () => ({
    versione: app.getVersion(),
    exists: await Account.exists(),
    unlocked: account !== null,
    // Non il percorso: `state` e' raggiungibile anche dal telefono, e dove
    // sta il deposito non e' un'informazione che debba viaggiare in rete.
    dataDir: '',
    address: account?.address ?? null,
    uri: account?.uri ?? null,
    // La soglia la decide il cuore. Una copia nella finestra prima o poi
    // diverge da quella vera, e diverge in silenzio.
    soglia: SOGLIA_MAILBOX,
  }),

  create: async (passphrase: string) => bringUp(await Account.create(passphrase)),
  unlock: async (passphrase: string) => bringUp(await Account.open(passphrase)),

  profile: () => {
    const a = requireAccount();
    return { name: a.displayName, address: a.address, id: a.id };
  },
  setName: async (name: string) => {
    await requireAccount().setDisplayName(name);
    return requireAccount().displayName;
  },

  contacts: () => {
    const a = requireAccount();
    return a.contacts().map((c) => toView(a, c));
  },
  addContact: async (uri: string, name: string) => {
    const a = requireAccount();
    return toView(a, await a.addContact(uri, name));
  },

  archivia: async (id: string, valore: boolean) => {
    await requireAccount().archivia(id, valore);
    return true;
  },
  riordina: async (ids: string[]) => {
    await requireAccount().riordina(ids ?? []);
    return true;
  },
  svuotaConversazione: async (id: string) => {
    await requireAccount().svuotaConversazione(id);
    return true;
  },
  removeContact: async (id: string) => {
    await requireAccount().removeContact(id);
    return true;
  },
  safetyNumber: (id: string) => {
    const a = requireAccount();
    return a.safetyNumberWith(requireContact(a, id));
  },
  /** Butta le sessioni con un contatto: rubrica e storico restano. */
  riavviaSessione: async (id: string) => {
    const a = requireAccount();
    await a.riavviaSessione(requireContact(a, id));
    return true;
  },
  markVerified: async (id: string) => {
    await requireAccount().markVerified(id);
    return true;
  },

  history: (id: string) => {
    const a = requireAccount();
    return a.historyWith(requireContact(a, id));
  },
  send: (id: string, text: string) => {
    const a = requireAccount();
    return a.sendText(requireContact(a, id), text);
  },
  sync: () => requireAccount().sync(),

  // ---------- dispositivi collegati ----------

  /** Il codice da mostrare al dispositivo nuovo, gia' come QR. */
  codiceCollegamento: () => {
    const uri = requireAccount().codiceCollegamento();
    return { uri, qr: qrSvg(uri, 300) };
  },
  dispositivi: () => {
    const a = requireAccount();
    return a.dispositivi.map((d) => ({
      id: d.id,
      nome: d.nome,
      aggiuntoIl: d.aggiuntoIl,
      questo: d.id === a.idDispositivo,
    }));
  },

  /** Toglie un messaggio: solo da qui, o anche dall'altro. */
  eliminaMessaggio: (messaggioId: string, perEntrambi: boolean) =>
    requireAccount().eliminaMessaggio(messaggioId, perEntrambi === true),

  // ---------- file ----------

  /** Perche' questo file non puo' partire, o null se puo'. Chiesto PRIMA di
   *  leggere qualsiasi cosa: e' il senso del controllo. */
  perche: (id: string, dimensione: number) => {
    const a = requireAccount();
    return a.perche(requireContact(a, id), dimensione);
  },

  /**
   * File piccolo: i byte arrivano dalla finestra, gia' letti, in base64.
   *
   * Non come array di numeri: passarne cinque milioni attraverso il ponte
   * significa serializzare cinque milioni di elementi, e il tempo se ne va
   * tutto li' invece che nella rete.
   */
  sendFile: async (id: string, nome: string, tipo: string, dati: string) => {
    const a = requireAccount();
    return a.sendFile(requireContact(a, id), nome, tipo, new Uint8Array(Buffer.from(dati, 'base64')));
  },

  /** File grosso: si annuncia, poi i byte passano dal collegamento diretto. */
  iniziaDiretto: async (id: string, nome: string, tipo: string, dimensione: number) => {
    const a = requireAccount();
    return a.iniziaDiretto(requireContact(a, id), nome, tipo, dimensione);
  },

  /** I byte di un file ricevuto, per l'anteprima. Solo quelli piccoli. */
  fileDati: async (fileId: string) => {
    const bytes = await requireAccount().fileBytes(fileId);
    return Buffer.from(bytes).toString('base64');
  },

  /** Salva dove dice l'utente. Il file esce in chiaro solo qui, dove l'ha chiesto. */
  salvaFile: async (fileId: string, nome: string) => {
    const a = requireAccount();
    const scelta = await dialog.showSaveDialog(win!, { defaultPath: nomeFileSicuro(nome) });
    if (scelta.canceled || !scelta.filePath) return null;
    await writeFile(scelta.filePath, Buffer.from(await a.fileBytes(fileId)));
    return true;
  },

  /**
   * Dove scrivere un file che sta arrivando dal collegamento diretto.
   *
   * Restituisce un GETTONE, non un percorso. Il percorso resta qui dentro:
   * la finestra non lo vede e non puo' inventarne uno. Prima glielo
   * rimandavamo indietro e lei lo ripassava a ogni pezzo — bastava un difetto
   * nella pagina per farsi scrivere un file dove voleva.
   */
  destinazione: async (nome: string) => {
    const scelta = await dialog.showSaveDialog(win!, { defaultPath: nomeFileSicuro(nome) });
    if (scelta.canceled || !scelta.filePath) return null;
    const gettone = identificativo();
    // Il percorso vero viene restituito insieme al gettone SOLO per finire nel
    // registro, dove serve a riprendere un trasferimento interrotto. La finestra
    // non lo usa per scrivere: per quello passa sempre dal gettone.
    ultimoPercorso = scelta.filePath;
    destinazioni.set(gettone, scelta.filePath);
    // La mappa tiene l'ordine d'inserimento: se qualcuno non ha chiuso i suoi
    // gettoni, il piu' vecchio smette di valere invece di restare buono.
    while (destinazioni.size > MAX_DESTINAZIONI) {
      const vecchio = destinazioni.keys().next().value;
      if (vecchio === undefined) break;
      destinazioni.delete(vecchio);
      void chiudiFile(vecchio);
    }
    return { gettone, percorso: ultimoPercorso };
  },

  /**
   * Riprende un file lasciato a meta', senza richiedere dove salvarlo.
   *
   * Il percorso non arriva dalla finestra: si cerca nello storico il messaggio
   * di quel file e si usa quello che ci sta scritto. Se la finestra potesse
   * passare un percorso qualunque, un difetto nella pagina basterebbe per farsi
   * scrivere un file dove vuole — che e' esattamente cio' che i gettoni evitano.
   *
   * Restituisce anche quanti byte ci sono gia': e' quel numero, letto dal disco
   * e non dal registro, a dire da dove ripartire. Il registro puo' essere
   * indietro di qualche pezzo se il programma e' stato chiuso di colpo.
   */
  riprendiDestinazione: async (messaggioId: string) => {
    const a = requireAccount();
    const tutti = await a.tuttiMessaggi();
    const m = tutti.find((x) => x.id === messaggioId);
    const percorso = m?.file?.percorso;
    if (!percorso) return null;
    let gia = 0;
    try {
      gia = (await stat(percorso)).size;
    } catch {
      // Il file non c'e' piu': si ricomincia da zero, non e' un errore.
      return null;
    }
    const gettone = identificativo();
    destinazioni.set(gettone, percorso);
    return { gettone, gia };
  },

  /**
   * Il trasferimento e' finito: il gettone non deve piu' valere.
   *
   * Si chiama in tutti i casi — riuscito, fallito, annullato. Senza, il
   * permesso di scrivere su quel file restava valido per tutta l'accensione, e
   * bastava un difetto nella pagina per riscriverci sopra piu' tardi.
   */
  chiudiDestinazione: async (gettone: string) => {
    await chiudiFile(gettone);
    destinazioni.delete(gettone);
    return true;
  },

  /**
   * Scrive un pezzo di file che arriva dal collegamento diretto.
   *
   * In coda, un pezzo alla volta: un file di due gigabyte non puo' essere
   * tenuto in memoria mentre arriva, ne' passato tutto insieme di qui.
   */
  scriviPezzo: async (gettone: string, dati: string) => {
    const h = await fileDi(gettone);
    await h.write(Buffer.from(dati, 'base64'));
    return true;
  },

  /** Comincia da zero: un trasferimento ripreso non deve accodarsi al vecchio. */
  azzeraFile: async (gettone: string) => {
    // Prima si chiude quello eventualmente aperto: troncare un file mentre lo
    // si tiene aperto in coda lascerebbe la scrittura dopo il punto sbagliato.
    await chiudiFile(gettone);
    await writeFile(perGettone(gettone), Buffer.alloc(0));
    return true;
  },

  /**
   * Apre la cartella che contiene un file salvato.
   *
   * Prende il percorso vero, non un gettone: nello storico finisce il percorso
   * (i gettoni muoiono col programma, e MOSTRA deve funzionare anche il giorno
   * dopo). Cercarlo fra i gettoni, com'era prima, faceva fallire il pulsante
   * sempre — anche subito, perche' quello che la finestra ha in mano e' gia'
   * il percorso.
   *
   * Quello che la finestra puo' fare con questo e' aprire il gestore di file
   * su un percorso: non legge niente e non scrive niente.
   */
  mostraNellaCartella: (percorso: string) => {
    if (typeof percorso !== 'string' || !percorso) return false;
    shell.showItemInFolder(percorso);
    return true;
  },

  // ---------- relay ----------

  /** Su quali relay ascolta questo computer: i suoi o i predefiniti. */
  relay: () => requireAccount().relay(),
  /** La lista nuova, o null per i predefiniti. Il controllo lo fa il cuore. */
  impostaRelay: (elenco: unknown[] | null) => requireAccount().impostaRelay(elenco ?? null),
  /** Misura adesso: apre il collegamento con ciascuno e conta i millisecondi. */
  statoRelay: () => requireAccount().statoRelay(),

  // ---------- backup ----------

  /** Il deposito intero in un file, dove dice l'utente. Resta cifrato com'e'. */
  esportaBackup: async () => {
    const a = requireAccount();
    const scelta = await dialog.showSaveDialog(win!, {
      defaultPath: nomeFileBackup(),
      filters: [{ name: 'Backup THE WIRE', extensions: ['wirebk'] }],
    });
    if (scelta.canceled || !scelta.filePath) return null;
    await writeFile(scelta.filePath, Buffer.from(await a.esportaBackup()));
    return scelta.filePath;
  },

  /**
   * Rimette un backup nella cartella dei dati. Solo quando non c'e' ancora un
   * deposito: e' la strada per un computer nuovo, non un modo di tornare
   * indietro su uno che funziona.
   */
  ripristinaBackup: async () => {
    if (account) throw new Error('il ripristino vale solo su un dispositivo che non ha ancora un deposito');
    const scelta = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [
        { name: 'Backup THE WIRE', extensions: ['wirebk'] },
        { name: 'Tutti i file', extensions: ['*'] },
      ],
    });
    const percorso = scelta.filePaths[0];
    if (scelta.canceled || !percorso) return null;
    return Account.ripristinaBackup(new Uint8Array(await readFile(percorso)));
  },

  /** Il server TURN per il collegamento diretto. La password torna alla
   *  finestra perche' e' la finestra a creare la connessione: WebRTC vive li'. */
  turn: () => requireAccount().turn(),
  impostaTurn: (valore: { url?: unknown; utente?: unknown; password?: unknown } | null) =>
    requireAccount().impostaTurn(valore ?? null),

  /** Segnalazione WebRTC verso l'altro. I byte non passano di qui. */
  segnale: async (id: string, p: { id: string; ruolo: string; dati: string }) => {
    const a = requireAccount();
    await a.inviaSegnale(requireContact(a, id), p as never);
    return true;
  },

  /**
   * Esito di un trasferimento diretto, che avviene nella finestra.
   *
   * La finestra conosce solo il gettone; nello storico va il percorso vero, o
   * il pulsante MOSTRA smetterebbe di funzionare al primo riavvio — i gettoni
   * vivono in memoria e muoiono con il programma.
   */
  /** Solo l'avanzamento: non tocca il registro, e per questo si puo' chiamare
   *  a ogni pezzo senza far rallentare il trasferimento. */
  avanzamentoDiretto: (messaggioId: string, fatti: number) =>
    requireAccount().avanzamentoDiretto(messaggioId, fatti),

  esitoDiretto: async (messaggioId: string, cambi: Record<string, unknown>) => {
    const risolto = { ...cambi };
    if (typeof risolto['percorso'] === 'string') {
      const vero = destinazioni.get(risolto['percorso']);
      if (vero) risolto['percorso'] = vero;
    }
    return requireAccount().concludiDiretto(messaggioId, risolto as never);
  },

  groups: () => {
    const a = requireAccount();
    return a.groups().map((g) => groupView(a, g));
  },
  createGroup: async (name: string, memberIds: string[]) => {
    const a = requireAccount();
    const membri = (memberIds ?? []).flatMap((id) => {
      const c = a.contacts().find((x) => x.id === id);
      return c ? [c] : [];
    });
    return groupView(a, await a.createGroup(name, membri));
  },
  groupHistory: async (id: string, topicId?: string) => {
    const a = requireAccount();
    const g = requireGroup(a, id);
    // La faccia mostra un nome, non un identificativo: risolverlo qui evita di
    // mandarle il roster completo a ogni messaggio.
    return (await a.groupHistory(g, topicId)).map((m) => ({
      ...m,
      author: m.mine ? 'Tu' : a.memberName(g, m.from ?? ''),
    }));
  },
  sendGroup: async (id: string, topicId: string, text: string) => {
    const a = requireAccount();
    const m = await a.sendGroupText(requireGroup(a, id), topicId || DEFAULT_TOPIC.id, text);
    return { ...m, author: 'Tu' };
  },
  addTopic: (id: string, name: string) => {
    const a = requireAccount();
    return a.addTopic(requireGroup(a, id), name);
  },
  addMember: async (id: string, contactId: string) => {
    const a = requireAccount();
    return groupView(a, await a.addMember(requireGroup(a, id), requireContact(a, contactId)));
  },
  leaveGroup: async (id: string) => {
    await requireAccount().leaveGroup(id);
    return true;
  },
};

function invoca(metodo: string, args: unknown[]): Promise<unknown> {
  const azione = azioni[metodo];
  if (!azione) return Promise.reject(new Error(`operazione sconosciuta: ${metodo}`));
  return Promise.resolve((azione as (...a: unknown[]) => unknown)(...args));
}

// ---------- ascoltatori dei messaggi in arrivo ----------

const facce = new Set<(m: Message) => void>();

async function bringUp(created: Account): Promise<{ address: string; uri: string }> {
  account = created;
  account.onMessage((m) => {
    for (const f of facce) f(m);
  });
  facce.add((m) => win?.webContents.send('wire:message', m));
  // La segnalazione del collegamento diretto va alla finestra: WebRTC vive li'.
  account.onSegnale((da, p) => win?.webContents.send('wire:segnale', { da, p }));
  // Lo storico arrivato da un altro dispositivo: la finestra rilegge la conversazione.
  account.onStorico((quanti) => win?.webContents.send('wire:storico', quanti));
  try {
    await account.connect();
    // `void` non gestisce il rifiuto: lo lascia diventare una promessa non
    // gestita. Il primo ritiro va in sottofondo, ma il suo errore va raccolto.
    account.sync().catch((e) => segnala('primo ritiro dalla mailbox', e));
  } catch (e) {
    // Senza rete si lavora comunque: contatti e storico sono locali.
    segnala('collegamento alla mailbox', e);
  }
  return { address: account.address, uri: account.uri };
}

// ---------- blocco automatico ----------

/**
 * Dopo dieci minuti senza nessuno, l'account si chiude da solo.
 *
 * Finche' e' aperto, la chiave del deposito sta in memoria: un computer
 * lasciato acceso e incustodito era leggibile per intero. Ora torna alla
 * schermata della passphrase — costa i due secondi di Argon2id al rientro,
 * ed e' l'intero prezzo.
 *
 * "Nessuno" tiene conto anche del telefono: il tempo di inattivita' del
 * sistema lo misura `powerMonitor`, ma chi sta usando l'app dal telefono non
 * muove il mouse del PC, e bloccarglielo sotto le dita non e' sicurezza, e'
 * un dispetto. Vale l'ultima richiesta remota, qualunque sia.
 */
const BLOCCO_DOPO_MS = 10 * 60 * 1000;

async function bloccaPerInattivita(): Promise<void> {
  const a = account;
  if (!a) return;
  account = null;
  try {
    // `close` spegne la mailbox, azzera la chiave in memoria e lascia il
    // deposito: e' la stessa strada della chiusura normale.
    await a.close();
  } catch (e) {
    segnala('blocco automatico', e);
  }
  win?.webContents.send('wire:bloccato');
}

setInterval(() => {
  if (!account) return;
  const fermoDaMs = powerMonitor.getSystemIdleTime() * 1000;
  if (fermoDaMs >= BLOCCO_DOPO_MS) void bloccaPerInattivita();
}, 60 * 1000);

// ---------- finestra ----------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    frame: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: join(appRoot, 'apps', 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Il processo che disegna la finestra gira dentro la sandbox del
      // sistema operativo. Il preload usa solo `electron`, che nella sandbox
      // c'e': niente si perde, e un difetto nella pagina resta chiuso li'
      // dentro invece di avere a disposizione il processo intero.
      sandbox: true,
      // Nessuna finestra dell'app deve poter aprire pagine esterne.
      webviewTag: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[wire] pagina non caricata (${code} ${desc}): ${url}`);
    win?.show();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    // Anche il codice d'uscita: "crashed" da solo non distingue un difetto
    // della pagina da un ambiente che non lascia partire i processi figli.
    console.error('[wire] processo di rendering terminato:', details.reason, 'codice', details.exitCode);
  });


  win.loadFile(join(cartellaUi, 'index.html')).catch((e) => console.error('[wire] loadFile fallita:', e));

  // Un link nell'interfaccia non deve poter navigare via la finestra dell'app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  /**
   * Nessuna navigazione fuori dai file dell'app.
   *
   * `setWindowOpenHandler` copre solo le finestre nuove. Una navigazione della
   * finestra stessa — `location.href = ...` — non passava di li', e il preload
   * viene riagganciato a ogni navigazione: una pagina esterna si sarebbe
   * trovata `window.wireApi` fra le mani, cioe' l'account intero.
   */
  win.webContents.on('will-navigate', (evento, url) => {
    if (!url.startsWith('file://')) {
      evento.preventDefault();
      segnala('navigazione bloccata', new Error(url.slice(0, 120)));
    }
  });

  /**
   * Regole sul contenuto della pagina.
   *
   * Con `contextIsolation` una falla nella pagina non arriva a Node, ma
   * arriverebbe a `window.wireApi`, che sa mandare messaggi, leggere file e
   * cancellare. Qui si toglie il gradino prima: niente codice da fuori, niente
   * connessioni verso fuori, e nessun modo di eseguire una stringa come codice.
   */
  win.webContents.session.webRequest.onHeadersReceived((dettagli, callback) => {
    callback({
      responseHeaders: {
        ...dettagli.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

// ---------- IPC ----------

ipcMain.on('wire:window', (_e, action: string) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
});

ipcMain.handle('wire:call', (_e, metodo: string, args: unknown[]) => invoca(metodo, args ?? []));

// ---------- ciclo di vita ----------

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', async () => {
  await account?.close();
  account = null;
});
