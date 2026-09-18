/**
 * Offline publishing-platform FORMAT validation.
 *
 * WHAT THIS IS, STATED PRECISELY. It checks a prepared output against a locally stored, versioned
 * description of a platform's mechanical requirements. It is OFFLINE: nothing is uploaded, no platform
 * is contacted, and a pass here is NOT evidence that any real platform accepted anything. Acceptance
 * by a real platform is an external event this repository cannot observe, and the result type says so
 * in a field (`external_acceptance`) rather than in a comment, so no caller can quietly imply
 * otherwise.
 *
 * WHY THE RULES ARE CONFIGURATION AND NOT CODE. Platform requirements change without warning, and a
 * rule compiled into a function is a rule nobody can audit, diff or pin. Each profile is therefore a
 * versioned data object with an explicit `rules_version`; an unknown or malformed version is REFUSED
 * rather than defaulted, because silently falling back to a different platform's rules would produce a
 * confident, wrong pass.
 *
 * CONFLICTING RULES. A profile whose own rules contradict each other (a minimum length above its
 * maximum, a required field also listed as prohibited) is a configuration defect, not a content defect.
 * It is reported as `PROFILE_CONFLICT` at load time so the conflict cannot be blamed on the manuscript.
 */
import { checkTypography, type TypographySeverity } from './typography.js';

export const PLATFORM_RULES_VERSIONS = ['1.0'] as const;
export type PlatformRulesVersion = (typeof PLATFORM_RULES_VERSIONS)[number];

/** Stable rule codes. Closed: an unknown code cannot be produced. */
export const PLATFORM_CODES = [
  'PF001', // missing required metadata field
  'PF002', // metadata field exceeds its maximum length
  'PF003', // no chapters
  'PF004', // chapter numbers are not a contiguous ascending run
  'PF005', // duplicate chapter number
  'PF006', // chapter body below the minimum length
  'PF007', // chapter body above the maximum length
  'PF008', // disallowed character for the platform's encoding restriction
  'PF009', // prohibited control character
  'PF010', // paragraph separation does not match the platform's rule
  'PF011', // line longer than the platform's maximum
  'PF012', // required identifier missing or malformed
  'PF013', // referenced asset is missing
  'PF014', // unsupported asset file type
  'PF015', // duplicate filename in the package
  'PF016', // filename is not the platform's deterministic form
  'PF017', // total output size above the platform's limit
  'PF018', // required manifest field missing
  'PF019', // title is empty or whitespace only
  'PF020', // a typography error-severity finding the platform rejects
] as const;
export type PlatformCode = (typeof PLATFORM_CODES)[number];

export type PlatformSeverity = 'error' | 'warning';

export interface PlatformFinding {
  readonly code: PlatformCode;
  readonly severity: PlatformSeverity;
  /** Exactly where: a chapter number, a metadata field name, or a filename. Never manuscript text. */
  readonly location: string;
  readonly message: string;
}

export interface PlatformProfile {
  readonly platform_id: string;
  readonly rules_version: PlatformRulesVersion;
  readonly display_name: string;
  readonly required_metadata: readonly string[];
  readonly prohibited_metadata: readonly string[];
  readonly max_metadata_length: number;
  readonly min_chapter_codepoints: number;
  readonly max_chapter_codepoints: number;
  readonly max_line_codepoints: number;
  readonly require_contiguous_chapters: boolean;
  readonly paragraph_separator: 'blank_line' | 'single_newline';
  /** Character classes the platform refuses. `non_ascii` is common for legacy ingestion pipelines. */
  readonly character_restriction: 'none' | 'no_control' | 'ascii_only' | 'bmp_only';
  readonly required_identifier_pattern: string | null;
  readonly allowed_asset_extensions: readonly string[];
  readonly max_total_bytes: number;
  readonly required_manifest_fields: readonly string[];
  readonly filename_pattern: string;
  /** Typography severities the platform treats as hard refusals. */
  readonly rejects_typography: readonly TypographySeverity[];
}

/**
 * The bundled profiles.
 *
 * `generic.v1` is deliberately permissive and is what an unprofiled export is checked against;
 * `serial_web.v1` models the stricter mechanical constraints a serialized web platform typically
 * imposes (per-chapter length windows, no control characters, deterministic filenames).
 */
