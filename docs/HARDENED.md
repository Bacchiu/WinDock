# Branch `hardened`

Questa branch rende WinDock più sicuro in due modi.

## 1. Solo connessioni sicure (HTTPS)

- I telefoni possono collegarsi **solo con l'abbinamento sicuro** (codice QR → HTTPS con certificato verificato).
- La vecchia modalità "indirizzo + PIN" su HTTP in chiaro è **bloccata per tutti i dispositivi in rete**: niente PIN, niente interfaccia, niente WebSocket. Risponde solo `/health`, che serve al telefono per trovare il PC.
- Sul PC stesso (localhost) tutto funziona come prima: icona nel tray, pagina "Pair a phone securely", browser locale.
- Per tornare al comportamento originale (sconsigliato) avvia l'host con `WINDOCK_ALLOW_INSECURE=1`.
- Test: `scripts/verify-secure-only.mjs` (incluso in `npm test`).

Nota: il tray mostra ancora indirizzo e PIN della vecchia modalità. Su questa build non funzionano dal telefono: usa **Pair a phone securely**.

## 2. Niente aggiornamenti dal progetto originale

- Il PC non contatta mai il sito dell'autore originale: niente controllo aggiornamenti all'avvio, voce "Check for updates" nascosta nel tray.
- Il dock e l'app Android non propongono più di scaricare l'APK o l'installer originali, che toglierebbero queste protezioni o non si installerebbero (firma diversa).
- Per aggiornare: su GitHub premi **Sync fork**, unisci le novità nella branch `hardened`, lascia ricompilare il workflow e installa i nuovi file sopra quelli attuali.

## 3. Programmi compilati in modo verificabile

Il workflow `.github/workflows/build-hardened.yml` compila **dal codice di questa branch**:

- **l'installer Windows** (dopo aver eseguito tutti i test);
- **un APK Android "release"**, che quindi non è debuggabile, non ha il debug WebView, non permette HTTP in chiaro e si collega solo a PC abbinati in modo sicuro. È firmato con **la tua chiave**.

Per ogni file vengono pubblicati lo SHA-256 e un'**attestazione di provenienza** GitHub, che prova che quel file è stato compilato da quel commit. Puoi verificarla così:

```
gh attestation verify WinDock-hardened.apk --repo TUONOME/WinDock
gh attestation verify WinDockSetup.exe     --repo TUONOME/WinDock
```

### Configurazione una tantum

1. **Abilita le Actions** nel fork: scheda *Actions* → "I understand my workflows, go ahead and enable them".
2. **Crea la chiave di firma** sul tuo PC. Serve `keytool`, incluso in qualsiasi JDK o in Android Studio.
   ```
   keytool -genkeypair -v -keystore windock.jks -alias windock -keyalg RSA -keysize 4096 -validity 10000
   keytool -list -v -keystore windock.jks -alias windock
   ```
   Copia la riga **SHA256** del certificato. Conserva `windock.jks` e le password in un posto sicuro: se li perdi, non potrai aggiornare l'app senza disinstallarla.
3. **Converti la chiave in base64** (PowerShell):
   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("windock.jks")) | Set-Clipboard
   ```
4. Nel fork vai su *Settings → Secrets and variables → Actions*.
   - Nella scheda **Secrets** aggiungi:
     - `WINDOCK_KEYSTORE_B64`: il testo base64 copiato al punto 3
     - `WINDOCK_KEYSTORE_PASSWORD`
     - `WINDOCK_KEY_ALIAS`: `windock`
     - `WINDOCK_KEY_PASSWORD`
   - Nella scheda **Variables** aggiungi `WINDOCK_UPLOAD_CERT_SHA256`: l'impronta SHA256 del punto 2 (non è segreta).
5. *Actions* → **Build hardened WinDock** → *Run workflow*. Al termine scarica i due file dalla sezione *Artifacts*.

### Installazione

- **PC**: installa `WinDockSetup.exe`. Non è firmato con un certificato di Windows, quindi SmartScreen mostrerà un avviso: l'attestazione serve proprio a verificarne l'origine.
- **Telefono**: se hai installato l'APK originale, disinstallalo prima, perché la firma è diversa. Poi installa `WinDock-hardened.apk`. Sul PC scegli **Pair a phone securely** e sul telefono **Scan computer code**.
