/**
 * Written Portuguese → spoken Portuguese, before the text reaches the synthesiser.
 *
 * Until now the only defence was a line in the storyboard prompt asking the model
 * for "spoken, not written" Portuguese (`src/openai/script.ts`). That works on
 * text the model wrote and does nothing for a hand-written `demo.yaml`, which
 * reaches `/v1/audio/speech` after exactly one transformation: `trim()`.
 *
 * **Scope is deliberately narrow, and the boundary is "does the glyph carry
 * pronunciation".** `R$`, `%`, `º`, `/` in a date and `:` in a time are notation —
 * the reader supplies words the writer never typed, and which words depends on
 * the locale. Those are converted. Bare integers are NOT: the synthesiser reads
 * `1234` correctly, while a rule that rewrote every digit run would also rewrite
 * `CEP 01310-100` and `v4.0.501` into nonsense. A normaliser that mangles one
 * string in fifty is worse than none, because the failure is inaudible until it
 * ships.
 *
 * Decimal commas are the exception among numbers, and they earn it: `3,5` is
 * `three point five` in pt-BR and a thousands separator in en-US, so leaving it
 * ambiguous is a coin flip on a model that speaks both.
 *
 * Runs before {@link clipId} so the cache key is the audio's real input; `Clip`
 * keeps the original text as well, because captions and the timeline want what
 * the human wrote, not what the voice was handed.
 */

/** 0–19 spelled out; above that {@link under100} composes. */
const UNITS = [
  "zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
  "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove",
];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = [
  "", "cento", "duzentos", "trezentos", "quatrocentos",
  "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos",
];

const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** Masculine and feminine ordinals, 1–31 — the range `º`/`ª` actually appears in. */
const ORDINALS_M = [
  "", "primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "oitavo", "nono", "décimo",
  "décimo primeiro", "décimo segundo", "décimo terceiro", "décimo quarto", "décimo quinto",
  "décimo sexto", "décimo sétimo", "décimo oitavo", "décimo nono", "vigésimo",
  "vigésimo primeiro", "vigésimo segundo", "vigésimo terceiro", "vigésimo quarto", "vigésimo quinto",
  "vigésimo sexto", "vigésimo sétimo", "vigésimo oitavo", "vigésimo nono", "trigésimo", "trigésimo primeiro",
];

function under100(n: number): string {
  if (n < 20) return UNITS[n] ?? String(n);
  const t = Math.floor(n / 10);
  const u = n % 10;
  const tens = TENS[t] ?? "";
  return u > 0 ? `${tens} e ${UNITS[u]}` : tens;
}

function under1000(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cem"; // "cento" only ever precedes a remainder
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(HUNDREDS[h] ?? "");
  if (r > 0) parts.push(under100(r));
  return parts.join(" e ");
}

const SCALES = [
  { at: 1_000_000_000, one: "bilhão", many: "bilhões" },
  { at: 1_000_000, one: "milhão", many: "milhões" },
  { at: 1_000, one: "mil", many: "mil" },
] as const;

/**
 * A non-negative integer in words.
 *
 * Two pt-BR rules that a naive join gets wrong: `1000` is "mil", never "um mil";
 * and the remainder is joined with "e" only when it is under a hundred or a round
 * hundred — "mil e cinco", "mil e duzentos", but "mil duzentos e trinta".
 */
export function integerToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `menos ${integerToWords(-n)}`;
  if (n === 0) return "zero";
  if (n < 1000) return under1000(n);

  for (const s of SCALES) {
    if (n < s.at) continue;
    const count = Math.floor(n / s.at);
    const rest = n % s.at;
    const head =
      s.at === 1000 && count === 1 ? "mil" : `${integerToWords(count)} ${count === 1 ? s.one : s.many}`;
    if (rest === 0) return head;
    const joiner = rest < 100 || rest % 100 === 0 ? " e " : " ";
    return `${head}${joiner}${integerToWords(rest)}`;
  }
  return under1000(n);
}

/** Digits only, no separators. */
const digits = (s: string): number => Number.parseInt(s.replace(/\D/g, ""), 10);

function reais(intPart: string, cents: string | undefined): string {
  const whole = digits(intPart);
  const c = cents ? digits(cents.padEnd(2, "0").slice(0, 2)) : 0;
  const wholeWords = whole === 1 ? "um real" : `${integerToWords(whole)} reais`;
  if (c === 0) return wholeWords;
  const centWords = c === 1 ? "um centavo" : `${integerToWords(c)} centavos`;
  return whole === 0 ? centWords : `${wholeWords} e ${centWords}`;
}

/**
 * Abbreviation → what a reader says. Keyed on the same stems the sentence splitter
 * guards in `src/openai/tts.ts`, because they are the same phenomenon seen from
 * two sides: the splitter must not break on the dot, and the voice must not read
 * the dot. Entries with no unambiguous expansion (`r.` for rua vs. real) are left
 * out on purpose — a wrong expansion is spoken confidently.
 */
