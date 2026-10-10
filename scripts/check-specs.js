'use strict';
/* ============================================================
   СПЕЦИФИКАЦИИ НЕ ВРУТ О КОДЕ.
   В openspec/specs/<область>/spec.md имена файлов, функций и
   констант стоят в обратных кавычках. Скрипт проверяет, что
   каждое такое имя есть в исходниках: переименовали функцию и
   забыли про спецификацию — тест скажет, где.
   Запуск: node scripts/check-specs.js   (входит в npm test)
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SPECS = path.join(ROOT, 'openspec', 'specs');
const DIRS = ['shared', 'game', 'server', 'client/js', 'client/js/render', 'scripts'];
/* слова формата и значения из текста — не имена из кода */
const SKIP = new Set(('SHALL MUST NOT GIVEN WHEN THEN AND nato cis both attack defense deploy battle me open bot ' +
  'create join list leave act pace seat save load saved rooms res true false localStorage package json keydown spec md').split(' '));
/* короткие имена, которые всё же проверяем */
const SHORT = new Set(['UT', 'CP', 'su', 'sp', 'fu', 'sv', 'G', 'M', 'H']);

if (!fs.existsSync(SPECS)) { console.log('спецификаций нет — проверять нечего'); process.exit(0) }
const files = DIRS.flatMap(d => fs.readdirSync(path.join(ROOT, d)).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, d, f)));
const all = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const has = id => new RegExp('(^|[^\\w$])' + id.replace(/\$/g, '\\$') + '([^\\w$]|$)').test(all);

let bad = 0, total = 0;
for (const d of fs.readdirSync(SPECS)) {
  const file = path.join(SPECS, d, 'spec.md');
  if (!fs.existsSync(file)) continue;
  const md = fs.readFileSync(file, 'utf8');
  for (const m of md.matchAll(/`([^`]+)`/g)) {
    const t = m[1];
    if (/^[\w./-]+\.(js|css|md|json)$/.test(t)) {
      total++;
      if (!fs.existsSync(path.join(ROOT, t))) { console.error(`${d}: нет файла ${t}`); bad++ }
      continue;
    }
    for (const part of t.split(/[\/,\s]+/)) {
      for (const id of part.replace(/\(.*$/, '').split('.')) {
        if (!/^[A-Za-z_$][\w$]*$/.test(id) || SKIP.has(id) || (id.length < 3 && !SHORT.has(id))) continue;
        total++;
        if (!has(id)) { console.error(`${d}: в коде нет «${id}» (из \`${t}\`)`); bad++ }
      }
    }
  }
}
if (bad) { console.error(`спецификации разошлись с кодом: ${bad} из ${total} ссылок — поправьте openspec/specs`); process.exit(1) }
console.log(`спецификации: ${total} ссылок на код, все на месте`);
