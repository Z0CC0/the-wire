// I candidati di rete che arrivano prima che ci sia una connessione.
//
// Chi manda spedisce offerta e candidati nello stesso istante; sui relay ci
// mettono meno di un secondo. Chi riceve, in quel secondo, ha davanti la
// finestra "dove salvare" e non ha ancora creato la connessione. Prima quei
// candidati venivano buttati, e allo scadere dei trenta secondi la diagnosi
// diceva `suoi=0`: nessun candidato dell'altro, nessuna coppia da provare,
// collegamento mai tentato. Sintomo visto su un trasferimento vero:
// "ice=new, raccolta=gathering, miei host=6 srflx=1, suoi=0".
//
// Qui si carica `ui/diretto.js` per davvero, con finti `api` e
// `RTCPeerConnection`, e si controlla che i candidati arrivati mentre la
// finestra e' aperta finiscano nella connessione appena esiste.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SORGENTE = readFileSync(join(__dirname, '..', '..', '..', 'ui', 'diretto.js'), 'utf8');

class FintaConnessione {
  static ultime: FintaConnessione[] = [];
  remoteDescription: unknown = null;
  aggiunti: unknown[] = [];
  rifiutati = 0;
  connectionState = 'new';
  iceConnectionState = 'new';
  iceGatheringState = 'new';
  sctp = { maxMessageSize: 262144 };
  __cand: { remoti: number } | undefined;
  onicecandidate: ((e: unknown) => void) | null = null;
  onicecandidateerror: ((e: unknown) => void) | null = null;
  ondatachannel: ((e: unknown) => void) | null = null;

  constructor() {
    FintaConnessione.ultime.push(this);
  }
  createDataChannel() {
    return { readyState: 'connecting', binaryType: '', send() {}, bufferedAmount: 0 };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0' };
  }
  async setLocalDescription() {}
  async setRemoteDescription(d: unknown) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: unknown) {
    // Come nel browser: senza descrizione remota il candidato viene rifiutato.
    if (!this.remoteDescription) {
      this.rifiutati += 1;
      throw new Error('remote description not set');
    }
    this.aggiunti.push(c);
  }
  close() {}
}

function carica(opzioni: { destinazione: () => Promise<unknown> }) {
  const segnali: unknown[] = [];
  const api = {
    segnale: async (_id: string, p: unknown) => {
      segnali.push(p);
    },
    history: async () => [{ id: 'msg-1', file: { id: 'f1' } }],
    riprendiDestinazione: async () => null,
    destinazione: opzioni.destinazione,
    esitoDiretto: async () => null,
    azzeraFile: async () => true,
    chiudiDestinazione: async () => true,
    avanzamentoDiretto: async () => null,
  };
  const contesto = vm.createContext({
    api,
    state: { open: null },
    document: { querySelector: () => null },
    avvisoDiSistema: () => {},
    metti: () => {},
    el: () => ({}),
    setTimeout,
    clearTimeout,
    btoa,
    RTCPeerConnection: FintaConnessione,
    console,
  });
  vm.runInContext(SORGENTE, contesto, { filename: 'diretto.js' });
  return { contesto, segnali };
}

async function unMomento(): Promise<void> {
  // Un giro intero del ciclo degli eventi, come farebbe la rete fra un
  // segnale e l'altro: la catena scelta-cartella, descrizione remota e
  // candidati e' fatta di promesse annidate, e i soli microtask non bastano.
  await new Promise((r) => setTimeout(r, 0));
}

