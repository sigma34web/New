/**
 * Deterministic mechanical typography checks.
 *
 * THE BOUNDARY THIS MODULE REFUSES TO CROSS. Everything here is decidable from the bytes: a doubled
 * space, an unbalanced bracket, a stray control character, a line ending that is not LF. Nothing here
 * judges whether prose is GOOD. That judgment is bilingual human review, it is listed in
 * `docs/08-delivery/12-remaining-external-work.md` as blocked on reviewers, and this module does not
 * reduce that requirement by a single reader. A finding here means "a machine can prove this is a
 * formatting defect", nothing more.
 *
 * WHY IT IS IN `prose` AND NOT IN THE EXPORT RENDERER. The same checks have to run from the API, the
 * CLI, the export preparation path and the batch runner. A check implemented in one renderer is a check
 * the other three callers do not get, so it lives next to the NFC, paragraph and code-point primitives
 * every one of those callers already shares.
 *
 * DETERMINISM IS A TESTED PROPERTY, not an aspiration: findings are produced by scanning in a fixed
 * order and then sorted by (start, code), so the same text always yields the identical array. Offsets
 * are Unicode CODE-POINT indices into NFC text (ADR-0030), which is why a surrogate pair or a combining
 * sequence cannot shift a reported location.
 *
 * LANGUAGE SCOPE. English is the manuscript language (ADR-0026). Korean text nonetheless appears in
 * terminology entries, glossaries and fixtures, so the Korean and mixed-language rules below exist to
 * avoid FALSE POSITIVES on legitimate Korean punctuation as much as to catch real defects.
 */
import { normalizeNfc, type NfcText, toNfcText } from './nfc.js';
import { utf16IndexToCodePoint } from './codepoints.js';

export type TypographySeverity = 'error' | 'warning' | 'info';

/**
 * Stable finding codes. Closed and versioned by name: a code never changes meaning, because
 * suppressions in stored configuration refer to these strings.
 */
export const TYPOGRAPHY_CODES = [
  'TYPO001', // repeated space inside a line
  'TYPO002', // trailing whitespace at end of line
  'TYPO003', // more than one consecutive blank line
  'TYPO004', // CR or CRLF line ending
  'TYPO005', // disallowed control character
  'TYPO006', // lone surrogate / broken Unicode
  'TYPO007', // text is not NFC-normalized
  'TYPO008', // mismatched bracket
  'TYPO009', // odd number of a paired quotation mark
  'TYPO010', // straight and curly quotes mixed in one text
  'TYPO011', // repeated punctuation (!!! , ??)
  'TYPO012', // space before a closing punctuation mark
  'TYPO013', // missing space after sentence punctuation
  'TYPO014', // three consecutive dots instead of an ellipsis character
  'TYPO015', // hyphen pair used as a dash
  'TYPO016', // non-breaking or exotic space character
  'TYPO017', // Korean text followed by a Latin full stop where a Korean one is expected
  'TYPO018', // space between a Korean syllable and its attached punctuation
  'TYPO019', // paragraph separated by a single newline rather than a blank line
  'TYPO020', // zero-width character
] as const;
export type TypographyCode = (typeof TYPOGRAPHY_CODES)[number];

export interface TypographyFinding {
  readonly code: TypographyCode;
  readonly severity: TypographySeverity;
  /** Inclusive code-point offset into the NFC text. */
  readonly start: number;
  /** Exclusive code-point offset. */
  readonly end: number;
  readonly line: number;
  readonly column: number;
  /** A fixed, safe message. Never contains the offending text verbatim beyond a bounded sample. */
  readonly message: string;
}

export interface TypographyResult {
  readonly performed: true;
  /** True when there is no `error`-severity finding. Warnings do not fail a check. */
  readonly passed: boolean;
  readonly findings: readonly TypographyFinding[];
  readonly counts: Readonly<Record<TypographySeverity, number>>;
  readonly suppressed: readonly TypographyCode[];
  /**
   * Stated in the result itself, so no consumer can present this as a quality verdict.
   */
  readonly does_not_replace: 'bilingual human review';
}

export interface TypographyOptions {
  /**
   * Codes to suppress, with the reason recorded by the caller's configuration.
   *
   * Suppression is by CODE rather than by offset on purpose: an offset-based suppression silently stops
   * matching the moment the text is edited, which makes it indistinguishable from a fixed defect.
   */
  readonly suppress?: readonly TypographyCode[] | undefined;
  /** Expected line ending. LF only in this system; the option exists so the rule is explicit. */
  readonly lineEnding?: 'lf' | undefined;
  /** Treat Korean punctuation rules as applicable. Auto-detected from the text when omitted. */
  readonly korean?: boolean | undefined;
}

