// Проверка проводки main.js без Electron: main.js грузится обычным node с поддельным модулем electron и поддельным
// child_process — ни настоящего значка, окна, сочетаний клавиш, уведомлений, реестра, ни запуска программ. Связь —
// с образцовым хабом kit.txt на свободном порту (не 42080 настоящего core.txt). Папки данных временные: настоящие
// настройки aura.txt и модуля в микрофоне (%ProgramData%\Aura) не трогаются.
//   node scripts/main-test.js --hub <kit.txt>/hub/hub.js                  все случаи, каждый в своём процессе
//   node scripts/main-test.js --hub <kit.txt>/hub/hub.js --case installed   один: absent | installed | packaged
// Без --hub ищет kit.txt рядом (переменная KIT_HUB, ../kit.txt, ../kit, ../../kit).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
};
const CASES = ['absent', 'installed', 'packaged'];
const hubJs = [arg('--hub'), process.env.KIT_HUB, '../kit.txt/hub/hub.js', '../kit/hub/hub.js', '../../kit/hub/hub.js']
  .filter(Boolean)
  .map((p) => path.resolve(repo, p))
  .find((p) => fs.existsSync(p));
const only = arg('--case');

if (!hubJs) {
  console.log('не проверялось: нет образцового хаба — укажите --hub <kit.txt>/hub/hub.js');
  process.exit(1);
}
if (!only) {
  // Каждый случай — в своём процессе: main.js держит своё состояние в модуле
  let bad = 0;
  for (const c of CASES) {
    console.log('── ' + c);
    const r = spawnSync(process.execPath, [__filename, '--hub', hubJs, '--case', c], { stdio: 'inherit', timeout: 120000 });
    if (r.status !== 0) bad++;
  }
  console.log(bad ? 'НЕ ПРОШЛО случаев: ' + bad : 'всё прошло · случаев: ' + CASES.length);
  process.exit(bad ? 1 : 0);
}
if (!CASES.includes(only)) {
  console.log('незнакомый случай: ' + only);
  process.exit(1);
}

// ───── Временные папки вместо настоящих ─────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-main-test-'));
const userData = path.join(tmp, 'userData');
fs.mkdirSync(userData, { recursive: true });
process.env.LOCALAPPDATA = path.join(tmp, 'local');
process.env.ProgramData = path.join(tmp, 'programdata');
process.resourcesPath = path.join(tmp, 'resources'); // установленная копия берёт модуль отсюда (здесь его нет)
const installed = only !== 'absent';
const packaged = only === 'packaged';
if (installed) {
  fs.mkdirSync(path.join(process.env.LOCALAPPDATA, 'Programs', 'dev.txt'), { recursive: true });
  fs.writeFileSync(path.join(process.env.LOCALAPPDATA, 'Programs', 'dev.txt', 'Core.exe'), ''); // пустой файл: только «установлен»
}
process.argv = [process.argv[0], path.join(repo, 'main.js')]; // main.js читает ключи из argv: без ключей — обычный запуск

let failed = 0, passed = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) passed++;
  else {
    failed++;
    console.log('FAIL ' + name + '\n  получено:  ' + a + '\n  ожидалось: ' + b);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms) => {
  for (let t = 0; t < (ms || 4000); t += 20) {
    if (test()) return true;
    await wait(20);
  }
  return false;
};

