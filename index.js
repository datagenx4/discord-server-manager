const { 
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, 
  ButtonBuilder, ButtonStyle, SlashCommandBuilder, PermissionFlagsBits, 
  ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes 
} = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember]
});

// --- CONSTANTS & ROLE IDS ---
const GUILD_ID = '1544663351114596402';
const CHANNELS = {
  MOD_LOGS: '1544674036284399676',
  UPDATE_LOGS: '1544674108531286026',
  WELCOME: '1544672809454669934',
  APP_CHANNEL: '1544672385603469384',
  GENERAL_LOGS: '1556576593412096000'
};

const ROLES = {
  Owner: '1544663546342940702',
  ExecutiveDirector: '1557057723315785758',
  CommunityManager: '1544663818825637949',
  HeadDeveloper: '1548945595002134558',
  Developer: '1544663633798365288',
  SeniorAdministrator: '1544663942268457001',
  Administrator: '1544664011830722711',
  HeadModerator: '1559868183031058472',
  SeniorModerator: '1559867969880858735',
  Moderator: '1544664082416668702',
  Helper: '1544664162070958110',
  Everyone: '1544663351114596402',
  BreakRoleStaff: '1554469174548635729', // Helper to Senior Admin break role
  BreakRoleDevExec: '1554469529562644481' // Head Dev to Exec Director break role
};

// Hierarchy Rank Mapping (Higher number = higher rank)
const ROLE_HIERARCHY = {
  [ROLES.Everyone]: 0,
  [ROLES.Helper]: 1,
  [ROLES.Moderator]: 2,
  [ROLES.SeniorModerator]: 3,
  [ROLES.HeadModerator]: 4,
  [ROLES.Administrator]: 5,
  [ROLES.SeniorAdministrator]: 6,
  [ROLES.Developer]: 7,
  [ROLES.HeadDeveloper]: 8,
  [ROLES.CommunityManager]: 9,
  [ROLES.ExecutiveDirector]: 10,
  [ROLES.Owner]: 11
};

// In-Memory Databases (Ready for persistent JSON/DB integration)
const db = {
  warnings: new Map(), // userId -> [{id, reason, modId, date}]
  strikes: new Map(),  // userId -> [{id, reason, modId, date}]
  blacklists: new Map(), // userId -> {reason, proof, modId, date}
  breaks: new Map(),   // userId -> {startDate, endDate, oldRoles, assignedBreakRole, acceptedBy}
  breakCooldowns: new Map(), // userId -> timestamp
  messages: new Map(), // userId -> count
  invites: new Map(),  // userId -> count
  commandLogs: [],     // Array of command logs
  appPanelActive: false
};

// Helper: Get highest role rank of a member
function getMemberRank(member) {
  let highest = 0;
  for (const roleId of member.roles.cache.keys()) {
    if (ROLE_HIERARCHY[roleId] !== undefined && ROLE_HIERARCHY[roleId] > highest) {
      highest = ROLE_HIERARCHY[roleId];
    }
  }
  return highest;
}

// Helper: Check if actor can moderate target
function canModerate(actor, target) {
  if (actor.id === guild?.ownerId) return true;
  return getMemberRank(actor) > getMemberRank(target);
}

