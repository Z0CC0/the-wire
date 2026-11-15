// Un messaggio che non si e' potuto trattare NON deve essere dato per visto.
//
// Il registro di cio' che e' arrivato serve a non processare due volte la
// stessa busta. Segnarla prima di averla aperta significa buttarla: se il
// mittente non era ancora in rubrica, o la sessione non era pronta, quel
// messaggio non torna piu' indietro. E da quando il registro e' su disco, non
// torna nemmeno riavviando.

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
  const d = await mkdtemp(join(tmpdir(), 'wire-cons-'));
  dirs.push(d);
  return d;
}

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('consegna', () => {
  it('il messaggio arrivato PRIMA di aggiungere il contatto non va perso', async () => {
    const dirA = await cartella();
    const dirB = await cartella();
    const a = await Account.create(PASS, dirA);
    const b = await Account.create(PASS, dirB);

    // Alice conosce Bob e gli scrive. Bob non ha ancora aggiunto Alice.
    await a.addContact(b.uri, 'BOB');
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });
    await a.sendText(a.contact('BOB')!, 'ti ho scritto prima che mi aggiungessi');

    // Bob ritira: non sa chi sia Alice, quindi non puo' trattarlo.
    expect(await b.sync()).toHaveLength(0);

    // Ora Bob aggiunge Alice e ritira di nuovo: il messaggio deve arrivare.
    await b.addContact(a.uri, 'ALICE');
    const arrivati = await b.sync();
    expect(arrivati.map((m) => m.text)).toEqual(['ti ho scritto prima che mi aggiungessi']);

    await a.close();
    await b.close();
  });

  it('non si ripresenta una volta trattato', async () => {
    const dirA = await cartella();
    const dirB = await cartella();
    const a = await Account.create(PASS, dirA);
    const b = await Account.create(PASS, dirB);
    await a.addContact(b.uri, 'BOB');
    await b.addContact(a.uri, 'ALICE');
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });

    await a.sendText(a.contact('BOB')!, 'una volta sola');
    expect(await b.sync()).toHaveLength(1);
    expect(await b.sync()).toHaveLength(0);
    expect(await b.historyWith(b.contact('ALICE')!)).toHaveLength(1);

    await a.close();
    await b.close();
  });

  it('aggiungere un contatto fa riguardare indietro nella mailbox', async () => {
    const dirB = await cartella();
    const b = await Account.create(PASS, dirB);
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });
    await b.sync(); // il punto di ripresa avanza a "adesso"

    const dirA = await cartella();
    const a = await Account.create(PASS, dirA);
    await a.addContact(b.uri, 'BOB');
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
    await a.sendText(a.contact('BOB')!, 'arrivato mentre non ti conoscevo');

    await b.sync(); // non lo puo' trattare: Alice e' sconosciuta
    await b.addContact(a.uri, 'ALICE');
    // Il punto di ripresa non deve impedire di ritrovare quella busta.
    expect((await b.sync()).map((m) => m.text)).toEqual(['arrivato mentre non ti conoscevo']);

    await a.close();
    await b.close();
  });
});
