/**
 * Deterministic typography checks: what they catch, what they must NOT claim, and the false positives
 * they are specifically shaped to avoid.
 *
 * The false-positive cases carry as much weight as the detection cases. A mechanical checker that
 * flags an ordinary apostrophe, a decimal point or an abbreviation is one that operators learn to
 * ignore, and an ignored checker catches nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  checkTypography,
  SEVERITY_OF,
  typographySummary,
  TYPOGRAPHY_CODES,
  type TypographyCode,
} from './typography.js';

const codesOf = (text: string, opts = {}): TypographyCode[] => [
  ...new Set(checkTypography(text, opts).findings.map((f) => f.code)),
];

describe('deterministic typography checks', () => {
  it('accepts clean English webnovel prose with no findings at error severity', () => {
    const text = 'The blade moved first.\n\nShe did not.\n';
    const result = checkTypography(text);
    expect(result.passed).toBe(true);
    expect(result.counts.error).toBe(0);
  });

  it('declares that it does not replace bilingual human review', () => {
    // The claim boundary is part of the RESULT, so no caller can present a pass as a quality verdict.
    expect(checkTypography('x').does_not_replace).toBe('bilingual human review');
  });

  it('is deterministic: the same input yields an identical finding array', () => {
    const text = 'He  said "wait ... ??\n \nThen  (nothing.\n';
    expect(checkTypography(text).findings).toEqual(checkTypography(text).findings);
  });

  it('every declared code has a severity and every severity is a known value', () => {
    for (const code of TYPOGRAPHY_CODES) {
      expect(['error', 'warning', 'info']).toContain(SEVERITY_OF[code]);
    }
  });

  // --- whitespace and line structure -------------------------------------------------------------

  it('reports a repeated space once per run, not once per extra space', () => {
    const findings = checkTypography('a      b\n').findings.filter((f) => f.code === 'TYPO001');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.start).toBe(1);
    // Six spaces occupy code points 1..6, so the exclusive end is 7.
    expect(findings[0]?.end).toBe(7);
  });

  it('reports trailing whitespace and more than one consecutive blank line', () => {
    const codes = codesOf('a   \n\n\n\nb\n');
    expect(codes).toContain('TYPO002');
    expect(codes).toContain('TYPO003');
  });

  it('does not report a single blank paragraph separator as excessive', () => {
    expect(codesOf('one.\n\ntwo.\n')).not.toContain('TYPO003');
  });

  it('reports a CR as an invalid line ending at error severity', () => {
    const result = checkTypography('a\r\nb\n');
    expect(result.passed).toBe(false);
    expect(codesOf('a\r\nb\n')).toContain('TYPO004');
  });

  // --- Unicode and encoding -----------------------------------------------------------------------

  it('reports a disallowed control character and a zero-width character', () => {
    expect(codesOf('a\u0007b\n')).toContain('TYPO005');
    expect(codesOf('a\u200bb\n')).toContain('TYPO020');
  });

  it('reports an unpaired surrogate as broken Unicode', () => {
    expect(codesOf('a\ud800b\n')).toContain('TYPO006');
  });

  it('does not report a correctly paired surrogate (an emoji or a rare CJK ideograph)', () => {
    expect(codesOf('a \u{1f5e1}\u{fe0f} b.\n')).not.toContain('TYPO006');
    expect(codesOf('\u{20000}\n')).not.toContain('TYPO006');
  });

  it('reports text that is not NFC-normalized', () => {
    // Decomposed "é": U+0065 U+0301.
    expect(codesOf('cafe\u0301\n')).toContain('TYPO007');
    expect(codesOf('caf\u00e9\n')).not.toContain('TYPO007');
  });

  it('offsets are code-point indices, so an astral character does not shift a later finding', () => {
    const result = checkTypography('\u{1f5e1}  x\n');
    const doubled = result.findings.find((f) => f.code === 'TYPO001');
    // One code point for the sword, so the doubled space starts at index 1 rather than 2.
    expect(doubled?.start).toBe(1);
  });

  it('reports a non-breaking space as an unusual space character', () => {
    expect(codesOf('a\u00a0b\n')).toContain('TYPO016');
  });

  // --- brackets and quotation marks ---------------------------------------------------------------

  it('reports an unclosed bracket and a mismatched pair', () => {
    expect(codesOf('a (b\n')).toContain('TYPO008');
    expect(codesOf('a (b]\n')).toContain('TYPO008');
  });

  it('accepts nested and Korean-style brackets that are correctly balanced', () => {
    expect(codesOf('a ([b] {c}) \u300cd\u300d \u300ee\u300f\n')).not.toContain('TYPO008');
  });

  it('never treats an apostrophe as an unmatched bracket', () => {
    // The false positive that would have made this checker unusable on real English prose: U+2019 is
    // the apostrophe in every contraction and possessive.
    const prose = 'He didn\u2019t look. He knew the man\u2019s name and the guild\u2019s reach.\n';
    expect(codesOf(prose)).not.toContain('TYPO008');
    expect(checkTypography(prose).counts.error).toBe(0);
  });

  it('still reports a curly single quotation that was opened and never closed', () => {
    expect(codesOf('She said \u2018wait and see.\n')).toContain('TYPO009');
  });

  it('a single stray closer does not cascade into later brackets', () => {
    const findings = checkTypography('a) (b) (c)\n').findings.filter((f) => f.code === 'TYPO008');
    expect(findings).toHaveLength(1);
  });

  it('reports an odd number of straight double quotes', () => {
    expect(codesOf('He said "wait.\n')).toContain('TYPO009');
    expect(codesOf('He said "wait".\n')).not.toContain('TYPO009');
  });

  it('does not treat an English apostrophe as an unbalanced curly quote', () => {
    // ’ is the apostrophe in "didn’t"; an imbalance in that direction is not a defect.
    expect(codesOf('She didn\u2019t move. It wasn\u2019t time.\n')).not.toContain('TYPO009');
  });

  it('reports straight and curly quotes mixed in one text', () => {
    expect(codesOf('\u201cyes,\u201d he said, "no."\n')).toContain('TYPO010');
  });

  // --- punctuation ---------------------------------------------------------------------------------

  it('reports repeated punctuation and a space before a closing mark', () => {
    expect(codesOf('What!!! Really ?\n')).toContain('TYPO011');
    expect(codesOf('What !\n')).toContain('TYPO012');
  });

  it('does not report the legitimate interrobang sequence "?!"', () => {
    expect(codesOf('What?! she said.\n')).not.toContain('TYPO011');
  });

  it('reports three dots as an ellipsis substitute at info severity only', () => {
    const result = checkTypography('wait...\n');
    expect(result.passed).toBe(true);
    expect(codesOf('wait...\n')).toContain('TYPO014');
    expect(codesOf('wait\u2026\n')).not.toContain('TYPO014');
  });

  it('reports a missing space after sentence punctuation', () => {
    expect(codesOf('He left.She stayed.\n')).toContain('TYPO013');
  });

  it('does not report a decimal number, an initial, or an ellipsis as a missing space', () => {
    expect(codesOf('It cost 3.5 credits.\n')).not.toContain('TYPO013');
    expect(codesOf('J.R. arrived.\n')).not.toContain('TYPO013');
    expect(codesOf('wait...then go.\n')).not.toContain('TYPO013');
  });

  it('reports a double hyphen used as a dash, at info severity', () => {
    expect(codesOf('wait--no.\n')).toContain('TYPO015');
    expect(SEVERITY_OF.TYPO015).toBe('info');
  });

  // --- Korean and mixed-language fixtures ----------------------------------------------------------

  it('accepts well-formed Korean terminology prose without error findings', () => {
    const korean =
      '\uc0ac\uc774\ub2e4 \uad6c\uc870\ub294 \ubcf4\ubcf5\uc758 \ud575\uc2ec\uc774\ub2e4\u3002\n';
    expect(checkTypography(korean).counts.error).toBe(0);
  });

  it('reports a space between Korean text and its attached punctuation', () => {
    expect(codesOf('\uc0ac\uc774\ub2e4 \u3002\n')).toContain('TYPO018');
  });

  it('reports a Latin period after Hangul at info severity only, never as an error', () => {
    const result = checkTypography('\ud68c\uadc0.\n');
    expect(codesOf('\ud68c\uadc0.\n')).toContain('TYPO017');
    expect(result.counts.error).toBe(0);
  });

  it('applies Korean rules only when Korean is present, unless explicitly requested', () => {
    expect(codesOf('Regression.\n')).not.toContain('TYPO017');
    // A glossed English term next to Korean is a mixed-language fixture: both rule sets apply.
    const mixed = 'The \uc0ac\uc774\ub2e4 (catharsis) beat lands here.\n';
    expect(checkTypography(mixed).counts.error).toBe(0);
  });

  it('a mixed-language line with a real defect is still caught', () => {
    const mixed = 'The \ud68c\uadc0  (regression) beat  lands here.\n';
    expect(codesOf(mixed)).toContain('TYPO001');
  });

  // --- suppression ----------------------------------------------------------------------------------

  it('suppresses a documented code and records that it was suppressed', () => {
    const result = checkTypography('a  b\n', { suppress: ['TYPO001'] });
    expect(result.findings.map((f) => f.code)).not.toContain('TYPO001');
    expect(result.suppressed).toEqual(['TYPO001']);
  });

  it('suppression cannot turn a failing check into a pass for an unsuppressed error', () => {
    const result = checkTypography('a\r\n', { suppress: ['TYPO001'] });
    expect(result.passed).toBe(false);
  });

  // --- reporting --------------------------------------------------------------------------------------

  it('every finding carries a code, a severity, a location and a safe message', () => {
    for (const finding of checkTypography('a  b\r\n(x\n').findings) {
      expect(TYPOGRAPHY_CODES).toContain(finding.code);
      expect(finding.line).toBeGreaterThan(0);
      expect(finding.column).toBeGreaterThan(0);
      expect(finding.start).toBeGreaterThanOrEqual(0);
      expect(finding.message.length).toBeLessThan(120);
    }
  });

  it('findings are ordered by position, so two runs produce the same report', () => {
    const findings = checkTypography('a  b\r\n(x\n').findings;
    const starts = findings.map((f) => f.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('the summary carries codes and counts and no manuscript text', () => {
    const summary = typographySummary(checkTypography('secret  words here\n'));
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(summary.codes).toContain('TYPO001');
  });

  it('handles an empty text and a text of only whitespace without throwing', () => {
    expect(checkTypography('').findings).toEqual([]);
    expect(() => checkTypography('   \n\n\n')).not.toThrow();
  });
});
