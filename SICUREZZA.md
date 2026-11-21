# THE WIRE — stato della sicurezza

Questo documento serve a chi vuole verificare il programma invece di crederci.
Descrive cosa è protetto, con cosa, e — soprattutto — **cosa non lo è**. Ogni
affermazione qui dentro è verificabile nel codice; dove indico un file, quella è
la riga da leggere.

Versione: 0.1.3 — decifratura del ratchet atomica, tetto alle chiavi saltate, test sotto stress; pacchetti Linux. (0.1.2: relay personali firmati nella card, riserva, storico al dispositivo nuovo, backup. 0.1.1: nomi interni definitivi, vedi `docs/ARCHITETTURA.md`.)

---

## In una riga

Il contenuto dei messaggi è cifrato punto-a-punto e nessuno dei server
attraversati può leggerlo. Quello che un osservatore paziente **può** ricavare è
il grafo: chi riceve, e quando. Chi ha in mano il computer trova un deposito
cifrato la cui resistenza dipende interamente dalla passphrase scelta.

---

## Cosa protegge, e come

**Il contenuto dei messaggi.** Cifratura punto-a-punto con X3DH per la prima
stretta di mano e Double Ratchet per il seguito (`packages/core/src/ratchet.ts`,
`session.ts`). Primitive: X25519, Ed25519, XChaCha20-Poly1305, HKDF-SHA256 —
tutte da `@noble`, non implementate a mano. Ogni messaggio ha una chiave sua:
chi ne compromette una non legge i precedenti né i successivi.

**Chi sta parlando.** Le buste verso i relay usano NIP-59 gift wrap: l'involucro
esterno è firmato da una chiave usa-e-getta, quindi il relay non vede il
mittente. Il destinatario sì.

**Il deposito sul disco.** Chiave derivata dalla passphrase con Argon2id,
64 MB di memoria, 3 passate (`packages/core/src/keystore.ts`, costante `KDF`).
Sono parametri seri per un attacco offline — ma vedi il limite più sotto.

**La finestra dell'applicazione.** `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, CSP `default-src 'none'`,
`will-navigate` bloccato (`apps/desktop/src/main.ts`). Gli stili inline non
esistono: ogni `style="..."` è una classe, quindi la CSP vieta anche il CSS
iniettato, non solo il codice.

**Il blocco automatico.** Dopo dieci minuti senza nessuno l'account si blocca da
sé: la chiave viene azzerata e si torna alla passphrase
(`apps/desktop/src/main.ts`, `BLOCCO_DOPO_MS`). "Nessuno" tiene conto anche del
telefono, che altrimenti si vedrebbe bloccare l'app sotto le dita.

**Niente server in ascolto.** Il programma non apre nessuna porta e non
risponde a nessuno sulla rete di casa. Il pannello TELEFONO, che serviva
l'interfaccia in HTTP al telefono, **è stato tolto**: era la superficie
d'attacco più larga del programma, e con lui è sparita anche la dipendenza da
Tailscale. Il telefono adesso ha un'app sua, con chiavi sue, che parla
direttamente con i relay e funziona a computer spento.

**I nomi dei file in arrivo.** Sanificati prima di finire in una finestra di
salvataggio (`packages/core/src/nomefile.ts`): niente separatori di percorso,
niente nomi che iniziano per punto, niente byte di controllo.

---

## Cosa NON protegge

Questa sezione conta più di quella sopra.

**Il grafo delle conversazioni.** Il relay vede un involucro cifrato, l'indirizzo
di chi riceve, e l'ora. Non vede il contenuto e non vede il mittente, ma chi
osserva a lungo abbastanza può correlare i tempi e dedurre che due indirizzi si
stanno parlando. **Questo è il limite strutturale del programma**, e non si
risolve senza cambiare trasporto (mixnet, o traffico di copertura costante).

