require("dotenv").config();
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

function getOrCreateUserData(session, userId, username) {
  if (!session.users.has(userId)) {
    session.users.set(userId, {
      username,
      selectedDays: new Set(),
      selectedTimes: new Set(),
    });
  }
  return session.users.get(userId);
}

function getNamesForDay(session, dayKey) {
  const names = [];
  for (const userData of session.users.values()) {
    if (userData.selectedDays.has(dayKey)) {
      names.push(userData.username);
    }
  }
  return names;
}

function getNamesForTime(session, time) {
  const names = [];
  for (const userData of session.users.values()) {
    if (userData.selectedTimes.has(time)) {
      names.push(userData.username);
    }
  }
  return names;
}

function buildDetailText(session) {
  const lines = ["집계 현황표", "", "[요일]"];
  for (const day of DAYS) {
    const names = getNamesForDay(session, day.key).sort((a, b) => a.localeCompare(b, "ko"));
    lines.push(`- ${day.label}요일 (${names.length}명): ${names.length > 0 ? names.join(", ") : "없음"}`);
  }

  lines.push("");
  lines.push("[시간]");
  for (const time of TIME_SLOTS) {
    const names = getNamesForTime(session, time).sort((a, b) => a.localeCompare(b, "ko"));
    lines.push(`- ${time} (${names.length}명): ${names.length > 0 ? names.join(", ") : "없음"}`);
  }

  return lines.join("\n");
}

function buildSummaryEmbed(session) {
  const lines = [];
  let totalSelections = 0;

  for (const day of DAYS) {
    const names = getNamesForDay(session, day.key);
    totalSelections += names.length;
    lines.push(`- ${day.label}요일: ${names.length}명`);
  }

  lines.push("");
  lines.push("## 시간");
  for (const time of TIME_SLOTS) {
    const names = getNamesForTime(session, time);
    totalSelections += names.length;
    lines.push(`- ${time}: ${names.length}명`);
  }

  const summaryLine = totalSelections > 0 ? `총 선택 수: ${totalSelections}` : "아직 아무도 선택하지 않았어요.";

  return new EmbedBuilder()
    .setTitle("요일/시간 조율")
    .setDescription(lines.join("\n"))
    .addFields({ name: "집계", value: summaryLine })
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

    const userData = getOrCreateUserData(session, interaction.user.id, interaction.user.username);

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
