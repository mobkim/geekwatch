import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { parseRecentTopics } from '../src/scraper.js';

function fixture(name: string): string {
  // geekhack serves latin1-ish bytes that aren't valid UTF-8
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))).toString('latin1');
}

// The listener's destination lookup and Discord sends are mocked; these tests
// cover which posts get selected, which is where the misses came from.
const sent: any[] = [];

// The listener does `channel instanceof TextChannel`, so the fake channel has
// to be a real instance of whatever class the module sees.
class FakeTextChannel {
  async send(payload: any) {
    sent.push(payload.embeds[0]);
  }
}

vi.mock('discord.js', () => ({
  TextChannel: FakeTextChannel,
  Client: class {},
}));

vi.mock('../src/database.js', () => ({
  listens: vi.fn(async () => [
    { topic_id: 33106, topic: 'Bug Reports', last: 0, to: { channel: ['chan1'], dm: [] } },
  ]),
  listened: vi.fn(async () => {}),
  clean: vi.fn(),
}));

vi.mock('../src/embeds.js', () => ({
  topicPostEmbed: vi.fn((kind, msg_href, response, topic, opName, opScore, opIcon, image, timestamp) => ({
    kind,
    msg_href,
    response,
    opName,
    timestamp,
  })),
}));

const { processTopic } = await import('../src/listener.js');

function mockClient() {
  return {
    channels: { cache: { get: () => new FakeTextChannel() } },
    users: { fetch: async () => ({ send: async () => {} }) },
  } as any;
}

describe('parseRecentTopics', () => {
  const $ = cheerio.load(fixture('recenttopics.html'));
  const rows = parseRecentTopics($);

  it('parses every row on the page', () => {
    // Regression: the reply count was read from td.smalltext[0], the
    // last-poster cell ("mcmcmc35 minutes ago"), so parseInt gave NaN and the
    // `post === 0` guard dropped every row — no topic ever notified.
    expect(rows.length).toBe(20);
  });

  it('reads the reply count, not the last-poster cell', () => {
    for (const row of rows) {
      expect(Number.isInteger(row.post)).toBe(true);
      expect(row.post).toBeGreaterThanOrEqual(0);
    }
    // First row on the fixture page has 5 replies
    expect(rows[rows.length - 1].post).toBe(5);
  });

  it('extracts topic id, title and both user ids', () => {
    const row = rows[rows.length - 1];
    expect(row.topic_id).toBeGreaterThan(0);
    expect(row.topic).toBe('[IC] DCS VoC (Violet on Cream)');
    expect(row.poster_id).toBeGreaterThan(0);
    expect(row.op_id).toBeGreaterThan(0);
  });
});

describe('processTopic', () => {
  let requested: string[];

  beforeEach(() => {
    sent.length = 0;
    requested = [];
    // Keyed by the page-aligned offset, not the topic: geekhack floors the .N
    // start offset to a 50-post page boundary, and the URL assertions below
    // pin that arithmetic down. Offsets past the saved pages reuse the
    // mid-thread page — only the request sequence matters there.
    const pages: Record<string, string> = {
      '0': fixture('topic-33106.html'),
      '100': fixture('topic-33106-page100.html'),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        const offset = url.match(/topic=\d+\.(\d+)/)![1];
        return { ok: true, text: async () => pages[offset] ?? pages['100'] };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("announces the thread starter's reply", async () => {
    // topic 33106 page 1: post 0 and Reply #1 by the OP (mkawa), Reply #2 by
    // bpiphany. Reply #1 was missed because the page-number parse produced
    // NaN, making the scan loop start at NaN and never run.
    await processTopic(mockClient(), 33106, 1, 1, 'Bug Reports');

    expect(sent.length).toBe(1);
    expect(sent[0].opName).toBe('mkawa');
    expect(sent[0].kind).toBe('Direct Post');
    expect(sent[0].timestamp).toContain('Fri, 20 July 2012, 23:38:53');
  });

  it("skips posts that aren't by the thread starter", async () => {
    // Reply #2 is bpiphany, not the OP.
    await processTopic(mockClient(), 33106, 2, 2, 'Bug Reports');
    expect(sent.length).toBe(0);
  });

  it('catches the OP post when a non-OP replies after it in the same window', async () => {
    // The old tick gated on `poster_id === op_id` from recenttopics, which only
    // reports the newest poster — bpiphany's Reply #2 masked the OP's #1.
    await processTopic(mockClient(), 33106, 1, 2, 'Bug Reports');

    expect(sent.length).toBe(1);
    expect(sent[0].opName).toBe('mkawa');
  });

  it('scans a whole range rather than only the newest post', async () => {
    await processTopic(mockClient(), 33106, 0, 2, 'Bug Reports');

    expect(sent.length).toBe(2);
    expect(sent.map((e) => e.opName)).toEqual(['mkawa', 'mkawa']);
  });

  it('requests the page-aligned offset and indexes within it', async () => {
    // Reply #117 lives at index 17 of the page starting at offset 100
    await processTopic(mockClient(), 33106, 117, 117, 'Bug Reports');

    expect(requested).toEqual(['https://geekhack.org/index.php?topic=33106.100']);
    expect(sent.length).toBe(1);
    expect(sent[0].opName).toBe('mkawa');
    expect(sent[0].timestamp).toContain('#117');
  });

  it('walks forward one page at a time across a boundary', async () => {
    // The mock serves the same page for both requests, so only the request
    // sequence is meaningful here.
    await processTopic(mockClient(), 33106, 117, 151, 'Bug Reports');

    expect(requested).toEqual([
      'https://geekhack.org/index.php?topic=33106.100',
      'https://geekhack.org/index.php?topic=33106.150',
    ]);
  });

  it('skips thread-starter posts that fall before the range', async () => {
    // The OP's posts on the fixture page are #117, #120, #122, #126 and #140;
    // starting at 121 must exclude the first two.
    await processTopic(mockClient(), 33106, 121, 126, 'Bug Reports');

    expect(sent.map((e) => e.timestamp.match(/#\d+/)![0])).toEqual(['#122', '#126']);
  });

  it('links to the exact post rather than the topic', async () => {
    await processTopic(mockClient(), 33106, 117, 117, 'Bug Reports');

    expect(sent[0].msg_href).toBe('https://geekhack.org/index.php?topic=33106.msg700616#msg700616');
  });
});
