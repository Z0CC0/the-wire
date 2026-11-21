// Il backup: il deposito intero in un file, e il ripristino su un dispositivo vuoto.
//
// Da difendere: il file non contiene niente in chiaro; si riapre solo con la
// passphrase; dopo il ripristino rubrica, storico e file ci sono; le
// conversazioni ripartono con sessioni nuove e i messaggi passano in entrambi
// i versi; un ripristino sopra un deposito vivo viene rifiutato; un file che
// non e' un backup viene rifiutato prima di scrivere qualunque cosa.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex, te } from '../src/codec.js';
import { impacchetta, nomeFileBackup, spacchetta } from '../src/backup.js';
import { DepositoMemoria } from '../src/deposito.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];
async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-backup-'));
  dirs.push(d);
  return d;
}
beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function nuovo(): Promise<Account> {
  const a = await Account.create(PASS, await cartella());
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
  return a;
}

describe('il formato', () => {
  it('impacchetta e spacchetta, nomi e lunghezze comprese', () => {
    const voci = [
      { nome: 'wire.vault', dati: new Uint8Array([1, 2, 3]) },
      { nome: 'wire.history', dati: new Uint8Array(0) },
      { nome: 'file-abcdef12', dati: new Uint8Array([9]) },
    ];
    const b = spacchetta(impacchetta(voci, 12345));
    expect(b.creato).toBe(12345);
    expect(b.voci.map((v) => [v.nome, [...v.dati]])).toEqual(voci.map((v) => [v.nome, [...v.dati]]));
  });

  it('rifiuta cio che non e un backup, o e troncato, o ha nomi che non sono nomi', () => {
    expect(() => spacchetta(new Uint8Array(3))).toThrow(/non e un backup/);
    expect(() => spacchetta(te.encode('WIREBK'.padEnd(40, 'x')))).toThrow();
    const buono = impacchetta([{ nome: 'wire.vault', dati: new Uint8Array(10) }]);
    expect(() => spacchetta(buono.subarray(0, buono.length - 1))).toThrow(/troncato/);
    expect(() => impacchetta([{ nome: '../fuori', dati: new Uint8Array(1) }])).toThrow(/nome non valido/);
  });

  it('il nome proposto porta la data', () => {
    expect(nomeFileBackup(new Date(2026, 10, 21))).toBe('THE-WIRE-backup-2026-11-21.wirebk');
  });
});

describe('esporta e ripristina', () => {
  it('rubrica, storico e file tornano; le conversazioni ripartono in entrambi i versi', async () => {
    const alice = await nuovo();
    const bob = await nuovo();
    await alice.addContact(bob.uri, 'BOB');
    await bob.addContact(alice.uri, 'ALICE');
    await alice.sendText(alice.contact('BOB')!, 'prima del backup');
    await bob.sync();
    await alice.sendFile(alice.contact('BOB')!, 'nota.txt', 'text/plain', te.encode('contenuto del file'));
    await bob.sync();
    await bob.sync();
    await bob.sendText(bob.contact('ALICE')!, 'risposta');
    await alice.sync();

    const backup = await bob.esportaBackup();
    // Niente in chiaro: ne' il nome del contatto, ne' un testo, ne' il file.
    const testo = new TextDecoder('latin1').decode(backup);
    expect(testo).not.toContain('ALICE');
    expect(testo).not.toContain('prima del backup');
    expect(testo).not.toContain('contenuto del file');

    // Il computer di BOB sparisce. Su uno nuovo si rimette il backup.
    await bob.close();
    const nuovaCartella = await cartella();
    const esito = await Account.ripristinaBackup(backup, nuovaCartella);
    expect(esito.voci).toBe(3);
    await expect(Account.open('passphrase-sbagliata', nuovaCartella)).rejects.toThrow(/passphrase/);

    const bob2 = await Account.open(PASS, nuovaCartella);
    expect(bob2.id, 'stessa identita').toBe(bob.id);
    expect(bob2.contact('ALICE')).toBeDefined();
    const conv = await bob2.historyWith(bob2.contact('ALICE')!);
    expect(conv.map((m) => m.text)).toEqual(['prima del backup', '', 'risposta']);
    const file = conv.find((m) => m.file)!;
    expect(file.file!.stato).toBe('pronto');
    expect(new TextDecoder().decode(await bob2.fileBytes(file.file!.id))).toBe('contenuto del file');
    // Il segno del ripristino e' stato consumato, e si e' detto a chi guarda.
    expect((await readdir(nuovaCartella)).some((f) => f.includes('ripristino'))).toBe(false);
    expect((await bob2.tuttiMessaggi()).some((m) => m.system && /ripristinato/.test(m.text))).toBe(true);

    // Da qui: si scrive e si legge, con sessioni nuove.
    await bob2.connect(new MemoryMailbox(hex(bob2.identity.nostrPublic)), { live: false });
    await bob2.sendText(bob2.contact('ALICE')!, 'dopo il ripristino');
    const daAlice = await alice.sync();
    expect(daAlice.map((m) => m.text)).toContain('dopo il ripristino');
    await alice.sendText(alice.contact('BOB')!, 'ti leggo');
    const daBob = await bob2.sync();
    expect(daBob.map((m) => m.text)).toContain('ti leggo');

    await alice.close();
    await bob2.close();
  });

  it('un ripristino sopra un deposito vivo viene rifiutato', async () => {
    const a = await nuovo();
    const backup = await a.esportaBackup();
    await expect(Account.ripristinaBackup(backup, a.dataDir)).rejects.toThrow(/gia un deposito/);
    await a.close();
  });

  it('un file che non e un backup non scrive niente', async () => {
    const dep = new DepositoMemoria();
    await expect(Account.ripristinaSuDeposito(te.encode('non sono un backup'), dep)).rejects.toThrow();
    expect(await dep.esiste('wire.vault')).toBe(false);
    // Un backup senza il deposito delle chiavi: non serve a niente, e si dice.
    const senzaVault = impacchetta([{ nome: 'wire.history', dati: new Uint8Array(4) }]);
    await expect(Account.ripristinaSuDeposito(senzaVault, dep)).rejects.toThrow(/deposito delle chiavi/);
    expect(await dep.esiste('wire.history')).toBe(false);
  });

  it('nomi estranei nel backup non vengono scritti', async () => {
    const a = await nuovo();
    const buono = spacchetta(await a.esportaBackup());
    const conEstraneo = impacchetta([...buono.voci, { nome: 'qualcosa.exe', dati: new Uint8Array(3) }]);
    const dep = new DepositoMemoria();
    await Account.ripristinaSuDeposito(conEstraneo, dep);
    expect(await dep.esiste('wire.vault')).toBe(true);
    expect(await dep.esiste('qualcosa.exe')).toBe(false);
    await a.close();
  });
});
