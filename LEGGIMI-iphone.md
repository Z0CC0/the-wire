# THE WIRE — l'app per iPhone

Dai questo file a Claude (o a un altro assistente) **su un Mac** e digli:
**"fai quello che è scritto in LEGGIMI-iphone.md"**.

Serve un Mac. Non è una preferenza: gli strumenti che costruiscono un'app per
iPhone esistono solo su macOS, e Apple non ne distribuisce versioni per altri
sistemi.

---

## Leggi prima questo, e dillo all'utente

Su Android l'app si installa da un file e basta. **Su iPhone no.** Apple non
permette di installare app fuori dall'App Store, e questo non si aggira: è una
scelta di Apple, non un limite del programma.

Restano tre strade, e nessuna è indolore:

**1. Xcode con un ID Apple gratuito.** Si installa l'app sul proprio iPhone
collegandolo al Mac. **Scade dopo 7 giorni**: passata la settimana l'app smette
di aprirsi finché non la si reinstalla dal Mac. Gratis, ma va rifatto ogni
settimana. Per provare va bene; per usarla tutti i giorni, no.

**2. Account sviluppatore Apple, 99 dollari l'anno.** Stessa procedura, ma
l'app dura un anno invece di sette giorni.

**3. La PWA.** Nessuna installazione: l'indirizzo esiste già,
**https://z0cc0.github.io/the-wire/** (è la cartella `apps/pwa/sito` di questo
repository pubblicata da GitHub Pages). Si apre con Safari e si aggiunge alla
schermata Home. Funziona subito e non scade. Il rovescio è che passa da un
indirizzo web, e l'utente voleva evitarlo.

Vedi `LEGGIMI-telefono.md` per la strada 3, che non richiede un Mac.

Se l'utente non sa quale scegliere, la domanda utile è una sola: **è disposto a
ricollegare l'iPhone al Mac ogni settimana?** Se sì, strada 1. Se no e non vuole
pagare, strada 3.

---

## ISTRUZIONI PER L'ASSISTENTE (strade 1 e 2)

Esegui i passi nell'ordine. Se uno fallisce, **fermati e spiega all'utente**:
non tirare avanti a caso.

### 1. Verifica di essere su macOS con gli strumenti

```bash
uname -s              # deve stampare: Darwin
xcodebuild -version   # deve stampare una versione di Xcode
```

Se Xcode manca, va installato dall'App Store — sono diversi gigabyte. Serve
anche CocoaPods:

```bash
sudo gem install cocoapods
```

### 2. Costruisci l'app

Dalla radice del progetto:

```bash
npm install
npm run build
node apps/pwa/costruisci-android.mjs
npx cap sync ios
```

`costruisci-android.mjs` non ha un nome sbagliato: prepara i file per stare
**dentro** un'app, e vanno bene per tutte e due i sistemi. La differenza con la
versione web è che toglie il service worker e il manifest di installazione, che
dentro un'app non servono.

Deve comparire `apps/pwa/android-www` con dentro `index.html`, `app.js`,
`ponte.js`, `qr.js`, `app.css`, `tokens.css`. Se `qr.js` manca, il telefono non
potrà inquadrare il codice di collegamento.

### 3. Apri il progetto in Xcode

```bash
npx cap open ios
```

Nel pannello **Signing & Capabilities** del target `App`:

- spunta **Automatically manage signing**;
- in **Team** scegli il proprio ID Apple (se non c'è: Xcode › Settings ›
  Accounts › `+`);
- cambia il **Bundle Identifier** in qualcosa di unico, per esempio
  `com.<cognome>.thewire`. Con l'ID gratuito quello predefinito viene rifiutato
  perché qualcun altro potrebbe averlo già usato.

### 4. Installa sull'iPhone

Collega l'iPhone al Mac con il cavo, sbloccalo e autorizza il computer. In Xcode
scegli l'iPhone come destinazione e premi **Run**.

Al primo avvio l'iPhone rifiuta di aprire l'app: è normale con un ID gratuito.
Sul telefono: **Impostazioni › Generali › VPN e gestione dispositivo**, tocca il
proprio ID Apple e scegli **Autorizza**.

### 5. Verifica che funzioni davvero

Non fermarti al fatto che si apra. Controlla queste tre cose e riferiscile
all'utente:

1. **Si crea un'identità.** Deve chiedere una passphrase di almeno 12 caratteri.
2. **La fotocamera si apre.** In `DISPOSITIVI › COLLEGA UN DISPOSITIVO` deve
   comparire il mirino e la richiesta di permesso. Se resta nero, controlla che
   `NSCameraUsageDescription` sia in `ios/App/App/Info.plist` — c'è già, ma un
   `cap sync` fatto male può sovrascriverlo.
3. **Il collegamento riesce.** Sul computer dell'utente si apre lo stesso
   pannello, compare un QR, e l'iPhone lo inquadra. Se funziona, l'iPhone è
   diventato un dispositivo di quell'account.

---

## Cosa dire all'utente quando hai finito

**Il QR contiene la chiave privata dell'account.** Chi fotografa lo schermo
mentre è visibile diventa un suo dispositivo e legge tutto quello che gli
scrivono. Vale cinque minuti: va mostrato il tempo di inquadrarlo, non lasciato
aperto.

**Dopo il collegamento il numero di sicurezza con tutti i contatti cambia.** È
previsto, ma va riconfrontato a voce con ciascuno. Se cambia quando nessuno ha
collegato niente, qualcuno ha aggiunto un dispositivo che non doveva.

**Con l'ID gratuito l'app scade dopo 7 giorni.** Ricollegare l'iPhone al Mac e
premere Run di nuovo. L'identità e le conversazioni restano dove sono: si
reinstalla l'app, non si ricomincia da capo.

**Niente notifiche.** Su iPhone servirebbe un server che sa quando arriva un
messaggio e per chi — esattamente ciò che questo programma evita di far
esistere. I messaggi si vedono aprendo l'app.

**I file oltre 5 MB non partono dal telefono.** Passano da un collegamento
diretto fra due computer, che dal telefono non esiste.

Per cosa il programma protegge e cosa **non** protegge, vedi `SICUREZZA.md`.
