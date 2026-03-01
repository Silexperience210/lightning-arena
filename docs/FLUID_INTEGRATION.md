# 🎮 Intégration Fluide: Paiement → Gameplay

## Problème Actuel

```
┌─────────────────────────────────────────────────────────────┐
│                    EXPÉRIENCE ACTUELLE                       │
│                     (Cassée / Friction)                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Joueur lance STK         ┌─────────────────────────┐   │
│     ┌─────────────┐          │  2. Ouvre navigateur   │   │
│     │  SuperTux   │          │     pour connecter     │   │
│     │    Kart     │──────────▶│     wallet NWC       │   │
│     └─────────────┘          │                         │   │
│                              │  • Copier l'adresse LN │   │
│                              │  • Ouvrir Alby/Blue    │   │
│                              │  • Créer connexion     │   │
│                              │  • Copier l'URI NWC    │   │
│                              │  • Retourner sur web   │   │
│                              │  • Coller l'URI        │   │
│                              └─────────────────────────┘   │
│                                         │                  │
│                                         ▼                  │
│                              ┌─────────────────────────┐   │
│     ┌─────────────┐          │  3. ENFIN retourne     │   │
│     │   JOUE !    │◀─────────▶│     dans STK           │   │
│     └─────────────┘          └─────────────────────────┘   │
│                                                             │
│  ❌ 3 fenêtres différentes                                  │
│  ❌ Copier/coller x2                                        │
│  ❌ Temps: 2-3 minutes                                      │
│  ❌ Friction énorme                                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 🎯 Objectif: Expérience "Invisible"

```
┌─────────────────────────────────────────────────────────────┐
│                   EXPÉRIENCE FLUIDE                          │
│                    (One-Click Gaming)                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│     ┌─────────────────────────────────────────────────┐    │
│     │              SUPER TUX KART                      │    │
│     │                                                  │    │
│     │   ┌─────────────────────────────────────────┐   │    │
│     │   │  🔗 Connecter Wallet                    │   │    │
│     │   │                                          │   │    │
│     │   │  [Se connecter avec Alby]  ←───┐        │   │    │
│     │   │  [Se connecter avec BlueWallet]│        │   │    │
│     │   │  [Mode Escrow - Sans NWC]      │        │   │    │
│     │   └─────────────────────────────────────────┘   │    │
│     │                        │                        │    │
│     │                        ▼                        │    │
│     │   ┌─────────────────────────────────────────┐   │    │
│     │   │  ⚡ Partie en cours                    │   │    │
│     │   │                                          │   │    │
│     │   │  Solde: 950 sats    [🔊]               │   │    │
│     │   │  ┌──────┐                              │   │    │
│     │   │  │ BOOM │  -50 sats → adversaire       │   │    │
│     │   │  └──────┘                              │   │    │
│     │   │                                          │   │    │
│     │   └─────────────────────────────────────────┘   │    │
│     │                                                  │    │
│     └─────────────────────────────────────────────────┘    │
│                                                             │
│  ✅ 1 seule fenêtre (le jeu)                                │
│  ✅ 1 clic pour connecter                                   │
│  ✅ Paiements en arrière-plan                               │
│  ✅ Temps: 10 secondes                                      │
│  ✅ Zero friction                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Solution 1: Deep Linking Natif (Recommandée - Simple)

### Architecture: Liens directs entre applications

```
┌─────────────────────────────────────────────────────────────┐
│              DEEP LINK FLOW - Ultra Simple                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Joueur dans STK                                         │
│     ┌─────────────────────────┐                             │
│     │  "Connecter Wallet"     │                             │
│     └───────────┬─────────────┘                             │
│                 │                                           │
│                 ▼                                           │
│     ┌─────────────────────────┐                             │
│     │ Ouvre navigateur        │                             │
│     │ lightning-arena.com/    │                             │
│     │ connect?return=stk://   │                             │
│     └───────────┬─────────────┘                             │
│                 │                                           │
│                 ▼                                           │
│     ┌─────────────────────────┐                             │
│     │ Bouton "Ouvrir Alby"    │                             │
│     │ alby://nwc/new?...      │ ◀── Deep link vers wallet   │
│     └───────────┬─────────────┘                             │
│                 │                                           │
│                 ▼                                           │
│     ┌─────────────────────────┐                             │
│     │ Alby s'ouvre            │                             │
│     │ "Autoriser connexion?"  │                             │
│     │ [Oui]                   │                             │
│     └───────────┬─────────────┘                             │
│                 │                                           │
│                 ▼                                           │
│     ┌─────────────────────────┐                             │
│     │ Retour automatique      │                             │
│     │ stk://connected?token=..│ ◀── Deep link vers STK      │
│     └───────────┬─────────────┘                             │
│                 │                                           │
│                 ▼                                           │
│     ┌─────────────────────────┐                             │
│     │ STK reçoit le token     │                             │
│     │ Connexion établie !     │                             │
│     └─────────────────────────┘                             │
│                                                             │
│  ✅ Zero copier/coller                                      │
│  ✅ Flux natif mobile/desktop                               │
│  ✅ 10 secondes                                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Implémentation

**Fichier à modifier dans STK:**
```cpp
// src/states_screens/online/wallet_connect.cpp

