const { app, BrowserWindow, session, ipcMain, Tray, Menu, Notification, globalShortcut, dialog, shell, nativeTheme, net, utilityProcess } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Family, TrayGate, accelOk, hotkeyPlan, auraKeys, auraTray } = require('./family'); // aura.txt в семье dev.txt: kit.txt, hub/PROTOCOL.md, «Семья»

// Dev-only flags: --shot=<png> saves a screenshot and quits, --test runs the DSP self-check.
const shotArg = process.argv.find((a) => a.startsWith('--shot='));
const testMode = process.argv.includes('--test');
const probeMode = process.argv.includes('--probe'); // dev: switch on for one run without saving
const devRun = !!shotArg || testMode || probeMode;
const tabArg = process.argv.find((a) => a.startsWith('--tab=')); // dev: open on a given page
const dataArg = process.argv.find((a) => a.startsWith('--data=')); // dev: worst-case fixtures (app/dev-fixtures.js)
const sizeArg = process.argv.find((a) => a.startsWith('--size=')); // dev: WIDTHxHEIGHT
const zoomArg = process.argv.find((a) => a.startsWith('--zoom='));
const themeArg = process.argv.find((a) => a.startsWith('--theme=')); // dev: light | dark
const clickSelector = process.env.AURA_CLICK; // dev: click this selector partway through a --shot run
const startHidden = process.argv.includes('--hidden'); // launched with Windows: straight to the tray
const asset = (name) => path.join(__dirname, 'assets', name);

// Let the audio engine start on launch, without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Dev runs get a profile of their own: they must never read or overwrite the installed app's settings.
if (devRun) app.setPath('userData', path.join(app.getPath('temp'), 'aura-dev-profile'));
if (shotArg) app.disableHardwareAcceleration(); // dev screenshots: software rendering works with the display off

if (!devRun && !app.requestSingleInstanceLock()) app.quit();
// Уведомления Windows и кнопка на панели задач — от имени ярлыка «Пуск», который ставит установщик: у него этот же id
// (build.appId в package.json). Без него Windows не показывает уведомления приложения.
const APP_ID = 'app.aura.voice'; // под ним же Electron пишет автозапуск в реестр
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId(APP_ID);

let win;
let tray;
let quitting = false;
let ui = { on: false, mute: false, system: false, preset: '', presetName: '', presets: [], voice: 'none', voices: [] }; // what the window last reported
const HOTKEY_POWER = 'Ctrl+Shift+F9';
const HOTKEY_MUTE = 'Ctrl+Shift+F10';
let hotkeys = { power: HOTKEY_POWER, mute: HOTKEY_MUTE }; // what the window last asked for

// Mica — the Windows 11 window material — from 22H2 (build 22621) on. Off for dev screenshots: they render offscreen.
const micaOk = () => process.platform === 'win32' && Number(String(require('os').release()).split('.')[2] || 0) >= 22621;

function createWindow() {
  nativeTheme.themeSource = 'dark'; // Aura is a dark room whatever Windows is set to: its light needs darkness behind it
  const mica = micaOk() && !shotArg;
  win = new BrowserWindow({
    width: 1060,
    height: 900,
    minWidth: 940,
    minHeight: 700,
    show: false,
    backgroundColor: mica ? '#00000000' : '#202020',
    ...(mica ? { backgroundMaterial: 'mica' } : {}),
    title: 'aura.txt',
    icon: asset('icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 30 },
    webPreferences: {
      // The voice must keep flowing while the window is minimised.
      backgroundThrottling: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      offscreen: !!shotArg, // dev screenshots render in memory, so they work with the display locked or off
    },
  });

  win.removeMenu();
  if (devRun && sizeArg) {
    const [w, h] = sizeArg.slice('--size='.length).split('x').map(Number);
    win.setMinimumSize(300, 300);
    win.setContentSize(w, h);
  }
  // Chromium remembers the zoom per profile, so dev runs always set it — back to 1 unless asked otherwise.
  if (devRun) win.webContents.once('did-finish-load', () => win.webContents.setZoomFactor(zoomArg ? Number(zoomArg.slice('--zoom='.length)) : 1));
  win.loadFile(path.join(__dirname, 'app', 'index.html'), {
    query: { ...(testMode ? { test: '1' } : probeMode ? { probe: '1' } : {}), ...(tabArg ? { tab: tabArg.slice('--tab='.length) } : {}), ...(devRun && dataArg ? { data: dataArg.slice('--data='.length) } : {}), ...(mica ? { mica: '1' } : {}) },
  });
  win.once('ready-to-show', () => {
    if (!startHidden && !shotArg) win.show();
  });
  // The window keeps running in the tray (the audio needs it), but it has no business drawing there.
  const tellVisible = () => command('visible', win.isVisible() && !win.isMinimized());
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, tellVisible);

  // Closing the window keeps Aura in the tray: the voice stays on, like a proper background utility.
  win.on('close', (e) => {
    if (quitting || devRun) return;
    e.preventDefault();
    win.hide();
    // Один раз подсказать, где теперь aura.txt (tellUser: остров kapsula.txt, свой значок или уведомление Windows).
    // Значок у core.txt — подсказка про его меню и про выход в «Настройках». Показать было нельзя — подскажем в другой раз.
    const flag = path.join(app.getPath('userData'), 'tray-hint-shown');
    if (!fs.existsSync(flag)) {
      const told = family.hideOwnTray
        ? tellUser('aura.txt работает в фоне', 'Голос продолжает обрабатываться. Окно открывается из меню core.txt в трее, а выйти можно в «Настройках».')
        : tellUser('aura.txt осталась в трее', 'Голос продолжает обрабатываться. Чтобы закрыть совсем — правый клик по рыбке → «Выход».');
      if (told) {
        try {
          fs.writeFileSync(flag, '');
        } catch {}
      }
    }
  });

  if (shotArg || testMode || probeMode) {
    // dev: AURA_HIDE_TEST=1 measures how many animation frames the page gets while shown and while hidden.
    if (process.env.AURA_HIDE_TEST) {
      const count = "new Promise((r) => { let n = 0; const t = performance.now(); (function f() { n++; if (performance.now() - t < 1000) requestAnimationFrame(f); else r(n); })(); setTimeout(() => r(n), 1500); })";
      const appFrames = "new Promise((r) => { const a = lastFrame; setTimeout(() => r(lastFrame !== a), 700); })";
      setTimeout(async () => {
        const js = (code) => win.webContents.executeJavaScript(code).catch((e) => 'failed: ' + e.message);
        console.log('[hide-test] shown : raw rAF/s =', await js(count), '| app loop running =', await js(appFrames), '| document.hidden =', await js('document.hidden'));
        win.hide();
        await new Promise((r) => setTimeout(r, 800));
        console.log('[hide-test] hidden: raw rAF/s =', await js(count), '| app loop running =', await js(appFrames), '| document.hidden =', await js('document.hidden'), '| windowVisible =', await js('windowVisible'));
        win.show();
        await new Promise((r) => setTimeout(r, 800));
        console.log('[hide-test] reshown: app loop running =', await js(appFrames), '| windowVisible =', await js('windowVisible'));
      }, 2500);
    }
    // dev: AURA_EARLY_SHOT=<ms after load> saves an extra frame, e.g. to look at the launch animation
    if (shotArg && process.env.AURA_EARLY_SHOT) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            fs.writeFileSync(shotArg.slice('--shot='.length).replace(/.png$/, '-early.png'), (await win.webContents.capturePage()).toPNG());
          } catch (err) {
            console.log('[early shot] failed:', err.message);
          }
        }, Number(process.env.AURA_EARLY_SHOT));
      });
    }
    if (shotArg && clickSelector) {
      setTimeout(async () => {
        const result = await win.webContents
          .executeJavaScript(`(async () => { for (let i = 0; i < 40; i++) { const el = document.readyState === 'complete' && document.querySelector(${JSON.stringify(clickSelector)}); if (el) { el.click(); return 'clicked ' + el.tagName + ' "' + el.textContent + '"'; } await new Promise((r) => setTimeout(r, 250)); } return 'no element'; })()`)
          .catch((err) => 'click failed: ' + err.message);
        console.log('[click]', result);
      }, 1500);
    }
    win.webContents.on('console-message', (e) => {
      console.log('[renderer]', e.message);
    });
    setTimeout(async () => {
      if (shotArg) {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shotArg.slice('--shot='.length), img.toPNG());
        } catch (err) {
          console.log('[shot] failed:', err.message);
        }
        // A text summary of what is on screen, for when a picture is not enough.
        const summary = await win.webContents
          .executeJavaScript("JSON.stringify({ tab: document.querySelector('.tabs [aria-selected=true]')?.textContent, pages: [...document.querySelectorAll('.page')].filter((p) => !p.hidden).map((p) => p.dataset.page), pads: [...document.querySelectorAll('.pad')].map((e) => e.textContent), added: document.querySelector('.catalog-row .pill')?.textContent, rows: document.querySelectorAll('.catalog-row').length, first: [...document.querySelectorAll('.catalog-title')].slice(0, 3).map((e) => e.textContent), note: document.querySelector('#catalogNote')?.textContent, status: document.querySelector('#status')?.textContent, intro: !!document.querySelector('#intro'), body: document.body.className, heroOpacity: getComputedStyle(document.querySelector('.hero')).opacity, fishCells: document.querySelectorAll('#introFish i').length })")
          .catch((err) => 'summary failed: ' + err.message);
        console.log('[dom]', summary);
      }
      app.quit();
    }, process.env.AURA_HIDE_TEST ? 12000 : probeMode ? 10000 : shotArg ? 14000 : 4500);
  }
}

