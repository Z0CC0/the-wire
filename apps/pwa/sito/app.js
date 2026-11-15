// THE WIRE — finestra. Non contiene crittografia ne' accesso al disco: chiede
// tutto a `window.wireApi`, che parla col processo principale. Lo stesso core
// che gira nella variante da terminale.

const api = window.wireApi;

const state = {
  filter: 'TUTTI',
  contacts: [],
  groups: [],
  /** { kind: 'contatto' | 'gruppo', id, topic? } */
  open: null,
  view: 'empty',
  me: { name: '', address: null, uri: null, id: null },
  /** Il server TURN per il collegamento diretto, o null. Lo legge `diretto.js`. */
  turn: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clock = (at) => {
  const d = new Date(at);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
};

/**
 * Il messaggio utile, senza l'involucro dell'IPC.
 *
 * Electron incarta gli errori del processo principale in
 * "Error invoking remote method 'wire:call': Error: ...": quel prefisso non dice
 * niente a chi legge e nasconde la frase che conta.
 */
const motivo = (e) =>
  String(e?.message ?? e)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|Uncaught \(in promise\)):\s*/, '')
    .trim();

const contactById = (id) => state.contacts.find((c) => c.id === id) || null;
const groupById = (id) => state.groups.find((g) => g.id === id) || null;

// ---------- schermata di sblocco ----------

function lockScreen({ exists, versione }) {
  const primo = !exists;
  const box = el(`
    <div class="lock">
      <div class="lock__panel uk-panel">
        <div class="logo u-1"><b>THE</b><i> WIRE</i></div>
        <div class="lock__sub">${primo ? 'PRIMO AVVIO' : 'BENTORNATO'}${versione ? ` · v${versione}` : ''}</div>
        <div class="lock__text">${
          primo
            ? 'Creo ora la tua identità. Nessuna registrazione: le chiavi restano su questo dispositivo, cifrate con la passphrase che scegli.'
            : 'Le tue chiavi sono cifrate su questo dispositivo. Inserisci la passphrase per aprirle.'
        }</div>
        <input class="uk-field" type="password" id="pass1" placeholder="passphrase" />
        ${primo ? '<input class="uk-field" type="password" id="pass2" placeholder="ripeti la passphrase" />' : ''}
        <button class="uk-btn uk-btn--primary uk-btn--lg u-2" id="lockGo">
          ${primo ? 'CREA IDENTITÀ' : 'SBLOCCA'}
        </button>
        <div class="lock__err" id="lockErr"></div>
        ${
          primo
            ? '<div class="lock__warn">Se perdi la passphrase, l’identità è persa. Per costruzione, nessuno può recuperarla.</div>'
            : ''
        }
      </div>
    </div>`);

  const err = box.querySelector('#lockErr');
  const go = async () => {
    const p1 = box.querySelector('#pass1').value;
    const p2 = primo ? box.querySelector('#pass2').value : p1;
    err.textContent = '';
    if (p1.length < 12) return (err.textContent = 'La passphrase deve avere almeno 12 caratteri.');
    if (p1 !== p2) return (err.textContent = 'Le due passphrase non coincidono.');

    const btn = box.querySelector('#lockGo');
    btn.disabled = true;
    btn.textContent = primo ? 'GENERO LE CHIAVI…' : 'APRO…';
    try {
      primo ? await api.create(p1) : await api.unlock(p1);
      box.remove();
      await boot();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = primo ? 'CREA IDENTITÀ' : 'SBLOCCA';
      err.textContent = motivo(e);
    }
  };

  box.querySelector('#lockGo').onclick = go;
  // addEventListener con un corpo esplicito, non una freccia che ritorna il
  // risultato del confronto: un handler di keydown che restituisce `false`
  // annulla l'evento, e ogni tasto diverso da Invio non scriverebbe niente.
  box.querySelectorAll('.uk-field').forEach((f) =>
    f.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') go();
    })
  );
  document.body.appendChild(box);
  setTimeout(() => box.querySelector('#pass1')?.focus(), 40);
}

// ---------- presenza ----------

/**
 * Da quanto non si fa vivo, detto come lo direbbe una persona.
 *
 * Volutamente vago oltre l ora: sapere che un amico e stato online alle 3:41
 * di stanotte non serve a nessuno, e detto cosi sembra sorveglianza.
 */
function quandoVisto(at) {
  if (!at) return 'MAI VISTO';
  const min = Math.floor((Date.now() - at) / 60000);
  if (min < 1) return 'VISTO ORA';
  if (min < 60) return `VISTO ${min} MIN FA`;
  const ore = Math.floor(min / 60);
  if (ore < 24) return `VISTO ${ore} ${ore === 1 ? 'ORA' : 'ORE'} FA`;
  const giorni = Math.floor(ore / 24);
  return `VISTO ${giorni} ${giorni === 1 ? 'GIORNO' : 'GIORNI'} FA`;
}

function presenzaTesto(c) {
  return c.online ? 'ONLINE' : quandoVisto(c.visto);
}

/** Un solo elemento, sostituibile da solo: cosi la riga di stato si aggiorna
 *  senza ridisegnare la conversazione sotto. */
function presenzaHtml(c) {
  return `<span class="pane__presenza"><span class="dot" data-on="${c.online ? 1 : 0}"></span>${esc(
    presenzaTesto(c)
  )}</span>`;
}

// ---------- pannello sinistro ----------

const FILTERS = ['TUTTI', 'DIRETTE', 'GRUPPI', 'ARCHIVIATE'];

function renderFilters() {
  const box = $('#filters');
  box.innerHTML = '';
  FILTERS.forEach((f) => {
    const b = el(`<button class="pill" data-on="${f === state.filter ? 1 : 0}">${f}</button>`);
    b.onclick = () => {
      state.filter = f;
      renderFilters();
      renderList();
    };
    box.appendChild(b);
  });
}

function righeVisibili() {
  const archivio = state.filter === 'ARCHIVIATE';
  const righe = [];
  if (state.filter !== 'GRUPPI') {
    righe.push(...state.contacts.map((c) => ({ kind: 'contatto', id: c.id, name: c.name, contact: c, dato: c })));
  }
  if (state.filter !== 'DIRETTE') {
    righe.push(...state.groups.map((g) => ({ kind: 'gruppo', id: g.id, name: g.name, group: g, dato: g })));
  }
  // Le archiviate stanno nella loro sezione e in nessuna altra.
  return righe
    .filter((r) => Boolean(r.dato.archiviata) === archivio)
    .sort((a, b) => {
      // Chi ha una posizione scelta a mano viene prima, nell ordine scelto.
      // Gli altri restano in ordine di nome, dietro.
      const oa = a.dato.ordine || 0;
      const ob = b.dato.ordine || 0;
      if (oa && ob) return oa - ob;
      if (oa) return -1;
      if (ob) return 1;
      return a.name.localeCompare(b.name);
    });
}

function renderList() {
  const box = $('#list');
  box.innerHTML = '';
  const righe = righeVisibili();

  if (!righe.length) {
    const archivio = state.filter === 'ARCHIVIATE';
    box.appendChild(
      el(`<div class="empty u-3">
            <div class="empty__glyph">${archivio ? '▤' : '◈'}</div>
            <div class="empty__title">${archivio ? 'NESSUNA ARCHIVIATA' : 'NIENTE QUI'}</div>
            <div class="empty__sub">${
              archivio ? 'Le conversazioni archiviate finiscono qui' : 'Aggiungi un contatto col pulsante qui sopra'
            }</div>
          </div>`)
    );
    return;
  }

  for (const r of righe) {
    const attiva = state.open?.id === r.id ? 1 : 0;
    const gruppo = r.kind === 'gruppo';
    const sub = gruppo
      ? `${r.group.members.length} MEMBRI<span class="row__sep">|</span>${r.group.topics.length} ARGOMENTI`
      : r.contact.verified
        ? `${esc(presenzaTesto(r.contact))}<span class="row__sep">|</span>${esc(r.contact.address)}`
        : `<span class="u-4">DA VERIFICARE</span><span class="row__sep">|</span>${esc(
            r.contact.address
          )}`;

    // Il pallino sta sul simbolo della riga, non nel testo: si vede con la coda
    // dell occhio scorrendo l elenco, che e il solo motivo per cui esiste.
    const acceso = !gruppo && r.contact.online ? 1 : 0;

    const archiviata = Boolean(r.dato.archiviata);
    const row = el(`
      <div class="row" data-id="${esc(r.id)}" data-active="${attiva}" data-off="${
        !gruppo && !r.contact.verified ? 1 : 0
      }">
        <div class="row__maniglia" title="Trascina per spostarla">≡</div>
        <button class="row__archivia" data-etichetta="${archiviata ? 'RIPRISTINA' : 'ARCHIVIA'}"
          title="${archiviata ? 'Rimetti nell elenco' : 'Archivia la conversazione'}">${
          archiviata ? '&#8613;' : '&#8615;'
        }</button>
        <div class="row__glyph">${gruppo ? '▤' : '◈'}${
          gruppo ? '' : `<span class="row__presenza" data-on="${acceso}"></span>`
        }</div>
        <div class="row__main">
          <div class="row__name">${esc(r.name)}</div>
          <div class="row__sub">${sub}</div>
        </div>
      </div>`);

    row.querySelector('.row__archivia').onclick = async (ev) => {
      // Senza fermarlo qui, archiviare aprirebbe anche la conversazione.
      ev.stopPropagation();
      await api.archivia(r.id, !archiviata);
      if (state.open?.id === r.id) {
        state.open = null;
        setPane(viewEmpty());
        mostra('lista');
      }
      await refreshAll();
    };
    row.querySelector('.row__maniglia').addEventListener('pointerdown', (ev) => iniziaTrascinamento(ev, row, box));
    row.onclick = () => (gruppo ? openGroup(r.id) : openContact(r.id));
    box.appendChild(row);
  }
}

