/**
 * Versa il file dentro un canale gia' aperto.
 *
 * Sta in una funzione sola perche' ci si arriva da due strade: il primo
 * tentativo, dove il collegamento lo apre chi manda, e il secondo a parti
 * invertite, dove lo apre chi riceve. Il file viaggia nello stesso verso in
 * tutti e due i casi — cambia solo chi ha bussato.
 */
function versaIlFile(pc, canale, f, fileId, messaggioId) {
  let confermato;
  const conferma = new Promise((r) => (confermato = r));
  // Chi riceve puo' chiedere di rallentare: la sua coda di scrittura non e'
  // infinita, e la nostra coda di uscita non sa niente della sua.
  let fermo = false;
  let riprendi = null;
  // Da dove cominciare lo decide chi riceve: e' lui che sa quanto ha gia' su
  // disco. Finche' non lo dice, non parte niente.
  let daDove = null;
  let saputo;
  const puntoDiPartenza = new Promise((r) => (saputo = r));
  canale.onmessage = (e) => {
    if (typeof e.data === 'string' && e.data.startsWith('DA:')) {
      const n = Number(e.data.slice(3));
      daDove = Number.isSafeInteger(n) && n >= 0 && n <= f.size ? n : 0;
      saputo(daDove);
      return;
    }
    if (e.data === 'OK') confermato(true);
    else if (e.data === 'PAUSA') fermo = true;
    else if (e.data === 'VAI') {
      fermo = false;
      riprendi?.();
      riprendi = null;
    }
  };

  // Se il canale e' gia' aperto quando arriviamo qui, `onopen` non scatta piu':
  // capita nel secondo tentativo, dove il canale lo crea l'altro e ci arriva
  // gia' pronto. Senza questo, il file non partirebbe e basta.
  const versa = async () => {
    // Quanto grande puo' essere un pezzo lo dice questa connessione, adesso.
    const pezzo = quantoGrande(pc);
    // Un aggiornamento della barra ogni ~1 MB, qualunque sia il pezzo.
    const ogni = Math.max(1, Math.round((1024 * 1024) / pezzo));
    let pezziMandati = 0;
    let inviati = 0;
    try {
      // Il punto di partenza arriva da chi riceve. Il tempo massimo evita di
      // restare fermi per sempre davanti a una versione che non lo manda: in
      // quel caso si riparte da zero, come si e' sempre fatto.
      inviati = await Promise.race([
        puntoDiPartenza,
        new Promise((r) => setTimeout(() => r(0), 10000)),
      ]);
      if (inviati > 0) aggiornaRiga(await api.avanzamentoDiretto(messaggioId, inviati));
      while (inviati < f.size) {
        // Se la coda e' piena si aspetta: scrivere comunque significherebbe
        // accumulare in memoria quello che la rete non riesce a portare via.
        if (canale.bufferedAmount > CODA_MASSIMA) {
          await new Promise((r) => {
            canale.bufferedAmountLowThreshold = CODA_MASSIMA / 2;
            canale.onbufferedamountlow = r;
            // Il tempo massimo serve: se il collegamento cade proprio mentre si
            // aspetta, quell'evento non arriva mai e il ciclo resta appeso in
            // silenzio, senza errori e senza fine.
            setTimeout(r, 5000);
          });
        }
        // Fermi finche' l'altro non dice di riprendere. Il tempo massimo c'e'
        // lo stesso: se il "vai" si perde per strada non si resta appesi per
        // sempre, si riprova e al massimo l'altro richiede un'altra pausa.
        while (fermo && canale.readyState === 'open') {
          await new Promise((r) => {
            riprendi = r;
            setTimeout(r, 500);
          });
        }
        if (canale.readyState !== 'open') throw new Error('collegamento interrotto');
        const fetta = f.slice(inviati, Math.min(inviati + pezzo, f.size));
        canale.send(await fetta.arrayBuffer());
        inviati += fetta.size;
        pezziMandati += 1;
        // Un pezzo ogni sedici, e solo in memoria: scrivere l'avanzamento nel
        // registro a ogni pezzo faceva rallentare il trasferimento fino a
        // fermarlo — il registro va riletto tutto ogni volta, quindi il costo
        // cresce da solo. Su un file da 4 GB non arrivava in fondo.
        // A pezzi, non a byte: `inviati % qualcosa === 0` non tornava mai
        // quando l'ultimo pezzo era parziale, o quando il pezzo cambiava misura.
        if (pezziMandati % ogni === 0) {
          aggiornaRiga(await api.avanzamentoDiretto(messaggioId, inviati));
        }
      }
      canale.send('FINE');
      // Prima si aspetta che la coda si svuoti davvero, poi che l'altro dica
      // di avere tutto. Chiudere prima significa buttare via cio' che non e'
      // ancora partito: e' esattamente il difetto che questo evita.
      while (canale.bufferedAmount > 0 && canale.readyState === 'open') {
        await new Promise((r) => setTimeout(r, 50));
      }
      const arrivato = await Promise.race([
        conferma,
        new Promise((r) => setTimeout(() => r(false), ATTESA_CONFERMA)),
      ]);
      if (!arrivato) throw new Error('nessuna conferma da chi doveva riceverlo');
      chiudi(fileId, null);
    } catch (e) {
      chiudi(fileId, e instanceof Error ? e.message : String(e));
    }
  };

  canale.onopen = versa;
  if (canale.readyState === 'open') void versa();
}

