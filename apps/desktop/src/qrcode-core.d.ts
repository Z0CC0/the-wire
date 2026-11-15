// Il pacchetto `qrcode` non dichiara i suoi moduli interni: qui si descrive
// solo il pezzo che usiamo davvero, il generatore della matrice.
declare module 'qrcode/lib/core/qrcode.js' {
  export function create(
    data: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }
  ): { modules: { size: number; data: Uint8Array } };
}