**Una passphrase corta.** Il minimo accettato è **12 caratteri**, alzato da 8
(`packages/core/src/keystore.ts`, `MIN_PASSPHRASE`). Il controllo sta nel cuore
e non solo nella pagina, perché la pagina si può aggirare. Argon2id con questi
parametri rende ogni tentativo costoso, ma la passphrase resta l'unica difesa
che regge quando il computer è stato sequestrato: dodici caratteri sono un
minimo, non un consiglio. Chi si aspetta davvero quello scenario ne scelga una
lunga.

**I metadati dei file grandi.** I file oltre 5 MB passano da un collegamento
diretto fra i due computer (WebRTC, `ui/diretto.js`). Per stabilirlo si usano
server STUN pubblici (Google, Cloudflare, Nextcloud), che vedono gli indirizzi
IP dei due capi. Il contenuto non passa di lì, gli indirizzi sì.

**Il server TURN, se l'utente ne scrive uno.** È facoltativo e di default non
c'è. Quando c'è e le strade dirette falliscono, **i byte passano da lì**:
cifrati da DTLS come su qualunque canale WebRTC, quindi chi gestisce il TURN
vede gli indirizzi IP dei due, l'ora, il volume, e un flusso che non può
leggere. Le credenziali stanno nel deposito cifrato (`rete.turn`), non in
chiaro su disco; la pagina le riceve perché è lei a creare la connessione. Chi
sceglie il TURN di un fornitore gli affida questi metadati: va saputo prima di
scriverlo. Il controllo del valore (`packages/core/src/turn.ts`) sta nel cuore.

**Un attaccante che ha già il controllo del computer acceso e sbloccato.** Non
c'è difesa, e non ce n'è in nessun programma di questo tipo.

**Il fatto che tu usi questo programma.** Il traffico verso i relay Nostr è
riconoscibile come tale da chi osserva la rete.

---

## Il pannello TELEFONO non c'è più

Tre delle sei vulnerabilità segnalate — VULN-01, VULN-02, VULN-06 — stavano nel
server che serviva l'interfaccia al telefono. Erano state corrette; poi quel
server è stato **tolto del tutto**, perché faceva una cosa che l'app sul
telefono fa meglio: quella ha chiavi sue e funziona a computer spento, mentre il
pannello richiedeva un PC acceso, una pagina servita in HTTP e — per l'uso fuori
casa — Tailscale.

Con lui sono spariti: il server HTTP, il canale cifrato che lo proteggeva, il
token nel QR, le regole del firewall di Windows, e ogni riferimento a Tailscale.
**Il programma non apre più nessuna porta.**

Resta scritto qui sotto cosa erano quei difetti, perché il rapporto li elenca e
chi lo rilegge deve poterli ritrovare — ma il codice a cui si riferiscono non
esiste più.

## L'app sul telefono, e perché non le serve HTTPS

L'app Android non è una pagina web che si scarica: i file stanno **dentro** il
pacchetto, e vengono serviti da `https://localhost`. Il browser tratta quella
origine come contesto sicuro, quindi cifratura e fotocamera funzionano senza un
solo indirizzo esterno, senza certificati e senza servizi di terzi.

Questo chiude, per la strada Android, il problema che restava aperto: non c'è
più nessuna pagina che viaggia in chiaro e che qualcuno possa sostituire.

Cosa la difende, e cosa no:

- **Non c'è nessuna porta aperta.** L'app parla verso i relay, nessuno parla
  verso di lei.
- **I permessi sono due:** rete e fotocamera. La fotocamera serve solo a
  inquadrare il codice di collegamento; la richiesta della WebView viene
  concessa **solo** per il video, e ogni altra — microfono compreso — viene
  rifiutata (`MainActivity.java`).
- **La firma del pacchetto è nostra e sta nel progetto.** Non certifica chi
  siamo: serve perché Android non installa un pacchetto non firmato. Chi
  ricostruisce l'app con una firma diversa produce, per il telefono, un'altra
  app.