/* ───── Soundboard files ─────
 * Sounds the user adds are copied into the app's own folder under a random name, so pads keep
 * working when the original file moves, and the page can only ever ask for files from there. */
const soundsDir = () => path.join(app.getPath('userData'), 'sounds');
const soundId = /^[0-9a-f-]{36}\.(mp3|wav|ogg|m4a|flac|opus)$/;

ipcMain.handle('sounds:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Добавить звуки',
    filters: [{ name: 'Звуки', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled) return [];
  fs.mkdirSync(soundsDir(), { recursive: true });
  const added = [];
  for (const file of filePaths.slice(0, 50)) {
    try {
      const ext = path.extname(file).toLowerCase();
      const id = crypto.randomUUID() + ext;
      if (!soundId.test(id) || fs.statSync(file).size > 30e6) continue;
      fs.copyFileSync(file, path.join(soundsDir(), id));
      added.push({ id, name: path.basename(file, path.extname(file)).slice(0, 40) });
    } catch {}
  }
  return added;
});
// Clownfish keeps the sounds of its player as plain files in its own folder: copy them over, so
// someone moving from it finds their sounds here. Returns null when Clownfish is not installed.
ipcMain.handle('sounds:clownfish', () => {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map((p) => path.join(p, 'ClownfishVoiceChanger', 'sounds'));
  const dir = roots.find((p) => fs.existsSync(p));
  if (!dir) return null;
  fs.mkdirSync(soundsDir(), { recursive: true });
  const added = [];
  for (const name of fs.readdirSync(dir).sort().slice(0, 100)) {
    try {
      const ext = path.extname(name).toLowerCase();
      const id = crypto.randomUUID() + ext;
      const file = path.join(dir, name);
      if (!soundId.test(id) || !fs.statSync(file).isFile() || fs.statSync(file).size > 30e6) continue;
      fs.copyFileSync(file, path.join(soundsDir(), id));
      added.push({ id, name: path.basename(name, path.extname(name)).slice(0, 40), source: 'clownfish' });
    } catch {}
  }
  return added;
});
ipcMain.handle('sounds:read', (_e, id) => {
  if (typeof id !== 'string' || !soundId.test(id)) return null;
  try {
    return fs.readFileSync(path.join(soundsDir(), id));
  } catch {
    return null;
  }
});
ipcMain.handle('sounds:remove', (_e, id) => {
  if (typeof id !== 'string' || !soundId.test(id)) return false;
  try {
    fs.rmSync(path.join(soundsDir(), id), { force: true });
  } catch {}
  return true;
});
// The decoded clip for the module: raw mono float32 at 48 kHz, at most 20 seconds.
ipcMain.handle('sounds:clip', (_e, samples) => {
  if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length > 48000 * 20) return false;
  try {
    const tmp = path.join(dataDir, 'clip.tmp');
    fs.writeFileSync(tmp, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    fs.renameSync(tmp, path.join(dataDir, 'clip.pcm'));
    return true;
  } catch {
    return false;
  }
});

/* ───── UwUpad catalogue ─────
 * The window never talks to the network itself; these handlers do, and only to this one site.
 * Requests happen when the user searches, scrolls or presses a button — nothing is crawled. */
const UWU_SITE = 'https://uwupad.me';
const UWU_CDN = 'https://cdn.uwupad.me';
const uwuHeaders = () => ({ Accept: 'application/json', 'User-Agent': `AuraVoice/${app.getVersion()} (desktop soundboard)` });
const uwuExt = /^(mp3|wav|ogg|m4a|flac|opus)$/;
const uwuCache = new Map(); // recently fetched audio, so "listen, then add" downloads once

ipcMain.handle('uwu:list', async (_e, q) => {
  const feed = ['popular', 'trending', 'latest'].includes(q?.feed) ? q.feed : 'popular';
  const query = typeof q?.query === 'string' ? q.query.trim().slice(0, 80) : '';
  const offset = Math.max(0, Math.min(5000, Number(q?.offset) || 0));
  const url = query
    ? `${UWU_SITE}/api/search?v3=true&query=${encodeURIComponent(query)}&limit=24&offset=${offset}`
    : `${UWU_SITE}/api/sounds/?v3=true&tab=${feed}&limit=24&offset=${offset}`;
  try {
    const res = await fetch(url, { headers: uwuHeaders(), signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { error: true };
    const json = await res.json();
    const items = (Array.isArray(json?.data) ? json.data : [])
      .slice(0, 24)
      .map((s) => ({
        id: Number(s.id),
        file: Number(s.original_id || s.id), // re-uploads point at the original file
        ext: String(s.extension || 'mp3').toLowerCase(),
        title: (String(s.title || '').trim() || 'Без названия').slice(0, 80),
        duration: Math.round(Number(s.duration) || 0),
        likes: Number(s.likes) || 0,
        explicit: !!s.is_explicit,
        loud: !!s.is_loud,
      }))
      .filter((s) => Number.isInteger(s.id) && Number.isInteger(s.file) && s.file > 0 && uwuExt.test(s.ext));
    return { total: Number(json.total) || items.length, items };
  } catch {
    return { error: true };
  }
});

async function uwuAudio(item) {
  const file = Number(item?.file);
  const ext = String(item?.ext || '');
  if (!Number.isInteger(file) || file <= 0 || !uwuExt.test(ext)) return null;
  const key = `${file}.${ext}`;
  if (uwuCache.has(key)) return uwuCache.get(key);
  try {
    const res = await fetch(`${UWU_CDN}/${key}`, { headers: { 'User-Agent': uwuHeaders()['User-Agent'] }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 15e6) return null;
    uwuCache.set(key, bytes);
    if (uwuCache.size > 30) uwuCache.delete(uwuCache.keys().next().value);
    return bytes;
  } catch {
    return null;
  }
}
ipcMain.handle('uwu:sound', (_e, item) => uwuAudio(item));
ipcMain.handle('uwu:add', async (_e, item) => {
  const bytes = await uwuAudio(item);
  if (!bytes) return null;
  try {
    fs.mkdirSync(soundsDir(), { recursive: true });
    const id = `${crypto.randomUUID()}.${item.ext}`;
    fs.writeFileSync(path.join(soundsDir(), id), bytes);
    return { id, name: (String(item.title || '').trim() || 'Звук').slice(0, 40), source: `uwu:${Number(item.id)}` };
  } catch {
    return null;
  }
});
ipcMain.handle('uwu:open', () => shell.openExternal(UWU_SITE));

/* ───── Hotkeys ─────
 * The window owns the configuration and re-sends all of it on every change.
 * Что и в каком порядке занимается (обработка, микрофон, голоса, звуки) — hotkeyPlan() в family.js;
 * тот же список уходит в aura.keys, на страницу «Клавиши» в core.txt. */
let keyConfig = null; // что окно прислало последним — для aura.keys
ipcMain.handle('hotkeys:set', (_e, config) => {
  if (devRun) return [];
  globalShortcut.unregisterAll();
  const failed = [];
  for (const k of hotkeyPlan(config)) {
    let ok = false;
    try {
      ok = globalShortcut.register(k.accel, () => command(k.action, k.arg));
    } catch {}
    if (!ok) failed.push(k.accel); // some other program already owns this combination
  }
  hotkeys = { power: accelOk(config?.power) ? config.power : '', mute: accelOk(config?.mute) ? config.mute : '' };
  keyConfig = config && typeof config === 'object' ? config : null;
  refreshTray();
  publishKeys();
  return failed;
});

/* ───── Microphones the module can live in ───── */
ipcMain.handle('system:devices', () => {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$current = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Aura' -ErrorAction SilentlyContinue).Device",
    "Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture' | ForEach-Object {",
    '  if ((Get-ItemProperty $_.PSPath).DeviceState -eq 1) {',
    "    $p = Get-ItemProperty ($_.PSPath + '\\Properties')",
    "    [pscustomobject]@{ guid = $_.PSChildName; name = ($p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2' + ' — ' + $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'); current = ($_.PSChildName -eq $current) }",
    '  }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }, (err, out) => {
      try {
        const parsed = JSON.parse(String(out).trim() || '[]');
        resolve(
          (Array.isArray(parsed) ? parsed : [parsed])
            .filter((d) => /^\{[0-9a-fA-F-]{36}\}$/.test(d.guid))
            .map((d) => ({ guid: d.guid, name: String(d.name).slice(0, 90), current: !!d.current }))
        );
      } catch {
        resolve([]);
      }
    });
  });
});

/* ───── Rendering recordings through the module's own chain (native/render.cpp) ─────
 * The page decodes audio (only it has a decoder) and hands over mono float32 at 48 kHz; the tool
 * returns stereo. A short sample comes straight back; a file is streamed to disk as a WAV. */
