// Il server TURN entra nella connessione solo se c'e', e la diagnosi lo nomina.
//
// Si carica `ui/diretto.js` per davvero, con un finto `RTCPeerConnection` che
// si tiene la configurazione ricevuta: e' l'unico modo di vedere cosa arriva a
// Chromium, perche' da fuori una connessione con o senza TURN e' identica fino
// al momento in cui fallisce.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SORGENTE = readFileSync(join(__dirname, '..', '..', '..', 'ui', 'diretto.js'), 'utf8');

interface Config {
  iceServers: { urls: string; username?: string; credential?: string }[];
}

class FintaConnessione {
  static configurazioni: Config[] = [];
  remoteDescription: unknown = null;
  connectionState = 'new';
  iceConnectionState = 'failed';
  iceGatheringState = 'complete';
  sctp = { maxMessageSize: 262144 };
  __cand: unknown;
  onicecandidate: unknown = null;
  onicecandidateerror: unknown = null;
  constructor(config: Config) {
    FintaConnessione.configurazioni.push(config);
  }
  createDataChannel() {
    return { readyState: 'connecting', binaryType: '', send() {}, bufferedAmount: 0 };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0' };
  }
  async setLocalDescription() {}
  close() {}
}

function carica(turn: unknown) {
  FintaConnessione.configurazioni = [];
  const contesto = vm.createContext({
    api: { segnale: async () => {}, esitoDiretto: async () => null, avanzamentoDiretto: async () => null },
    state: { open: null, turn },
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
  return contesto as unknown as {
    nuovaConnessione: () => FintaConnessione;
    diagnosi: (pc: FintaConnessione) => string;
    serverIce: () => Config['iceServers'];
  };
}

const TURN = { url: 'turns:relay.esempio.it:443?transport=tcp', utente: 'u', password: 'p' };

describe('il server TURN nella connessione', () => {
  it('senza TURN ci sono solo gli STUN, come prima', () => {
    const d = carica(null);
    d.nuovaConnessione();
    const servers = FintaConnessione.configurazioni[0]!.iceServers;
    expect(servers.length).toBeGreaterThan(0);
    expect(servers.every((s) => s.urls.startsWith('stun:'))).toBe(true);
    expect(servers.some((s) => 'credential' in s)).toBe(false);
  });

  it('con TURN entra in coda agli STUN, con le credenziali', () => {
    const d = carica(TURN);
    d.nuovaConnessione();
    const servers = FintaConnessione.configurazioni[0]!.iceServers;
    const ultimo = servers[servers.length - 1]!;
    expect(ultimo).toEqual({ urls: TURN.url, username: 'u', credential: 'p' });
    expect(servers.slice(0, -1).every((s) => s.urls.startsWith('stun:'))).toBe(true);
  });

  it('un TURN a meta (senza password) non entra: Chromium rifiuterebbe tutta la connessione', () => {
    const d = carica({ url: TURN.url, utente: 'u', password: '' });
    expect(d.serverIce().some((s) => 'credential' in s)).toBe(false);
  });

  it('la diagnosi dice se il TURN c era e non ha dato candidati', () => {
    const con = carica(TURN);
    const pc = con.nuovaConnessione();
    pc.__cand = { host: 2, srflx: 1, relay: 0, remoti: 3, errori: [] };
    expect(con.diagnosi(pc)).toMatch(/turn=nessun candidato/);
    pc.__cand = { host: 2, srflx: 1, relay: 1, remoti: 3, errori: [] };
    expect(con.diagnosi(pc)).not.toMatch(/turn=/);

    const senza = carica(null);
    const pc2 = senza.nuovaConnessione();
    pc2.__cand = { host: 2, srflx: 1, relay: 0, remoti: 0, errori: [] };
    expect(senza.diagnosi(pc2)).toMatch(/turn=assente/);
  });
});
