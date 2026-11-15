// I punti d'ingresso del programma.
//
// Questo test esiste per un difetto vero: `apps/desktop/package.json` puntava
// ancora all'uscita di `tsc`, che in questo progetto e' un modulo ES. Il
// programma vero e' il bundle CommonJS, e caricare l'altro fa morire Electron
// al primo `__dirname` con "ReferenceError: __dirname is not defined in ES
// module scope" — un errore che non compare mai finche' si costruisce il
// pacchetto, e compare subito a chi lancia la finestra dai sorgenti.
//
// Il controllo e' banale ma copre esattamente il caso che e' sfuggito: un
// punto d'ingresso ESM in un progetto il cui codice si aspetta CommonJS.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const radice = join(import.meta.dirname, '..', '..', '..');

function leggi(percorso: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(radice, percorso), 'utf8')) as Record<string, unknown>;
}

describe('punti d avvio', () => {
  it('entrambi i package.json puntano al bundle CommonJS', () => {
    for (const percorso of ['package.json', join('apps', 'desktop', 'package.json')]) {
      const main = leggi(percorso)['main'];
      expect(main, `${percorso} non dichiara un main`).toBeTypeOf('string');
      // `.cjs` e' quello che conta: con "type": "module" un file `.js` viene
      // trattato come modulo ES, e li' `__dirname` non esiste.
      expect(String(main), `${percorso} deve puntare a un file .cjs`).toMatch(/\.cjs$/);
      expect(String(main), `${percorso} non deve puntare all'uscita di tsc`).not.toContain('dist/');
    }
  });

  it('lo script che avvia la finestra costruisce il bundle prima', () => {
    const scripts = leggi('package.json')['scripts'] as Record<string, string>;
    // Senza `pack` prima, `electron .` troverebbe un bundle vecchio o nessuno.
    expect(scripts['desktop']).toContain('pack');
  });

  it('il binario di Electron viene scaricato esplicitamente', () => {
    const scripts = leggi('package.json')['scripts'] as Record<string, string>;
    // Da Electron 42 il pacchetto non ha piu' un postinstall suo: senza questa
    // riga `npm install` finisce senza errori e lascia il progetto senza
    // Electron, quindi niente si avvia e niente si costruisce.
    expect(scripts['postinstall']).toContain('install-electron');
  });
});
