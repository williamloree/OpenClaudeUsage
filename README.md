# Claude Usage Tray 🔮

App Electron — system tray Windows — qui scrape **claude.ai/settings/usage**  
avec ton cookie de session, sans API key.

## Démarrage rapide

```bash
npm install     # installe Electron (~100 MB, une seule fois)
npm start       # lance l'app
```

Pour builder un `.exe` portable :
```bash
npm run build   # → dist/Claude Usage.exe
```

## Configuration (au premier lancement)

1. Icône violette dans le tray → clic droit → **Paramètres**
2. Ouvre `claude.ai` dans Chrome / Firefox
3. `F12` → Application → Cookies → `https://claude.ai` → copie la valeur de `sessionKey`
4. Colle dans le champ et **Enregistrer**

## Fonctionnement

- L'app ouvre une fenêtre Electron **invisible** qui charge `claude.ai/settings/usage`
- Le cookie sessionKey est injecté avant le chargement → la page s'authentifie
- Le DOM est parsé pour extraire : session actuelle, limites hebdo, dépenses
- Rafraîchissement automatique configurable (1 min → 1h)

## Vues

| Section | Ce qui est affiché |
|---|---|
| **Session actuelle** | tokens utilisés / max, barre de progression |
| **Limites hebdomadaires** | tokens utilisés / max, barre de progression |
| **Usage supplémentaire** | montant dépensé hors forfait (€) |

## Notes

- Le cookie expire avec ta session Claude → si l'app affiche "Session expirée",  
  retourne sur `claude.ai`, reconnecte-toi, et recupère un nouveau `sessionKey`.
- Le cookie est stocké dans `%AppData%\claude-usage-tray\config.json`  
  et ne quitte jamais ta machine.