describe('candidati arrivati mentre si sceglie dove salvare', () => {
  it('chi riceve li da alla connessione appena esiste, invece di buttarli', async () => {
    FintaConnessione.ultime = [];
    let scegli: ((v: unknown) => void) | null = null;
    const finestraAperta = new Promise((r) => (scegli = r));
    const { contesto } = carica({ destinazione: () => finestraAperta });
    const ricevi = contesto['riceviSegnale'] as (da: string, p: unknown) => Promise<void>;

    // L'annuncio, poi l'offerta: da qui la finestra "dove salvare" resta aperta.
    await ricevi('alice', { id: 'f1', ruolo: 'offerta', dati: JSON.stringify({ t: 'file.offer', nome: 'a.zip', dimensione: 10 }) });
    void ricevi('alice', { id: 'f1', ruolo: 'offerta', dati: JSON.stringify({ type: 'offer', sdp: 'v=0' }) });
    await unMomento();
    expect(FintaConnessione.ultime, 'la connessione non esiste finche non si e scelto dove salvare').toHaveLength(0);

    // Intanto arrivano i candidati dell'altro: tre, come succede davvero.
    for (let i = 0; i < 3; i++) {
      await ricevi('alice', { id: 'f1', ruolo: 'candidato', dati: JSON.stringify({ candidate: `c${i}` }) });
    }

    // Ora si sceglie la cartella.
    scegli!({ gettone: 'g1', percorso: 'C:/x/a.zip' });
    await unMomento();

    expect(FintaConnessione.ultime).toHaveLength(1);
    const pc = FintaConnessione.ultime[0]!;
    expect(pc.remoteDescription, 'l offerta e stata impostata').not.toBeNull();
    expect(pc.aggiunti, 'tutti e tre i candidati sono nella connessione').toHaveLength(3);
    expect(pc.rifiutati, 'nessuno e stato dato prima della descrizione remota').toBe(0);
    expect(pc.__cand?.remoti, 'la diagnosi li conta').toBe(3);
  });

  it('un candidato arrivato dopo, a connessione pronta, entra subito', async () => {
    FintaConnessione.ultime = [];
    const { contesto } = carica({ destinazione: async () => ({ gettone: 'g1', percorso: 'C:/x/a.zip' }) });
    const ricevi = contesto['riceviSegnale'] as (da: string, p: unknown) => Promise<void>;

    await ricevi('alice', { id: 'f1', ruolo: 'offerta', dati: JSON.stringify({ t: 'file.offer', nome: 'a.zip', dimensione: 10 }) });
    await ricevi('alice', { id: 'f1', ruolo: 'offerta', dati: JSON.stringify({ type: 'offer', sdp: 'v=0' }) });
    await unMomento();
    await ricevi('alice', { id: 'f1', ruolo: 'candidato', dati: JSON.stringify({ candidate: 'tardi' }) });

    const pc = FintaConnessione.ultime[0]!;
    expect(pc.aggiunti).toHaveLength(1);
    expect(pc.rifiutati).toBe(0);
  });

  it('chi manda tiene i candidati che precedono la risposta sui relay', async () => {
    FintaConnessione.ultime = [];
    const { contesto } = carica({ destinazione: async () => null });
    const invia = contesto['inviaDiretto'] as (c: unknown, m: unknown, f: unknown) => Promise<void>;
    const ricevi = contesto['riceviSegnale'] as (da: string, p: unknown) => Promise<void>;

    await invia({ id: 'bob' }, { id: 'msg-1', file: { id: 'f2' } }, { name: 'b.zip', size: 10, slice: () => ({ size: 0 }) });
    const pc = FintaConnessione.ultime[0]!;

    // I relay non garantiscono l'ordine: il candidato arriva prima della risposta.
    await ricevi('bob', { id: 'f2', ruolo: 'candidato', dati: JSON.stringify({ candidate: 'prima' }) });
    expect(pc.rifiutati, 'non si prova nemmeno: senza descrizione remota fallirebbe').toBe(0);
    expect(pc.aggiunti).toHaveLength(0);

    await ricevi('bob', { id: 'f2', ruolo: 'risposta', dati: JSON.stringify({ type: 'answer', sdp: 'v=0' }) });
    expect(pc.aggiunti, 'dopo la risposta il candidato messo da parte entra').toHaveLength(1);
    expect(pc.__cand?.remoti).toBe(1);
  });
});
