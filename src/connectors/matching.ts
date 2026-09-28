import type { DocumentMeta } from './types.js';

/**
 * Shared, connector-agnostic book-matching helpers. Connectors call their own
 * search API, then use scoreCandidate() to rank results against the document's
 * title/author. Pure functions - unit-tested independently of any network.
 */

/** Fold diacritics, lowercase, drop punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip subtitle after a colon and trailing "(Series, Book 2)" style suffixes. */
export function coreTitle(title: string): string {
  let t = title.replace(/\s*[:—-]\s.*$/, ''); // subtitle
  t = t.replace(/\s*\((?:[^)]*\b(?:book|vol|volume|part|no)\b[^)]*)\)\s*$/i, '');
  return t.trim();
}

/** "Last, First" -> "First Last"; also normalizes. */
export function normalizeAuthor(author: string): string {
  const trimmed = author.trim();
  const comma = trimmed.indexOf(',');
  if (comma > 0 && trimmed.indexOf(',') === trimmed.lastIndexOf(',')) {
    const last = trimmed.slice(0, comma).trim();
    const first = trimmed.slice(comma + 1).trim();
    return normalizeText(`${first} ${last}`);
  }
  return normalizeText(trimmed);
}

/**
 * Derive {title, author} for book matching. The EPUB's own title/author (which
 * the firmware extracts and sends in the progress `metadata` object) is the real
 * signal - this is the primary and expected path.
 *
 * Filename is only a last resort for the rare title-less case (a malformed EPUB
 * whose getTitle() was empty). Note it can't rescue the "no metadata at all"
 * case: filename ships in the same metadata object as title/author, so if we
 * lack title we usually lack filename too. We deliberately do NOT guess
 * "Title - Author" vs "Author - Title" ordering - we drop the separators and let
 * the whole string be a fuzzy search query, which search engines handle fine.
 */
export function extractTitleAuthor(doc: DocumentMeta): { title: string; author: string } | null {
  if (doc.title) {
    return { title: doc.title, author: doc.author ?? '' };
  }
  if (doc.filename) {
    const base = doc.filename.replace(/\.[a-z0-9]+$/i, '').replace(/\s*-\s*/g, ' ').trim();
    return base ? { title: base, author: '' } : null;
  }
  return null;
}

/** Token set overlap (Jaccard) of two normalized strings. */
function tokenOverlap(a: string, b: string): number {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Strip extension and bare volume/chapter-number tokens (e.g. "01"), normalize. */
export function filenameStem(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, '');
  return normalizeText(base)
    .split(' ')
    .filter((t) => t && !/^\d+$/.test(t))
    .join(' ');
}

/**
 * Fuzzy filename match for auto-merging documents across clients that name
 * downloaded files differently (e.g. server's "Series - 01.epub" vs a client-
 * synthesized "Author - Title.epub" for the same book).
 *
 * An exact match after stripping the extension/volume numbers is always
 * accepted (covers single-word titles like "Pinwheel.epub" vs
 * "Pinwheel - 01.epub" - there's nothing ambiguous about it). Anything short
 * of that needs both strong overlap and at least 2 shared distinctive words,
 * so two unrelated short filenames sharing one common word don't merge.
 */
export function filenamesLikelyMatch(a: string, b: string): boolean {
  const sa = filenameStem(a);
  const sb = filenameStem(b);
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const setA = new Set(sa.split(' ').filter(Boolean));
  const setB = new Set(sb.split(' ').filter(Boolean));
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return shared >= 2 && tokenOverlap(sa, sb) >= 0.5;
}

export interface Candidate {
  externalId: string;
  title: string;
  author?: string | null;
  /** Optional popularity/rank signal (higher = more popular), used as a tiebreak. */
  popularity?: number;
}

export interface ScoredCandidate extends Candidate {
  score: number;
}

/**
 * Score a candidate against the wanted title/author. Title similarity dominates;
 * author overlap is a strong secondary that disambiguates same-title collisions.
 */
export function scoreCandidate(
  wantTitle: string,
  wantAuthor: string,
  cand: Candidate
): number {
  const wt = normalizeText(coreTitle(wantTitle));
  const ct = normalizeText(coreTitle(cand.title));
  const titleScore = wt && ct ? tokenOverlap(wt, ct) : 0;

  const wa = wantAuthor ? normalizeAuthor(wantAuthor) : '';
  const ca = cand.author ? normalizeAuthor(cand.author) : '';
  const authorScore = wa && ca ? tokenOverlap(wa, ca) : 0;

  // No author info on either side: rely on title alone (capped so it can't
  // clear a high threshold on title-only, since title collisions are common).
  if (!wa || !ca) return titleScore * 0.85;
  return titleScore * 0.7 + authorScore * 0.3;
}

export interface MatchDecision {
  best: ScoredCandidate | null;
  accepted: boolean;
}

/**
 * Rank candidates and decide whether to auto-accept: the top must clear
 * `threshold` AND beat the runner-up by `margin` (unless the runner-up is the
 * same book - same normalized title+author - in which case ambiguity between
 * editions is fine and we take the more popular one).
 */
export function decideMatch(
  wantTitle: string,
  wantAuthor: string,
  candidates: Candidate[],
  opts: { threshold?: number; margin?: number } = {}
): MatchDecision {
  const threshold = opts.threshold ?? 0.6;
  const margin = opts.margin ?? 0.15;
  if (candidates.length === 0) return { best: null, accepted: false };

  const scored: ScoredCandidate[] = candidates
    .map((c) => ({ ...c, score: scoreCandidate(wantTitle, wantAuthor, c) }))
    .sort((a, b) => b.score - a.score || (b.popularity ?? 0) - (a.popularity ?? 0));

  const best = scored[0];
  if (best.score < threshold) return { best, accepted: false };

  const runner = scored[1];
  if (!runner) return { best, accepted: true };

  const sameBook =
    normalizeText(coreTitle(best.title)) === normalizeText(coreTitle(runner.title)) &&
    normalizeAuthor(best.author ?? '') === normalizeAuthor(runner.author ?? '');
  if (sameBook) return { best, accepted: true };

  return { best, accepted: best.score - runner.score >= margin };
}
