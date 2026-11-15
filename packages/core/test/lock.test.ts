// Un solo programma alla volta sul deposito.
//
// Il danno che si previene non e' un file corrotto: sono messaggi che non
// arrivano piu', perche' due copie dello stesso ratchet bruciano gli stessi
// numeri e il destinatario li rifiuta per sempre.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { LOCK_FILE, VaultInUso, VaultLock } from '../src/lock.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-lock-'));
  dirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('lock del deposito', () => {
  it('due account sulla stessa cartella: il secondo si ferma', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await expect(Account.open(PASS, dir)).rejects.toThrow(VaultInUso);
    await a.close();
  });

  it('dopo la chiusura il deposito si riapre', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await a.close();
    const b = await Account.open(PASS, dir);
    expect(b.address).toBe(a.address);
    await b.close();
  });

  it('il file del lock sparisce alla chiusura', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    await a.close();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('il messaggio dice dove sta il file, per poterlo togliere a mano', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await expect(Account.open(PASS, dir)).rejects.toThrow(new RegExp(LOCK_FILE));
    await a.close();
  });

  it('un lock lasciato da un programma morto non blocca nessuno', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await a.close();

    // Un processo finito male lascia il file. Il pid 999999 non esiste:
    // deve essere riconosciuto come spazzatura, non come occupante.
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 999999, host: hostname(), at: Date.now() }));
    const b = await Account.open(PASS, dir);
    expect(b.address).toBe(a.address);
    await b.close();
  });

  it('un lock di un altro computer si rispetta, vivo o morto che sia', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await a.close();

    // Deposito su cartella condivisa: di un pid altrui non sappiamo niente.
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 999999, host: 'un-altro-pc', at: Date.now() }));
    await expect(Account.open(PASS, dir)).rejects.toThrow(VaultInUso);
    await rm(join(dir, LOCK_FILE));
  });

  it('un lock illeggibile non viene scavalcato', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await a.close();

    await writeFile(join(dir, LOCK_FILE), 'non e json');
    await expect(Account.open(PASS, dir)).rejects.toThrow(VaultInUso);
    await rm(join(dir, LOCK_FILE));
  });

  it('passphrase sbagliata: il deposito resta libero', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await a.close();

    await expect(Account.open('un-altra-passphrase', dir)).rejects.toThrow(/passphrase errata/);
    // Se il lock fosse rimasto appeso, questo fallirebbe.
    const b = await Account.open(PASS, dir);
    await b.close();
  });

  it('create su un deposito che esiste gia: nessun lock appeso', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await a.close();

    await expect(Account.create(PASS, dir)).rejects.toThrow();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('non si rilascia il lock di qualcun altro', async () => {
    const dir = await cartella();
    const lock = await VaultLock.acquire(dir);

    // Qualcun altro sovrascrive il file col proprio pid.
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 999999, host: hostname(), at: Date.now() }));
    await lock.release();

    // Il file dell'altro deve essere ancora li'.
    const dentro = JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8')) as { pid: number };
    expect(dentro.pid).toBe(999999);
    await rm(join(dir, LOCK_FILE));
  });

  it('cartelle diverse non si disturbano', async () => {
    const a = await Account.create(PASS, await cartella());
    const b = await Account.create(PASS, await cartella());
    expect(a.address).not.toBe(b.address);
    await a.close();
    await b.close();
  });
});