/**
 * Trascinamento per riordinare, come la barra laterale di THE WIDGET.
 *
 * Si prende solo dalla maniglia: il resto della riga resta cliccabile per
 * aprire la conversazione. L ordine finisce nel deposito una volta sola,
 * quando si lascia — non a ogni pixel di movimento.
 */
function iniziaTrascinamento(ev, row, box) {
  ev.preventDefault();
  ev.stopPropagation();
  row.classList.add('row--trascina');
  document.body.classList.add('sta-trascinando');

  const muovi = (e) => {
    const altre = [...box.querySelectorAll('.row')].filter((r) => r !== row);
    // La prima riga il cui centro sta sotto il puntatore: la nostra va lì.
    const sotto = altre.find((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY < b.top + b.height / 2;
    });
    if (sotto) box.insertBefore(row, sotto);
    else box.appendChild(row);
  };

  const lascia = async () => {
    window.removeEventListener('pointermove', muovi);
    window.removeEventListener('pointerup', lascia);
    row.classList.remove('row--trascina');
    document.body.classList.remove('sta-trascinando');
    const ids = [...box.querySelectorAll('.row')].map((r) => r.dataset.id).filter(Boolean);
    try {
      await api.riordina(ids);
    } catch (e) {
      console.error('riordino non salvato:', motivo(e));
    }
    await refreshAll();
  };

  window.addEventListener('pointermove', muovi);
  window.addEventListener('pointerup', lascia);
}

// ---------- pannello destro ----------

/** Su schermo stretto lista e conversazione non ci stanno insieme: si alternano. */
function mostra(vista) {
  document.body.dataset.vista = vista;
}

function setPane(node) {
  mostra('conversazione');
  const pane = $('#pane');
  pane.innerHTML = '';
  pane.classList.remove('pane-fade');
  void pane.offsetWidth;
  pane.classList.add('pane-fade');
  pane.appendChild(node);
}

function head(title, subHtml, actions) {
  const h = el(`
    <div class="pane__head">
      <div class="u-5">
        <div class="pane__title">${esc(title)}</div>
        <div class="pane__sub">${subHtml}</div>
      </div>
      <div class="pane__acts"></div>
    </div>`);
  const indietro = el('<button class="uk-btn uk-btn--outline stretto-solo" title="Torna all elenco">&#8249;</button>');
  indietro.onclick = () => mostra('lista');
  h.prepend(indietro);

  const acts = h.querySelector('.pane__acts');
  // Le azioni principali restano in vista; le altre entrano sotto un menu.
  // Tre pulsanti sempre accesi accanto al nome pesano piu di quanto valgano:
  // il numero di sicurezza si guarda una volta, la cifratura si riavvia quasi
  // mai, ed eliminare non deve stare a un dito di distanza dal resto.
  const principali = actions.filter((a) => a[2] === 'primary');
  const secondarie = actions.filter((a) => a[2] !== 'primary');

  for (const [label, hint, variant, fn] of principali) {
    const b = el(`<button class="uk-btn uk-btn--${variant}" title="${esc(hint)}">${label}</button>`);
    b.onclick = fn;
    acts.appendChild(b);
  }

  if (secondarie.length) {
    const apri = el('<button class="uk-btn uk-btn--outline pane__menu-btn" title="Altre azioni">&#8943;</button>');
    apri.onclick = (ev) => {
      ev.stopPropagation();
      apriMenu(apri, secondarie);
    };
    acts.appendChild(apri);
  }
  return h;
}

/**
 * Apre un menu ancorato a un pulsante.
 *
 * Sta attaccato alla pagina e non al pulsante, e la posizione si calcola qui.
 * Due ragioni, tutte e due imparate rompendolo: sullo schermo stretto la
 * barra delle azioni scorre di lato, e un menu figlio di un contenitore che
 * scorre viene tagliato dal contenitore — sul telefono non compariva affatto.
 * E si evita di dipendere da `hidden`, che una regola `display` del foglio di
 * stile annulla senza dire niente: il menu restava aperto per sempre.
 */
function apriMenu(bottone, voci) {
  const gia = document.querySelector('.menu-mouse');
  document.querySelector('.menu-mouse')?.remove();
  // Secondo clic sullo stesso pulsante: si chiude e basta.
  if (gia && gia.dataset.per === bottone.dataset.menuId) return;

  bottone.dataset.menuId = bottone.dataset.menuId || String(Math.random()).slice(2);
  const menu = el('<div class="menu menu-mouse"></div>');
  menu.dataset.per = bottone.dataset.menuId;
  for (const [label, hint, variant, fn] of voci) {
    const v = el(
      `<button class="menu__voce ${variant === 'danger' ? 'menu__voce--rossa' : ''}" title="${esc(hint)}">${label}</button>`
    );
    v.onclick = () => {
      chiudiMenu();
      fn();
    };
    menu.appendChild(v);
  }
  document.body.appendChild(menu);

  const r = bottone.getBoundingClientRect();
  const larghezza = menu.offsetWidth || 210;
  const altezza = menu.offsetHeight || 120;
  menu.style.left = `${Math.max(8, Math.min(r.right - larghezza, innerWidth - larghezza - 8))}px`;
  // Sotto il pulsante, o sopra se sotto non ci sta.
  const sotto = r.bottom + 6;
  menu.style.top = `${sotto + altezza > innerHeight - 8 ? Math.max(8, r.top - altezza - 6) : sotto}px`;

  function chiudiMenu() {
    menu.remove();
    document.removeEventListener('mousedown', fuori);
    document.removeEventListener('keydown', esc);
  }
  function fuori(e) {
    if (!menu.contains(e.target) && e.target !== bottone) chiudiMenu();
  }
  function esc(e) {
    if (e.key === 'Escape') chiudiMenu();
  }
  setTimeout(() => {
    document.addEventListener('mousedown', fuori);
    document.addEventListener('keydown', esc);
  }, 0);
}

const viewEmpty = () =>
  el(`<div class="empty">
        <div class="empty__glyph">▧</div>
        <div class="empty__title">SELEZIONA UNA CONVERSAZIONE</div>
        <div class="empty__sub">Oppure crea un gruppo dal pulsante NUOVO</div>
      </div>`);

/** Peso leggibile: 1,4 MB dice piu di 1468006, e 2,1 GB piu di 2002,7 MB. */
function peso(byte) {
  if (byte < 1024) return `${byte} B`;
  if (byte < 1024 * 1024) return `${Math.round(byte / 1024)} KB`;
  if (byte < 1024 * 1024 * 1024) {
    const mb = byte / (1024 * 1024);
    // Una cifra decimale sotto i 100 MB, nessuna sopra: a quel punto non
    // aggiunge niente e allunga soltanto.
    return `${(mb < 100 ? mb.toFixed(1) : String(Math.round(mb))).replace('.', ',')} MB`;
  }
  return `${(byte / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`;
}

const IMMAGINE = /^image\/(png|jpeg|gif|webp|bmp|avif)$/;