/**
 * Riceve i pezzi e li scrive, con il freno.
 *
 * Sta in una funzione sola perche' i due percorsi che portano qui — chi accetta
 * un collegamento e chi lo apre lui al secondo tentativo — devono comportarsi
 * nello stesso identico modo. Duplicarla vorrebbe dire due comportamenti che
 * divergono alla prima correzione fatta da una parte sola.
 */
function scriviQuelloCheArriva(canale, opzioni) {
  const { fileId, dove, gia, dimensione, messaggioId } = opzioni;
  canale.binaryType = 'arraybuffer';
  let scritti = gia;

  // Prima cosa che si dice: da che punto mandare. Zero se si comincia.
  const diciDaDove = () => {
    if (canale.readyState === 'open') canale.send('DA:' + gia);
  };
  canale.onopen = diciDaDove;
  diciDaDove();

  // Una coda sola: le scritture su disco vanno serializzate, o due pezzi
  // finiscono in coda nell'ordine sbagliato.
  let coda = Promise.resolve();
  // Quanti byte aspettano di essere scritti. Se crescono senza limite
  // finiscono tutti in memoria: e' cio' che rendeva impossibili i file
  // grandi. Vedi `BYTE_TROPPI`.
  let byteInAttesa = 0;
  let pezziRicevuti = 0;
  let chiestaPausa = false;
  const dilloAllAltro = (parola) => {
    if (canale.readyState === 'open') canale.send(parola);
  };

  canale.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      // Il segnale di fine aspetta la coda: le scritture in sospeso devono
      // finire prima di dire che e' arrivato tutto.
      coda = coda.then(() => {
        if (canale.readyState === 'open') canale.send('OK');
        chiudi(fileId, null);
      });
      return;
    }
    const bytes = new Uint8Array(ev.data);
    scritti += bytes.length;
    const pezzo = inBase64(bytes);

    byteInAttesa += bytes.length;
    pezziRicevuti += 1;
    if (byteInAttesa >= BYTE_TROPPI && !chiestaPausa) {
      chiestaPausa = true;
      dilloAllAltro('PAUSA');
    }

    coda = coda
      .then(() => api.scriviPezzo(dove, pezzo))
      .then(() => {
        byteInAttesa -= bytes.length;
        if (chiestaPausa && byteInAttesa <= BYTE_ABBASTANZA) {
          chiestaPausa = false;
          dilloAllAltro('VAI');
        }
      })
      .then(() => (pezziRicevuti % 8 === 0 ? api.avanzamentoDiretto(messaggioId, scritti) : null))
      .then((m) => (m ? aggiornaRiga(m) : null))
      .catch((err) => chiudi(fileId, err instanceof Error ? err.message : String(err)));
  };

  canale.onclose = () =>
    coda.then(() => chiudi(fileId, scritti === dimensione ? null : 'collegamento chiuso a meta'));

  // Quanti byte sono stati scritti finora, per chi deve segnare l'esito.
  return () => scritti;
}

