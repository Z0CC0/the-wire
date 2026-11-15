// Un nome di file, non un percorso.
//
// Il nome di un file arriva dall'altra parte, e finisce nella finestra di
// salvataggio del sistema: `../../qualcosa` la porterebbe dove non deve.
//
// Questa funzione e' nata da un controllo di sicurezza esterno. Nel codice
// c'era un commento che diceva che qualcuno ripuliva il nome piu' avanti; non
// era vero, e nessuno l'aveva verificato. Ora la pulizia esiste, sta in un
// posto solo, ed e' coperta da test — compreso il caso che alla prima stesura
// mi era sfuggito: le barre ROVESCIATE, cioe' il separatore di Windows.

/** Massimo ragionevole per un nome di file su tutti e tre i sistemi. */
const MAX = 200;

export function nomeFileSicuro(nome: unknown): string {
  const pulito = String(nome ?? '')
    // Tutti e due i separatori: quello di Unix e quello di Windows.
    .replace(/[\\/]/g, '_')
    // Punti iniziali: tolgono `..` e i file nascosti creati senza volerlo.
    .replace(/^\.+/, '')
    // Caratteri che Windows rifiuta nei nomi, piu' quelli di controllo — fra
    // cui il byte zero, che tronca il nome in molte librerie di sistema.
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, MAX)
    // Nomi che su Windows non sono file ma periferiche: `CON`, `NUL`, `COM1`…
    // Aprirli in scrittura non da' un file, da' un comportamento strano —
    // scrivere su `NUL` butta via tutto in silenzio, e l'utente crede di aver
    // salvato. Vale anche con l'estensione: `nul.png` e' sempre la periferica.
    // Un trattino basso davanti li rende nomi normali.
    .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '_$1$2');
  // Un nome vuoto farebbe aprire la finestra di salvataggio su una cartella
  // invece che su un file.
  return pulito || 'file';
}
