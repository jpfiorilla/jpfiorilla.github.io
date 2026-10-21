// Contract tests against the LIVE start.gg API. These exist to catch API
// drift: filters that stop working, query shapes that stop parsing, the
// response-dependent 1000-object complexity cap, and set data changing
// shape. Run on demand (npm run test:contract) or on the weekly GitHub
// Actions schedule; failures there are the drift alert.
//
// Token: STARTGG_TOKEN env var, or the gitignored melee/recent-sets-config.js.
// Budget: ~6 requests, spaced to respect the 80/min rate limit.
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../recent-sets-core.js");

function findToken() {
  if (process.env.STARTGG_TOKEN) return process.env.STARTGG_TOKEN;
  try {
    const cfg = fs.readFileSync(
      path.join(__dirname, "..", "recent-sets-config.js"),
      "utf8"
    );
    return cfg.match(/STARTGG_TOKEN\s*=\s*"([^"]+)"/)?.[1] || null;
  } catch {
    return null;
  }
}

const TOKEN = findToken();
const API = "https://api.start.gg/gql/alpha";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (
      json.success === false &&
      /Rate limit/.test(json.message || "") &&
      attempt < 4
    ) {
      await sleep(55000);
      continue;
    }
    if (json.errors || json.success === false) {
      throw new Error(JSON.stringify(json.errors || json).slice(0, 300));
    }
    return json.data;
  }
}

// Stable historical fixtures (completed events never change):
const EVENT_SLUG = "tournament/nycmelee-s-stock-exchange-64/event/melee-singles";
const TOURNEY_SLUG = "nycmelee-s-stock-exchange-64";
const RYOBEAT = 4748; // 1890+ sets; pages 7-9 are doubles-heavy
const AKLO = 282096;
const RYOBEAT_AKLO_2025_SET = "90401926"; // completed 2025-06-19

describe("start.gg API contract", { skip: !TOKEN && "no STARTGG_TOKEN" }, () => {
  it("main poll query parses and returns the expected keys", async () => {
    const data = await gql(core.pollQuery(5), {
      slug: EVENT_SLUG,
      tourneySlug: TOURNEY_SLUG,
    });
    assert.ok(data.event.id, "event.id");
    assert.ok(Array.isArray(data.event.sets.nodes), "recent sets array");
    assert.ok(data.event.sets.nodes.length > 0, "recent sets non-empty");
    assert.ok("onStream" in data.event, "onStream alias present");
    assert.ok("streamQueue" in data.tournament, "streamQueue present");
    const s = data.event.sets.nodes[0];
    assert.ok(s.fullRoundText, "fullRoundText");
    assert.ok(s.slots[0].entrant.name, "entrant name");
    assert.notEqual(
      s.slots[0].standing?.stats?.score?.value,
      undefined,
      "score value"
    );
  });

  it("walk pages stay under the complexity cap on doubles-heavy history", async () => {
    for (const page of [7, 8]) {
      await sleep(1500);
      const data = await gql(core.walkQuery(core.H2H_PAGE_SIZE), {
        pid: RYOBEAT,
        page,
      });
      const nodes = data.player.sets.nodes;
      assert.equal(nodes.length, core.H2H_PAGE_SIZE, `page ${page} full`);
      assert.ok("completedAt" in nodes[0], "completedAt field");
      assert.ok("displayScore" in nodes[0], "displayScore field");
    }
  });

  it("pageInfo totals work for the walk-player pick", async () => {
    await sleep(1500);
    const data = await gql(
      `query($p: ID!) { player(id: $p) { sets(page: 1, perPage: 1) { pageInfo { total } } } }`,
      { p: RYOBEAT }
    );
    assert.ok(data.player.sets.pageInfo.total >= 1890, "total >= 1890");
  });

  it("set-details query returns a stable historical set intact", async () => {
    await sleep(1500);
    const [detail] = await core.fetchSetDetails(gql, [RYOBEAT_AKLO_2025_SET]);
    assert.ok(detail, "set found");
    const pids = detail.players.map((p) => p.playerId).sort();
    assert.deepEqual(pids, [RYOBEAT, AKLO].sort(), "both players");
    assert.equal(
      new Date(detail.date).toISOString().slice(0, 10),
      "2025-06-19",
      "completed date"
    );
    assert.ok(detail.tournament, "tournament name");
    assert.ok(
      detail.players.some((p) => p.won),
      "winner flagged"
    );
  });

  it("tournament short links resolve to the series' current event", async () => {
    await sleep(1500);
    const data = await gql(
      `query($s: String!) { tournament(slug: $s) { slug events { slug } } }`,
      { s: "nyse" }
    );
    assert.match(
      data.tournament.slug,
      /^tournament\/nycmelee-s-stock-exchange-/,
      "nyse points at a Stock Exchange"
    );
    assert.match(
      data.tournament.events[0].slug,
      /\/event\/melee-singles$/,
      "first event is main singles"
    );
  });

  it("active-set state filter still parses", async () => {
    await sleep(1500);
    const data = await gql(
      `query($slug: String!) {
        event(slug: $slug) {
          sets(page: 1, perPage: 5, filters: { state: [1, 2, 6] }) {
            nodes { id state stream { streamName } }
          }
        }
      }`,
      { slug: EVENT_SLUG }
    );
    assert.ok(Array.isArray(data.event.sets.nodes), "filtered sets array");
  });
});

if (!TOKEN) {
  console.log("contract tests skipped: no STARTGG_TOKEN and no local config");
}
