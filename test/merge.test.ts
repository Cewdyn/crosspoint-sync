import { describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

const KOBO_DOC = '27593cefaf3a602cf410ecf5da4652e2';
const CP_DOC = '76166bb603f5121c19c308c64a8d5c73';

async function putProgress(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  headers: Record<string, string>,
  body: Record<string, unknown>
) {
  return app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify(body) });
}

async function setup() {
  const { app, db } = makeTestApp();
  const { headers } = await registerUser(app);
  // Same book, hashed differently by two devices; only CrossPoint sends metadata.
  await putProgress(app, headers, {
    document: KOBO_DOC,
    progress: '/body/DocFragment[5]/body/p[1]/text().0',
    percentage: 0.1,
    device: 'Kobo',
    device_id: 'kobo-1',
  });
  await putProgress(app, headers, {
    document: CP_DOC,
    progress: '/body/DocFragment[7]/body/p[8]/text().4',
    percentage: 0.2,
    device: 'CrossPoint',
    device_id: 'cp-1',
    metadata: { title: 'The Water Outlaws', authors: 'S. L. Huang', filename: 'The Water Outlaws - S. L. Huang.epub' },
  });
  const merge = await app.request('/api/v1/documents/merge', {
    method: 'POST',
    headers,
    body: JSON.stringify({ document: KOBO_DOC, into: CP_DOC }),
  });
  expect(merge.status).toBe(200);
  return { app, db, headers };
}

describe('document merge', () => {
  it('migrates progress and lists one book with the alias', async () => {
    const { app, headers } = await setup();
    const list = await app.request('/api/v1/progress?limit=500', { headers });
    const { items } = (await list.json()) as { items: Record<string, unknown>[] };
    expect(items).toHaveLength(1);
    expect(items[0].document).toBe(CP_DOC);
    expect(items[0].title).toBe('The Water Outlaws');
    expect(items[0].aliases).toEqual([KOBO_DOC]);
  });

  it('serves the merged progress when asked for the alias hash', async () => {
    const { app, headers } = await setup();
    const res = await app.request(`/syncs/progress/${KOBO_DOC}`, { headers });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.document).toBe(KOBO_DOC); // echoes what the client asked for
    expect(body.percentage).toBe(0.2); // CrossPoint's newer progress
  });

  it('stores pushes to the alias hash under the canonical document', async () => {
    const { app, headers } = await setup();
    await putProgress(app, headers, {
      document: KOBO_DOC,
      progress: '/body/DocFragment[9]/body/p[2]/text().0',
      percentage: 0.5,
      device: 'Kobo',
      device_id: 'kobo-1',
    });
    const res = await app.request(`/api/v1/progress/${CP_DOC}`, { headers });
    const body = (await res.json()) as { devices: { device_id: string; percentage: number }[] };
    const kobo = body.devices.find((d) => d.device_id === 'kobo-1');
    expect(kobo?.percentage).toBe(0.5);
  });

  it('keeps the newest row per device when both hashes had progress', async () => {
    const { db, headers, app } = await setup();
    void headers;
    void app;
    const rows = db
      .prepare('SELECT document, device_id FROM progress ORDER BY device_id')
      .all() as unknown as { document: string; device_id: string }[];
    expect(rows).toEqual([
      { document: CP_DOC, device_id: 'cp-1' },
      { document: CP_DOC, device_id: 'kobo-1' },
    ]);
  });

  it('rejects merging a document into itself (directly or via alias)', async () => {
    const { app, headers } = await setup();
    const res = await app.request('/api/v1/documents/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify({ document: KOBO_DOC, into: CP_DOC }),
    });
    expect(res.status).toBe(403); // KOBO_DOC already resolves to CP_DOC
  });

  it('unmerge stops resolution but keeps migrated rows', async () => {
    const { app, headers } = await setup();
    const un = await app.request(`/api/v1/documents/merge/${KOBO_DOC}`, {
      method: 'DELETE',
      headers,
    });
    expect(un.status).toBe(200);
    // The alias hash is its own (empty) document again.
    const res = await app.request(`/syncs/progress/${KOBO_DOC}`, { headers });
    expect(await res.json()).toEqual({});
    // Canonical still has both devices' rows.
    const canon = await app.request(`/api/v1/progress/${CP_DOC}`, { headers });
    const body = (await canon.json()) as { devices: unknown[] };
    expect(body.devices).toHaveLength(2);
  });

  it('deleting the canonical book clears the alias mapping too', async () => {
    const { app, db, headers } = await setup();
    const del = await app.request(`/api/v1/progress/${CP_DOC}`, { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    const aliases = db.prepare('SELECT * FROM document_aliases').all();
    expect(aliases).toHaveLength(0);
  });
});

