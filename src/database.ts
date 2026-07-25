import { MongoClient, Collection, Document, Long } from 'mongodb';
import { MONGO_URI } from './config.js';
import {
  Address,
  FollowingDoc,
  ListeningDoc,
  WatchingDoc,
  ServingDoc,
} from './types/index.js';
import { log } from './logger.js';

const toLong = (val: Address) => Long.fromString(String(val));

// Legacy docs from the Python bot store addresses as int64 (Long); new writes
// use strings. Match either representation.
const sameAddress = (a: Address, b: Address) => String(a) === String(b);
const addressVariants = (address: Address) => {
  const variants: unknown[] = [String(address)];
  try {
    variants.push(toLong(address));
  } catch {
    // non-numeric address (only happens in tests) — string form is enough
  }
  return variants;
};

let client: MongoClient;

let db: ReturnType<typeof client.db>;
let following: Collection<FollowingDoc>;
let listening: Collection<ListeningDoc>;
let watching: Collection<WatchingDoc>;
let serving: Collection<ServingDoc>;

export function setDBClient(uri: string): void {
  if (!uri) return;
  client = new MongoClient(uri);
}

// Initialize with default URI at module load for backward compatibility
setDBClient(MONGO_URI);

export async function connectDB(): Promise<void> {
  if (!client) {
    setDBClient(MONGO_URI);
  }
  await client.connect();
  db = client.db('gw');
  following = db.collection<FollowingDoc>('following');
  listening = db.collection<ListeningDoc>('listening');
  watching = db.collection<WatchingDoc>('watching');
  serving = db.collection<ServingDoc>('serving');
  log('Connected to MongoDB');
}

export function getCollections() {
  return { following, listening, watching, serving };
}

export async function disconnectDB(): Promise<void> {
  if (client) {
    await client.close();
    log('Disconnected from MongoDB');
  }
}

export async function idIter<T extends { _id?: number }>(col: Collection<T>): Promise<number> {
  try {
    const last = await col.findOne({}, { sort: { _id: -1 } as any });
    return ((last?._id as unknown as number) ?? 0) + 1;
  } catch {
    return 1;
  }
}

export async function follow(
  user_id: number | string,
  target: string,
  target_id: number,
  address: string,
  response: [string, number]
): Promise<boolean> {
  const isTopic = Number(target_id) >= 10000;
  const method = sameAddress(user_id, address) ? 'dm' : 'channel';
  const ul = toLong(user_id);

  // Ensure the doc exists with a numeric _id from idIter — an upsert here
  // would create it with an ObjectId _id, which sorts above all numbers and
  // breaks idIter for every subsequent insert
  const doc = await follows(user_id);

  // `watching`/`listening` are the delivery lists; `following` is the ownership
  // list that /following renders and /unfollow acts on. Keying off listen()/
  // watch() alone meant an address already on the delivery list produced no
  // ownership row at all — the subscription kept delivering while belonging to
  // nobody, invisible to /following and impossible to remove. Write ownership
  // whenever this user doesn't already have it, which also adopts such orphans.
  if (isTopic) {
     const owned = (doc.following.topics ?? []).some(
       t => t.topic_id === target_id && sameAddress(t.address, address)
     );
     const added = await listen(response as [string, number], address, method);
     if (added || !owned) {
       if (!owned) {
         // Matched with sameAddress rather than $addToSet: legacy rows store
         // the address as int64 and new writes use strings, and $addToSet
         // compares whole subdocuments — so Long(x) and "x" both survive as
         // separate, identical-looking entries.
         await following.updateOne(
           { user_id: ul },
           { $addToSet: { 'following.topics': { topic: target, topic_id: target_id, address } } }
         );
       }
       return true;
     }
     return false;
   } else {
     const owned = (doc.following.boards ?? []).some(
       b => b.board_id === target_id && sameAddress(b.address, address)
     );
     const added = await watch(response as [string, number], address, method);
     if (added || !owned) {
       if (!owned) {
         await following.updateOne(
           { user_id: ul },
           { $addToSet: { 'following.boards': { board: target, board_id: target_id, address } } }
         );
       }
       return true;
     }
     return false;
   }
}

export async function follows(user_id: number | string): Promise<FollowingDoc> {
  const ul = toLong(user_id);
  const doc = await following.findOne({ user_id: ul }) as FollowingDoc | null;
  if (!doc) {
    const id = await idIter(following);
    const newDoc: FollowingDoc = {
      _id: id,
      user_id: ul,
      following: { topics: [], boards: [] },
    };
    await following.insertOne(newDoc);
    return newDoc;
  }
  return doc;
}

