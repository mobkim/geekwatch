import {
  ChatInputCommandInteraction,
  PermissionsBitField,
} from 'discord.js';
import { log } from '../logger.js';
import { verify } from '../scraper.js';
import {
  errorEmbed,
  messageEmbed,
  maxErrorEmbed,
  removedEmbed,
  gatekeepEmbed,
  commandListEmbed,
  followListEmbed,
  inviteEmbed,
  confirmRow,
  missingPermissionsEmbed,
} from '../embeds.js';
import {
  follow,
  follows,
  unfollow,
  listenOwners,
  watchOwners,
  restrict,
} from '../database.js';
import { SlashCommandBuilder } from 'discord.js';
import { Address, TopicEntry, BoardEntry } from '../types/index.js';

export const unrestrictStates = new Map<string, { guildId: string; address: string; user_id: string }>();
export const detachStates = new Map<string, { method: 'channel' | 'dm'; address: string; user_id: string }>();

// Permissions the bot needs in a channel to actually deliver follow/watch
// updates there — matches the Default Install Settings permissions requested
// by INVITE_URL.
const REQUIRED_CHANNEL_PERMISSIONS: { flag: bigint; label: string }[] = [
  { flag: PermissionsBitField.Flags.ViewChannel, label: 'View Channel' },
  { flag: PermissionsBitField.Flags.SendMessages, label: 'Send Messages' },
  { flag: PermissionsBitField.Flags.EmbedLinks, label: 'Embed Links' },
];