- **Chi ha in mano il telefono sbloccato** ha accesso all'app, come su
  qualunque programma di questo tipo. Il deposito sul telefono è cifrato con la
  stessa passphrase.

Su iPhone la stessa app esiste, ma va installata da un Mac: Apple non consente
altro. Chi non vuole passare di lì usa la PWA, e lì il discorso cambia — vedi
sotto.

### La PWA, e il rischio che resta

Questa strada non installa niente: l'app arriva da un indirizzo web. Il traffico
è HTTPS, quindi nessuno la legge né la modifica lungo la strada; ma **chi
controlla quell'indirizzo può cambiare l'app**, e un'app modificata può mandare
le chiavi dove vuole.

Non si elimina, si restringe. Due cose lo fanno:

**L'app parte dalla copia installata, non dal sito.** Il service worker serve i
file già sul telefono e non li riscarica. Una manomissione del sito raggiunge
solo chi installa in quel momento: chi ce l'ha già resta con la sua copia. Prima
li riscaricava a ogni apertura, e la finestra di rischio non si chiudeva mai.

**Un cambiamento si vede.** All'apertura si confrontano le impronte pubblicate
con quelle installate; se differiscono compare una barra che lo dice, e
l'aggiornamento entra solo se qualcuno lo accetta. Il confronto è sui contenuti
e non sulla data, quindi si accorge anche di un file cambiato senza che la
versione lo sia — che è esattamente come si presenterebbe una manomissione.

Resta questo, e va detto: **chi installa per la prima volta si fida
dell'indirizzo**, e non ha modo di accorgersi di niente. Per quel momento
l'unica difesa è la sicurezza dell'account da cui l'app è pubblicata.

## Perché la correlazione temporale non si chiude con Tor

Domanda ragionevole: far girare i messaggi come fa Tor. La risposta è che Tor
risolve un problema **diverso** da quello che abbiamo.

Tor nasconde al relay l'indirizzo IP di chi si collega. Utile, ma il nostro
punto debole non è quello: è che il relay vede *quando* arriva una busta e *per
chi*. Chi osserva le due estremità correla i tempi anche quando tutto è cifrato
e anche quando passa da Tor — è un limite noto della cifratura a bassa latenza,
non una mancanza dell'implementazione.

Ciò che ridurrebbe davvero la correlazione è altro: ritardi casuali prima di
spedire, e traffico di copertura costante — buste finte indistinguibili da
quelle vere, mandate anche quando non si scrive a nessuno. Funziona solo se il
volume è costante, cioè se l'app manda buste finte **anche mentre è chiusa**.
Su un telefono, senza un server che la svegli, non è possibile; e ogni ritardo
introdotto è un messaggio che arriva più tardi. È il motivo per cui questa
strada non è stata presa: costerebbe l'immediatezza e la batteria, e senza
volume costante non darebbe la protezione che promette.

## Risposta al controllo esterno del 29 agosto 2026

Un controllo indipendente ha segnalato sei punti. Cinque erano veri e sono
corretti; uno non era sfruttabile, ed è stato rinforzato lo stesso.

**VULN-02 — rigioco delle richieste dal telefono. Era vero, ed era il più
serio. Oggi il codice che lo conteneva non esiste più.** La cifratura impedisce di *capire* una busta, non di *rimandarla*:
chi ascolta la rete poteva rispedire identica una richiesta già vista e farla
eseguire di nuovo. Provato prima di correggere — un messaggio inviato una volta
partiva due volte. Ora ogni busta porta dentro, nella parte cifrata, una
sessione e un numero che cresce; il computer rifiuta quelle già viste con un
`409`. Non si usano orari: orologi diversi fra computer e telefono avrebbero
fatto smettere di funzionare il collegamento senza che nessuno capisse perché.

