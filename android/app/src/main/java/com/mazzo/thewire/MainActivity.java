package com.mazzo.thewire;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * L'app sul telefono.
 *
 * Serve una sola cosa in piu' rispetto a quella che Capacitor genera da solo:
 * la fotocamera per inquadrare il QR che collega questo telefono all'account.
 *
 * La pagina la chiede con `getUserMedia`, ma dentro una WebView quella
 * richiesta non arriva da nessuna parte se nessuno la raccoglie: senza il
 * codice qui sotto il mirino resta nero e non compare nemmeno un errore. Sono
 * due permessi diversi e servono tutti e due — quello di Android, che lo chiede
 * all'utente, e quello della WebView, che lo gira alla pagina.
 */
public class MainActivity extends BridgeActivity {

    private static final int RICHIESTA_FOTOCAMERA = 4711;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Il permesso di Android. Si chiede all'avvio e non al momento del
        // bisogno: la finestra di sistema che compare mentre si sta inquadrando
        // fa perdere il codice, che vale cinque minuti.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this, new String[]{Manifest.permission.CAMERA}, RICHIESTA_FOTOCAMERA);
        }

        // Il permesso della WebView. Si concede solo la fotocamera, e solo se
        // Android ce l'ha gia' data: se questa app non ha la fotocamera, la
        // pagina non deve credere di averla.
        getBridge().getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest richiesta) {
                runOnUiThread(() -> {
                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA)
                            != PackageManager.PERMISSION_GRANTED) {
                        richiesta.deny();
                        return;
                    }
                    for (String risorsa : richiesta.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(risorsa)) {
                            richiesta.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                            return;
                        }
                    }
                    // Microfono, posizione, tutto il resto: no. Questa app non
                    // ne ha bisogno, e concederli "per sicurezza" sarebbe il
                    // contrario della sicurezza.
                    richiesta.deny();
                });
            }
        });
    }
}
