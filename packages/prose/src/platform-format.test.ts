/**
 * Offline platform-format validation.
 *
 * The two things this suite exists to pin down are the refusals and the claim boundary: every
 * supported rule must be able to refuse, and a passing result must still say `not_verified` about
 * external acceptance, because nothing here contacts a platform.
 */
import { describe, expect, it } from 'vitest';
import {
  checkPlatformFormat,
  parseProfile,
  PLATFORM_PROFILES,
  PlatformProfileError,
  resolveProfile,
  type PlatformCheckInput,
  type PlatformProfile,
} from './platform-format.js';

const serial = resolveProfile('serial_web', '1.0');
const generic = resolveProfile('generic', '1.0');

/** A chapter long enough to satisfy the serial profile's 500-code-point minimum. */
function body(seed: string): string {
  const paragraph = `${seed} The blade moved before the thought did, and the room answered.`;
  const parts: string[] = [];
  while (parts.join('\n\n').length < 700) parts.push(paragraph);
  return parts.join('\n\n');
}

function validInput(overrides: Partial<PlatformCheckInput> = {}): PlatformCheckInput {
  return {
    metadata: {
      title: 'The Quiet Blade',
      author: 'Yeonjae Studio',
      language: 'en',
      ai_assistance_disclosure: 'Drafted with AI assistance and reviewed before release.',
    },
    chapters: [
      { chapter_no: 1, text: body('one.') },
      { chapter_no: 2, text: body('two.') },
    ],
    assets: [{ filename: 'cover-notes.txt', bytes: 12, present: true }],
    manifestFields: [
      'manifest_version',
      'project_id',
      'chapters',
      'content_hash',
      'external_identifier',
    ],
    identifier: 'quiet-blade-0001',
    totalBytes: 4096,
    ...overrides,
  };
}

const codes = (input: PlatformCheckInput, profile: PlatformProfile = serial): string[] => [
  ...new Set(checkPlatformFormat(profile, input).findings.map((f) => f.code)),
];

