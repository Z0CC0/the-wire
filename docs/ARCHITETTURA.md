# THE WIRE

Messaggistica cifrata da persona a persona. Nessuna registrazione, nessun
account, nessun server da pagare o da tenere acceso.

Applicazione desktop (Electron), Windows e macOS.

## Come funziona

**Identità.** Al primo avvio l'app genera le tue chiavi in locale e le cifra con
una passphrase. Non c'è iscrizione: non esiste nessun posto dove tu sia
registrato. Se perdi la passphrase, l'identità è persa — per costruzione,
nessuno può recuperarla.

**Contatti.** Ti scambi una riga `wire:1:…` (di persona, o da qualunque canale).
La riga è firmata: se qualcuno la altera per strada, viene rifiutata.

**Verifica.** Prima di fidarvi, confrontate a voce il **numero di sicurezza**: 60
cifre identiche sui due schermi. È l'unico momento in cui l'uomo-nel-mezzo viene
escluso davvero.

**Messaggi.** X3DH per aprire la conversazione, poi Double Ratchet: chiave nuova
a ogni messaggio, forward secrecy e post-compromise security. Il primo messaggio
parte anche se l'altro è offline.

**Consegna.** Relay Nostr pubblici e gratuiti. Il relay non vede il contenuto
(doppia cifratura: ratchet + NIP-44) né chi scrive a chi (involucro NIP-59
firmato da una chiave usa-e-getta). Si pubblica su cinque relay in parallelo:
basta che due persone ne abbiano uno in comune.

**Un programma alla volta.** Il deposito si prende all'apertura e si rilascia
alla chiusura. Due programmi che avanzano lo stesso ratchet brucerebbero gli
stessi numeri di messaggio, e quei messaggi il destinatario li rifiuterebbe per
sempre — senza errori a schermo. Un lock lasciato da un programma finito male
viene riconosciuto e scavalcato; quello di un altro computer no.

**Storico.** Registro cifrato in sola aggiunta, sul tuo disco. Scrivere costa
sempre uguale, che sia il decimo messaggio o il centomillesimo.

## Dipendenze

`npm audit` deve dire **`6 moderate severity vulnerabilities`, tutte in
`minimatch`** sotto `electron-builder` (`app-builder-lib`, `dmg-builder`,
`@electron/universal`). Sono nello strumento che costruisce il pacchetto, non in
ciò che finisce dentro il pacchetto, e l'unica "correzione" che npm propone è
tornare a `electron-builder` 25: un passo indietro per un difetto che non ci
riguarda. Qualunque **altra** riga — Electron, Capacitor, vitest, le librerie
`@noble` — va riportata e sistemata con `npm audit fix` (fatto l'ultima volta il
2026-11-15: Electron 44.11.3, Capacitor 8.6.2, vitest 4.1.12).

**Dopo un `npm audit fix` che tocca Electron, rilanciare `npm run postinstall`.**
L'aggiornamento sostituisce il pacchetto ma non riscarica il binario:
`node_modules/electron/dist` resta vuoto e `npx electron .` muore senza spiegare
perché. Il controllo è `ls node_modules/electron/dist`.

Restano quattro avvisi `npm warn deprecated` (`inflight`, `rimraf`, `glob`,
`boolean`): arrivano tutti dall'albero di `electron-builder` — `@electron/asar`,
`electron-winstaller`, `@electron/get` — non da questo progetto, e nessuno è una
vulnerabilità. Due addirittura da `electron-builder-squirrel-windows`, che non
usiamo: qui si costruisce con NSIS.

**`postinstall": "install-electron"` non è decorativo.** Da Electron 42 il
pacchetto `electron` non ha più un `postinstall` suo, quindi il binario non si
scarica da solo: senza quella riga `npm install` finisce **senza errori** e
lascia il progetto senza Electron — niente si avvia e niente si costruisce,
senza un messaggio che spieghi perché.

## Punti d'ingresso

Il programma che Electron carica è **`apps/desktop/bundle/main.cjs`**, prodotto
da `npm run pack` con esbuild. Non è l'uscita di `tsc`: quella è un modulo ES,
perché entrambi i `package.json` dichiarano `"type": "module"`, e in un modulo
ES `__dirname` non esiste. Caricarla fa morire Electron all'avvio con
`ReferenceError: __dirname is not defined in ES module scope`.

