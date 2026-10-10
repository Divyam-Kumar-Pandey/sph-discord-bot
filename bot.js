
require("dotenv").config();

const crypto = require("node:crypto");

const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits
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
    "Missing required environment variables."
  );
  process.exit(1);
}

// ============================================
// 2. INITIALIZE DISCORD BOT
// ============================================

// Only Guilds intent is required for slash
// commands and modal interactions.

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ============================================
// 3. REGISTER /feedback new COMMAND
// ============================================

const feedbackCommand = new SlashCommandBuilder()
  .setName("feedback")
  .setDescription("Submit product feedback")
  .addSubcommand(sub =>
    sub
      .setName("new")
      .setDescription("Report an issue or suggest a feature")
  );

// ============================================
// 4. BOT READY
// ============================================

client.once(Events.ClientReady, async readyClient => {

  console.log(
    `Bot connected as ${readyClient.user.tag}`
  );

  try {
    await readyClient.application.commands.set([
      feedbackCommand.toJSON()
    ]);

    console.log("Slash command registered: /feedback new");

  } catch (error) {
    console.error(
      "Failed to register slash command:",
      error
    );
  }
});

// ============================================
// 5. WEBHOOK FORWARDING
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
        `[WEBHOOK] Feedback delivered: ${payload.feedback_id}`
      );

      return;

    } catch (error) {

      console.error(
        `[WEBHOOK] Attempt ${attempt} failed:`,
        error.message
      );

      if (attempt === 3) {
        throw error;
      }

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 1000)
      );
    }
  }
}

// ============================================
// 6. CREATE FEEDBACK MODAL
// ============================================

function createFeedbackModal() {

  // Issue title
  const titleInput = new TextInputBuilder()
    .setCustomId("feedback_title")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Example: Dashboard loading slowly")
    .setMinLength(5)
    .setMaxLength(150)
    .setRequired(true);

  // Issue description
  const descriptionInput = new TextInputBuilder()
    .setCustomId("feedback_description")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(
      "Describe the issue or suggestion in detail"
    )
    .setMinLength(10)
    .setMaxLength(2000)
    .setRequired(true);

  // Contact email
  const emailInput = new TextInputBuilder()
    .setCustomId("feedback_email")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("you@example.com")
    .setMaxLength(254)
    .setRequired(true);

  const modal = new ModalBuilder()
    .setCustomId("feedback_submission")
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
          "For issue updates; never shown publicly."
        )
        .setTextInputComponent(emailInput)

    );

  return modal;
}

// ============================================
// 7. HANDLE SLASH COMMANDS AND MODALS
// ============================================