const renderTool = () => path.join(app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, 'native', 'bin'), 'AuraRender.exe');
const renderModel = () => path.join(path.dirname(renderTool()), 'DeepFilterNet3_onnx.tar.gz');
const renderDir = () => {
  const dir = path.join(app.getPath('temp'), 'aura-render');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const cleanSettings = (text) => String(text || '').split(/\r?\n/).filter((l) => /^[a-z0-9]{1,16}=-?[0-9.]{1,12}$/.test(l)).slice(0, 200).join('\n') + '\n';
function runRender(inFile, outFile, settings) {
  return new Promise((resolve) => {
    const cfg = inFile + '.txt';
    fs.writeFileSync(cfg, cleanSettings(settings));
    const args = [inFile, outFile, cfg];
    if (fs.existsSync(renderModel())) args.push(renderModel());
    execFile(renderTool(), args, { windowsHide: true, timeout: 20 * 60 * 1000 }, (err) => {
      fs.rm(cfg, { force: true }, () => {});
      resolve(!err);
    });
  });
}
let renderSeq = 0;
// The user's own recorded phrase, kept between sessions: the effects page tries voices on it.
const takeFile = () => path.join(app.getPath('userData'), 'take.f32');
ipcMain.handle('take:save', (_e, pcm) => {
  const bytes = Buffer.from(pcm instanceof ArrayBuffer ? pcm : []);
  if (!bytes.length || bytes.length % 4 || bytes.length > 4 * 48000 * 30) return false;
  try {
    fs.writeFileSync(takeFile(), bytes);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('take:load', () => {
  try {
    const b = fs.readFileSync(takeFile());
    return b.length && b.length % 4 === 0 ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null;
  } catch {
    return null;
  }
});
ipcMain.handle('render:available', () => fs.existsSync(renderTool()));
ipcMain.handle('render:sample', async (_e, pcm, settings) => {
  const bytes = Buffer.from(pcm instanceof ArrayBuffer ? pcm : pcm?.buffer || []);
  if (!bytes.length || bytes.length % 4 || bytes.length > 4 * 48000 * 600 || !fs.existsSync(renderTool())) return null; // ten minutes at most
  const base = path.join(renderDir(), `sample-${process.pid}-${++renderSeq}`);
  try {
    fs.writeFileSync(base + '.in', bytes);
    if (!(await runRender(base + '.in', base + '.out', settings))) return null;
    const out = fs.readFileSync(base + '.out');
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  } catch {
    return null;
  } finally {
    for (const ext of ['.in', '.out']) fs.rm(base + ext, { force: true }, () => {});
  }
});
// A file: ask where to save first, take the audio in pieces, then render and write the WAV.
const renderJobs = new Map();
ipcMain.handle('render:begin', async (_e, name) => {
  const safe = String(name || 'Aura').replace(/\.[^.]{1,5}$/, '').replace(/[^\p{L}\p{N} _.()-]/gu, '').slice(0, 80) || 'Aura';
  const { canceled, filePath } = await dialog.showSaveDialog(win, { title: 'Сохранить запись', defaultPath: `${safe} — Aura.wav`, filters: [{ name: 'WAV', extensions: ['wav'] }] });
  if (canceled || !filePath) return null;
  const token = `${process.pid}-${++renderSeq}`;
  const base = path.join(renderDir(), 'file-' + token);
  renderJobs.set(token, { base, target: filePath, bytes: 0, fd: fs.openSync(base + '.in', 'w') });
  return token;
});
ipcMain.handle('render:chunk', (_e, token, pcm) => {
  const job = renderJobs.get(token);
  const bytes = Buffer.from(pcm instanceof ArrayBuffer ? pcm : pcm?.buffer || []);
  if (!job || bytes.length % 4 || job.bytes + bytes.length > 4 * 48000 * 3600 * 3) return false; // three hours at most
  fs.writeSync(job.fd, bytes);
  job.bytes += bytes.length;
  return true;
});
ipcMain.handle('render:finish', async (_e, token, settings) => {
  const job = renderJobs.get(token);
  if (!job) return { ok: false };
  renderJobs.delete(token);
  fs.closeSync(job.fd);
  const clean = () => { for (const ext of ['.in', '.out']) fs.rm(job.base + ext, { force: true }, () => {}); };
  try {
    if (!job.bytes) return { ok: false };
    const frames = job.bytes / 4;
    let source = job.base + '.in';
    let channels = 1;
    if (settings != null) { // null = already processed (a take recorded through the module): only wrap it
      if (!fs.existsSync(renderTool()) || !(await runRender(source, job.base + '.out', settings))) return { ok: false };
      source = job.base + '.out';
      channels = 2;
    }
    // 24-bit PCM WAV, written in pieces.
    const out = fs.openSync(job.target, 'w');
    const data = frames * channels * 3;
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + data, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); head.writeUInt16LE(channels, 22); head.writeUInt32LE(48000, 24); head.writeUInt32LE(48000 * channels * 3, 28);
    head.writeUInt16LE(channels * 3, 32); head.writeUInt16LE(24, 34); head.write('data', 36); head.writeUInt32LE(data, 40);
    fs.writeSync(out, head);
    const inp = fs.openSync(source, 'r');
    const piece = Buffer.alloc(4 * 65536);
    for (;;) {
      const got = fs.readSync(inp, piece, 0, piece.length, null);
      if (got <= 0) break;
      const n = got >> 2;
      const pcm = Buffer.alloc(n * 3);
      for (let i = 0; i < n; i++) {
        const v = Math.max(-8388608, Math.min(8388607, Math.round(piece.readFloatLE(i * 4) * 8388607)));
        pcm.writeIntLE(v, i * 3, 3);
      }
      fs.writeSync(out, pcm);
    }
    fs.closeSync(inp);
    fs.closeSync(out);
    return { ok: true, seconds: frames / 48000, name: path.basename(job.target) };
  } catch {
    return { ok: false };
  } finally {
    clean();
  }
});

/* ───── AI voices ─────
 * Neural voice conversion with the user's own voice models (see ai-convert.js). Nothing is
 * bundled: the content encoder (377 MB) is fetched once on the user's click, voices are files
 * the user adds. Everything runs in a worker process. */
const AI_ENCODER = {
  file: 'vec-768-layer-12.onnx',
  url: 'https://huggingface.co/NaruseMioShirakana/MoeSS-SUBModel/resolve/main/vec-768-layer-12.onnx',
  size: 377655729,
  sha256: 'b3886e7dff1495cda514f94f4680a7b1261e05d6929f5c764cdb17934b413c2a',
};
const aiDir = () => {
  const dir = path.join(app.getPath('userData'), 'ai');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const aiEncoder = () => {
  const own = path.join(aiDir(), AI_ENCODER.file);
  if (fs.existsSync(own)) return own;
  const dev = path.join(__dirname, 'third_party', 'ai', AI_ENCODER.file);
  return !app.isPackaged && fs.existsSync(dev) ? dev : null;
};
// The open voices: RVC's own v2 base model (MIT; trained by the RVC project on the open VCTK
// corpus, CC BY 4.0), exported with RVC's exporter in this repository's CI (ai-export workflow).
// One file, 109 timbres. Fetched on the user's click from this project's releases.
const AI_BASE = {
  file: 'rvc-v2-base-40k.onnx',
  url: 'https://github.com/cxxperman/aura.txt/releases/download/ai-voices-1/rvc-v2-base-40k.onnx',
  size: 110892490,
  sha256: 'f1bac9e2433823c9a39d5375c2cc7b7e98cd4c6300fd26efb67a9bf9b9681023',
  speakers: 109,
};
const aiBase = () => {
  const own = path.join(aiDir(), AI_BASE.file);
  if (fs.existsSync(own)) return own;
  const dev = path.join(__dirname, 'third_party', 'ai', 'base', AI_BASE.file);
  return !app.isPackaged && fs.existsSync(dev) ? dev : null;
};
// A file this version knows the size and SHA-256 of, streamed to disk; `progress` gets 0…1.
async function aiFetch(item, progress) {
  const part = path.join(aiDir(), item.file + '.part');
  try {
    const res = await net.fetch(item.url, { headers: { 'User-Agent': `AuraVoice/${app.getVersion()}` } });
    if (!res.ok || !res.body) return false;
    const out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha256');
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      got += chunk.length;
      progress(Math.min(0.999, got / item.size));
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r) => out.end(r));
    if (got !== item.size || hash.digest('hex') !== item.sha256) return false; // exactly the tested file, or nothing
    fs.renameSync(part, path.join(aiDir(), item.file));
    return true;
  } catch {
    return false;
  } finally {
    fs.rm(part, { force: true }, () => {});
  }
}
let aiBaseDownload = null;
ipcMain.handle('ai:base', async () => {
  if (aiBaseDownload != null || aiBase()) return !!aiBase();
  aiBaseDownload = 0;
  const ok = await aiFetch(AI_BASE, (p) => (aiBaseDownload = p));
  aiBaseDownload = null;
  return ok;
});
const aiVoiceId = /^[0-9a-f-]{36}$/;
const aiList = () => {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(aiDir(), 'voices.json'), 'utf8'));
    return Array.isArray(list) ? list.filter((v) => aiVoiceId.test(v.id) && fs.existsSync(path.join(aiDir(), v.id + '.onnx'))) : [];
  } catch {
    return [];
  }
};
const aiSave = (list) => fs.writeFileSync(path.join(aiDir(), 'voices.json'), JSON.stringify(list, null, 2));
let aiDownload = null; // fraction while the encoder is being fetched
let aiProgress = null; // fraction while a conversion runs
let aiLive = null; // { on, ms, worst, late } while the live voice runs
let aiChild = null;
let aiSeq = 0;
const aiWaiting = new Map();
function aiAsk(msg) {
  if (!aiChild) {
    aiChild = utilityProcess.fork(path.join(__dirname, 'ai-worker.js'), [], { serviceName: 'Aura AI voices' });
    aiChild.on('message', (m) => {
      if (m.progress != null) return (aiProgress = m.progress);
      if (m.live) return (aiLive = { ...m.live, on: true });
      if (m.id === 0 && m.error) return (aiLive = { on: !!aiLive?.on, error: m.error });
      const done = aiWaiting.get(m.id);
      aiWaiting.delete(m.id);
      done?.(m);
    });
    aiChild.on('exit', () => {
      aiChild = null;
      aiLive = null;
      for (const done of aiWaiting.values()) done({ ok: false, error: 'Процесс ИИ-голосов завершился' });
      aiWaiting.clear();
    });
  }
  return new Promise((resolve) => {
    const id = ++aiSeq;
    aiWaiting.set(id, resolve);
    aiChild.postMessage({ ...msg, id });
  });
}
ipcMain.handle('ai:status', () => ({ encoder: !!aiEncoder(), megabytes: Math.round(AI_ENCODER.size / 1e6), downloading: aiDownload, converting: aiProgress, live: aiLive, voices: aiList(), base: { present: !!aiBase(), megabytes: Math.round(AI_BASE.size / 1e6), downloading: aiBaseDownload, speakers: AI_BASE.speakers } }));
ipcMain.handle('ai:download', async () => {
  if (aiDownload != null || aiEncoder()) return !!aiEncoder();
  aiDownload = 0;
  const ok = await aiFetch(AI_ENCODER, (p) => (aiDownload = p));
  aiDownload = null;
  return ok;
});
ipcMain.handle('ai:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Добавить голос', filters: [{ name: 'Модель голоса RVC', extensions: ['onnx', 'pth'] }], properties: ['openFile'] });
  if (canceled || !filePaths[0]) return null;
  try {
    if (fs.statSync(filePaths[0]).size > 600e6) return { error: 'Файл слишком большой для модели голоса.' };
    const id = crypto.randomUUID();
    const stored = path.join(aiDir(), id + '.onnx');
    let source = filePaths[0];
    if (path.extname(source).toLowerCase() === '.pth') {
      const made = await aiAsk({ cmd: 'pth', file: source, templates: path.join(__dirname, 'ai-templates'), out: stored });
      if (!made.ok) {
        fs.rm(stored, { force: true }, () => {});
        return { error: /[а-яё]/i.test(made.error || '') ? made.error : `Не получилось перевести .pth: ${made.error || 'неизвестная ошибка'}` };
      }
      source = stored;
    }
    const res = await aiAsk({ cmd: 'inspect', voice: source });
    if (!res.ok) return { error: 'Не получилось прочитать этот файл как модель ONNX.' };
    if (!res.info.ok) return { error: 'Это не модель голоса RVC: в ней нет входов phone или feats.' };
    if (res.info.dim === 256) return { error: 'Это модель первого поколения (256). Пока поддерживаются модели v2 (768).' };
    if (source !== stored) fs.copyFileSync(source, stored);
    const list = aiList();
    list.push({ id, name: path.basename(filePaths[0], path.extname(filePaths[0])).slice(0, 40), layout: res.info.layout, pitched: res.info.pitched });
    aiSave(list);
    return { ok: true };
  } catch {
    return { error: 'Не получилось добавить файл.' };
  }
});
ipcMain.handle('ai:remove', (_e, id) => {
  if (typeof id !== 'string' || !aiVoiceId.test(id)) return false;
  aiSave(aiList().filter((v) => v.id !== id));
  fs.rm(path.join(aiDir(), id + '.onnx'), { force: true }, () => {});
  return true;
});
// Live: the worker converts the voice the module hands it through %ProgramData%\\Aura\\live.bin.
ipcMain.handle('ai:live', async (_e, on, id, st, speaker) => {
  if (!on) {
    if (aiChild) await aiAsk({ cmd: 'live-stop' });
    aiLive = null;
    return { ok: true };
  }
  const encoder = aiEncoder();
  const voiceFile = id === 'base' ? aiBase() : typeof id === 'string' && aiVoiceId.test(id) ? path.join(aiDir(), id + '.onnx') : null;
  if (!encoder || !voiceFile) return { error: 'Сначала скачайте компонент и выберите голос.' };
  const res = await aiAsk({ cmd: 'live-start', encoder, voice: voiceFile, file: path.join(dataDir, 'live.bin'), st: Math.max(-24, Math.min(24, Number(st) || 0)), speaker: id === 'base' ? Math.max(0, Math.min(AI_BASE.speakers - 1, Math.round(Number(speaker) || 0))) : 0 });
  if (!res.ok) return { error: res.error || 'Не получилось запустить.' };
  aiLive = { on: true };
  return { ok: true };
});
ipcMain.handle('ai:live-set', async (_e, st, speaker) => {
  if (aiChild && aiLive?.on) await aiAsk({ cmd: 'live-set', st: Math.max(-24, Math.min(24, Number(st) || 0)), speaker: Math.max(0, Math.min(AI_BASE.speakers - 1, Math.round(Number(speaker) || 0))) });
  return true;
});
ipcMain.handle('ai:convert', async (_e, pcm, id, st, speaker) => {
  const encoder = aiEncoder();
  const voiceFile = id === 'base' ? aiBase() : typeof id === 'string' && aiVoiceId.test(id) ? path.join(aiDir(), id + '.onnx') : null;
  if (!encoder || !voiceFile || !(pcm instanceof ArrayBuffer) || pcm.byteLength % 4 || pcm.byteLength > 4 * 48000 * 600) return { error: 'Нечего преобразовывать.' };
  aiProgress = 0;
  const res = await aiAsk({ cmd: 'convert', encoder, voice: voiceFile, pcm, st: Math.max(-24, Math.min(24, Number(st) || 0)), speaker: id === 'base' ? Math.max(0, Math.min(AI_BASE.speakers - 1, Math.round(Number(speaker) || 0))) : 0 });
  aiProgress = null;
  return res.ok ? { pcm: res.pcm } : { error: res.error || 'Не получилось.' };
});