describe('offline platform-format validation', () => {
  it('accepts valid output against the stricter bundled profile', () => {
    const result = checkPlatformFormat(serial, validInput());
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('never claims that a real platform accepted the content', () => {
    // A pass and a failure must BOTH say the same thing about external acceptance.
    expect(checkPlatformFormat(serial, validInput()).external_acceptance).toBe('not_verified');
    expect(checkPlatformFormat(serial, validInput({ chapters: [] })).external_acceptance).toBe(
      'not_verified',
    );
  });

  it('is deterministic and reports findings in a stable order', () => {
    const input = validInput({ chapters: [{ chapter_no: 1, text: 'short' }], identifier: 'x' });
    expect(checkPlatformFormat(serial, input).findings).toEqual(
      checkPlatformFormat(serial, input).findings,
    );
  });

  // --- every supported refusal --------------------------------------------------------------------

  it('refuses missing required metadata (PF001) and an empty title (PF019)', () => {
    const found = codes(validInput({ metadata: { title: '   ', author: 'a', language: 'en' } }));
    expect(found).toContain('PF001');
    expect(found).toContain('PF019');
  });

  it('refuses metadata longer than the profile allows (PF002)', () => {
    expect(
      codes(validInput({ metadata: { ...validInput().metadata, author: 'a'.repeat(400) } })),
    ).toContain('PF002');
  });

  it('refuses a prohibited metadata field, so a prompt or key cannot ride along', () => {
    const found = codes(
      validInput({ metadata: { ...validInput().metadata, api_key: 'FAKE-NOT-A-KEY' } }),
    );
    expect(found).toContain('PF001');
  });

  it('refuses an empty chapter list (PF003)', () => {
    expect(codes(validInput({ chapters: [] }))).toContain('PF003');
  });

  it('refuses out-of-order, non-contiguous and duplicate chapters (PF004, PF005)', () => {
    expect(
      codes(
        validInput({
          chapters: [
            { chapter_no: 2, text: body('a') },
            { chapter_no: 1, text: body('b') },
          ],
        }),
      ),
    ).toContain('PF004');
    expect(
      codes(
        validInput({
          chapters: [
            { chapter_no: 1, text: body('a') },
            { chapter_no: 5, text: body('b') },
          ],
        }),
      ),
    ).toContain('PF004');
    expect(
      codes(
        validInput({
          chapters: [
            { chapter_no: 1, text: body('a') },
            { chapter_no: 1, text: body('b') },
          ],
        }),
      ),
    ).toContain('PF005');
  });

  it('refuses chapters below and above the length window (PF006, PF007)', () => {
    expect(codes(validInput({ chapters: [{ chapter_no: 1, text: 'too short' }] }))).toContain(
      'PF006',
    );
    expect(
      codes(validInput({ chapters: [{ chapter_no: 1, text: 'a'.repeat(50_000) }] })),
    ).toContain('PF007');
  });

  it('refuses characters outside the encoding restriction (PF008)', () => {
    // The serial profile is BMP-only, so an astral code point is refused.
    expect(
      codes(validInput({ chapters: [{ chapter_no: 1, text: `${body('a')}\u{1f5e1}` }] })),
    ).toContain('PF008');
    // The generic profile has no such restriction.
    expect(
      codes({ ...validInput(), chapters: [{ chapter_no: 1, text: `ok \u{1f5e1}` }] }, generic),
    ).not.toContain('PF008');
  });

  it('refuses a prohibited control character (PF009)', () => {
    expect(
      codes(validInput({ chapters: [{ chapter_no: 1, text: `${body('a')}\u0007` }] })),
    ).toContain('PF009');
  });

  it('warns about paragraph separation and over-long lines without failing on its own', () => {
    const result = checkPlatformFormat(generic, {
      metadata: { title: 'T' },
      chapters: [{ chapter_no: 1, text: 'one\ntwo' }],
      manifestFields: ['manifest_version', 'project_id', 'chapters', 'content_hash'],
    });
    expect(result.findings.map((f) => f.code)).toContain('PF010');
    // A warning alone does not fail the check.
    expect(result.passed).toBe(true);
  });

  it('refuses a missing or malformed required identifier (PF012)', () => {
    expect(codes(validInput({ identifier: undefined }))).toContain('PF012');
    expect(codes(validInput({ identifier: 'no spaces allowed' }))).toContain('PF012');
  });

  it('refuses missing assets, unsupported types, duplicates and non-deterministic names', () => {
    expect(
      codes(validInput({ assets: [{ filename: 'gone.txt', bytes: 1, present: false }] })),
    ).toContain('PF013');
    expect(
      codes(validInput({ assets: [{ filename: 'cover.png', bytes: 1, present: true }] })),
    ).toContain('PF014');
    expect(
      codes(
        validInput({
          assets: [
            { filename: 'a.txt', bytes: 1, present: true },
            { filename: 'a.txt', bytes: 1, present: true },
          ],
        }),
      ),
    ).toContain('PF015');
    expect(
      codes(validInput({ assets: [{ filename: 'Cover Notes.txt', bytes: 1, present: true }] })),
    ).toContain('PF016');
  });

  it('refuses a package above the size limit (PF017)', () => {
    expect(codes(validInput({ totalBytes: 50 * 1024 * 1024 }))).toContain('PF017');
  });

  it('refuses a manifest missing a required field (PF018)', () => {
    expect(codes(validInput({ manifestFields: ['manifest_version'] }))).toContain('PF018');
  });

  it('refuses content carrying a typography error the platform rejects (PF020)', () => {
    expect(
      codes(
        validInput({ chapters: [{ chapter_no: 1, text: body('a').replace('\n\n', '\r\n\r\n') }] }),
      ),
    ).toContain('PF020');
  });

  // --- configuration handling ---------------------------------------------------------------------

  it('refuses an unknown platform and an unknown rules version safely', () => {
    expect(() => resolveProfile('no_such_platform', '1.0')).toThrow(PlatformProfileError);
    try {
      resolveProfile('serial_web', '9.9');
      expect.unreachable('an unknown rules version must be refused');
    } catch (err) {
      expect((err as PlatformProfileError).code).toBe('UNKNOWN_RULES_VERSION');
    }
  });

  it('refuses a malformed profile rather than defaulting to another platform’s rules', () => {
    expect(() => parseProfile(null)).toThrow(PlatformProfileError);
    expect(() => parseProfile({ platform_id: 'x' })).toThrow(PlatformProfileError);
    expect(() => parseProfile({ ...PLATFORM_PROFILES[0], filename_pattern: '([unclosed' })).toThrow(
      PlatformProfileError,
    );
  });

  it('refuses a self-contradictory profile as a CONFIGURATION defect, not a content defect', () => {
    try {
      parseProfile({
        ...PLATFORM_PROFILES[0],
        min_chapter_codepoints: 9_000,
        max_chapter_codepoints: 10,
      });
      expect.unreachable('a conflicting profile must be refused');
    } catch (err) {
      expect((err as PlatformProfileError).code).toBe('PROFILE_CONFLICT');
    }
    try {
      parseProfile({
        ...PLATFORM_PROFILES[0],
        required_metadata: ['title'],
        prohibited_metadata: ['title'],
      });
      expect.unreachable('a field both required and prohibited must be refused');
    } catch (err) {
      expect((err as PlatformProfileError).code).toBe('PROFILE_CONFLICT');
    }
  });

  it('accepts a well-formed operator-supplied profile', () => {
    const profile = parseProfile({ ...PLATFORM_PROFILES[0], platform_id: 'house_style' });
    expect(profile.platform_id).toBe('house_style');
    expect(resolveProfile('house_style', '1.0', [profile]).display_name).toBeTruthy();
  });

  it('every bundled profile is internally coherent', () => {
    for (const profile of PLATFORM_PROFILES) {
      expect(() => resolveProfile(profile.platform_id, profile.rules_version)).not.toThrow();
    }
  });

  it('findings carry an exact location and no manuscript text', () => {
    const result = checkPlatformFormat(serial, {
      ...validInput(),
      chapters: [{ chapter_no: 7, text: 'a secret phrase that must not be echoed' }],
    });
    expect(result.findings.some((f) => f.location === 'chapter.7')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret phrase');
  });
});