/**
 * La parte di bolla che riguarda il file.
 *
 * Tre casi da distinguere, perche significano cose diverse per chi guarda:
 * sta arrivando (barra), e arrivato (si apre), non ce l ha fatta (si dice).
 */
function allegato(m) {
  const f = m.file;
  const box = el('<div class="allegato"></div>');
  const anteprima = el('<div class="allegato__anteprima"></div>');

  if (f.stato === 'pronto' && IMMAGINE.test(f.tipo) && f.via === 'mailbox' && api.fileDati) {
    // L immagine si mostra solo quando i byte ci sono davvero. Chiederli prima
    // significherebbe un riquadro rotto per tutto il tempo del trasferimento.
    api
      .fileDati(f.id)
      .then((b64) => {
        const img = el(`<img class="allegato__img" alt="${esc(f.nome)}" />`);
        img.src = `data:${f.tipo};base64,${b64}`;
        anteprima.replaceWith(img);
      })
      .catch(() => anteprima.replaceWith(el('<div class="allegato__glifo">▢</div>')));
    box.appendChild(anteprima);
  }

  const riga1 = esc(f.nome);
  let riga2;
  const fatti = f.fatti || 0;
  if (f.stato === 'in-corso') {
    const totale = f.via === 'mailbox' ? Math.max(1, Math.ceil(f.dimensione / 16384)) : f.dimensione;
    const perc = Math.min(100, Math.round((fatti / totale) * 100));
    riga2 = `${f.via === 'diretto' ? 'DIRETTO' : 'IN ARRIVO'} · ${perc}% · ${peso(f.dimensione)}`;
  } else if (f.stato === 'fallito') {
    riga2 = `<span class="u-4">NON ARRIVATO INTERO</span> · ${peso(f.dimensione)}`;
  } else if (f.stato === 'atteso' && fatti > 0) {
    // Interrotto a meta', non in attesa di partire: il pezzo gia' arrivato
    // resta sul disco e il prossimo tentativo riparte da li'. Dirgli "in attesa
    // che sia online" farebbe credere che non sia mai cominciato.
    const perc = Math.min(100, Math.round((fatti / (f.dimensione || 1)) * 100));
    riga2 = `<span class="u-4">INTERROTTO AL ${perc}%</span> · riprende da solo · ${peso(f.dimensione)}`;
  } else if (f.stato === 'atteso') {
    riga2 = `<span class="u-4">IN ATTESA CHE SIA ONLINE</span> · ${peso(f.dimensione)}`;
  } else {
    riga2 = `${f.via === 'diretto' ? 'ARRIVATO DIRETTAMENTE' : 'PRONTO'} · ${peso(f.dimensione)}`;
  }

  const testo = el(`<div class="allegato__testo">
      <div class="allegato__nome">${riga1}</div>
      <div class="allegato__nota">${riga2}</div>
    </div>`);
  box.appendChild(testo);

  if (f.stato === 'in-corso') {
    const fatti = f.fatti || 0;
    const totale = f.via === 'mailbox' ? Math.max(1, Math.ceil(f.dimensione / 16384)) : f.dimensione;
    const barra = el('<div class="allegato__barra"><i></i></div>');
    barra.querySelector('i').style.width = `${Math.min(100, Math.round((fatti / totale) * 100))}%`;
    box.appendChild(barra);
  }

  if (f.stato === 'pronto') {
    if (f.via === 'mailbox' && api.salvaFile) {
      const b = el('<button class="uk-btn uk-btn--outline allegato__btn">SALVA</button>');
      b.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          const dove = await api.salvaFile(f.id, f.nome);
          if (dove) b.textContent = 'SALVATO';
        } catch (e) {
          b.textContent = motivo(e).slice(0, 30);
        }
      };
      box.appendChild(b);
    } else if (f.percorso && api.mostraNellaCartella) {
      const b = el('<button class="uk-btn uk-btn--outline allegato__btn">MOSTRA</button>');
      b.onclick = (ev) => {
        ev.stopPropagation();
        api.mostraNellaCartella(f.percorso);
      };
      box.appendChild(b);
    }
  }
  return box;
}

/**
 * Menu del tasto destro su un messaggio.
 *
 * Compare dove si e cliccato e si chiude al primo clic fuori o con Esc: una
 * finestra di conferma per eliminare un messaggio sarebbe piu invadente di
 * quanto serva.
 */
function menuMessaggio(ev, m, thread) {
  ev.preventDefault();
  document.querySelector('.menu-mouse')?.remove();
  if (m.eliminato || m.system) return;

  const menu = el('<div class="menu menu-mouse"></div>');
  const voci = [['Elimina per me', false]];
  // Solo i propri: togliere dal dispositivo altrui qualcosa che ha scritto lui
  // non e una funzione che questo programma offre.
  if (m.mine) voci.push(['Elimina per entrambi', true]);

  for (const [etichetta, entrambi] of voci) {
    const v = el(`<button class="menu__voce ${entrambi ? 'menu__voce--rossa' : ''}">${etichetta}</button>`);
    v.onclick = async () => {
      menu.remove();
      try {
        const aggiornato = await api.eliminaMessaggio(m.id, entrambi);
        if (aggiornato) metti(thread, aggiornato, Boolean(m.group));
      } catch (e) {
        avvisoNelThread(thread, motivo(e));
      }
    };
    menu.appendChild(v);
  }
  if (m.mine) {
    menu.appendChild(
      el(`<div class="menu__nota">Eliminare per entrambi e una richiesta: la esegue il suo programma.
        Chi ha gia letto, o fotografato lo schermo, non si raggiunge.</div>`)
    );
  }

  document.body.appendChild(menu);
  const larghezza = menu.offsetWidth || 200;
  const altezza = menu.offsetHeight || 80;
  menu.style.left = `${Math.min(ev.clientX, innerWidth - larghezza - 8)}px`;
  menu.style.top = `${Math.min(ev.clientY, innerHeight - altezza - 8)}px`;

  const chiudi = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', chiudi);
    document.removeEventListener('keydown', esc);
  };
  const esc = (e) => {
    if (e.key === 'Escape') chiudi(e);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', chiudi);
    document.addEventListener('keydown', esc);
  }, 0);
}

function bubble(m, mostraAutore) {
  if (m.system) return el(`<div class="daysep">${esc(m.text)}</div>`);
  // L identificativo sulla bolla serve a ritrovarla dopo: un messaggio che
  // arriva si aggiunge, uno che cambia (un file che avanza) si sostituisce al
  // suo posto. Senza, l unico modo sarebbe ridisegnare tutto il pannello.
  const b = el(`<div class="msg ${m.mine ? 'msg--me' : ''}" data-id="${esc(m.id)}"></div>`);
  if (mostraAutore && !m.mine) b.appendChild(el(`<div class="msg__who">${esc(m.author || '')}</div>`));
  if (m.eliminato) {
    b.classList.add('msg--eliminato');
    b.appendChild(
      el(`<div class="msg__text">${m.eliminato === 'entrambi' ? 'Messaggio eliminato' : 'Eliminato per te'}</div>`)
    );
  } else {
    if (m.file) b.appendChild(allegato(m));
    if (m.text) b.appendChild(el(`<div class="msg__text">${esc(m.text)}</div>`));
  }
  b.appendChild(el(`<div class="msg__meta">${clock(m.at)}${m.mine && !m.eliminato ? ' ✓✓' : ''}</div>`));
  return b;
}

/**
 * Mette un messaggio nella conversazione senza ridisegnarla.
 *
 * Tre casi: c e gia e va sostituito al suo posto (un file che avanza), e nuovo
 * e va in fondo, oppure la conversazione era vuota e il segnaposto va tolto.
 * Ridisegnare tutto a ogni messaggio faceva sfarfallare il pannello e perdeva
 * la posizione dello scorrimento.
 */
