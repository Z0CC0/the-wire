# THE WIRE — costruire l'app per macOS

Dai questo file a Claude (o a un altro assistente) su un Mac e digli:
**"fai quello che è scritto in LEGGIMI.md"**.

In fondo trovi anche i comandi per farlo a mano.

---

## Cosa deve venirne fuori

Un file `.dmg` dentro `progetto/release/`. Si apre con doppio clic e si trascina
`THE WIRE` nelle Applicazioni.

**Se c'e' gia' una "THE WIRE 2" (o la 0.1.0) installata**, va tolta dalle
Applicazioni e al suo posto si mette questa: dalla 0.1.1 l'identificativo e'
`com.mazzo.thewire` e la cartella dei dati `THE WIRE`. I dati non si perdono:
al primo avvio la cartella `THE WIRE 2` in Application Support viene rinominata
in `THE WIRE`, con identita', contatti e storico. Per scriversi, entrambe le
persone devono stare su questa versione.

**La vecchia THE WIRE 0.2.2**, se e' ancora installata, e' un programma a parte
con un deposito incompatibile: non viene toccata e la sua identita' non si
eredita. Si puo' disinstallare quando si vuole.

**Perché serve un Mac:** il pacchetto `.app` e l'immagine `.dmg` si costruiscono
solo su macOS — richiedono strumenti Apple che su Windows non esistono. Il file
`.exe` per Windows su un Mac non si apre: sono formati di eseguibile diversi,
non è una questione di permessi.

---

## ISTRUZIONI PER L'ASSISTENTE

Esegui i passi nell'ordine. Se uno fallisce, **fermati e spiega all'utente**:
non tirare avanti a caso.

### 1. Verifica di essere su macOS

```bash
uname -s   # deve stampare: Darwin
```

Se stampa altro, **fermati**: il pacchetto macOS da lì non si può costruire.

### 2. Verifica Node.js

```bash
node -v    # serve la 20 o superiore, meglio la 22
```

Se manca o è vecchio: `brew install node`, oppure l'installer LTS da
https://nodejs.org

Non serve altro: nessun Xcode, nessun compilatore, nessuna libreria di sistema.
La crittografia è TypeScript puro, senza dipendenze native.

### 3. Installa le dipendenze

```bash
cd progetto
npm install
```

Compaiono **quattro avvisi `npm warn deprecated`** (`inflight`, `rimraf`, `glob`,
`boolean`). Sono attesi e innocui: arrivano tutti da dentro `electron-builder`,
non da questo progetto, e nessuno è una vulnerabilità. `npm audit` deve dire
**`6 moderate severity vulnerabilities`**, tutte `minimatch` dentro
`electron-builder`: sono attese, stanno nello strumento di build e non nel
pacchetto, e non vanno "corrette" con `--force` (riporterebbe `electron-builder`
alla 25). Se compare **qualunque altra riga** — Electron, Capacitor, vitest —
riportalo.

Il comando scarica anche il binario di Electron (circa 100 MB), quindi la prima
volta richiede qualche minuto e una connessione. Da Electron 42 quel download
non è più automatico: lo fa il `postinstall` di questo progetto. Se `npm install`
finisce e la cartella `node_modules/electron/dist` non esiste, il download è
fallito — riprova, non proseguire.

### 4. Esegui i test — non saltare questo passo

```bash
npm test
```