class WalletConnectScreen : public GUIEngine::Screen
{
public:
    void onConnectButtonPressed()
    {
        // 1. Ouvrir le navigateur avec URL de connexion
        std::string connectUrl = 
            "https://lightning-arena.com/wallet/connect"
            "?return_uri=stk://auth"
            "&session_id=" + generateSessionId();
        
        openURL(connectUrl);  // Ouvre le navigateur système
    }
    
    // 2. Recevoir le retour deep link
    void onDeepLinkReceived(const std::string& url)
    {
        if (url.find("stk://connected") == 0) {
            std::string token = extractParam(url, "token");
            std::string walletType = extractParam(url, "type"); // nwc ou escrow
            
            // Sauvegarder
            UserConfigParams::m_nwc_token = token;
            UserConfigParams::m_wallet_type = walletType;
            
            // Transition vers le jeu
            StateManager::get()->replaceAndDelete(MainMenuScreen::getInstance());
        }
    }
};
```

**Page web simplifiée:**
```html
<!-- lightning-arena.com/wallet/connect -->
<!DOCTYPE html>
<html>
<head>
    <title>Connecter Wallet - Lightning Arena</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding: 50px; }
        .wallet-btn { 
            display: block; 
            margin: 20px auto; 
            padding: 15px 30px;
            font-size: 18px;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <h1>🔌 Connecter votre wallet</h1>
    
    <button class="wallet-btn" onclick="connectAlby()">
        ⚡ Connecter avec Alby
    </button>
    
    <button class="wallet-btn" onclick="connectBlueWallet()">
        🔵 Connecter avec BlueWallet
    </button>
    
    <button class="wallet-btn" onclick="connectEscrow()">
        🔒 Mode Escrow (sans NWC)
    </button>
    
    <script>
        const returnUri = new URLSearchParams(location.search).get('return_uri');
        
        function connectAlby() {
            // Deep link vers Alby
            const albyUrl = `alby://nwc/new?` +
                `name=LightningArena&` +
                `return_to=${encodeURIComponent(returnUri)}&` +
                `max_amount=100000&` +
                `budget_renewal=daily`;
            
            window.location.href = albyUrl;
            
            // Fallback: si deep link ne marche pas, ouvrir web
            setTimeout(() => {
                window.location.href = 'https://nwc.getalby.com/apps/new?name=LightningArena';
            }, 500);
        }
        
        function connectBlueWallet() {
            window.location.href = 'bluewallet://nwc/new?name=LightningArena';
        }
        
        function connectEscrow() {
            // Rediriger directement vers le jeu avec mode escrow
            window.location.href = `${returnUri}?type=escrow&session=xxx`;
        }
    </script>
</body>
</html>
```

---

## 🚀 Solution 2: QR Code In-Game (Pour mobile)

### Affichage dans STK

```cpp
// HUD: Afficher QR code pour connexion rapide

void HUD::showWalletConnectQR()
{
    // Générer session unique
    std::string sessionId = generateUUID();
    
    // URL de connexion
    std::string connectUrl = "https://lightning-arena.com/connect?session=" + sessionId;
    
    // Générer QR (libqrencode ou similaire)
    Texture* qrTexture = generateQRCodeTexture(connectUrl, 256);
    
    // Afficher au centre de l'écran
    draw2DImage(qrTexture, 
                screen_width/2 - 128, 
                screen_height/2 - 128,
                256, 256);
    
    // Texte explicatif
    renderText("Scannez avec votre wallet Lightning", 
               screen_width/2, 
               screen_height/2 + 150,
               TextAlign::CENTER);
    
    // Polling: vérifier si connexion établie
    startPolling(sessionId);
}

void HUD::startPolling(const std::string& sessionId)
{
    // Vérifier toutes les 2 secondes
    m_pollTimer = setInterval([sessionId]() {
        auto response = httpGet("/api/wallet/session/" + sessionId);
        if (response.status == "connected") {
            // Connexion réussie!
            hideQRCode();
            showBalance(response.balance);
        }
    }, 2000);
}
```

---

## 🚀 Solution 3: Application Desktop Unifiée (Electron)

### Pour une vraie expérience native

```javascript
// Electron: Une seule application avec jeu intégré

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

// Fenêtre principale
let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    
    // Charger l'interface unifiée
    mainWindow.loadFile('index.html');
}

