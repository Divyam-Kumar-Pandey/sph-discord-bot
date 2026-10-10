
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder
} = require("discord.js");

// ============================================
// 1. ENVIRONMENT VARIABLES
// ============================================

const {
  DISCORD_TOKEN,
  WEBHOOK_URL,
  WEBHOOK_SECRET
} = process.env;

if (!DISCORD_TOKEN || !WEBHOOK_URL) {
  console.error(
    "Missing DISCORD_TOKEN, WEBHOOK_URL"
  );
  process.exit(1);
}

// ============================================
// 2. INITIALIZE DISCORD BOT
// ============================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ============================================
// 3. CHANNEL CONFIGURATION STORAGE
// ============================================

const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "channels.json");

fs.mkdirSync(dataDir, { recursive: true });

let configurations = {};

if (fs.existsSync(dataFile)) {
  try {
    configurations = JSON.parse(
      fs.readFileSync(dataFile, "utf8")
    );
  } catch (error) {
    console.error("Cannot load channel configuration:", error);
    process.exit(1);
  }
}

function saveConfigurations() {
  const tempFile = dataFile + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(configurations, null, 2)
  );

  fs.renameSync(tempFile, dataFile);
}

function isMonitored(guildId, channelId) {
  return (configurations[guildId] || [])
    .includes(channelId);
}

// ============================================
// 4. CREATE SLASH COMMANDS
// ============================================

const feedbackCommand = new SlashCommandBuilder()
  .setName("feedback")
  .setDescription("Submit feedback and manage collection")

  // USER: /feedback new
  .addSubcommand(sub =>
    sub
      .setName("new")
      .setDescription("Submit feedback or report an issue")
  )

  // ADMIN: /feedback add
  .addSubcommand(sub =>
    sub
      .setName("add")
      .setDescription("Enable feedback collection")
      .addChannelOption(option =>
        option
          .setName("channel")
          .setDescription("Channel to monitor")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement
          )
          .setRequired(true)
      )
  )

  // ADMIN: /feedback remove
  .addSubcommand(sub =>
    sub
      .setName("remove")
      .setDescription("Disable feedback collection")
      .addChannelOption(option =>
        option
          .setName("channel")
          .setDescription("Channel to remove")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement
          )
          .setRequired(true)
      )
  )

  // ADMIN: /feedback list
  .addSubcommand(sub =>
    sub
      .setName("list")
      .setDescription("Show monitored channels")
  );

// ============================================
// 5. DISCORD BOT READY
// ============================================

client.once(Events.ClientReady, async readyClient => {
  console.log(`Bot connected: ${readyClient.user.tag}`);

  try {
    await readyClient.application.commands.set([
      feedbackCommand.toJSON()
    ]);

    console.log("Slash commands registered successfully");
  } catch (error) {
    console.error("Command registration failed:", error);
  }
});

// ============================================
// 6. WEBHOOK FORWARDING FUNCTION
// ============================================

async function forwardToWebhook(payload) {

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": WEBHOOK_SECRET
        },

        body: JSON.stringify(payload),

        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(
          `Webhook returned HTTP ${response.status}`
        );
      }

      console.log(
        `[WEBHOOK] Delivered: ${payload.event_type}`,
        payload.message_id
      );

      return true;

    } catch (error) {

      console.error(
        `[WEBHOOK] Attempt ${attempt} failed:`,
        error.message
      );

      if (attempt < 3) {
        await new Promise(resolve =>
          setTimeout(resolve, attempt * 1000)
        );
      }
    }
  }

  throw new Error("Webhook delivery failed after 3 attempts");
}

// ============================================
// 7. BUILD FEEDBACK FORM
// ============================================

function createFeedbackModal(guildId, channelId) {

  const titleInput = new TextInputBuilder()
    .setCustomId("feedback_title")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Example: Dashboard loading slowly")
    .setMinLength(5)
    .setMaxLength(150)
    .setRequired(true);

  const descriptionInput = new TextInputBuilder()
    .setCustomId("feedback_description")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(
      "Describe the issue or suggestion in detail"
    )
    .setMinLength(10)
    .setMaxLength(2000)
    .setRequired(true);

  const emailInput = new TextInputBuilder()
    .setCustomId("feedback_email")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("you@example.com")
    .setMaxLength(254)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(
      `feedback_modal:${guildId}:${channelId}`
    )
    .setTitle("Submit Feedback")
    .addLabelComponents(

      new LabelBuilder()
        .setLabel("Issue Title")
        .setTextInputComponent(titleInput),

      new LabelBuilder()
        .setLabel("Description")
        .setTextInputComponent(descriptionInput),

      new LabelBuilder()
        .setLabel("Email Address")
        .setDescription(
          "Used for issue updates; not shown publicly."
        )
        .setTextInputComponent(emailInput)

    );
}

