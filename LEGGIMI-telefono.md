# THE WIRE — mettere l'app sul telefono

Dai questo file a Claude (o a un altro assistente) e digli:
**"fai quello che è scritto in LEGGIMI-telefono.md"**.

In fondo ci sono i passi da fare a mano, se preferisci.

---

## Cosa deve venirne fuori

L'icona di THE WIRE sulla schermata Home del telefono, che apre l'app a tutto
schermo. Funziona su iPhone e su Android, ed è la stessa app del computer.

**Non serve nessuno store.** Niente account sviluppatore Apple da 99 dollari
l'anno, niente revisione, niente attesa. L'app è una cartella di file statici:
messa su un indirizzo HTTPS, il telefono la installa da sé.

**Non serve nessun server nostro.** I file statici li serve chiunque — per
questo repository li serve già GitHub Pages, gratis, all'indirizzo
**https://z0cc0.github.io/the-wire/**: se ti basta quello, salta la pubblicazione e
vai dritto all'installazione sul telefono. Da lì in poi l'app parla direttamente con i
relay Nostr, come fa quella del computer: chi ospita i file non vede passare
niente, perché non passa niente da lui.

**Non serve che il computer sia acceso.** Questa è la differenza con il pannello
TELEFONO: quello faceva del telefono uno schermo di un PC acceso. Qui il
telefono ha chiavi sue e riceve per conto suo.

---

## ISTRUZIONI PER L'ASSISTENTE

Esegui i passi nell'ordine. Se uno fallisce, **fermati e spiega all'utente**:
non tirare avanti a caso.

### 1. Costruisci la cartella dell'app

Dalla radice del progetto:

```bash
npm install
npm run build
node apps/pwa/costruisci.mjs
```

Deve stampare `sito pronto in apps/pwa/sito`. Dentro `apps/pwa/sito` devono
esserci almeno: `index.html`, `app.js`, `ponte.js`, `qr.js`, `sw.js`,
`manifest.webmanifest`, `app.css`, `tokens.css`, `icona-192.png`,
`icona-512.png`.

Se `qr.js` manca, il telefono non potrà inquadrare il codice di collegamento.

### 2. Pubblicala su un indirizzo HTTPS

HTTPS non è un dettaglio da rimandare: **senza, il telefono non installa l'app e
non dà accesso alla fotocamera**. Sono regole del browser, non nostre.

Con GitHub Pages, dalla radice del progetto:

```bash
git init
git add apps/pwa/sito
git commit -m "app per telefono"
```

Poi crea un repository su GitHub e caricalo. Nelle impostazioni del repository,
sezione **Pages**, scegli il ramo e la cartella `apps/pwa/sito`. Dopo qualche
minuto l'indirizzo è `https://<utente>.github.io/<repository>/`.

Il repository **può essere pubblico**: nei file non c'è niente di segreto. Le
chiavi nascono sul dispositivo di chi installa l'app e non escono da lì.

Verifica che l'indirizzo si apra da un browser qualunque prima di passare oltre.

### 3. Installala sul telefono

**iPhone** — apri l'indirizzo con **Safari** (non Chrome: su iOS solo Safari
aggiunge alla schermata Home). Tocca il pulsante Condividi, poi *Aggiungi alla
schermata Home*.

**Android** — apri l'indirizzo con Chrome. Compare una richiesta di installare
l'app; se non compare, usa il menu ⋮ e *Installa app*.

Da questo momento l'icona apre THE WIRE a tutto schermo, senza barra del
browser.

### 4. Collega il telefono all'account

Sul telefono l'app crea un'identità nuova, che all'inizio è **separata** da
quella del computer. Per farne un dispositivo dello stesso account:

1. Sul computer: **DISPOSITIVI › COLLEGA UN DISPOSITIVO**. Compare un QR.
2. Sul telefono: lo stesso pulsante, che apre la fotocamera. Inquadra il QR.

Al primo uso il telefono chiede il permesso della fotocamera: va dato, o resta
solo la strada dell'incolla.

**Avverti l'utente di questo, prima che inquadri:** quel QR contiene la chiave
privata dell'account. Chi fotografa lo schermo mentre è visibile diventa un suo
dispositivo e legge tutto quello che gli scrivono. Vale cinque minuti, e va
mostrato il tempo di inquadrarlo — non lasciato aperto su una scrivania.

E dopo: **il numero di sicurezza con tutti i contatti cambia.** È previsto, ma i
contatti devono riconfrontarlo. Se cambia quando nessuno ha collegato niente,
qualcuno ha aggiunto un dispositivo che non doveva.

---

## Limiti da dire all'utente, non da scoprire dopo

**Niente notifiche.** Su iPhone le notifiche push richiederebbero un server che
sa quando arriva un messaggio per chi — esattamente ciò che questo programma
evita di far esistere. I messaggi si vedono aprendo l'app.

**Su iPhone il deposito può sparire.** iOS cancella i dati dei siti non usati
dopo qualche settimana. Averla installata sulla schermata Home la protegge da
questa pulizia: è il motivo principale per non lasciarla come semplice scheda
del browser. Comunque l'identità sta anche sul computer, e da lì si ricollega.

**I file oltre 5 MB non partono dal telefono.** Passano da un collegamento
diretto fra i due computer, che dal telefono non esiste. Sotto i 5 MB si mandano
normalmente.

---

## A mano, senza assistente

```bash
npm install
npm run build
node apps/pwa/costruisci.mjs
```

Prendi la cartella `apps/pwa/sito` e mettila su un qualunque indirizzo HTTPS.
Apri quell'indirizzo dal telefono e aggiungilo alla schermata Home.
