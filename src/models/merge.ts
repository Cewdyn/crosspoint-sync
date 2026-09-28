import { withTransaction, type DB } from '../db/db.js';
import { coreTitle, filenamesLikelyMatch, normalizeAuthor, normalizeText } from '../connectors/matching.js';

/**
 * Manual document merges. The kosync document key is client-computed and
 * clients disagree (KOReader binary partial-MD5 vs CrossPoint filename MD5),
 * so one physical book can sync as two documents. A merge migrates the
 * existing rows onto one canonical document and records alias -> canonical so
 * future pushes under the old hash land on the canonical one.
 */

/** Resolve a device-sent document hash to its canonical merged document. */
export function resolveDocument(db: DB, userId: number, document: string): string {
  const row = db
    .prepare('SELECT document FROM document_aliases WHERE user_id = ? AND alias = ?')
    .get(userId, document) as { document: string } | undefined;
  return row?.document ?? document;
}

/** All alias hashes per canonical document for a user. */
export function aliasesByDocument(db: DB, userId: number): Map<string, string[]> {
  const rows = db
    .prepare('SELECT alias, document FROM document_aliases WHERE user_id = ?')
    .all(userId) as unknown as { alias: string; document: string }[];
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.document) ?? [];
    list.push(r.alias);
    map.set(r.document, list);
  }
  return map;
}

/**
 * Merge `from` into `into`: migrate progress (newest per device wins),
 * position samples, metadata (canonical's fields win, alias fills gaps),
 * bookmarks/clippings/stats, and connector matches, then record the alias.
 * Callers must pass already-resolved, distinct documents.
 */