// Trasferimento diretto fra i due computer, per i file oltre la soglia.
//
// Perche' sta nella finestra e non nel processo principale: `RTCPeerConnection`
// e' dentro Chromium, quindi qui e' gia' disponibile. Nel processo principale
// servirebbe un modulo nativo, e questo programma non ne ha nessuno — e' cio'
// che gli permette di essere costruito per Windows e per Mac senza una catena
// di compilazione diversa per ciascuno.
//
// Cosa passa dai relay e cosa no: dai relay passa SOLO la segnalazione — le
// descrizioni di sessione e i candidati di rete — e passa cifrata dal ratchet
// come qualsiasi messaggio. I byte del file non toccano nessun relay: vanno
// dal computer di chi manda a quello di chi riceve e basta.
//
// Il limite onesto: senza un server di appoggio a pagamento, certe combinazioni
// di router non riescono a trovarsi. In quel caso il trasferimento non parte, e
// va detto invece di lasciare una barra ferma per sempre.

/** Server STUN pubblici: dicono soltanto "il tuo indirizzo visto da fuori e'
 *  questo". Non vedono i dati e non fanno da tramite. */
const STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Piu' di due: se uno non risponde — provato, capita — restano gli altri, e
  // senza almeno un indirizzo visto da fuori non si esce dalla propria rete.
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.nextcloud.com:443' },
];

/**
 * Quanto si aspetta che i due si trovino, DOPO che l'altro ha accettato.
 *
 * Trenta secondi bastano per lo scambio dei candidati: e' traffico fra due
 * programmi, senza nessuno che debba decidere niente.
 */
const ATTESA_COLLEGAMENTO = 30000;

/**
 * Quanto si aspetta che l'altro accetti.
 *
 * Molto piu' lungo, perche' qui dentro c'e' una persona: chi riceve deve
 * scegliere dove salvare, e per un file da gigabyte puo' andare a cercare un
 * disco con abbastanza spazio. Prima questo tempo stava dentro i trenta
 * secondi del collegamento, e superarli dava "non si e riusciti a stabilire il
 * collegamento diretto" — un messaggio che parlava di rete mentre il problema
 * era che qualcuno stava ancora scegliendo una cartella.
 */
const ATTESA_ACCETTAZIONE = 10 * 60 * 1000;
/**
 * Quanto grande e' un pezzo sul canale diretto.
 *
 * Non una costante: il massimo lo dichiara la connessione stessa in
 * `pc.sctp.maxMessageSize`, e si prende quello. Provato con due connessioni
 * vere: il valore era 262144, cioe' 256 KB, e oltre quella soglia `send()`
 * NON da' errore ma i messaggi non arrivano — spediti 512 KB e 1 MB, ricevuti
 * solo fino a 256. Un fallimento silenzioso e' il modo peggiore di sbagliare,
 * quindi non ci si avvicina indovinando.
 *
 * Quattro volte piu' grande di prima vuol dire un quarto delle chiamate, delle
 * conversioni e delle scritture: su un file da 100 GB sono 400.000 pezzi
 * invece di 1.638.400.
 */
const PEZZO_MASSIMO = 256 * 1024;
const PEZZO_MINIMO = 16 * 1024;

function quantoGrande(pc) {
  const dichiarato = pc?.sctp?.maxMessageSize;
  if (!dichiarato || !Number.isFinite(dichiarato)) return 64 * 1024; // com'era prima
  return Math.max(PEZZO_MINIMO, Math.min(PEZZO_MASSIMO, dichiarato));
}
/** Sopra questa coda si smette di scrivere e si aspetta che si svuoti: senza,
 *  un file grosso riempie la memoria invece della rete. */
const CODA_MASSIMA = 4 * 1024 * 1024;

/**
 * Quanti pezzi chi riceve accetta di tenere in attesa di scrittura.
 *
 * Serve contro il difetto che rendeva impossibili i file molto grandi. Chi
 * manda si ferma quando la SUA coda di uscita e' piena, cioe' quando i dati
 * sono partiti — non quando sono stati scritti su disco. Se il disco e' piu'
 * lento della rete, i pezzi si accumulano in memoria dall'altra parte e
 * nessuno lo dice a nessuno: misurato, tutti i pezzi finivano in attesa
 * insieme. A 100 MB sono 133 MB di memoria e si passa; a 4 GB sarebbero 5,4 GB
 * e il programma muore, lasciando "collegamento non riuscito" da una parte e
 * "non arrivato intero" dall'altra.
 *
 * Adesso chi riceve dice quando fermarsi e quando riprendere. Due soglie e non
 * una: con una sola si alternerebbe fermo e riparti a ogni pezzo.
 */