**VULN-03 — la verifica restava valida dopo un cambio di dispositivi. Era
vero.** Il numero di sicurezza copre l'insieme dei dispositivi, quindi cambia
quando il contatto ne collega uno; ma la schermata continuava a dire
"verificata". Restava tolto proprio il segnale che fa accorgere di un
dispositivo non messo da voi. Ora la verifica si azzera quando l'insieme cambia
davvero — le impronte si confrontano, così un annuncio identico non la tocca — e
nella conversazione compare una riga che dice cosa è successo e cosa fare.
*Correzione nella 0.1.2:* quel confronto era fatto fra due `Uint8Array` con
`===`, che in JavaScript confronta i riferimenti e non i byte: era sempre
"diverso", e ogni annuncio di dispositivi — anche identico — toglieva la
verifica. Nessun test lo coglieva perché nessuno mandava un annuncio identico.
Ora si confrontano in esadecimale, e `relay.test.ts` manda un annuncio che
cambia solo i relay e pretende che la verifica resti.

**VULN-05 — i permessi di scrittura non venivano chiusi. Era vero.** Ogni file
in arrivo riceve un gettone, che è il permesso di scrivere in un punto preciso
del disco. Non veniva mai chiuso: restava valido per tutta l'accensione. Ora la
finestra lo chiude a fine trasferimento — riuscito, fallito o annullato — e
comunque non se ne tengono più di 32.

**VULN-04 — nomi di periferica di Windows. Era vero.** `CON`, `NUL`, `COM1` e
simili non sono file: scrivere su `NUL` butta via tutto in silenzio, e chi
riceve crede di aver salvato. Ora sono neutralizzati, con attenzione a non
rovinare nomi legittimi come `console.log` o `nullo.txt`.

**VULN-06 — blocco per tentativi senza scadenza. Era vero, e il rischio vero
era l'opposto di quello segnalato. Anche questo era nel pannello, ora rimosso.** Non tanto la memoria: un blocco che non
scade è un blocco per sempre, e due telefoni dietro lo stesso indirizzo — cosa
normale sulla rete dati — potevano chiudersi fuori a vicenda fino allo
spegnimento del server. Ora si dimentica dopo un quarto d'ora di silenzio.

**VULN-01 — uscita dalla cartella dell'interfaccia. Segnalata come ALTA, ma non
era sfruttabile, e riguardava anch'essa il pannello ora rimosso.** Il controllo sul prefisso era effettivamente scritto male,
però il percorso passa prima da `new URL()`, che toglie i `..` — provato con
otto codifiche diverse (`..`, `%2e%2e`, `%2f`, doppia codifica, barre
rovesciate): nessuna arriva fuori. Il controllo è stato comunque corretto,
perché non deve dipendere da una difesa che sta in un altro punto del file e
che un domani potrebbe cambiare.

**Un'ottava, trovata provando a mandare un file da 4 GB:** il trasferimento non
arrivava mai in fondo — chi mandava vedeva "collegamento non stabilito", chi
riceveva "non arrivato intero". La causa: l'avanzamento veniva scritto nel
registro a ogni pezzo da 64 KB, e ogni scrittura rilegge e decifra tutto il
registro. Misurato: da 2 a 13 millisecondi per aggiornamento in milleseicento
pezzi, con costo che cresce da solo. Su 4 GB i pezzi sono 65.536, e il conto
arriva a ore. Ora l'avanzamento vive in memoria e sul disco va solo lo stato
finale; il file di destinazione resta aperto invece di essere riaperto a ogni
pezzo (24 secondi contro 3, su 4 GB); e l'attesa della conferma finale passa da
20 secondi a 2 minuti, perché chi riceve può avere ancora molto da scrivere.

**Una settima cosa, non nel rapporto:** il pulsante MOSTRA non ha mai
funzionato. Nello storico finisce il percorso vero, ma il codice lo cercava fra
i gettoni — che sono un'altra cosa — e falliva sempre. Corretto.

Tutte e sette hanno ora un test che le copre. Quello sulla verifica è stato
controllato al contrario: tolto il rimedio, il test fallisce.