export function mergeDocuments(db: DB, userId: number, from: string, into: string, now: number): void {
  withTransaction(db, () => {
    // progress PK (user, document, device_id): keep the newest row per device.
    db.prepare(
      `DELETE FROM progress WHERE user_id = ? AND document = ? AND EXISTS (
         SELECT 1 FROM progress b WHERE b.user_id = progress.user_id AND b.document = ?
           AND b.device_id = progress.device_id AND b.updated_at >= progress.updated_at)`
    ).run(userId, from, into);
    db.prepare(
      `DELETE FROM progress WHERE user_id = ? AND document = ? AND EXISTS (
         SELECT 1 FROM progress b WHERE b.user_id = progress.user_id AND b.document = ?
           AND b.device_id = progress.device_id AND b.updated_at > progress.updated_at)`
    ).run(userId, into, from);
    db.prepare('UPDATE progress SET document = ? WHERE user_id = ? AND document = ?').run(
      into,
      userId,
      from
    );

    // progress_samples PK (user, document, pct_bucket): newest sample per bucket.
    db.prepare(
      `DELETE FROM progress_samples WHERE user_id = ? AND document = ? AND EXISTS (
         SELECT 1 FROM progress_samples b WHERE b.user_id = progress_samples.user_id AND b.document = ?
           AND b.pct_bucket = progress_samples.pct_bucket AND b.updated_at >= progress_samples.updated_at)`
    ).run(userId, from, into);
    db.prepare('UPDATE OR REPLACE progress_samples SET document = ? WHERE user_id = ? AND document = ?').run(
      into,
      userId,
      from
    );

    // documents: canonical metadata wins, alias fills the gaps.
    db.prepare(
      `INSERT INTO documents (user_id, document, title, author, filename, filesize, updated_at)
       SELECT user_id, ?, title, author, filename, filesize, ? FROM documents WHERE user_id = ? AND document = ?
       ON CONFLICT(user_id, document) DO UPDATE SET
         title = COALESCE(documents.title, excluded.title),
         author = COALESCE(documents.author, excluded.author),
         filename = COALESCE(documents.filename, excluded.filename),
         filesize = COALESCE(documents.filesize, excluded.filesize),
         updated_at = excluded.updated_at`
    ).run(into, now, userId, from);
    db.prepare('DELETE FROM documents WHERE user_id = ? AND document = ?').run(userId, from);

    // Uniquely-keyed side tables: move what fits, drop the (rare) conflicts.
    for (const table of ['bookmarks', 'clippings', 'stats_device_book', 'connector_matches', 'connector_queue']) {
      db.prepare(`UPDATE OR IGNORE ${table} SET document = ? WHERE user_id = ? AND document = ?`).run(
        into,
        userId,
        from
      );
      db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND document = ?`).run(userId, from);
    }

    // Flatten chains (anything aliased to `from` now points at `into`), then
    // record the merge itself.
    db.prepare('UPDATE document_aliases SET document = ? WHERE user_id = ? AND document = ?').run(
      into,
      userId,
      from
    );
    db.prepare(
      'INSERT OR REPLACE INTO document_aliases (user_id, alias, document, created_at) VALUES (?, ?, ?, ?)'
    ).run(userId, from, into, now);
  });
}

/**
 * Remove an alias mapping. Already-migrated rows stay on the canonical
 * document; the old hash just starts accumulating its own progress again.
 */
export function unmergeDocument(db: DB, userId: number, alias: string): boolean {
  const res = db
    .prepare('DELETE FROM document_aliases WHERE user_id = ? AND alias = ?')
    .run(userId, alias);
  return res.changes > 0;
}

interface DocRow {
  document: string;
  title: string | null;
  author: string | null;
  filename: string | null;
}

/**
 * Find an existing, different, not-already-linked document that's probably the
 * same book under a different client-computed hash. Two clients that disagree
 * on document identity (KOReader binary MD5 vs a device's own filename MD5, or
 * two devices saving a downloaded file under different local names) otherwise
 * sync as unrelated books forever.
 *
 * Matched by exact title (case/punctuation-insensitive, subtitle stripped) with
 * author agreement when both sides have one - the strong signal, when a device
 * sends real metadata. Falls back to fuzzy filename word-overlap for devices
 * that only ever send `filename` (e.g. firmware that can't reliably read an
 * EPUB's internal title), since two devices' local filenames for the same book
 * still share its distinctive title words even when formatted completely
 * differently (a server-provided "Series - 01.epub" vs a client-synthesized
 * "Author - Title.epub").
 */
export function findAutoMergeCandidate(
  db: DB,
  userId: number,
  document: string,
  meta: { title?: string | null; author?: string | null; filename?: string | null }
): string | null {
  const rows = db
    .prepare('SELECT document, title, author, filename FROM documents WHERE user_id = ? AND document != ?')
    .all(userId, document) as unknown as DocRow[];
  if (rows.length === 0) return null;

  const titleKey = meta.title ? normalizeText(coreTitle(meta.title)) : '';
  const authorKey = meta.author ? normalizeAuthor(meta.author) : '';

  for (const r of rows) {
    if (titleKey && r.title) {
      // Both sides have title info for this pair - judge it on title/author
      // alone, never rescue a mismatch via filename fuzzy-matching.
      if (
        normalizeText(coreTitle(r.title)) === titleKey &&
        (!authorKey || !r.author || normalizeAuthor(r.author) === authorKey)
      ) {
        return r.document;
      }
      continue;
    }
    // At least one side has no title at all (e.g. a device that only ever
    // sends `filename`) - the only signal available is filename overlap.
    if (meta.filename && r.filename && filenamesLikelyMatch(meta.filename, r.filename)) {
      return r.document;
    }
  }

  return null;
}

/**
 * Decide which of two documents stays canonical when auto-merging: prefer
 * whichever already has connector matches (so established integrations aren't
 * orphaned), then whichever has been syncing longer (stable, not just "whoever
 * pushed most recently").
 */
export function pickCanonical(
  db: DB,
  userId: number,
  a: string,
  b: string
): { canonical: string; alias: string } {
  const matchCount = (doc: string): number =>
    (
      db
        .prepare('SELECT COUNT(*) as c FROM connector_matches WHERE user_id = ? AND document = ?')
        .get(userId, doc) as { c: number }
    ).c;
  const aMatches = matchCount(a);
  const bMatches = matchCount(b);
  if (aMatches !== bMatches) {
    return aMatches > bMatches ? { canonical: a, alias: b } : { canonical: b, alias: a };
  }

  const firstSeen = (doc: string): number =>
    (
      db
        .prepare('SELECT MIN(updated_at) as t FROM progress WHERE user_id = ? AND document = ?')
        .get(userId, doc) as { t: number | null }
    ).t ?? Number.POSITIVE_INFINITY;
  return firstSeen(a) <= firstSeen(b) ? { canonical: a, alias: b } : { canonical: b, alias: a };
}