const BYTE_TROPPI = 16 * 1024 * 1024;
const BYTE_ABBASTANZA = 4 * 1024 * 1024;
/**
 * Quanto si aspetta la conferma finale prima di considerarlo non riuscito.
 *
 * Due minuti e non venti secondi: quando arriva il segnale di fine, chi riceve
 * puo' avere ancora centinaia di megabyte in coda da scrivere su disco. Su un
 * file grande venti secondi non bastavano, e il mittente lo dava per fallito
 * mentre dall'altra parte stava ancora arrivando.
 */
const ATTESA_CONFERMA = 120000;

/**
 * Byte in base64, a fette.
 *
 * `String.fromCharCode(...bytes)` su un pezzo da 64 KB supera il numero massimo
 * di argomenti e va in errore, quindi si procede a fette piccole. Passare i
 * byte come array di numeri costerebbe una serializzazione di sessantacinquemila
 * elementi per pezzo: su un file da un gigabyte sono milioni di elementi al
 * secondo, ed e' li' che se ne va il tempo, non nella rete.
 */
function inBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(s);
}

/** Trasferimenti in corso, per identificativo di file. */
const inCorso = new Map();

/**
 * Candidati di rete arrivati troppo presto, per identificativo di file.
 *
 * Chi manda spedisce i candidati subito dopo l'offerta, e sui relay ci
 * mettono meno di un secondo. Chi riceve, in quel momento, sta ancora
 * scegliendo dove salvare: la connessione non esiste, e un candidato che
 * arriva adesso non ha nessuno a cui essere dato. Prima veniva buttato, e a
 * fine attesa la diagnosi diceva `suoi=0`: tutti i candidati dell'altro
 * persi, nessuna coppia da provare, collegamento mai tentato. Vale anche per
 * chi manda: un candidato puo' precedere la risposta sui relay, e
 * `addIceCandidate` senza descrizione remota fallisce in silenzio.
 *
 * Si tengono qui e si versano appena la descrizione remota e' impostata.
 */
const candidatiInAttesa = new Map();

function tieniCandidato(fileId, dati) {
  const lista = candidatiInAttesa.get(fileId) ?? [];
  lista.push(dati);
  candidatiInAttesa.set(fileId, lista);
}

async function aggiungiCandidato(pc, dati) {
  try {
    await pc.addIceCandidate(JSON.parse(dati));
    if (pc.__cand) pc.__cand.remoti += 1;
  } catch {
    // Un candidato che non serve piu' non e' un errore: capita di riceverne
    // dopo che il collegamento e' gia' stabilito per un'altra strada.
  }
}

/** Da' alla connessione i candidati messi da parte. Dopo `setRemoteDescription`. */
async function versaCandidati(fileId, pc) {
  const lista = candidatiInAttesa.get(fileId) ?? [];
  candidatiInAttesa.delete(fileId);
  for (const dati of lista) await aggiungiCandidato(pc, dati);
}

/**
 * Aggiorna la riga di un file nella conversazione aperta, se e' quella giusta.
 *
 * `metti` sostituisce la bolla al suo posto invece di ridisegnare il pannello:
 * durante un trasferimento la barra si muove decine di volte, e ogni ridisegno
 * faceva sfarfallare tutto e perdeva la posizione dello scorrimento.
 */
function aggiornaRiga(m) {
  if (!m) return;
  const thread = document.querySelector('#pane .thread');
  if (!thread) return;
  if (state.open?.kind !== 'contatto' || state.open.id !== m.peer) return;
  metti(thread, m, false);
}

/**
 * I server che ICE puo' usare: gli STUN pubblici, piu' il TURN dell'utente se
 * ne ha scritto uno.
 *
 * Il TURN entra solo quando esiste: con `urls` vuoto o credenziali mancanti
 * Chromium rifiuta la connessione intera alla creazione, cioe' nel punto
 * peggiore. Il controllo sui valori lo fa il cuore prima di salvarli; qui si
 * guarda soltanto se ci sono. ICE lo prova da solo come ultima strada, dopo le
 * dirette: non si paga niente quando le dirette bastano.
 */
function serverIce() {
  const t = state.turn;
  if (!t || !t.url || !t.utente || !t.password) return STUN;
  return [...STUN, { urls: t.url, username: t.utente, credential: t.password }];
}

function nuovaConnessione() {
  return new RTCPeerConnection({
    iceServers: serverIce(),
    // Tutte le strade, non solo quelle viste da fuori: gli indirizzi di rete
    // locale sono i piu' veloci quando i due sono sulla stessa rete.
    iceTransportPolicy: 'all',
    // Candidati raccolti in anticipo: la negoziazione parte con qualcosa in
    // mano invece di aspettare i server STUN.
    iceCandidatePoolSize: 4,
  });
}