export const commands = [
  new SlashCommandBuilder()
    .setName('follow')
    .setDescription('Follow a topic or board')
    .addStringOption(option =>
      option.setName('target').setDescription('Topic number, board number, or URL').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('unfollow')
    .setDescription('Unfollow a topic or board')
    .addStringOption(option =>
      option.setName('index').setDescription('Index number or "all"').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('following')
    .setDescription('List topics and boards you are following'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands'),
  new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Get the bot invite link'),
  new SlashCommandBuilder()
    .setName('unrestrict')
    .setDescription('Unrestrict a channel (admin only)'),
  new SlashCommandBuilder()
    .setName('restrict')
    .setDescription('Restrict a channel (admin only)'),
  new SlashCommandBuilder()
    .setName('detach')
    .setDescription('Detach from a channel (admin only)'),
];

function guildHasSubscription(
  guild: import('discord.js').Guild,
  subscribed: Address[]
): boolean {
  const ids = subscribed.map(String).filter(id => id !== '0');
  if (ids.length === 0) return false;
  const cache = guild.channels.cache as any;
  const guildChannelIds: string[] = cache
    .filter(() => true)
    .map((c: any) => String(c?.id ?? c));
  return ids.some(id => guildChannelIds.includes(id));
}

// Discord embed field values cap out at 1024 raw characters. Every entry must
// stay visible and clickable via its geekhack link — nothing is ever dropped
// or cut off mid-line. Whether an index also gets a jump-to-location link is
// decided by redundancy, not budget: if the entry's tracked location *is*
// where /following was just run — compared as the resolved location URL, not
// the raw stored address, since a DM entry's address is the follower's user
// id while "here" in a DM is the DM channel — a link to it tells the reader
// nothing, so it's left as a plain index; every other entry's location link
// is always included, since that's real information the budget doesn't get
// to veto. Only if that still doesn't fit under 1024 (very large titles at
// the 10-item cap) does it fall back to shrinking every title by an equal
// shared amount — never a raw character slice (that used to cut a line off
// mid-URL).
const FIELD_VALUE_LIMIT = 1024;
const MAX_TITLE_LEN = 100;

function buildLine(idx: number, title: string, ghUrl: string, locationUrl: string, titleLen: number): string {
  const shown = title.length > titleLen ? title.slice(0, Math.max(titleLen - 1, 1)) + '…' : title;
  return locationUrl
    ? `[[ ${idx} ]](${locationUrl}) [${shown}](${ghUrl})`
    : `[ ${idx} ] [${shown}](${ghUrl})`;
}

async function buildListField(
  entries: { idx: number; title: string; ghUrl: string; address: Address }[],
  getLocationUrl: (address: Address) => Promise<string>,
  hereUrl?: string
): Promise<string> {
  if (entries.length === 0) return 'None';

  const resolvedUrls = await Promise.all(entries.map(e => getLocationUrl(e.address)));
  const locationUrls = resolvedUrls.map(url => (hereUrl && url === hereUrl ? '' : url));
  const render = (titleLen: number): string[] =>
    entries.map((e, i) => buildLine(e.idx, e.title, e.ghUrl, locationUrls[i], titleLen));
  const fits = (lines: string[]) => lines.join('\n').length <= FIELD_VALUE_LIMIT;

  let lines = render(MAX_TITLE_LEN);

  if (!fits(lines)) {
    // Location links are kept as-is (they're required, not negotiable) —
    // shrink every title by an equal cut of whatever's left after the fixed
    // parts (index, brackets, links). Guaranteed to fit at up to 10 items per
    // list, since that fixed overhead alone leaves comfortably more than a
    // nub of room per title even with every location link present.
    const overheadTotal = entries.reduce((sum, e, i) => {
      const bare = buildLine(e.idx, e.title, e.ghUrl, locationUrls[i], MAX_TITLE_LEN);
      return sum + (bare.length - Math.min(e.title.length, MAX_TITLE_LEN));
    }, 0) + (entries.length - 1);
    const titleBudget = Math.max(Math.floor((FIELD_VALUE_LIMIT - overheadTotal) / entries.length), 1);
    lines = render(titleBudget);
  }

  return lines.join('\n');
}

async function buildFollowLists(
  client: import('discord.js').Client | undefined,
  topics: TopicEntry[],
  boards: BoardEntry[],
  user?: import('discord.js').User,
  here?: { guildId: string | null; channelId: string }
): Promise<{ topicsStr: string; boardsStr: string }> {
  // A DM follow is keyed by the follower's user id, and /following only ever
  // lists the caller's own doc — so an address equal to the caller means "my
  // DMs", and the DM channel id gives a real @me link. The Python gated on
  // client.get_channel(cid).guild.id, which is None for a DM, so these rows
  // always rendered as a bare unlinked index.
  let dmUrl: string | null = null;
  const getDmUrl = async (): Promise<string> => {
    if (dmUrl !== null) return dmUrl;
    dmUrl = '';
    try {
      const dm = user?.dmChannel ?? (await user?.createDM());
      if (dm) dmUrl = `https://discord.com/channels/@me/${dm.id}`;
    } catch {
      // Can't open a DM (blocked, no mutual guild) — fall back to no link.
    }
    return dmUrl;
  };

  // client.channels.cache only holds what arrived in GUILD_CREATE, so a
  // channel the bot can't currently view — or one evicted from the cache —
  // silently lost its index hyperlink while its neighbours kept theirs. Fall
  // back to a fetch so a cache miss isn't mistaken for "this is a DM".
  const resolved = new Map<string, string>();
  const getLocationUrl = async (address: Address): Promise<string> => {
    const chId = String(address);
    if (!chId || chId === '0') return '';
    if (user && chId === user.id) return getDmUrl();
    if (resolved.has(chId)) return resolved.get(chId)!;

    let url = '';
    let channel = client?.channels?.cache?.get(chId) ?? null;
    if (!channel) {
      try {
        channel = (await client?.channels?.fetch(chId)) ?? null;
      } catch {
        // Gone or unreachable — no location to link to.
        channel = null;
      }
    }
    if (channel && 'guildId' in channel && channel.guildId) {
      url = `https://discord.com/channels/${channel.guildId}/${chId}`;
    }
    resolved.set(chId, url);
    return url;
  };

  const topicEntries = topics.map((t, i) => ({
    idx: i + 1,
    title: t.topic,
    ghUrl: `https://geekhack.org/index.php?topic=${t.topic_id}.0`,
    address: t.address,
  }));
  const boardStartIdx = topics.length + 1;
  const boardEntries = boards.map((b, i) => ({
    idx: boardStartIdx + i,
    title: b.board,
    ghUrl: `https://geekhack.org/index.php?board=${b.board_id}.0`,
    address: b.address,
  }));

  const hereUrl = here
    ? (here.guildId
        ? `https://discord.com/channels/${here.guildId}/${here.channelId}`
        : await getDmUrl())
    : undefined;

  const topicsStr = await buildListField(topicEntries, getLocationUrl, hereUrl);
  const boardsStr = await buildListField(boardEntries, getLocationUrl, hereUrl);

  return { topicsStr, boardsStr };
}

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  checkUnrestricted: (guildId: string, channelId: string) => Promise<boolean>
): Promise<void> {
  const commandName = interaction.commandName;
  const user_id = interaction.user.id;
  const avatar = interaction.user.displayAvatarURL();
  // DM follows are keyed by user id, not the DM channel id (matches the
  // legacy DB). Guild detection uses guildId (always in the payload), not
  // interaction.guild, which is null on a cache miss and would bypass the
  // restriction check.
  const address = interaction.guildId ? interaction.channelId : user_id;
  const member = interaction.member;
  let isAdmin = false;
  if (member && 'permissions' in member) {
    const perms = member.permissions;
    if (typeof perms === 'string') {
      isAdmin = (BigInt(perms) & BigInt(PermissionsBitField.Flags.Administrator)) !== 0n;
    } else {
      isAdmin = perms.has(PermissionsBitField.Flags.Administrator);
    }
  }

  try {
    switch (commandName) {
      case 'follow': {
        const target = interaction.options.getString('target');
        if (!target) {
          await interaction.reply({ embeds: [errorEmbed('Missing parameter', 'Please provide a topic/board number or URL')], ephemeral: true });
          return;
        }
        await handleFollowOrWatchSlash(target, user_id, avatar, address, isAdmin, interaction, checkUnrestricted);
        break;
      }

      case 'unfollow': {
        const index = interaction.options.getString('index');
        await handleUnfollowOrUnwatchSlash(index, user_id, avatar, interaction);
        break;
      }

      case 'following':
        await handleFollowingSlash(user_id, avatar, interaction);
        break;

      case 'unrestrict':
        await handleUnrestrictSlash(isAdmin, address, interaction, user_id, checkUnrestricted);
        break;

      case 'restrict':
        await handleRestrictSlash(isAdmin, address, interaction);
        break;

      case 'detach':
        await handleDetachSlash(isAdmin, address, interaction, user_id);
        break;

      case 'help':
        await interaction.reply({ embeds: [commandListEmbed()], ephemeral: true });
        break;

      case 'invite':
        await interaction.reply({ embeds: [inviteEmbed()], ephemeral: true });
        break;
    }

    // Warn the caller if updates sent to this channel won't actually land —
    // appPermissions comes straight off the interaction payload, so this is
    // accurate even when the bot itself lacks Send Messages here.
    if (interaction.guildId && interaction.appPermissions && (interaction.replied || interaction.deferred)) {
      const missing = REQUIRED_CHANNEL_PERMISSIONS.filter(p => !interaction.appPermissions!.has(p.flag)).map(p => p.label);
      if (missing.length > 0) {
        await interaction.followUp({ embeds: [missingPermissionsEmbed(missing)], ephemeral: true }).catch(() => {});
      }
    }
  } catch (err: any) {
    log(`Error handling slash command: ${err.message}`);
    const replySent = interaction.replied || interaction.deferred;
    if (!replySent) {
      await interaction.reply({ embeds: [errorEmbed('Error', 'An unexpected error occurred')], ephemeral: true }).catch(() => {});
    } else {
      await interaction.followUp({ embeds: [errorEmbed('Error', 'An unexpected error occurred')], ephemeral: true }).catch(() => {});
    }
  }
}

async function handleFollowOrWatchSlash(
  target: string,
  user_id: string,
  avatar: string,
  address: string,
  isAdmin: boolean,
  interaction: ChatInputCommandInteraction,
  checkUnrestricted: (guildId: string, channelId: string) => Promise<boolean>
): Promise<void> {
  // Restrictions only apply to server channels — DMs are always allowed
  if (interaction.guildId && !isAdmin && !(await checkUnrestricted(interaction.guildId, address))) {
    await interaction.reply({ embeds: [errorEmbed('No permission', 'You do not have permissions to call this command')], ephemeral: true });
    return;
  }

  const response = await verify(target);

  if (response === 404) {
    await interaction.reply({ embeds: [errorEmbed('Could not locate topic or board', 'Provide a valid topic/board number or URL')], ephemeral: true });
    return;
  }

  if (response === 503) {
    await interaction.reply({ embeds: [errorEmbed('Connection error', '[geekhack servers may be down](https://geekhack.org/)')], ephemeral: true });
    return;
  }

  if (Array.isArray(response) && response.length === 9) {
    const [topic, topic_id, date, op_name, op_id, op_flair, op_icon, op_score, image] = response;

    if (interaction.guild) {
      if (guildHasSubscription(interaction.guild, await listenOwners(topic_id))) {
        await interaction.reply({ embeds: [errorEmbed('Already followed within this server', 'This topic is already being followed within this server')], ephemeral: true });
        return;
      }
    }

    const doc = await follows(user_id);
    if (doc.following.topics.length >= 10) {
      await interaction.reply({ embeds: [maxErrorEmbed(10, 'topic', '', avatar)], ephemeral: true });
      return;
    }

    const result = await follow(user_id, topic, topic_id, address, [topic, topic_id]);
    if (result) {
      await interaction.reply({ embeds: [messageEmbed('Now following', response as [string, number, string, string, number, string, string, string, string], avatar)], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [messageEmbed('Already being followed', response as [string, number, string, string, number, string, string, string, string], avatar)], ephemeral: true });
    }
  } else if (Array.isArray(response) && response.length === 2) {
    const [board, board_id] = response;

    if (interaction.guild) {
      if (guildHasSubscription(interaction.guild, await watchOwners(board_id))) {
        await interaction.reply({ embeds: [errorEmbed('Already being watched within this server', 'This board is already being watched within this server')], ephemeral: true });
        return;
      }
    }

    const doc = await follows(user_id);
    if (doc.following.boards.length >= 10) {
      await interaction.reply({ embeds: [maxErrorEmbed(10, 'board', '', avatar)], ephemeral: true });
      return;
    }

    const result = await follow(user_id, board, board_id, address, [board, board_id]);
    if (result) {
      await interaction.reply({ embeds: [messageEmbed('Now watching', [board, board_id] as [string, number], avatar)], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [messageEmbed('Already being watched', [board, board_id] as [string, number], avatar)], ephemeral: true });
    }
  }
}

async function handleUnfollowOrUnwatchSlash(
  index: string | null,
  user_id: string,
  avatar: string,
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!index) {
    await interaction.reply({ embeds: [errorEmbed('Missing parameter', 'Please provide an index number or "all"')], ephemeral: true });
    return;
  }

  const response = await unfollow(user_id, index);
  if (response === false) {
    await interaction.reply({ embeds: [errorEmbed('Bad index!', 'Check the indices of your list with `/following`')], ephemeral: true });
    return;
  }

  if (index === 'all') {
    const doc = await follows(user_id);
    const here = { guildId: interaction.guildId, channelId: interaction.channelId };
    const { topicsStr, boardsStr } = await buildFollowLists(interaction.client, doc.following.topics, doc.following.boards, interaction.user, here);
    await interaction.reply({ embeds: [followListEmbed(topicsStr, boardsStr, avatar)], ephemeral: true });
  } else {
    const r = response as [string, number];
    await interaction.reply({ embeds: [removedEmbed(r[1] >= 10000 ? 'topic' : 'board', r[0], r[1], avatar)], ephemeral: true });
  }
}

async function handleFollowingSlash(
  user_id: string,
  avatar: string,
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const doc = await follows(user_id);
  const here = { guildId: interaction.guildId, channelId: interaction.channelId };
  const { topicsStr, boardsStr } = await buildFollowLists(interaction.client, doc.following.topics, doc.following.boards, interaction.user, here);
  await interaction.reply({ embeds: [followListEmbed(topicsStr, boardsStr, avatar)], ephemeral: true });
}

async function handleUnrestrictSlash(
  isAdmin: boolean,
  address: string,
  interaction: ChatInputCommandInteraction,
  user_id: string,
  checkUnrestricted: (guildId: string, channelId: string) => Promise<boolean>
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ embeds: [errorEmbed('Invalid channel', 'This command is limited to text channels within servers')], ephemeral: true });
    return;
  }

  if (!isAdmin) {
    await interaction.reply({ embeds: [errorEmbed('Admin only', 'This command is limited to admins only')], ephemeral: true });
    return;
  }

  if (await checkUnrestricted(guildId, address)) {
    await interaction.reply({ embeds: [gatekeepEmbed('Channel is already unrestricted')], ephemeral: true });
    return;
  }

  const stateKey = `${guildId}:${address}`;
  unrestrictStates.set(stateKey, { guildId, address, user_id });

  await interaction.reply({
    embeds: [gatekeepEmbed('WARNING')],
    components: [confirmRow(stateKey)],
    ephemeral: true,
  });
}