export const SEVERITY_OF: Readonly<Record<TypographyCode, TypographySeverity>> = {
  TYPO001: 'warning',
  TYPO002: 'warning',
  TYPO003: 'warning',
  TYPO004: 'error',
  TYPO005: 'error',
  TYPO006: 'error',
  TYPO007: 'error',
  TYPO008: 'error',
  TYPO009: 'warning',
  TYPO010: 'warning',
  TYPO011: 'warning',
  TYPO012: 'warning',
  TYPO013: 'warning',
  TYPO014: 'info',
  TYPO015: 'info',
  TYPO016: 'warning',
  TYPO017: 'info',
  TYPO018: 'warning',
  TYPO019: 'info',
  TYPO020: 'error',
};

const MESSAGE_OF: Readonly<Record<TypographyCode, string>> = {
  TYPO001: 'Repeated space inside a line.',
  TYPO002: 'Trailing whitespace at the end of a line.',
  TYPO003: 'More than one consecutive blank line.',
  TYPO004: 'Line ending is not LF.',
  TYPO005: 'Disallowed control character.',
  TYPO006: 'Broken Unicode: an unpaired surrogate code unit.',
  TYPO007: 'Text is not NFC-normalized.',
  TYPO008: 'Mismatched bracket.',
  TYPO009: 'Unbalanced paired quotation mark.',
  TYPO010: 'Straight and curly quotation marks are mixed.',
  TYPO011: 'Repeated punctuation.',
  TYPO012: 'Space before closing punctuation.',
  TYPO013: 'Missing space after sentence punctuation.',
  TYPO014: 'Three dots used instead of an ellipsis character.',
  TYPO015: 'Double hyphen used instead of a dash.',
  TYPO016: 'Non-breaking or unusual space character.',
  TYPO017: 'Korean sentence ends with a Latin period where a Korean one is conventional.',
  TYPO018: 'Space between Korean text and its attached punctuation.',
  TYPO019: 'Paragraph break uses a single newline rather than a blank line.',
  TYPO020: 'Zero-width character.',
};

const BRACKET_PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '\u201c': '\u201d', // “ ”
  '\u300c': '\u300d', // 「 」
  '\u300e': '\u300f', // 『 』
  '\u3008': '\u3009', // 〈 〉
  '\u300a': '\u300b', // 《 》
};
const CLOSERS = new Set(Object.values(BRACKET_PAIRS));

/**
 * The single-quote pair is DELIBERATELY not a bracket.
 *
 * U+2019 is both the closing single quotation mark and the English apostrophe, and the apostrophe is
 * overwhelmingly the common case: "didn’t", "man’s", "Do-yoon’s". Treating it as a closer made every
 * contraction in the fixture manuscripts an unmatched-bracket ERROR — 13 of them in chapter 1 alone —
 * which is a checker nobody would keep enabled. Curly-single balance is therefore left to TYPO009's
 * count comparison, which only reports an excess of OPENERS, the direction an apostrophe cannot cause.
 */
const SINGLE_OPEN = '\u2018';
const SINGLE_CLOSE = '\u2019';

/** Control characters that are never legitimate in a manuscript. Tab and LF are handled separately. */
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ZERO_WIDTH = new Set(['\u200b', '\u200c', '\u200d', '\ufeff', '\u2060']);
const EXOTIC_SPACE = new Set([
  '\u00a0',
  '\u2007',
  '\u202f',
  '\u2009',
  '\u3000',
  '\u2002',
  '\u2003',
]);
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;

/** Line and column (1-based) for a code-point offset, computed once for the whole text. */
function lineIndex(codePoints: readonly string[]): { line: number[]; column: number[] } {
  const line: number[] = new Array<number>(codePoints.length + 1);
  const column: number[] = new Array<number>(codePoints.length + 1);
  let l = 1;
  let c = 1;
  for (let i = 0; i < codePoints.length; i++) {
    line[i] = l;
    column[i] = c;
    if (codePoints[i] === '\n') {
      l += 1;
      c = 1;
    } else {
      c += 1;
    }
  }
  line[codePoints.length] = l;
  column[codePoints.length] = c;
  return { line, column };
}

/**
 * Run every mechanical check.
 *
 * The input is normalized to NFC before scanning so every offset is an index into the SAME text the
 * rest of the system stores — but the non-normalized input is detected first (TYPO007), because
 * silently normalizing and then reporting no finding would hide the defect that matters.
 */
