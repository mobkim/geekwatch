import { Client, TextChannel } from 'discord.js';
import { listens, listened, clean } from './database.js';
import { log } from './logger.js';
import { GEEKHACK_BASE } from './config.js';
import { topicPostEmbed } from './embeds.js';
import { parseRecentTopics } from './scraper.js';

import * as cheerio from 'cheerio';

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.87 Safari/537.36' };

/** Posts geekhack renders on one topic page. */
const POSTS_PER_PAGE = 50;

/** Ceiling on posts announced per topic per tick, so a burst can't flood a channel. */
const MAX_POSTS_PER_TICK = 10;

async function fetchPage(url: string): Promise<cheerio.CheerioAPI | null> {
  try {
    const signal = AbortSignal.timeout(5000);
    const resp = await fetch(url, { headers: HEADERS, signal });
    if (!resp.ok) return null;
    const text = await resp.text();
    return cheerio.load(text);
  } catch {
    return null;
  }
}

/**
 * Build the embed for one post, or null if it isn't by the thread starter.
 *
 * `offset` is the post's index within the topic (0 = opening post, N = Reply #N).
 */
function buildPostEmbed(
  $: cheerio.CheerioAPI,
  postWrapper: cheerio.Cheerio<any>,
  topic_id: number,
  topic_title: string,
  offset: number
) {
  const posterDiv = postWrapper.find('div.poster').first();
  if (posterDiv.length === 0) return null;

  const threadStarter = posterDiv.find('li.threadstarter');
  if (threadStarter.length === 0) return null;

  const innerDiv = postWrapper.find('div.inner').first();
  if (innerDiv.length === 0) return null;

  // Remove blockquotes from text
  const tempInner = innerDiv.clone();
  tempInner.find('blockquote').remove();
  tempInner.find('div.topslice_quote').remove();
  let response = tempInner.text().trim();
  response = response.replace(/\n{3,}/g, '\n\n');

  // Find replied-to users
  const replyList: string[] = [];
  innerDiv.find('div.topslice_quote').each((_, qEl) => {
    const text = $(qEl).text();
    const onIdx = text.indexOf('on');
    if (onIdx > 12) {
      replyList.push(text.slice(12, onIdx - 1));
    }
  });

  const quoted = replyList.length > 0 ? replyList.join(' & ') : '';
  const kind = quoted ? `Response to ${quoted}` : 'Direct Post';

  let image = '';
  try {
    const highslide = postWrapper.find('a.highslide').first();
    if (highslide.length > 0) {
      image = highslide.attr('href') || '';
    }
  } catch {
    image = '';
  }

  let opIcon = '';
  try {
    const avatar = postWrapper.find('li.avatar img.avatar').first();
    if (avatar.length > 0) {
      opIcon = avatar.attr('src') || '';
    }
  } catch {
    opIcon = '';
  }

  const opScore = posterDiv.find('li.postcount').text().replace('Posts: ', '');
  // h4 carries the name for guests (no profile link) and members alike.
  const opName = posterDiv.find('h4').text().trim() || posterDiv.find('a').text().trim();

  // The date line and the permalink live in div.keyinfo, not div.poster —
  // scoping these to posterDiv matched nothing, so every embed carried an
  // empty timestamp and fell back to a topic-level link.
  const keyinfo = postWrapper.find('div.keyinfo').first();

  const smalltext = keyinfo.find('div.smalltext').text();
  const cleanTime = smalltext.replace('« ', '').replace(' »', '');
  const replyNumIdx = cleanTime.indexOf(' on: ');
  const datePart = replyNumIdx !== -1 ? cleanTime.slice(replyNumIdx + 5) : cleanTime;
  const replyNumPart = replyNumIdx !== -1 ? cleanTime.slice(0, replyNumIdx + 5).replace(' on: ', '').replace('Reply ', '') : '';
  const timestamp = `${datePart} | ${replyNumPart}`;

  let msgHref = '';
  try {
    const msgLink = keyinfo.find('h5 a').first();
    if (msgLink.length > 0) {
      const msg = msgLink.attr('href') || '';
      const hashIdx = msg.indexOf('#');
      if (hashIdx !== -1) {
        const msgn = msg.slice(hashIdx + 1);
        msgHref = `${GEEKHACK_BASE}/index.php?topic=${topic_id}.${msgn}#${msgn}`;
      }
    }
  } catch {
    // ignore
  }

  if (!msgHref) {
    msgHref = `${GEEKHACK_BASE}/index.php?topic=${topic_id}.${offset}`;
  }

  // The Python set the author url to topic_href, but read it from a closure
  // variable that the scan loop had already advanced to the last recent topic
  // — so every embed linked to whichever thread happened to be scanned last.
  // topic_id is passed in per topic here, so the link is actually correct.
  const topicHref = `${GEEKHACK_BASE}/index.php?topic=${topic_id}`;

  return topicPostEmbed(kind, msgHref, response, topic_title, opName, opScore, opIcon, image, timestamp, topicHref);
}

