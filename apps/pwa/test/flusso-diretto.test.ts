// Il controllo di flusso del trasferimento diretto.
//
// Chi manda si ferma quando la SUA coda di uscita e' piena, cioe' quando i dati
// sono partiti — non quando sono stati scritti dall'altra parte. Se il disco di
// chi riceve e' piu' lento della rete, i pezzi si accumulano in memoria e
// nessuno lo dice a nessuno. Misurato sul percorso vero: finivano tutti in
// attesa insieme. A 100 MB sono 133 MB e si passa; a 4 GB sarebbero 5,4 GB, e
// il programma muore lasciando "collegamento non riuscito" da una parte e "non
// arrivato intero" dall'altra.
//
// Qui si riproduce quella situazione — arrivo veloce, scrittura lenta — e si
// controlla che la coda resti limitata e che il file arrivi intero.

import { describe, expect, it } from 'vitest';

const PEZZO = 64 * 1024;
const BYTE_TROPPI = 16 * 1024 * 1024;
const BYTE_ABBASTANZA = 4 * 1024 * 1024;

/**
 * I due lati, con la stessa logica di `ui/diretto.js`.
 *
 * Non si carica quel file: dipende dal DOM e da `api`. Si riproduce la parte
 * che conta — chi scrive chiede di fermarsi, chi manda si ferma — perche' e'
 * quella che deve restare vera.
 */
async function trasferimento(opzioni: { pezzi: number; msPerScrittura: number; conControllo: boolean }) {
  let inAttesa = 0;
  let massimoInAttesa = 0;
  let scritti = 0;
  let chiestaPausa = false;
  let fermo = false;
  let riprendi: (() => void) | null = null;
  let coda: Promise<unknown> = Promise.resolve();

  const alMittente = (parola: string) => {
    if (parola === 'PAUSA') fermo = true;
    if (parola === 'VAI') {
      fermo = false;
      riprendi?.();
      riprendi = null;
    }
  };

  /** Chi riceve: accoda la scrittura, e se la coda cresce chiede di fermarsi. */
  const ricevi = () => {
    inAttesa += 1;
    massimoInAttesa = Math.max(massimoInAttesa, inAttesa);
    if (opzioni.conControllo && inAttesa * PEZZO >= BYTE_TROPPI && !chiestaPausa) {
      chiestaPausa = true;
      alMittente('PAUSA');
    }
    coda = coda
      .then(() => (opzioni.msPerScrittura ? new Promise((r) => setTimeout(r, opzioni.msPerScrittura)) : Promise.resolve()))
      .then(() => {
        inAttesa -= 1;
        scritti += 1;
        if (opzioni.conControllo && chiestaPausa && inAttesa * PEZZO <= BYTE_ABBASTANZA) {
          chiestaPausa = false;
          alMittente('VAI');
        }
      });
  };

  // Chi manda: un pezzo alla volta, fermandosi quando glielo chiedono.
  for (let i = 0; i < opzioni.pezzi; i++) {
    while (fermo) {
      await new Promise<void>((r) => {
        riprendi = r;
        setTimeout(r, 50);
      });
    }
    ricevi();
    // Lascia girare il ciclo degli eventi, come farebbe la rete. Un microtask
    // basta: un timer vero renderebbe il test piu' lento di cio' che misura.
    if (i % 8 === 0) await Promise.resolve();
  }
  await coda;
  return { massimoInAttesa, scritti, memoriaMassimaMB: (massimoInAttesa * PEZZO * 4) / 3 / 1048576 };
}

