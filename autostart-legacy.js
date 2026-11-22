// Старая запись автозапуска. До 0.28 у aura.txt не было своего id (setAppUserModelId), и Electron писал автозапуск
// в HKCU\…\Run под id по умолчанию — «electron.app.Aura». Теперь id — app.aura.voice, и запись — под ним; старая
// оставалась, и при входе в Windows стартовали две копии. Здесь — что с ней делать; реестр читает и правит main.js.
'use strict';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const LEGACY_NAME = 'electron.app.Aura';

// reg query <ключ>: строки «    имя    REG_SZ    данные» → { имя: { type, data } }
function parseRegValues(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (m) out[m[1]] = { type: m[2], data: (m[3] || '').trim() };
  }
  return out;
}

// Программа из командной строки записи: "C:\…\Aura.exe" --hidden или C:\…\Aura.exe --hidden
function commandExe(command) {
  const s = String(command || '').trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 0 ? s.slice(1, end) : '';
  }
  const m = /^(.*?\.exe)(?:\s|$)/i.exec(s);
  return m ? m[1] : s.split(/\s/)[0];
}
const samePath = (a, b) => !!a && !!b && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

// StartupApproved\Run: первый байт чётный (02, 06) — включено, нечётный (03, 07) — выключено в диспетчере задач.
// Записи нет — Windows считает включённой.
function approvedOn(value) {
  if (!value || value.type !== 'REG_BINARY' || !/^[0-9a-f]{2}/i.test(value.data)) return true;
  return (parseInt(value.data.slice(0, 2), 16) & 1) === 0;
}

// Что сделать по содержимому обоих ключей: убрать старую запись (и её отметку в StartupApproved) — только если
// она есть и запускает именно этот Aura.exe; включить текущую — если старая и была автозапуском (включена), а
// текущей нет: выбор «запускать с Windows» остаётся тем же, но одной записью.
function legacyPlan({ run, approved, exePath, currentName }) {
  const legacy = run && run[LEGACY_NAME];
  if (!legacy || LEGACY_NAME === currentName || !samePath(commandExe(legacy.data), exePath)) {
    return { removeRun: false, removeApproved: false, enableCurrent: false };
  }
  return {
    removeRun: true,
    removeApproved: !!(approved && approved[LEGACY_NAME]),
    enableCurrent: !run[currentName] && approvedOn(approved && approved[LEGACY_NAME]),
  };
}

module.exports = { RUN_KEY, APPROVED_KEY, LEGACY_NAME, parseRegValues, commandExe, approvedOn, legacyPlan };
