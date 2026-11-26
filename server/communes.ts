// The 24 communes of Kinshasa, with the short names and spellings people use, so "Bandal",
// "Ndjili", "Kasavubu" or "Binza" all land on the same commune.
export const KINSHASA_COMMUNES: { name: string; aliases: string[] }[] = [
  { name: 'Bandalungwa', aliases: ['Bandal'] },
  { name: 'Barumbu', aliases: [] },
  { name: 'Bumbu', aliases: [] },
  { name: 'Gombe', aliases: ['La Gombe'] },
  { name: 'Kalamu', aliases: ['Matonge', 'Victoire', 'Yolo'] },
  { name: 'Kasa-Vubu', aliases: ['Kasavubu', 'Kasa Vubu'] },
  { name: 'Kimbanseke', aliases: ['Kimbaseke'] },
  { name: 'Kinshasa', aliases: [] },
  { name: 'Kintambo', aliases: [] },
  { name: 'Kisenso', aliases: [] },
  { name: 'Lemba', aliases: ['Righini', 'Salongo'] },
  { name: 'Limete', aliases: ['Kingabwa'] },
  { name: 'Lingwala', aliases: [] },
  { name: 'Makala', aliases: [] },
  { name: 'Maluku', aliases: [] },
  { name: 'Masina', aliases: ['Petro-Congo', 'Petro Congo'] },
  { name: 'Matete', aliases: [] },
  { name: 'Mont-Ngafula', aliases: ['Mont Ngafula', 'Mt Ngafula', 'Ngafula'] },
  { name: "N'Djili", aliases: ['Ndjili', 'Ndili', 'N Djili'] },
  { name: 'Ngaba', aliases: [] },
  { name: 'Ngaliema', aliases: ['Binza', 'Ma Campagne', 'Macampagne'] },
  { name: 'Ngiri-Ngiri', aliases: ['Ngiri Ngiri', 'Ngiringiri'] },
  { name: "N'Sele", aliases: ['Nsele', 'N Sele'] },
  { name: 'Selembao', aliases: [] },
];

/** Lower case, no accents, apostrophes or dashes. */
export const fold = (x: string): string => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

export function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** The official commune for a name, short name or close spelling; otherwise the text as typed. */
export function canonicalCommune(input: string): string {
  const q = fold(input || '');
  if (!q) return '';
  for (const c of KINSHASA_COMMUNES) if ([c.name, ...c.aliases].some((n) => fold(n) === q)) return c.name;
  // A close spelling ("Bandalungua", "Lingwalla"): one or two letters off.
  let best: { name: string; d: number } | null = null;
  for (const c of KINSHASA_COMMUNES) for (const n of [c.name, ...c.aliases]) {
    const d = distance(q, fold(n));
    if (d <= (q.length >= 7 ? 2 : 1) && (!best || d < best.d)) best = { name: c.name, d };
  }
  return best ? best.name : input.trim();
}

/** Communes mentioned in a sentence (by name, short name or close spelling). */
// Ordinary words close to a commune's name ("limite" ≈ Limete); "Kinshasa" usually means the city.
const NOT_COMMUNES = new Set(['limite', 'limites', 'kinshasa', 'masini']);
export function communesIn(text: string): string[] {
  const words = fold(text).split(/[^a-z0-9]+/).filter((w) => w && !NOT_COMMUNES.has(w));
  const found = new Set<string>();
  for (const c of KINSHASA_COMMUNES) {
    for (const n of [c.name, ...c.aliases]) {
      const parts = fold(n).split(' ');
      for (let i = 0; i + parts.length <= words.length; i++) {
        const chunk = words.slice(i, i + parts.length).join(' ');
        const target = parts.join(' ');
        if (chunk === target || (target.length >= 6 && distance(chunk, target) <= 2)) found.add(c.name);
      }
    }
  }
  return [...found];
}