describe('automatic merge on metadata match', () => {
  const KINDLE_DOC = 'a'.repeat(32);
  const XTEINK_DOC = 'b'.repeat(32);

  it('links two devices automatically by title+author, no manual merge needed', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    // Kindle (KOReader): real title/author metadata, its own content hash.
    await putProgress(app, headers, {
      document: KINDLE_DOC,
      progress: '/body/DocFragment[3]/body/p[1]/text().0',
      percentage: 0.1,
      device: 'KindlePaperWhite5',
      device_id: 'kindle-1',
      metadata: {
        title: 'Ana and Din Mysteries',
        authors: 'R. Bennett',
        filename: 'Ana and Din Mysteries - 01.epub',
      },
    });
    // XTEink (CrossPoint): a different hash for the same book, matching title/author too.
    const put = await putProgress(app, headers, {
      document: XTEINK_DOC,
      progress: '/body/DocFragment[1]/body/p[1]/text().0',
      percentage: 0.02,
      device: 'CrossPoint',
      device_id: 'xteink-1',
      metadata: {
        title: 'Ana and Din Mysteries',
        authors: 'R. Bennett',
        filename: 'R Bennett - Ana and Din Mysteries.epub',
      },
    });
    expect(put.status).toBe(200);

    const aliases = db.prepare('SELECT alias, document FROM document_aliases').all();
    expect(aliases).toHaveLength(1);
    // Only one book should show up in the list - not two unrelated entries.
    const list = await (await app.request('/api/v1/progress?limit=500', { headers })).json();
    expect(list.items).toHaveLength(1);
  });

  it('links two devices by fuzzy filename overlap when one sends no title/author at all', async () => {
    // Matches the real-world case this was built for: a firmware that only ever
    // sends `filename` (never real title/author), syncing against a device that
    // sends full metadata under a different local filename for the same book.
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    await putProgress(app, headers, {
      document: KINDLE_DOC,
      progress: '/body/DocFragment[3]/body/p[1]/text().0',
      percentage: 1.0,
      device: 'KindlePaperWhite5',
      device_id: 'kindle-1',
      metadata: { title: 'Pinwheel', authors: 'Snek Guy', filename: 'Pinwheel - 01.epub' },
    });
    const put = await putProgress(app, headers, {
      document: XTEINK_DOC,
      progress: '/body/DocFragment[1]/body/p[1]/text().0',
      percentage: 0.003,
      device: 'CrossPoint',
      device_id: 'xteink-1',
      metadata: { title: null, authors: null, filename: 'Pinwheel.epub' } as unknown as Record<string, unknown>,
    });
    expect(put.status).toBe(200);

    const aliases = db.prepare('SELECT alias, document FROM document_aliases').all();
    expect(aliases).toHaveLength(1);
  });

  it('does not merge two different books that happen to share one filename word', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    await putProgress(app, headers, {
      document: KINDLE_DOC,
      progress: 'p',
      percentage: 0.1,
      device_id: 'kindle-1',
      metadata: { title: 'The Great Adventure', authors: 'Author One', filename: 'The Great Adventure.epub' },
    });
    await putProgress(app, headers, {
      document: XTEINK_DOC,
      progress: 'p',
      percentage: 0.1,
      device_id: 'xteink-1',
      metadata: { title: null, authors: null, filename: 'The Lost City.epub' } as unknown as Record<string, unknown>,
    });
    expect(db.prepare('SELECT * FROM document_aliases').all()).toHaveLength(0);
  });

  it('does not merge same-titled books by different authors', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    await putProgress(app, headers, {
      document: KINDLE_DOC,
      progress: 'p',
      percentage: 0.1,
      device_id: 'kindle-1',
      metadata: { title: 'Circe', authors: 'Madeline Miller', filename: 'Circe.epub' },
    });
    await putProgress(app, headers, {
      document: XTEINK_DOC,
      progress: 'p',
      percentage: 0.1,
      device_id: 'xteink-1',
      metadata: { title: 'Circe', authors: 'Someone Else', filename: 'Circe (2).epub' },
    });
    expect(db.prepare('SELECT * FROM document_aliases').all()).toHaveLength(0);
  });

  it('keeps the document with an existing connector match as canonical', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    await putProgress(app, headers, {
      document: KINDLE_DOC,
      progress: 'p',
      percentage: 0.1,
      device_id: 'kindle-1',
      metadata: { title: 'Foundryside', authors: 'Robert Jackson Bennett', filename: 'Foundryside - 01.epub' },
    });
    // Simulate an already-established external connector match on the Kindle hash.
    db.prepare(
      `INSERT INTO connector_matches (user_id, connector_id, document, external_id, source, updated_at)
       VALUES (1, 'hardcover', ?, 'hc-123', 'auto', unixepoch())`
    ).run(KINDLE_DOC);
    await putProgress(app, headers, {
      document: XTEINK_DOC,
      progress: 'p',
      percentage: 0.02,
      device_id: 'xteink-1',
      metadata: {
        title: 'Foundryside',
        authors: 'Robert Jackson Bennett',
        filename: 'RJB - Foundryside.epub',
      },
    });
    const alias = db.prepare('SELECT alias, document FROM document_aliases').get() as {
      alias: string;
      document: string;
    };
    // Canonical must stay the one that already has the Hardcover match.
    expect(alias.document).toBe(KINDLE_DOC);
    expect(alias.alias).toBe(XTEINK_DOC);
  });
});
