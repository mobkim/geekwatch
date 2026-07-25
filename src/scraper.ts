import * as cheerio from 'cheerio';
import { GEEKHACK_BASE, USER_AGENT } from './config.js';
import { ScraperResult, ScraperTopicResult, ScraperBoardResult, RecentTopic } from './types/index.js';

const HEADERS = { 'User-Agent': USER_AGENT };
const BAD_TITLES = ['An Error Has Occurred!', 'Login', 'geekhack - Index'];

function parseId(input: string, key: string): string {
  const idx = input.indexOf(key + '=');
  if (idx === -1) return '';
  const after = input.slice(idx + key.length + 1);
  const eqIdx = after.indexOf('=');
  if (eqIdx !== -1) return after.slice(0, eqIdx);
  return after;
}

function extractId(raw: string): string {
  const dotIdx = raw.indexOf('.');
  return dotIdx !== -1 ? raw.slice(0, dotIdx) : raw;
}

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

async function fetchTopicPage(topicId: number): Promise<cheerio.CheerioAPI | null> {
  return fetchPage(`${GEEKHACK_BASE}/index.php?topic=${topicId}.0`);
}

async function fetchBoardPage(boardId: number): Promise<cheerio.CheerioAPI | null> {
  return fetchPage(`${GEEKHACK_BASE}/index.php?board=${boardId}.0`);
}

function getImageSrc($: cheerio.CheerioAPI, selector: string): string {
  const el = $(selector);
  if (el.length === 0) return '';
  let href = el.attr('href') || '';
  if (href && href.includes('https://geekhack.org/index.php?')) {
    const actionIdx = href.indexOf('action');
    if (actionIdx !== -1) {
      href = `${GEEKHACK_BASE}/index.php?${href.slice(actionIdx)}`;
    }
  }
  return href;
}

function parseTopicInfo($: cheerio.CheerioAPI): {
  topic: string;
  topic_id: number;
  date: string;
  op_name: string;
  op_id: number;
  op_flair: string;
  op_icon: string;
  op_score: string;
  image: string;
} | null {
  // One div.keyinfo per post on the page. The Python used soup.find(), which
  // takes the first match only — cheerio's .text() concatenates every match,
  // so an unscoped selector returned every post's subject glued together and
  // every timestamp in a row. Scope to the opening post.
  const keyinfo = $('div.keyinfo').first();
  const topic = keyinfo.find('a').first().text().trim();

  const smalltext = keyinfo.find('div.smalltext').text().trim();
  const date = smalltext.slice(7, smalltext.length - 2);

  const posters = $('div.poster');
  if (posters.length === 0) return null;

  const op = posters[0];
  // Guests have no profile link — their name sits in the <h4> with no <a> at
  // all, so keying off the anchor returned an empty author. h4 holds the name
  // for registered users too.
  const opName = $(op).find('h4').text().trim() || $(op).find('a').text().trim();
  const opHref = $(op).find('a').attr('href') || '';
  const uidMatch = opHref.match(/u=(\d+)/);
  const opId = uidMatch ? parseInt(uidMatch[1], 10) : 0;

  const postcount = $(op).find('li.postcount').text();
  const opScore = postcount.replace('Posts: ', '');

  try {
    const flairEl = $(op).find('li.membergroup img');
    const opFlair = flairEl.attr('src') || '';
    const iconEl = $(op).find('li.avatar img');
    let opIcon = iconEl.attr('src') || '';
    if (opIcon && opIcon.includes('action')) {
      opIcon = `${GEEKHACK_BASE}/index.php?${opIcon.slice(opIcon.indexOf('action'))}`;
    }

    const highspins = $('a.highslide');
    let image = '';
    if (highspins.length > 1) {
      image = highspins[1].attribs.href || '';
    } else if (highspins.length > 0) {
      image = highspins[0].attribs.href || '';
    } else {
      image = `${GEEKHACK_BASE}/Themes/Nostalgia/images/banner.png`;
    }
    if (image && image.includes('https://geekhack.org/index.php?')) {
      const actionIdx = image.indexOf('action');
      if (actionIdx !== -1) {
        image = `${GEEKHACK_BASE}/index.php?${image.slice(actionIdx)}`;
      }
    }

    return { topic, topic_id: 0, date, op_name: opName, op_id: opId, op_flair: opFlair, op_icon: opIcon, op_score: opScore, image };
  } catch {
    return { topic, topic_id: 0, date, op_name: opName, op_id: opId, op_flair: '', op_icon: '', op_score: '', image: '' };
  }
}