/**
 * Manda i candidati man mano che il browser li scopre.
 *
 * Si potrebbe aspettare di averli tutti e mandarne uno solo, ma vorrebbe dire
 * aspettare il timeout del candidato piu' lento prima di provare il primo.
 */
function inoltraCandidati(pc, contattoId, fileId) {
  // Si conta cosa si raccoglie: senza, un collegamento fallito e' solo un
  // messaggio che dice che e' fallito.
  pc.__cand = { host: 0, srflx: 0, relay: 0, remoti: 0, errori: [] };
  pc.onicecandidateerror = (e) => {
    // 701 e' "il server STUN non ha risposto". Vale la pena saperlo: senza
    // srflx non si esce dalla propria rete.
    pc.__cand.errori.push(`${e.errorCode}@${(e.url ?? '').replace(/^stun:/, '')}`);
  };
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const tipo = e.candidate.type ?? '';
    if (tipo in pc.__cand) pc.__cand[tipo] += 1;
    void api.segnale(contattoId, { id: fileId, ruolo: 'candidato', dati: JSON.stringify(e.candidate) });
  };
}

function scadenza(pc, fileId, quando, motivo = 'non si e riusciti a stabilire il collegamento diretto') {
  return setTimeout(() => {
    if (pc.connectionState === 'connected') return;
    chiudi(fileId, `${motivo} (${diagnosi(pc)})`);
  }, quando);
}

/**
 * Cosa e' successo davvero nella negoziazione.
 *
 * "Non si e riusciti a stabilire il collegamento diretto" non dice niente a
 * chi deve capire perche'. I due casi che si somigliano e vanno distinti:
 * nessun candidato utile raccolto (i server STUN non hanno risposto, o la rete
 * li blocca) e candidati raccolti ma nessuna coppia che funziona (i due NAT non
 * si bucano, e senza un server che faccia da tramite non si passa).
 *
 * `srflx` e' l'indirizzo visto da fuori, quello che serve per uscire da casa;
 * `host` sono gli indirizzi locali, che valgono solo sulla stessa rete.
 */
function diagnosi(pc) {
  const c = pc.__cand ?? { host: 0, srflx: 0, relay: 0, remoti: 0, errori: [] };
  const pezzi = [
    `ice=${pc.iceConnectionState}`,
    `raccolta=${pc.iceGatheringState}`,
    `miei host=${c.host} srflx=${c.srflx} relay=${c.relay}`,
    `suoi=${c.remoti}`,
  ];
  if (c.errori.length) pezzi.push(`errori=${c.errori.slice(0, 2).join(' ')}`);
  // Se c'e' un TURN e non ha dato nemmeno un candidato, e' quello il guasto da
  // guardare: senza questa riga la diagnosi lo tacerebbe.
  if (state.turn && c.relay === 0) pezzi.push('turn=nessun candidato');
  else if (!state.turn) pezzi.push('turn=assente');
  return pezzi.join(', ');
}

function chiudi(fileId, errore) {
  const t = inCorso.get(fileId);
  if (!t) return;
  inCorso.delete(fileId);
  candidatiInAttesa.delete(fileId);
  clearTimeout(t.orologio);
  try {
    t.pc.close();
  } catch {
    /* gia' chiusa */
  }
  if (t.onFine) t.onFine(errore ?? null);
}

/**
 * Lato di chi manda: apre il canale, aspetta la risposta, poi versa il file.
 *
 * Il file si legge a fette con `slice`: un file da due gigabyte non entra in
 * memoria, e non deve entrarci in nessun momento.
 */
/**
 * I file che stiamo mandando, tenuti da parte per un eventuale secondo
 * tentativo.
 *
 * `chiudi()` toglie la voce da `inCorso` PRIMA di chiamare `onFine`: quando da
 * li' si chiede all'altro di riprovare lui, non c'e' piu' niente a cui
 * agganciare la sua offerta. Senza questa mappa il secondo tentativo arrivava e
 * non trovava nessuno — chi riceve restava con un file vuoto sul disco e niente
 * che succedeva.
 */
const daMandare = new Map();