const EXPANSIONS: Record<string, string> = {
  dr: "doutor", dra: "doutora", sr: "senhor", sra: "senhora", srta: "senhorita",
  prof: "professor", profa: "professora", eng: "engenheiro",
  av: "avenida", ltda: "limitada", cia: "companhia",
  art: "artigo", fig: "figura", tab: "tabela", pág: "página", cap: "capítulo",
  obs: "observação", ref: "referência", núm: "número", nº: "número",
  aprox: "aproximadamente", máx: "máximo", mín: "mínimo",
  etc: "et cetera", vs: "versus",
};
const EXPANSION_RE = new RegExp(`\\b(${Object.keys(EXPANSIONS).filter((k) => k !== "nº").join("|")})\\.`, "giu");

/** Keeps the readable part of a link and drops the machinery around it. */
function speakUrl(raw: string): string {
  const host = /^(?:https?:\/\/)?(?:www\.)?([^/\s:]+)/i.exec(raw)?.[1];
  if (!host) return raw;
  return host.replace(/\./g, " ponto ").replace(/-/g, " ");
}

/**
 * Normalise one stretch of narration for the synthesiser.
 *
 * Order matters and is not arbitrary: markdown comes off first so a bold
 * `**R$ 10**` is still recognisable as currency, and every notation rule runs
 * before the generic decimal rule so `1,5%` is a percentage rather than a bare
 * decimal followed by a stray glyph.
 */
export function toSpeakable(input: string): string {
  let s = input.normalize("NFC");

  // ── markdown, which is punctuation the voice would try to pronounce ─────────
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links keep their label
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
  s = s.replace(/(?<![\p{L}\d])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?![\p{L}\d])/gu, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");

  // ── links ──────────────────────────────────────────────────────────────────
  s = s.replace(/\bhttps?:\/\/\S+|\bwww\.[^\s,;)]+/gi, (m) => speakUrl(m));

  // ── currency ───────────────────────────────────────────────────────────────
  s = s.replace(/R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/g, (_m, int: string, cents?: string) =>
    reais(int, cents),
  );

  // ── dates: dd/mm/yyyy and dd/mm ────────────────────────────────────────────
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, d: string, mo: string, y: string) => {
    const month = MONTHS[Number(mo) - 1];
    if (!month) return m;
    return `${integerToWords(Number(d))} de ${month} de ${integerToWords(Number(y))}`;
  });
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g, (m, d: string, mo: string) => {
    const month = MONTHS[Number(mo) - 1];
    if (!month || Number(d) > 31 || Number(d) < 1) return m;
    // A yearless date and a fraction are the same three characters. `1/2` and
    // `3/4` are overwhelmingly fractions in narration, so the rule only fires
    // when the day cannot be a small numerator: zero-padded, or past 12.
    if (!/^\d{2}$/.test(d) && Number(d) <= 12) return m;
    return `${integerToWords(Number(d))} de ${month}`;
  });

  // ── times: 14h30, 14:30, 14h ───────────────────────────────────────────────
  s = s.replace(/\b([01]?\d|2[0-3])[h:]([0-5]\d)\b/g, (_m, h: string, mi: string) =>
    Number(mi) === 0
      ? `${integerToWords(Number(h))} horas`
      : `${integerToWords(Number(h))} e ${integerToWords(Number(mi))}`,
  );
  s = s.replace(/\b([01]?\d|2[0-3])h\b/g, (_m, h: string) =>
    Number(h) === 1 ? "uma hora" : `${integerToWords(Number(h))} horas`,
  );

  // ── percentages ────────────────────────────────────────────────────────────
  s = s.replace(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?\s*%/g, (_m, int: string, dec?: string) => {
    const head = integerToWords(digits(int));
    const tail = dec ? ` vírgula ${[...dec].map((d) => UNITS[Number(d)]).join(" ")}` : "";
    return `${head}${tail} por cento`;
  });

  // ── ordinals ───────────────────────────────────────────────────────────────
  s = s.replace(/\b(\d{1,2})\s*º/g, (m, n: string) => ORDINALS_M[Number(n)] ?? m);
  s = s.replace(/\b(\d{1,2})\s*ª/g, (m, n: string) => {
    const w = ORDINALS_M[Number(n)];
    return w ? w.replace(/o\b/g, "a") : m;
  });
  s = s.replace(/\bnº\s*(\d+)/gi, (_m, n: string) => `número ${integerToWords(digits(n))}`);

  // ── decimal comma, once every notation that owns one has had its turn ──────
  // The int side accepts grouped thousands so `1.234,56` without an `R$` still
  // reads as one number instead of leaving a dangling `1.` behind.
  s = s.replace(/\b(\d{1,3}(?:\.\d{3})+|\d+),(\d+)\b/g, (_m, int: string, dec: string) => {
    const tail = [...dec].map((d) => UNITS[Number(d)] ?? d).join(" ");
    return `${integerToWords(digits(int))} vírgula ${tail}`;
  });

  // ── abbreviations ──────────────────────────────────────────────────────────
  s = s.replace(EXPANSION_RE, (m, abbr: string) => {
    const exp = EXPANSIONS[abbr.toLowerCase()];
    if (!exp) return m;
    // Preserve a leading capital: "Dr." opens sentences.
    return /^[A-ZÀ-Þ]/.test(abbr) ? exp.charAt(0).toUpperCase() + exp.slice(1) : exp;
  });

  // ── parentheses: keep the words, drop the glyphs ────────────────────────────
  // The content is usually load-bearing ("(aprox.)" became "aproximadamente"
  // above); it is the brackets that have no pronunciation.
  s = s.replace(/[()[\]]/g, " ");

  return s.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}
