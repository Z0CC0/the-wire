// Il deposito: lo stesso contratto, due implementazioni.
//
// Da quando il cuore gira anche in un browser, non sa piu' se sta scrivendo su
// un disco o dentro IndexedDB: chiede a un deposito. Se le due implementazioni
// si comportano diversamente anche solo su un caso limite, l'app funziona su un
// computer e sbaglia su un telefono — e quel genere di differenza si scopre
// tardi, in mano a qualcun altro.
//
// Per questo i test sono scritti UNA volta e passati a entrambe. Quella
// IndexedDB non si prova qui, perche' in Node non esiste; si prova nel browser.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DepositoMemoria, chiaveValida, type Deposito } from '../src/deposito.js';
import { DepositoFile, cartellaPredefinita } from '../src/deposito-file.js';
import { readdir } from 'node:fs/promises';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function suDisco(): Promise<Deposito> {
  const d = await mkdtemp(join(tmpdir(), 'wire-dep-'));
  dirs.push(d);
  return new DepositoFile(d);
}

const implementazioni: [string, () => Promise<Deposito>][] = [
  ['in memoria', async () => new DepositoMemoria()],
  ['su disco', suDisco],
];

describe.each(implementazioni)('deposito %s', (_nome, crea) => {
  it('quello che non c e vale null, non un errore', async () => {
    const d = await crea();
    expect(await d.leggi('mai-scritto')).toBeNull();
    expect(await d.esiste('mai-scritto')).toBe(false);
  });

  it('scrivi e rileggi restituisce gli stessi byte', async () => {
    const d = await crea();
    const dati = new Uint8Array([0, 1, 250, 255, 7]);
    await d.scrivi('cosa', dati);
    expect([...(await d.leggi('cosa'))!]).toEqual([...dati]);
    expect(await d.esiste('cosa')).toBe(true);
  });

  it('riscrivere sostituisce, non accoda', async () => {
    const d = await crea();
    await d.scrivi('cosa', new Uint8Array([1, 2, 3]));
    await d.scrivi('cosa', new Uint8Array([9]));
    expect([...(await d.leggi('cosa'))!]).toEqual([9]);
  });

  it('accodare su cio che non esiste equivale a scrivere', async () => {
    const d = await crea();
    await d.accoda('nuovo', new Uint8Array([4, 5]));
    expect([...(await d.leggi('nuovo'))!]).toEqual([4, 5]);
  });

  it('accodare mette in coda, nell ordine', async () => {
    const d = await crea();
    await d.accoda('registro', new Uint8Array([1]));
    await d.accoda('registro', new Uint8Array([2, 3]));
    await d.accoda('registro', new Uint8Array([4]));
    expect([...(await d.leggi('registro'))!]).toEqual([1, 2, 3, 4]);
  });

  it('eliminare toglie, ed eliminare due volte non e un errore', async () => {
    const d = await crea();
    await d.scrivi('cosa', new Uint8Array([1]));
    await d.elimina('cosa');
    expect(await d.esiste('cosa')).toBe(false);
    await d.elimina('cosa');
  });

  it('una vista su un buffer piu grande non si salva per intero', async () => {
    const d = await crea();
    // `subarray` guarda dentro un buffer piu' grande senza copiarlo: chi salva
    // il buffer invece della vista si porta dietro anche cio' che non c'entra.
    const grande = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    await d.scrivi('fetta', grande.subarray(2, 5));
    expect([...(await d.leggi('fetta'))!]).toEqual([1, 2, 3]);
  });

  it('i nomi con percorsi dentro non passano', async () => {
    const d = await crea();
    // Un identificativo che arriva dall'altra parte non deve poter decidere
    // dove si scrive.
    for (const cattivo of ['../fuori', 'a/b', '..', '.', 'con spazio', '']) {
      await expect(d.scrivi(cattivo, new Uint8Array([1]))).rejects.toThrow();
      await expect(d.leggi(cattivo)).rejects.toThrow();
    }
  });
});

describe('nomi accettati', () => {
  it('accetta cio che il programma usa davvero', () => {
    for (const buono of ['wire.vault', 'wire.history', 'file-0123abcdef', 'a', 'A_b-c.1']) {
      expect(chiaveValida(buono)).toBe(buono);
    }
  });

  it('rifiuta i nomi troppo lunghi', () => {
    expect(() => chiaveValida('a'.repeat(129))).toThrow();
  });
});

describe('deposito su disco: cosa resta dopo una scrittura', () => {
  it('non lascia file temporanei accanto a quello vero', async () => {
    const d = await mkdtemp(join(tmpdir(), 'wire-dep-'));
    dirs.push(d);
    const dep = new DepositoFile(d);
    await dep.scrivi('wire.vault', Uint8Array.of(1, 2, 3));
    await dep.scrivi('wire.vault', Uint8Array.of(4, 5, 6, 7));
    expect(await readdir(d)).toEqual(['wire.vault']);
    expect(Array.from((await dep.leggi('wire.vault'))!)).toEqual([4, 5, 6, 7]);
  });

  it('due scritture nello stesso istante non falliscono, e resta l ultima', async () => {
    // Visto davvero: un nome cambiato e una verifica chiesti insieme facevano
    // fallire la seconda rinomina con ENOENT, perche' il temporaneo era uno
    // solo e la prima lo aveva gia' spostato.
    const d = await mkdtemp(join(tmpdir(), 'wire-dep-'));
    dirs.push(d);
    const dep = new DepositoFile(d);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => dep.scrivi('wire.vault', Uint8Array.of(i)))
    );
    expect(Array.from((await dep.leggi('wire.vault'))!)).toEqual([11]);
    expect(await readdir(d)).toEqual(['wire.vault']);
  });
});

describe('dove stanno i dati', () => {
  it('THE_WIRE_DATI sposta la cartella per intero', () => {
    const prima = process.env['THE_WIRE_DATI'];
    try {
      process.env['THE_WIRE_DATI'] = join(tmpdir(), 'wire-altrove');
      expect(cartellaPredefinita()).toBe(join(tmpdir(), 'wire-altrove'));
      process.env['THE_WIRE_DATI'] = '   ';
      expect(cartellaPredefinita()).not.toBe('   ');
      expect(cartellaPredefinita()).toMatch(/THE WIRE 2|the-wire-2/);
    } finally {
      if (prima === undefined) delete process.env['THE_WIRE_DATI'];
      else process.env['THE_WIRE_DATI'] = prima;
    }
  });
});