async function inviaDiretto(contatto, messaggio, f, giaInvertito = false) {
  const fileId = messaggio.file.id;
  daMandare.set(fileId, { f, messaggioId: messaggio.id, contattoId: contatto.id });
  const pc = nuovaConnessione();
  const canale = pc.createDataChannel('file', { ordered: true });
  canale.binaryType = 'arraybuffer';

  inCorso.set(fileId, {
    pc,
    canale,
    // Prima si aspetta che accetti, con calma. Il conto stretto parte solo
    // quando la risposta e' arrivata: vedi `ATTESA_ACCETTAZIONE`.
    orologio: scadenza(pc, fileId, ATTESA_ACCETTAZIONE, 'l altro non ha ancora accettato'),
    file: f,
    contattoId: contatto.id,
    messaggioId: messaggio.id,
    onFine: async (errore) => {
      // Un collegamento che non si stabilisce si riprova una volta sola, a
      // parti invertite: e' chi riceve ad aprirlo. Per la connettivita' ICE
      // il verso non conta — le coppie si provano da entrambi i lati — ma il
      // secondo tentativo e' una connessione nuova, con candidati nuovi, e
      // costa un solo giro in piu'. (Il "NAT simmetrico" per cui era nato non
      // c'era: rimisurato, e' un NAT cone. Il difetto vero era altrove, vedi
      // `candidatiInAttesa`.)
      if (errore && !giaInvertito && /collegamento|accettato/.test(errore)) {
        giaInvertito = true;
        avvisoDiSistema(`${f.name}: riprovo dall'altra parte`);
        await api.segnale(contatto.id, { id: fileId, ruolo: 'inverti', dati: '' });
        return;
      }
      const m = await api.esitoDiretto(messaggio.id, errore ? { stato: 'fallito' } : { stato: 'pronto', fatti: f.size });
      if (errore) avvisoDiSistema(`${f.name}: ${errore}`);
      aggiornaRiga(m);
    },
  });

  inoltraCandidati(pc, contatto.id, fileId);

  // La conferma di chi riceve. Senza, si chiude la connessione mentre i dati
  // sono ancora nella coda di uscita e il file arriva mozzato — con il mittente
  // convinto di averlo mandato tutto.
  versaIlFile(pc, canale, f, fileId, messaggio.id);

  const offerta = await pc.createOffer();
  await pc.setLocalDescription(offerta);
  await api.segnale(contatto.id, { id: fileId, ruolo: 'offerta', dati: JSON.stringify(offerta) });
}

/**
 * Lato di chi riceve: chiede dove salvare, poi scrive i pezzi in coda.
 *
 * La destinazione la sceglie l'utente PRIMA che arrivi qualcosa. Un file da
 * gigabyte non si tiene in memoria in attesa di sapere dove metterlo, e non si
 * scrive da nessuna parte senza che qualcuno l'abbia deciso.
 */
