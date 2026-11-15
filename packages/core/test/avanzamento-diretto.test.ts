// L'avanzamento di un file grande non deve costare quanto il registro.
//
// Prima ogni pezzo da 64 KB passava da `concludiDiretto`, che rilegge TUTTO lo
// storico, lo decifra e ci aggiunge un record. Il costo cresce con il registro,
// quindi ogni pezzo costa piu' del precedente: misurato, da 2 a 13 millisecondi
// in milleseicento pezzi. Su un file da 4 GB i pezzi sono 65.536, e il
// trasferimento rallentava fino a fermarsi — chi mandava vedeva "collegamento
// non stabilito", chi riceveva "non arrivato intero".
//
// Qui non si misura il tempo, che su una macchina carica dice quello che vuole:
// si contano le riletture del registro, che sono la cosa che cresceva.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex } from '../src/codec.js';
import type { Message } from '../src/history.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-avanz-'));
  dirs.push(d);
  return d;
}

const QUATTRO_GIGA = 4 * 1024 * 1024 * 1024;

async function conFileInCorso() {
  const a = await Account.create(PASS, await cartella());
  const b = await Account.create(PASS, await cartella());
  await a.addContact(b.uri, 'BOB');
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });

  // Il messaggio si scrive nel registro direttamente: qui interessa il costo
  // degli aggiornamenti, non il controllo su chi e' online.
  const storia = (a as unknown as { history: { all(): Promise<Message[]>; append(m: Message): Promise<void> } }).history;
  const messaggio = {
    id: 'file-grosso',
    peer: a.contact('BOB')!.id,
    mine: true,
    text: '',
    at: Date.now(),
    file: {
      id: 'f1',
      nome: 'grosso.bin',
      tipo: 'application/octet-stream',
      dimensione: QUATTRO_GIGA,
      sha256: ''.padEnd(64, '0'),
      via: 'diretto' as const,
      stato: 'in-corso' as const,
      fatti: 0,
    },
  } as Message;
  await storia.append(messaggio);

  // Da qui in poi si contano le riletture.
  let letture = 0;
  const vera = storia.all.bind(storia);
  storia.all = async () => {
    letture += 1;
    return vera();
  };
  return { a, b, messaggio, letture: () => letture };
}

describe('avanzamento di un trasferimento diretto', () => {
  it('cento aggiornamenti non rileggono cento volte il registro', async () => {
    const { a, b, messaggio, letture } = await conFileInCorso();
    for (let i = 1; i <= 100; i++) await a.avanzamentoDiretto(messaggio.id, i * 65536);
    // Una sola: la prima, per trovare il messaggio. Poi resta in memoria.
    expect(letture()).toBeLessThanOrEqual(1);
    await a.close();
    await b.close();
  });

  it('l avanzamento arriva a chi guarda la finestra', async () => {
    const { a, b, messaggio } = await conFileInCorso();
    const visti: number[] = [];
    a.onMessage((m) => {
      if (m.id === messaggio.id && m.file) visti.push(m.file.fatti);
    });
    await a.avanzamentoDiretto(messaggio.id, 65536);
    await a.avanzamentoDiretto(messaggio.id, 131072);
    expect(visti).toEqual([65536, 131072]);
    await a.close();
    await b.close();
  });

  it('alla fine il conto finisce sul disco, non solo in memoria', async () => {
    // L'avanzamento non si scrive; ma quando il file e' arrivato, quanti byte
    // sono passati deve restare, o la riga direbbe zero su un file completo.
    const { a, b, messaggio } = await conFileInCorso();
    await a.avanzamentoDiretto(messaggio.id, QUATTRO_GIGA);
    await a.concludiDiretto(messaggio.id, { stato: 'pronto' });

    const riletto = (await a.historyWith(a.contact('BOB')!)).find((m) => m.id === messaggio.id);
    expect(riletto?.file?.stato).toBe('pronto');
    expect(riletto?.file?.fatti).toBe(QUATTRO_GIGA);
    await a.close();
    await b.close();
  });

  it('finito il trasferimento non resta niente in memoria', async () => {
    const { a, b, messaggio } = await conFileInCorso();
    await a.avanzamentoDiretto(messaggio.id, 65536);
    await a.concludiDiretto(messaggio.id, { stato: 'fallito' });
    const dentro = (a as unknown as { inTransito: Map<string, unknown> }).inTransito;
    expect(dentro.size).toBe(0);
    await a.close();
    await b.close();
  });
});