function metti(thread, m, mostraAutore) {
  if (!thread) return;
  const nuova = bubble(m, mostraAutore);
  const gia = thread.querySelector(`.msg[data-id="${CSS.escape(m.id)}"]`);
  if (api.eliminaMessaggio) {
    nuova.addEventListener('contextmenu', (ev) => menuMessaggio(ev, m, thread));
  }
  if (gia) {
    // Sostituzione silenziosa: un file che avanza non deve rientrare in scena
    // a ogni pezzo.
    gia.replaceWith(nuova);
    return;
  }
  // Il segnaposto "nessun messaggio" se ne va appena ne arriva uno.
  const vuoto = thread.querySelector('.thread__vuoto');
  if (vuoto) vuoto.remove();

  // La riga con la data si aggiunge solo quando il giorno cambia.
  const giorno = new Date(m.at).toLocaleDateString('it-IT', { day: '2-digit', month: 'long' });
  const separatori = thread.querySelectorAll('.daysep');
  const ultimo = separatori[separatori.length - 1];
  if (!ultimo || ultimo.textContent !== giorno) {
    thread.appendChild(el(`<div class="daysep">${esc(giorno)}</div>`));
  }

  nuova.classList.add('msg--entra');
  thread.appendChild(nuova);
  // La classe si toglie a animazione finita, o rientrerebbe in scena ogni
  // volta che il messaggio viene sostituito.
  setTimeout(() => nuova.classList.remove('msg--entra'), 400);
  thread.scrollTop = thread.scrollHeight;
}

function fillThread(thread, messages, mostraAutore, vuoto) {
  thread.innerHTML = '';
  if (!messages.length) thread.appendChild(el(`<div class="daysep thread__vuoto">${vuoto}</div>`));
  let ultimoGiorno = '';
  for (const m of messages) {
    const giorno = new Date(m.at).toLocaleDateString('it-IT', { day: '2-digit', month: 'long' });
    if (giorno !== ultimoGiorno) {
      thread.appendChild(el(`<div class="daysep">${esc(giorno)}</div>`));
      ultimoGiorno = giorno;
    }
    const b = bubble(m, mostraAutore);
    if (api.eliminaMessaggio) b.addEventListener('contextmenu', (ev) => menuMessaggio(ev, m, thread));
    thread.appendChild(b);
  }
  thread.scrollTop = thread.scrollHeight;
}

function composer(onSend, onErrore, onFile) {
  const c = el(`
    <div class="composer">
      <button class="uk-btn uk-btn--outline composer__piu" title="Allega un file">+</button>
      <input class="uk-field" placeholder="Scrivi un messaggio…" id="msgInput" />
      <button class="uk-btn uk-btn--primary u-6" id="msgSend">INVIA</button>
    </div>`);
  const input = c.querySelector('#msgInput');
  const invia = c.querySelector('#msgSend');
  const piu = c.querySelector('.composer__piu');

  // Il pulsante c e solo dove serve: nelle conversazioni dirette. Nei gruppi
  // lo stesso file andrebbe spedito una volta per membro.
  if (!onFile) {
    piu.remove();
  } else {
    // Un input nascosto invece di una finestra di sistema: cosi la finestra
    // riceve un oggetto File, che si puo leggere a pezzi senza tenerlo tutto
    // in memoria. Un percorso non basterebbe per i file da gigabyte.
    const scelta = el('<input class="u-7" type="file" />');
    c.appendChild(scelta);
    piu.onclick = () => scelta.click();
    scelta.onchange = () => {
      const f = scelta.files && scelta.files[0];
      scelta.value = '';
      if (f) void onFile(f);
    };
  }

  const go = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    invia.disabled = true;
    invia.textContent = 'INVIO…';
    try {
      await onSend(text);
    } catch (e) {
      // Il testo torna nel campo: un invio fallito non deve far perdere quello
      // che si era scritto.
      input.value = text;
      onErrore(motivo(e));
    } finally {
      invia.disabled = false;
      invia.textContent = 'INVIA';
      input.focus();
    }
  };

  invia.onclick = () => void go();
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void go();
  });
  setTimeout(() => input.focus(), 30);
  return c;
}

/**
 * Avviso di sistema, sotto la barra del titolo. Si accumula al massimo uno alla
 * volta e sparisce da solo: un problema di rete e una notizia, non un blocco.
 */
let timerAvviso = null;
function avvisoDiSistema(testo) {
  let barra = document.querySelector('#avvisoSistema');
  if (!barra) {
    barra = el('<div class="avviso-sistema" id="avvisoSistema"></div>');
    barra.onclick = () => barra.remove();
    document.querySelector('.shell').insertBefore(barra, document.querySelector('.body'));
  }
  barra.textContent = testo;
  clearTimeout(timerAvviso);
  timerAvviso = setTimeout(() => barra.remove(), 8000);
}

/** Avviso in fondo alla conversazione: si vede dove si stava guardando. */
function avvisoNelThread(thread, testo) {
  const riga = el(`<div class="avviso">${esc(testo)}</div>`);
  thread.appendChild(riga);
  thread.scrollTop = thread.scrollHeight;
}

// ---------- conversazione diretta ----------

async function openContact(id) {
  state.open = { kind: 'contatto', id };
  state.view = 'chat';
  renderList();
  await renderContact();
}

async function renderContact() {
  const c = contactById(state.open?.id);
  if (!c) return setPane(viewEmpty());

  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head(
      c.name,
      c.verified
        ? `${presenzaHtml(c)}<span class="row__sep">|</span>CIFRATURA VERIFICATA`
        : `${presenzaHtml(c)}<span class="row__sep">|</span><span class="u-4">NON ANCORA VERIFICATO</span>`,
      [
        ['NUMERO DI SICUREZZA', 'Confronta le cifre a voce', 'outline', () => renderSafety(c.id)],
        ...(api.riavviaSessione
          ? [['RIAVVIA CIFRATURA', 'Se non arrivano piu messaggi', 'outline', () => riavviaCifratura(c)]]
          : []),
        ['ELIMINA', 'Cancella la conversazione, o togli il contatto', 'danger', () => renderElimina(c)],
      ]
    )
  );
  const thread = el('<div class="thread uk-scroll"></div>');
  wrap.appendChild(thread);
  const mandaQui = (f) => mandaFile(c, f, thread);
  wrap.appendChild(
    composer(
      async (text) => metti(thread, await api.send(c.id, text), false),
      (testo) => avvisoNelThread(thread, `NON INVIATO — ${testo}`),
      api.sendFile ? mandaQui : null
    )
  );
  if (api.sendFile) accettaTrascinamento(wrap, mandaQui);
  setPane(wrap);
  fillThread(thread, await api.history(c.id), false, 'NESSUN MESSAGGIO — SCRIVI IL PRIMO');
}

/**
 * Trascinare un file dentro la conversazione.
 *
 * `dragover` va fermato o il browser apre il file al posto nostro, sostituendo
 * l intera pagina. Il contatore serve perche dragenter e dragleave scattano
 * anche passando sopra i figli: senza, il riquadro lampeggerebbe.
 */
function accettaTrascinamento(dove, onFile) {
  let dentro = 0;
  dove.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++dentro === 1) dove.classList.add('accetta-file');
  });
  dove.addEventListener('dragover', (e) => e.preventDefault());
  dove.addEventListener('dragleave', () => {
    if (--dentro <= 0) {
      dentro = 0;
      dove.classList.remove('accetta-file');
    }
  });
  dove.addEventListener('drop', (e) => {
    e.preventDefault();
    dentro = 0;
    dove.classList.remove('accetta-file');
    const f = e.dataTransfer?.files?.[0];
    if (f) void onFile(f);
  });
}

/**
 * Manda un file, scegliendo la strada da solo.
 *
 * Sotto la soglia passa dalla mailbox e arriva anche se l altro e spento.
 * Sopra, serve il collegamento diretto fra i due computer, che esiste solo
 * mentre sono accesi tutti e due — e questo si sa PRIMA di leggere un byte,
 * perche dirlo a meta invio sarebbe peggio che non dirlo.
 */
async function mandaFile(c, f, thread) {
  const impedimento = await api.perche(c.id, f.size);
  if (impedimento) return avvisoNelThread(thread, impedimento);

  try {
    if (f.size <= (state.soglia || 5 * 1024 * 1024)) {
      return metti(thread, await api.sendFile(c.id, f.name, f.type || '', inBase64(new Uint8Array(await f.arrayBuffer()))), false);
    }
    if (!api.iniziaDiretto) {
      // Dal telefono il collegamento diretto non esiste: il telefono e uno
      // schermo del computer, non un capo del trasferimento.
      return avvisoNelThread(
        thread,
        'Dal telefono si mandano file fino a 5 MB. Per quelli piu grandi serve la finestra sul computer, dove i due programmi si collegano direttamente.'
      );
    }
    const m = await api.iniziaDiretto(c.id, f.name, f.type || '', f.size);
    metti(thread, m, false);
    await inviaDiretto(c, m, f);
  } catch (e) {
    avvisoNelThread(thread, `NON INVIATO — ${motivo(e)}`);
  }
}

