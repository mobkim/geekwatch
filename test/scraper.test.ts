import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verify } from '../src/scraper.js';

function fixture(name: string): string {
  // geekhack serves latin1-ish bytes that aren't valid UTF-8
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))).toString('latin1');
}

function stubFetch(body: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => body })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verify (topic)', () => {
  it('reads the opening post, not every post on the page', async () => {
    stubFetch(fixture('topic-33429.html'));

    const result = (await verify('33429')) as any[];

    // A topic page has one div.keyinfo per post. The Python used soup.find()
    // (first match); cheerio's .text() concatenates every match, so /follow
    // stored the subject of all 50 posts glued together — 1164 characters —
    // and then threw building the embed.
    expect(result[0]).toBe('Welcome new members!');
    expect(result[0].length).toBeLessThanOrEqual(256);
    expect(result[2]).toBe('Sun, 29 July 2012, 09:51:16');
  });

  it('reads a guest OP name from the h4 rather than a profile link', async () => {
    stubFetch(fixture('topic-33429.html'));

    const result = (await verify('33429')) as any[];

    // Guests have no profile anchor at all, so keying off <a> returned ''.
    expect(result[3]).toBe('fartq');
    expect(result[4]).toBe(0);   // no u= in the href -> no op id
    expect(result[7]).toBe('');  // guests carry no postcount
  });

  it('reads the opening post on a long thread with a registered OP', async () => {
    stubFetch(fixture('topic-33106.html'));

    const result = (await verify('33106')) as any[];

    // 50 posts on page 1, so the unscoped selector had plenty to concatenate.
    expect(result[0]).toBe('Bug Reports');
    expect(result[0].length).toBeLessThanOrEqual(256);
    expect(result[2]).toBe('Fri, 20 July 2012, 23:29:55');
    expect(result[3]).toBe('mkawa');
    expect(result[7]).toBe('6562');
  });
});
