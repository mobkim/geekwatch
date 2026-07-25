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

async function buildFollowLists(
  client: import('discord.js').Client | undefined,
  topics: TopicEntry[],
  boards: BoardEntry[],
  user?: import('discord.js').User
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

  let topicsStr = 'None';
  let boardsStr = 'None';

  if (topics.length > 0) {
    const lines = await Promise.all(topics.map(async (t, i) => {
      const idx = i + 1;
      const url = await getLocationUrl(t.address);
      const ghUrl = `https://geekhack.org/index.php?topic=${t.topic_id}.0`;
      return url
        ? `[[ ${idx} ]](${url}) [${t.topic}](${ghUrl})`
        : `[ ${idx} ] [${t.topic}](${ghUrl})`;
    }));
    topicsStr = lines.join('\n');
  }
  if (boards.length > 0) {
    const startIdx = topics.length + 1;
    const lines = await Promise.all(boards.map(async (b, i) => {
      const idx = startIdx + i;
      const url = await getLocationUrl(b.address);
      const ghUrl = `https://geekhack.org/index.php?board=${b.board_id}.0`;
      return url
        ? `[[ ${idx} ]](${url}) [${b.board}](${ghUrl})`
        : `[ ${idx} ] [${b.board}](${ghUrl})`;
    }));
    boardsStr = lines.join('\n');
  }

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
    const { topicsStr, boardsStr } = await buildFollowLists(interaction.client, doc.following.topics, doc.following.boards, interaction.user);
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
  const { topicsStr, boardsStr } = await buildFollowLists(interaction.client, doc.following.topics, doc.following.boards, interaction.user);
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