// Lancer STK en embedded mode
let stkProcess;
function launchSTK() {
    stkProcess = spawn('./supertuxkart', [
        '--windowed',
        '--connect=localhost:3001',
        '--embedded'  // Mode sans bordure
    ]);
    
    // Capturer les events du jeu
    stkProcess.stdout.on('data', (data) => {
        const event = JSON.parse(data);
        
        if (event.type === 'HIT') {
            // Déclencher paiement automatique
            mainWindow.webContents.send('game-hit', event);
        }
    });
}

// Gérer les paiements NWC
ipcMain.handle('nwc-pay', async (event, { to, amount }) => {
    const { nwc } = require('@getalby/sdk');
    const client = new nwc.NWCClient({ 
        nostrWalletConnectUrl: userSettings.nwcUri 
    });
    
    // Créer invoice pour l'adversaire
    const invoice = await client.makeInvoice({
        amount: amount * 1000,
        description: `Lightning Arena - Hit from player`
    });
    
    // Le serveur fait le reste (P2P)
    return { success: true };
});

// Register custom protocol
app.whenReady().then(() => {
    protocol.registerFileProtocol('stk', (request, callback) => {
        // Handler pour stk:// deep links
        const url = request.url.substr(7); // enlever 'stk://'
        handleDeepLink(url);
    });
    
    createWindow();
    launchSTK();
});
```

**Interface (index.html):**
```html
<!DOCTYPE html>
<html>
<head>
    <style>
        body { margin: 0; overflow: hidden; background: #000; }
        #stk-container { width: 100%; height: 100vh; position: relative; }
        #wallet-overlay { 
            position: absolute; 
            top: 20px; 
            right: 20px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 15px;
            border-radius: 10px;
            font-family: sans-serif;
        }
        .balance { font-size: 24px; color: #f7931a; }
        .hit-notification {
            position: absolute;
            bottom: 100px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(255,0,0,0.8);
            color: white;
            padding: 10px 20px;
            border-radius: 20px;
            display: none;
        }
    </style>
</head>
<body>
    <div id="stk-container">
        <!-- STK s'affiche ici -->
    </div>
    
    <div id="wallet-overlay">
        <div>⚡ Solde</div>
        <div class="balance" id="balance">1000 sats</div>
        <button onclick="connectWallet()">Connecter Wallet</button>
    </div>
    
    <div id="hit-notif" class="hit-notification">
        💸 -50 sats
    </div>
    
    <script>
        const { ipcRenderer } = require('electron');
        
        // Recevoir les hits du jeu
        ipcRenderer.on('game-hit', (event, data) => {
            showHitNotification(data.amount);
            updateBalance(data.newBalance);
        });
        
        function connectWallet() {
            // Ouvrir modal intégré
            document.getElementById('wallet-modal').style.display = 'block';
        }
        
        function showHitNotification(amount) {
            const notif = document.getElementById('hit-notif');
            notif.textContent = `💸 -${amount} sats`;
            notif.style.display = 'block';
            setTimeout(() => notif.style.display = 'none', 2000);
        }
    </script>
</body>
</html>
```

---

## 🚀 Solution 4: WebView Intégré dans STK (Le plus propre)

### Utiliser CEF (Chromium Embedded Framework) ou Awesomium

```cpp
// Dans STK: Intégrer une vue web directement dans le moteur

class WalletWebView : public GUIEngine::Widget
{
private:
    CefRefPtr<CefBrowser> m_browser;
    
public:
    void init()
    {
        // Créer une fenêtre web
        CefWindowInfo window_info;
        window_info.SetAsWindowless(0);
        
        CefBrowserSettings browser_settings;
        
        m_browser = CefBrowserHost::CreateBrowserSync(
            window_info,
            new WalletHandler(this),  // Handler personnalisé
            "https://lightning-arena.com/wallet/embed",
            browser_settings,
            nullptr
        );
    }
    
    void onWalletConnected(const std::string& token)
    {
        // Masquer le webview
        setVisible(false);
        
        // Afficher le HUD de jeu
        HUD::get()->showWalletBalance(1000);
        
        // Sauvegarder le token
        UserConfigParams::m_nwc_token = token;
    }
    
    void draw() override
    {
        // Rendre la texture web sur l'écran
        if (m_texture)
        {
            draw2DImage(m_texture, m_x, m_y, m_w, m_h);
        }
    }
};

// Handler pour communication JS ↔ C++
class WalletHandler : public CefClient
{
public:
    bool OnProcessMessageReceived(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        CefProcessId source_process,
        CefRefPtr<CefProcessMessage> message) override
    {
        if (message->GetName() == "walletConnected")
        {
            std::string token = message->GetArgumentList()->GetString(0);
            m_parent->onWalletConnected(token);
            return true;
        }
        return false;
    }
};
```

**Page web embeddée:**
```html
<!-- lightning-arena.com/wallet/embed -->
<!DOCTYPE html>
<html style="margin:0; background:transparent;">
<head>
    <style>
        body { 
            margin: 0; 
            background: rgba(20,20,40,0.95);
            color: white;
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
        }
        .glass-panel {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            padding: 30px;
            border-radius: 20px;
            border: 1px solid rgba(255,255,255,0.2);
        }
        button {
            background: linear-gradient(135deg, #f7931a, #ff6b35);
            border: none;
            color: white;
            padding: 15px 30px;
            border-radius: 10px;
            font-size: 16px;
            cursor: pointer;
            margin: 10px;
        }
    </style>
</head>
<body>
    <div class="glass-panel">
        <h2>⚡ Connecter Wallet</h2>
        <button onclick="connectAlby()">Alby</button>
        <button onclick="connectBlue()">BlueWallet</button>
    </div>
    
    <script>
        // Communiquer avec le jeu via CefSharp/CEF
        function connectAlby() {
            // Deep link puis retour
            const token = 'nwc://...';
            
            // Envoyer au jeu natif
            if (window.cefQuery) {
                window.cefQuery({
                    request: JSON.stringify({
                        type: 'walletConnected',
                        token: token
                    })
                });
            }
        }
    </script>
</body>
</html>
```

---

## 🏆 Comparaison des Solutions

| Solution | Complexité | Expérience | Temps dev | Meilleur pour |
|----------|------------|------------|-----------|---------------|
| **Deep Linking** | ⭐ Facile | ⭐⭐⭐ Bon | 2 jours | MVP, test rapide |
| **QR Code** | ⭐ Facile | ⭐⭐⭐ Bon | 1 jour | Mobile, scan rapide |
| **Electron App** | ⭐⭐⭐ Dur | ⭐⭐⭐⭐⭐ Excellent | 1 semaine | Production, desktop |
| **CEF WebView** | ⭐⭐⭐ Dur | ⭐⭐⭐⭐⭐ Excellent | 1 semaine | Intégration native |

---

## 🎯 Recommandation: Phased Approach

### Phase 1 (Cette semaine): Deep Linking
```cpp
// Ajouter dans STK:
// 1. Bouton "Connecter Wallet" qui ouvre navigateur
// 2. Handler stk:// pour recevoir le retour
// 3. Sauvegarde du token
```
**Résultat**: 10 secondes pour connecter (vs 3 minutes)

### Phase 2 (Semaine prochaine): QR Code
```cpp
// Ajouter dans STK:
// 1. Génération QR code
// 2. Affichage dans menu
// 3. Polling session
```
**Résultat**: Connexion mobile super rapide

### Phase 3 (Plus tard): WebView Intégré
```cpp
// Intégrer CEF/Awesomium dans STK
// Wallet UI rendu directement dans le jeu
```
**Résultat**: Expérience 100% native

---

## 💡 Bonus: Headless Mode (Expérience Invisible)

Pour les joueurs réguliers, le serveur peut garder une session active:

```javascript
// Sur le serveur: Session persistante
const userSession = {
    userId: 'xxx',
    nwcUri: 'encrypted...',  // Stocké sécurisé
    autoPay: true,           // Paiement automatique
    maxAutoAmount: 1000      // Limite par transaction
};

// Quand un hit arrive:
// 1. Serveur déclenche le paiement P2P
// 2. Joueur reçoit juste notification "-50 sats"
// 3. Zero interaction requise!
```

Le joueur configure UNE FOIS, puis joue sans penser aux paiements.

---

**Quelle solution veux-tu implémenter ?** Je peux te donner le code complet pour n'importe laquelle ! 🚀