/**
 * Rifa la cifratura con un contatto.
 *
 * Serve quando i messaggi smettono di arrivare pur vedendosi online: vuol dire
 * che le due sessioni non coincidono piu, e non si rimettono a posto da sole.
 * Va fatto da entrambe le parti, altrimenti si aggiusta una direzione sola.
 * Non cancella niente: rubrica, storico e numero di sicurezza restano.
 */
async function riavviaCifratura(c) {
  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head(c.name, '<span class="uk-section u-9">RIAVVIA CIFRATURA</span>', [
      ['INDIETRO', 'Torna alla conversazione', 'primary', () => openContact(c.id)],
    ])
  );
  const body = el(`<div class="addc uk-scroll">
    <div class="addc__text">Da usare quando <b class="u-10">vedi il contatto online ma i messaggi non
      arrivano</b>. Vuol dire che le due meta della cifratura non coincidono piu, e da sole non si
      rimettono a posto.</div>
    <div class="addc__text u-11">Non cancella niente: restano il contatto, tutto lo
      storico e il numero di sicurezza gia confrontato. Riparte solo la cifratura, dal messaggio dopo.</div>
    <div class="addc__text u-11"><b class="u-4">Dovete farlo tutti e
      due.</b> Se lo fa uno solo, si aggiusta una direzione e l altra resta muta.</div>
  </div>`);
  const b = el('<button class="uk-btn uk-btn--primary uk-btn--lg u-12">RIAVVIA LA CIFRATURA</button>');
  const esito = el('<div class="addc__text u-13"></div>');
  b.onclick = async () => {
    b.disabled = true;
    b.textContent = 'RIAVVIO…';
    try {
      await api.riavviaSessione(c.id);
      esito.innerHTML =
        '<b class="u-10">Fatto.</b> Ora scrivigli un messaggio. Se non arriva ancora, ' +
        'vuol dire che dall altra parte non e stato fatto.';
      b.textContent = 'RIAVVIATA';
    } catch (e) {
      esito.textContent = motivo(e);
      b.disabled = false;
      b.textContent = 'RIAVVIA LA CIFRATURA';
    }
  };
  body.appendChild(riga(b));
  body.appendChild(esito);
  wrap.appendChild(body);
  setPane(wrap);
}

// ---------- conversazione di gruppo ----------

async function openGroup(id, topicId) {
  const g = groupById(id);
  if (!g) return;
  state.open = { kind: 'gruppo', id, topic: topicId || g.topics[0]?.id };
  state.view = 'chat';
  renderList();
  await renderGroup();
}

async function renderGroup() {
  const g = groupById(state.open?.id);
  if (!g) return setPane(viewEmpty());
  const topicId = state.open.topic || g.topics[0]?.id;
  const topic = g.topics.find((t) => t.id === topicId) || g.topics[0];

  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head(
      g.name,
      `<span class="uk-section u-9">${g.members.length} MEMBRI</span>` +
        `<span class="row__sep">|</span>${g.members.map((m) => esc(m.name)).join(', ')}`,
      [['ABBANDONA', 'Esci dal gruppo', 'danger', () => leaveGroup(g)]]
    )
  );

  // Argomenti: le conversazioni separate dentro lo stesso gruppo.
  const topics = el('<div class="topics"></div>');
  for (const t of g.topics) {
    const b = el(`<button class="pill" data-on="${t.id === topic?.id ? 1 : 0}">${esc(t.name)}</button>`);
    b.onclick = () => openGroup(g.id, t.id);
    topics.appendChild(b);
  }
  // Il nome si scrive dove comparira' l argomento, non in una finestrella:
  // Electron non ha `window.prompt` — esiste ma lancia "prompt() is not
  // supported", quindi qui il pulsante non faceva proprio niente.
  const piu = el('<button class="pill" title="Nuovo argomento">+ ARGOMENTO</button>');
  piu.onclick = () => {
    const campo = el('<input class="pill pill--campo" placeholder="nome argomento" maxlength="40" />');
    const annulla = () => campo.replaceWith(piu);
    const conferma = async () => {
      const nome = campo.value.trim();
      if (!nome) return annulla();
      campo.disabled = true;
      try {
        const t = await api.addTopic(g.id, nome);
        await refreshAll();
        await openGroup(g.id, t.id);
      } catch (e) {
        annulla();
        avvisoNelThread(thread, motivo(e));
      }
    };
    campo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void conferma();
      if (ev.key === 'Escape') annulla();
    });
    campo.addEventListener('blur', () => {
      if (!campo.disabled) annulla();
    });
    piu.replaceWith(campo);
    campo.focus();
  };
  topics.appendChild(piu);
  wrap.appendChild(topics);

  const thread = el('<div class="thread uk-scroll"></div>');
  wrap.appendChild(thread);
  wrap.appendChild(
    composer(
      async (text) => {
        const m = await api.sendGroup(g.id, topic?.id, text);
        thread.appendChild(bubble(m, true));
        thread.scrollTop = thread.scrollHeight;
      },
      (testo) => avvisoNelThread(thread, `NON INVIATO — ${testo}`)
    )
  );
  setPane(wrap);
  fillThread(thread, await api.groupHistory(g.id, topic?.id), true, 'NESSUN MESSAGGIO IN QUESTO ARGOMENTO');
}

async function leaveGroup(g) {
  if (!window.confirm(`Uscire da ${g.name} e cancellarne lo storico? Non è reversibile.`)) return;
  await api.leaveGroup(g.id);
  state.open = null;
  await refreshAll();
  setPane(viewEmpty());
}

// ---------- numero di sicurezza ----------

async function renderSafety(id) {
  const c = contactById(id);
  const gruppi = (await api.safetyNumber(id)).split(' ');
  const righe = [];
  for (let i = 0; i < gruppi.length; i += 4) righe.push(gruppi.slice(i, i + 4).join('  '));

  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head('NUMERO DI SICUREZZA', `<span class="uk-section u-9">CON ${esc(c.name)}</span>`, [
      ['INDIETRO', 'Torna alla conversazione', 'primary', () => renderContact()],
    ])
  );
  wrap.appendChild(
    el(`
    <div class="safety uk-scroll">
      <div class="safety__grid">${righe.map((r) => `<div>${esc(r)}</div>`).join('')}</div>
      <div class="safety__text">
        Leggetelo a voce, tutti e due. Se le cifre coincidono, nessuno sta in mezzo alla vostra
        conversazione. Se <b>non</b> coincidono, la card è stata sostituita: non scrivetevi e
        rifate lo scambio di persona.
      </div>
      <div class="safety__acts">
        <button class="uk-btn uk-btn--primary u-14" id="safeOk">COINCIDE — VERIFICA</button>
      </div>
    </div>`)
  );
  setPane(wrap);
  wrap.querySelector('#safeOk').onclick = async () => {
    await api.markVerified(id);
    await refreshAll();
    await openContact(id);
  };
}

// ---------- nuovo contatto / nuovo gruppo ----------

/** Racchiude un pulsante nella riga di azioni, per non ripetere il markup. */
function riga(...nodes) {
  const r = el('<div class="addc__acts"></div>');
  r.append(...nodes);
  return r;
}

