// Il codice di collegamento deve stare in un QR che una fotocamera legge.
//
// Non e' scontato: il codice e' 657 caratteri e ne esce un QR da 89 moduli, che
// e' vicino al limite di cio' che si legge da un fotogramma ridotto. Se un
// giorno il codice si allunga — un campo in piu' nella card, un dispositivo in
// piu' — il QR cresce e a un certo punto il telefono smette di leggerlo,
// restando davanti al codice senza che succeda niente. Questo test se ne
// accorge qui invece che in mano a chi collega un telefono.

import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { create as creaMatrice } from 'qrcode/lib/core/qrcode.js';
import { cardOf, codiceFromUri, codiceToUri, creaChiaveAccount, createIdentity, nuovoCodice } from '@wire/core';

/** La stessa riduzione che fa `inquadraCodice()` in `ui/app.js`. */
const LATO_TELA = 720;

/** Il QR disegnato dentro un fotogramma, come lo vedrebbe la fotocamera. */
function fotogramma(uri: string, tela: number, quota: number): { px: Uint8ClampedArray; moduli: number } {
  const m = creaMatrice(uri, { errorCorrectionLevel: 'L' }) as { modules: { size: number; get(x: number, y: number): boolean } };
  const lato = m.modules.size;
  const pxModulo = Math.max(1, Math.floor((tela * quota) / lato));
  const bordo = Math.round((tela - lato * pxModulo) / 2);
  const px = new Uint8ClampedArray(tela * tela * 4).fill(255);
  for (let y = 0; y < lato; y++) {
    for (let x = 0; x < lato; x++) {
      if (!m.modules.get(x, y)) continue;
      for (let dy = 0; dy < pxModulo; dy++) {
        for (let dx = 0; dx < pxModulo; dx++) {
          const i = ((bordo + y * pxModulo + dy) * tela + bordo + x * pxModulo + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return { px, moduli: lato };
}

/** Sfocatura e rumore: una fotocamera vera non consegna pixel netti. */
function comeUnaFotocamera(px: Uint8ClampedArray, tela: number): Uint8ClampedArray {
  const fuori = new Uint8ClampedArray(px);
  for (let y = 1; y < tela - 1; y++) {
    for (let x = 1; x < tela - 1; x++) {
      let somma = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) somma += px[((y + dy) * tela + x + dx) * 4]!;
      // Rumore deciso dalla posizione invece che a caso: un test che passa o
      // fallisce a seconda del giorno non serve a niente.
      const v = Math.max(0, Math.min(255, Math.round(somma / 9) + ((x * 7919 + y * 104729) % 41) - 20));
      const i = (y * tela + x) * 4;
      fuori[i] = fuori[i + 1] = fuori[i + 2] = v;
    }
  }
  return fuori;
}

function unCodice(): string {
  return codiceToUri(nuovoCodice(creaChiaveAccount().secret, cardOf(createIdentity())));
}

describe('il QR del collegamento', () => {
  it('si legge da un fotogramma sfocato, anche se occupa meta inquadratura', () => {
    const uri = unCodice();
    for (const quota of [0.5, 0.7, 0.9]) {
      const { px } = fotogramma(uri, LATO_TELA, quota);
      const letto = jsQR(comeUnaFotocamera(px, LATO_TELA), LATO_TELA, LATO_TELA, { inversionAttempts: 'attemptBoth' });
      expect(letto?.data, `QR al ${quota * 100}% dell inquadratura`).toBe(uri);
    }
  });

  it('resta sotto i 100 moduli: oltre, la fotocamera fatica', () => {
    const { moduli } = fotogramma(unCodice(), LATO_TELA, 0.7);
    expect(moduli).toBeLessThanOrEqual(97);
  });

  it('quello che si legge si riapre come codice', () => {
    const uri = unCodice();
    const { px } = fotogramma(uri, LATO_TELA, 0.7);
    const letto = jsQR(px, LATO_TELA, LATO_TELA, { inversionAttempts: 'attemptBoth' });
    const codice = codiceFromUri(letto!.data);
    expect(codice.accountSecret).toHaveLength(32);
    expect(codice.card).toBeTruthy();
  });
});