/* ───── Party ─────
 * Talking to someone together: a site (any site) runs in a window of its own, its sound can be
 * taken by the Aura window — to be passed on to friends — and what friends say is added to the
 * microphone by the module (party-mix.js). Normally the page in the party window is never touched:
 * nothing is injected into it, nothing about the browser is disguised. The one exception is the
 * "party through Discord" mode with the site in the party window, switched on by the user: then the
 * window gets party-preload.js, which swaps the page's microphone for "the real microphone + Discord's
 * sound" (so the person on the site hears the call, while Discord itself still gets only the voice),
 * and changes nothing else. With the site in the person's own browser instead, the party window is
 * left alone: Discord's sound goes to the Aura window, which plays "voice + call" into a virtual cable
 * (app/party-cable.js), and the browser takes the cable as its microphone.
 * The window has a profile of its own, apart from Aura's, and the one thing it may be granted is
 * the microphone, asked per site. */
const { Mix } = require('./party-mix.js');
const { DISCORD_NAMES, isDiscord, parseTasklist, parseCim, pickDiscordRoot, FrameFeed } = require('./party-discord.js');
let partyWin = null;
let partyMix = null;
let partyDiscord = false; // "party through Discord": the window says, on start and on every change
let partyDiscordWhere = 'window'; // where the site is: 'window' (the party window, preload) | 'browser' (own browser, cable)
let partyCable = false; // 'browser': the Aura window has found the cable device to play into
const partyPreloadWanted = () => partyDiscord && partyDiscordWhere === 'window';
const partyMicAllowed = new Set(); // origins the user said yes to, this run only
const partySession = () => session.fromPartition('persist:party');
const originOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
};
function partyPermissions() {
  const ses = partySession();
  ses.setPermissionRequestHandler(async (wc, permission, done, details) => {
    const origin = originOf(details.requestingUrl || wc.getURL());
    if (permission !== 'media' || !origin || (details.mediaTypes || []).includes('video')) return done(false);
    if (partyMicAllowed.has(origin)) return done(true);
    const { response } = await dialog.showMessageBox(partyWin || win, {
      type: 'question', buttons: ['Разрешить', 'Отказать'], defaultId: 0, cancelId: 1,
      message: `Разрешить микрофон сайту ${new URL(origin).host}?`,
      detail: 'Сайт будет слышать ваш микрофон со всем, что Aura к нему добавляет. Разрешение действует до закрытия Aura.',
    });
    if (response === 0) partyMicAllowed.add(origin);
    done(response === 0);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && partyMicAllowed.has(originOf(origin)));
}
ipcMain.handle('party:open', (_e, address) => {
  let url = String(address || '').trim();
  if (!url) return { error: 'Введите адрес сайта.' };
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  if (!originOf(url)) return { error: 'Нужен адрес сайта с https://' };
  if (!partySiteOpen()) makePartyWin();
  partyWin.loadURL(url);
  partyWin.show();
  discordSync();
  return { ok: true };
});
const partySiteOpen = () => !!partyWin && !partyWin.isDestroyed();
// The preload is fixed when a window is made: the mode decides it, and a change of mode makes the window anew.
function makePartyWin(bounds, show = true) {
  partyPermissions();
  const discordMode = partyPreloadWanted();
  const w = new BrowserWindow({
    width: 1100, height: 820, ...(bounds || {}), show, title: 'Aura — пати', backgroundColor: '#111114', icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      session: partySession(), sandbox: true, contextIsolation: true, nodeIntegration: false,
      // only in this mode: the microphone of the page and of its frames (calls often sit in an iframe) — party-preload.js
      ...(discordMode ? { preload: path.join(__dirname, 'party-preload.js'), nodeIntegrationInSubFrames: true } : {}),
    },
  });
  w.discordMode = discordMode;
  w.removeMenu();
  w.webContents.setWindowOpenHandler(({ url: next }) => {
    if (originOf(next)) w.loadURL(next); // links that want a new window open in this one
    return { action: 'deny' };
  });
  w.on('closed', () => {
    if (partyWin !== w) return;
    partyWin = null;
    discordSync();
  });
  partyWin = w;
  return w;
}
ipcMain.handle('party:close', () => {
  if (partyWin && !partyWin.isDestroyed()) partyWin.close();
  return true;
});
// The mode, from the window: on, where the site is, whether the cable is there. With the party window open and
// the preload now wanted or no longer wanted, its page loads again — with the preload, or without it.
ipcMain.handle('party:discord-mode', (_e, on, where, cable) => {
  partyDiscord = !!on;
  partyDiscordWhere = where === 'browser' ? 'browser' : 'window';
  partyCable = !!cable;
  if (!partyPreloadWanted()) discordFeed.clear(); // the pages of the party window no longer get the sound
  if (partySiteOpen() && partyWin.discordMode !== partyPreloadWanted()) {
    const old = partyWin;
    const url = old.webContents.getURL();
    const shown = old.isVisible();
    const bounds = old.getBounds();
    partyWin = null;
    old.destroy();
    makePartyWin(bounds, shown);
    if (originOf(url)) partyWin.loadURL(url);
  }
  discordSync();
  return discordStatus();
});
ipcMain.handle('party:discord-state', () => discordStatus());
// The cable driver is a third party's: Aura neither downloads nor installs it, only opens its page in the browser.
const CABLE_SITE = 'https://vb-audio.com/Cable/';
ipcMain.handle('party:cable-site', () => shell.openExternal(CABLE_SITE));
ipcMain.handle('party:state', () => (partyWin && !partyWin.isDestroyed() ? { open: true, url: partyWin.webContents.getURL(), title: partyWin.webContents.getTitle().slice(0, 80) } : { open: false }));
ipcMain.handle('party:forget', async () => { // everything the party window's profile holds: sign-ins, cookies, cache
  if (partyWin && !partyWin.isDestroyed()) partyWin.close();
  partyMicAllowed.clear();
  await partySession().clearStorageData();
  await partySession().clearCache();
  return true;
});
// Friends: found by a code, let in by hand (party-net.js). The window is told what happens and
// carries the WebRTC side itself.
const { PartyNet, normalizeCode } = require('./party-net.js');
const PARTY_STUN = [['stun.l.google.com', 19302], ['stun.cloudflare.com', 3478], ['stun.nextcloud.com', 3478], ['stun.sipnet.ru', 3478]]; // the same list as app/party-rtc.js
let partyNet = null;
const partyTell = (name, payload) => win && !win.isDestroyed() && win.webContents.send('party:event', name, payload);
function partyNetwork() {
  if (partyNet) return partyNet;
  partyNet = new PartyNet(require('hyperswarm'));
  for (const name of ['request', 'member', 'left', 'signal', 'audio', 'waiting', 'joined', 'denied', 'ended']) partyNet.on(name, (payload) => partyTell(name, payload));
  return partyNet;
}
ipcMain.handle('party:host', async () => {
  try {
    return { code: await partyNetwork().host() };
  } catch {
    return { error: 'Не получилось создать пати. Проверьте интернет.' };
  }
});
ipcMain.handle('party:join', async (_e, code, name) => {
  if (!normalizeCode(code)) return { error: 'В коде восемь букв и цифр, например ABCD-2345.' };
  try {
    await partyNetwork().join(code, name);
    return { ok: true };
  } catch {
    return { error: 'Не получилось подключиться. Проверьте интернет.' };
  }
});
ipcMain.handle('party:answer', (_e, id, ok) => !!partyNet?.answer(String(id), !!ok));
ipcMain.handle('party:kick', (_e, id) => void partyNet?.kick(String(id)));
ipcMain.on('party:signal', (_e, id, msg) => partyNet?.signal(String(id), msg));
ipcMain.on('party:audio', (_e, id, d) => partyNet?.audio(String(id), d));
// What this computer's network allows, in the terms the party depends on: can it reach the public
// directory where codes are looked up, does its router keep one port per connection (or a new one
// each time, which defeats a direct link unless the other side is better off), do STUN servers answer.
function stunProbe(host, port) {
  return new Promise((resolve) => {
    const s = require('dgram').createSocket('udp4');
    const done = (ok) => { clearTimeout(t); try { s.close(); } catch {} resolve(ok); };
    const t = setTimeout(() => done(false), 2500);
    s.on('error', () => done(false));
    s.on('message', () => done(true));
    s.send(Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), crypto.randomBytes(12)]), port, host, (e) => e && done(false));
  });
}
ipcMain.handle('party:check', async () => {
  const out = { directory: false, ms: 0, symmetric: false, stun: 0, stunAll: PARTY_STUN.length };
  let dht = null;
  try {
    const DHT = require('hyperdht');
    dht = new DHT();
    const t0 = Date.now();
    out.directory = await Promise.race([dht.fullyBootstrapped().then(() => true), new Promise((r) => setTimeout(() => r(false), 12000))]);
    out.ms = Date.now() - t0;
    out.directory = out.directory && dht.nodes.toArray().length > 0;
    out.symmetric = !!dht.randomized;
  } catch {}
  try { await dht?.destroy(); } catch {}
  out.stun = (await Promise.all(PARTY_STUN.map(([h, p]) => stunProbe(h, p)))).filter(Boolean).length;
  return out;
});
ipcMain.handle('party:leave', async () => {
  await partyNet?.leave();
  return true;
});