function renderNew() {
  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head('NUOVO', '<span class="uk-section u-9">CONTATTO O GRUPPO</span>', [
      ['INDIETRO', 'Annulla', 'primary', () => restore()],
    ])
  );

  const body = el('<div class="addc uk-scroll"></div>');
  body.appendChild(
    el(`
    <div>
      <div class="uk-section">LA TUA CARD</div>
      <div class="addc__text">Dalla a chi vuoi ti scriva. È firmata: se qualcuno la altera per strada, viene rifiutata.</div>
      <div class="addc__uri">${esc(state.me.uri || '')}</div>
    </div>`)
  );
  const copia = el('<button class="uk-btn uk-btn--outline u-15">COPIA</button>');
  copia.onclick = async () => {
    await navigator.clipboard.writeText(state.me.uri || '');
    copia.textContent = 'COPIATA';
    setTimeout(() => (copia.textContent = 'COPIA'), 1500);
  };
  body.appendChild(copia);

  body.appendChild(
    el(`
    <div class="u-16">
      <div class="uk-section">AGGIUNGI UN CONTATTO</div>
      <div class="addc__text">Incolla la riga che ti ha dato l'altro.</div>
    </div>`)
  );
  const uri = el('<input class="uk-field" placeholder="wire:1:…" />');
  const nome = el('<input class="uk-field u-17" placeholder="Come vuoi chiamarlo" />');
  const err = el('<div class="lock__err"></div>');
  const addBtn = el('<button class="uk-btn uk-btn--primary u-15">AGGIUNGI</button>');
  addBtn.onclick = async () => {
    err.textContent = '';
    try {
      const c = await api.addContact(uri.value.trim(), nome.value);
      await refreshAll();
      await openContact(c.id);
    } catch (e) {
      err.textContent = motivo(e);
    }
  };
  body.append(uri, nome, riga(addBtn), err);

  // --- gruppo ---
  body.appendChild(
    el(`
    <div class="u-18">
      <div class="uk-section">CREA UN GRUPPO</div>
      <div class="addc__text">Scegli chi ne fa parte. I membri si ritroveranno gli altri in rubrica
        come <b class="u-4">non verificati</b>: il numero di sicurezza con ciascuno
        va confrontato a voce, uno per uno.</div>
    </div>`)
  );
  const gnome = el('<input class="uk-field" placeholder="Nome del gruppo" />');
  body.appendChild(gnome);

  const scelti = new Set();
  const lista = el('<div class="picker"></div>');
  if (!state.contacts.length) {
    lista.appendChild(el('<div class="addc__text">Nessun contatto da aggiungere: prima aggiungine almeno uno.</div>'));
  }
  for (const c of state.contacts) {
    const b = el(`<button class="pill">${esc(c.name)}</button>`);
    b.onclick = () => {
      scelti.has(c.id) ? scelti.delete(c.id) : scelti.add(c.id);
      b.dataset.on = scelti.has(c.id) ? '1' : '0';
    };
    lista.appendChild(b);
  }
  body.appendChild(lista);

  const gerr = el('<div class="lock__err"></div>');
  const gBtn = el('<button class="uk-btn uk-btn--primary u-15">CREA GRUPPO</button>');
  gBtn.onclick = async () => {
    gerr.textContent = '';
    try {
      const g = await api.createGroup(gnome.value, [...scelti]);
      await refreshAll();
      await openGroup(g.id);
    } catch (e) {
      gerr.textContent = motivo(e);
    }
  };
  body.append(riga(gBtn), gerr);

  wrap.appendChild(body);
  setPane(wrap);
}

/**
 * I dispositivi collegati, e come aggiungerne uno.
 *
 * Due mestieri diversi a seconda di dove gira. Sul computer si MOSTRA il
 * codice; sul telefono lo si INQUADRA, perche' portare a mano seicento
 * caratteri che contengono una chiave privata non e una cosa da chiedere a
 * nessuno — e mandarseli per email significherebbe consegnarla a quel servizio.
 */
async function renderDispositivi() {
  const elenco = await api.dispositivi();
  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head('DISPOSITIVI', `<span class="uk-section u-9">${elenco.length} COLLEGATI</span>`, [
      ['INDIETRO', 'Torna indietro', 'primary', () => restore()],
    ])
  );
  const body = el('<div class="addc uk-scroll"></div>');

  body.appendChild(
    el(`<div class="addc__text">Ogni dispositivo ha chiavi sue, e chi ti scrive cifra una volta per
      ciascuno. Cosi il computer funziona anche a telefono spento, e viceversa.</div>`)
  );

  for (const d of elenco) {
    body.appendChild(
      el(`<div class="scelta u-13">
        <div class="scelta__titolo">${esc(d.nome || 'senza nome')}${d.questo ? ' · QUESTO' : ''}</div>
        <div class="addc__text u-19">${esc(d.id.slice(0, 16))}</div>
      </div>`)
    );
  }

  const b = el('<button class="uk-btn uk-btn--primary uk-btn--lg u-12">COLLEGA UN DISPOSITIVO</button>');
  b.onclick = () => (api.runtime === 'PWA' ? inquadraCodice() : mostraCodice());
  body.appendChild(riga(b));

  body.appendChild(
    el(`<div class="addc__text u-20"><b class="u-4">Collegando un
      dispositivo il numero di sicurezza cambia</b> per tutti i tuoi contatti: dovrete riconfrontare
      le cifre. E fastidioso, ed e l unica cosa che vi fa accorgere di un dispositivo che non avete
      messo voi.</div>`)
  );

  if (api.runtime === 'ELECTRON' && api.turn) body.appendChild(sezioneTurn());

  wrap.appendChild(body);
  setPane(wrap);
}

/**
 * Il server di appoggio per i file grandi, quando due router non si trovano.
 *
 * Sta qui e non in un pannello suo: riguarda questo computer e nessun contatto
 * in particolare, come i dispositivi. Il controllo dei valori lo fa il cuore;
 * la pagina mostra solo l'errore che torna. La password si vede mentre la si
 * scrive: e' la credenziale di un relay, non quella dell'account, e un campo
 * mascherato porterebbe a salvare refusi senza accorgersene.
 */
function sezioneTurn() {
  const box = el('<div class="u-18"></div>');
  const stato = el('<div class="uk-section"></div>');
  const url = el('<input class="uk-field u-17" placeholder="turn:relay.esempio.it:3478" autocomplete="off" spellcheck="false" />');
  const utente = el('<input class="uk-field u-17" placeholder="Nome utente" autocomplete="off" spellcheck="false" />');
  const password = el('<input class="uk-field u-17" placeholder="Password" autocomplete="off" spellcheck="false" />');
  const err = el('<div class="lock__err u-19"></div>');
  const salva = el('<button class="uk-btn uk-btn--primary u-15">SALVA</button>');
  const togli = el('<button class="uk-btn uk-btn--outline u-15">TOGLI</button>');

  const mostra = () => {
    const t = state.turn;
    stato.textContent = t ? `SERVER DI APPOGGIO · ATTIVO` : 'SERVER DI APPOGGIO · NESSUNO';
    url.value = t ? t.url : '';
    utente.value = t ? t.utente : '';
    password.value = t ? t.password : '';
    togli.disabled = !t;
  };

  salva.onclick = async () => {
    err.textContent = '';
    try {
      state.turn = await api.impostaTurn({ url: url.value, utente: utente.value, password: password.value });
      mostra();
      salva.textContent = 'SALVATO';
      setTimeout(() => (salva.textContent = 'SALVA'), 1500);
    } catch (e) {
      err.textContent = motivo(e);
    }
  };
  togli.onclick = async () => {
    err.textContent = '';
    try {
      state.turn = await api.impostaTurn(null);
      mostra();
    } catch (e) {
      err.textContent = motivo(e);
    }
  };

  box.append(
    stato,
    el(`<div class="addc__text">I file oltre la soglia vanno da computer a computer. Quando i due router
      non si trovano, il collegamento non parte: un server TURN fa da tramite e lo sblocca. Vede gli
      indirizzi dei due e un flusso cifrato, non il contenuto. Basta che lo abbia <b class="u-4">uno
      solo dei due</b>. Questo programma non ne porta uno: serve il proprio, o quello di un fornitore.
      Senza, resta tutto come prima.</div>`),
    url,
    utente,
    password,
    riga(salva, togli),
    err
  );
  mostra();
  return box;
}

/** Sul computer: si mostra il codice, e si aspetta che l altro lo inquadri. */
async function mostraCodice() {
  const { uri, qr } = await api.codiceCollegamento();
  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head('COLLEGA UN DISPOSITIVO', '<span class="uk-section u-9">INQUADRA DALL ALTRO</span>', [
      ['INDIETRO', 'Torna indietro', 'primary', () => renderDispositivi()],
    ])
  );
  const body = el('<div class="addc uk-scroll"></div>');
  body.appendChild(
    el(`<div class="addc__text"><b class="u-4">Questo codice contiene la chiave del tuo
      account.</b> Chi fotografa lo schermo mentre e visibile diventa un tuo dispositivo e legge
      tutto quello che ti scrivono. Vale cinque minuti: mostralo il tempo di inquadrarlo.</div>`)
  );
  if (qr) body.appendChild(el(`<div class="qr-riga"><div class="qr-carta"><div class="qr">${qr}</div></div></div>`));
  const testo = el('<button class="uk-btn uk-btn--outline u-14">MOSTRA COME TESTO</button>');
  testo.onclick = () => testo.replaceWith(el(`<div class="uri">${esc(uri)}</div>`));
  body.appendChild(riga(testo));
  wrap.appendChild(body);
  setPane(wrap);
}