export async function verify(userInput: string): Promise<ScraperResult> {
  let targetId: string;
  let target: 'topic' | 'board' | null = null;

  if (userInput.includes('topic=')) {
    target = 'topic';
    targetId = parseId(userInput, 'topic');
  } else if (userInput.includes('board=')) {
    target = 'board';
    targetId = parseId(userInput, 'board');
  } else {
    targetId = userInput;
  }

  const id = extractId(targetId);

  if (target === 'board') {
    const $ = await fetchBoardPage(parseInt(id, 10));
    if (!$) return 503;
    const title = $.text().slice(0, 30);
    // Check page title
    const pageTitle = $('title').text().trim();
    if (BAD_TITLES.includes(pageTitle)) return 404;
    const boardTitle = $('title').text().trim();
    if (BAD_TITLES.includes(boardTitle)) return 404;
    return [boardTitle, parseInt(id, 10)] as ScraperBoardResult;
  }

  // Try topic first
  const topicPage = await fetchTopicPage(parseInt(id, 10));
  if (!topicPage) return 503;

  const topicTitle = topicPage('title').text().trim();
  if (BAD_TITLES.includes(topicTitle)) {
    // Try as board
    const boardPage = await fetchBoardPage(parseInt(id, 10));
    if (!boardPage) return 503;
    const boardTitle = boardPage('title').text().trim();
    if (BAD_TITLES.includes(boardTitle)) return 404;
    return [boardTitle, parseInt(id, 10)] as ScraperBoardResult;
  }

  const info = parseTopicInfo(topicPage);
  if (!info) return 503;
  const topicId = parseInt(id, 10);
  return [
    info.topic,
    topicId,
    info.date,
    info.op_name,
    info.op_id,
    info.op_flair,
    info.op_icon,
    info.op_score,
    info.image || `${GEEKHACK_BASE}/Themes/Nostalgia/images/banner.png`,
  ] as ScraperTopicResult;
}

export async function sort(boardId: number): Promise<number> {
  const front: number[] = [];
  for (let p = 0; p < 300; p += 50) {
    const $ = await fetchPage(
      `${GEEKHACK_BASE}/index.php?board=${boardId}.${p};sort=last_post;desc`
    );
    if (!$) continue;
    $('td.subject.windowbg2').each((_, el) => {
      const href = $(el).find('a').attr('href') || '';
      const match = href.match(/topic=(\d+)/);
      if (match) front.push(parseInt(match[1], 10));
    });
  }
  front.sort((a, b) => a - b);
  return front.length > 0 ? front[front.length - 1] : 0;
}

export function parseRecentTopics($: cheerio.CheerioAPI): RecentTopic[] {
  const results: RecentTopic[] = [];

  $('tr[class*="windowbg"]').each((_, el) => {
    const links = $(el).find('a');
    if (links.length < 5) return;

    const t = links[2].attribs.href || '';
    const op = links[4].attribs.href || '';
    const lp = links[1].attribs.href || '';

    const topic = $(links[2]).text().trim();
    const topicMatch = t.match(/topic=(\d+)/);
    if (!topicMatch) return;
    const topic_id = parseInt(topicMatch[1], 10);

    const opIdMatch = op.match(/u=(\d+)/);
    const op_id = opIdMatch ? parseInt(opIdMatch[1], 10) : 0;

    const posterIdMatch = lp.match(/u=(\d+)/);
    const poster_id = posterIdMatch ? parseInt(posterIdMatch[1], 10) : 0;

    // The reply count is the only all-digit cell in the row. Don't index into
    // td.smalltext — the first one is the last-poster column ("mcmcmc35
    // minutes ago"), which parseInt reads as NaN and silently drops the row.
    let post = -1;
    $(el)
      .find('td.smalltext')
      .each((_, cell) => {
        const text = $(cell).text().trim();
        if (post === -1 && /^\d+$/.test(text)) post = parseInt(text, 10);
      });
    if (post === -1) return;

    results.push({
      topic,
      topic_id,
      topic_href: `${GEEKHACK_BASE}/index.php?topic=${topic_id}`,
      op_id,
      poster_id,
      post,
    });
  });

  return results.reverse();
}

export async function getBoardTopics(boardId: number): Promise<number[]> {
  const $ = await fetchPage(
    `${GEEKHACK_BASE}/index.php?board=${boardId}.0;sort=last_post;desc`
  );
  if (!$) return [];
  const front: number[] = [];
  $('td.subject.windowbg2').each((_, el) => {
    const href = $(el).find('a').attr('href') || '';
    const match = href.match(/topic=(\d+)/);
    if (match) front.push(parseInt(match[1], 10));
  });
  front.sort((a, b) => a - b);
  return front;
}

export async function getTopicPage(topicId: number): Promise<cheerio.CheerioAPI | null> {
  return fetchPage(`${GEEKHACK_BASE}/index.php?topic=${topicId}.0`);
}