export const PLATFORM_PROFILES: readonly PlatformProfile[] = [
  {
    platform_id: 'generic',
    rules_version: '1.0',
    display_name: 'Generic offline format profile',
    required_metadata: ['title'],
    prohibited_metadata: [],
    max_metadata_length: 500,
    min_chapter_codepoints: 1,
    max_chapter_codepoints: 500_000,
    max_line_codepoints: 100_000,
    require_contiguous_chapters: false,
    paragraph_separator: 'blank_line',
    character_restriction: 'no_control',
    required_identifier_pattern: null,
    allowed_asset_extensions: ['.txt', '.json', '.md'],
    max_total_bytes: 200 * 1024 * 1024,
    required_manifest_fields: ['manifest_version', 'project_id', 'chapters', 'content_hash'],
    filename_pattern: '^[a-z0-9][a-z0-9._-]{0,80}$',
    rejects_typography: ['error'],
  },
  {
    platform_id: 'serial_web',
    rules_version: '1.0',
    display_name: 'Serialized web platform offline format profile',
    required_metadata: ['title', 'author', 'language', 'ai_assistance_disclosure'],
    prohibited_metadata: ['provider_response', 'prompt', 'api_key'],
    max_metadata_length: 200,
    min_chapter_codepoints: 500,
    max_chapter_codepoints: 40_000,
    max_line_codepoints: 5_000,
    require_contiguous_chapters: true,
    paragraph_separator: 'blank_line',
    character_restriction: 'bmp_only',
    required_identifier_pattern: '^[A-Za-z0-9-]{4,64}$',
    allowed_asset_extensions: ['.txt', '.json'],
    max_total_bytes: 20 * 1024 * 1024,
    required_manifest_fields: [
      'manifest_version',
      'project_id',
      'chapters',
      'content_hash',
      'external_identifier',
    ],
    filename_pattern: '^[a-z0-9][a-z0-9._-]{0,80}$',
    rejects_typography: ['error'],
  },
];

export class PlatformProfileError extends Error {
  constructor(
    readonly code:
      'UNKNOWN_PLATFORM' | 'UNKNOWN_RULES_VERSION' | 'PROFILE_MALFORMED' | 'PROFILE_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'PlatformProfileError';
  }
}

/**
 * Resolve a profile, refusing anything it cannot validate against.
 *
 * The refusals are the feature: an unknown platform, an unknown rules version and a self-contradictory
 * profile all fail here, so a caller can never reach content validation with rules it does not
 * understand.
 */
export function resolveProfile(
  platformId: string,
  rulesVersion: string,
  extra: readonly PlatformProfile[] = [],
): PlatformProfile {
  if (!PLATFORM_RULES_VERSIONS.includes(rulesVersion as PlatformRulesVersion))
    throw new PlatformProfileError(
      'UNKNOWN_RULES_VERSION',
      `rules version ${rulesVersion} is not supported`,
    );
  const all = [...PLATFORM_PROFILES, ...extra];
  const profile = all.find((p) => p.platform_id === platformId && p.rules_version === rulesVersion);
  if (!profile)
    throw new PlatformProfileError('UNKNOWN_PLATFORM', `no profile for platform ${platformId}`);
  assertProfileCoherent(profile);
  return profile;
}

/** A profile whose rules contradict each other is a configuration defect, reported as such. */
export function assertProfileCoherent(profile: PlatformProfile): void {
  if (profile.min_chapter_codepoints > profile.max_chapter_codepoints)
    throw new PlatformProfileError(
      'PROFILE_CONFLICT',
      'min_chapter_codepoints exceeds max_chapter_codepoints',
    );
  const both = profile.required_metadata.filter((f) => profile.prohibited_metadata.includes(f));
  if (both.length > 0)
    throw new PlatformProfileError(
      'PROFILE_CONFLICT',
      `metadata field(s) both required and prohibited: ${both.sort().join(', ')}`,
    );
  if (profile.max_metadata_length <= 0 || profile.max_total_bytes <= 0)
    throw new PlatformProfileError('PROFILE_MALFORMED', 'a size limit is not positive');
  for (const pattern of [profile.filename_pattern, profile.required_identifier_pattern]) {
    if (pattern === null) continue;
    try {
      new RegExp(pattern);
    } catch {
      throw new PlatformProfileError(
        'PROFILE_MALFORMED',
        'a rule pattern is not a valid expression',
      );
    }
  }
}