/**
 * Announce the thread starter's posts at offsets `from..to` (inclusive).
 *
 * geekhack floors the `.N` start offset to a 50-post page boundary, so
 * `topic=X.118` renders replies #100-#149 and the wanted post sits at index
 * `118 % 50` on that page. Deriving the offset arithmetically avoids reading
 * the page number out of `div.pagelinks`, whose last node is the "Go Down"
 * link — `parseInt` returned NaN there, which poisoned the scan index and made
 * the loop body never run.
 */
export async function processTopic(
  client: Client,
  topic_id: number,
  from: number,
  to: number,
  topic_title: string
): Promise<void> {
  const embeds: ReturnType<typeof topicPostEmbed>[] = [];
  const firstPage = Math.floor(from / POSTS_PER_PAGE) * POSTS_PER_PAGE;

  for (let pageStart = firstPage; pageStart <= to; pageStart += POSTS_PER_PAGE) {
    const $ = await fetchPage(`${GEEKHACK_BASE}/index.php?topic=${topic_id}.${pageStart}`);
    if (!$) return;

    const infoDivs = $('div.keyinfo');
    for (let i = 0; i < infoDivs.length; i++) {
      const offset = pageStart + i;
      if (offset < from) continue;
      if (offset > to) break;

      const postWrapper = infoDivs.eq(i).closest('div.post_wrapper');
      if (postWrapper.length === 0) continue;

      const embed = buildPostEmbed($, postWrapper, topic_id, topic_title, offset);
      if (embed) embeds.push(embed);
    }
  }

  if (embeds.length === 0) return;

  const listeningDocs = await listens();
  const matchedDoc = listeningDocs.find(l => l.topic_id === topic_id);
  if (!matchedDoc) return;

  for (const embed of embeds) {
    if (matchedDoc.to.channel && matchedDoc.to.channel.length > 0) {
      for (const address of matchedDoc.to.channel.map(String)) {
        try {
          const channel = client.channels.cache.get(address);
          if (!channel || !(channel instanceof TextChannel)) {
            clean('channel', address);
            continue;
          }
          await channel.send({ embeds: [embed] }).catch(() => {});
        } catch {
          clean('channel', address);
        }
      }
    }

    if (matchedDoc.to.dm && matchedDoc.to.dm.length > 0) {
      for (const address of matchedDoc.to.dm.map(String)) {
        try {
          const user = await client.users.fetch(address);
          await user.send({ embeds: [embed] }).catch(() => {
            clean('dm', address);
          });
        } catch {
          clean('dm', address);
        }
      }
    }
  }
}

export function startListener(client: Client): void {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;

    try {
      const recent$ = await fetchPage(`${GEEKHACK_BASE}/index.php?action=recenttopics`);
      if (!recent$) {
        running = false;
        return;
      }

      const recentTopics = parseRecentTopics(recent$);

      const listeningDocs = await listens();
      const tasks: Promise<void>[] = [];

      for (const rt of recentTopics) {
        const matched = listeningDocs.find(l => l.topic_id === rt.topic_id);
        if (!matched) continue;
        if (rt.post <= matched.last) continue;

        tasks.push(listened(rt.topic_id, rt.post).catch(() => {}));

        // Scan every post since `last`, not just the newest. recenttopics only
        // reports a topic's most recent poster, so gating on `poster_id ===
        // op_id` dropped the OP's post whenever someone else replied after it
        // within one tick. buildPostEmbed does the thread-starter filtering.
        // On a fresh follow (`last === 0`) only announce the newest post rather
        // than backfilling the thread's history.
        const from =
          matched.last === 0 ? rt.post : Math.max(matched.last + 1, rt.post - MAX_POSTS_PER_TICK + 1);

        tasks.push(processTopic(client, rt.topic_id, from, rt.post, rt.topic));
      }

      await Promise.all(tasks);
    } catch (err) {
      log(`Listener error: ${err}`);
    } finally {
      running = false;
    }
  }

  setInterval(tick, 60000);
  log('Listener started');
}
