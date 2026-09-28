import { describe, expect, it } from 'vitest';
import {
  coreTitle,
  decideMatch,
  extractTitleAuthor,
  filenamesLikelyMatch,
  normalizeAuthor,
  scoreCandidate,
} from '../src/connectors/matching.js';

describe('matching helpers', () => {
  it('strips subtitles and series suffixes from titles', () => {
    expect(coreTitle('Foundryside: A Novel')).toBe('Foundryside');
    expect(coreTitle('Foundryside (The Founders Trilogy, Book 1)')).toBe('Foundryside');
    expect(coreTitle('Plain Title')).toBe('Plain Title');
  });

  it('normalizes "Last, First" author form', () => {
    expect(normalizeAuthor('Bennett, Robert Jackson')).toBe('robert jackson bennett');
    expect(normalizeAuthor('Robert Jackson Bennett')).toBe('robert jackson bennett');
  });

  it('uses EPUB title/author as the primary signal', () => {
    expect(extractTitleAuthor({ document: 'd', title: 'Foundryside', author: 'RJB', filename: 'x.epub' }))
      .toEqual({ title: 'Foundryside', author: 'RJB' });
  });

  it('falls back to a filename query only when title is missing, without guessing order', () => {
    expect(
      extractTitleAuthor({
        document: 'd',
        title: null,
        author: null,
        filename: 'Foundryside - Robert Jackson Bennett.epub',
      })
    ).toEqual({ title: 'Foundryside Robert Jackson Bennett', author: '' });
    expect(extractTitleAuthor({ document: 'd', title: null, author: null, filename: null })).toBeNull();
  });

  it('scores exact title+author near 1 and mismatches low', () => {
    const good = scoreCandidate('Foundryside', 'Robert Jackson Bennett', {
      externalId: '1',
      title: 'Foundryside',
      author: 'Robert Jackson Bennett',
    });
    expect(good).toBeGreaterThan(0.9);
    const bad = scoreCandidate('Foundryside', 'Robert Jackson Bennett', {
      externalId: '2',
      title: 'Dune',
      author: 'Frank Herbert',
    });
    expect(bad).toBeLessThan(0.2);
  });

  it('auto-accepts a clear winner, rejects ambiguous title collisions', () => {
    const clear = decideMatch('Foundryside', 'Robert Jackson Bennett', [
      { externalId: '1', title: 'Foundryside', author: 'Robert Jackson Bennett' },
      { externalId: '2', title: 'Dune', author: 'Frank Herbert' },
    ]);
    expect(clear.accepted).toBe(true);
    expect(clear.best?.externalId).toBe('1');

    // Two different books literally titled "Circe" — needs author to split; with
    // no author on the query, stays unaccepted.
    const collision = decideMatch('Circe', '', [
      { externalId: '1', title: 'Circe', author: 'Madeline Miller' },
      { externalId: '2', title: 'Circe', author: 'Someone Else' },
    ]);
    expect(collision.accepted).toBe(false);
  });

  it('accepts same-book different-edition ambiguity, taking the popular one', () => {
    const d = decideMatch('Foundryside', 'Robert Jackson Bennett', [
      { externalId: 'ed1', title: 'Foundryside', author: 'Robert Jackson Bennett', popularity: 10 },
      { externalId: 'ed2', title: 'Foundryside', author: 'Robert Jackson Bennett', popularity: 500 },
    ]);
    expect(d.accepted).toBe(true);
    expect(d.best?.externalId).toBe('ed2');
  });

  it('returns unaccepted for empty candidates', () => {
    expect(decideMatch('X', 'Y', []).accepted).toBe(false);
  });

  describe('filenamesLikelyMatch', () => {
    it('matches a server-format name against a client-synthesized author-title name', () => {
      // Same book, two clients that name downloaded files completely differently.
      expect(filenamesLikelyMatch('Ana and Din Mysteries - 01.epub', 'R Bennett - Ana and Din Mysteries.epub')).toBe(
        true
      );
    });

    it('ignores bare volume/chapter numbers as distinguishing content', () => {
      expect(filenamesLikelyMatch('Pinwheel - 01.epub', 'Pinwheel.epub')).toBe(true);
    });

    it('does not match unrelated books', () => {
      expect(filenamesLikelyMatch('Ana and Din Mysteries - 01.epub', 'Golden Fields.epub')).toBe(false);
    });

    it('does not match on a single shared common word', () => {
      expect(filenamesLikelyMatch('The Great Adventure.epub', 'The Lost City.epub')).toBe(false);
    });

    it('handles empty/unusable input without throwing', () => {
      expect(filenamesLikelyMatch('', 'Something.epub')).toBe(false);
      expect(filenamesLikelyMatch('01.epub', '02.epub')).toBe(false); // nothing but volume numbers
    });
  });
});
