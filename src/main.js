const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");

// Guard : ce fichier doit être lancé via Electron, pas via Node.js pur
// (ELECTRON_RUN_AS_NODE=1 rend app=undefined)
if (!app || typeof app.whenReady !== "function") {
  console.error("Lancer avec : npx electron . (pas node .)");
  process.exit(0);
}

/* ─────────────────────────────────────────────
   Config persistence  (~AppData/OpenClaudeUsage/config.json)
───────────────────────────────────────────── */

// Résolu en lazy à l'intérieur de whenReady (app.getPath n'est pas
// disponible au chargement du module quand ELECTRON_RUN_AS_NODE=1)
let CONFIG_PATH = null;
function getConfigPath() {
  if (!CONFIG_PATH) CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
  return CONFIG_PATH;
}

function loadConfig() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {}
  return { sessionKey: "", refreshInterval: 5 };
}

function saveConfig(cfg) {
  try {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  } catch (_) {}
}

/* ─────────────────────────────────────────────
   State
───────────────────────────────────────────── */
let tray = null;
let popupWin = null;
let settingsWin = null;
let scraperWin = null; // hidden BrowserWindow that loads claude.ai

let usageData = null;
let lastFetch = null;
let fetchError = null;
let refreshTimer = null;
let config = { sessionKey: "", refreshInterval: 5 }; // chargé dans whenReady
let isScraping = false;
let lastPopupPos = null; // chargé dans whenReady
let lastSessionPct = null; // pourcentage session actuelle (pour la couleur du point)

/* ─────────────────────────────────────────────
   Tray icon — logo.png + point coloré
   Approche 100% sans fenêtre cachée :
   manipulation directe du bitmap BGRA via
   nativeImage.toBitmap() / createFromBitmap()
───────────────────────────────────────────── */

let _logoBase32 = null; // NativeImage 32×32 chargé une fois

function getLogoBase() {
  if (_logoBase32) return _logoBase32;
  try {
    const img = nativeImage.createFromPath(
      path.join(__dirname, "assets/logo.png"),
    );
    if (!img.isEmpty()) {
      _logoBase32 = img.resize({ width: 32, height: 32 });
    }
  } catch (_) {}
  return _logoBase32;
}