async function accettaDiretto(contattoId, fileId, offertaSdp, messaggioId, nome, dimensione) {
  // Se di questo file c'e' gia' un pezzo su disco si riprende da li'. Su un
  // file da decine di gigabyte una connessione che cade e' normale, e
  // ricominciare da zero ogni volta vorrebbe dire non arrivare mai in fondo.
  const ripresa = (await api.riprendiDestinazione?.(messaggioId)) ?? null;
  let dove;
  let gia = 0;
  if (ripresa && ripresa.gia > 0 && ripresa.gia < dimensione) {
    dove = ripresa.gettone;
    gia = ripresa.gia;
  } else {
    const scelta = await api.destinazione(nome);
    if (!scelta) {
      await api.segnale(contattoId, { id: fileId, ruolo: 'rifiuto', dati: 'rifiutato' });
      aggiornaRiga(await api.esitoDiretto(messaggioId, { stato: 'fallito' }));
      return;
    }
    // La destinazione adesso torna anche il percorso, che va messo subito nel
    // registro: senza, una ripresa non saprebbe quale file continuare.
    dove = scelta.gettone ?? scelta;
    if (scelta.percorso) await api.esitoDiretto(messaggioId, { percorso: scelta.percorso });
    await api.azzeraFile(dove);
  }

  const pc = nuovaConnessione();
  // Quanti byte sono stati scritti lo sa chi li scrive: qui si tiene solo il
  // modo di chiederglielo.
  let quantiScritti = () => gia;

  inCorso.set(fileId, {
    pc,
    orologio: scadenza(pc, fileId, ATTESA_COLLEGAMENTO),
    onFine: async (errore) => {
      const scritti = quantiScritti();
      const completo = !errore && scritti === dimensione;
      const m = await api.esitoDiretto(
        messaggioId,
        completo
          ? { stato: 'pronto', fatti: scritti, percorso: dove }
          : // Non "fallito" ma "atteso": il pezzo gia' scritto resta sul disco e
            // il prossimo tentativo riparte da li'. Chiamarlo fallito farebbe
            // ricominciare da zero un file da decine di gigabyte.
            { stato: 'atteso', fatti: scritti }
      );
      // Il gettone ha fatto il suo lavoro: da qui in poi non deve piu' valere,
      // che il file sia arrivato tutto o no.
      await api.chiudiDestinazione?.(dove);
      if (!completo) avvisoDiSistema(`${nome}: ${errore ?? 'arrivato incompleto'}`);
      aggiornaRiga(m);
    },
  });

  inoltraCandidati(pc, contattoId, fileId);

  pc.ondatachannel = (e) => {
    quantiScritti = scriviQuelloCheArriva(e.channel, {
      fileId,
      dove,
      gia,
      dimensione,
      messaggioId,
    });
  };

  await pc.setRemoteDescription(JSON.parse(offertaSdp));
  // I candidati dell'altro sono quasi certamente gia' arrivati, mentre la
  // finestra di salvataggio era aperta: adesso c'e' a chi darli.
  await versaCandidati(fileId, pc);
  const risposta = await pc.createAnswer();
  await pc.setLocalDescription(risposta);
  await api.segnale(contattoId, { id: fileId, ruolo: 'risposta', dati: JSON.stringify(risposta) });
}

/**
 * Il secondo tentativo, aperto da chi riceve.
 *
 * Stesso trasferimento, ruoli scambiati: il collegamento lo apre chi aspetta il
 * file invece di chi ce l'ha. Serve perche' un NAT che cambia porta per ogni
 * destinazione lascia passare in un verso e non nell'altro, e quale sia il
 * verso buono dipende dalle due reti — non da chi ha il file da mandare.
 *
 * Il canale lo crea chi apre; i byte ci passano nello stesso senso di prima.
 */
async function apriIoIlCollegamento(contattoId, fileId, dati) {
  const ripresa = (await api.riprendiDestinazione?.(dati.messaggioId)) ?? null;
  let dove;
  let gia = 0;
  if (ripresa && ripresa.gia > 0 && ripresa.gia < dati.dimensione) {
    dove = ripresa.gettone;
    gia = ripresa.gia;
  } else {
    const scelta = await api.destinazione(dati.nome);
    if (!scelta) {
      await api.segnale(contattoId, { id: fileId, ruolo: 'rifiuto', dati: 'rifiutato' });
      return;
    }
    dove = scelta.gettone ?? scelta;
    if (scelta.percorso) await api.esitoDiretto(dati.messaggioId, { percorso: scelta.percorso });
    await api.azzeraFile(dove);
  }

  const pc = nuovaConnessione();
  const canale = pc.createDataChannel('file', { ordered: true });
  const quantiScritti = scriviQuelloCheArriva(canale, {
    fileId,
    dove,
    gia,
    dimensione: dati.dimensione,
    messaggioId: dati.messaggioId,
  });
  inCorso.set(fileId, {
    pc,
    canale,
    orologio: scadenza(pc, fileId, ATTESA_COLLEGAMENTO),
    onFine: async (errore) => {
      const scritti = quantiScritti();
      const completo = !errore && scritti === dati.dimensione;
      const m = await api.esitoDiretto(
        dati.messaggioId,
        completo
          ? { stato: 'pronto', fatti: scritti, percorso: dove }
          : { stato: 'atteso', fatti: scritti }
      );
      await api.chiudiDestinazione?.(dove);
      if (!completo) avvisoDiSistema(`${dati.nome}: ${errore ?? 'arrivato incompleto'}`);
      aggiornaRiga(m);
    },
  });
  inoltraCandidati(pc, contattoId, fileId);

  const offerta = await pc.createOffer();
  await pc.setLocalDescription(offerta);
  await api.segnale(contattoId, { id: fileId, ruolo: 'offerta-inversa', dati: JSON.stringify(offerta) });
}

/**
 * Segnalazione in arrivo dall'altro.
 *
 * L'annuncio del file arriva due volte apposta: una come messaggio, che crea la
 * riga nella conversazione, e una come segnalazione, che fa partire questo.
 * Sono due cose diverse — la prima resta anche se il trasferimento fallisce.
 */