export function checkTypography(input: string, opts: TypographyOptions = {}): TypographyResult {
  const suppressed = [...new Set(opts.suppress ?? [])].sort();
  const suppress = new Set<TypographyCode>(suppressed);
  const raw = input;
  const nfc: NfcText = toNfcText(raw);
  const { text, codePoints } = nfc;
  const { line, column } = lineIndex(codePoints);
  const findings: TypographyFinding[] = [];

  const add = (code: TypographyCode, start: number, end: number): void => {
    if (suppress.has(code)) return;
    findings.push({
      code,
      severity: SEVERITY_OF[code],
      start,
      end,
      line: line[Math.min(start, codePoints.length)] ?? 1,
      column: column[Math.min(start, codePoints.length)] ?? 1,
      message: MESSAGE_OF[code],
    });
  };

  // --- whole-text properties --------------------------------------------------------------------

  if (raw !== normalizeNfc(raw)) add('TYPO007', 0, 0);

  // A lone surrogate survives NFC normalization and is what \p{Surrogate} exists to find. This is
  // checked on the UTF-16 units, because by definition no code point corresponds to it.
  for (let i = 0; i < raw.length; i++) {
    const unit = raw.charCodeAt(i);
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;
    if (!isHigh && !isLow) continue;
    const next = raw.charCodeAt(i + 1);
    const paired = isHigh && next >= 0xdc00 && next <= 0xdfff;
    if (paired) {
      i += 1;
      continue;
    }
    const at = utf16IndexToCodePoint(raw, i);
    add('TYPO006', at, at + 1);
  }

  const hasCurly = /[\u2018\u2019\u201c\u201d]/.test(text);
  const hasStraightQuote = /["]/.test(text);
  if (hasCurly && hasStraightQuote) {
    const at = text.indexOf('"');
    add('TYPO010', utf16IndexToCodePoint(text, at), utf16IndexToCodePoint(text, at) + 1);
  }

  // --- per-code-point scan ----------------------------------------------------------------------

  const brackets: { char: string; at: number }[] = [];
  let straightDoubleQuotes = 0;
  let firstStraightQuote = -1;
  const korean = opts.korean ?? HANGUL.test(text);

  for (let i = 0; i < codePoints.length; i++) {
    const ch = codePoints[i] ?? '';
    const prev = i > 0 ? (codePoints[i - 1] ?? '') : '';
    const next = codePoints[i + 1] ?? '';

    if (ch === '\r') add('TYPO004', i, i + 1);
    else if (DISALLOWED_CONTROL.test(ch)) add('TYPO005', i, i + 1);
    if (ZERO_WIDTH.has(ch)) add('TYPO020', i, i + 1);
    if (EXOTIC_SPACE.has(ch)) add('TYPO016', i, i + 1);

    if (ch === ' ' && next === ' ') {
      // Report the RUN once, at its start, rather than once per extra space: a line of ten spaces is
      // one defect, and ten findings for it would drown the report.
      if (prev !== ' ') {
        let end = i + 1;
        while ((codePoints[end] ?? '') === ' ') end += 1;
        add('TYPO001', i, end);
      }
    }

    if (ch === '\n' && (prev === ' ' || prev === '\t')) {
      let start = i - 1;
      while (start > 0 && ((codePoints[start - 1] ?? '') === ' ' || codePoints[start - 1] === '\t'))
        start -= 1;
      add('TYPO002', start, i);
    }

    if (ch in BRACKET_PAIRS && !CLOSERS.has(ch)) brackets.push({ char: ch, at: i });
    else if (CLOSERS.has(ch)) {
      const open = brackets.pop();
      if (!open || BRACKET_PAIRS[open.char] !== ch) {
        add('TYPO008', i, i + 1);
        // A mismatched closer must not consume an unrelated opener, or one stray `)` would report
        // every later bracket as broken too.
        if (open) brackets.push(open);
      }
    }

    if (ch === '"') {
      straightDoubleQuotes += 1;
      if (firstStraightQuote < 0) firstStraightQuote = i;
    }

    if ((ch === '!' || ch === '?' || ch === ',' || ch === '.') && next === ch) {
      // `...` is its own finding (TYPO014) and `?!` is legitimate; only an exact repeat is reported,
      // and an ellipsis is excluded so it is not double-reported.
      const isEllipsis = ch === '.' && (codePoints[i + 2] ?? '') === '.';
      if (!isEllipsis && prev !== ch) {
        let end = i + 1;
        while ((codePoints[end] ?? '') === ch) end += 1;
        add('TYPO011', i, end);
      }
    }

    if (ch === '.' && next === '.' && (codePoints[i + 2] ?? '') === '.' && prev !== '.')
      add('TYPO014', i, i + 3);

    if (ch === '-' && next === '-' && prev !== '-') {
      let end = i + 1;
      while ((codePoints[end] ?? '') === '-') end += 1;
      add('TYPO015', i, end);
    }

    if (
      ch === ' ' &&
      (next === ',' || next === '.' || next === '!' || next === '?' || next === ';')
    )
      add('TYPO012', i, i + 2);

    // A sentence mark must be followed by a space, a newline, a closing mark or the end of text.
    // A decimal point, an abbreviation (`Mr.`) and an ellipsis are excluded, or every one of them
    // would be a false positive.
    if ((ch === '.' || ch === '!' || ch === '?') && next !== '' && /[A-Za-z]/.test(next)) {
      const digitRun = /[0-9]/.test(prev) && /[0-9]/.test(next);
      const abbreviation = ch === '.' && /[A-Z]/.test(prev) && prev.length === 1;
      const ellipsis = prev === '.' || next === '.';
      if (!digitRun && !abbreviation && !ellipsis) add('TYPO013', i, i + 2);
    }

    if (korean) {
      // A Korean clause immediately followed by a space and then its own punctuation is a spacing
      // defect in Korean, where the mark attaches to the preceding syllable.
      if (ch === ' ' && HANGUL.test(prev) && /[\u3002\uff0c\uff1f\uff01]/.test(next))
        add('TYPO018', i, i + 2);
      // A full-width Korean sentence ending a Hangul clause is conventional; a Latin period after
      // Hangul is reported as INFO only, because mixed-language manuscripts legitimately use both.
      if (ch === '.' && HANGUL.test(prev) && (next === '' || next === '\n' || next === ' '))
        add('TYPO017', i, i + 1);
    }
  }

  for (const open of brackets) add('TYPO008', open.at, open.at + 1);

  if (straightDoubleQuotes % 2 === 1)
    add('TYPO009', firstStraightQuote < 0 ? 0 : firstStraightQuote, firstStraightQuote + 1);

  // An unmatched curly SINGLE opener: more ‘ than ’ means a quotation was opened and never closed,
  // and an apostrophe can only ever add to the CLOSER count, so this direction is unambiguous.
  if (countOf(codePoints, SINGLE_OPEN) > countOf(codePoints, SINGLE_CLOSE))
    add('TYPO009', codePoints.indexOf(SINGLE_OPEN), codePoints.indexOf(SINGLE_OPEN) + 1);

  // --- line-structure checks --------------------------------------------------------------------

  let blankRun = 0;
  let runStart = 0;
  let offset = 0;
  for (const lineText of text.split('\n')) {
    const isBlank = lineText.trim() === '';
    if (isBlank) {
      if (blankRun === 0) runStart = offset;
      blankRun += 1;
    } else {
      if (blankRun > 1) add('TYPO003', runStart, offset);
      blankRun = 0;
    }
    offset += Array.from(lineText).length + 1;
  }
  if (blankRun > 1) add('TYPO003', runStart, codePoints.length);

  // A sentence-ending line immediately followed by another sentence with no blank line between them
  // is a paragraph-separation inconsistency in serialized webnovel formatting, where a blank line is
  // the paragraph boundary. Reported as INFO because a deliberate hard wrap is legal.
  {
    const lines = text.split('\n');
    let at = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      const here = lines[i] ?? '';
      const after = lines[i + 1] ?? '';
      if (/[.!?\u3002\uff01\uff1f]["'\u2019\u201d]?$/.test(here.trim()) && after.trim() !== '')
        add('TYPO019', at, at + Array.from(here).length);
      at += Array.from(here).length + 1;
    }
  }

  findings.sort((a, b) => a.start - b.start || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const counts: Record<TypographySeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return {
    performed: true,
    passed: counts.error === 0,
    findings,
    counts,
    suppressed,
    does_not_replace: 'bilingual human review',
  };
}

function countOf(codePoints: readonly string[], ch: string): number {
  let n = 0;
  for (const c of codePoints) if (c === ch) n += 1;
  return n;
}

/**
 * A stable, bounded digest of a result, for storing in an export manifest.
 *
 * Codes and counts only: the manuscript text never enters a manifest through this path.
 */
export function typographySummary(result: TypographyResult): {
  passed: boolean;
  errors: number;
  warnings: number;
  infos: number;
  codes: string[];
} {
  return {
    passed: result.passed,
    errors: result.counts.error,
    warnings: result.counts.warning,
    infos: result.counts.info,
    codes: [...new Set(result.findings.map((f) => f.code))].sort(),
  };
}