**Devono passare tutti (247).** Se uno è rosso, fermati e riporta quale: è
crittografia, un test rosso vale più di un pacchetto pronto. Unica eccezione:
un test che fallisce con `Test timed out in 20000ms` su una macchina carica.
Quelli creano più identità con Argon2id (64 MB l'una) in parallelo e possono
sforare il tempo: rilancia da solo il file che ha sforato, per esempio
`npx vitest run packages/core/test/group.test.ts`. Se da solo passa, va bene.

### 4b. Se vuoi vedere subito la finestra, senza costruire il pacchetto

```bash
npm run desktop
```

Apre l'app direttamente dai sorgenti. Utile per un controllo veloce, ma il file
da consegnare all'utente resta il `.dmg` del passo dopo.

**Non lanciare `electron` a mano su una cartella.** Il programma vero è un file
CommonJS costruito da `npm run pack`; puntare Electron altrove produce
`ReferenceError: __dirname is not defined in ES module scope`. Usa gli script
`npm run`, che fanno le cose nell'ordine giusto.

### 5. Costruisci il pacchetto

```bash
npm run dist:mac
```

Qualche minuto. I `.dmg` finiscono in `release/`. Vengono costruiti sia
**arm64** (Mac con chip Apple M1/M2/M3/M4) sia **x64** (Mac Intel).

Per fare solo il proprio:

```bash
uname -m                                                  # arm64 oppure x86_64
npx electron-builder --mac dmg --arm64 --publish never    # Apple Silicon
npx electron-builder --mac dmg --x64   --publish never    # Intel
```

### 6. Verifica che parta

```bash
open "release/mac-arm64/THE WIRE.app"       # su Intel: release/mac/
```

Deve aprirsi una finestra nera col logo **THE WIRE** e la schermata
`PRIMO AVVIO · v0.1.2`. Se compare invece un riquadro "A JavaScript error
occurred in the main process", riporta il testo esatto all'utente: significa che
qualcosa nel pacchetto non ha funzionato, e il messaggio dice cosa.

### 7. Riferisci all'utente

Dì dove sta il `.dmg` e riporta i punti della sezione qui sotto.

---

## COSE CHE L'UTENTE DEVE SAPERE

### Gatekeeper: la prima apertura

L'app **non è firmata** con un certificato Apple (servirebbe un account
sviluppatore da 99$/anno), quindi macOS dirà che lo sviluppatore non è
identificato.

Si supera una volta sola: **tasto destro sull'app → Apri → Apri**.

Il doppio clic normale non basta, serve la voce Apri dal menu contestuale. Se
macOS insiste:

```bash
xattr -cr "/Applications/THE WIRE.app"
```

Non è un difetto del programma: è come macOS tratta qualunque app distribuita
fuori dall'App Store senza firma.

### Al primo avvio

L'app genera le chiavi in locale e chiede una passphrase per cifrarle. **Nessuna
registrazione**: non esiste un posto dove si sia iscritti.

La generazione richiede **2-3 secondi** su "GENERO LE CHIAVI…": è Argon2id che
lavora, ed è voluto — è quello che rende inutile provare miliardi di passphrase
su un file rubato. Non è bloccata.

**Se si perde la passphrase, l'identità è persa.** Nessuno può recuperarla: non
c'è un server con una copia.

### Per scriversi con qualcuno

1. Pannello NUOVO: mostra la propria card, una riga che comincia con `wire:1:`
2. Ci si scambia quella riga, su qualunque canale
3. Si incolla nel campo del pannello NUOVO, con un nome
4. **Poi si confronta il numero di sicurezza a voce**: 60 cifre che
   devono coincidere sui due schermi. È l'unico momento in cui si esclude
   davvero che qualcuno stia in mezzo. Se coincidono, si conferma.

I messaggi passano da relay pubblici e gratuiti, arrivano anche se l'altro è
offline, e il relay non vede né il contenuto né chi scrive a chi.

**I relay sono volontari:** che uno o due non rispondano è normale. Basta che
uno accetti. Se l'invio fallisce del tutto, l'app lo dice dentro la
conversazione e il testo scritto resta nel campo.

### Mandare file

Il pulsante `+` accanto al campo di scrittura, oppure si trascina il file dentro
la conversazione.

Fino a **5 MB** il file arriva anche se l'altro è spento: viene spezzato e
passa dagli stessi relay dei messaggi. Oltre i 5 MB serve un collegamento
diretto fra i due computer, che esiste solo mentre siete **collegati tutti e
due**: se l'altro è offline il programma lo dice subito, prima di cominciare.
Non c'è limite di dimensione su quella strada, e i dati non toccano nessun
server — vanno da un computer all'altro.

Chi riceve un file grosso sceglie dove salvarlo prima che arrivi. I file
piccoli restano cifrati dentro il programma finché non si preme SALVA.

