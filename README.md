<div align="center">
  <h1>🔮 OpenClaudeUsage</h1>
  <p><b>An unofficial Windows system tray application to seamlessly monitor your Claude.ai usage.</b></p>
  <p><i>Une application non-officielle pour la barre d'état Windows permettant de surveiller votre consommation Claude.ai.</i></p>
</div>

---

## English Documentation

OpenClaudeUsage is a lightweight Electron app that lives in your Windows system tray. It securely scrapes `claude.ai/settings/usage` using your local session cookie, avoiding the need for expensive API keys.

### ✨ Features
- **Live Token Tracking**: View current session and weekly token limits via progress bars.
- **Extra Usage Costs**: Keep track of out-of-plan spendings (€ / $).
- **API-Key Free**: Uses your own `sessionKey` cookie to authenticate locally.
- **Privacy First**: Your cookie is stored locally in `%AppData%\OpenClaudeUsage` and never leaves your machine.
- **Custom Refresh Rate**: Configure auto-refresh intervals from 1 minute to 1 hour.

### 🚀 Quick Start

Make sure you have Node.js installed.

```bash
# 1. Install dependencies
npm install

# 2. Start the app in development mode
npm start

# 3. Build a portable .exe for Windows
npm run build
```
The executable will be generated in the `dist/` folder.

### ⚙️ Setup Instructions
1. Launch the app and right-click the **Purple Icon** in your system tray, then select **Paramètres** (Settings).
2. Open `claude.ai` in Chrome or Firefox.
3. Press `F12` to open Developer Tools → **Application** (Chrome) or **Storage** (Firefox) tab.
4. Navigate to **Cookies** → `https://claude.ai` and copy the value of `sessionKey` (it usually starts with `sk-ant-sid...`).
5. Paste it into the app's settings window and click **Enregistrer** (Save).

*(Note: If your Claude session expires on your browser, you will need to grab the new `sessionKey` and update it in the app).*

---

## Documentation en Français

Cette application Electron se place dans votre barre d'état système Windows et scrape la page **claude.ai/settings/usage** en utilisant votre cookie de session, sans nécessiter de clé d'API.

### 🚀 Démarrage rapide
```bash
npm install     # Installe les dépendances (~100 MB)
npm start       # Lance l'application
npm run build   # Génère un exécutable portable dans dist/
```

### ⚙️ Configuration (au premier lancement)
1. Faites un clic droit sur l'icône violette dans le tray → **Paramètres**.
2. Ouvrez `claude.ai` dans votre navigateur (Chrome / Firefox).
3. Appuyez sur `F12` → Onglet **Application** → **Cookies** → `https://claude.ai`.
4. Copiez la valeur de `sessionKey` (commence par `sk-ant-sid...`).
5. Collez-la dans le champ de l'application et cliquez sur **Enregistrer**.

### 💡 Fonctionnement et Vues
- L'application ouvre une fenêtre Electron **invisible** qui charge la page d'utilisation de Claude.
- Le DOM est parsé de manière sécurisée pour extraire : **Session actuelle** (tokens), **Limites hebdomadaires** et **Usage supplémentaire** (dépenses).
- **Vie privée :** Le cookie est stocké dans `%AppData%\OpenClaudeUsage\config.json` et ne quitte jamais votre machine. Il expire en même temps que votre session web.

---

### 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the issues page.

### 📝 License
This project is open-source and available under the MIT License.