// The sound of a program instead of a site: native/capture.cpp, one process (and its children) at a time.
const captureTool = () => path.join(app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, 'native', 'bin'), 'AuraCapture.exe');
let partyCapture = null;
function stopPartyCapture() {
  const child = partyCapture;
  partyCapture = null;
  child?.kill();
}
// Programs with a window, by name: what a person would recognise as "an application".
ipcMain.handle('party:apps', () =>
  new Promise((resolve) => {
    if (!fs.existsSync(captureTool())) return resolve(null); // the tool is not there (older install)
    const script = "Get-Process | Where-Object { $_.MainWindowTitle -and $_.Id -ne $PID } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + script], { windowsHide: true, encoding: 'utf8', timeout: 8000 }, (err, out) => {
      try {
        const list = JSON.parse(out || '[]');
        const own = new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]);
        resolve((Array.isArray(list) ? list : [list]).filter((p) => p && Number.isInteger(p.Id) && !own.has(p.Id)).map((p) => ({ pid: p.Id, name: String(p.ProcessName).slice(0, 40), title: String(p.MainWindowTitle).slice(0, 60) })));
      } catch {
        resolve(err ? [] : []);
      }
    });
  })
);
ipcMain.handle('party:capture', (_e, pid) => {
  stopPartyCapture();
  if (!Number.isInteger(pid) || pid <= 0 || !fs.existsSync(captureTool())) return false;
  const child = spawn(captureTool(), [String(pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  partyCapture = child;
  let rest = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    const all = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const whole = all.length - (all.length % 4);
    rest = all.subarray(whole);
    if (whole && win && !win.isDestroyed()) win.webContents.send('party:pcm', all.buffer.slice(all.byteOffset, all.byteOffset + whole));
  });
  child.on('exit', () => {
    if (partyCapture === child) { partyCapture = null; partyTell('capture-ended', {}); }
  });
  return true;
});
ipcMain.handle('party:capture-stop', () => {
  stopPartyCapture();
  return true;
});

/* "Party through Discord": Discord's sound, for the page in the party window — or, with the site in the person's
 * own browser, for the Aura window, which plays it into the virtual cable (channel party:cable-pcm) — and nothing else.
 * A capture of its own (AuraCapture.exe once more), beside the one above: either can run without the other.
 * It runs while the mode is on and the party window is open ('window'), or the cable is there ('browser').
 * Discord is looked for every few seconds while it is not being heard: tasklist (cheap) for whether it runs,
 * and once per Discord start one PowerShell query for which of its processes is the root of the tree (party-discord.js). */
const discordFeed = new FrameFeed('party:discord-pcm');
const discord = { child: null, root: 0, found: false, hearing: false, timer: null, looking: false, failed: new Map(), told: '' };
const discordStatus = () => ({ available: fs.existsSync(captureTool()), on: partyDiscord, where: partyDiscordWhere, cable: partyCable, site: partySiteOpen(), found: discord.found, hearing: discord.hearing });
const discordWanted = () => partyDiscord && (partyDiscordWhere === 'browser' ? partyCable : partySiteOpen()) && fs.existsSync(captureTool());
function tellDiscord() {
  const s = discordStatus();
  const text = JSON.stringify(s);
  if (text === discord.told) return;
  discord.told = text;
  partyTell('discord', s);
}
function discordStop() {
  clearInterval(discord.timer);
  discord.timer = null;
  const child = discord.child;
  discord.child = null;
  child?.kill();
  discord.found = discord.hearing = false;
  discordFeed.clear();
}
function discordSync() {
  if (discordWanted()) {
    if (!discord.timer) {
      discord.timer = setInterval(discordLook, 5000);
      discordLook();
    }
  } else discordStop();
  tellDiscord();
}
function discordLook() {
  if (discord.child || discord.looking) return;
  discord.looking = true;
  execFile('tasklist.exe', ['/FI', 'IMAGENAME eq Discord*', '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (err, out) => {
    const running = err ? [] : parseTasklist(out).filter((p) => isDiscord(p.name));
    discord.found = running.length > 0;
    tellDiscord();
    if (!discord.found) return void (discord.looking = false);
    const start = (pid) => {
      discord.looking = false;
      discord.root = pid;
      if (!pid || discord.child || !discord.timer || Date.now() < (discord.failed.get(pid) || 0)) return;
      discordCapture(pid);
    };
    if (discord.root && running.some((p) => p.pid === discord.root)) return start(discord.root);
    const filter = DISCORD_NAMES.map((n) => `Name='${n}'`).join(' or ');
    const script = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 8000 }, (err2, out2) => start(err2 ? 0 : pickDiscordRoot(parseCim(out2))));
  });
}
function discordCapture(pid) {
  const child = spawn(captureTool(), [String(pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  discord.child = child;
  const started = Date.now();
  let rest = Buffer.alloc(0);
  child.stderr?.on('data', (d) => {
    if (discord.child === child && /capturing/.test(String(d))) {
      discord.hearing = true;
      tellDiscord();
    }
  });
  child.stdout?.on('data', (chunk) => {
    const all = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const whole = all.length - (all.length % 4);
    rest = all.subarray(whole);
    if (!whole || discord.child !== child) return;
    const pcm = all.buffer.slice(all.byteOffset, all.byteOffset + whole);
    if (partyDiscordWhere === 'browser') { // to the Aura window, for the cable; the pages of the party window get nothing
      if (win && !win.isDestroyed()) win.webContents.send('party:cable-pcm', pcm);
    } else if (discordFeed.size) discordFeed.send(pcm);
  });
  child.on('error', () => {});
  child.on('exit', () => {
    if (discord.child !== child) return;
    // Discord closed (or restarted): look again on the next tick. Did not even start — not this process for a while.
    if (!discord.hearing || Date.now() - started < 3000) discord.failed.set(pid, Date.now() + 30000);
    discord.child = null;
    discord.hearing = false;
    tellDiscord();
  });
}
// A page (or a frame in it) of the party window asks for Discord's sound once it opens the microphone.
const fromPartyWin = (e) => partySiteOpen() && e.sender === partyWin.webContents && e.senderFrame;
ipcMain.on('party:discord-want', (e) => {
  if (partyWin?.discordMode && fromPartyWin(e)) discordFeed.want(e.senderFrame);
});
ipcMain.on('party:discord-unwant', (e) => {
  if (fromPartyWin(e)) discordFeed.unwant(e.senderFrame);
});

// Sound for the microphone (friends' voices, mixed, mono 48 kHz float32).
const partyWrite = (samples) => {
  try {
    if (!partyMix) partyMix = new Mix(path.join(dataDir, 'mix.bin'));
    partyMix.write(samples);
    return true;
  } catch {
    return false;
  }
};
ipcMain.on('party:mix', (_e, pcm) => {
  if (pcm instanceof ArrayBuffer && pcm.byteLength && pcm.byteLength % 4 === 0 && pcm.byteLength <= 4 * 48000) partyWrite(new Float32Array(pcm));
});
// A short two-tone signal into the microphone: proves the path to the module, by ear or by a recording.
ipcMain.handle('party:beep', () => {
  let sent = 0;
  const total = 48000 * 0.8, step = 960;
  const timer = setInterval(() => {
    const out = new Float32Array(step);
    for (let i = 0; i < step; i++) {
      const n = sent + i, t = n / 48000;
      const fade = Math.min(1, n / 960, (total - n) / 960);
      out[i] = 0.2 * Math.max(0, fade) * Math.sin(2 * Math.PI * (t < 0.4 ? 660 : 880) * t);
    }
    sent += step;
    if (!partyWrite(out) || sent >= total) clearInterval(timer);
  }, 20);
  return true;
});

/* ───── Start with Windows ───── */
ipcMain.handle('autostart:get', () => app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin);
ipcMain.handle('autostart:set', (_e, on) => {
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  refreshTray?.();
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
});
// Автозапуск из версий до 0.28 лежит под старым именем (autostart-legacy.js): он убирается, а выбор не меняется —
// была включена старая запись, а текущей нет, — включается текущая. Ошибки реестра запуску не мешают: в следующий раз ещё раз.
const { RUN_KEY, APPROVED_KEY, LEGACY_NAME, parseRegValues, legacyPlan } = require('./autostart-legacy.js');
function dropLegacyAutostart() {
  const reg = (args) => new Promise((resolve) => execFile('reg.exe', args, { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : out)));
  return Promise.all([reg(['query', RUN_KEY]), reg(['query', APPROVED_KEY])]).then(async ([run, approved]) => {
    if (run === null) return;
    const plan = legacyPlan({ run: parseRegValues(run), approved: parseRegValues(approved), exePath: process.execPath, currentName: APP_ID });
    if (!plan.removeRun) return;
    if (plan.enableCurrent) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    const removed = (await reg(['delete', RUN_KEY, '/v', LEGACY_NAME, '/f'])) !== null;
    if (removed && plan.removeApproved) await reg(['delete', APPROVED_KEY, '/v', LEGACY_NAME, '/f']);
    if (plan.enableCurrent) {
      refreshTray();
      command('autostart'); // переключатель в окне и пункт в core.txt — по новому состоянию
    }
  }).catch(() => {});
}

/* ───── Preset files ───── */
const presetFilter = [{ name: 'Пресет aura.txt', extensions: ['json'] }];
ipcMain.handle('preset:export', async (_e, preset) => {
  if (!preset || typeof preset !== 'object' || typeof preset.v !== 'object') return false;
  const safeName = String(preset.name || 'preset').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 40) || 'preset';
  const { canceled, filePath } = await dialog.showSaveDialog(win, { title: 'Сохранить пресет', defaultPath: `${safeName}.aura.json`, filters: presetFilter });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify({ app: 'aura', version: 2, name: String(preset.name || ''), v: preset.v, eq: preset.eq && typeof preset.eq === 'object' ? preset.eq : {} }, null, 2));
  return true;
});
ipcMain.handle('preset:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Загрузить пресет', filters: presetFilter, properties: ['openFile'] });
  if (canceled || !filePaths[0]) return null;
  try {
    if (fs.statSync(filePaths[0]).size > 20000) return { error: true };
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (data?.app !== 'aura' || !data.v || typeof data.v !== 'object') return { error: true };
    return { name: String(data.name || ''), v: data.v, eq: data.eq && typeof data.eq === 'object' ? data.eq : {} };
  } catch {
    return { error: true };
  }
});