async function handleRestrictSlash(
  isAdmin: boolean,
  address: string,
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ embeds: [errorEmbed('Invalid channel', 'This command is limited to text channels within servers')], ephemeral: true });
    return;
  }

  if (!isAdmin) {
    await interaction.reply({ embeds: [errorEmbed('Admin only', 'This command is limited to admins only')], ephemeral: true });
    return;
  }

  const result = await restrict(guildId, address);
  if (result === false) {
    await interaction.reply({ embeds: [gatekeepEmbed('Channel is already restricted')], ephemeral: true });
  } else {
    await interaction.reply({ embeds: [gatekeepEmbed('Channel has been restricted')], ephemeral: true });
  }
}

async function handleDetachSlash(
  isAdmin: boolean,
  address: string,
  interaction: ChatInputCommandInteraction,
  user_id: string
): Promise<void> {
  // In DMs anyone may detach their own address; in servers admins only
  const method = interaction.guildId ? 'channel' : 'dm';

  if (method === 'channel' && !isAdmin) {
    await interaction.reply({ embeds: [errorEmbed('Admin only', 'This command is limited to admins only')], ephemeral: true });
    return;
  }

  const stateKey = `detach:${method}:${address}`;
  detachStates.set(stateKey, { method, address, user_id });

  await interaction.reply({
    embeds: [gatekeepEmbed(method)],
    components: [confirmRow(stateKey)],
    ephemeral: true,
  });
}