## Cosa è cambiato nella 0.1.3

Due difetti nel ratchet, trovati scrivendo i test sotto stress
(`packages/core/test/ratchet-robustezza.test.ts`) e corretti in
`packages/core/src/ratchet.ts`:

1. **La decifratura non era atomica.** Il giro di DH e l'avanzamento della
   catena avvenivano *prima* del controllo del tag: una busta manomessa, o
   consegnata alla sessione sbagliata, lasciava la sessione avanzata su una
   catena che l'altro non ha, e da lì niente si apriva più. L'Account si
   difendeva decifrando su una copia serializzata della sessione, quindi
   nell'app il difetto non si vedeva; ma la garanzia stava nel chiamante, non
   nella funzione. Ora `ratchetDecrypt` lavora su una copia dello stato e la
   applica solo se la decifratura riesce. Il test gira un bit in una busta nel
   mezzo, e a cavallo di un giro di DH, e pretende lo stato identico byte per
   byte e il messaggio dopo leggibile.
2. **Le chiavi saltate non avevano un tetto complessivo.** `MAX_SKIP` limita un
   salto solo; un contatto poteva mandare una catena nuova dopo l'altra,
   ciascuna con mille messaggi "persi", e far crescere stato e deposito senza
   fine. Ora si tengono le ultime 2000 (`MAX_SKIPPED_TOTAL`, come Signal) e le
   più vecchie si lasciano andare.

I test sotto stress: 300 messaggi con mittente a caso, consegne in ordine a
caso con fino a venti buste in volo, 3% di perdite, doppioni rimandati, stato
salvato e ricaricato a metà, quattro semi diversi; 200 buste di byte a caso
che non devono produrre altro che un errore e non devono toccare lo stato; il
confine esatto di `MAX_SKIP`. Non è una revisione esterna, e il README continua
a dirlo: è il modo di togliere al ratchet gli errori che una macchina a stati
fa di solito.

## Cosa è cambiato nella 0.1.2

1. **I relay viaggiano nella card, firmati.** La voce di ogni dispositivo può
   portare la lista dei relay su cui ascolta; la firma della chiave d'account
   la copre (`WIRE-DISPOSITIVO-2` in `packages/core/src/dispositivi.ts`), così
   un relay sostituito per strada non passa. Le voci senza relay restano valide
   con la forma di prima. I relay **non** entrano nel numero di sicurezza:
   coprono dove si ascolta, non chi si è, e cambiarli non deve far perdere la
   verifica. Cosa concede: un contatto vede su quali relay ascolti, e un relay
   che hai scelto tu vede ciò che vedono tutti gli altri — busta, destinatario,
   ora — in più vede che quel destinatario l'hai scelto tu. Solo `wss://`: in
   chiaro si rifiuta (`relay.ts`).
2. **Riserva automatica.** Tre relay in più, usati solo quando nessuno dei
   normali risponde. Entrano da entrambe le parti, quindi sono un punto
   d'incontro; e sono stati misurati (29 relay pubblici provati con un gift wrap
   da 54 KB il 2026-11-21: tre accettano, ventuno no). Il battito non li usa.
3. **Lo storico passa al dispositivo nuovo.** Solo da un proprio dispositivo
   (`sender.id === this.id`), dentro il ratchet, a pezzi come un file sulla
   mailbox, con impronta. Chi riceve rivalida campo per campo: identificativi,
   lunghezze, gruppi passati dalla stessa validazione di un gruppo che arriva da
   un contatto. I file arrivano come righe senza byte.
4. **Backup.** `packages/core/src/backup.ts`: il deposito così com'è — vault
   cifrato con Argon2id, storico e file con le chiavi derivate — in un file
   solo. Niente in chiaro dentro (`backup.test.ts` lo cerca). Si ripristina
   solo su un deposito vuoto; alla prima apertura le sessioni per scrivere si
   riaprono con X3DH, perché quelle nel backup sono ferme e riusarle vorrebbe
   dire riusare numeri di messaggio. Nomi di voce diversi da quelli del deposito
   non si scrivono.

