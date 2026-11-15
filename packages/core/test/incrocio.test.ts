// Due persone che si scrivono per prime nello stesso momento.
//
// Questo test esiste per un difetto vero, che ha reso muta una conversazione
// reale mentre il pallino restava acceso.
//
// Cosa succedeva. Ognuno dei due, scrivendo per primo, apriva una sessione sua
// con X3DH. Ricevendo poi il primo messaggio dell'altro, `Session.accept`
// SOSTITUIVA la propria sessione con quella accettata, perche' se ne teneva una
// sola per contatto. Da quel momento ciascuno cifrava con una sessione che
// l'altro non aveva piu': ogni messaggio successivo veniva scartato in
// silenzio, per sempre.
//
// Era invisibile dall'esterno, e questa e' la parte peggiore: la presenza non
// passa dal ratchet, quindi i due continuavano a vedersi online mentre non si
// arrivava piu' niente.
//
// La correzione tiene piu' sessioni per contatto: la propria per scrivere, le
// altre per leggere.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex } from '../src/codec.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-incr-'));
  dirs.push(d);
  return d;
}

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Nessuno dei due in ascolto: scrivono al buio, come due persone che si
 *  scrivono nello stesso momento. */
async function coppiaAlBuio(): Promise<[Account, Account]> {
  const a = await Account.create(PASS, await cartella());
  const b = await Account.create(PASS, await cartella());
  await a.addContact(b.uri, 'BOB');
  await b.addContact(a.uri, 'ALICE');
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
  await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });
  return [a, b];
}

describe('sessioni incrociate', () => {
  it('se scrivono per primi entrambi, la conversazione continua da tutte e due le parti', async () => {
    const [a, b] = await coppiaAlBuio();

    for (const n of ['primo', 'secondo', 'terzo']) {
      await a.sendText(a.contact('BOB')!, `${n} di A`);
      await b.sendText(b.contact('ALICE')!, `${n} di B`);
      await b.sync();
      await a.sync();
    }

    const daA = (await b.historyWith(b.contact('ALICE')!)).filter((m) => !m.mine).map((m) => m.text);
    const daB = (await a.historyWith(a.contact('BOB')!)).filter((m) => !m.mine).map((m) => m.text);
    // Prima della correzione arrivava solo il primo di ciascuno, e nient'altro
    // per sempre.
    expect(daA).toEqual(['primo di A', 'secondo di A', 'terzo di A']);
    expect(daB).toEqual(['primo di B', 'secondo di B', 'terzo di B']);

    await a.close();
    await b.close();
  });

  it('le sessioni incrociate sopravvivono a chiusura e riapertura', async () => {
    const dirA = await cartella();
    const dirB = await cartella();
    const a = await Account.create(PASS, dirA);
    const b = await Account.create(PASS, dirB);
    await a.addContact(b.uri, 'BOB');
    await b.addContact(a.uri, 'ALICE');
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });

    await a.sendText(a.contact('BOB')!, 'primo di A');
    await b.sendText(b.contact('ALICE')!, 'primo di B');
    await b.sync();
    await a.sync();
    await a.close();
    await b.close();

    // Riaperti: il deposito deve aver conservato ENTRAMBE le sessioni, non una.
    const a2 = await Account.open(PASS, dirA);
    const b2 = await Account.open(PASS, dirB);
    await a2.connect(new MemoryMailbox(hex(a2.identity.nostrPublic)), { live: false });
    await b2.connect(new MemoryMailbox(hex(b2.identity.nostrPublic)), { live: false });

    await a2.sendText(a2.contact('BOB')!, 'dopo il riavvio, da A');
    await b2.sendText(b2.contact('ALICE')!, 'dopo il riavvio, da B');
    await b2.sync();
    await a2.sync();

    const daA = (await b2.historyWith(b2.contact('ALICE')!)).filter((m) => !m.mine).map((m) => m.text);
    const daB = (await a2.historyWith(a2.contact('BOB')!)).filter((m) => !m.mine).map((m) => m.text);
    expect(daA).toContain('dopo il riavvio, da A');
    expect(daB).toContain('dopo il riavvio, da B');

    await a2.close();
    await b2.close();
  });

  it('riavviare la cifratura da entrambe le parti rimette in sesto una conversazione muta', async () => {
    const [a, b] = await coppiaAlBuio();
    await a.sendText(a.contact('BOB')!, 'prima del guasto');
    await b.sync();

    // Si simula il guasto: le sessioni non coincidono piu'.
    await a.riavviaSessione(a.contact('BOB')!);
    await a.sendText(a.contact('BOB')!, 'con una sessione che B non conosce');
    await b.sync();

    // Il rimedio: entrambi buttano le sessioni, e si ricomincia.
    await a.riavviaSessione(a.contact('BOB')!);
    await b.riavviaSessione(b.contact('ALICE')!);

    await a.sendText(a.contact('BOB')!, 'dopo il riavvio');
    await b.sendText(b.contact('ALICE')!, 'anche da B');
    await b.sync();
    await a.sync();

    const daA = (await b.historyWith(b.contact('ALICE')!)).filter((m) => !m.mine).map((m) => m.text);
    const daB = (await a.historyWith(a.contact('BOB')!)).filter((m) => !m.mine).map((m) => m.text);
    expect(daA).toContain('dopo il riavvio');
    expect(daB).toContain('anche da B');
    // Lo storico non si tocca: riavviare la cifratura non cancella niente.
    expect(daA).toContain('prima del guasto');

    await a.close();
    await b.close();
  });
});