export async function unfollow(
  user_id: number | string,
  idx: string
): Promise<boolean | [string, number]> {
  if (idx === 'all') {
    const doc = await follows(user_id);
    const topics = doc.following.topics || [];
    const boards = doc.following.boards || [];
    if (topics.length === 0 && boards.length === 0) {
      return false;
    }
    for (const t of topics) {
      await unlisten(t.topic_id, user_id, t.address);
    }
    for (const b of boards) {
      await unwatch(b.board_id, user_id, b.address);
    }
    await following.updateOne(
      { user_id: toLong(user_id) },
      { $set: { 'following.topics': [], 'following.boards': [] } }
    );
    return true;
  }

  const i = parseInt(idx, 10);
  if (isNaN(i) || i < 1 || i > 20) return false;

  const doc = await follows(user_id);
  let index = i - 1;
  const topics = doc.following.topics || [];
  const boards = doc.following.boards || [];

  // Pull by id AND address — the same topic/board can appear twice for one
  // user (channel + DM entries), and only the selected entry may be removed
  if (index >= topics.length) {
    index -= topics.length;
    const match = boards[index];
    if (!match) return false;
    await unwatch(match.board_id, user_id, match.address);
    await following.updateOne(
      { user_id: toLong(user_id) },
      { $pull: { 'following.boards': { board_id: match.board_id, address: { $in: addressVariants(match.address) } } } } as any
    );
    return [match.board, match.board_id] as [string, number];
  } else {
    const match = topics[index];
    if (!match) return false;
    await unlisten(match.topic_id, user_id, match.address);
    await following.updateOne(
      { user_id: toLong(user_id) },
      { $pull: { 'following.topics': { topic_id: match.topic_id, address: { $in: addressVariants(match.address) } } } } as any
    );
    return [match.topic, match.topic_id] as [string, number];
  }
}

export async function listen(
  response: [string, number],
  address: string,
  method: 'channel' | 'dm'
): Promise<boolean> {
  const [topic, topic_id] = response;
  const exists = await listening.findOne({ topic_id });

  if (!exists) {
    const id = await idIter(listening);
    log(`Now listening in ${topic_id}`);
    await listening.insertOne({
      _id: id,
      topic,
      topic_id,
      last: 0,
      to: { channel: method === 'channel' ? [address] : [], dm: method === 'dm' ? [address] : [] },
    });
    return true;
  }

  const l = exists.to;
  if (method === 'channel') {
    if (!(l?.channel ?? []).some(a => sameAddress(a, address))) {
      await listening.updateOne(
        { topic_id },
        { $addToSet: { 'to.channel': address } }
      );
      return true;
    }
  } else {
    if (!(l?.dm ?? []).some(a => sameAddress(a, address))) {
      await listening.updateOne(
        { topic_id },
        { $addToSet: { 'to.dm': address } }
      );
      return true;
    }
  }
  return false;
}

export async function unlisten(topic_id: number, user_id: number | string, address: Address): Promise<void> {
  const pull = { $in: addressVariants(address) };
  if (!sameAddress(user_id, address)) {
    await listening.updateOne({ topic_id }, { $pull: { 'to.channel': pull } } as any);
  } else {
    await listening.updateOne({ topic_id }, { $pull: { 'to.dm': pull } } as any);
  }
}

export async function listens(): Promise<ListeningDoc[]> {
  return listening.find({}).toArray();
}

export async function listened(topic_id: number, post: number): Promise<void> {
  await listening.updateOne({ topic_id }, { $set: { last: post } });
}

export async function listen_dupe(topic_id: number): Promise<Address[]> {
  const doc = await listening.findOne({ topic_id });
  if (doc?.to?.channel && doc.to.channel.length > 0) {
    return doc.to.channel;
  }
  return ['0'];
}

export async function watch(
  response: [string, number],
  address: string,
  method: 'channel' | 'dm'
): Promise<boolean> {
  const [board, board_id] = response;
  const exists = await watching.findOne({ board_id });

  if (!exists) {
    const id = await idIter(watching);
    log(`Now watching ${board_id}`);
    await watching.insertOne({
      _id: id,
      board,
      board_id,
      last: 0,
      to: { channel: method === 'channel' ? [address] : [], dm: method === 'dm' ? [address] : [] },
    });
    return true;
  }

  const l = exists.to;
  if (method === 'channel') {
    if (!(l?.channel ?? []).some(a => sameAddress(a, address))) {
      await watching.updateOne(
        { board_id },
        { $addToSet: { 'to.channel': address } }
      );
      return true;
    }
  } else {
    if (!(l?.dm ?? []).some(a => sameAddress(a, address))) {
      await watching.updateOne(
        { board_id },
        { $addToSet: { 'to.dm': address } }
      );
      return true;
    }
  }
  return false;
}

export async function watched(board_id: number, topic_id: number): Promise<void> {
  await watching.updateOne({ board_id }, { $set: { last: topic_id } });
}

// The legacy Python bot's watched() wrote the latest-announced topic to a
// `topic_id` field and never updated `last`, so legacy docs carry a stale
// `last`. Fold the two together once on startup so the watcher doesn't
// re-announce years of topics.
export async function migrateWatchingLast(): Promise<void> {
  await watching.updateMany({}, [
    {
      $set: {
        last: { $max: [{ $ifNull: ['$last', 0] }, { $ifNull: ['$topic_id', 0] }] },
      },
    },
    { $unset: ['topic_id'] },
  ] as any);
}

/**
 * Addresses some user actually claims for this board/topic.
 *
 * The per-server duplicate check must key off ownership, not delivery: an
 * orphaned delivery address (on watching/listening but in nobody's list) would
 * otherwise reject every future follow for that whole server, with no way for
 * anyone to clear it.
 */