/** Validate an arbitrary object as a profile, so an operator-supplied one cannot be trusted blindly. */
export function parseProfile(raw: unknown): PlatformProfile {
  if (typeof raw !== 'object' || raw === null)
    throw new PlatformProfileError('PROFILE_MALFORMED', 'the profile is not an object');
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v === '')
      throw new PlatformProfileError('PROFILE_MALFORMED', `${k} must be a non-empty string`);
    return v;
  };
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v))
      throw new PlatformProfileError('PROFILE_MALFORMED', `${k} must be an integer`);
    return v;
  };
  const arr = (k: string): string[] => {
    const v = o[k];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
      throw new PlatformProfileError('PROFILE_MALFORMED', `${k} must be an array of strings`);
    return v as string[];
  };
  const version = str('rules_version');
  if (!PLATFORM_RULES_VERSIONS.includes(version as PlatformRulesVersion))
    throw new PlatformProfileError(
      'UNKNOWN_RULES_VERSION',
      `rules version ${version} is not supported`,
    );
  const separator = str('paragraph_separator');
  if (separator !== 'blank_line' && separator !== 'single_newline')
    throw new PlatformProfileError('PROFILE_MALFORMED', 'paragraph_separator is not a known value');
  const restriction = str('character_restriction');
  if (!['none', 'no_control', 'ascii_only', 'bmp_only'].includes(restriction))
    throw new PlatformProfileError(
      'PROFILE_MALFORMED',
      'character_restriction is not a known value',
    );
  const identifier = o.required_identifier_pattern;
  if (identifier !== null && typeof identifier !== 'string')
    throw new PlatformProfileError(
      'PROFILE_MALFORMED',
      'required_identifier_pattern must be a string or null',
    );
  const profile: PlatformProfile = {
    platform_id: str('platform_id'),
    rules_version: version as PlatformRulesVersion,
    display_name: str('display_name'),
    required_metadata: arr('required_metadata'),
    prohibited_metadata: arr('prohibited_metadata'),
    max_metadata_length: num('max_metadata_length'),
    min_chapter_codepoints: num('min_chapter_codepoints'),
    max_chapter_codepoints: num('max_chapter_codepoints'),
    max_line_codepoints: num('max_line_codepoints'),
    require_contiguous_chapters: o.require_contiguous_chapters === true,
    paragraph_separator: separator,
    character_restriction: restriction as PlatformProfile['character_restriction'],
    required_identifier_pattern: identifier,
    allowed_asset_extensions: arr('allowed_asset_extensions'),
    max_total_bytes: num('max_total_bytes'),
    required_manifest_fields: arr('required_manifest_fields'),
    filename_pattern: str('filename_pattern'),
    rejects_typography: arr('rejects_typography') as TypographySeverity[],
  };
  assertProfileCoherent(profile);
  return profile;
}

export interface PlatformCheckChapter {
  readonly chapter_no: number;
  readonly text: string;
}

export interface PlatformCheckInput {
  readonly metadata: Readonly<Record<string, string>>;
  readonly chapters: readonly PlatformCheckChapter[];
  readonly assets?:
    | readonly { readonly filename: string; readonly bytes: number; readonly present: boolean }[]
    | undefined;
  readonly manifestFields?: readonly string[] | undefined;
  readonly identifier?: string | undefined;
  readonly totalBytes?: number | undefined;
}

export interface PlatformCheckResult {
  readonly performed: true;
  readonly platform_id: string;
  readonly rules_version: PlatformRulesVersion;
  /** True when there is no error-severity finding. Warnings never block on their own. */
  readonly passed: boolean;
  readonly findings: readonly PlatformFinding[];
  readonly errors: number;
  readonly warnings: number;
  /**
   * Always `not_verified`. Offline validation cannot observe a platform's decision, and a field that
   * always says so is harder to misread than a comment.
   */
  readonly external_acceptance: 'not_verified';
}

