import { describe, it, expect } from 'vitest';
import {
  idIter,
  follow,
  follows,
  unfollow,
  listen,
  unlisten,
  listens,
  listened,
  listen_dupe,
  watch,
  unwatch,
  watches,
  watched,
  watch_dupe,
  watchOwners,
  listenOwners,
  serve,
  unserve,
  serves,
  unrestricts,
  unrestrict,
  restrict,
   clean,
   getCollections,
} from '../src/database.js';
import { Collection, Long } from 'mongodb';

async function clearCollections() {
  const { following, listening, watching, serving } = getCollections();
  await following.deleteMany({});
  await listening.deleteMany({});
  await watching.deleteMany({});
  await serving.deleteMany({});
}

describe('database', () => {
  beforeEach(async () => clearCollections());
  afterEach(async () => clearCollections());

  describe('connectDB / disconnectDB', () => {
    it('should connect and create collections', async () => {
      const col = getCollections();
      expect(col.following).toBeDefined();
      expect(col.listening).toBeDefined();
      expect(col.watching).toBeDefined();
      expect(col.serving).toBeDefined();
    });
  });

  describe('idIter', () => {
    it('returns 1 for an empty collection', async () => {
      const col = getCollections();
      const id = await idIter(col.following as unknown as Collection<{ _id?: number }>);
      expect(id).toBe(1);
    });

    it('increments correctly after inserts', async () => {
      const col = getCollections();
      await col.following.insertOne({ _id: 1, user_id: 'u1', following: { topics: [], boards: [] } });
      await col.following.insertOne({ _id: 2, user_id: 'u2', following: { topics: [], boards: [] } });
      const id = await idIter(col.following as unknown as Collection<{ _id?: number }>);
      expect(id).toBe(3);
    });
  });

  describe('follow / unfollow (topics)', () => {
    it('follows a topic and stores it', async () => {
      const result = await follow('user1', 'Test Topic', 12345, 'user1', ['Test Topic', 12345]);
      expect(result).toBe(true);

      const doc = await follows('user1');
      expect(doc.following.topics.length).toBe(1);
      expect(doc.following.topics[0].topic).toBe('Test Topic');
      expect(doc.following.topics[0].topic_id).toBe(12345);
    });

    it('unfollows a topic by index', async () => {
      await follow('user1', 'Test Topic', 12345, 'user1', ['Test Topic', 12345]);
      const result = await unfollow('user1', '1');
      expect(Array.isArray(result)).toBe(true);
      expect((result as [string, number])[0]).toBe('Test Topic');

      const doc = await follows('user1');
      expect(doc.following.topics.length).toBe(0);
    });

    it('unfollows all', async () => {
      await follow('user1', 'Topic A', 12345, 'user1', ['Topic A', 12345]);
      await follow('user1', 'Topic B', 12346, 'user1', ['Topic B', 12346]);
      const result = await unfollow('user1', 'all');
      expect(result).toBe(true);
      const doc = await follows('user1');
      expect(doc.following.topics.length).toBe(0);
    });

    it('follow creates docs with numeric _ids matching the legacy int scheme', async () => {
      await follow('111', 'Topic', 12345, '111', ['Topic', 12345]);
      await follow('222', 'Topic', 12345, '222', ['Topic', 12345]);

      const { following } = getCollections();
      const docs = await following.find({}).toArray();
      expect(docs.length).toBe(2);
      for (const doc of docs) {
        expect(typeof doc._id).toBe('number');
      }
      expect(await idIter(following)).toBe(Math.max(...docs.map(d => d._id as number)) + 1);
    });

    it('unfollow removes only the selected entry when a topic is followed in channel and DM', async () => {
      // Same user, same topic, two addresses: channel entry then DM entry
      await follow('111', 'Dual Topic', 12345, '555', ['Dual Topic', 12345]);
      await follow('111', 'Dual Topic', 12345, '111', ['Dual Topic', 12345]);
      let doc = await follows('111');
      expect(doc.following.topics.length).toBe(2);

      // Index 1 is the channel entry
      const removed = await unfollow('111', '1');
      expect(removed).toEqual(['Dual Topic', 12345]);

      doc = await follows('111');
      expect(doc.following.topics.length).toBe(1);
      expect(String(doc.following.topics[0].address)).toBe('111');

      // The DM subscription must still be live; the channel one gone
      const { listening } = getCollections();
      const ldoc = await listening.findOne({ topic_id: 12345 });
      expect((ldoc!.to.dm ?? []).map(String)).toContain('111');
      expect((ldoc!.to.channel ?? []).map(String)).not.toContain('555');
    });
  });

  describe('follow / unfollow (boards)', () => {
    it('follows a board and stores it', async () => {
      const result = await follow('user1', 'Test Board', 5, 'user1', ['Test Board', 5]);
      expect(result).toBe(true);

      const doc = await follows('user1');
      expect(doc.following.boards.length).toBe(1);
      expect(doc.following.boards[0].board).toBe('Test Board');
      expect(doc.following.boards[0].board_id).toBe(5);
    });

    it('unfollows a board by index', async () => {
      await follow('user1', 'Test Board', 5, 'user1', ['Test Board', 5]);
      const result = await unfollow('user1', '1');
      expect(Array.isArray(result)).toBe(true);
      expect((result as [string, number])[0]).toBe('Test Board');
    });
  });

  describe('follow (duplicate)', () => {
    it('returns false when following same topic twice with same address', async () => {
      const r1 = await follow('user1', 'Topic', 12345, 'user1', ['Topic', 12345]);
      expect(r1).toBe(true);
      const r2 = await follow('user1', 'Topic', 12345, 'user1', ['Topic', 12345]);
      expect(r2).toBe(false);
    });
  });

  describe('unfollow all', () => {
    it('clears everything when all are removed', async () => {
      await follow('user1', 'Topic', 12345, 'user1', ['Topic', 12345]);
      await follow('user1', 'Board', 5, 'user1', ['Board', 5]);
      const result = await unfollow('user1', 'all');
      expect(result).toBe(true);
      const doc = await follows('user1');
      expect(doc.following.topics.length).toBe(0);
      expect(doc.following.boards.length).toBe(0);
    });

    it('returns false when there is nothing to unfollow', async () => {
      const result = await unfollow('user1', 'all');
      expect(result).toBe(false);
    });
  });

  describe('unfollow by index', () => {
    it('removes topic at index 1', async () => {
      await follow('user1', 'Topic A', 12345, 'user1', ['Topic A', 12345]);
      await follow('user1', 'Topic B', 12346, 'user1', ['Topic B', 12346]);
      const result = await unfollow('user1', '1');
      expect((result as [string, number])[0]).toBe('Topic A');
      const doc = await follows('user1');
      expect(doc.following.topics.length).toBe(1);
      expect(doc.following.topics[0].topic).toBe('Topic B');
    });

    it('removes board at index after all topics', async () => {
      await follow('user1', 'Topic', 12345, 'user1', ['Topic', 12345]);
      await follow('user1', 'Board A', 5, 'user1', ['Board A', 5]);
      await follow('user1', 'Board B', 6, 'user1', ['Board B', 6]);
      const result = await unfollow('user1', '2');
      expect((result as [string, number])[0]).toBe('Board A');
    });

    it('returns false for invalid index', async () => {
      await follow('user1', 'Topic', 12345, 'user1', ['Topic', 12345]);
      const result = await unfollow('user1', '5');
      expect(result).toBe(false);
    });
  });

  describe('listen / unlisten', () => {
    it('creates a listen entry for a new topic', async () => {
      const result = await listen(['Topic A', 12345], 'channel1', 'channel');
      expect(result).toBe(true);

      const docs = await listens();
      expect(docs.length).toBe(1);
      expect(docs[0].topic_id).toBe(12345);
      expect(docs[0].to.channel).toContain('channel1');
    });

    it('adds an address to an existing listen entry', async () => {
      await listen(['Topic A', 12345], 'channel1', 'channel');
      const result = await listen(['Topic A', 12345], 'channel2', 'channel');
      expect(result).toBe(true);

      const docs = await listens();
      expect(docs[0].to.channel).toContain('channel1');
      expect(docs[0].to.channel).toContain('channel2');
    });

    it('adds a DM address', async () => {
      const result = await listen(['Topic A', 12345], 'user1', 'dm');
      expect(result).toBe(true);
      const docs = await listens();
      expect(docs[0].to.dm).toContain('user1');
    });

    it('unlisten removes channel address', async () => {
      await listen(['Topic A', 12345], 'channel1', 'channel');
      await unlisten(12345, 'user1', 'channel1');
      const docs = await listens();
      expect(docs[0].to.channel).not.toContain('channel1');
    });

    it('unlisten removes dm address', async () => {
      await listen(['Topic A', 12345], 'user1', 'dm');
      await unlisten(12345, 'user1', 'user1');
      const docs = await listens();
      expect(docs[0].to.dm).not.toContain('user1');
    });

    it('listened updates last post', async () => {
      await listen(['Topic A', 12345], 'channel1', 'channel');
      await listened(12345, 42);
      const docs = await listens();
      expect(docs[0].last).toBe(42);
    });
  });

  describe('listen (duplicate)', () => {
    it('returns false when adding same address twice to channel', async () => {
      await listen(['Topic A', 12345], 'channel1', 'channel');
      const result = await listen(['Topic A', 12345], 'channel1', 'channel');
      expect(result).toBe(false);
    });

    it('returns false when adding same dm address twice', async () => {
      await listen(['Topic A', 12345], 'user1', 'dm');
      const result = await listen(['Topic A', 12345], 'user1', 'dm');
      expect(result).toBe(false);
    });
  });

  describe('listen_dupe', () => {
    it('returns channel list when channels are listening', async () => {
      await listen(['Topic A', 12345], 'ch1', 'channel');
      await listen(['Topic A', 12345], 'ch2', 'channel');
      const result = await listen_dupe(12345);
      expect(result).toContain('ch1');
      expect(result).toContain('ch2');
    });

    it('returns ["0"] when no channels are listening', async () => {
      const result = await listen_dupe(12345);
      expect(result).toEqual(['0']);
    });
  });

  describe('orphaned delivery addresses', () => {
    it('adopts a board already on the delivery list but owned by nobody', async () => {
      // Reproduces board 132 / channel 769799450587561994: the address delivers
      // notifications but appears in no user's list, so it could never be seen
      // or removed, and blocked every future follow in that server.
      await watch(['Interest Checks', 132], 'chanOrphan', 'channel');
      expect(await watchOwners(132)).toHaveLength(0);

      const result = await follow('user1', 'Interest Checks', 132, 'chanOrphan', ['Interest Checks', 132]);

      expect(result).toBe(true);
      const doc = await follows('user1');
      expect(doc.following.boards).toContainEqual(
        expect.objectContaining({ board_id: 132, address: 'chanOrphan' })
      );
      expect((await watchOwners(132)).map(String)).toContain('chanOrphan');
    });

    it('adopts an orphaned topic the same way', async () => {
      await listen(['A Topic', 12345], 'chanOrphan', 'channel');
      expect(await listenOwners(12345)).toHaveLength(0);

      const result = await follow('user1', 'A Topic', 12345, 'chanOrphan', ['A Topic', 12345]);

      expect(result).toBe(true);
      expect((await listenOwners(12345)).map(String)).toContain('chanOrphan');
    });

    it('still reports a duplicate when the same user already owns the address', async () => {
      await follow('user1', 'Interest Checks', 132, 'chan1', ['Interest Checks', 132]);

      expect(await follow('user1', 'Interest Checks', 132, 'chan1', ['Interest Checks', 132])).toBe(false);

      const doc = await follows('user1');
      expect(doc.following.boards.filter(b => b.board_id === 132)).toHaveLength(1);
    });

    it('does not duplicate a legacy int64 address row', async () => {
      // Legacy Python rows store the address as int64; $addToSet compares whole
      // subdocuments, so Long(x) and "x" would both survive as separate,
      // identical-looking rows. Ownership is matched with sameAddress instead.
      const { following } = getCollections();
      await follow('4242', 'Interest Checks', 132, '999', ['Interest Checks', 132]);

      // Rewrite the stored address to the legacy int64 form.
      const res = await following.updateOne(
        { user_id: Long.fromString('4242'), 'following.boards.board_id': 132 },
        { $set: { 'following.boards.$.address': Long.fromString('999') } }
      );
      expect(res.modifiedCount).toBe(1);

      await follow('4242', 'Interest Checks', 132, '999', ['Interest Checks', 132]);

      const doc = await follows('4242');
      expect(doc.following.boards.filter(b => b.board_id === 132)).toHaveLength(1);
    });

    it('lists owners separately from delivery addresses', async () => {
      await follow('user1', 'Interest Checks', 132, 'chan1', ['Interest Checks', 132]);
      await watch(['Interest Checks', 132], 'chanOrphan', 'channel');

      const owners = (await watchOwners(132)).map(String);
      const delivery = (await watch_dupe(132)).map(String);

      expect(owners).toEqual(['chan1']);
      expect(delivery).toEqual(expect.arrayContaining(['chan1', 'chanOrphan']));
    });
  });

  describe('watch / unwatch', () => {
    it('creates a watch entry for a new board', async () => {
      const result = await watch(['Board A', 5], 'channel1', 'channel');
      expect(result).toBe(true);

      const docs = await watches();
      expect(docs.length).toBe(1);
      expect(docs[0].board_id).toBe(5);
      expect(docs[0].to.channel).toContain('channel1');
    });

    it('adds a DM address', async () => {
      const result = await watch(['Board A', 5], 'user1', 'dm');
      expect(result).toBe(true);
      const docs = await watches();
      expect(docs[0].to.dm).toContain('user1');
    });

    it('unwatch removes channel address', async () => {
      await watch(['Board A', 5], 'channel1', 'channel');
      await unwatch(5, 'user1', 'channel1');
      const docs = await watches();
      expect(docs[0].to.channel).not.toContain('channel1');
    });

    it('watched updates last topic', async () => {
      await watch(['Board A', 5], 'channel1', 'channel');
      await watched(5, 100);
      const docs = await watches();
      expect(docs[0].last).toBe(100);
    });
  });

  describe('watch_dupe', () => {
    it('returns channel list when channels are watching', async () => {
      await watch(['Board A', 5], 'ch1', 'channel');
      const result = await watch_dupe(5);
      expect(result).toContain('ch1');
    });

    it('returns ["0"] when no channels are watching', async () => {
      const result = await watch_dupe(5);
      expect(result).toEqual(['0']);
    });
  });

  describe('serve / unserve', () => {
    it('registers a new server', async () => {
      await serve('Test Server', 'server1');
      const docs = await serves();
      expect(docs.length).toBe(1);
      expect(docs[0].server).toBe('Test Server');
      expect(docs[0].serving).toBe(true);
    });

    it('updates an existing server', async () => {
      await serve('Test Server', 'server1');
      await serve('Updated Server', 'server1');
      const docs = await serves();
      expect(docs[0].server).toBe('Updated Server');
    });

    it('unserve marks server as not serving', async () => {
      await serve('Test Server', 'server1');
      await unserve('Test Server', 'server1');
      const docs = await serves();
      expect(docs[0].serving).toBe(false);
    });
  });

  describe('unrestrict / restrict', () => {
    it('unrestrict stores state and restrict removes it', async () => {
      await serve('Test Server', 'server1');
      const result = await unrestrict('server1', 'channel1');
      expect(result).toBe(true);
      const checked = await unrestricts('server1', 'channel1');
      expect(checked).toBe(true);

      const restricted = await restrict('server1', 'channel1');
      expect(restricted).toBe(true);
      const afterRestrict = await unrestricts('server1', 'channel1');
      expect(afterRestrict).toBe(false);
    });

    it('unrestrict adds to existing array', async () => {
      await serve('Test Server', '900');
      await unrestrict('900', '901');
      await unrestrict('900', '902');
      const doc = (await serves())[0];
      const unrestricted = (doc.unrestricting as object[]).map(String);
      expect(unrestricted).toContain('901');
      expect(unrestricted).toContain('902');
    });

    it('restrict resets unrestricting to false when empty', async () => {
      await serve('Test Server', 'server1');
      await unrestrict('server1', 'channel1');
      await restrict('server1', 'channel1');
      const doc = (await serves())[0];
      expect(doc.unrestricting).toBe(false);
    });

    it('restrict returns false when not unrestricted', async () => {
      await serve('Test Server', 'server1');
      const result = await restrict('server1', 'channel1');
      expect(result).toBe(false);
    });

    it('unrestrict works when the serving doc is missing (guild joined while offline)', async () => {
      const result = await unrestrict('888001', '888002');
      expect(result).toBe(true);
      expect(await unrestricts('888001', '888002')).toBe(true);
      expect(await unrestricts('888001', '888003')).toBe(false);
    });

    it('unrestrict works on a legacy doc without the unrestricting field', async () => {
      const { serving } = getCollections();
      await serving.insertOne({
        _id: 999,
        server: 'Legacy Server',
        server_id: Long.fromString('700'),
        serving: true,
      } as any);

      const result = await unrestrict('700', '701');
      expect(result).toBe(true);
      expect(await unrestricts('700', '701')).toBe(true);
    });

    it('unrestricts defaults to restricted for unknown servers and channels', async () => {
      expect(await unrestricts('nope', 'nope')).toBe(false);
      await serve('Test Server', 'server1');
      expect(await unrestricts('server1', 'channel1')).toBe(false);
    });
  });

  describe('clean', () => {
    it('removes address from all collections', async () => {
      await follow('user1', 'Topic', 12345, 'ch1', ['Topic', 12345]);
      await follow('user1', 'Board', 5, 'ch1', ['Board', 5]);
      await listen(['Topic A', 12345], 'ch1', 'channel');
      await watch(['Board A', 5], 'ch1', 'channel');

      await clean('channel', 'ch1');

      const followDocs = await follows('user1');
      expect(followDocs.following.topics.every((t: { address: string }) => t.address !== 'ch1')).toBe(true);
      expect(followDocs.following.boards.every((b: { address: string }) => b.address !== 'ch1')).toBe(true);

      const listenDocs = await listens();
      expect(listenDocs.every((d) => !d.to.channel.includes('ch1'))).toBe(true);

      const watchDocs = await watches();
      expect(watchDocs.every((d) => !d.to.channel.includes('ch1'))).toBe(true);
    });
  });
});