/**
 * Sul telefono: si inquadra il codice mostrato dal computer.
 *
 * A mano non si puo' chiedere: il codice e' seicentocinquanta caratteri, e
 * dentro c'e' una chiave privata — che non si manda per email, perche' vorrebbe
 * dire consegnarla a quel servizio. Resta l'incolla per chi lo ha spostato con
 * mezzi suoi.
 *
 * La fotocamera vuole HTTPS: la PWA sta su un indirizzo HTTPS, quindi c'e'.
 * Se manca il permesso non si resta davanti a un rettangolo nero — si dice
 * cosa e' successo e si offre l'altra strada.
 */
async function inquadraCodice() {
  const wrap = el('<div class="u-8"></div>');
  let fermaTutto = () => {};
  wrap.appendChild(
    head('COLLEGA QUESTO TELEFONO', '<span class="uk-section u-9">INQUADRA IL CODICE</span>', [
      [
        'INDIETRO',
        'Torna indietro',
        'primary',
        () => {
          fermaTutto();
          renderDispositivi();
        },
      ],
    ])
  );
  const body = el('<div class="addc uk-scroll"></div>');
  body.appendChild(
    el(`<div class="addc__text">Sul computer apri <b class="u-10">DISPOSITIVI &rsaquo; COLLEGA UN
      DISPOSITIVO</b> e inquadra il codice che compare. Vale cinque minuti.</div>`)
  );

  const stato = el('<div class="addc__text u-17">Chiedo la fotocamera...</div>');
  body.appendChild(stato);

  const video = el('<video class="qr-video" playsinline muted></video>');
  const cornice = el('<div class="qr-riga"><div class="qr-carta"></div></div>');
  cornice.querySelector('.qr-carta').appendChild(video);
  body.appendChild(cornice);

  const incolla = el('<button class="uk-btn uk-btn--outline u-14">INCOLLA IL CODICE</button>');
  incolla.onclick = () => {
    fermaTutto();
    incollaCodice();
  };
  body.appendChild(riga(incolla));
  wrap.appendChild(body);
  setPane(wrap);

  if (!window.wireQr || !navigator.mediaDevices?.getUserMedia) {
    cornice.remove();
    stato.innerHTML = 'Questo browser non apre la fotocamera. Incolla il codice qui sotto.';
    return;
  }

  let flusso = null;
  let vivo = true;
  let prossimo = 0;
  fermaTutto = () => {
    vivo = false;
    clearTimeout(prossimo);
    for (const t of flusso?.getTracks() ?? []) t.stop();
  };
  // Se si cambia schermata senza passare da INDIETRO, la fotocamera deve
  // spegnersi lo stesso: una spia accesa a vuoto e' un difetto, non un dettaglio.
  const osserva = new MutationObserver(() => {
    if (!document.contains(video)) {
      fermaTutto();
      osserva.disconnect();
    }
  });
  osserva.observe(document.body, { childList: true, subtree: true });

  try {
    flusso = await navigator.mediaDevices.getUserMedia({
      // Quella dietro: si inquadra lo schermo di un altro apparecchio.
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (e) {
    cornice.remove();
    stato.innerHTML =
      e && e.name === 'NotAllowedError'
        ? 'Permesso negato. Dallo alla pagina dalle impostazioni del browser, oppure incolla il codice.'
        : `Fotocamera non disponibile: ${esc(String(e?.message || e))}`;
    return;
  }
  if (!vivo) {
    for (const t of flusso.getTracks()) t.stop();
    return;
  }

  video.srcObject = flusso;
  await video.play().catch(() => {});
  stato.innerHTML = 'Inquadra il codice sullo schermo del computer.';

  const tela = document.createElement('canvas');
  const pennello = tela.getContext('2d', { willReadFrequently: true });

  const guarda = () => {
    if (!vivo) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      // Ridotto a 720 di lato: un fotogramma intero e' piu' pixel di quanti ne
      // servano, e su un telefono lento vuol dire scatti invece di lettura.
      // Non meno di 720, pero': il codice e' 89 moduli, e provato con sfocatura
      // e rumore a 480 px non si legge piu' se il QR non riempie l'inquadratura.
      const scala = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      tela.width = Math.round(video.videoWidth * scala);
      tela.height = Math.round(video.videoHeight * scala);
      if (tela.width && tela.height) {
        pennello.drawImage(video, 0, 0, tela.width, tela.height);
        const q = tela.width && tela.height ? pennello.getImageData(0, 0, tela.width, tela.height) : null;
        const testo = q && window.wireQr.leggi(q.data, q.width, q.height);
        if (testo) {
          fermaTutto();
          usaCodice(testo, stato);
          return;
        }
      }
    }
    // Un timer e non `requestAnimationFrame`: quello si ferma quando la pagina
    // non e' in primo piano — provato, e la lettura restava appesa senza dirlo.
    // Dieci volte al secondo bastano per un codice che sta fermo davanti, e
    // costano molto meno batteria di sessanta.
    prossimo = setTimeout(guarda, 100);
  };
  guarda();
}

/** L altra strada: il codice arrivato in qualche altro modo, incollato. */
function incollaCodice() {
  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head('COLLEGA QUESTO TELEFONO', '<span class="uk-section u-9">INCOLLA IL CODICE</span>', [
      ['INDIETRO', 'Torna indietro', 'primary', () => inquadraCodice()],
    ])
  );
  const body = el('<div class="addc uk-scroll"></div>');
  const campo = el('<textarea class="uk-field addc__area" rows="5" placeholder="wire-collega:1:..."></textarea>');
  body.appendChild(campo);
  const stato = el('<div class="addc__text u-17"></div>');
  const ok = el('<button class="uk-btn uk-btn--primary u-14">COLLEGA</button>');
  ok.onclick = () => usaCodice(campo.value.trim(), stato);
  body.appendChild(riga(ok));
  body.appendChild(stato);
  wrap.appendChild(body);
  setPane(wrap);
  campo.focus();
}

/**
 * Il passo che conta, uguale per il QR e per l incolla.
 *
 * Non si torna alla lista dei dispositivi con un messaggio breve: collegare un
 * dispositivo cambia il numero di sicurezza per tutti i contatti, e chi lo ha
 * appena fatto deve saperlo mentre lo fa, non scoprirlo dopo.
 */
async function usaCodice(codice, stato) {
  stato.innerHTML = 'Collego...';
  try {
    await api.collegatiCome(codice);
  } catch (e) {
    stato.innerHTML = `<b class="u-4">Non ha funzionato.</b> ${esc(String(e?.message || e))}`;
    return;
  }
  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head('COLLEGATO', '<span class="uk-section u-9">QUESTO TELEFONO E TUO</span>', [
      ['FATTO', 'Torna indietro', 'primary', () => renderDispositivi()],
    ])
  );
  const body = el('<div class="addc uk-scroll"></div>');
  body.appendChild(
    el(`<div class="addc__text">Questo telefono ora fa parte del tuo account: chi ti scrive cifra
      anche per lui, e le conversazioni arrivano su tutti e due.</div>`)
  );
  body.appendChild(
    el(`<div class="addc__text u-20"><b class="u-4">Il numero di sicurezza con i tuoi contatti
      e cambiato.</b> Vi conviene riconfrontarlo: e l unica cosa che vi fa accorgere di un
      dispositivo che non avete messo voi.</div>`)
  );
  wrap.appendChild(body);
  setPane(wrap);
}

/**
 * Eliminare: due cose diverse, che prima ne facevano una sola.
 *
 * Il pulsante cancellava la conversazione E toglieva il contatto dalla
 * rubrica, senza dirlo. Sono decisioni distinte: ripulire una conversazione
 * capita spesso, togliere una persona quasi mai, e chi voleva la prima si
 * ritrovava la seconda.
 */
