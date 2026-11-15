// Il nome di un file che arriva dall'altra parte.
//
// Questo test esiste per un difetto vero, segnalato da un controllo di
// sicurezza esterno: nel codice c'era un commento che diceva che il nome
// veniva ripulito prima di finire su disco, e non era vero. Nessuno l'aveva
// verificato perche' nessun test lo guardava.
//
// E alla prima stesura della correzione ne e' sfuggito subito un altro: le
// barre ROVESCIATE passavano intatte — cioe' proprio il separatore di Windows,
// il sistema su cui questo programma gira di piu'. L'ha trovato questo test.

import { describe, expect, it } from 'vitest';
import { nomeFileSicuro } from '../src/nomefile.js';

/** La barra rovesciata si compone: scriverla dentro un letterale in un file
 *  che passa per piu' strumenti e' il modo migliore per perderla per strada. */
const BARRA = String.fromCharCode(92);

describe('nome di file sicuro', () => {
  it('un nome normale resta com e', () => {
    expect(nomeFileSicuro('foto.png')).toBe('foto.png');
    expect(nomeFileSicuro('relazione finale-2.pdf')).toBe('relazione finale-2.pdf');
  });

  it('i percorsi in stile Unix non passano', () => {
    const out = nomeFileSicuro('../../etc/passwd');
    expect(out).not.toContain('/');
    expect(out.startsWith('.')).toBe(false);
  });

  it('i percorsi in stile Windows non passano', () => {
    // E' il caso che era sfuggito alla prima correzione.
    const out = nomeFileSicuro('..' + BARRA + '..' + BARRA + 'Windows' + BARRA + 'system32' + BARRA + 'x.dll');
    expect(out).not.toContain(BARRA);
    expect(out.startsWith('.')).toBe(false);
  });

  it('un percorso di rete non passa', () => {
    const out = nomeFileSicuro(BARRA + BARRA + 'server' + BARRA + 'condivisa' + BARRA + 'x.txt');
    expect(out).not.toContain(BARRA);
  });

  it('il byte zero non tronca il nome', () => {
    // In molte librerie di sistema il byte zero chiude la stringa: un nome
    // come «innocuo.txt\0.exe» puo' diventare un eseguibile.
    const out = nomeFileSicuro('innocuo.txt' + String.fromCharCode(0) + '.exe');
    expect(out).not.toContain(String.fromCharCode(0));
    expect(out).toBe('innocuo.txt_.exe');
  });

  it('i caratteri che Windows rifiuta vengono sostituiti', () => {
    expect(nomeFileSicuro('a<b>c|d?e*f"g:h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  it('cio che resta vuoto diventa un nome comunque', () => {
    for (const niente of ['', '...', '///', BARRA + BARRA, '   ', null, undefined, 42]) {
      const out = nomeFileSicuro(niente as never);
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toContain('/');
      expect(out).not.toContain(BARRA);
    }
  });

  it('un nome lunghissimo viene accorciato', () => {
    expect(nomeFileSicuro('x'.repeat(5000)).length).toBe(200);
  });

  it('qualunque cosa arrivi, esce un nome innocuo', () => {
    // Rete di sicurezza: qualunque combinazione di caratteri cattivi, il
    // risultato non deve mai poter uscire dalla cartella scelta dall'utente.
    const pezzi = ['..', '/', BARRA, 'a', String.fromCharCode(0), ':', '*', '.', ' '];
    for (let i = 0; i < 400; i++) {
      let s = '';
      for (let j = 0; j < 6; j++) s += pezzi[(i * 7 + j * 3) % pezzi.length]!;
      const out = nomeFileSicuro(s);
      expect(out).not.toContain('/');
      expect(out).not.toContain(BARRA);
      expect(out.startsWith('.')).toBe(false);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('i nomi di periferica di Windows non restano tali', () => {
    // `CON`, `NUL`, `COM1`… su Windows non sono file: aprirli in scrittura non
    // crea niente. Scrivere su `NUL` butta via tutto in silenzio, e chi ha
    // ricevuto il file crede di averlo salvato. Vale anche con l'estensione.
    for (const brutto of ['CON', 'con', 'nul.png', 'NUL.TXT', 'com1', 'COM9.dat', 'lpt1', 'aux', 'PRN.pdf']) {
      expect(nomeFileSicuro(brutto).toLowerCase(), brutto).not.toMatch(
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/
      );
    }
  });

  it('i nomi normali che cominciano cosi restano intatti', () => {
    // Una regola troppo larga rovinerebbe nomi legittimi: `console.log` non e'
    // la periferica `con`.
    for (const buono of ['console.log', 'nullo.txt', 'communicato.pdf', 'auxiliary.png', 'printer.jpg']) {
      expect(nomeFileSicuro(buono)).toBe(buono);
    }
  });
});