async function riceviSegnale(da, p) {
  if (p.ruolo === 'offerta') {
    // La prima offerta e' l'annuncio del file, la seconda la descrizione di
    // sessione. Si distinguono da cosa contengono.
    let contenuto;
    try {
      contenuto = JSON.parse(p.dati);
    } catch {
      return;
    }
    if (contenuto.t === 'file.offer') {
      inCorso.set(`attesa:${p.id}`, { offerta: contenuto, da });
      return;
    }
    const attesa = inCorso.get(`attesa:${p.id}`);
    if (!attesa) return;
    inCorso.delete(`attesa:${p.id}`);
    const righe = await api.history(da);
    const riga = righe.find((m) => m.file && m.file.id === p.id);
    if (!riga) return;
    // Messo da parte per il caso in cui il primo tentativo non riesca e tocchi
    // a noi aprire il collegamento.
    inCorso.set(`riprova:${p.id}`, {
      messaggioId: riga.id,
      nome: attesa.offerta.nome,
      dimensione: attesa.offerta.dimensione,
    });
    return accettaDiretto(da, p.id, p.dati, riga.id, attesa.offerta.nome, attesa.offerta.dimensione);
  }

  if (p.ruolo === 'inverti') {
    // L'altro non e' riuscito ad aprire il collegamento: si prova al contrario,
    // aprendolo da qui. Il file continua a venire da lui: cambia solo chi bussa.
    const salvato = inCorso.get(`riprova:${p.id}`);
    inCorso.delete(`riprova:${p.id}`);
    if (salvato) await apriIoIlCollegamento(da, p.id, salvato);
    return;
  }

  if (p.ruolo === 'offerta-inversa') {
    // Abbiamo noi il file, e l'altro ha aperto lui il collegamento. La
    // connessione di prima e' stata chiusa quando il primo tentativo e'
    // fallito: qui ne serve una nuova.
    const mio = daMandare.get(p.id);
    if (!mio) return;
    const pc2 = nuovaConnessione();
    inCorso.set(p.id, {
      pc: pc2,
      orologio: scadenza(pc2, p.id, ATTESA_COLLEGAMENTO),
      onFine: async (errore) => {
        daMandare.delete(p.id);
        const m = await api.esitoDiretto(
          mio.messaggioId,
          errore ? { stato: 'fallito' } : { stato: 'pronto', fatti: mio.f.size }
        );
        if (errore) avvisoDiSistema(`${mio.f.name}: ${errore}`);
        aggiornaRiga(m);
      },
    });
    inoltraCandidati(pc2, da, p.id);
    // Il canale lo ha creato l'altro: si aspetta che arrivi, poi ci si versa
    // dentro il file come nel primo tentativo.
    pc2.ondatachannel = (e) => {
      e.channel.binaryType = 'arraybuffer';
      versaIlFile(pc2, e.channel, mio.f, p.id, mio.messaggioId);
    };
    await pc2.setRemoteDescription(JSON.parse(p.dati));
    await versaCandidati(p.id, pc2);
    const risposta = await pc2.createAnswer();
    await pc2.setLocalDescription(risposta);
    await api.segnale(da, { id: p.id, ruolo: 'risposta', dati: JSON.stringify(risposta) });
    return;
  }

  if (p.ruolo === 'candidato') {
    // Senza una connessione con la descrizione remota gia' impostata il
    // candidato si mette da parte, non si butta: vedi `candidatiInAttesa`.
    const t = inCorso.get(p.id);
    if (!t || !t.pc.remoteDescription) {
      tieniCandidato(p.id, p.dati);
      return;
    }
    await aggiungiCandidato(t.pc, p.dati);
    return;
  }

  const t = inCorso.get(p.id);
  if (!t) return;
  if (p.ruolo === 'risposta') {
    // Accettato: da qui in poi non c'e' piu' nessuno che deve decidere, e il
    // conto torna stretto.
    clearTimeout(t.orologio);
    t.orologio = scadenza(t.pc, p.id, ATTESA_COLLEGAMENTO);
    await t.pc.setRemoteDescription(JSON.parse(p.dati));
    await versaCandidati(p.id, t.pc);
    return;
  }
  if (p.ruolo === 'rifiuto') chiudi(p.id, 'rifiutato da chi doveva riceverlo');
}