/* ───── Tray ───── */
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
const command = (name, arg) => {
  if (win && !win.isDestroyed()) win.webContents.send('tray:command', name, arg);
};

function refreshTray() {
  if (!tray) return;
  tray.setImage(asset(ui.on && !ui.mute ? 'tray.png' : 'tray-off.png'));
  tray.setToolTip(ui.mute ? 'aura.txt — микрофон заглушён' : ui.on ? `aura.txt — ${ui.presetName}` : 'aura.txt — выключено');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть aura.txt', click: showWindow },
      { type: 'separator' },
      { label: 'Обработка голоса', type: 'checkbox', checked: ui.on, accelerator: hotkeys.power || undefined, registerAccelerator: false, click: () => command('power') },
      { label: 'Заглушить микрофон', type: 'checkbox', checked: ui.mute, enabled: ui.system, accelerator: hotkeys.mute || undefined, registerAccelerator: false, click: () => command('mute') },
      {
        label: 'Готовый звук',
        enabled: ui.presets.length > 0,
        submenu: ui.presets.map((p) => ({ label: p.name, type: 'radio', checked: p.id === ui.preset, click: () => command('preset', p.id) })),
      },
      {
        label: 'Эффект',
        enabled: ui.voices.length > 0,
        submenu: ui.voices.map((v) => ({ label: v.name, type: 'radio', checked: v.id === ui.voice, click: () => command('voice', v.id === ui.voice ? 'none' : v.id) })),
      },
      { type: 'separator' },
      // the same line every dev.txt app has in its tray menu: open the launcher, or fetch it
      { label: hub?.online || coreInstalled() ? 'Открыть core.txt' : 'Скачать core.txt', click: () => coreGo() },
      {
        label: 'Запускать вместе с Windows',
        type: 'checkbox',
        enabled: app.isPackaged, // only meaningful for the installed app
        checked: app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
          command('autostart'); // строка в окне и пункт в core.txt («Общие» → «Запуск и обновления») — по новому состоянию
        },
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  if (tray) return;
  tray = new Tray(asset('tray-off.png'));
  tray.on('click', showWindow);
  refreshTray();
}
function dropTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

