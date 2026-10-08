'use strict';
/* ============================================================
   ВЕРСИЯ В ОДНОМ МЕСТЕ: package.json — источник правды.
   Отсюда она расходится в shared/world.js (литерал: файл грузится
   и браузером, где require('../package.json') недоступен) и в README.
   Запуск: node scripts/sync-version.js [--check]
   Вызывается сам из npm-хука "version" — `npm version 1.3.0`.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const check = process.argv.includes('--check');
const version = require(path.join(ROOT, 'package.json')).version;

const targets = [
  { file: 'shared/world.js', re: /(const GAME_VERSION = ')([^']*)(')/, what: 'GAME_VERSION' },
  { file: 'README.md', re: /(Версия: \*\*)([^*]*)(\*\*)/, what: 'строка версии' }
];

let bad = 0, changed = 0;
for (const t of targets) {
  const p = path.join(ROOT, t.file);
  const src = fs.readFileSync(p, 'utf8');
  const m = src.match(t.re);
  if (!m) { console.error(`${t.file}: не нашёл ${t.what} — проверьте шаблон в scripts/sync-version.js`); bad++; continue }
  if (m[2] === version) continue;
  if (check) { console.error(`${t.file}: ${t.what} — ${m[2]}, а в package.json ${version}`); bad++; continue }
  fs.writeFileSync(p, src.replace(t.re, `$1${version}$3`));
  console.log(`${t.file}: ${m[2]} → ${version}`);
  changed++;
}

if (bad) { console.error(check ? 'Версии разошлись — выполните npm run version:sync' : 'Синхронизация не удалась'); process.exit(1) }
console.log(check ? `версии сходятся: ${version}` : (changed ? `готово: ${version}` : `и так везде ${version}`));
