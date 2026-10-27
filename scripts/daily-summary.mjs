// Daily team summary: reads Linear, posts to Discord. No packages needed (Node 20+).
// Secrets: LINEAR_API_KEY, DISCORD_WEBHOOK_URL. Optional: LINEAR_TEAM_KEY (default INC), FORCE=true to skip the 5pm check.

const LINEAR_KEY = process.env.LINEAR_API_KEY;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TEAM = process.env.LINEAR_TEAM_KEY || "INC";
const FORCE = process.env.FORCE === "true";
const TZ = "Europe/London";
const STALE_DAYS = 2;

if (!LINEAR_KEY || !WEBHOOK) {
  console.error("Missing LINEAR_API_KEY or DISCORD_WEBHOOK_URL secret.");
  process.exit(1);
}

// GitHub cron is in UTC, so the workflow runs at 16:00 and 17:00 UTC.
// Only the run that lands at 5pm UK time (summer or winter) posts.
const now = new Date();
const londonPart = (opts) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts }).format(now);
const londonHour = Number(londonPart({ hour: "numeric", hourCycle: "h23" }));
if (!FORCE && londonHour !== 17) {
  console.log(`UK time is ${londonHour}:xx, not 17:xx — skipping this run.`);
  process.exit(0);
}

// Monday covers the weekend too.
const isMonday = londonPart({ weekday: "short" }) === "Mon";
const lookbackHours = isMonday ? 72 : 24;
const since = new Date(now.getTime() - lookbackHours * 3600 * 1000).toISOString();
const dateLabel = londonPart({ weekday: "short", day: "numeric", month: "short" });

async function gql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: LINEAR_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error("Linear error: " + JSON.stringify(json.errors || json));
  return json.data;
}

const QUERY = `
query ($team: String!, $since: DateTimeOrDuration!) {
  users(first: 100, filter: { active: { eq: true } }) { nodes { id name email } }
  open: issues(first: 250, filter: { team: { key: { eq: $team } }, state: { type: { in: ["started", "unstarted"] } } }) { nodes { ...F } }
  done: issues(first: 250, filter: { team: { key: { eq: $team } }, completedAt: { gte: $since } }) { nodes { ...F } }
}
fragment F on Issue {
  identifier title url priority updatedAt
  state { name type }
  assignee { id name }
  project { name }
}`;

const short = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const link = (i) => `[${i.identifier}](${i.url})`;
const proj = (i) => (i.project ? ` · ${i.project.name}` : "");
const who = (i) => (i.assignee ? i.assignee.name : "unassigned");
const daysSince = (iso) => Math.floor((now - new Date(iso)) / 86400000);

async function main() {
  const data = await gql(QUERY, { team: TEAM, since });
  const people = data.users.nodes.filter((u) => !u.email.endsWith("linear.linear.app"));
  const open = data.open.nodes;
  const done = data.done.nodes;

  const started = open.filter((i) => i.state.type === "started");
  const blocked = started.filter((i) => /blocked/i.test(i.state.name));
  const working = started.filter((i) => !/blocked/i.test(i.state.name));
  const stale = working.filter((i) => i.state.name === "In Progress" && daysSince(i.updatedAt) >= STALE_DAYS);
  const urgentUnassigned = open.filter((i) => !i.assignee && (i.priority === 1 || i.priority === 2));

  const lines = [`📊 **Daily summary — ${dateLabel}**`, ""];

  lines.push(`**🔴 Blocked (${blocked.length})**`);
  if (blocked.length) blocked.forEach((i) => lines.push(`• ${link(i)} ${short(i.title)} — ${who(i)}${proj(i)}`));
  else lines.push("• Nothing blocked 👍");
  lines.push("");

  if (stale.length || urgentUnassigned.length) {
    lines.push("**⚠️ Needs attention**");
    stale.forEach((i) => lines.push(`• ${link(i)} no update for ${daysSince(i.updatedAt)} days — ${who(i)}`));
    urgentUnassigned.forEach((i) => lines.push(`• ${link(i)} high priority, no one assigned${proj(i)}`));
    lines.push("");
  }

  lines.push(`**✅ Done (last ${lookbackHours}h): ${done.length}**`);
  done.forEach((i) => lines.push(`• ${link(i)} ${short(i.title)} — ${who(i)}`));
  lines.push("");

  lines.push("**👥 Who is on what**");
  const byPerson = new Map();
  for (const i of working) {
    const key = i.assignee ? i.assignee.id : "none";
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(i);
  }
  for (const p of people) {
    const tasks = byPerson.get(p.id);
    if (!tasks) continue;
    const list = tasks
      .map((i) => `${link(i)} ${short(i.title, 40)}${i.state.name !== "In Progress" ? ` (${i.state.name})` : ""}`)
      .join(", ");
    lines.push(`**${p.name}** — ${list}`);
  }
  if (byPerson.has("none")) lines.push(`**Unassigned** — ${byPerson.get("none").map(link).join(", ")}`);
  if (!working.length) lines.push("• No tasks in progress");
  lines.push("");

  const idle = people.filter((p) => !byPerson.has(p.id) && !blocked.some((i) => i.assignee?.id === p.id));
  lines.push(`**🟢 No task in progress (${idle.length}):** ${idle.map((p) => p.name).join(", ") || "everyone is busy"}`);

  await postToDiscord(lines);
  console.log("Summary posted.");
}

// Discord allows 2000 characters per message, so split long summaries.
async function postToDiscord(lines) {
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    if ((cur + line + "\n").length > 1900) { chunks.push(cur); cur = ""; }
    cur += line + "\n";
  }
  if (cur.trim()) chunks.push(cur);
  for (const content of chunks) {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, flags: 4, allowed_mentions: { parse: [] } }), // 4 = no link previews
    });
    if (!res.ok) throw new Error(`Discord error ${res.status}: ${await res.text()}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