// Compose le logo 32×32 avec un point coloré en bas à droite
// dotRgb = [R, G, B] ou null. Format bitmap Windows : BGRA.
function makeLogoWithDot(dotRgb) {
  const logo = getLogoBase();
  if (!logo) return null;

  const size = 32;
  const buf = Buffer.from(logo.toBitmap()); // copie indépendante
  const cx = 24, cy = 24, r = 5.5;

  if (dotRgb) {
    const [dr, dg, db] = dotRgb;
    const span = Math.ceil(r + 2);
    for (let py = cy - span; py <= cy + span; py++) {
      for (let px = cx - span; px <= cx + span; px++) {
        if (px < 0 || px >= size || py < 0 || py >= size) continue;
        const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
        const i = (py * size + px) * 4;
        if (dist <= r) {
          buf[i] = db; buf[i + 1] = dg; buf[i + 2] = dr; buf[i + 3] = 255;
        } else if (dist <= r + 1.5) {
          buf[i] = 10; buf[i + 1] = 10; buf[i + 2] = 10; buf[i + 3] = 255;
        }
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function makeTrayIcon(state) {
  const pct = lastSessionPct;

  // Couleur du point selon l'état et le % de session
  const dot =
    state === "error" ? [232, 72,  64]  :  // rouge
    state === "spin"  ? [240, 192, 80]  :  // jaune
    state === "idle"  ? [85,  85,  85]  :  // gris
    pct === null      ? [85,  85,  85]  :  // gris (pas encore de données)
    pct > 80          ? [232, 72,  64]  :  // rouge  (>80 %)
    pct > 50          ? [240, 160, 32]  :  // orange (50–80 %)
                        [76,  175, 80];    // vert   (≤50 %)

  const img = makeLogoWithDot(dot);
  if (img) return img;

  // Fallback jauge SVG si logo.png absent
  const color =
    state === "error" ? "#e84840" :
    state === "ok"    ? "#e8a838" :
    state === "spin"  ? "#f0c050" : "#555";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <rect width="16" height="16" rx="3.5" fill="#090b0a"/>
    <path d="M2.5 11 a5.5 5.5 0 0 1 11 0" stroke="rgba(255,255,255,0.1)" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M2.5 11 a5.5 5.5 0 0 1 11 0" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="17.28" stroke-dashoffset="6.05"/>
    <line x1="8" y1="11" x2="5.2" y2="6.8" stroke="${color}" stroke-width="1.3" stroke-linecap="round"/>
    <circle cx="8" cy="11" r="1.3" fill="${color}"/>
  </svg>`;
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
  );
}

/* ─────────────────────────────────────────────
   Inject sessionKey cookie into Electron's session
───────────────────────────────────────────── */
async function injectCookie(sessionKey) {
  const ses = session.defaultSession;
  // Remove old one first
  await ses.cookies.remove("https://claude.ai", "sessionKey").catch(() => {});
  if (!sessionKey) return;
  await ses.cookies.set({
    url: "https://claude.ai",
    name: "sessionKey",
    value: sessionKey,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
  });
}

/* ─────────────────────────────────────────────
   Scraper — loads /settings/usage in a hidden window, reads the DOM
───────────────────────────────────────────── */
function scrapeUsage() {
  return new Promise((resolve, reject) => {
    if (scraperWin && !scraperWin.isDestroyed()) scraperWin.destroy();

    scraperWin = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        javascript: true,
      },
    });

    // Timeout — if the page never loads / never resolves
    const timeout = setTimeout(() => {
      if (!scraperWin.isDestroyed()) scraperWin.destroy();
      reject(new Error("Timeout — la page a mis trop longtemps à charger."));
    }, 30_000);

    scraperWin.webContents.on("did-finish-load", async () => {
      // Small pause so React can render
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const result = await scraperWin.webContents.executeJavaScript(`
          (function () {
            // ── 1. Check if we are on the right page / logged in ──────────
            const url = location.href;
            if (url.includes('/login') || url.includes('/sign')) {
              return { error: 'SESSION_EXPIRED', url };
            }

            // ── 2. Try to find React fiber data (most robust) ─────────────
            function findReactRoot (el) {
              for (const key of Object.keys(el)) {
                if (key.startsWith('__reactFiber') || key.startsWith('__reactInternals')) {
                  return el[key];
                }
              }
              return null;
            }

            function walkFiber (fiber, depth = 0) {
              if (!fiber || depth > 80) return null;
              const props = fiber.memoizedProps || fiber.pendingProps;
              // Look for usage-related data structures
              if (props && typeof props === 'object') {
                // Check for usage data shapes
                if (props.usageData || props.usage_data) return props.usageData || props.usage_data;
                if (Array.isArray(props.periods)) return { periods: props.periods };
              }
              const state = fiber.memoizedState;
              if (state && state.memoizedState && typeof state.memoizedState === 'object') {
                const s = state.memoizedState;
                if (s.currentSession || s.weeklyLimit || s.spendAmount) return s;
              }
              return walkFiber(fiber.child, depth + 1)
                  || walkFiber(fiber.sibling, depth + 1);
            }

            // ── 3. DOM scraping (fallback & main) ─────────────────────────
            const text = document.body.innerText;

            // Detect session block (after heading)
            function extractBlock (heading) {
              const idx = text.indexOf(heading);
              if (idx === -1) return null;
              return text.slice(idx, idx + 600);
            }
            // Capture context around heading (includes text before it — e.g. value displayed above label)
            function extractAround (heading, before = 200, after = 400) {
              const idx = text.indexOf(heading);
              if (idx === -1) return null;
              return text.slice(Math.max(0, idx - before), idx + after);
            }

            // Grab numbers from a text block
            function nums (t) {
              if (!t) return [];
              return (t.match(/[\d,. ]+(?:k|M)?(?:\s*tokens?|\s*messages?|\s*€|\s*\$)?/gi) || [])
                .map(s => s.trim()).filter(Boolean);
            }

            const sessionBlock  = extractBlock('Session actuelle')
                                || extractBlock('Current session')
                                || extractBlock('Usage this session');
            const weeklyBlock   = extractBlock('Limites hebdomadaires')
                                || extractBlock('Weekly limits')
                                || extractBlock('Weekly usage');
            const extraBlock    = extractAround('Usage supplémentaire')
                                || extractAround('Additional usage')
                                || extractAround('Extra usage');
            const balanceBlock  = extractAround('Solde actuel')
                                || extractAround('Current balance')
                                || extractAround('Balance');

            // Generic: grab all <section> or card-like divs and their headings + numbers
            const cards = [];
            document.querySelectorAll('[class*="card"], [class*="usage"], [class*="limit"], section, [class*="panel"]').forEach(el => {
              const h = (el.querySelector('h1,h2,h3,h4,h5,h6,strong') || {}).innerText || '';
              const body = el.innerText || '';
              if (body.length > 10 && body.length < 2000) {
                cards.push({ heading: h.trim(), body: body.trim() });
              }
            });

            // Token bars: look for progress-bar-like elements with aria-valuenow
            const bars = [];
            document.querySelectorAll('[role="progressbar"], [aria-valuenow]').forEach(el => {
              bars.push({
                label: (el.getAttribute('aria-label') || el.closest('*[class]')?.innerText || '').slice(0,100),
                value: el.getAttribute('aria-valuenow'),
                max  : el.getAttribute('aria-valuemax')
              });
            });

            // Spend amount — prefer from extra block to avoid capturing balance amount
            const spendMatch = (extraBlock && (extraBlock.match(/([\d,. ]+)\s*€/) || extraBlock.match(/\$([\d,.]+)/)))
                            || text.match(/([\d,. ]+)\s*€/)
                            || text.match(/\$([\d,.]+)/);
            const spend = spendMatch ? spendMatch[0] : null;

            return {
              url,
              sessionBlock,
              weeklyBlock,
              extraBlock,
              balanceBlock,
              cards    : cards.slice(0, 30),
              bars,
              spend,
              rawText  : text.slice(0, 6000)   // send first 6k chars for parsing
            };
          })()
        `);

        clearTimeout(timeout);
        if (!scraperWin.isDestroyed()) scraperWin.destroy();
        resolve(result);
      } catch (err) {
        clearTimeout(timeout);
        if (!scraperWin.isDestroyed()) scraperWin.destroy();
        reject(err);
      }
    });

    scraperWin.webContents.on("did-fail-load", (e, code, desc) => {
      clearTimeout(timeout);
      if (!scraperWin.isDestroyed()) scraperWin.destroy();
      reject(new Error(`Erreur de chargement : ${desc} (${code})`));
    });

    scraperWin.loadURL("https://claude.ai/settings/usage", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
  });
}

/* ─────────────────────────────────────────────
   Parse raw scraped data into clean usageData object
───────────────────────────────────────────── */
function parseScrapedData(raw) {
  if (!raw || raw.error === "SESSION_EXPIRED") {
    throw new Error("SESSION_EXPIRED");
  }

  console.log("[debug] extraBlock:", raw.extraBlock?.slice(0, 200));
  console.log("[debug] balanceBlock:", raw.balanceBlock?.slice(0, 200));

  const text = raw.rawText || "";

  // Helper: extract number (handles "1,234", "1.2k", "1.5M")
  function parseNum(s) {
    if (!s) return 0;
    s = s.toString().replace(/\s/g, "").replace(",", ".");
    if (/M$/i.test(s)) return parseFloat(s) * 1_000_000;
    if (/k$/i.test(s)) return parseFloat(s) * 1_000;
    return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
  }

  // Parse progress bars first (most reliable)
  const result = {
    session: {
      label: "Session actuelle",
      used: null,
      max: null,
      pct: null,
      reset: null,
    },
    weekly: {
      label: "Limites hebdomadaires",
      used: null,
      max: null,
      pct: null,
      reset: null,
    },
    extra: { label: "Usage supplémentaire", spend: null, budget: null, renewal: null, balance: null, autoReload: false, extraEnabled: false },
  };

  // From aria bars
  if (raw.bars && raw.bars.length > 0) {
    raw.bars.forEach((b, i) => {
      const val = parseNum(b.value);
      const max = parseNum(b.max);
      const pct = max > 0 ? Math.round((val / max) * 100) : null;
      if (i === 0) {
        result.session.used = val;
        result.session.max = max;
        result.session.pct = pct;
      }
      if (i === 1) {
        result.weekly.used = val;
        result.weekly.max = max;
        result.weekly.pct = pct;
      }
    });
  }

  // Spend
  if (raw.spend) result.extra.spend = raw.spend;

  // Extra block: budget, renewal
  if (raw.extraBlock) {
    const budgetM = raw.extraBlock.match(/\/\s*([\d,. ]+\s*[€$])/);
    if (budgetM) result.extra.budget = budgetM[1].trim();
    const renewalM = raw.extraBlock.match(/[Rr]enouvellement\s+(.+?)(?:\n|$)/);
    if (renewalM) result.extra.renewal = renewalM[1].trim();
  }

  // Balance block: solde, autoReload, extraEnabled
  if (raw.balanceBlock) {
    const balM = raw.balanceBlock.match(/([\d,. ]+\s*[€$])/);
    if (balM) result.extra.balance = balM[1].trim();
    if (/recharge[^:\n]*:\s*on|auto.reload.*on/i.test(raw.balanceBlock)) result.extra.autoReload = true;
    if (/usage\s+supp[^:\n]*:\s*on|additional.*on/i.test(raw.balanceBlock)) result.extra.extraEnabled = true;
  }

  // From cards
  if (raw.cards) {
    raw.cards.forEach((card) => {
      const h = card.heading.toLowerCase();
      const b = card.body;
      if (h.includes("session") || h.includes("actuelle")) {
        const m = b.match(/([\d,. ]+)\s*\/\s*([\d,. ]+)/);
        if (m) {
          result.session.used = parseNum(m[1]);
          result.session.max = parseNum(m[2]);
          result.session.pct = Math.round(
            (result.session.used / result.session.max) * 100,
          );
        }
      }
      if (
        h.includes("hebdo") ||
        h.includes("weekly") ||
        h.includes("semaine")
      ) {
        const m = b.match(/([\d,. ]+)\s*\/\s*([\d,. ]+)/);
        if (m) {
          result.weekly.used = parseNum(m[1]);
          result.weekly.max = parseNum(m[2]);
          result.weekly.pct = Math.round(
            (result.weekly.used / result.weekly.max) * 100,
          );
        }
      }
      if (!result.extra.spend) {
        const spend = b.match(/([\d,. ]+)\s*€/) || b.match(/\$([\d,.]+)/);
        if (spend) result.extra.spend = spend[0];
      }
    });
  }

  // Last resort — raw text regex
  if (result.session.used === null) {
    const sessionM = text.match(/Session[^0-9]*([\d,. ]+)\s*\/\s*([\d,. ]+)/i);
    if (sessionM) {
      result.session.used = parseNum(sessionM[1]);
      result.session.max = parseNum(sessionM[2]);
      result.session.pct = Math.round(
        (result.session.used / result.session.max) * 100,
      );
    }
  }
  if (result.weekly.used === null) {
    const weekM = text.match(
      /(?:hebdo|weekly|semaine)[^0-9]*([\d,. ]+)\s*\/\s*([\d,. ]+)/i,
    );
    if (weekM) {
      result.weekly.used = parseNum(weekM[1]);
      result.weekly.max = parseNum(weekM[2]);
      result.weekly.pct = Math.round(
        (result.weekly.used / result.weekly.max) * 100,
      );
    }
  }
  if (!result.extra.spend) {
    const spendM = text.match(/([\d,. ]+)\s*€/) || text.match(/\$([\d,.]+)/);
    if (spendM) result.extra.spend = spendM[0];
  }

  // ── Reset times ────────────────────────────────────────────────────────
  // Search session block first, then full text as fallback
  const sessSource = (raw.sessionBlock || "") + "\n" + text;
  const weekSource = (raw.weeklyBlock || "") + "\n" + text;

  // Session: "Réinitialisation dans 1 h 39 min"  /  "Resets in 1h 39m"
  const sessReset =
    sessSource.match(
      /[Rr]é?initialisation\s+dans\s+([\d]+\s*h\s*[\d]+\s*min|[\d]+\s*min|[\d]+\s*h)/i,
    ) ||
    sessSource.match(
      /[Rr]esets?\s+in\s+([\w\s]+(?:hour|min|h|m)[^\n,]{0,20})/i,
    );
  if (sessReset) result.session.reset = sessReset[1].trim();

  // Weekly: "Réinitialisation dim. 03:59"  /  "Resets Sun 03:59"
  const weekReset =
    weekSource.match(
      /[Rr]é?initialisation\s+((?:lun|mar|mer|jeu|ven|sam|dim)[a-zé.]*\s*[\d:]*)/i,
    ) ||
    weekSource.match(
      /[Rr]esets?\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z.]*\s*[\d:]*)/i,
    );
  if (weekReset) result.weekly.reset = weekReset[1].trim();

  // Store raw blocks for display
  result._raw = {
    sessionBlock: raw.sessionBlock,
    weeklyBlock: raw.weeklyBlock,
    extraBlock: raw.extraBlock,
    rawText: text,
  };

  return result;
}

/* ─────────────────────────────────────────────
   Main fetch orchestrator
───────────────────────────────────────────── */
async function fetchUsage() {
  if (!config.sessionKey) {
    fetchError = "NO_SESSION_KEY";
    usageData = null;
    broadcastUpdate();
    return;
  }

  if (isScraping) return;
  isScraping = true;

  tray && tray.setImage(makeTrayIcon("spin"));
  fetchError = null;

  try {
    await injectCookie(config.sessionKey);
    const raw = await scrapeUsage();
    usageData = parseScrapedData(raw);
    lastFetch = new Date();
    lastSessionPct = usageData?.session?.pct ?? null;
    tray && tray.setImage(makeTrayIcon("ok"));
    tray && tray.setToolTip(buildTooltip());
  } catch (err) {
    fetchError = err.message || "Erreur inconnue";
    tray && tray.setImage(makeTrayIcon("error"));
    usageData = null;
  } finally {
    isScraping = false;
    broadcastUpdate();
  }
}

function buildTooltip() {
  if (!usageData) return "OpenClaudeUsage";
  const s = usageData.session;
  const w = usageData.weekly;
  const e = usageData.extra;
  let tip = "OpenClaudeUsage\n";
  if (s.pct !== null) tip += `Session : ${s.pct}%`;
  if (w.pct !== null) tip += `  |  Semaine : ${w.pct}%`;
  if (e.spend) {
    tip += `\nUsage supp. : ${e.spend}`;
    if (e.budget) tip += ` / ${e.budget}`;
  }
  if (e.balance) tip += `\nSolde : ${e.balance}`;
  return tip.trim();
}

function broadcastUpdate() {
  const payload = {
    usageData,
    lastFetch,
    fetchError,
    refreshInterval: config.refreshInterval,
  };
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.webContents.send("usage-update", payload);
  }
}

/* ─────────────────────────────────────────────
   Auto-refresh timer
───────────────────────────────────────────── */
function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(
    fetchUsage,
    (config.refreshInterval || 5) * 60_000,
  );
}

/* ─────────────────────────────────────────────
   Popup window
───────────────────────────────────────────── */
function savePopupPos() {
  if (!popupWin || popupWin.isDestroyed()) return;
  const [x, y] = popupWin.getPosition();
  lastPopupPos = { x, y };
  config.popupPos = { x, y };
  saveConfig(config);
}

function createPopup() {
  popupWin = new BrowserWindow({
    width: 420,
    height: 600,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  popupWin.loadFile(path.join(__dirname, "popup.html"));
  // Save position on blur (click outside) if settings not open
  popupWin.on("blur", () => {
    if (!settingsWin || settingsWin.isDestroyed()) {
      savePopupPos();
      popupWin.hide();
    }
  });
  // Save position when moved by user (drag)
  popupWin.on("moved", () => savePopupPos());
}

function togglePopup() {
  if (!popupWin || popupWin.isDestroyed()) createPopup();
  if (popupWin.isVisible()) {
    savePopupPos();
    popupWin.hide();
    return;
  }

  // Use last known position, or default bottom-right corner
  if (lastPopupPos) {
    popupWin.setPosition(lastPopupPos.x, lastPopupPos.y);
  } else {
    const { screen } = require("electron");
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    popupWin.setPosition(sw - 436, sh - 616);
  }
  popupWin.show();
  popupWin.focus();
  broadcastUpdate();
}

/* ─────────────────────────────────────────────
   Settings window
───────────────────────────────────────────── */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 520,
    title: "OpenClaudeUsage — Paramètres",
    frame: false,
    resizable: false,
    minimizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.setMenu(null);
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

/* ─────────────────────────────────────────────
   App bootstrap
───────────────────────────────────────────── */
app.whenReady().then(() => {
  app.setAppUserModelId("com.william.open-claude-usage");
  if (app.dock) app.dock.hide();

  // Chargement de la config (app.getPath disponible seulement ici)
  config = loadConfig();
  lastPopupPos = config.popupPos || null;

  try {
    tray = new Tray(makeTrayIcon(config.sessionKey ? "idle" : "error"));
  } catch (_) {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip("OpenClaudeUsage Monitor");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Afficher / Masquer", click: togglePopup },
      { label: "Rafraîchir maintenant", click: fetchUsage },
      { type: "separator" },
      { label: "Paramètres", click: openSettings },
      {
        label: "Ouvrir claude.ai",
        click: () => shell.openExternal("https://claude.ai/settings/usage"),
      },
      { type: "separator" },
      { label: "Quitter", click: () => app.quit() },
    ]),
  );
  tray.on("click", togglePopup);

  createPopup();

  // Start fetching (slight delay so window can init)
  setTimeout(fetchUsage, 1000);
  scheduleRefresh();
}).catch((err) => {
  console.error("Erreur fatale au démarrage :", err);
  app.quit();
});

/* ─────────────────────────────────────────────
   IPC
───────────────────────────────────────────── */
ipcMain.on("refresh", () => fetchUsage());
ipcMain.on("open-settings", () => openSettings());
ipcMain.on("close-popup", () => {
  savePopupPos();
  popupWin?.hide();
});
ipcMain.on("open-external", (_, url) => shell.openExternal(url));
ipcMain.on("get-config", (e) => e.reply("config-data", config));
ipcMain.on("save-config", (e, cfg) => {
  config = { ...config, ...cfg };
  saveConfig(config);
  scheduleRefresh();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  fetchUsage();
});