client.on(Events.InteractionCreate, async interaction => {

  try {

    // ----------------------------------------
    // A. HANDLE /feedback new
    // ----------------------------------------

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "feedback" &&
      interaction.options.getSubcommand() === "new"
    ) {

      if (!interaction.inGuild()) {
        return interaction.reply({
          content:
            "Please use this command in a Discord server.",
          flags: MessageFlags.Ephemeral
        });
      }

      // Open feedback form
      await interaction.showModal(
        createFeedbackModal()
      );

      return;
    }

    // ----------------------------------------
    // B. HANDLE FEEDBACK FORM SUBMISSION
    // ----------------------------------------

    if (
      !interaction.isModalSubmit() ||
      interaction.customId !== "feedback_submission"
    ) {
      return;
    }

    if (!interaction.inGuild() || !interaction.channel) {
      return interaction.reply({
        content:
          "Feedback must be submitted in a server channel.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Collect form values
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

    // ----------------------------------------
    // C. VALIDATE EMAIL
    // ----------------------------------------

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email) || email.length > 254) {
      return interaction.reply({
        content:
          "Please enter a valid email address.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Acknowledge submission
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });

    // ----------------------------------------
    // D. GENERATE FEEDBACK ID
    // ----------------------------------------

    const feedbackId = crypto.randomUUID();

    // ----------------------------------------
    // E. CREATE PUBLIC DISCORD EMBED
    // ----------------------------------------

    const embed = new EmbedBuilder()
      .setTitle("New Feedback")
      .setColor(0x5865F2)
      .addFields(
        {
          name: "Issue Title",
          value: title
        },
        {
          name: "Description",
          value: description
        },
        {
          name: "Submitted By",
          value: `<@${interaction.user.id}>`,
          inline: true
        }
      )
      .setFooter({
        text: `Feedback ID: ${feedbackId}`
      })
      .setTimestamp();

    // IMPORTANT:
    // Email is intentionally NOT included
    // in this public Discord embed.

    // ----------------------------------------
    // F. VERIFY CHANNEL PERMISSIONS
    // ----------------------------------------

    const channel = interaction.channel;

    if (
      !channel.isTextBased() ||
      typeof channel.send !== "function"
    ) {
      return interaction.editReply({
        content:
          "This channel does not support feedback posts."
      });
    }

    const botMember =
      await interaction.guild.members.fetchMe();

    const permissions =
      channel.permissionsFor(botMember);

    if (
      !permissions?.has(
        PermissionFlagsBits.ViewChannel
      ) ||
      !permissions?.has(
        PermissionFlagsBits.SendMessages
      ) ||
      !permissions?.has(
        PermissionFlagsBits.EmbedLinks
      )
    ) {
      return interaction.editReply({
        content:
          "The bot needs View Channel, " +
          "Send Messages and Embed Links permissions."
      });
    }

    // ----------------------------------------
    // G. POST FEEDBACK IN DISCORD
    // ----------------------------------------

    let postedMessage;

    try {

      postedMessage = await channel.send({
        embeds: [embed],

        // Prevent arbitrary user input
        // from pinging server members.
        allowedMentions: {
          parse: []
        }
      });

      console.log(
        `[DISCORD] Feedback posted: ${feedbackId}`
      );

    } catch (error) {

      console.error(
        "Failed to post feedback:",
        error
      );

      return interaction.editReply({
        content:
          "Failed to post feedback in this channel."
      });
    }

    // ----------------------------------------
    // H. CREATE WEBHOOK PAYLOAD
    // ----------------------------------------

    const payload = {

      platform: "discord",
      event_type: "feedback.created",

      feedback_id: feedbackId,

      guild_id: interaction.guildId,
      guild_name: interaction.guild.name,

      channel_id: interaction.channelId,
      channel_name: channel.name ?? null,

      message_id: postedMessage.id,

      message_url: postedMessage.url,

      author: {
        id: interaction.user.id,
        username: interaction.user.username,
        display_name:
          interaction.user.globalName ??
          interaction.user.username
      },

      feedback: {
        title: title,
        description: description,
        email: email
      },

      timestamp: new Date().toISOString()
    };

    // ----------------------------------------
    // I. FORWARD TO YOUR BACKEND
    // ----------------------------------------

    try {

      await forwardToWebhook(payload);

      await interaction.editReply({
        content:
          "Your feedback was submitted successfully! " +
          "You may receive email updates about your issue."
      });

    } catch (error) {

      console.error(
        "Failed to sync feedback:",
        error
      );

      await interaction.editReply({
        content:
          "Your feedback was posted in Discord, " +
          "but syncing it to our system failed. " +
          "Please contact the server administrator."
      });
    }

  } catch (error) {

    console.error("Interaction error:", error);

    try {
      if (interaction.deferred) {

        await interaction.editReply({
          content: "An unexpected error occurred."
        });

      } else if (interaction.replied) {

        await interaction.followUp({
          content: "An unexpected error occurred.",
          flags: MessageFlags.Ephemeral
        });

      } else {

        await interaction.reply({
          content: "An unexpected error occurred.",
          flags: MessageFlags.Ephemeral
        });
      }

    } catch (replyError) {
      console.error(
        "Could not send error response:",
        replyError
      );
    }
  }
});

// ============================================
// 8. HANDLE CLIENT ERRORS
// ============================================

client.on(Events.Error, error => {
  console.error("Discord client error:", error);
});

// ============================================
// 9. START BOT
// ============================================

client.login(DISCORD_TOKEN).catch(error => {
  console.error("Discord login failed:", error);
  process.exit(1);
});