Sia `package.json` sia `apps/desktop/package.json` puntano quindi al bundle, e
`packages/core/test/avvio.test.ts` lo verifica — quel test esiste perché il
secondo dei due era rimasto indietro, e il difetto non si vede mai costruendo il
pacchetto: si vede solo a chi avvia dai sorgenti.

## Sviluppo

```bash
npm install
npm run build
npm test
```

| Comando | Cosa fa |
|---------|---------|
| `npm run desktop` | costruisce il bundle e avvia la finestra Electron |
| `npm test` | 210 test: crittografia, protocollo, gruppi, lock, consegna, prova d'insieme |
| `npm run dist:win` | installer Windows (NSIS) |
| `npm run dist:mac` | DMG macOS (arm64 + x64) |

## Struttura

```
packages/core/       il cuore, condiviso dalle due facce
  identity.ts          chiavi, contact card firmata, numero di sicurezza
  ratchet.ts           X3DH + Double Ratchet
  envelope.ts          formato di rete (ogni byte autenticato)
  keystore.ts          deposito cifrato con Argon2id
  history.ts           registro messaggi in sola aggiunta
  lock.ts              un solo programma alla volta sul deposito
  payload.ts           cosa viaggia dentro il cifrato, validato campo per campo
  group.ts             gruppi con argomenti, consegna a ventaglio
  mailbox.ts           interfaccia di trasporto (+ finto, per i test)
  mailbox-nostr.ts     trasporto su relay pubblici
  turn.ts              il server di appoggio del collegamento diretto, controllato prima di salvarlo
  account.ts           l'oggetto che usano entrambe le facce
apps/desktop/        Electron: finestra e IPC. Niente protocollo.
  qr.ts                il QR del collegamento, disegnato come SVG
apps/pwa/            la stessa app, impacchettata per il telefono
ui/                  interfaccia, la stessa nei due posti (HTML/CSS/JS, zero build)
```

Il protocollo sta **solo** in `packages/core`. L'interfaccia non lo tocca: chiede
al processo principale e mostra quello che riceve.

## Crittografia