async function renderElimina(c) {
  const wrap = el('<div class="u-8"></div>');
  wrap.appendChild(
    head(c.name, '<span class="uk-section u-9">COSA VUOI ELIMINARE</span>', [
      ['INDIETRO', 'Torna alla conversazione', 'primary', () => openContact(c.id)],
    ])
  );
  const body = el('<div class="addc uk-scroll"></div>');
  const esito = el('<div class="lock__err"></div>');

  const scelta = (titolo, testo, etichetta, azione) => {
    const box = el(`<div class="scelta">
      <div class="scelta__titolo">${titolo}</div>
      <div class="addc__text u-25">${testo}</div>
    </div>`);
    const b = el(`<button class="uk-btn uk-btn--danger u-26">${etichetta}</button>`);
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'ELIMINO…';
      try {
        await azione();
      } catch (e) {
        esito.textContent = motivo(e);
        b.disabled = false;
        b.textContent = etichetta;
      }
    };
    box.appendChild(b);
    return box;
  };

  body.appendChild(
    scelta(
      'Solo i messaggi',
      `Cancella tutta la conversazione con ${esc(c.name)}, e i file ricevuti. ${esc(c.name)} resta in
       rubrica, resta verificato, e potete continuare a scrivervi. Dal suo dispositivo non sparisce niente.`,
      'CANCELLA LA CONVERSAZIONE',
      async () => {
        await api.svuotaConversazione(c.id);
        await openContact(c.id);
      }
    )
  );

  body.appendChild(
    scelta(
      'Anche il contatto',
      `Toglie ${esc(c.name)} dalla rubrica: spariscono conversazione, file e la verifica del numero di
       sicurezza. Per riparlargli servira' di nuovo la sua card, e ripartirete da "da verificare".
       Dal suo dispositivo non sparisce niente: lui continuera' a vedere te.`,
      'ELIMINA IL CONTATTO',
      async () => {
        await api.removeContact(c.id);
        state.open = null;
        setPane(viewEmpty());
        mostra('lista');
        await refreshAll();
      }
    )
  );

  body.appendChild(esito);
  wrap.appendChild(body);
  setPane(wrap);
}


// ---------- avvio ----------

function restore() {
  if (state.open?.kind === 'contatto') return renderContact();
  if (state.open?.kind === 'gruppo') return renderGroup();
  return setPane(viewEmpty());
}

/** Aggiorna la sola riga di stato della conversazione aperta, senza toccare
 *  il resto del pannello. */
function aggiornaPresenzaAperta() {
  if (state.open?.kind !== 'contatto') return;
  const campo = $('#pane')?.querySelector('.pane__presenza');
  const c = contactById(state.open.id);
  if (!campo || !c) return;
  campo.outerHTML = presenzaHtml(c);
}

async function refreshAll() {
  const [contacts, groups] = await Promise.all([api.contacts(), api.groups()]);
  state.contacts = contacts;
  state.groups = groups;
  renderList();
}

async function boot() {
  const s = await api.state();
  if (!s.unlocked) return lockScreen(s);
  const profilo = await api.profile();
  state.me = { ...profilo, uri: s.uri };
  state.soglia = s.soglia || 5 * 1024 * 1024;
  // Solo sul computer: il collegamento diretto, e con lui il TURN, non esistono
  // sul telefono, e il ponte del telefono non ha questa chiamata.
  state.turn = api.turn ? await api.turn() : null;
  // La versione sta a schermo apposta: senza, non c'e' modo di sapere quale
  // build si sta usando, e un aggiornamento non applicato passa inosservato.
  $('#meAddress').textContent = s.versione ? `${profilo.name} · v${s.versione}` : profilo.name;
  await refreshAll();
  setPane(viewEmpty());
  mostra('lista');

  // I guai di rete che il processo principale intercetta devono arrivare a chi
  // guarda. Il canale c era gia, ma nessuno lo ascoltava: gli avvisi finivano
  // nel vuoto e l app sembrava non avere problemi mentre ne aveva.
  // Blocco automatico: si torna alla schermata della passphrase. `boot`
  // rilegge lo stato, trova l account chiuso, e mostra quella giusta.
  if (api.onBloccato) {
    api.onBloccato(() => {
      state.open = null;
      void boot();
    });
  }

  if (api.onProblema) {
    api.onProblema(({ dove, testo }) => avvisoDiSistema(`${dove}: ${testo}`));
  }

  // Il pallino non ha un evento suo: si ricontrolla ogni tanto. Vale anche al
  // contrario — chi era online e smette di battere deve spegnersi da solo,
  // e per quello non arriva nessun avviso, per definizione.
  setInterval(() => {
    // Solo l elenco e la riga di stato: ridisegnare la conversazione
    // cancellerebbe quello che si sta scrivendo e la posizione dello scorrimento.
    void refreshAll()
      .then(aggiornaPresenzaAperta)
      .catch(() => {});
  }, 20000);

  // Il collegamento diretto vive qui dentro: il processo principale gli
  // inoltra soltanto le segnalazioni.
  if (api.onSegnale) api.onSegnale(({ da, p }) => void riceviSegnale(da, p));

  api.onMessage(async (m) => {
    const soloAvanzamento = m.file && m.file.stato === 'in-corso';
    if (!soloAvanzamento) await refreshAll();
    const suoGruppo =
      m.group && state.open?.kind === 'gruppo' && state.open.id === m.group && m.topic === state.open.topic;
    const suaChat = !m.group && state.open?.kind === 'contatto' && state.open.id === m.peer;
    // Si aggiunge la riga, non si ridisegna il pannello: ridisegnare faceva
    // sfarfallare tutto e perdeva la posizione dello scorrimento a ogni
    // messaggio, e a ogni pezzo di un file in arrivo.
    if (suoGruppo || suaChat) metti($('#pane')?.querySelector('.thread'), m, Boolean(m.group));
  });
}

// I pulsanti della finestra hanno senso solo dove c'e' una finestra da
// comandare. Sul telefono e nel browser non fanno niente, e tre pulsanti che
// non fanno niente in cima allo schermo sono peggio di nessun pulsante.
if (api.runtime === 'ELECTRON') {
  document.querySelectorAll('[data-win]').forEach((b) => (b.onclick = () => api.window(b.dataset.win)));
} else {
  document.querySelector('.titlebar__ctrls')?.remove();
}
$('#btnNew').onclick = renderNew;
// I dispositivi collegati. Questo pulsante c'e' dappertutto: sul computer mostra
// il codice, sul telefono apre la fotocamera per inquadrarlo. E' l'unica strada
// per il telefono, da quando il pannello che ne faceva uno schermo del PC non
// esiste piu': l'app sul telefono ha chiavi sue e parla da sola con i relay.
{
  const b = el(`<button class="uk-btn uk-btn--outline uk-btn--icon" title="Dispositivi collegati">
    <svg viewBox="0 0 22 18" width="19" height="16" aria-hidden="true">
      <rect x="0.6" y="0.6" width="14" height="10.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.2"/>
      <line x1="4.6" y1="15.4" x2="10.6" y2="15.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="7.6" y1="11" x2="7.6" y2="15.4" stroke="currentColor" stroke-width="1.2"/>
      <rect x="16.4" y="4.6" width="5" height="12.8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.2"/>
    </svg></button>`);
  b.onclick = renderDispositivi;
  $('#sideActs').appendChild(b);
}

/**
 * Il ritiro dalla mailbox non ha piu un pulsante.
 *
 * Serviva quando l ascolto in tempo reale saltava senza dirlo, e premerlo era
 * l unico modo di accorgersene. Un compito del genere non si lascia a chi usa
 * il programma: adesso il ritiro si rifa da solo ogni cinque minuti, e chi
 * guarda non deve sapere che esiste.
 */
setInterval(() => {
  void api
    .sync()
    .then(() => refreshAll())
    .catch(() => {});
}, 300000);

if (api.runtime === 'TELEFONO') {
  document.body.classList.add('da-telefono');
  adattaAllaTastiera();
}

/**
 * La tastiera del telefono non restringe la pagina: ci si appoggia sopra.
 *
 * Il risultato e che il campo per scrivere finisce sotto la tastiera, e si
 * scrive alla cieca. `visualViewport` dice quanto schermo resta davvero
 * visibile in questo momento — quella e l altezza che deve avere la finestra
 * dell app, non l altezza dello schermo.
 */
function adattaAllaTastiera() {
  const vv = window.visualViewport;
  if (!vv) return; // browser vecchio: resta il comportamento di prima
  const applica = () => {
    document.documentElement.style.setProperty('--altezza-visibile', `${Math.round(vv.height)}px`);
    // Senza questo la pagina resta scorsa verso il basso quando la tastiera si
    // chiude, e in cima rimane una striscia vuota.
    window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', applica);
  vv.addEventListener('scroll', applica);
  applica();

  // Aprendo la tastiera si vuole vedere l ultimo messaggio, non il primo.
  document.addEventListener('focusin', (e) => {
    if (!e.target.closest?.('.composer')) return;
    setTimeout(() => {
      const t = document.querySelector('.thread');
      if (t) t.scrollTop = t.scrollHeight;
    }, 250);
  });
}

renderFilters();
mostra('lista');
void boot();
