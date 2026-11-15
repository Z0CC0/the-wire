// Il QR, disegnato come SVG.
//
// Serve al codice che collega un dispositivo: seicentocinquanta caratteri che
// contengono una chiave privata non si dettano e non si mandano per email, si
// inquadrano. Sta qui e non nella finestra perche' la libreria che calcola la
// matrice e' di Node.

import { create as creaMatrice } from 'qrcode/lib/core/qrcode.js';

export function qrSvg(testo: string, lato = 260): string {
  const { modules } = creaMatrice(testo, { errorCorrectionLevel: 'M' }) as {
    modules: { size: number; data: ArrayLike<number> };
  };
  const n = modules.size;
  // Quattro moduli di bordo: e' il "quiet zone" che chiede la specifica QR.
  // Con meno, alcuni lettori di telefono faticano o rinunciano.
  const bordo = 4;
  const totale = n + bordo * 2;
  const pezzi: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.data[y * n + x]) pezzi.push(`M${x + bordo} ${y + bordo}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${lato}" height="${lato}" ` +
    `viewBox="0 0 ${totale} ${totale}" shape-rendering="crispEdges">` +
    `<rect width="${totale}" height="${totale}" fill="#fff"/>` +
    `<path d="${pezzi.join('')}" fill="#000"/></svg>`
  );
}
