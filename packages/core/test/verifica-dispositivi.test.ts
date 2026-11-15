// La verifica a voce vale per l'insieme di dispositivi di quel momento.
//
// Il numero di sicurezza copre TUTTI i dispositivi di un contatto. Quando lui
// ne collega uno nuovo, quel numero cambia — ed e' il solo segnale che fa
// accorgere di un dispositivo che l'altro non ha messo. Se l'interfaccia
// continuasse a dire "verificata", quel segnale sparirebbe proprio nel momento
// in cui serve: e' cio' che questo test impedisce di reintrodurre.

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
  const d = await mkdtemp(join(tmpdir(), 'wire-verifica-'));
  dirs.push(d);
  return d;
}

async function coppia() {
  const a = await Account.create(PASS, await nuovaCartella());
  const b = await Account.create(PASS, await nuovaCartella());
  await a.addContact(b.uri, 'BOB');
  await b.addContact(a.uri, 'ALICE');
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
  await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });
  return { a, b };
}

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('verifica e dispositivi', () => {
  it('un dispositivo nuovo dell altro toglie la verifica', async () => {
    const { a, b } = await coppia();
    await a.markVerified(a.contact('BOB')!.id);
    expect(a.contact('BOB')!.verifiedAt).not.toBeNull();
    const numeroPrima = a.safetyNumberWith(a.contact('BOB')!);

    // BOB collega un secondo dispositivo e lo annuncia.
    const secondo = await Account.create(PASS, await nuovaCartella());
    await secondo.connect(new MemoryMailbox(hex(secondo.identity.nostrPublic)), { live: false });
    await secondo.collegatiCome(b.codiceCollegamento());
    await b.sync();
    await a.sync();

    const bob = a.contact('BOB')!;
    expect(bob.dispositivi.length, 'ALICE deve vedere i due dispositivi').toBeGreaterThan(1);
    expect(a.safetyNumberWith(bob), 'il numero deve cambiare').not.toBe(numeroPrima);
    expect(bob.verifiedAt, 'e la verifica non deve piu valere').toBeNull();

    await a.close();
    await b.close();
    await secondo.close();
  });

  it('un annuncio che non cambia niente lascia la verifica dov e', async () => {
    // L'elenco viene rimandato anche quando e' identico. Azzerare a ogni
    // annuncio vorrebbe dire non restare verificati mai, e chi usa il programma
    // smetterebbe di dare peso a quell'avviso.
    const { a, b } = await coppia();
    await a.markVerified(a.contact('BOB')!.id);
    const quando = a.contact('BOB')!.verifiedAt;

    for (let i = 0; i < 3; i++) {
      await b.sync();
      await a.sync();
    }
    expect(a.contact('BOB')!.verifiedAt).toBe(quando);

    await a.close();
    await b.close();
  });
});
