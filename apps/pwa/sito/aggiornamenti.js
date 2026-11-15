// L'avviso di aggiornamento, sul telefono.
//
// Esiste solo qui: sul computer e nell'app Android i file stanno dentro il
// programma, e non c'e' niente da controllare. Su questa strada invece l'app
// arriva da un indirizzo web, e chi controlla quell'indirizzo potrebbe
// cambiarla — quindi il telefono parte sempre dalla copia che ha, e un
// aggiornamento entra solo quando qualcuno lo accetta guardandolo.
//
// La barra dice due cose in una: che c'e' una versione nuova, e — implicito ma
// il motivo per cui e' fatta cosi' — che i file sul sito sono cambiati. Se
// compare quando nessuno ha pubblicato niente, e' una notizia.

(() => {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('sw.js').catch(() => {});

  const barra = () => {
    const b = document.createElement('div');
    b.className = 'agg';
    b.innerHTML =
      '<div class="agg__testo"><b>Aggiornamento disponibile.</b> ' +
      'I file dell\'app sul sito sono cambiati. Se non hai pubblicato niente, ' +
      'non installarlo e controlla il tuo account.</div>';

    const ok = document.createElement('button');
    ok.className = 'agg__btn agg__btn--si';
    ok.textContent = 'INSTALLA';
    ok.onclick = () => {
      ok.disabled = true;
      ok.textContent = 'SCARICO...';
      navigator.serviceWorker.controller?.postMessage('applica-aggiornamento');
    };

    const no = document.createElement('button');
    no.className = 'agg__btn';
    no.textContent = 'PIU TARDI';
    no.onclick = () => b.remove();

    b.append(ok, no);
    return b;
  };

  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.tipo === 'aggiornamento' && e.data.diverso) {
      if (!document.querySelector('.agg')) document.body.appendChild(barra());
      return;
    }
    if (e.data?.tipo === 'aggiornato') {
      if (e.data.riuscito) {
        location.reload();
        return;
      }
      const b = document.querySelector('.agg__btn--si');
      if (b) {
        b.disabled = false;
        b.textContent = 'RIPROVA';
      }
    }
  });

  // Si controlla all'avvio, non di continuo: una versione nuova non e' una cosa
  // che arriva mentre si sta scrivendo, e chiedere al sito ogni pochi minuti
  // vorrebbe dire dire a chi ospita l'app quando la si tiene aperta.
  const controlla = () => navigator.serviceWorker.controller?.postMessage('cerca-aggiornamento');
  if (navigator.serviceWorker.controller) controlla();
  else navigator.serviceWorker.addEventListener('controllerchange', controlla, { once: true });
})();
