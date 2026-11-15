# THE WIRE — telefono (Android e iPhone)

## Leggi questo per primo: qui dentro non c'è un "setup"

Per il telefono non esiste un file da installare, e non è una mancanza: è come
funziona questa app. Niente Play Store, niente App Store, niente account
sviluppatore, nessun costo.

Al posto del setup c'è **questa cartella**, che va messa su un indirizzo HTTPS.
Da quel momento l'indirizzo *è* l'app: si apre dal telefono e si aggiunge alla
schermata Home. Android e iPhone usano **lo stesso identico indirizzo** — si
pubblica una volta sola e vale per tutti e due.

HTTPS non è rimandabile: senza, il telefono non installa l'app e non dà accesso
alla fotocamera. Sono regole del browser, non nostre.

---

## Pubblicarla — una volta sola, gratis

Se usi la copia del repository ufficiale, è già pubblicata:
**https://z0cc0.github.io/the-wire/**. I passi qui sotto servono solo per metterla
su un indirizzo tuo.

Con GitHub Pages:

1. Crea un repository su GitHub (**può essere pubblico**: qui dentro non c'è
   niente di segreto — le chiavi nascono sul telefono di chi installa l'app e
   non escono da lì).
2. Carica il contenuto di questa cartella.
3. Impostazioni del repository, sezione **Pages**: scegli il ramo e la cartella.
4. Dopo qualche minuto l'indirizzo è `https://<utente>.github.io/<repository>/`.

Apri quell'indirizzo da un browser qualunque per controllare che risponda, prima
di passare al telefono.

---

## Come si aggiorna, e perché non da sola

L'app **parte sempre dalla copia installata sul telefono**, non da quella sul
sito. È una scelta di sicurezza: l'app arriva da un indirizzo web, e chi
mettesse le mani su quell'indirizzo potrebbe sostituirla con una che manda le
chiavi altrove. Riscaricandola a ogni apertura, una manomissione entrerebbe
subito e ogni volta; così invece raggiunge solo chi installa in quel momento.

Quando i file sul sito cambiano, all'apertura compare una barra in fondo che lo
dice, con due pulsanti: INSTALLA e PIÙ TARDI. Nessun aggiornamento entra da
solo.

**Se quella barra compare quando non hai pubblicato niente, non premere
INSTALLA.** Vuol dire che i file sul sito sono cambiati senza che tu lo sappia,
e la cosa da fare è controllare l'account da cui l'app è pubblicata.

Insieme ai file c'è `IMPRONTE.txt`, con l'impronta SHA-256 di ognuno. Serve a
rispondere a una domanda sola: quello che sta sul sito è quello che è uscito
dalla costruzione? Da una cartella con i file scaricati:

```bash
sha256sum -c IMPRONTE.txt
```

---

## Installarla

**Android** — apri l'indirizzo con Chrome. Compare la richiesta di installare
l'app; se non compare, menu ⋮ e *Installa app*.

**iPhone** — apri l'indirizzo con **Safari** (non Chrome: su iOS solo Safari
aggiunge alla schermata Home). Pulsante Condividi, poi *Aggiungi alla schermata
Home*.

---

## Collegare il telefono al tuo account

Appena installata, l'app crea un'identità nuova, **separata** da quella del
computer. Per farne un dispositivo dello stesso account:

1. Sul computer: **DISPOSITIVI › COLLEGA UN DISPOSITIVO**. Compare un QR.
2. Sul telefono: lo stesso pulsante, che apre la fotocamera. Inquadra il QR.

Al primo uso il telefono chiede il permesso della fotocamera. Se lo neghi resta
la strada dell'incolla, ma il codice è lungo 657 caratteri.

**Prima di mostrare quel QR, sappi questo:** contiene la chiave privata del tuo
account. Chi fotografa lo schermo mentre è visibile diventa un tuo dispositivo e
legge tutto quello che ti scrivono. Vale cinque minuti, e va mostrato il tempo
di inquadrarlo — non lasciato aperto su una scrivania.

Dopo il collegamento **il numero di sicurezza con tutti i tuoi contatti cambia.**
È previsto, ma i contatti devono riconfrontarlo. Se cambia quando nessuno ha
collegato niente, qualcuno ha aggiunto un dispositivo che non doveva. Dalla
parte di chi lo riceve, quel cambio adesso toglie da solo la spunta di verifica
e lo scrive nella conversazione: prima restava scritto "verificata" anche dopo,
ed era il difetto più insidioso trovato dal controllo esterno.

---

## Cosa non fa, per non scoprirlo dopo

**Niente notifiche.** Su iPhone servirebbe un server che sa quando arriva un
messaggio e per chi — esattamente ciò che questo programma evita di far
esistere. I messaggi si vedono aprendo l'app.

**Su iPhone il deposito può sparire.** iOS cancella i dati dei siti non usati
dopo qualche settimana. Averla installata sulla schermata Home la protegge da
questa pulizia: è il motivo principale per non lasciarla come scheda del
browser. Comunque l'identità sta anche sul computer, e da lì si ricollega.

**I file oltre 5 MB non partono dal telefono.** Passano da un collegamento
diretto fra due computer, che dal telefono non esiste. Sotto i 5 MB si mandano
normalmente.

---

## Cosa c'è dentro questa cartella

Tutti gli aggiornamenti di questa versione, codice e sicurezza. In particolare
`qr.js` è il lettore di QR: senza, il telefono non può collegarsi all'account.

Per il dettaglio della sicurezza — cosa protegge, cosa **non** protegge, e la
risposta punto per punto al controllo esterno — vedi `SICUREZZA.md`, qui
accanto.