// ───── Поддельный Electron ─────
const handles = {}, listeners = {}, appOn = {}, trays = [], balloons = [], toasts = [], wins = [], shortcuts = new Map(), opened = [], spawned = [];
const calls = { quit: 0, aumid: [], login: [], windowAfterAumid: null };
const taken = new Set(['Ctrl+Alt+R']); // будто это сочетание заняла другая программа
let loginOn = false;
class FakeTray {
  constructor(image) { this.image = image; this.destroyed = false; this.on_ = {}; trays.push(this); }
  on(ev, fn) { this.on_[ev] = fn; }
  setImage(i) { this.image = i; }
  setToolTip(t) { this.tip = t; }
  setContextMenu(m) { this.menu = m; }
  displayBalloon(o) { balloons.push(o); }
  destroy() { this.destroyed = true; }
}
class FakeNotification {
  constructor(o) { this.o = o; this.on_ = {}; }
  static isSupported() { return true; }
  on(ev, fn) { this.on_[ev] = fn; }
  show() { toasts.push(this); }
}
class FakeWindow {
  constructor(options) {
    this.options = options || {}; this.url = '';
    this.visible = this.options.show !== false && !!this.options.webPreferences?.session; this.minimized = false; this.destroyed = false; this.handlers = {}; this.sent = [];
    this.webContents = { send: (...a) => this.sent.push(a), once() {}, on() {}, setZoomFactor() {}, executeJavaScript: async () => null, setWindowOpenHandler() {}, getURL: () => this.url, getTitle: () => '' };
    wins.push(this);
    if (calls.windowAfterAumid === null) calls.windowAfterAumid = calls.aumid.length > 0;
  }
  removeMenu() {} setMinimumSize() {} setContentSize() {} loadFile() {}
  loadURL(u) { this.url = u; } getBounds() { return { x: 10, y: 20, width: 900, height: 700 }; } // окно пати
  close() { this.destroy(); } destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  once(ev, fn) { if (ev === 'ready-to-show') this.ready = fn; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
  isVisible() { return this.visible; } isMinimized() { return this.minimized; }
  show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; this.emit('hide'); }
  focus() {} restore() { this.minimized = false; } isDestroyed() { return this.destroyed; }
}
const electron = {
  app: {
    commandLine: { appendSwitch() {} }, setPath() {}, getPath: () => userData, disableHardwareAcceleration() {},
    requestSingleInstanceLock: () => true, exit() {}, whenReady: () => Promise.resolve(),
    quit() { calls.quit++; if (appOn['before-quit']) appOn['before-quit'](); }, // как в Electron: сначала before-quit
    on(ev, fn) { appOn[ev] = fn; }, getVersion: () => '0.0.0-test', isPackaged: packaged,
    setAppUserModelId(id) { calls.aumid.push(id); },
    getLoginItemSettings: () => ({ openAtLogin: loginOn }),
    setLoginItemSettings(o) { calls.login.push(o); loginOn = !!o.openAtLogin; },
  },
  BrowserWindow: FakeWindow,
  session: {
    defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {} },
    fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, clearStorageData: async () => {}, clearCache: async () => {} }), // окно пати
  },
  ipcMain: { handle(ch, fn) { handles[ch] = fn; }, on(ch, fn) { listeners[ch] = fn; } },
  Tray: FakeTray,
  Menu: { buildFromTemplate: (t) => t },
  Notification: FakeNotification,
  globalShortcut: { register(a, fn) { shortcuts.set(a, fn); return !taken.has(a); }, unregisterAll() { shortcuts.clear(); } },
  dialog: {}, shell: { openExternal: async (u) => opened.push(u) }, nativeTheme: {},
  net: { fetch: async () => { throw new Error('без сети'); } }, utilityProcess: { fork() { throw new Error('без процессов'); } },
};
// «Пати через Discord»: будто AuraCapture.exe на месте и Discord запущен — только когда случай этого просит
const fake = { capture: false, discord: false };
const children = [];
// Реестр автозапуска (только случай packaged): старая запись «electron.app.Aura» на эту программу, текущей нет
const regCalls = [];
const regRun = packaged ? `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Steam    REG_SZ    "C:\\Steam\\steam.exe" -silent\r\n    electron.app.Aura    REG_SZ    "${process.execPath}" --hidden\r\n\r\n` : '';
const regApproved = packaged ? '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run\r\n    electron.app.Aura    REG_BINARY    020000000000000000000000\r\n\r\n' : '';
const { EventEmitter } = require('events');
const childProcess = {
  execFile(cmd, args, opts, cb) {
    const done = cb || opts;
    const name = path.basename(cmd).toLowerCase();
    if (name === 'reg.exe' && args[1] && /CurrentVersion\\(Explorer\\StartupApproved\\)?Run$/.test(args[1])) {
      regCalls.push(args.join(' '));
      if (!packaged) return setImmediate(() => done(new Error('заглушка'), ''));
      if (args[0] === 'query') return setImmediate(() => done(null, /StartupApproved/.test(args[1]) ? regApproved : regRun));
      return setImmediate(() => done(null, 'The operation completed successfully.\r\n'));
    }
    if (fake.discord && name === 'tasklist.exe') return setImmediate(() => done(null, '"Discord.exe","5100","Console","1","90 K"\r\n"Discord.exe","5200","Console","1","90 K"\r\n'));
    if (fake.discord && name === 'powershell.exe' && /Win32_Process/.test(String(args))) return setImmediate(() => done(null, JSON.stringify([{ ProcessId: 5200, ParentProcessId: 5100, Name: 'Discord.exe' }, { ProcessId: 5100, ParentProcessId: 4000, Name: 'Discord.exe' }])));
    setImmediate(() => done(new Error('заглушка'), ''));
  },
  spawn(cmd, args) {
    spawned.push([path.basename(cmd)].concat(args || []));
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.unref = () => {};
    c.kill = () => { if (c.killed) return; c.killed = true; setImmediate(() => c.emit('exit', null)); };
    children.push(c);
    return c;
  },
};
const fakeFs = Object.assign(Object.create(fs), { existsSync: (p) => (fake.capture && /AuraCapture\.exe$/i.test(String(p))) || fs.existsSync(p) });
const load = Module._load;
Module._load = function (request, parent) {
  if (request === 'electron') return electron;
  const fromMain = parent && path.resolve(parent.filename) === path.resolve(repo, 'main.js');
  if (request === 'child_process' && fromMain) return childProcess;
  if (request === 'fs' && fromMain) return fakeFs;
  return load.apply(this, arguments);
};

