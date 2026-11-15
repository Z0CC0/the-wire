// Ponte fra la finestra e il processo principale.
//
// Superficie minima: un solo canale per le operazioni, piu' i controlli della
// finestra e il telefono. La finestra non tocca ne' il disco ne' le chiavi.
const { contextBridge, ipcRenderer } = require('electron');

const call = (metodo, ...args) => ipcRenderer.invoke('wire:call', metodo, args);

contextBridge.exposeInMainWorld('wireApi', {
  runtime: 'ELECTRON',
  window: (action) => ipcRenderer.send('wire:window', action),

  state: () => call('state'),
  create: (passphrase) => call('create', passphrase),
  unlock: (passphrase) => call('unlock', passphrase),

  profile: () => call('profile'),
  setName: (name) => call('setName', name),

  contacts: () => call('contacts'),
  archivia: (id, valore) => call('archivia', id, valore),
  riordina: (ids) => call('riordina', ids),
  addContact: (uri, name) => call('addContact', uri, name),
  removeContact: (id) => call('removeContact', id),
  svuotaConversazione: (id) => call('svuotaConversazione', id),
  safetyNumber: (id) => call('safetyNumber', id),
  markVerified: (id) => call('markVerified', id),
  riavviaSessione: (id) => call('riavviaSessione', id),

  history: (id) => call('history', id),
  send: (id, text) => call('send', id, text),
  sync: () => call('sync'),
  codiceCollegamento: () => call('codiceCollegamento'),
  dispositivi: () => call('dispositivi'),
  eliminaMessaggio: (messaggioId, perEntrambi) => call('eliminaMessaggio', messaggioId, perEntrambi),

  // File. I byte viaggiano in base64: una stringa attraversa il ponte in un
  // colpo solo, mentre un array di numeri costa una serializzazione per
  // elemento — su un file grosso e' li' che se ne andrebbe tutto il tempo.
  perche: (id, dimensione) => call('perche', id, dimensione),
  sendFile: (id, nome, tipo, dati) => call('sendFile', id, nome, tipo, dati),
  iniziaDiretto: (id, nome, tipo, dimensione) => call('iniziaDiretto', id, nome, tipo, dimensione),
  fileDati: (fileId) => call('fileDati', fileId),
  salvaFile: (fileId, nome) => call('salvaFile', fileId, nome),
  destinazione: (nome) => call('destinazione', nome),
  chiudiDestinazione: (gettone) => call('chiudiDestinazione', gettone),
  riprendiDestinazione: (messaggioId) => call('riprendiDestinazione', messaggioId),
  avanzamentoDiretto: (messaggioId, fatti) => call('avanzamentoDiretto', messaggioId, fatti),
  scriviPezzo: (percorso, dati) => call('scriviPezzo', percorso, dati),
  azzeraFile: (percorso) => call('azzeraFile', percorso),
  mostraNellaCartella: (percorso) => call('mostraNellaCartella', percorso),
  esitoDiretto: (messaggioId, cambi) => call('esitoDiretto', messaggioId, cambi),

  // Segnalazione del collegamento diretto: fuori vanno solo descrizioni di
  // sessione e candidati, cifrati dal ratchet come qualsiasi messaggio.
  segnale: (id, p) => call('segnale', id, p),
  // Il server di appoggio per quando due router non si trovano.
  turn: () => call('turn'),
  impostaTurn: (valore) => call('impostaTurn', valore),
  onSegnale: (cb) => {
    const handler = (_e, m) => cb(m);
    ipcRenderer.on('wire:segnale', handler);
    return () => ipcRenderer.removeListener('wire:segnale', handler);
  },

  groups: () => call('groups'),
  createGroup: (name, memberIds) => call('createGroup', name, memberIds),
  groupHistory: (id, topicId) => call('groupHistory', id, topicId),
  sendGroup: (id, topicId, text) => call('sendGroup', id, topicId, text),
  addTopic: (id, name) => call('addTopic', id, name),
  addMember: (id, contactId) => call('addMember', id, contactId),
  leaveGroup: (id) => call('leaveGroup', id),

  // Solo la finestra sul PC comanda il server: da remoto non si accende
  // e non si spegne niente.

  // Problemi di rete: la finestra li mostra invece di far morire il programma.
  // Il blocco automatico: la finestra torna alla schermata della passphrase.
  onBloccato: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('wire:bloccato', handler);
    return () => ipcRenderer.removeListener('wire:bloccato', handler);
  },

  onProblema: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('wire:problema', handler);
    return () => ipcRenderer.removeListener('wire:problema', handler);
  },

  onMessage: (cb) => {
    const handler = (_e, message) => cb(message);
    ipcRenderer.on('wire:message', handler);
    return () => ipcRenderer.removeListener('wire:message', handler);
  },
});