/* ───── Одна семья с core.txt (kit.txt, hub/PROTOCOL.md, «Семья») ─────
 * Пока core.txt на связи и держит один значок на всех, своего значка нет: первые пункты меню aura.txt (aura.tray)
 * стоят в меню core.txt, горячие клавиши (aura.keys) — на его странице «Клавиши». Связь пропала — свой значок
 * возвращается сразу, с полным меню. Короткие сообщения человеку — на острове kapsula.txt, если он на связи. */
// Окну — «family»: строка «Выйти из aura.txt» в «Настройках» видна, только пока своего значка (и его «Выход») нет
const trayGate = new TrayGate((show) => {
  if (show) createTray();
  else dropTray();
  command('family');
});
const family = new Family('aura', () => {
  trayGate.set(family.hideOwnTray, family.coreOnline);
  command('family');
});
const trayActions = { show: showWindow, power: () => command('power'), mute: () => command('mute') };
const publishTray = () => family.setTray(auraTray(ui, trayActions));
function publishKeys() {
  if (keyConfig) family.setKeys(auraKeys(keyConfig, { voices: new Map(ui.voices.map((v) => [v.id, v.name])) }));
}
// Сообщение человеку: на острове kapsula.txt, если он на связи. Иначе своё: подсказка у своего значка, а когда значок
// у core.txt (или вот-вот уйдёт к нему вместе с подсказкой) — уведомление Windows.
// false — показать негде или сейчас нельзя (в core.txt включено «Не беспокоить»).
function tellUser(title, text) {
  const balloon = () => {
    tray.displayBalloon({ title, content: text, icon: asset('icon.png') });
    return true;
  };
  const own = () => {
    if (family.focus) return false;
    if (tray && !family.hideOwnTray) return balloon();
    return toast(title, text) || (!!tray && balloon());
  };
  return family.notify(title, text, true, own) || own();
}
// Уведомление Windows. Только у установленной копии: Windows показывает их от имени ярлыка установщика (setAppUserModelId выше).
let lastToast = null; // ссылка держит щелчок по уведомлению живым
function toast(title, text) {
  if (!app.isPackaged || !Notification.isSupported()) return false;
  lastToast = new Notification({ title, body: text, icon: asset('icon.png'), silent: true });
  lastToast.on('click', showWindow);
  lastToast.show();
  return true;
}

ipcMain.on('ui:state', (_e, state) => {
  if (!state || typeof state !== 'object') return;
  ui = {
    on: !!state.on,
    mute: !!state.mute,
    system: !!state.system,
    preset: String(state.preset || ''),
    presetName: String(state.presetName || ''),
    presets: Array.isArray(state.presets) ? state.presets.slice(0, 20).map((p) => ({ id: String(p.id), name: String(p.name) })) : [],
    voice: String(state.voice || 'none'),
    voices: Array.isArray(state.voices) ? state.voices.slice(0, 40).map((v) => ({ id: String(v.id), name: String(v.name) })) : [],
  };
  refreshTray();
  publishTray(); // галочки в меню core.txt — те же, что в своём
  publishKeys(); // названия голосов для aura.keys приходят отсюда
  // Other dev.txt apps see what the voice is doing (the island can show it, for example)
  hub?.state('aura.voice', { on: ui.on, mute: ui.mute, preset: ui.preset, presetName: ui.presetName, voice: ui.voice });
});

/* ───── core.txt hub ─────
 * core.txt (the dev.txt launcher) keeps a local hub on 127.0.0.1:42080. Through it Aura shows its
 * settings on the launcher's shared settings page, takes changes from there, and follows the
 * shared look (accent colour, reduced motion). The hub being absent is normal: the client keeps
 * trying quietly and Aura works on its own. The protocol is in kit.txt, hub/PROTOCOL.md;
 * hub-client.js is copied from there as is. */
const { connect: hubConnect } = require('./hub-client');
let hub = null;
let hubTheme = null;
let hubSeq = 0;
const hubWaiting = new Map(); // request id → { resolve, reject, timer }

// The settings live in the window, so a change is passed to it and answered from there.
// kind 'set' | 'run' — a setting (key, value); 'cmd' — a command (name, args), its data comes back as the result.
function askWindow(kind, key, value, ms = 4000) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('окно aura.txt закрыто'));
    const id = ++hubSeq;
    const timer = setTimeout(() => { hubWaiting.delete(id); reject(new Error('aura.txt не ответила')); }, ms);
    hubWaiting.set(id, { resolve, reject, timer });
    win.webContents.send('hub:command', id, kind, key, value);
  });
}
const askSetting = (kind, args) => askWindow(kind, String(args?.key || ''), args?.value);
// Звуки, эффекты и пати живут в окне; окно для этого не показывается. party.start ждёт сеть — дольше обычного.
const askCommand = (name, ms) => (args) => askWindow('cmd', name, args && typeof args === 'object' && !Array.isArray(args) ? args : {}, ms);
const HUB_STATES = new Set(['aura.sounds', 'aura.effects', 'aura.party']); // what the window may publish
function startHub() {
  // family.wrap() добавляет к темам core.family и hub.apps, к командам — tray.run (пункты aura.txt в меню core.txt)
  hub = hubConnect(family.wrap({
    app: 'aura',
    name: 'aura.txt',
    version: app.getVersion(),
    port: Number(process.env.AURA_HUB_PORT) || undefined, // tests: a spare hub beside the real launcher
    topics: ['hub.theme'],
    commands: {
      'settings.set': (args) => askSetting('set', args),
      'settings.run': (args) => askSetting('run', args),
      'sounds.play': askCommand('sounds.play'),
      'sounds.stop': askCommand('sounds.stop'),
      'effects.set': askCommand('effects.set'),
      'effects.off': askCommand('effects.off'),
      'party.start': askCommand('party.start', 30000),
      'party.stop': askCommand('party.stop'),
      'party.answer': askCommand('party.answer'),
      'party.discord': askCommand('party.discord'),
      'party.site': askCommand('party.site'),
      // core.txt открывает окно; со страницей «keys» — сразу на горячих клавишах
      show: (args) => {
        showWindow();
        if (args?.page === 'keys' || args?.page === 'party') command('page', args.page);
        return null;
      },
      // «Закрыть» в трее core.txt: пока значок держит core.txt, это выход из aura.txt
      quit: () => {
        quitting = true;
        setTimeout(() => app.quit(), 0);   // сначала ответ хабу, потом выход
        return null;
      },
    },
    onState(topic, data) {
      if (topic !== 'hub.theme') return;
      hubTheme = data;
      win?.webContents.send('hub:theme', data);
    },
  }));
  family.attach(hub);
  publishTray();
}
ipcMain.on('hub:settings', (_e, settings) => {
  if (settings && typeof settings === 'object') hub?.state('aura.settings', settings);
});
ipcMain.on('hub:state', (_e, topic, data) => {
  if (HUB_STATES.has(topic) && data && typeof data === 'object' && !Array.isArray(data)) hub?.state(topic, data);
});
ipcMain.on('hub:result', (_e, id, ok, error, data) => {
  const w = hubWaiting.get(id);
  if (!w) return;
  hubWaiting.delete(id);
  clearTimeout(w.timer);
  if (ok) w.resolve(data === undefined ? null : data); else w.reject(new Error(String(error || 'не получилось')));
});
ipcMain.handle('hub:theme', () => hubTheme);

/* The way to core.txt, the dev.txt launcher: open it, or fetch it when it is not on this computer.
 * Every dev.txt app carries this in one quiet place (kit.txt, hub/CoreApp.cs is the same thing for C#). */
const CORE_URL = 'https://github.com/cxxperman/core.txt/releases/latest/download/Core.exe';
const corePath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'dev.txt', 'Core.exe');
const coreInstalled = () => { try { return fs.existsSync(corePath); } catch { return false; } };
// quitHere — значок aura.txt сейчас у core.txt, своего меню с «Выход» нет: выход — кнопкой в «Настройках»
ipcMain.handle('core:info', () => ({ online: !!hub?.online, installed: coreInstalled(), quitHere: !devRun && !tray && family.hideOwnTray }));
ipcMain.handle('app:quit', () => {
  quitting = true;
  app.quit();
  return true;
});
// page — какую страницу core.txt открыть («general» — «Общие», где «Запуск и обновления»): запущенному — просьбой show,
// не запущенному — ключом --page (прежний core.txt незнакомую страницу пропускает и просто открывается)
async function coreGo(page) {
  if (hub?.online) { await hub.command('core', 'show', page ? { page } : null); return; }
  if (coreInstalled()) { spawn(corePath, page ? ['--page', page] : [], { detached: true, stdio: 'ignore' }).unref(); return; }
  await shell.openExternal(CORE_URL);
}
ipcMain.handle('core:go', (_e, page) => coreGo(typeof page === 'string' && /^(general|games|keys)$/.test(page) ? page : null));