Su alcune combinazioni di router il collegamento diretto non riesce a
stabilirsi: in quel caso il trasferimento non parte e viene detto. L'avviso
contiene una riga di diagnosi (`ice=…, miei host=… srflx=…, suoi=…, turn=…`):
se un trasferimento fallisce, quella riga va copiata per intero e riportata.

Chi ha un server TURN (il proprio, o quello di un fornitore) lo scrive in
**DISPOSITIVI**, in fondo: indirizzo `turn:host:porta`, utente e password.
Basta che lo abbia uno solo dei due. Senza, resta tutto come prima.

### Se lo vedi online ma i messaggi non arrivano

Nella conversazione c'è il pulsante **RIAVVIA CIFRATURA**. Serve esattamente a
quel sintomo, che nelle versioni fino alla 0.1.6 poteva capitare quando due
persone si scrivevano per la prima volta nello stesso momento.

Non cancella niente: restano il contatto, tutto lo storico e il numero di
sicurezza già confrontato. Riparte solo la cifratura.

**Va premuto da tutte e due le parti.** Se lo fa uno solo, si aggiusta una
direzione e l'altra resta muta.

### Il pallino online

Accanto a ogni contatto c'è un pallino: acceso vuol dire che in questo momento è
collegato, spento che non lo è, e sotto al nome compare da quanto non si fa vivo.

Funziona con un piccolo segnale che i due programmi si scambiano ogni 45
secondi. Non contiene niente ed è cifrato come tutto il resto. Se sparisce per
due minuti e mezzo il pallino si spegne da solo — qualche segnale perso è
normale sui relay pubblici, e serve perderne tre di fila prima che qualcuno
risulti offline.

Non consuma la conversazione: quel segnale viaggia su un canale suo e non viene
mai ripescato all'avvio. Chi tiene il programma chiuso per giorni non si ritrova
niente da smaltire quando lo riapre.

### Il telefono

Non è più uno schermo del Mac: ha un'app sua, con chiavi sue, che funziona a
computer spento. Per l'iPhone vedi `LEGGIMI-iphone.md`. Si collega all'account
dal pannello DISPOSITIVI, inquadrando un QR mostrato dal Mac.

---

## SE QUALCOSA VA STORTO

**`npm install` fallisce** — di solito Node è troppo vecchio: `node -v`, serve 20+.

**`npm test` fallisce** — non costruire il pacchetto. Riporta quale test è rosso.

**"Build for macOS is supported only on macOS"** — non sei su un Mac: `uname -s`.

**Il DMG si crea ma l'app non si apre** — lancia il binario dal terminale per
vedere l'errore vero:

```bash
"release/mac-arm64/THE WIRE.app/Contents/MacOS/THE WIRE"
```

**"App danneggiata" / "sviluppatore non identificato"** — è Gatekeeper, vedi
sopra. Non è danneggiata.

**I messaggi non partono** — controlla la connessione e riprova col pulsante di
aggiornamento in alto a sinistra.

---

## COMANDI, IN BREVE

```bash
cd progetto
npm install
npm test
npm run dist:mac
open release/mac-arm64/"THE WIRE.app"
```

Il `.dmg` da conservare e installare sta in `release/`.

---

## COS'È QUESTO PROGRAMMA

Messaggistica cifrata da persona a persona. Nessun account, nessun server da
pagare, nessuna azienda in mezzo. Le chiavi restano sul dispositivo di chi le
genera.

X3DH per aprire la conversazione, poi Double Ratchet: chiave nuova a ogni
messaggio, forward secrecy e post-compromise security. Primitive da `@noble/*`,
che sono audite.

**Avvertenza onesta:** la macchina a stati del Double Ratchet è
un'implementazione originale, testata con cura ma **non sottoposta a revisione
esterna**. Va bene per scriversi fra amici. Non è il programma da usare dove la
riservatezza è questione di sicurezza personale — per quello esiste Signal.

Dettagli tecnici in `progetto/docs/ARCHITETTURA.md`.