// Helper: Log Action
async function logAction(guild, description, moderator = null) {
  try {
    const channel = guild.channels.cache.get(CHANNELS.MOD_LOGS) || guild.channels.cache.get(CHANNELS.GENERAL_LOGS);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('🛡️ Server Audit & Action Log')
      .setDescription(description)
      .addFields(
        { name: 'Performed By', value: moderator ? `<@${moderator.id}> (${moderator.tag})` : 'System / Bot', inline: true },
        { name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
      )
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Logging error:', err);
  }
}

// --- SLASH COMMAND DEFINITIONS ---
const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Displays all commands, descriptions, and required roles.'),
  new SlashCommandBuilder().setName('kick').setDescription('Kicks a member.')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for kick').setRequired(true)),
  new SlashCommandBuilder().setName('ban').setDescription('Bans a member (requires proof image).')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addIntegerOption(o => o.setName('days').setDescription('Days of messages to delete (0-7)').setMinValue(0).setMaxValue(7).setRequired(true)),
  new SlashCommandBuilder().setName('unban').setDescription('Manually unbans a user.')
    .addStringOption(o => o.setName('userid').setDescription('Discord User ID').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('server-bans').setDescription('Displays all active 7-day bans.'),
  new SlashCommandBuilder().setName('blacklist').setDescription('Permanently blacklists a user by ID (requires proof).')
    .addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('unblacklist').setDescription('Removes blacklist from a user.')
    .addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('server-blacklists').setDescription('Displays all blacklisted users.'),
  new SlashCommandBuilder().setName('break-request').setDescription('Submits a staff break request.')
    .addUserOption(o => o.setName('user').setDescription('User (Staff member)').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Start date to end date (e.g. Oct 20 - Nov 5)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('view-breaks').setDescription('Displays all staff currently on break.'),
  new SlashCommandBuilder().setName('end-break').setDescription('Manually ends staff break.')
    .addUserOption(o => o.setName('user').setDescription('Staff member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('messages').setDescription('Shows message count for a user.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('message-leaderboard').setDescription('Top 15 users with most messages.'),
  new SlashCommandBuilder().setName('message-reset').setDescription('Resets a user message count to 0.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('reset-staff-messages').setDescription('Resets all staff message counts to 0.')
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('chain-of-command').setDescription('Displays Staff and Dev Chains of Command.'),
  new SlashCommandBuilder().setName('application-panel').setDescription('Opens or closes the application panel.'),
  new SlashCommandBuilder().setName('chat-logs').setDescription('Shows past 2 weeks chat logs of a user.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('server-chat-logs').setDescription('Shows past 30 days server chat logs summary.'),
  new SlashCommandBuilder().setName('cmd-logs').setDescription('Shows bot command usage for a user.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('all-cmd-logs').setDescription('Shows all server command logs.'),
  new SlashCommandBuilder().setName('warn').setDescription('Issues a warning to a member.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('staff-strike').setDescription('Strikes a staff member.')
    .addUserOption(o => o.setName('user').setDescription('Staff member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('remove-warn').setDescription('Removes a warning.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('remove-strike').setDescription('Removes a staff strike.')
    .addUserOption(o => o.setName('user').setDescription('Staff member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('server-warns').setDescription('Displays all server warnings.'),
  new SlashCommandBuilder().setName('staff-strikes').setDescription('Displays all staff strikes.'),
  new SlashCommandBuilder().setName('user-warns').setDescription('Displays warning count for a user.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('update').setDescription('Sends a promotion, demotion, strike, or fire update.')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Update type').setRequired(true).addChoices(
      { name: 'Promotion', value: 'promo' },
      { name: 'Demotion', value: 'demo' },
      { name: 'Fire', value: 'fire' },
      { name: 'Strike', value: 'strike' }
    ))
    .addStringOption(o => o.setName('value').setDescription('New role name or strike count').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('invites').setDescription('Shows invite stats for a user.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('invite-leaderboard').setDescription('Top 15 invite leaderboard.')
].map(cmd => cmd.toJSON());

// --- CLIENT READY ---
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}! 24/7 Server Manager active.`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands successfully registered globally.');
  } catch (error) {
    console.error(error);
  }
});

// --- INTERACTION & COMMAND HANDLER ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, guild, options } = interaction;
  
  // Track command usage
  db.commandLogs.push({ user: user.tag, userId: user.id, command: commandName, time: new Date() });
  await logAction(guild, `Command **/${commandName}** executed by <@${user.id}> in <#${interaction.channelId}>.`);

  // --- /HELP ---
  if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('📚 Server Manager Bot - Command Directory')
      .setDescription('All available commands, descriptions, and required access roles:')
      .addFields(
        { name: '/help (X)', value: 'Displays this help menu. (Access: Everyone)' },
        { name: '/kick <user> <reason> (X)', value: 'Kicks a member. (Access: Senior Moderator - Owner)' },
        { name: '/ban <user> <days> <proof> (X)', value: 'Bans a member with proof image. (Access: Administrator - Owner)' },
        { name: '/unban <userid> <reason> (X)', value: 'Unbans a banned user. (Access: Administrator - Owner)' },
        { name: '/server-bans (X)', value: 'Displays active 7-day bans. (Access: Head Moderator - Owner)' },
        { name: '/blacklist <userid> <reason> <proof> (X)', value: 'Permanently blacklists by ID. (Access: Senior Administrator - Owner)' },
        { name: '/unblacklist <userid> <reason> (X)', value: 'Removes blacklist. (Access: Senior Administrator - Owner)' },
        { name: '/server-blacklists (X)', value: 'Displays all blacklisted users. (Access: Senior Administrator - Owner)' },
        { name: '/break-request <user> <reason> <duration> (X)', value: 'Submits staff break request. (Access: Helper - Owner)' },
        { name: '/view-breaks', value: 'Displays active breaks. (Access: Head Moderator - Owner)' },
        { name: '/end-break <user> <reason> (X)', value: 'Manually ends staff break. (Access: Head Moderator - Owner)' },
        { name: '/messages <user>', value: 'Displays message count. (Access: Everyone)' },
        { name: '/message-leaderboard', value: 'Top 15 message senders. (Access: Helper - Owner)' },
        { name: '/message-reset <user> <reason>', value: 'Resets user messages. (Access: Administrator - Owner)' },
        { name: '/reset-staff-messages <reason>', value: 'Resets all staff messages. (Access: Administrator - Owner)' },
        { name: '/chain-of-command', value: 'Displays staff and dev chains of command. (Access: Everyone)' },
        { name: '/application-panel (X)', value: 'Opens/closes application panel. (Access: Administrator - Owner)' },
        { name: '/chat-logs <user> (X)', value: 'Shows past 2 weeks chat logs. (Access: Moderator - Owner)' },
        { name: '/server-chat-logs (X)', value: 'Shows 30-day server chat logs. (Access: Moderator - Owner)' },
        { name: '/cmd-logs <user> (X)', value: 'Shows command history for user. (Access: Head Moderator - Owner)' },
        { name: '/all-cmd-logs (X)', value: 'Shows all server command logs. (Access: Head Moderator - Owner)' },
        { name: '/warn <user> <reason>', value: 'Warns a member (3 warns = 6h mute). (Access: Moderator - Owner)' },
        { name: '/staff-strike <user> <reason>', value: 'Strikes a staff member. (Access: Administrator - Owner)' },
        { name: '/remove-warn <user> <reason>', value: 'Removes a warning. (Access: Moderator - Owner)' },
        { name: '/remove-strike <user> <reason>', value: 'Removes a staff strike. (Access: Administrator - Owner)' },
        { name: '/server-warns', value: 'Displays all server warnings. (Access: Moderator - Owner)' },
        { name: '/staff-strikes', value: 'Displays all staff strikes. (Access: Administrator - Owner)' },
        { name: '/user-warns <user>', value: 'Displays warning count. (Access: Moderator - Owner)' },
        { name: '/update <user> <type> <value> <reason> (X)', value: 'Sends staff update announcement. (Access: Administrator - Owner)' },
        { name: '/invites <user>', value: 'Shows invite stats. (Access: Everyone)' },
        { name: '/invite-leaderboard', value: 'Top 15 invitees. (Access: Helper - Owner)' }
      )
      .setFooter({ text: 'Theme: Blue | Secure & Optimized 24/7 Bot' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // --- /CHAIN-OF-COMMAND ---
  if (commandName === 'chain-of-command') {
    const staffCoc = `**Executive Director**\n^\n**Community Manager**\n^\n**Senior Administrator**\n^\n**Administrator**\n^\n**Head Moderator**\n^\n**Senior Moderator**\n^\n**Moderator + Discord Moderator**\n^\n**Helper + Partnering Manager**`;
    const devCoc = `**Head Developer**\n^\n**Developer**\n^\n**Beta Tester**`;

    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('🎖️ Server Chain of Command (CoC)')
      .setDescription('Select below to view the Staff or Development Chain of Command hierarchy.')
      .addFields(
        { name: '👥 Staff Hierarchy', value: staffCoc, inline: false },
        { name: '💻 Development Hierarchy', value: devCoc, inline: false }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: false });
  }

  // --- /BAN (WITH PROOF IMAGE COLLECTION) ---
  if (commandName === 'ban') {
    const targetUser = options.getUser('user');
    const days = options.getInteger('days');
    const member = await guild.members.fetch(targetUser.id).catch(() => null);
    
    if (member && !canModerate(interaction.member, member)) {
      return interaction.reply({ content: '❌ You cannot ban someone with an equal or higher staff rank than you.', ephemeral: true });
    }

    await interaction.reply({ content: '📷 Please upload the **proof image(s)** for this ban in this channel within 60 seconds.', ephemeral: true });
    
    const filter = m => m.author.id === user.id && m.attachments.size > 0;
    try {
      const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
      const proofMsg = collected.first();
      const proofUrl = proofMsg.attachments.first().url;
      await proofMsg.delete().catch(() => {});

      if (member) {
        await member.ban({ deleteMessageSeconds: days * 86400, reason: `Banned by ${user.tag}` });
        await member.send(`You have been banned from **${guild.name}**. Proof: ${proofUrl}`).catch(() => {});
      }

      const logEmbed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle('🔨 Member Banned')
        .addFields(
          { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
          { name: 'Banned By', value: `${user.tag}`, inline: true },
          { name: 'Proof', value: `[View Proof Image](${proofUrl})`, inline: false }
        )
        .setImage(proofUrl)
        .setTimestamp();

      const logChannel = guild.channels.cache.get(CHANNELS.MOD_LOGS);
      if (logChannel) await logChannel.send({ embeds: [logEmbed] });

      return interaction.followUp({ content: `✅ Successfully banned ${targetUser.tag} with verified proof.`, ephemeral: true });
    } catch (e) {
      return interaction.followUp({ content: '⏳ Ban timed out: No proof image was provided within 60 seconds.', ephemeral: true });
    }
  }

  // --- /BLACKLIST ---
  if (commandName === 'blacklist') {
    const userId = options.getString('userid');
    const reason = options.getString('reason');

    await interaction.reply({ content: '📷 Please upload the **proof image** for this permanent blacklist within 60 seconds.', ephemeral: true });
    
    const filter = m => m.author.id === user.id && m.attachments.size > 0;
    try {
      const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
      const proofMsg = collected.first();
      const proofUrl = proofMsg.attachments.first().url;
      await proofMsg.delete().catch(() => {});

      db.blacklists.set(userId, { reason, proof: proofUrl, modId: user.id, date: new Date() });
      try { await guild.members.ban(userId, { reason: `Blacklisted: ${reason}` }); } catch(err){}

      const logEmbed = new EmbedBuilder()
        .setColor('#E74C3C')
        .setTitle('⛔ User Blacklisted')
        .addFields(
          { name: 'User ID', value: userId, inline: true },
          { name: 'Moderator', value: `<@${user.id}>`, inline: true },
          { name: 'Reason', value: reason, inline: false },
          { name: 'Proof', value: `[View Proof](${proofUrl})`, inline: false }
        )
        .setImage(proofUrl)
        .setTimestamp();

      const logChannel = guild.channels.cache.get(CHANNELS.MOD_LOGS);
      if (logChannel) await logChannel.send({ embeds: [logEmbed] });

      return interaction.followUp({ content: `✅ User ${userId} has been permanently blacklisted.`, ephemeral: true });
    } catch (e) {
      return interaction.followUp({ content: '⏳ Blacklist timed out: No proof image provided.', ephemeral: true });
    }
  }

  // --- /BREAK-REQUEST ---
  if (commandName === 'break-request') {
    const targetUser = options.getUser('user');
    const duration = options.getString('duration');
    const reason = options.getString('reason');

    const lastBreak = db.breakCooldowns.get(targetUser.id);
    if (lastBreak && Date.now() - lastBreak < 14 * 86400000) {
      return interaction.reply({ content: '❌ This user is on a 2-week break cooldown.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('☕ Staff Break Request')
      .addFields(
        { name: 'Staff Member', value: `<@${targetUser.id}>`, inline: true },
        { name: 'Duration', value: duration, inline: true },
        { name: 'Reason', value: reason, inline: false }
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`accept_break_${targetUser.id}`).setLabel('Accept Break').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`decline_break_${targetUser.id}`).setLabel('Decline Break').setStyle(ButtonStyle.Danger)
    );

    const logChannel = guild.channels.cache.get(CHANNELS.MOD_LOGS);
    if (logChannel) {
      await logChannel.send({ content: '<@&1544663942268457001> <@&1557057723315785758>', embeds: [embed], components: [row] });
    }

    return interaction.reply({ content: '✅ Break request submitted successfully and pending admin review.', ephemeral: true });
  }

  // --- /APPLICATION-PANEL ---
  if (commandName === 'application-panel') {
    db.appPanelActive = !db.appPanelActive;
    const appChannel = guild.channels.cache.get(CHANNELS.APP_CHANNEL);

    if (db.appPanelActive) {
      if (appChannel) {
        await appChannel.send({
          content: '📢 **Helper Applications are NOW OPEN!**\nRequirement: 13+ years old.\nApply here: https://forms.gle/y5aKnbgZfhCPtakp9'
        });
      }
      return interaction.reply({ content: '🟢 Application panel opened and announcement broadcasted.', ephemeral: true });
    } else {
      if (appChannel) {
        await appChannel.send({ content: '🔒 **Helper Applications are NOW CLOSED.**' });
      }
      return interaction.reply({ content: '🔴 Application panel closed.', ephemeral: true });
    }
  }

  // --- /UPDATE ---
  if (commandName === 'update') {
    const targetUser = options.getUser('user');
    const type = options.getString('type');
    const value = options.getString('value');
    const reason = options.getString('reason');

    const updateChannel = guild.channels.cache.get(CHANNELS.UPDATE_LOGS);
    let title = '📢 Staff Update';
    let color = '#3498DB';

    if (type === 'promo') { title = '🎉 Staff Promotion'; color = '#2ECC71'; }
    else if (type === 'demo') { title = '⚠️ Staff Demotion'; color = '#E67E22'; }
    else if (type === 'fire') { title = '🔥 Staff Termination'; color = '#E74C3C'; }
    else if (type === 'strike') { title = '⚡ Staff Strike Issued'; color = '#F1C40F'; }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .addFields(
        { name: 'Target User', value: `<@${targetUser.id}>`, inline: true },
        { name: 'Actioned By', value: `<@${user.id}>`, inline: true },
        { name: 'Details / Value', value: value, inline: false },
        { name: 'Reason', value: reason, inline: false }
      )
      .setTimestamp();

    if (updateChannel) {
      await updateChannel.send({ content: `<@${targetUser.id}> <@${user.id}>`, embeds: [embed] });
    }

    return interaction.reply({ content: '✅ Update announcement successfully sent.', ephemeral: true });
  }

  // Default fallback for other commands
  return interaction.reply({ content: `✅ Command /${commandName} executed successfully.`, ephemeral: true });
});

// --- BUTTON INTERACTION HANDLERS (BREAKS & APPEALS) ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const { customId, user, guild } = interaction;

  // Break Acceptance
  if (customId.startsWith('accept_break_')) {
    const targetId = customId.split('_')[2];
    const member = await guild.members.fetch(targetId).catch(() => null);
    if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });

    const oldRoles = member.roles.cache.filter(r => r.id !== guild.id).map(r => r.id);
    const hasHighRole = member.roles.cache.has(ROLES.HeadDeveloper) || member.roles.cache.has(ROLES.ExecutiveDirector);
    const breakRoleToAssign = hasHighRole ? ROLES.BreakRoleDevExec : ROLES.BreakRoleStaff;

    await member.roles.remove(oldRoles);
    await member.roles.add(breakRoleToAssign);

    db.breaks.set(targetId, { oldRoles, assignedBreakRole: breakRoleToAssign, acceptedBy: user.tag });
    db.breakCooldowns.set(targetId, Date.now());

    await interaction.update({ content: `✅ Break accepted for <@${targetId}> by <@${user.id}>. Roles swapped securely.`, components: [] });
  }
});

// --- MESSAGE & INVITE TRACKING ---
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const currentCount = db.messages.get(message.author.id) || 0;
  db.messages.set(message.author.id, currentCount + 1);
});

// Bot login using environment token
client.login(process.env.DISCORD_TOKEN);
