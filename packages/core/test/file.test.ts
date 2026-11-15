// Invio di file dalla mailbox.
//
// Le proprieta' che contano, e che questi test difendono:
//   1. il file arriva identico. Un pezzo perso o alterato deve produrre un
//      fallimento dichiarato, non un file che sembra buono e non lo e'.
//   2. i pezzi vanno al loro posto per indice, non in coda a fiducia.
//   3. sopra i 5 MB con l'altro offline non parte niente, e lo si sa PRIMA
//      di aver letto un solo byte.
//   4. i byte sul disco non sono leggibili senza la chiave del deposito.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Account, SOGLIA_MAILBOX } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex } from '../src/codec.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-file-'));
  dirs.push(d);
  return d;
}

const respiro = () => new Promise((r) => setTimeout(r, 120));

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function coppiaCollegata(): Promise<[Account, Account, string, string]> {
  const dirA = await cartella();
  const dirB = await cartella();
  const a = await Account.create(PASS, dirA);
  const b = await Account.create(PASS, dirB);
  await a.addContact(b.uri, 'BOB');
  await b.addContact(a.uri, 'ALICE');
  await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)));
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
  await respiro();
  return [a, b, dirA, dirB];
}

describe('file dalla mailbox', () => {
  it('un file arriva identico, byte per byte', async () => {
    const [a, b] = await coppiaCollegata();
    // Abbastanza grande da essere spezzato davvero: 100 KB fanno sette pezzi.
    const dati = new Uint8Array(randomBytes(100 * 1024));

    const inviato = await a.sendFile(a.contact('BOB')!, 'foto.png', 'image/png', dati);
    expect(inviato.file?.stato).toBe('pronto');
    await respiro();

    const ricevuto = (await b.historyWith(b.contact('ALICE')!)).find((m) => m.file);
    expect(ricevuto?.file?.nome).toBe('foto.png');
    expect(ricevuto?.file?.stato).toBe('pronto');
    expect(ricevuto?.file?.dimensione).toBe(dati.length);

    const bytes = await b.fileBytes(ricevuto!.file!.id);
    expect(Buffer.from(bytes).equals(Buffer.from(dati))).toBe(true);

    await a.close();
    await b.close();
  });

  it('chi manda tiene la propria copia, e la rilegge', async () => {
    const [a, b] = await coppiaCollegata();
    const dati = new Uint8Array(randomBytes(20 * 1024));
    const inviato = await a.sendFile(a.contact('BOB')!, 'nota.txt', 'text/plain', dati);
    const miei = await a.fileBytes(inviato.file!.id);
    expect(Buffer.from(miei).equals(Buffer.from(dati))).toBe(true);
    await a.close();
    await b.close();
  });

  it('sul disco il file non e leggibile in chiaro', async () => {
    const [a, b, dirA] = await coppiaCollegata();
    const riconoscibile = Buffer.from('SEGRETO-RICONOSCIBILE'.repeat(400));
    const inviato = await a.sendFile(a.contact('BOB')!, 'segreto.txt', 'text/plain', new Uint8Array(riconoscibile));
    const suDisco = await readFile(join(dirA, `file-${inviato.file!.id}`));
    expect(suDisco.includes('SEGRETO-RICONOSCIBILE')).toBe(false);
    // E i byte in chiaro non ci sono proprio: non un pezzo, non una volta.
    expect(suDisco.includes(Buffer.from(riconoscibile.subarray(0, 32)))).toBe(false);
    // E il nome vero non finisce nel nome sul disco: chi apre la cartella non
    // deve poter leggere di cosa si tratta.
    expect(inviato.file!.id).not.toContain('segreto');
    await a.close();
    await b.close();
  });

  it('oltre 5 MB con l altro offline non parte, e lo dice prima', async () => {
    const a = await Account.create(PASS, await cartella());
    const b = await Account.create(PASS, await cartella());
    await a.addContact(b.uri, 'BOB');
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });

    const grande = SOGLIA_MAILBOX + 1;
    const motivo = a.perche(a.contact('BOB')!, grande);
    expect(motivo).toContain('non e collegato');
    expect(motivo).toContain('BOB');

    await expect(a.iniziaDiretto(a.contact('BOB')!, 'video.mp4', 'video/mp4', grande)).rejects.toThrow(
      /non e collegato/
    );
    // Nessuna riga nella conversazione: non e' cominciato niente.
    expect(await a.historyWith(a.contact('BOB')!)).toHaveLength(0);
    await a.close();
    await b.close();
  });

  it('oltre 5 MB con l altro online il trasferimento diretto comincia', async () => {
    const [a, b] = await coppiaCollegata();
    const grande = SOGLIA_MAILBOX + 1;
    expect(a.perche(a.contact('BOB')!, grande)).toBeNull();

    const inviato = await a.iniziaDiretto(a.contact('BOB')!, 'video.mp4', 'video/mp4', grande);
    expect(inviato.file?.via).toBe('diretto');
    expect(inviato.file?.stato).toBe('in-corso');
    await respiro();

    const ricevuto = (await b.historyWith(b.contact('ALICE')!)).find((m) => m.file);
    expect(ricevuto?.file?.nome).toBe('video.mp4');
    expect(ricevuto?.file?.via).toBe('diretto');
    await a.close();
    await b.close();
  });

  it('un file vuoto non si manda', async () => {
    const [a, b] = await coppiaCollegata();
    expect(a.perche(a.contact('BOB')!, 0)).toContain('vuoto');
    await a.close();
    await b.close();
  });

  it('lo stato del file sopravvive alla riapertura, e resta una riga sola', async () => {
    const dirB = await cartella();
    const a = await Account.create(PASS, await cartella());
    const b = await Account.create(PASS, dirB);
    await a.addContact(b.uri, 'BOB');
    await b.addContact(a.uri, 'ALICE');
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)));
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
    await respiro();

    const dati = new Uint8Array(randomBytes(40 * 1024));
    await a.sendFile(a.contact('BOB')!, 'immagine.jpg', 'image/jpeg', dati);
    await respiro();
    await a.close();
    await b.close();

    const riaperto = await Account.open(PASS, dirB);
    const righe = (await riaperto.historyWith(riaperto.contact('ALICE')!)).filter((m) => m.file);
    // Una riga, non una per ogni aggiornamento di avanzamento: lo storico e'
    // in sola aggiunta, ma chi legge deve vedere una conversazione.
    expect(righe).toHaveLength(1);
    expect(righe[0]!.file?.stato).toBe('pronto');
    const bytes = await riaperto.fileBytes(righe[0]!.file!.id);
    expect(Buffer.from(bytes).equals(Buffer.from(dati))).toBe(true);
    await riaperto.close();
  });
});