(async () => {
  const server = await require(hubJs).start({ port: 0 });
  if (server.port === 42080) throw new Error('это порт настоящего core.txt');
  process.env.AURA_HUB_PORT = String(server.port);
  const { connect } = require(path.join(repo, 'hub-client.js'));
  const started = Date.now();
  require(path.join(repo, 'main.js'));
  await wait(50); // whenReady: окно, хаб, значок
  const win = wins[0];
  const flag = path.join(userData, 'tray-hint-shown');
  const closeWindow = () => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    win.visible = true;
    win.emit('close', e);
    return e.prevented;
  };
  const sentNames = () => win.sent.filter((s) => s[0] === 'tray:command').map((s) => s.slice(1).filter((x) => x !== undefined && x !== null).join(':'));
  const familyPushes = () => sentNames().filter((x) => x === 'family').length;
  const info = () => handles['core:info'](); // отвечает сразу, без ожидания
  const coreLink = (seen, shows) => connect({
    app: 'core', name: 'core.txt', port: server.port, topics: ['aura.*'],
    commands: { show: (a) => { if (shows) shows.push(a); return null; }, 'focus.set': () => null },
    onState: (t, d) => { if (seen) seen[t] = d; },
  });
  let serverUp = true;
  const stopServer = async () => {
    if (!serverUp) return;
    serverUp = false;
    await server.stop().catch(() => {});
  };
  const finish = async () => {
    await stopServer();
    console.log((failed ? 'НЕ ПРОШЛО: ' + failed : 'всё прошло') + ' · проверок: ' + (passed + failed));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(failed ? 1 : 0);
  };

  // ───────── core.txt не установлен ─────────
  if (only === 'absent') {
    eq('id ярлыка — только у установленной копии', calls.aumid, []);
    eq('core.txt нет: свой значок сразу', [trays.length, trays[0] && trays[0].destroyed], [1, false]);
    await until(() => info().online, 2000);
    eq('core:info без core.txt', info(), { online: true, installed: false, quitHere: false });
    await wait(2000);
    eq('core.txt нет: значок остаётся', [trays.length, trays[0].destroyed], [1, false]);
    const shows = [];
    const core = coreLink(null, shows); // core.txt, запущенный не из своей папки
    await until(() => core.online);
    core.state('core.family', { tray: true });
    await wait(1200);
    eq('core.txt взял значок: свой ещё есть', trays[0].destroyed, false);
    await until(() => trays[0].destroyed, 1000);
    eq('...и убран через ~1,5 с', trays[0].destroyed, true);
    eq('значок у core.txt: окно узнало, выход — в «Настройках»', [sentNames().slice(-1)[0], info().quitHere], ['family', true]);
    core.state('core.family', { tray: false });
    await until(() => trays.length === 2, 1000);
    eq('core.txt отдал значок: свой сразу', [trays.length, trays[1].destroyed, info().quitHere], [2, false, false]);
    await handles['core:go']({}, 'general');
    eq('core:go: запущенному core.txt — show со страницей', shows.slice(-1), [{ page: 'general' }]);
    core.close();
    await stopServer();
    await until(() => !info().online, 3000);
    await handles['core:go']({}, 'general');
    eq('core:go без core.txt — скачать', [opened.slice(-1)[0], spawned.length], ['https://github.com/cxxperman/core.txt/releases/latest/download/Core.exe', 0]);
    eq('без core.txt своё уведомление Windows не нужно', toasts.length, 0);
    appOn['before-quit']();
    return finish();
  }

  // ───────── установленная копия: id ярлыка, уведомление Windows ─────────
  if (only === 'packaged') {
    const hint = ['aura.txt работает в фоне', 'Голос продолжает обрабатываться. Окно открывается из меню core.txt в трее, а выйти можно в «Настройках».', true];
    eq('id ярлыка — до окна', [calls.aumid, calls.windowAfterAumid], [['app.aura.voice'], true]);
    eq('первый запуск установленной: автозапуск включён', calls.login.slice(0, 1), [{ openAtLogin: true, args: ['--hidden'] }]);
    eq('...и запомнено во временной папке', fs.existsSync(path.join(userData, 'autostart.set')), true);
    await until(() => regCalls.length >= 4, 2000);
    const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
    eq('старая запись автозапуска убрана — и её отметка в StartupApproved', regCalls, ['query ' + RUN, 'query ' + APPROVED, `delete ${RUN} /v electron.app.Aura /f`, `delete ${APPROVED} /v electron.app.Aura /f`]);
    eq('...а текущая включена', calls.login.slice(1), [{ openAtLogin: true, args: ['--hidden'] }]);
    const seen = {};
    const core = coreLink(seen);
    await until(() => core.online);
    await until(() => trays.length === 1, 4000); // core.txt на связи, но о значке молчит
    eq('core.txt молчит о значке: свой через ~3 с', trays.length, 1);
    core.state('core.family', { tray: true, focus: false, focusUntil: 0, game: false, gameApp: '' });
    await wait(150);
    eq('значок уходит к core.txt: окно закрывается', closeWindow(), true);
    eq('подсказка — не у уходящего значка, а уведомлением Windows', [balloons.length, toasts.map((t) => [t.o.title, t.o.body, t.o.silent])], [0, [hint]]);
    eq('...и отмечено', fs.existsSync(flag), true);
    fs.rmSync(flag);
    await until(() => trays[0].destroyed, 2000);
    eq('core:info: значок у core.txt, выход — в «Настройках»', [trays[0].destroyed, info()], [true, { online: true, installed: true, quitHere: true }]);
    core.state('core.family', { tray: true, focus: true, focusUntil: 0, game: false, gameApp: '' });
    await wait(150);
    eq('«Не беспокоить»: окно закрывается', closeWindow(), true);
    eq('«Не беспокоить»: ни уведомления, ни отметки', [toasts.length, balloons.length, fs.existsSync(flag)], [1, 0, false]);
    core.state('core.family', { tray: true, focus: false, focusUntil: 0, game: false, gameApp: '' });
    await wait(150);
    closeWindow();
    eq('нет ни острова, ни своего значка: уведомление Windows', [toasts.length, [toasts[1].o.title, toasts[1].o.body, toasts[1].o.silent], fs.existsSync(flag)], [2, hint, true]);
    win.visible = false;
    toasts[1].on_.click();
    eq('щелчок по уведомлению открывает окно', win.visible, true);
    await handles['app:quit']();
    eq('«Выйти» из окна: выход', [calls.quit, closeWindow()], [1, false]);
    core.close();
    await wait(300);
    eq('после выхода значок не появляется', trays.length, 1);
    return finish();
  }

  // ───────── core.txt установлен, копия не установленная ─────────
  eq('id ярлыка — только у установленной копии', calls.aumid, []);
  eq('core.txt установлен: сначала своего значка нет', trays.length, 0);
  eq('...и выход пока не в окне', info().quitHere, false);
  await until(() => trays.length > 0, 4000);
  const shownAfter = Date.now() - started;
  eq('core.txt молчит: свой значок через ~3 с', [trays.length, shownAfter >= 2800 && shownAfter < 3900], [1, true]);
  const own = trays[0];
  eq('своё меню — полное', own.menu.map((i) => i.label || i.type), ['Открыть aura.txt', 'separator', 'Обработка голоса', 'Заглушить микрофон', 'Готовый звук', 'Эффект', 'separator', 'Открыть core.txt', 'Запускать вместе с Windows', 'separator', 'Выход']);
  own.menu.find((i) => i.label === 'Запускать вместе с Windows').click({ checked: true });
  eq('автозапуск из меню значка: окно перечитывает', [calls.login.slice(-1)[0], sentNames().slice(-1)[0]], [{ openAtLogin: true, args: ['--hidden'] }, 'autostart']);

  // окно сообщает клавиши и состояние, как при своём запуске
  const failedKeys = await handles['hotkeys:set']({}, { power: 'Ctrl+Shift+F9', mute: 'Ctrl+Shift+F10', pads: [null, 'Ctrl+Alt+Q'], padNames: ['Бонк', 'Сирена'], voices: [['robot', 'Ctrl+Alt+R']] });
  eq('hotkeys:set: не занялись', failedKeys, ['Ctrl+Alt+R']);
  eq('hotkeys:set: занятые', [...shortcuts.keys()], ['Ctrl+Shift+F9', 'Ctrl+Shift+F10', 'Ctrl+Alt+R', 'Ctrl+Alt+Q', 'Ctrl+Alt+1']);
  shortcuts.get('Ctrl+Alt+Q')();
  shortcuts.get('Ctrl+Alt+R')();
  shortcuts.get('Ctrl+Shift+F9')();
  eq('клавиши доходят до окна', sentNames().slice(-3), ['pad:1', 'voice:robot', 'power']);
  const ui = (o) => listeners['ui:state']({}, Object.assign({ on: true, mute: false, system: true, preset: 'studio', presetName: 'Подкаст', presets: [{ id: 'studio', name: 'Подкаст' }], voice: 'none', voices: [{ id: 'none', name: 'Обычный голос' }, { id: 'robot', name: 'Робот' }] }, o));
  ui({});
  eq('свой значок следует за окном', [own.tip, own.menu[2].checked], ['aura.txt — Подкаст', true]);

  // core.txt приходит и берёт один значок на всех
  const seen = {}, coreShow = [];
  let core = coreLink(seen, coreShow);
  await until(() => core.online);
  core.state('core.family', { tray: true, focus: false, focusUntil: 0, game: false, gameApp: '' });
  await until(() => seen['aura.tray'] && seen['aura.keys'] && seen['aura.voice']);
  eq('aura.tray', seen['aura.tray'], { items: [{ key: 'show', label: 'Открыть' }, { key: 'power', label: 'Обработка голоса', check: true }, { key: 'mute', label: 'Заглушить микрофон', check: false }] });
  eq('aura.keys', seen['aura.keys'].keys, [
    { id: 'power', label: 'Обработка голоса', keys: 'Ctrl+Shift+F9', on: true },
    { id: 'mute', label: 'Заглушить микрофон', keys: 'Ctrl+Shift+F10', on: true },
    { id: 'voice.robot', label: 'Эффект «Робот»', keys: 'Ctrl+Alt+R', on: true },
    { id: 'pad.0', label: 'Звук «Бонк»', keys: 'Ctrl+Alt+1', on: true },
    { id: 'pad.1', label: 'Звук «Сирена»', keys: 'Ctrl+Alt+Q', on: true },
  ]);
  await wait(1000);
  eq('через 1 с после core.txt свой значок ещё есть, выход — в его меню', [own.destroyed, info().quitHere], [false, false]);
  await until(() => own.destroyed, 1500);
  eq('через ~1,5 с свой значок убран', own.destroyed, true);
  eq('окно узнало: выход — в «Настройках»', [sentNames().slice(-1)[0], info().quitHere], ['family', true]);

  // общее меню core.txt управляет aura.txt
  eq('tray.run power', await core.command('aura', 'tray.run', { key: 'power' }), { ok: true, data: null });
  eq('tray.run mute', await core.command('aura', 'tray.run', { key: 'mute' }), { ok: true, data: null });
  eq('tray.run дошли до окна', sentNames().filter((x) => x !== 'family').slice(-2), ['power', 'mute']);
  ui({ on: false, system: false });
  await until(() => seen['aura.tray'].items[2].enabled === false);
  eq('aura.tray заново', seen['aura.tray'].items.slice(1), [{ key: 'power', label: 'Обработка голоса', check: false }, { key: 'mute', label: 'Заглушить микрофон', check: false, enabled: false }]);
  const r = await core.command('aura', 'tray.run', { key: 'mute' });
  eq('tray.run: недоступный пункт', [r.ok, r.error], [false, 'пункт сейчас недоступен']);
  win.visible = false;
  eq('tray.run show', await core.command('aura', 'tray.run', { key: 'show' }), { ok: true, data: null });
  eq('окно открыто', win.visible, true);
  win.visible = false;
  await core.command('aura', 'show', { page: 'keys' });
  eq('show {page: keys}', [win.visible, sentNames().slice(-1)[0]], [true, 'page:keys']);
  const n = win.sent.length;
  await core.command('aura', 'show', {});
  eq('show без страницы — без page', win.sent.slice(n).some((s) => s[1] === 'page'), false);

  // звуки, эффекты и пати: команды идут в окно (оно не показывается), ответ окна с data — результат; состояния — из окна
  const maskaSeen = {};
  const maska = connect({ app: 'maska', name: 'Maska', port: server.port, topics: ['hub.apps', 'aura.*'], onState: (t, d) => { maskaSeen[t] = d; } });
  await until(() => maska.online && maskaSeen['hub.apps']);
  const NEW_COMMANDS = ['sounds.play', 'sounds.stop', 'effects.set', 'effects.off', 'party.start', 'party.stop', 'party.answer', 'party.discord', 'party.site'];
  const auraApp = (maskaSeen['hub.apps'] || []).find((a) => a.app === 'aura');
  eq('hub.apps: aura умеет звуки, эффекты, пати', NEW_COMMANDS.filter((c) => auraApp && auraApp.commands.includes(c)), NEW_COMMANDS);
  const asked = [];
  let reply = null; // (kind, key, value) → аргументы hub:result после id: ok, error, data
  const send = win.webContents.send;
  win.webContents.send = (...a) => {
    send(...a);
    if (a[0] !== 'hub:command') return;
    asked.push(a.slice(2));
    if (reply) setImmediate(() => listeners['hub:result']({}, a[1], ...reply(a[2], a[3], a[4])));
  };
  win.visible = false;
  reply = (kind, key) => [true, null, key === 'party.start' ? { code: 'ABCD-EFGH' } : undefined];
  eq('party.start: data окна — результат', await maska.command('aura', 'party.start', {}), { ok: true, data: { code: 'ABCD-EFGH' } });
  eq('sounds.play: без data — null', await maska.command('aura', 'sounds.play', { id: 'p1' }), { ok: true, data: null });
  eq('...до окна дошли имя и args', asked.slice(-1), [['cmd', 'sounds.play', { id: 'p1' }]]);
  eq('party.discord: до окна, data null', [await maska.command('aura', 'party.discord', { on: true }), asked.slice(-1)], [{ ok: true, data: null }, [['cmd', 'party.discord', { on: true }]]]);
  eq('party.discord с where: до окна как есть', [await maska.command('aura', 'party.discord', { on: true, where: 'browser' }), asked.slice(-1)], [{ ok: true, data: null }, [['cmd', 'party.discord', { on: true, where: 'browser' }]]]);
  eq('party.site: до окна, data null', [await maska.command('aura', 'party.site', { open: true, url: 'example.com' }), asked.slice(-1)], [{ ok: true, data: null }, [['cmd', 'party.site', { open: true, url: 'example.com' }]]]);
  await maska.command('aura', 'effects.off');
  eq('без args — пустой объект', asked.slice(-1), [['cmd', 'effects.off', {}]]);
  eq('settings.set по-прежнему: key, value, data null', [await maska.command('aura', 'settings.set', { key: 'auto', value: true }), asked.slice(-1)], [{ ok: true, data: null }, [['set', 'auto', true]]]);
  eq('окно не показано', win.visible, false);
  reply = () => [false, 'такого звука нет'];
  const bad = await maska.command('aura', 'sounds.play', { id: 'нет' });
  eq('ошибка окна — ok: false с текстом', [bad.ok, bad.error], [false, 'такого звука нет']);
  reply = null;
  win.webContents.send = send;
  const sounds = { mic: true, pads: [{ id: 'p1', name: 'Бонк' }], playing: ['p1'] };
  listeners['hub:state']({}, 'aura.evil', { x: 1 });
  listeners['hub:state']({}, 'aura.party', [1, 2]);
  listeners['hub:state']({}, 'aura.sounds', sounds);
  await until(() => maskaSeen['aura.sounds']);
  eq('hub:state: тема из списка публикуется', maskaSeen['aura.sounds'], sounds);
  await wait(150);
  eq('hub:state: чужая тема и не объект — нет', ['aura.evil' in maskaSeen, 'aura.party' in maskaSeen], [false, false]);
  maska.close();

  // окно пати: preload (подмена микрофона) — только в режиме «Пати через Discord»; режим main.js узнаёт от окна
  const partyWins = () => wins.filter((w) => w.options.webPreferences && w.options.webPreferences.session);
  const prefs = (w) => [path.basename(w.options.webPreferences.preload || '') || null, !!w.options.webPreferences.nodeIntegrationInSubFrames, w.options.webPreferences.sandbox, w.options.webPreferences.contextIsolation];
  eq('party:discord-mode выкл', (await handles['party:discord-mode']({}, false)).on, false);
  eq('party:open: неверный адрес', await handles['party:open']({}, 'http://example.com'), { error: 'Нужен адрес сайта с https://' });
  eq('party:open', await handles['party:open']({}, 'example.com/chat'), { ok: true });
  let pw = partyWins().slice(-1)[0];
  eq('режим выключен: у окна пати нет preload', [partyWins().length, prefs(pw), pw.url], [1, [null, false, true, true], 'https://example.com/chat']);
  const st = await handles['party:discord-mode']({}, true);
  const pw2 = partyWins()[1];
  eq('режим включён: окно сделано заново, тот же адрес и место, с preload и во фреймах', [partyWins().length, pw.destroyed, pw2 && prefs(pw2), pw2 && pw2.url, pw2 && pw2.options.width], [2, true, ['party-preload.js', true, true, true], 'https://example.com/chat', 900]);
  eq('party:discord-mode: состояние', [st.on, st.site, st.hearing], [true, true, false]);
  await handles['party:discord-mode']({}, true);
  eq('тот же режим ещё раз — окно не пересоздаётся', partyWins().length, 2);
  await handles['party:discord-mode']({}, false);
  eq('режим снова выключен: окно без preload', [partyWins().length, pw2.destroyed, prefs(partyWins()[2])], [3, true, [null, false, true, true]]);
  await handles['party:discord-mode']({}, true);
  await handles['party:close']();
  eq('окно закрыто: site false', (await handles['party:discord-state']()).site, false);
  await handles['party:open']({}, 'example.com');
  const pw3 = partyWins().slice(-1)[0];
  eq('открыто в режиме: сразу с preload', prefs(pw3)[0], 'party-preload.js');
  listeners['party:discord-want']({ sender: {}, senderFrame: { processId: 7, routingId: 1 } }); // не из окна пати — мимо
  await wait(50);
  eq('Discord не найден (tasklist не ответил): AuraCapture не запускается', [spawned.filter((x) => /AuraCapture/i.test(x[0])), (await handles['party:discord-state']()).found], [[], false]);
  eq('окну Aura сообщено о режиме', win.sent.filter((x) => x[0] === 'party:event' && x[1] === 'discord').slice(-1).map((x) => [x[2].on, x[2].site]), [[true, true]]);
  await handles['party:discord-mode']({}, false);
  await handles['party:close']();

  // сайт в своём браузере: окну пати preload не нужен; захват Discord — без окна пати, когда кабель есть; звук — в окно Aura
  await handles['party:open']({}, 'example.com');
  await handles['party:discord-mode']({}, true, 'window', false);
  const pwWin = partyWins().slice(-1)[0];
  eq('вариант «окно»: окно пати с preload', prefs(pwWin)[0], 'party-preload.js');
  let bst = await handles['party:discord-mode']({}, true, 'browser', false);
  const pwBr = partyWins().slice(-1)[0];
  eq('вариант «браузер»: открытое окно пати сделано заново без preload', [pwWin.destroyed, prefs(pwBr), pwBr.url], [true, [null, false, true, true], 'https://example.com']);
  eq('вариант «браузер»: состояние', [bst.on, bst.where, bst.cable, bst.site], [true, 'browser', false, true]);
  await handles['party:discord-mode']({}, true, 'browser', true);
  eq('вариант «браузер», кабель есть: окно пати больше не пересоздаётся', partyWins().length, partyWins().indexOf(pwBr) + 1);
  await handles['party:close']();
  fake.capture = true;
  fake.discord = true;
  const captures = () => spawned.filter((x) => /AuraCapture/i.test(x[0]));
  await handles['party:discord-mode']({}, true, 'window', true);
  await wait(100);
  eq('вариант «окно» без окна пати: захвата нет', captures().length, 0);
  await handles['party:discord-mode']({}, true, 'browser', false);
  await wait(100);
  eq('вариант «браузер» без кабеля: захвата нет', captures().length, 0);
  bst = await handles['party:discord-mode']({}, true, 'browser', true);
  eq('вариант «браузер», кабель есть, окна пати нет: режим включён', [bst.on, bst.where, bst.cable, bst.site, bst.available], [true, 'browser', true, false, true]);
  await until(() => captures().length === 1, 2000);
  eq('...и захват Discord запущен — корень дерева', captures(), [['AuraCapture.exe', '5100']]);
  const cap = children[children.length - 1];
  cap.stderr.emit('data', Buffer.from('capturing\n'));
  eq('слышит Discord', (await handles['party:discord-state']()).hearing, true);
  const pcmSent = () => win.sent.filter((x) => x[0] === 'party:cable-pcm');
  const fromCapture = Buffer.from(new Float32Array([0.5, -0.25, 0.125]).buffer);
  cap.stdout.emit('data', fromCapture.subarray(0, 7)); // кусок не на границе отсчёта: остаток ждёт следующего
  cap.stdout.emit('data', fromCapture.subarray(7));
  const got = pcmSent().map((x) => [...new Float32Array(x[1])]);
  eq('звук Discord — в окно Aura, каналом party:cable-pcm, целыми отсчётами', got, [[0.5], [-0.25, 0.125]]);
  eq('...а не во фреймы окна пати', win.sent.filter((x) => x[0] === 'party:discord-pcm').length, 0);
  eq('окну Aura сообщено: where и cable', win.sent.filter((x) => x[0] === 'party:event' && x[1] === 'discord').slice(-1).map((x) => [x[2].where, x[2].cable, x[2].hearing]), [['browser', true, true]]);
  bst = await handles['party:discord-mode']({}, true, 'browser', false);
  eq('кабель пропал: захват остановлен', [cap.killed, bst.hearing, bst.found], [true, false, false]);
  await handles['party:discord-mode']({}, true, 'browser', true);
  await until(() => captures().length === 2, 2000);
  const cap2 = children[children.length - 1];
  await handles['party:discord-mode']({}, false, 'browser', true);
  eq('режим выключен: захват остановлен', [captures().length, cap2.killed], [2, true]);
  fake.capture = false;
  fake.discord = false;
  // какой процесс Discord слушать: корень дерева (party-discord.js)
  const pd = require(path.join(repo, 'party-discord.js'));
  const listed = pd.parseTasklist('"System","4","Services","0","1 K"\r\n"Discord.exe","5100","Console","1","90 K"\r\n"Discord.exe","5200","Console","1","90 K"\r\n"DiscordPTB.exe","7000","Console","1","9 K"\r\n');
  eq('tasklist: Discord найден', listed.filter((p) => pd.isDiscord(p.name)).map((p) => p.pid), [5100, 5200, 7000]);
  const cim = pd.parseCim(JSON.stringify([{ ProcessId: 5200, ParentProcessId: 5100, Name: 'Discord.exe' }, { ProcessId: 5100, ParentProcessId: 4000, Name: 'Discord.exe' }, { ProcessId: 5300, ParentProcessId: 5100, Name: 'Discord.exe' }, { ProcessId: 7000, ParentProcessId: 6000, Name: 'DiscordPTB.exe' }]));
  eq('корень дерева Discord, обычный раньше PTB', [pd.pickDiscordRoot(cim), pd.pickDiscordRoot(cim.filter((p) => p.name !== 'Discord.exe')), pd.pickDiscordRoot(pd.parseCim('{"ProcessId":9,"ParentProcessId":1,"Name":"DiscordCanary.exe"}')), pd.pickDiscordRoot(pd.parseCim('не json'))], [5100, 7000, 9, 0]);

  // старая запись автозапуска (autostart-legacy.js): что убирать, а что нет
  eq('не установленная копия реестр автозапуска не трогает', regCalls, []);
  const al = require(path.join(repo, 'autostart-legacy.js'));
  const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\aura-voice\\Aura.exe';
  const runOut = (rows) => '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n' + rows.map((r) => '    ' + r.join('    ')).join('\r\n') + '\r\n\r\n';
  const plan = (rows, approvedRows) => al.legacyPlan({ run: al.parseRegValues(runOut(rows)), approved: al.parseRegValues(runOut(approvedRows || [])), exePath: EXE, currentName: 'app.aura.voice' });
  const oldRow = ['electron.app.Aura', 'REG_SZ', `"${EXE}" --hidden`], curRow = ['app.aura.voice', 'REG_SZ', `"${EXE}" --hidden`];
  const NOTHING = { removeRun: false, removeApproved: false, enableCurrent: false };
  eq('reg query: имена с пробелами, пустые данные', al.parseRegValues(runOut([['Gaijin.Net Updater', 'REG_BINARY', '0300'], ['Empty', 'REG_SZ']])), { 'Gaijin.Net Updater': { type: 'REG_BINARY', data: '0300' }, Empty: { type: 'REG_SZ', data: '' } });
  eq('обе записи: старая убирается, текущая не трогается', plan([oldRow, curRow], [['electron.app.Aura', 'REG_BINARY', '020000000000000000000000']]), { removeRun: true, removeApproved: true, enableCurrent: false });
  eq('только старая, включена: убирается, текущая включается', plan([oldRow]), { removeRun: true, removeApproved: false, enableCurrent: true });
  eq('только старая, выключена в диспетчере задач: убирается, автозапуск остаётся выключен', plan([oldRow], [['electron.app.Aura', 'REG_BINARY', '03000000C86EC629EBB6DC01']]), { removeRun: true, removeApproved: true, enableCurrent: false });
  eq('старая без кавычек и другим регистром — тоже Aura', plan([['electron.app.Aura', 'REG_SZ', EXE.toLowerCase() + ' --hidden']]).removeRun, true);
  eq('старое имя, но чужая программа — не трогается', plan([['electron.app.Aura', 'REG_SZ', '"C:\\Other\\Aura.exe" --hidden']]), NOTHING);
  eq('Aura.exe под чужим именем — не трогается', plan([['Aura', 'REG_SZ', `"${EXE}"`], curRow]), NOTHING);
  eq('старой нет — ничего', [plan([curRow]), plan([])], [NOTHING, NOTHING]);
  eq('отметка без записи в Run — не трогается', plan([curRow], [['electron.app.Aura', 'REG_BINARY', '02']]), NOTHING);

  // дорога к core.txt
  eq('core:info', info(), { online: true, installed: true, quitHere: true });
  await handles['core:go']({}, 'general');
  await handles['core:go']({}, 'evil');
  await handles['core:go']({});
  eq('core:go: страницы', coreShow.slice(-3), [{ page: 'general' }, {}, {}]);

  // первое закрытие: показать негде (значок у core.txt, острова нет, копия не установленная) — не отмечается
  eq('закрытие оставляет aura.txt работать', closeWindow(), true);
  eq('ни острова, ни своего значка: подсказки нет, не отмечено', [balloons.length, toasts.length, fs.existsSync(flag)], [0, 0, false]);
  const notes = [];
  const island = connect({ app: 'kapsula', name: 'kapsula.txt', port: server.port, commands: { notify: (a) => { notes.push(a); return null; } } });
  await until(() => island.online);
  await wait(150); // hub.apps доходит до aura.txt
  closeWindow();
  await until(() => notes.length === 1);
  eq('подсказка — на остров', notes[0], { title: 'aura.txt работает в фоне', text: 'Голос продолжает обрабатываться. Окно открывается из меню core.txt в трее, а выйти можно в «Настройках».', open: true });
  eq('подсказка отмечена', fs.existsSync(flag), true);
  fs.rmSync(flag);

  // core.txt закрылся: свой значок сразу
  const pushesBefore = familyPushes();
  core.close();
  await until(() => trays.length === 2, 1000);
  eq('core.txt ушёл: свой значок сразу', [trays.length, trays[1].destroyed], [2, false]);
  eq('...окно узнало, выход снова в меню значка', [familyPushes() > pushesBefore, info().quitHere], [true, false]);
  closeWindow();
  await until(() => notes.length === 2);
  eq('со своим значком: на остров — подсказка про рыбку', notes[1].text, 'Голос продолжает обрабатываться. Чтобы закрыть совсем — правый клик по рыбке → «Выход».');
  fs.rmSync(flag);
  island.close();
  await wait(200);
  closeWindow();
  eq('без острова: подсказка у своего значка', [balloons.length, balloons[0] && balloons[0].title, toasts.length, fs.existsSync(flag)], [1, 'aura.txt осталась в трее', 0, true]);

  // core.txt вернулся сразу: значок убирается дольше (без мигания)
  core = coreLink(seen);
  await until(() => core.online);
  core.state('core.family', { tray: true });
  await wait(3000);
  eq('значок только что вернулся: через 3 с ещё есть', trays[1].destroyed, false);
  await until(() => trays[1].destroyed, 7000);
  eq('...и убран через ~8 с', trays[1].destroyed, true);

  // хаба нет: core.txt запускается сразу на нужной странице
  core.close();
  await stopServer();
  await until(() => trays.length === 3 && !info().online, 3000);
  eq('хаб пропал: свой значок сразу', [trays.length, trays[2].destroyed, info().online], [3, false, false]);
  await handles['core:go']({}, 'general');
  await handles['core:go']({}, 'evil');
  await handles['core:go']({});
  eq('core:go без связи: запуск core.txt с --page', spawned.filter((x) => !/AuraCapture/i.test(x[0])), [['Core.exe', '--page', 'general'], ['Core.exe'], ['Core.exe']]);

  // выход кнопкой в окне: значок больше не появляется
  await handles['app:quit']();
  eq('«Выйти» из окна', [calls.quit, closeWindow()], [1, false]);
  await wait(300);
  eq('после выхода значок не создаётся заново', trays.length, 3);
  return finish();
})().catch((e) => {
  console.log('FAIL ' + (e && e.stack));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