export async function watchOwners(board_id: number): Promise<Address[]> {
  const docs = await following.find({ 'following.boards.board_id': board_id }).toArray();
  const out: Address[] = [];
  for (const doc of docs) {
    for (const b of doc.following?.boards ?? []) {
      if (b.board_id === board_id) out.push(b.address);
    }
  }
  return out;
}

export async function listenOwners(topic_id: number): Promise<Address[]> {
  const docs = await following.find({ 'following.topics.topic_id': topic_id }).toArray();
  const out: Address[] = [];
  for (const doc of docs) {
    for (const t of doc.following?.topics ?? []) {
      if (t.topic_id === topic_id) out.push(t.address);
    }
  }
  return out;
}

export async function watch_dupe(board_id: number): Promise<Address[]> {
  const doc = await watching.findOne({ board_id });
  if (doc?.to?.channel && doc.to.channel.length > 0) {
    return doc.to.channel;
  }
  return ['0'];
}

export async function unwatch(board_id: number, user_id: number | string, address: Address): Promise<void> {
  const pull = { $in: addressVariants(address) };
  if (!sameAddress(user_id, address)) {
    await watching.updateOne({ board_id }, { $pull: { 'to.channel': pull } } as any);
  } else {
    await watching.updateOne({ board_id }, { $pull: { 'to.dm': pull } } as any);
  }
}

export async function watches(): Promise<WatchingDoc[]> {
  return watching.find({}).toArray();
}

export async function serves(): Promise<ServingDoc[]> {
  return serving.find({}).toArray();
}

export async function serve(server: string, server_id: string): Promise<void> {
  const doc = await serving.findOne({ server_id: toLong(server_id) });
  if (!doc) {
    const id = await idIter(serving);
    await serving.insertOne({
      _id: id,
      server,
      server_id: toLong(server_id),
      unrestricting: false,
      serving: true,
    });
  } else {
    await serving.updateOne(
      { server_id: toLong(server_id) },
      { $set: { server, serving: true } }
    );
  }
}

export async function unserve(server: string, server_id: string): Promise<void> {
  const doc = await serving.findOne({ server_id: toLong(server_id) });
  if (!doc) {
    const id = await idIter(serving);
    await serving.insertOne({
      _id: id,
      server,
      server_id: toLong(server_id),
      unrestricting: false,
      serving: false,
    });
  } else {
    await serving.updateOne(
      { server_id: toLong(server_id) },
      { $set: { serving: false } }
    );
  }
}

export async function unrestricts(sid: string, cid: string): Promise<boolean> {
  try {
    const doc = await serving.findOne({ server_id: toLong(sid) });
    if (!doc) return false;
    const u = doc.unrestricting;
    if (u === false) return false;
    const channelId = toLong(cid);
    return (u as any[]).some((v: any) => v.toString() === channelId.toString());
  } catch {
    return false;
  }
}

export async function unrestrict(sid: string, cid: string): Promise<boolean> {
  const doc = await serving.findOne({ server_id: toLong(sid) });
  const channelId = toLong(cid);

  // No serving doc yet (guild joined while the bot was offline never gets a
  // GuildCreate/serve call) — create one so the unrestrict still takes effect
  if (!doc) {
    const id = await idIter(serving);
    await serving.insertOne({
      _id: id,
      server: '',
      server_id: toLong(sid),
      unrestricting: [channelId],
      serving: true,
    });
    return true;
  }

  const u = doc.unrestricting;
  if (Array.isArray(u)) {
    if (u.some((v: any) => String(v) === String(channelId))) return false;
    await serving.updateOne(
      { server_id: toLong(sid) },
      { $addToSet: { unrestricting: channelId } } as any
    );
    return true;
  }

  // unrestricting is false, or missing on a legacy doc
  await serving.updateOne(
    { server_id: toLong(sid) },
    { $set: { unrestricting: [channelId] } }
  );
  return true;
}

export async function restrict(sid: string, cid: string): Promise<boolean> {
  const wasUnrestricted = await unrestricts(sid, cid);
  if (!wasUnrestricted) {
    return false;
  }
  await serving.updateOne(
    { server_id: toLong(sid) },
    { $pull: { unrestricting: toLong(cid) } as any }
  );
  const doc = await serving.findOne({ server_id: toLong(sid) });
  if (Array.isArray(doc?.unrestricting) && doc.unrestricting.length === 0) {
    await serving.updateOne(
      { server_id: toLong(sid) },
      { $set: { unrestricting: false } }
    );
  }
  return true;
}

export async function clean(method: 'channel' | 'dm', address: Address): Promise<void> {
  const variants = { $in: addressVariants(address) };
  await following.updateMany({}, { $pull: { 'following.topics': { address: variants } } } as any);
  await following.updateMany({}, { $pull: { 'following.boards': { address: variants } } } as any);
  await listening.updateMany({}, { $pull: { [`to.${method}`]: variants } } as any);
  await watching.updateMany({}, { $pull: { [`to.${method}`]: variants } } as any);
}
