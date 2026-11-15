// Prova d'insieme: due account veri, su disco, che si parlano attraverso una
// mailbox. Qui non si testa una funzione: si testa che il sistema funzioni.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex } from '../src/codec.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function nuovaCartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-test-'));
  dirs.push(d);
  return d;
}

/** Due account che si conoscono, ciascuno con la propria mailbox in memoria. */
async function coppia() {
  const dirA = await nuovaCartella();
  const dirB = await nuovaCartella();
  const a = await Account.create(PASS, dirA);
  const b = await Account.create(PASS, dirB);

  await a.addContact(b.uri, 'BOB');
  await b.addContact(a.uri, 'ALICE');

  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
  await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });
  return { a, b, dirA, dirB, bob: a.contact('BOB')!, alice: b.contact('ALICE')! };
}

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('account', () => {
  it('lo scambio di card produce contatti coerenti', async () => {
    const { a, b, bob, alice } = await coppia();
    expect(bob.name).toBe('BOB');
    expect(alice.name).toBe('ALICE');
    expect(bob.id).toBe(hex(b.accountPublic));
    // E il dispositivo con cui e' stato aggiunto e' fra i suoi, non e' lui.
    expect(bob.dispositivi.map((d) => d.id)).toContain(hex(b.identity.sigPublic));
    expect(bob.id).not.toBe(hex(b.identity.sigPublic));
    expect(bob.verifiedAt).toBeNull(); // finche' non si legge il numero a voce
    await a.close();
    await b.close();
  });

  it('il numero di sicurezza coincide sui due schermi', async () => {
    const { a, b, bob, alice } = await coppia();
    expect(a.safetyNumberWith(bob)).toBe(b.safetyNumberWith(alice));
    await a.close();
    await b.close();
  });

  it('un messaggio parte, arriva e si decifra', async () => {
    const { a, b, bob } = await coppia();
    await a.sendText(bob, 'ciao, sono la prima riga vera');

    const arrivati = await b.sync();
    expect(arrivati).toHaveLength(1);
    expect(arrivati[0]!.text).toBe('ciao, sono la prima riga vera');
    expect(arrivati[0]!.mine).toBe(false);
    await a.close();
    await b.close();
  });

  it('conversazione nei due sensi', async () => {
    const { a, b, bob, alice } = await coppia();
    await a.sendText(bob, 'uno');
    expect((await b.sync())[0]!.text).toBe('uno');
    await b.sendText(alice, 'due');
    expect((await a.sync())[0]!.text).toBe('due');
    await a.sendText(bob, 'tre');
    expect((await b.sync())[0]!.text).toBe('tre');
    await a.close();
    await b.close();
  });

  it('lo storico contiene entrambi i lati, in ordine', async () => {
    const { a, b, bob, alice } = await coppia();
    await a.sendText(bob, 'primo');
    await b.sync();
    await b.sendText(alice, 'secondo');
    await a.sync();

    const storico = await a.historyWith(bob);
    expect(storico.map((m) => m.text)).toEqual(['primo', 'secondo']);
    expect(storico.map((m) => m.mine)).toEqual([true, false]);
    await a.close();
    await b.close();
  });

  it('tutto sopravvive a chiusura e riapertura', async () => {
    const { a, b, dirA, bob, alice } = await coppia();
    await a.sendText(bob, 'prima del riavvio');
    await b.sync();
    await a.close();

    const a2 = await Account.open(PASS, dirA);
    await a2.connect(new MemoryMailbox(hex(a2.identity.nostrPublic)), { live: false });
    const contatto = a2.contact('BOB')!;
    expect(contatto.id).toBe(bob.id);
    expect((await a2.historyWith(contatto)).map((m) => m.text)).toEqual(['prima del riavvio']);

    // La sessione ripresa da disco deve continuare la stessa catena.
    await b.sendText(alice, 'dopo il riavvio');
    expect((await a2.sync())[0]!.text).toBe('dopo il riavvio');
    await a2.close();
    await b.close();
  });

  it('la passphrase sbagliata non apre nulla', async () => {
    const dir = await nuovaCartella();
    const a = await Account.create(PASS, dir);
    await a.close();
    await expect(Account.open('un-altra-passphrase', dir)).rejects.toThrow(/passphrase errata/);
  });

  it('non si sovrascrive un account esistente', async () => {
    const dir = await nuovaCartella();
    const a = await Account.create(PASS, dir);
    await a.close();
    await expect(Account.create(PASS, dir)).rejects.toThrow();
  });

  it('un messaggio da uno sconosciuto viene ignorato', async () => {
    const { b } = await coppia();
    const dirC = await nuovaCartella();
    const carla = await Account.create(PASS, dirC);
    await carla.addContact(b.uri, 'BOB'); // Carla conosce Bob, Bob non conosce Carla
    await carla.connect(new MemoryMailbox(hex(carla.identity.nostrPublic)), { live: false });
    await carla.sendText(carla.contact('BOB')!, 'non mi conosci');

    expect(await b.sync()).toHaveLength(0);
    await carla.close();
    await b.close();
  });

  it('un contatto in piu non rovina la sessione di un altro', async () => {
    // Il tentativo di decifrare con la sessione sbagliata fa avanzare il
    // ratchet: se non lo si fa su una copia, il contatto innocente si rompe.
    const { a, b, bob, alice } = await coppia();
    const dirC = await nuovaCartella();
    const carla = await Account.create(PASS, dirC);
    await a.addContact(carla.uri, 'CARLA');
    await carla.addContact(a.uri, 'ALICE');
    await carla.connect(new MemoryMailbox(hex(carla.identity.nostrPublic)), { live: false });

    // Alice apre una sessione anche con Carla, poi Bob le scrive.
    await a.sendText(a.contact('CARLA')!, 'ciao Carla');
    await b.sendText(alice, 'ciao da Bob');

    const arrivati = await a.sync();
    expect(arrivati).toHaveLength(1);
    expect(arrivati[0]!.text).toBe('ciao da Bob');
    expect(arrivati[0]!.peer).toBe(bob.id);

    // E la sessione con Carla e' rimasta sana.
    await carla.sync();
    await carla.sendText(carla.contact('ALICE')!, 'risposta di Carla');
    const secondi = await a.sync();
    expect(secondi.map((m) => m.text)).toEqual(['risposta di Carla']);

    await a.close();
    await b.close();
    await carla.close();
  });

  it('rimuovere un contatto cancella anche il suo storico', async () => {
    const { a, b, bob } = await coppia();
    await a.sendText(bob, 'da dimenticare');
    await b.sync();
    expect(await a.historyWith(bob)).toHaveLength(1);

    await a.removeContact(bob.id);
    expect(a.contacts()).toHaveLength(0);
    expect(await a.historyWith(bob)).toHaveLength(0);
    await a.close();
    await b.close();
  });

  it('non si aggiunge la propria card come contatto', async () => {
    const dir = await nuovaCartella();
    const a = await Account.create(PASS, dir);
    await expect(a.addContact(a.uri, 'IO')).rejects.toThrow(/tua card/);
    await a.close();
  });
});
