require("dotenv").config();
const http = require("http");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const DAYS = [
  { key: "MON", label: "월" },
  { key: "TUE", label: "화" },
  { key: "WED", label: "수" },
  { key: "THU", label: "목" },
  { key: "FRI", label: "금" },
  { key: "SAT", label: "토" },
  { key: "SUN", label: "일" },
];
const TIME_SLOTS = ["19:00", "19:30", "20:00", "20:30", "21:00"];

const sessions = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("일정생성")
    .setDescription("주간(월~일) 요일/시간 참여 여부를 조율판으로 생성합니다."),
].map((command) => command.toJSON());

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.log("DISCORD_TOKEN 또는 CLIENT_ID가 없어 슬래시 명령어 등록을 건너뜁니다.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("길드 전용 슬래시 명령어 등록 완료");
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("전역 슬래시 명령어 등록 완료 (반영까지 시간 소요 가능)");
}

function makeSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildComponents(sessionId) {
  const dayRow1 = new ActionRowBuilder().addComponents(
    DAYS.slice(0, 5).map((day) =>
      new ButtonBuilder()
        .setCustomId(`day:${sessionId}:${day.key}`)
        .setLabel(day.label)
        .setStyle(ButtonStyle.Primary)
    )
  );

  const dayRow2 = new ActionRowBuilder().addComponents(
    ...DAYS.slice(5).map((day) =>
      new ButtonBuilder()
        .setCustomId(`day:${sessionId}:${day.key}`)
        .setLabel(day.label)
        .setStyle(ButtonStyle.Primary)
    ),
    new ButtonBuilder()
      .setCustomId(`view:${sessionId}`)
      .setLabel("조회")
      .setStyle(ButtonStyle.Success)
  );

  const timeRow = new ActionRowBuilder().addComponents(
    TIME_SLOTS.map((time) =>
      new ButtonBuilder()
        .setCustomId(`time:${sessionId}:${time}`)
        .setLabel(time)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return [dayRow1, dayRow2, timeRow];
}

function getDisplayName(interaction) {
  if (interaction.member && typeof interaction.member.displayName === "string") {
    return interaction.member.displayName;
  }
  return interaction.user.globalName || interaction.user.username;
}

function getOrCreateUserData(session, userId, username) {
  if (!session.users.has(userId)) {
    session.users.set(userId, {
      username,
      selectedDays: new Set(),
      selectedTimes: new Set(),
    });
  }
  const userData = session.users.get(userId);
  userData.username = username;
  return userData;
}

function getMentionsForDay(session, dayKey) {
  const mentions = [];
  for (const [userId, userData] of session.users.entries()) {
    if (userData.selectedDays.has(dayKey)) {
      mentions.push(`<@${userId}>`);
    }
  }
  return mentions;
}

function getMentionsForTime(session, time) {
  const mentions = [];
  for (const [userId, userData] of session.users.entries()) {
    if (userData.selectedTimes.has(time)) {
      mentions.push(`<@${userId}>`);
    }
  }
  return mentions;
}

function buildDetailText(session) {
  const lines = ["집계 현황표", "", "[요일]"];
  for (const day of DAYS) {
    const mentions = getMentionsForDay(session, day.key);
    lines.push(
      `- ${day.label}요일 (${mentions.length}명): ${mentions.length > 0 ? mentions.join(", ") : "없음"}`
    );
  }

  lines.push("");
  lines.push("[시간]");
  for (const time of TIME_SLOTS) {
    const mentions = getMentionsForTime(session, time);
    lines.push(`- ${time} (${mentions.length}명): ${mentions.length > 0 ? mentions.join(", ") : "없음"}`);
  }

  return lines.join("\n");
}

function buildSummaryEmbed(session) {
  const lines = [];
  let totalSelections = 0;

  for (const day of DAYS) {
    const mentions = getMentionsForDay(session, day.key);
    totalSelections += mentions.length;
    lines.push(`- ${day.label}요일: ${mentions.length}명`);
  }

  lines.push("");
  lines.push("## 시간");
  for (const time of TIME_SLOTS) {
    const mentions = getMentionsForTime(session, time);
    totalSelections += mentions.length;
    lines.push(`- ${time}: ${mentions.length}명`);
  }

  const guideText =
    "참여 가능하신 요일과 시간을 클릭해 주세요. 일정 선택은 매주 일요일까지 가능하며, 월요일마다 새롭게 리셋됩니다.";

  return new EmbedBuilder()
    .setTitle("요일/시간 조율")
    .setDescription(lines.join("\n"))
    .addFields({ name: "안내", value: guideText })
    .setColor(0x5865f2)
    .setFooter({ text: "요일/시간 버튼을 누르면 선택/해제됩니다." });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`${readyClient.user.tag} 로그인 완료`);
  try {
    await registerCommands();
  } catch (error) {
    console.error("명령어 등록 실패:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== "일정생성") {
      return;
    }

    const sessionId = makeSessionId();
    const session = {
      id: sessionId,
      users: new Map(),
      createdBy: interaction.user.id,
      messageId: null,
    };
    sessions.set(sessionId, session);

    const embed = buildSummaryEmbed(session);
    const message = await interaction.reply({
      embeds: [embed],
      components: buildComponents(sessionId),
      fetchReply: true,
    });

    session.messageId = message.id;
    return;
  }

  if (interaction.isButton()) {
    const [type, sessionId, ...payloadParts] = interaction.customId.split(":");
    const payload = payloadParts.join(":");
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: "이 조율 세션은 만료되었거나 찾을 수 없어요.",
        ephemeral: true,
      });
      return;
    }

    const userData = getOrCreateUserData(session, interaction.user.id, getDisplayName(interaction));

    if (type === "day") {
      if (userData.selectedDays.has(payload)) {
        userData.selectedDays.delete(payload);
      } else {
        userData.selectedDays.add(payload);
      }
      await interaction.update({
        embeds: [buildSummaryEmbed(session)],
        components: buildComponents(sessionId),
      });
      return;
    }

    if (type === "time") {
      if (userData.selectedTimes.has(payload)) {
        userData.selectedTimes.delete(payload);
      } else {
        userData.selectedTimes.add(payload);
      }
      await interaction.update({
        embeds: [buildSummaryEmbed(session)],
        components: buildComponents(sessionId),
      });
      return;
    }

    if (type === "view") {
      await interaction.reply({
        content: buildDetailText(session),
        ephemeral: true,
      });
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN이 없습니다. .env 파일을 확인하세요.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);

// Render Web Service free tier needs an open port.
const port = process.env.PORT;
if (port) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bot is running");
    })
    .listen(port, () => {
      console.log(`Health server listening on port ${port}`);
    });
}