/** Validate prepared output against a resolved profile. Deterministic and offline. */
export function checkPlatformFormat(
  profile: PlatformProfile,
  input: PlatformCheckInput,
): PlatformCheckResult {
  const findings: PlatformFinding[] = [];
  const add = (
    code: PlatformCode,
    severity: PlatformSeverity,
    location: string,
    message: string,
  ): void => {
    findings.push({ code, severity, location, message });
  };

  // --- metadata ----------------------------------------------------------------------------------
  for (const field of [...profile.required_metadata].sort()) {
    const value = input.metadata[field];
    if (value === undefined || value.trim() === '')
      add('PF001', 'error', `metadata.${field}`, 'A required metadata field is missing or empty.');
  }
  if ((input.metadata.title ?? '').trim() === '')
    add('PF019', 'error', 'metadata.title', 'The title is empty.');
  for (const [field, value] of [...Object.entries(input.metadata)].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (Array.from(value).length > profile.max_metadata_length)
      add('PF002', 'error', `metadata.${field}`, 'A metadata field exceeds its maximum length.');
    if (profile.prohibited_metadata.includes(field))
      add('PF001', 'error', `metadata.${field}`, 'A prohibited metadata field is present.');
  }

  // --- chapters ----------------------------------------------------------------------------------
  if (input.chapters.length === 0) add('PF003', 'error', 'chapters', 'The output has no chapters.');

  const numbers = input.chapters.map((c) => c.chapter_no);
  const seen = new Set<number>();
  for (const n of numbers) {
    if (seen.has(n)) add('PF005', 'error', `chapter.${String(n)}`, 'Duplicate chapter number.');
    seen.add(n);
  }
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ordered = numbers.every((n, i) => i === 0 || n > (numbers[i - 1] ?? -Infinity));
  if (!ordered) add('PF004', 'error', 'chapters', 'Chapters are not in ascending order.');
  if (profile.require_contiguous_chapters && sorted.length > 0) {
    const first = sorted[0] ?? 0;
    const contiguous = sorted.every((n, i) => n === first + i);
    if (!contiguous) add('PF004', 'error', 'chapters', 'Chapter numbers are not contiguous.');
  }

  for (const chapter of [...input.chapters].sort((a, b) => a.chapter_no - b.chapter_no)) {
    const where = `chapter.${String(chapter.chapter_no)}`;
    const points = Array.from(chapter.text);
    if (points.length < profile.min_chapter_codepoints)
      add('PF006', 'error', where, 'The chapter is shorter than the platform allows.');
    if (points.length > profile.max_chapter_codepoints)
      add('PF007', 'error', where, 'The chapter is longer than the platform allows.');

    for (const ch of points) {
      const code = ch.codePointAt(0) ?? 0;
      const isControl = (code < 0x20 && ch !== '\n' && ch !== '\t') || code === 0x7f;
      if (isControl) {
        add('PF009', 'error', where, 'The chapter contains a prohibited control character.');
        break;
      }
    }
    if (profile.character_restriction === 'ascii_only' && /[^\x20-\x7e\n\t]/.test(chapter.text))
      add('PF008', 'error', where, 'The chapter contains characters outside the allowed set.');
    if (
      profile.character_restriction === 'bmp_only' &&
      points.some((c) => (c.codePointAt(0) ?? 0) > 0xffff)
    )
      add('PF008', 'error', where, 'The chapter contains characters outside the allowed set.');

    for (const lineText of chapter.text.split('\n')) {
      if (Array.from(lineText).length > profile.max_line_codepoints) {
        add('PF011', 'warning', where, 'A line is longer than the platform recommends.');
        break;
      }
    }

    if (profile.paragraph_separator === 'blank_line' && /[^\n]\n[^\n]/.test(chapter.text))
      add('PF010', 'warning', where, 'Paragraphs are not separated by a blank line.');
    if (profile.paragraph_separator === 'single_newline' && /\n\s*\n/.test(chapter.text))
      add('PF010', 'warning', where, 'Paragraphs are separated by more than one newline.');

    if (profile.rejects_typography.length > 0) {
      const typo = checkTypography(chapter.text);
      const rejected = typo.findings.filter((f) => profile.rejects_typography.includes(f.severity));
      if (rejected.length > 0)
        add('PF020', 'error', where, 'The chapter has typography findings this platform refuses.');
    }
  }

  // --- identifier, assets, filenames, size, manifest ---------------------------------------------
  if (profile.required_identifier_pattern !== null) {
    const identifier = input.identifier ?? '';
    if (!new RegExp(profile.required_identifier_pattern).test(identifier))
      add('PF012', 'error', 'identifier', 'The required identifier is missing or malformed.');
  }

  const filenames = new Set<string>();
  const filenameRe = new RegExp(profile.filename_pattern);
  for (const asset of [...(input.assets ?? [])].sort((a, b) =>
    a.filename < b.filename ? -1 : 1,
  )) {
    const where = `asset.${asset.filename}`;
    if (!asset.present) add('PF013', 'error', where, 'A referenced asset is missing.');
    const dot = asset.filename.lastIndexOf('.');
    const ext = dot < 0 ? '' : asset.filename.slice(dot).toLowerCase();
    if (!profile.allowed_asset_extensions.includes(ext))
      add('PF014', 'error', where, 'The asset file type is not supported.');
    if (filenames.has(asset.filename))
      add('PF015', 'error', where, 'A filename appears more than once in the package.');
    filenames.add(asset.filename);
    if (!filenameRe.test(asset.filename))
      add('PF016', 'error', where, 'The filename is not in the platform’s deterministic form.');
  }

  if ((input.totalBytes ?? 0) > profile.max_total_bytes)
    add('PF017', 'error', 'package', 'The package is larger than the platform allows.');

  const present = new Set(input.manifestFields ?? []);
  for (const field of [...profile.required_manifest_fields].sort()) {
    if (!present.has(field))
      add('PF018', 'error', `manifest.${field}`, 'A required manifest field is missing.');
  }

  findings.sort(
    (a, b) =>
      (a.location < b.location ? -1 : a.location > b.location ? 1 : 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  const errors = findings.filter((f) => f.severity === 'error').length;
  return {
    performed: true,
    platform_id: profile.platform_id,
    rules_version: profile.rules_version,
    passed: errors === 0,
    findings,
    errors,
    warnings: findings.length - errors,
    external_acceptance: 'not_verified',
  };
}