Primitive da `@noble/*` (TypeScript puro, audite, zero dipendenze native — così
non c'è una build diversa per Windows, Mac arm64 e Mac x64).

| Ruolo | Algoritmo |
|-------|-----------|
| Firma | Ed25519 |
| Scambio chiavi | X25519 (X3DH + Double Ratchet) |
| Cifratura | XChaCha20-Poly1305 |
| Derivazione | HKDF-SHA256, HMAC-SHA256 |
| Passphrase | Argon2id (64 MB, 3 passate) |
| Indirizzo mailbox | secp256k1 Schnorr, derivato dalla chiave di firma |

Argon2id con questi parametri costa ~3 secondi allo sblocco. È voluto: è quello
che rende inutile provare miliardi di passphrase su un file rubato. Si paga una
volta all'apertura, non a ogni salvataggio.

## Presenza

Il pallino accanto a un contatto dice se è collegato in questo momento; sotto al
nome compare `ONLINE` oppure da quanto non si fa vivo.

Ogni 45 secondi il programma manda a ciascun contatto un **battito**: un
messaggio che non contiene niente e serve solo ad arrivare. Chi lo riceve
segna l'orario — il proprio, non quello del mittente, così un orologio sbagliato
dall'altra parte non può far risultare qualcuno online per sempre. Dopo 150
secondi senza battiti il contatto si spegne da solo: servono tre battiti persi
di fila, perché sui relay pubblici perderne uno è normale.

Chi riceve un battito risponde subito con uno suo, così due programmi che si
accendono si vedono in un paio di secondi invece di aspettare il giro. La
risposta è marcata come tale e a una risposta non si risponde: lo scambio finisce
dopo un giro e non rimbalza.

**Il battito non passa dal Double Ratchet, ed è deliberato.** Se ci passasse,
consumerebbe una chiave ogni 45 secondi: chi resta spento un giorno tornerebbe
con circa duemila chiavi da recuperare, oltre il limite `MAX_SKIP`, e la
conversazione si romperebbe per sempre. Un pallino verde non può costare una
conversazione. Il battito viaggia quindi su un canale suo — cifrato NIP-44 verso
il destinatario dentro l'involucro NIP-59, con numeri della fascia effimera —
che il recupero all'avvio non interroga mai. Un battito perso non costa niente e
non torna indietro: è esattamente quello che deve fare.

Quello che il battito dimostra è più debole di un messaggio: lo autentica la
firma del sigillo, non il ratchet. Va bene perché quello che porta è un pallino.
Un battito falsificato non apre sessioni, non scrive nello storico e non tocca
nessuna chiave.

## Dove stanno i dati, e come spostarli

`%APPDATA%\THE WIRE 2` su Windows, `~/Library/Application Support/THE WIRE 2` su
macOS, `~/.config/the-wire-2` altrove. Dentro: `wire.vault` (le chiavi, cifrate),
`wire.history` (lo storico, cifrato), `wire.lock`, i file ricevuti cifrati, e la
cartella `electron` con la cache di Chromium, tenuta separata perché si può
cancellare senza perdere niente.

La variabile d'ambiente **`THE_WIRE_DATI`** sposta tutto quanto in un'altra
cartella. Serve a due cose: tenere i dati su un altro disco, e **provare due
programmi sullo stesso computer** — due identità, due depositi, due lock — che
altrimenti è impossibile, perché il lock del deposito e il profilo di Chromium
sono gli stessi:

```bash
THE_WIRE_DATI=C:\prova\A npx electron .
```

Il deposito si scrive in due tempi: prima su un file `.tmp` accanto, poi lo si
**rinomina** sopra quello vero. La rinomina è atomica su NTFS come su APFS, quindi
in qualunque istante sul disco c'è il vecchio intero o il nuovo intero, mai una
via di mezzo. (Prima il secondo passo era una riscrittura, che tronca il file e
poi lo riempie: un'interruzione lì dentro lasciava un deposito vuoto.)

## Il nome, e i nomi interni

Dal 2026-11-15 questa è **l'unica versione**: la 0.2.2 non sta più nella
cartella dei progetti e il programma si chiama THE WIRE, versione 2.1.0. Era
nata come "THE WIRE 2", programma a parte da tenere accanto alla precedente
finché era in prova, e di quella fase restano **due nomi interni che non vanno
cambiati**:

- la cartella dei dati è ancora `%APPDATA%\THE WIRE 2` (su Mac `THE WIRE 2`
  in Application Support): quella chiamata `THE WIRE` appartiene alla 0.2.2, con
  un deposito di formato diverso, e su un computer che l'ha avuta può esistere
  ancora;
- l'identificativo dell'installer è `com.mazzo.thewire2`, e il pacchetto si
  installa in `Programs	he-wire-2`: è ciò che permette all'installer nuovo di
  **aggiornare sul posto** l'app già installata, tenendo identità, contatti e
  storico. Cambiarlo farebbe comparire una seconda app accanto alla prima.

**L'identità della 0.2.2 non si eredita**: i due formati non sono compatibili.
Chi ce l'ha ancora installata può disinstallarla quando vuole; questo programma
non la tocca.

## L'app sul telefono, senza il PC

Nella versione precedente il telefono faceva da schermo a un computer acceso: il
PC serviva l'interfaccia in HTTP sulla rete di casa, e per raggiungerlo da fuori
serviva Tailscale. **Quella strada non esiste più.** Era il punto più debole del
programma — una pagina in chiaro su una rete condivisa — e teneva in piedi una
dipendenza da un servizio esterno per una cosa che si può fare senza.

Adesso il telefono ha un'app sua, con chiavi sue, che parla direttamente con i
relay: funziona a computer spento, e non c'è nessun server in ascolto in casa.

### Android: un'app vera, senza server e senza store

```bash
npm run android
```

Produce `android/app/build/outputs/apk/release/app-release.apk`, che si copia
sul telefono e si installa. Niente Play Store, niente account, **niente
indirizzo web**: i file stanno dentro il pacchetto e Capacitor li serve da
`https://localhost`, che il browser considera contesto sicuro. È il motivo per
cui funzionano la fotocamera (per inquadrare il QR) e le primitive
crittografiche senza un solo servizio esterno.

Serve una volta sola: un JDK e l'SDK Android. La firma è nel progetto
(`android/app/firma.jks`) — non serve a dire chi siamo a nessuno, serve perché
Android non installa un pacchetto non firmato. Cambiandola, il telefono tratta
l'app come un'altra e chiede di disinstallare la vecchia.

Due cose che Capacitor non fa da solo e che stanno in `MainActivity.java`: il
permesso `CAMERA` nel manifest, e la risposta alla richiesta della WebView.
Senza la seconda il mirino resta nero **senza dare errori**, perché dentro una
WebView `getUserMedia` non arriva da nessuna parte se nessuno la raccoglie.

### iPhone: si può, ma Apple mette il prezzo

Il progetto Xcode c'è (`ios/`), e `npm run ios:sync` lo aggiorna. Ma **Apple non
permette di installare app fuori dall'App Store**: con un ID gratuito l'app
scade dopo 7 giorni e va reinstallata dal Mac, con un account sviluppatore costa
99 dollari l'anno. Vedi `LEGGIMI-iphone.md`, scritto per l'assistente di chi ha
il Mac.

### La strada senza installare niente

```bash
npm run pwa
```

Produce `apps/pwa/sito`: file statici da mettere su un qualunque indirizzo
HTTPS. Dal telefono si apre quell'indirizzo e si aggiunge alla schermata Home —
funziona su Android e iPhone allo stesso modo, senza Mac e senza scadenze. Il
prezzo è quell'indirizzo web, che le due strade qui sopra non richiedono.

## Collegare il telefono all'account

**Verificato da capo a fondo il 2026-11-15, sullo stesso PC**: un programma
desktop (A), un secondo programma desktop (C, un contatto) e l'app del telefono
aperta in un browser dalla cartella `apps/pwa/sito`. Il telefono ha creato la
sua identità, si è collegato ad A con il codice incollato, ha ricevuto da A la
rubrica (C è comparso da solo), ha ricevuto il messaggio che C ha scritto ad A,
ha ricevuto la **copia** della risposta scritta da A, e quello che ha scritto il
telefono è arrivato a C e, come copia, sul PC di A. Niente server nostro, niente
Tailscale: solo i relay. Quello che il telefono **non** riceve sono i messaggi
scambiati prima del collegamento: lo storico non si copia, e non c'è un posto
da cui copiarlo che non sia l'altro dispositivo.


Chi ti scrive deve cifrare una volta per ogni tuo dispositivo, quindi il
telefono va aggiunto all'account. Sul computer: **DISPOSITIVI › COLLEGA UN
DISPOSITIVO**, che mostra un QR. Sul telefono: lo stesso pulsante, che invece
apre la fotocamera.

**Il QR contiene la chiave privata dell'account.** Chi fotografa lo schermo
mentre è visibile diventa un tuo dispositivo e legge tutto quello che ti
scrivono. Vale cinque minuti, e va mostrato il tempo di inquadrarlo.

Il codice è 657 caratteri, e a mano non si porta: dettarlo è fuori questione, e
mandarselo per email significherebbe consegnare quella chiave al servizio di
posta. Resta l'incolla, per chi lo ha spostato con mezzi suoi.

Il lettore è **jsQR**, non `BarcodeDetector`: quello lo farebbe il browser da
solo, ma su iOS non esiste — e il telefono è proprio il posto dove serve. Il
fotogramma viene ridotto a 720 px di lato prima di darlo in pasto: meno costa
troppo poco, ma provato con sfocatura e rumore a 480 px il codice non si legge
più se non riempie l'inquadratura. Dieci letture al secondo, non sessanta: il
codice sta fermo davanti, e la batteria si nota.

**Collegando un dispositivo il numero di sicurezza cambia** per tutti i tuoi
contatti. È fastidioso, ed è l'unica cosa che vi fa accorgere di un dispositivo
che non avete messo voi: se cambia senza che nessuno dei due abbia collegato
niente, è successo qualcosa.

## Eliminare messaggi

Tasto destro su un messaggio. Sui propri compaiono due voci, sugli altrui una
sola: **togliere dal dispositivo di qualcuno qualcosa che ha scritto lui non è
una funzione che questo programma offre**, e una richiesta del genere in arrivo
viene scartata.

**"Elimina per entrambi" è una richiesta, non un comando.** La esegue il
programma dell'altro perché è questo programma; un client modificato, o una
schermata già fatta, non si richiamano indietro. Il menu lo dice, invece di
lasciarlo credere.

Resta un segnaposto grigio *"Messaggio eliminato"*: un buco senza spiegazione si
legge peggio di una riga che dice cosa è successo.

Il testo sparisce **dai byte**, non solo dalla vista. Il registro è in sola
aggiunta, quindi svuotare un messaggio richiede di riscrivere il file — costa
quanto la conversazione è lunga, e si paga solo quando si elimina qualcosa. I
file allegati vengono cancellati dal magazzino cifrato.

**`mid`, il riferimento condiviso.** I due storici assegnano identificativi
propri allo stesso messaggio, quindi una richiesta di eliminazione non saprebbe
quale indicare. Ogni messaggio porta con sé il nome che ha nello storico di chi
lo manda, e chi riceve lo conserva in `origine`. Non prende il posto
dell'identificativo locale, apposta: un mittente che potesse sceglierlo
potrebbe farlo coincidere con un messaggio già presente e sovrascriverlo.

## File grandi: come regge, e fin dove

Sotto i 5 MB un file passa dalla mailbox come un messaggio. Sopra, va da computer
a computer su un collegamento diretto, e lì valgono tre cose che non erano ovvie.

**I pezzi sono grandi quanto la connessione permette.** Non una costante scelta
a mano: il limite lo dichiara `pc.sctp.maxMessageSize`, e si prende quello, fino
a 256 KB. Provato con due connessioni vere: il valore era 262144, e oltre quella
soglia `send()` **non dà errore ma i messaggi non arrivano**. Quattro volte più
grandi di prima significa un quarto delle chiamate: su 100 GB sono 400.000 pezzi
invece di 1.638.400.

**Chi riceve dice quando fermarsi.** Chi manda si ferma quando la propria coda di
uscita è piena — cioè quando i dati sono partiti, non quando sono stati scritti.
Se il disco è più lento della rete i pezzi si accumulavano in memoria dall'altra
parte senza limite: misurato, finivano tutti in attesa insieme. A 100 MB sono
133 MB e si passa; a 4 GB sarebbero stati 5,4 GB, e il programma moriva lasciando
*"collegamento non riuscito"* da una parte e *"non arrivato intero"* dall'altra.
Adesso chi riceve manda `PAUSA` sopra i 16 MB in attesa e `VAI` sotto i 4, e la
memoria trattenuta è la stessa per un file da 100 MB e per uno da 100 GB.

**Un trasferimento interrotto riprende da dove era.** Chi riceve tiene il file
parziale, legge dal disco quanti byte ha davvero — non dal registro, che può
essere indietro se il programma è stato chiuso di colpo — e lo dice a chi manda,
che riparte da lì. Un file interrotto resta in stato `atteso`, non `fallito`:
senza questo, su una linea da 1 MB/s un file da 100 GB richiederebbe 28 ore
ininterrotte, e non arriverebbe mai in fondo.

Il percorso del file parziale sta nel registro, e chi lo riprende non lo passa
dalla finestra: il processo principale lo cerca nello storico da sé, o un difetto
nella pagina basterebbe per farsi scrivere un file dove vuole.

**Quello che il programma non può aggirare:** un disco formattato FAT32 rifiuta
qualunque file oltre 4 GB. Non è un limite nostro, e non c'è modo di superarlo se
non salvando su NTFS o exFAT.

## Sessioni: perché sono più di una

Con ogni contatto si tiene **un elenco di sessioni**, non una sola: la propria
per scrivere, quelle accettate per leggere.

Non è un'astrazione gratuita, è la correzione di un difetto che ha reso muta una
conversazione reale. Se due persone si scrivono per prime nello stesso momento —
prima che il messaggio dell'altro sia arrivato — ciascuna apre una sessione sua
con X3DH. Ricevendo poi il primo messaggio dell'altro, `Session.accept`
**sostituiva** la propria: da quel momento ognuno cifrava con una sessione che
l'altro non aveva più, e ogni messaggio successivo veniva scartato in silenzio,
per sempre.

La parte peggiore era l'invisibilità: **la presenza non passa dal ratchet**,
quindi i due continuavano a vedersi online mentre non arrivava più niente.

Ora `Session.accept` accoda invece di sovrascrivere, e la decifratura prova
tutte le sessioni del contatto. Il tetto è otto per contatto. I depositi scritti
prima si leggono ancora: una stringa sola diventa un elenco di uno.

Le sessioni già perse non tornano, perché sono state cancellate su entrambi i
dispositivi. Per quelle c'è **RIAVVIA CIFRATURA** nella conversazione: butta le
sessioni senza toccare contatto, storico e verifica, e va premuto **da entrambe
le parti** — farlo da una sola aggiusta una direzione e lascia muta l'altra.

Copertura in `packages/core/test/incrocio.test.ts`.

## File

Il pulsante `+` accanto al campo di scrittura, o un file trascinato dentro la
conversazione. Il programma sceglie da solo la strada, in base al peso.

**Fino a 5 MB: dalla mailbox.** Il file viene spezzato in pezzi da 16 KB,
cifrati dal ratchet come qualsiasi messaggio, e arriva **anche se l'altro è
spento**. Le due misure non sono scelte a sentimento: provate sui cinque relay,
passano 16 KB utili per evento (54 KB sul filo dopo doppia cifratura e base64)
accettati da 5 relay su 5, mentre a 32 KB due rifiutano. La velocità sostenuta
misurata è di circa 59 KB/s, quindi 1 MB in 17 secondi.

**Oltre 5 MB: collegamento diretto fra i due computer.** WebRTC, nessun limite
di dimensione, e **i byte non toccano nessun relay**: dai relay passa solo la
segnalazione — descrizioni di sessione e candidati di rete — cifrata dal
ratchet come tutto il resto. In cambio serve che siate **collegati tutti e
due**: sopra la soglia, se l'altro è offline, il pulsante rifiuta subito e dice
di aspettare che il pallino si accenda. Il controllo avviene prima di leggere
un solo byte.

Chi riceve sceglie dove salvare **prima** che arrivi qualcosa, e i pezzi si
scrivono in coda: un file da due gigabyte non passa mai per la memoria.

**Il limite onesto del collegamento diretto:** senza un server di appoggio,
certe combinazioni di router non riescono a trovarsi. In quel caso il
trasferimento non parte e viene detto, invece di lasciare una barra ferma.

**Il server di appoggio, se lo si ha.** In DISPOSITIVI, sotto l'elenco, si può
scrivere un server **TURN** (`turn:host:porta` o `turns:host:porta`, utente e
password). ICE lo prova da solo come **ultima strada**, dopo quelle dirette:
quando le dirette bastano non si paga niente, e quando non bastano il relay fa
da tramite. **Basta che lo abbia uno solo dei due**: il candidato `relay` di una
parte si accoppia con l'indirizzo dell'altra. Il programma non ne porta uno suo
— sarebbe un server da pagare e da tenere acceso, cioè quello che il resto del
progetto evita — quindi serve il proprio (coturn su un VPS) o il piano gratuito
di un fornitore. Chi lo scrive sbagliato lo scopre subito: il controllo
(`packages/core/src/turn.ts`) sta nel cuore e rifiuta l'indirizzo prima che
finisca nel deposito, perché dentro Chromium un TURN sbagliato non dà errore,
semplicemente non c'è. La riga di diagnosi di un trasferimento fallito dice
`turn=assente` o `turn=nessun candidato`, così si sa dove guardare.

Perché non FilePizza, valutato il 2026-11-15: è la stessa tecnologia (WebRTC
data channel sopra STUN) con in più un server PeerJS per la segnalazione, Redis
e — per i NAT difficili — coturn. La segnalazione qui passa già cifrata dal
ratchet sui relay, i byte vanno su disco dal processo principale invece che da
un service worker, e ripresa e controllo di flusso ci sono già. L'unica cosa in
più era il TURN, ed è quella che è stata aggiunta.

I file arrivati dalla mailbox restano **cifrati** nella cartella dei dati, con
una chiave derivata da quella del deposito, e con un nome che non rivela niente:
chi apre quella cartella vede identificativi, non `referto.pdf`. Escono in
chiaro solo dove l'utente preme SALVA.

Verificato: 8 MB e 64 MB trasferiti su una connessione WebRTC vera fra due
processi, identici byte per byte. Il primo tentativo perdeva 3 MB su 8, perché
la connessione veniva chiusa mentre la coda di uscita non era ancora vuota;
adesso chi manda aspetta che la coda si svuoti **e** che l'altro confermi.

**Non c'è nei gruppi:** lo stesso file andrebbe spedito una volta per membro.
**Dal telefono** si mandano solo file fino a 5 MB: il collegamento diretto
esiste solo fra due computer.

**I candidati di rete si tengono da parte finché la connessione esiste.** Chi
manda spedisce offerta e candidati nello stesso istante, e sui relay arrivano in
meno di un secondo; chi riceve in quel momento sta ancora scegliendo dove
salvare, e la connessione non c'è. Prima quei candidati venivano scartati, e la
diagnosi a fine attesa diceva `suoi=0`: nessuna coppia da provare, collegamento
mai tentato — il sintomo osservato su un trasferimento vero, con entrambi online
e il NAT a posto. Ora aspettano in `candidatiInAttesa` e entrano appena la
descrizione remota è impostata; vale anche dal lato di chi manda, dove un
candidato può precedere la risposta sui relay. Copertura in
`apps/pwa/test/candidati-in-attesa.test.ts`, che carica `ui/diretto.js` vero.

## Cosa non c'è ancora

- **File nei gruppi.**
- **Aggiungere membri a un gruppo già creato** (si scelgono alla creazione).
- **Chiamate e condivisione schermo.**

## Superficie d'attacco

Chi può fare cosa, e con quale sforzo.

**Il relay** vede: un involucro cifrato, l'indirizzo Nostr del destinatario, e
l'ora. Non vede il contenuto (doppia cifratura), non vede il mittente
(l'involucro NIP-59 è firmato da una chiave usa-e-getta), non sa che i due
indirizzi si stanno parlando — a meno di correlare i tempi. **Questa è la cosa
che un osservatore paziente può davvero ricavare: chi riceve, e quando.**

**Chi sta sulla stessa rete** non vede niente: verso i relay si parla WSS, e
non c'è più nessun server in ascolto sulla rete di casa. Il pannello TELEFONO —
che serviva l'interfaccia in HTTP e per questo era il punto più debole del
programma — non esiste più: il telefono ha un'app sua, con chiavi sue, che
parla direttamente con i relay. Con lui è sparita anche la dipendenza da
Tailscale, che serviva solo a raggiungere quel server da fuori casa.

**Chi ha il tuo computer** trova il deposito cifrato con Argon2id (64 MB, 3
passate). Contro chi lo sequestra, tutto dipende dalla passphrase: il programma
ne chiede una di **almeno 12 caratteri**, ma dodici sono un minimo, non un
consiglio: contro hardware serio conta quanto è lunga davvero. Finché l'app è
aperta la chiave sta in memoria, ma **dopo dieci minuti
senza nessuno l'account si blocca da solo**: la chiave viene azzerata e si
torna alla schermata della passphrase.

**Una falla nella pagina** sarebbe la strada più corta all'account, perché
`window.wireApi` sa mandare messaggi e leggere file. Difese in ordine:
`contextIsolation` isola la pagina da Node; `sandbox: true` chiude il processo
nella sandbox del sistema; una **CSP `default-src 'none'`** vieta codice e
connessioni verso l'esterno; `will-navigate` impedisce di portare la finestra
su una pagina esterna, che si ritroverebbe il preload agganciato. Gli stili
inline non esistono più — ogni `style="..."` è diventato una classe — quindi la
CSP vieta anche il CSS iniettato, non solo il codice.

**La finestra non conosce i percorsi dei file.** Quando scegli dove salvare,
riceve un gettone; a quale file corrisponda lo sa solo il processo principale.
Il gettone si chiude quando il trasferimento finisce, in un modo o nell'altro:
lasciarlo valido significava tenere aperto un permesso di scrittura per tutta
l'accensione. E il nome proposto nella finestra di salvataggio passa da
`nomeFileSicuro`, che toglie separatori, punti iniziali, caratteri di controllo
e i nomi di periferica di Windows — con i suoi test.

**Il limite di quella CSP:** `connect-src 'none'` non governa WebRTC — è una
lacuna nota della specifica, e non si può chiudere senza rinunciare al
trasferimento diretto dei file, che WebRTC lo usa.

**Il Double Ratchet** è un'implementazione originale sopra primitive audite.
Non è stato sottoposto a revisione esterna, e un difetto in quella macchina a
stati ha già reso muta una conversazione reale (vedi la sezione sulle sessioni).
Quel difetto perdeva messaggi, non li esponeva — ma è il promemoria di cosa
significa l'avvertenza qui sotto.

## Avvertenza

Il Double Ratchet qui è un'implementazione originale sopra primitive audite,
scritta e testata con cura ma **non sottoposta a revisione esterna**. Va bene
per due amici che si scambiano messaggi. Non usarlo dove la riservatezza è
questione di sicurezza personale: per quello esiste Signal.