## Cosa è cambiato nella 0.1.0

Rispetto alla 1.x, in ordine di importanza:

1. **Il pannello TELEFONO è stato tolto**, e con lui l'unico server in ascolto
   sulla rete di casa, la pagina servita in chiaro e la dipendenza da Tailscale.
   Al suo posto c'è un'app sul telefono che ha chiavi sue.
2. **Multi-dispositivo.** Le sessioni sono per dispositivo, non per persona, e
   ogni dispositivo ha chiavi sue (`packages/core/src/dispositivi.ts`). Il
   numero di sicurezza copre l'**insieme** dei dispositivi, quindi cambia quando
   se ne aggiunge uno: è il segnale che fa accorgere di un dispositivo non messo
   da voi — e adesso toglie da solo la spunta di verifica, cosa che prima non
   faceva.
3. **Passphrase minima da 8 a 12 caratteri**, controllata nel cuore e non solo
   nella pagina.
4. **Nomi dei file sanificati** (`packages/core/src/nomefile.ts`), compresi i
   nomi di periferica di Windows.
5. **Blocco automatico dopo dieci minuti** di inattività.
6. **I file grandi arrivano davvero.** L'avanzamento non passa più dal registro
   a ogni pezzo: prima un file da 4 GB non arrivava mai in fondo.

---

## Come verificarlo

```bash
npm install
npm run build
npm test
```

257 test. I più interessanti per chi verifica:

- `packages/core/test/ratchet-robustezza.test.ts` — il ratchet sotto stress:
  consegne a caso, buste rotte che non toccano lo stato, i limiti sui salti.
- `packages/core/test/relay.test.ts` — relay firmati nella voce, manomissione
  rifiutata, verifica che resta quando cambiano solo i relay.
- `packages/core/test/backup.test.ts` — niente in chiaro nel file, ripristino
  solo a deposito vuoto, conversazioni che ripartono in entrambi i versi.
- `packages/core/test/storico.test.ts` — lo storico al dispositivo nuovo senza
  doppioni, file come righe senza byte.
- `packages/core/test/verifica-dispositivi.test.ts` — che la verifica cada
  quando i dispositivi del contatto cambiano, e resti quando non cambiano.
- `apps/pwa/test/aggiornamento-sw.test.ts` — che l'app si accorga se i file sul
  sito cambiano, e che non lo dica a vuoto quando manca la rete.
- `packages/core/test/avanzamento-diretto.test.ts` — che l'avanzamento di un
  file grande non rilegga il registro a ogni pezzo. Conta le riletture, non i
  millisecondi: su una macchina carica il tempo dice quello che vuole.
- `packages/core/test/tamper.test.ts` — manomissione delle buste.
- `packages/core/test/session.test.ts`, `ratchet.test.ts` — il ratchet.
- `packages/core/test/incrocio.test.ts` — due account veri che si parlano.
- `packages/core/test/dispositivi.test.ts` — firme dei dispositivi.

I test passano tutti: se ne trovate uno che non passa, quella è una notizia.

---

## Se trovate qualcosa

Le due cose che varrebbe la pena cercare, in ordine di utilità:

1. **Un modo di leggere il contenuto di un messaggio** senza avere una delle due
   passphrase. Questo sarebbe grave.
2. **Un modo di far accettare un dispositivo** che il proprietario dell'account
   non ha collegato, senza far cambiare il numero di sicurezza.

Le cose già note e sopra elencate — correlazione temporale sui relay, attacco
attivo sul pannello telefono, passphrase corta, STUN che vede gli IP — sono
scelte consapevoli, documentate qui. Segnalarle di nuovo non aggiunge niente;
trovarci dentro una conseguenza che non abbiamo previsto, sì.
