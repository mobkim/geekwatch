import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function fixture(name: string): string {
  // geekhack serves latin1-ish bytes that aren't valid UTF-8
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))).toString('latin1');
}

const sent: any[] = [];

class FakeTextChannel {
  async send(payload: any) {
    sent.push(payload.embeds[0]);
  }
}

// Keep the real EmbedBuilder — the outage came from Discord rejecting the
// embed, so a stubbed builder would sail straight past the regression.
vi.mock('discord.js', async () => {
  const actual = await vi.importActual<any>('discord.js');
  return { ...actual, TextChannel: FakeTextChannel };
});

const watched = vi.fn(async () => {});

vi.mock('../src/database.js', () => ({
  watches: vi.fn(async () => []),
  watched,
  clean: vi.fn(),
}));

const { processBoard } = await import('../src/watcher.js');

function mockClient() {
  return {
    channels: { cache: { get: () => new FakeTextChannel() } },
    users: { fetch: async () => ({ send: async () => {} }) },
  } as any;
}

const board = {
  board_id: 109,
  board: 'Off Topic',
  // 126887 is the newest id on the saved front page; 126808 is the next one
  // down, so exactly one topic counts as new.
  last: 126808,
  to: { channel: ['chan1'], dm: [] },
} as any;

/**
 * Serves the saved geekhack pages; `fail` forces a fetch failure per URL
 * substring. Any topic id resolves to the one saved topic page — the board
 * fixture decides *which* ids are new, the topic fixture decides how a topic
 * page is parsed, and the two are independent.
 */
function stubFetch(fail: string[] = []) {
  return vi.fn(async (url: string) => {
    if (fail.some(f => url.includes(f))) return { ok: false, text: async () => '' };
    if (url.includes('board=109')) return { ok: true, text: async () => fixture('board-109.html') };
    if (url.includes('topic=')) return { ok: true, text: async () => fixture('topic-33429.html') };
    return { ok: false, text: async () => '' };
  });
}

beforeEach(() => {
  sent.length = 0;
  watched.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processBoard', () => {
  it('announces a new topic with the opening post title and date', async () => {
    vi.stubGlobal('fetch', stubFetch());

    await processBoard(mockClient(), board);

    expect(sent).toHaveLength(1);
    const embed = sent[0].toJSON();

    // A topic page has one div.keyinfo per post. The unscoped selector glued
    // every post's subject together, blowing past Discord's 256 char title cap
    // and making the whole embed throw — which processBoard swallowed, so the
    // board went silent with nothing in the logs.
    expect(embed.title).toBe('Welcome new members!');
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.footer.text).toBe('geekhack | Sun, 29 July 2012, 09:51:16');
    expect(embed.url).toBe('https://geekhack.org/index.php?topic=126887.0');
  });

  it('builds the embed for a guest OP with no flair, postcount or profile', async () => {
    vi.stubGlobal('fetch', stubFetch());

    // This topic was started by a guest: the name lives in the <h4> with no
    // <a>, and there is no membergroup image or postcount. Empty-string
    // iconURL/url values are rejected by Discord outright.
    await processBoard(mockClient(), board);

    expect(sent).toHaveLength(1);
    const author = sent[0].toJSON().author;
    expect(author.name).toBe('fartq ()');
    expect(author.icon_url).toBeUndefined();
    expect(author.url).toBeUndefined();
  });

  it('advances last only after a topic is announced', async () => {
    vi.stubGlobal('fetch', stubFetch());

    await processBoard(mockClient(), board);

    expect(watched).toHaveBeenCalledWith(109, 126887);
  });

  it('leaves last alone when the topic page cannot be fetched', async () => {
    vi.stubGlobal('fetch', stubFetch(['topic=126887']));

    await processBoard(mockClient(), board);

    // Previously `last` jumped to the front-page max regardless, so a topic
    // that failed a single transient fetch was never retried.
    expect(sent).toHaveLength(0);
    expect(watched).not.toHaveBeenCalled();
  });

  it('sets the baseline silently on a freshly watched board', async () => {
    vi.stubGlobal('fetch', stubFetch());

    await processBoard(mockClient(), { ...board, last: 0 });

    expect(sent).toHaveLength(0);
    expect(watched).toHaveBeenCalledWith(109, 126887);
  });
});