// ============================================
// 8. HANDLE DISCORD INTERACTIONS
// ============================================

client.on(Events.InteractionCreate, async interaction => {

  try {

    // ----------------------------------------
    // A. FEEDBACK FORM SUBMISSION
    // ----------------------------------------

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("feedback_modal:")
    ) {

      const parts = interaction.customId.split(":");

      const originalGuildId = parts[1];
      const originalChannelId = parts[2];

      if (
        !interaction.inGuild() ||
        interaction.guildId !== originalGuildId ||
        interaction.channelId !== originalChannelId ||
        !isMonitored(
          interaction.guildId,
          interaction.channelId
        )
      ) {
        return interaction.reply({
          content: "Feedback is not enabled in this channel.",
          flags: MessageFlags.Ephemeral
        });
      }

      // Collect submitted values
      const title = interaction.fields
        .getTextInputValue("feedback_title")
        .trim();

      const description = interaction.fields
        .getTextInputValue("feedback_description")
        .trim();

      const email = interaction.fields
        .getTextInputValue("feedback_email")
        .trim()
        .toLowerCase();

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!emailRegex.test(email) || email.length > 254) {
        return interaction.reply({
          content: "Please enter a valid email address.",
          flags: MessageFlags.Ephemeral
        });
      }

      // Acknowledge form submission
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      // --------------------------------------
      // Create public feedback embed
      // --------------------------------------

      const embed = new EmbedBuilder()
        .setTitle(`New Feedback: ${title}`)
        .setDescription(description)
        .setColor(0x5865F2)
        .addFields(
          {
            name: "Submitted By",
            value: `<@${interaction.user.id}>`,
            inline: true
          },
          {
            name: "Status",
            value: "Open",
            inline: true
          }
        )
        .setFooter({
          text: "Submitted using Feedback Collector"
        })
        .setTimestamp();

      // IMPORTANT: Do not include email
      // in the public Discord embed.

      let postedMessage;

      try {
        postedMessage = await interaction.channel.send({
          embeds: [embed],
          allowedMentions: { parse: [] }
        });
      } catch (error) {
        console.error("Failed to post feedback:", error);

        return interaction.editReply({
          content:
            "Could not post feedback. " +
            "Please contact the server administrator."
        });
      }

      // --------------------------------------
      // Prepare structured webhook payload
      // --------------------------------------

      const payload = {
        platform: "discord",
        event_type: "feedback.created",

        guild_id: interaction.guildId,
        guild_name: interaction.guild.name,

        channel_id: interaction.channelId,
        channel_name: interaction.channel.name,

        message_id: postedMessage.id,

        author: {
          id: interaction.user.id,
          username: interaction.user.username,
          display_name: interaction.user.globalName
        },

        feedback: {
          title: title,
          description: description,
          email: email,
          status: "open"
        },

        timestamp: new Date().toISOString()
      };

      // --------------------------------------
      // Forward to your backend
      // --------------------------------------

      try {

        await forwardToWebhook(payload);

        await interaction.editReply({
          content:
            "Your feedback was submitted successfully! " +
            "You may receive email updates about this issue."
        });

      } catch (error) {

        console.error(
          "Feedback webhook delivery failed:",
          error
        );

        await interaction.editReply({
          content:
            "Your feedback was posted in Discord, " +
            "but syncing it to the feedback system failed. " +
            "Please contact the server administrator."
        });
      }

      return;
    }

    // ----------------------------------------
    // B. HANDLE SLASH COMMANDS
    // ----------------------------------------

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "feedback") return;
    if (!interaction.inGuild()) return;

    const action = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // ----------------------------------------
    // /feedback new
    // ----------------------------------------

    if (action === "new") {

      if (!isMonitored(guildId, interaction.channelId)) {
        return interaction.reply({
          content:
            "Feedback is not enabled in this channel. " +
            "Please contact a server administrator.",
          flags: MessageFlags.Ephemeral
        });
      }

      const modal = createFeedbackModal(
        guildId,
        interaction.channelId
      );

      await interaction.showModal(modal);
      return;
    }

    // ----------------------------------------
    // Admin permission check
    // ----------------------------------------

    if (
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.ManageGuild
      )
    ) {
      return interaction.reply({
        content:
          "You need Manage Server permission " +
          "to use this command.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (!configurations[guildId]) {
      configurations[guildId] = [];
    }

    const channels = configurations[guildId];

    // ----------------------------------------
    // /feedback add
    // ----------------------------------------

    if (action === "add") {

      const channel = interaction.options
        .getChannel("channel");

      const botMember = await interaction.guild
        .members.fetchMe();

      const permissions = channel.permissionsFor(botMember);

      const requiredPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks
      ];

      if (
        !permissions ||
        !requiredPermissions.every(
          permission => permissions.has(permission)
        )
      ) {
        return interaction.reply({
          content:
            "The bot needs View Channel, " +
            "Send Messages and Embed Links permissions.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (channels.includes(channel.id)) {
        return interaction.reply({
          content: "This channel is already monitored.",
          flags: MessageFlags.Ephemeral
        });
      }

      channels.push(channel.id);
      saveConfigurations();

      return interaction.reply({
        content:
          `Feedback collection enabled for ${channel}.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // ----------------------------------------
    // /feedback remove
    // ----------------------------------------

    if (action === "remove") {

      const channel = interaction.options
        .getChannel("channel");

      configurations[guildId] = channels.filter(
        id => id !== channel.id
      );

      saveConfigurations();

      return interaction.reply({
        content:
          `Feedback collection disabled for ${channel}.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // ----------------------------------------
    // /feedback list
    // ----------------------------------------

    if (action === "list") {

      const result = channels.length
        ? channels.map(id => `<#${id}>`).join("\n")
        : "No channels configured.";

      return interaction.reply({
        content: `Monitored Channels:\n${result}`,
        flags: MessageFlags.Ephemeral
      });
    }

  } catch (error) {

    console.error("Interaction error:", error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "Something went wrong.",
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.reply({
          content: "Something went wrong.",
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (replyError) {
      console.error("Failed to send error reply:", replyError);
    }
  }
});

// ============================================
// 9. MONITOR ORDINARY CHANNEL MESSAGES
// ============================================

client.on(Events.MessageCreate, async message => {

  // Ignore DMs and bot messages
  if (!message.guild || message.author.bot) {
    return;
  }

  const guildId = message.guild.id;
  const channelId = message.channel.id;

  if (!isMonitored(guildId, channelId)) {
    return;
  }

  const payload = {
    platform: "discord",
    event_type: "message.created",

    guild_id: guildId,
    guild_name: message.guild.name,

    channel_id: channelId,
    channel_name: message.channel.name,

    message_id: message.id,

    author: {
      id: message.author.id,
      username: message.author.username,
      display_name: message.author.globalName
    },

    content: message.content,

    attachments: message.attachments.map(file => ({
      name: file.name,
      url: file.url,
      content_type: file.contentType
    })),

    timestamp: message.createdAt.toISOString()
  };

  try {

    await forwardToWebhook(payload);

    console.log(
      `[MESSAGE] Forwarded from ${message.guild.name} / #${message.channel.name}`
    );

  } catch (error) {

    console.error(
      `[MESSAGE] Delivery failed: ${message.id}`,
      error.message
    );
  }
});

// ============================================
// 10. REMOVE CONFIG WHEN BOT LEAVES SERVER
// ============================================

client.on(Events.GuildDelete, guild => {

  delete configurations[guild.id];
  saveConfigurations();

  console.log(
    `Removed configuration for ${guild.name}`
  );
});

// ============================================
// 11. HANDLE CLIENT ERRORS
// ============================================

client.on(Events.Error, error => {
  console.error("Discord client error:", error);
});

// ============================================
// 12. START BOT
// ============================================

client.login(DISCORD_TOKEN).catch(error => {
  console.error("Failed to log in:", error);
  process.exit(1);
});