/* ───── System module (APO) ───── */
const dataDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Aura');
const binDir = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, 'native', 'bin');
const installedDll = path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'Aura', 'AuraAPO.dll');

// The module's live meters: status.txt is rewritten ~8 times a second while it runs.
ipcMain.handle('system:levels', () => {
  try {
    const file = path.join(dataDir, 'status.txt');
    if (Date.now() - fs.statSync(file).mtimeMs > 1500) return null;
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = Number(line.slice(eq + 1));
    }
    return out;
  } catch {
    return null;
  }
});

// Windows and driver updates can wipe a microphone's effect slot. The DLL is then still on disk
// but nothing runs it; notice that, so the window can offer to attach it again.
let attached = null; // unknown until the first check
function checkAttached() {
  const reg = (args) => new Promise((resolve) => execFile('reg.exe', ['query', ...args], { windowsHide: true }, (err, out) => resolve(err ? '' : out)));
  return reg(['HKLM\\SOFTWARE\\Aura', '/v', 'Device', '/reg:64']).then(async (out) => {
    const guid = /\{[0-9a-fA-F-]{36}\}/.exec(out)?.[0];
    if (!guid) return (attached = null);
    const slot = await reg([`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture\\${guid}\\FxProperties`, '/v', '{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},2', '/reg:64']);
    attached = /7C1D5A62-3F0E-4B7A-9E2B-A0D3C4F51E88/i.test(slot);
  });
}

// Picking the high-quality engine again clears the "it crashed last time" marker the module leaves behind.
ipcMain.handle('system:reset-deep', () => {
  try {
    fs.rmSync(path.join(dataDir, 'deep.loading'), { force: true });
  } catch {}
  return true;
});

// After an update the window is new but the module inside the microphone is still the old file:
// compare the installed one with the one shipped in this version (size first, then contents).
let outdatedMemo = { key: '', value: false };
function moduleOutdated() {
  try {
    const shipped = path.join(binDir, 'AuraAPO.dll');
    const a = fs.statSync(shipped), b = fs.statSync(installedDll);
    const key = `${a.size}:${a.mtimeMs}:${b.size}:${b.mtimeMs}`;
    if (outdatedMemo.key !== key) {
      const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      outdatedMemo = { key, value: a.size !== b.size || hash(shipped) !== hash(installedDll) };
    }
    return outdatedMemo.value;
  } catch {
    return false;
  }
}

/* ───── Updates ─────
 * Releases of the project's own GitHub repository are the only source. The window asks, the
 * user decides; nothing is downloaded or installed without a click. */
const UPDATE_REPO = 'cxxperman/aura.txt';
// The repository's earlier name: GitHub may still hand out links under it, and they are just as much ours.
const UPDATE_REPOS = [UPDATE_REPO, 'cxxperman/aura-voice'];
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
let pendingUpdate = null;
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return null;
  try {
    const res = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`, { headers: { 'User-Agent': `AuraVoice/${app.getVersion()}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    let best = null;
    for (const rel of await res.json()) {
      if (rel.draft) continue;
      for (const asset of rel.assets || []) {
        const m = /^Aura-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(asset.name || '');
        const url = String(asset.browser_download_url || '');
        if (!m || !UPDATE_REPOS.some((repo) => url.startsWith(`https://github.com/${repo}/releases/download/`))) continue;
        if (newer(m[1], app.getVersion()) && (!best || newer(m[1], best.version))) {
          best = { version: m[1], url, size: Number(asset.size) || 0, digest: typeof asset.digest === 'string' ? asset.digest : '' };
        }
      }
    }
    pendingUpdate = best;
    return best ? { version: best.version, megabytes: Math.round(best.size / 1e6) } : null;
  } catch {
    return null;
  }
});
ipcMain.handle('update:install', async () => {
  const u = pendingUpdate;
  if (!u) return false;
  try {
    const res = await net.fetch(u.url, { headers: { 'User-Agent': `AuraVoice/${app.getVersion()}` } });
    if (!res.ok) return false;
    const data = Buffer.from(await res.arrayBuffer());
    // What arrived must be what the release lists: its size, and its SHA-256 when GitHub gives one.
    if (u.size && data.length !== u.size) return false;
    if (u.digest.startsWith('sha256:') && crypto.createHash('sha256').update(data).digest('hex') !== u.digest.slice(7).toLowerCase()) return false;
    const file = path.join(app.getPath('temp'), `Aura-Setup-${u.version}.exe`);
    fs.writeFileSync(file, data);
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.exit(0), 300);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('system:status', () => {
  const status = {
    available: fs.existsSync(path.join(binDir, 'AuraSetup.exe')) && fs.existsSync(path.join(binDir, 'AuraAPO.dll')),
    installed: fs.existsSync(installedDll),
    visible: !!win && win.isVisible() && !win.isMinimized(),
    alive: false,
  };
  status.detached = status.installed && attached === false;
  status.outdated = status.installed && moduleOutdated();
  try {
    // The module rewrites status.txt once a second while Windows is running it.
    status.alive = Date.now() - fs.statSync(path.join(dataDir, 'status.txt')).mtimeMs < 3000;
  } catch {}
  return status;
});

ipcMain.handle('system:write', (_e, text) => {
  if (devRun && !probeMode) return false; // a screenshot run must not change what the live module is doing
  if (typeof text !== 'string' || text.length > 2000) return false;
  try {
    // Write-then-rename, so the module never reads a half-written file.
    const tmp = path.join(dataDir, 'settings.tmp');
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(dataDir, 'settings.txt'));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('system:setup', (_e, action, unprotect, device) => {
  if (action !== 'install' && action !== 'uninstall') return { ok: false, lines: [] };
  const log = path.join(dataDir, 'setup.log');
  try { fs.rmSync(log, { force: true }); } catch {}
  const quote = (v) => `'${v.replace(/'/g, "''")}'`;
  const guid = typeof device === 'string' && /^\{[0-9a-fA-F-]{36}\}$/.test(device) ? device : null;
  const args = action === 'install' ? ["'install'", ...(unprotect ? ["'--unprotect'"] : []), ...(guid ? ["'--device'", quote(guid)] : [])].join(',') : quote(action);
  const command = `Start-Process -FilePath ${quote(path.join(binDir, 'AuraSetup.exe'))} -ArgumentList ${args} -Verb RunAs -Wait -WindowStyle Hidden`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (err) => {
      let lines = [];
      try { lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
      const ok = lines[0] === 'result=ok';
      checkAttached();
      resolve({ ok, cancelled: !!err && !lines.length, lines: lines.slice(1).filter((l) => !l.startsWith('device=')) });
    });
  });
});

app.whenReady().then(() => {
  // Only our own local page is ever loaded, so microphone / output selection is granted.
  const allowed = new Set(['media', 'speaker-selection', 'audioCapture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  createWindow();
  if (!devRun) startHub();
  checkAttached();
  setInterval(checkAttached, 60000);
  if (!devRun) {
    // The party window's sound, and only it, is what the main window may capture.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      if (partyWin && !partyWin.isDestroyed()) callback({ video: partyWin.webContents.mainFrame, audio: partyWin.webContents.mainFrame });
      else callback({});
    });
    // core.txt стоит на этом компьютере — до трёх секунд ждём, не возьмёт ли он значок: так при входе в Windows значок
    // aura.txt не мелькает. Не ответил — свой значок появляется: без входа aura.txt не остаётся.
    trayGate.start(coreInstalled() ? 3000 : 0);
  // Start with Windows, in the tray, unless the user says otherwise. The choice is made once, on
  // the first run of an installed copy; after that the switch in Settings (or the tray) decides.
  const asked = path.join(app.getPath('userData'), 'autostart.set');
  if (app.isPackaged && !fs.existsSync(asked)) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    try { fs.writeFileSync(asked, '1'); } catch {}
  }
  if (app.isPackaged && process.platform === 'win32') dropLegacyAutostart();
    // Work from inside a game, without alt-tabbing to the window.
    globalShortcut.register(HOTKEY_POWER, () => command('power'));
    globalShortcut.register(HOTKEY_MUTE, () => command('mute'));
    // Soundpad-style: the first nine pads from anywhere.
    for (let i = 0; i < 9; i++) globalShortcut.register(`Ctrl+Alt+${i + 1}`, () => command('pad', i));
  }
});

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
  trayGate.stop(); // связь сейчас закроется — свой значок из-за этого уже не появляется
  discordStop(); // захват звука Discord — свой процесс AuraCapture, его не оставлять
  hub?.close(); // says goodbye, so the launcher drops Aura's settings at once
});

app.on('window-all-closed', () => app.quit());
