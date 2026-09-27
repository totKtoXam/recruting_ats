// Расстояние Дамерау — Левенштейна (оптимальное выравнивание строк): вставка, удаление,
// замена и перестановка соседних символов считаются за одну правку.
export function damerauLevenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const rows = s.length + 1;
  const cols = t.length + 1;
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[s.length][t.length];
}

// Сходство 0..1: 1 — строки равны. Для коротких строк (до 3 символов) только точное совпадение,
// иначе «Ли» и «Ло» считались бы похожими.
export function similarity(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (!s || !t) return 0;
  if (s === t) return 1;
  if (Math.min(s.length, t.length) < 4) return 0;
  return 1 - damerauLevenshtein(s, t) / Math.max(s.length, t.length);
}