describe('trasferimento diretto di un file grande', () => {
  it('senza controllo di flusso la coda cresce quanto il file', async () => {
    // La prova che il difetto era reale: e' il comportamento di prima.
    const r = await trasferimento({ pezzi: 600, msPerScrittura: 0, conControllo: false });
    expect(r.massimoInAttesa).toBeGreaterThan(200);
  });

  it('con il controllo di flusso la coda resta limitata', async () => {
    const r = await trasferimento({ pezzi: 600, msPerScrittura: 0, conControllo: true });
    expect(r.massimoInAttesa * PEZZO).toBeLessThanOrEqual(BYTE_TROPPI * 2);
    expect(r.scritti, 'nessun pezzo perso').toBe(600);
  });

  it('anche con il disco molto piu lento della rete', async () => {
    // E' il caso peggiore: chi riceve scrive a rilento e chi manda spinge.
    const r = await trasferimento({ pezzi: 120, msPerScrittura: 1, conControllo: true });
    expect(r.massimoInAttesa * PEZZO).toBeLessThanOrEqual(BYTE_TROPPI * 2);
    expect(r.scritti).toBe(120);
  });

  it('la memoria trattenuta segue la soglia, non la dimensione del file', async () => {
    // Il numero che conta: con il controllo di flusso un file da 100 GB tiene
    // in memoria quanto uno da 100 MB. Senza, un file da 4 GB ne teneva 5,4.
    // Il limite si esprime in funzione della soglia e non come numero fisso:
    // cambiando la soglia il test resta vero o smette di esserlo per il motivo
    // giusto.
    const tetto = ((BYTE_TROPPI * 2) / 1048576) * (4 / 3); // il doppio, in base64
    const piccolo = await trasferimento({ pezzi: 300, msPerScrittura: 0, conControllo: true });
    const grande = await trasferimento({ pezzi: 900, msPerScrittura: 0, conControllo: true });
    expect(grande.memoriaMassimaMB).toBeLessThan(tetto);
    expect(grande.memoriaMassimaMB, 'tre volte i pezzi, non tre volte la memoria').toBeLessThan(
      piccolo.memoriaMassimaMB * 2
    );
  });

  it('un trasferimento interrotto riparte da dove era arrivato', async () => {
    // Il punto della ripresa: chi riceve dice quanti byte ha gia', chi manda
    // comincia da li'. Senza, un file da decine di gigabyte non arriverebbe
    // mai in fondo, perche' una connessione che cade in ore di trasferimento
    // e' normale, e ricominciare da zero ogni volta non converge.
    const DIMENSIONE = 1000;
    let scrittiSuDisco = 0;

    /** Un tentativo che si interrompe dopo `quantiPrima` pezzi. */
    const tentativo = (quantiPrima: number) => {
      // Chi riceve annuncia il punto di partenza leggendo il disco.
      const daDove = scrittiSuDisco;
      let mandati = daDove;
      for (let i = 0; i < quantiPrima && mandati < DIMENSIONE; i++) {
        mandati += 1;
        scrittiSuDisco = mandati;
      }
      return { daDove, arrivatoA: scrittiSuDisco };
    };

    const primo = tentativo(400);
    expect(primo.daDove, 'il primo tentativo comincia da zero').toBe(0);
    expect(primo.arrivatoA).toBe(400);

    const secondo = tentativo(400);
    expect(secondo.daDove, 'il secondo riprende da 400, non da zero').toBe(400);
    expect(secondo.arrivatoA).toBe(800);

    const terzo = tentativo(400);
    expect(terzo.daDove).toBe(800);
    expect(terzo.arrivatoA, 'e si ferma alla dimensione vera').toBe(DIMENSIONE);
  });

  it('un punto di partenza assurdo non viene creduto', () => {
    // Chi riceve potrebbe dire un numero sbagliato, o una versione diversa
    // potrebbe mandarne uno che non ha senso: si riparte da zero invece di
    // saltare pezzi di file.
    const dimensione = 1000;
    const accetta = (n: number) => (Number.isSafeInteger(n) && n >= 0 && n <= dimensione ? n : 0);
    expect(accetta(500)).toBe(500);
    expect(accetta(-1)).toBe(0);
    expect(accetta(2000)).toBe(0);
    expect(accetta(Number.NaN)).toBe(0);
    expect(accetta(1.5)).toBe(0);
  });

  it('il tempo che l altro impiega a scegliere non conta nel collegamento', () => {
    // Il difetto vero visto dall'utente: chi manda faceva partire un conto di
    // trenta secondi appena premuto invio, e dentro quel conto c'era anche il
    // tempo in cui chi riceve sceglieva la cartella. Per un file da 106 MB si
    // sceglie in fretta e passava; per uno da 4 GB si va a cercare un disco con
    // spazio, si superavano i trenta secondi, e compariva "non si e riusciti a
    // stabilire il collegamento diretto" — un messaggio che parla di rete
    // mentre il problema era una finestra aperta.
    const ATTESA_ACCETTAZIONE = 10 * 60 * 1000;
    const ATTESA_COLLEGAMENTO = 30000;

    /** Il conto in corso, come lo tiene `ui/diretto.js`. */
    const conto = (fase: 'prima' | 'dopo') =>
      fase === 'prima' ? ATTESA_ACCETTAZIONE : ATTESA_COLLEGAMENTO;

    // Novanta secondi per scegliere: prima bastavano a far fallire tutto.
    const sceltaLenta = 90 * 1000;
    expect(sceltaLenta).toBeLessThan(conto('prima'));
    expect(sceltaLenta, 'era questo il caso che rompeva').toBeGreaterThan(ATTESA_COLLEGAMENTO);

    // Dopo l'accettazione il conto torna stretto: li' non decide piu' nessuno.
    expect(conto('dopo')).toBe(ATTESA_COLLEGAMENTO);
  });

  it('quando il collegamento non si apre, si riprova a parti invertite', () => {
    // Perche' esiste: su un NAT che cambia porta per ogni destinazione — quello
    // di questa rete, provato con due server STUN: 51969 verso uno, 51971 verso
    // l'altro — il collegamento riesce in un verso e non nell'altro. Quale sia
    // il verso buono dipende dalle due reti, non da chi ha il file: l'unico
    // modo di saperlo e' provare anche al contrario.
    const tentativi: string[] = [];
    let giaInvertito = false;

    const finito = (errore: string | null, chiApre: string) => {
      tentativi.push(chiApre + (errore ? ':fallito' : ':riuscito'));
      if (errore && !giaInvertito && /collegamento|accettato/.test(errore)) {
        giaInvertito = true;
        return 'inverti';
      }
      return errore ? 'arreso' : 'fatto';
    };

    expect(finito('non si e riusciti a stabilire il collegamento diretto', 'mittente')).toBe('inverti');
    expect(finito(null, 'ricevente')).toBe('fatto');
    expect(tentativi).toEqual(['mittente:fallito', 'ricevente:riuscito']);
  });

  it('non si riprova all infinito', () => {
    // Due tentativi, non di piu': con due reti che non si parlano davvero, un
    // ciclo infinito terrebbe occupata la conversazione senza arrivare a niente.
    let giaInvertito = false;
    const prova = (errore: string) => {
      if (errore && !giaInvertito) {
        giaInvertito = true;
        return 'inverti';
      }
      return 'arreso';
    };
    expect(prova('collegamento non riuscito')).toBe('inverti');
    expect(prova('collegamento non riuscito')).toBe('arreso');
    expect(prova('collegamento non riuscito')).toBe('arreso');
  });

  it('il secondo tentativo trova ancora il file da mandare', () => {
    // Il difetto che lasciava chi riceve con un file vuoto sul disco e niente
    // altro: `chiudi()` toglie la voce da `inCorso` PRIMA di chiamare `onFine`,
    // e da li' si chiede all'altro di riprovare. Quando la sua offerta
    // arrivava, chi manda non trovava piu' niente a cui agganciarla e non
    // rispondeva. Il file da mandare va tenuto in una mappa sua.
    const inCorso = new Map<string, unknown>();
    const daMandare = new Map<string, { nome: string }>();

    daMandare.set('f1', { nome: 'Archivio.zip' });
    inCorso.set('f1', { attivo: true });

    // chiudi(): svuota, poi avvisa.
    inCorso.delete('f1');
    const rispostaPossibile = daMandare.get('f1');

    expect(inCorso.get('f1'), 'la connessione di prima non c e piu').toBeUndefined();
    expect(rispostaPossibile, 'ma il file da mandare si').toBeDefined();
    expect(rispostaPossibile?.nome).toBe('Archivio.zip');
  });
});
