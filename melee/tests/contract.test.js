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

// parry.gg's gRPC-web API is public (no token), so this always runs. Its
// protobuf field numbers were taken from the parrygg-python package rather
// than published docs, which makes drift here the likelier failure.
async function parryCall(method, fields, schema) {
  const res = await fetch(core.PARRY_API_URL + method, {
    method: "POST",
    headers: {
      "Content-Type": "application/grpc-web+proto",
      "X-Grpc-Web": "1",
    },
    body: core.grpcWebFrame(core.pbEncode(fields)),
  });
  const { payload, status, message } = core.parseGrpcWebResponse(
    new Uint8Array(await res.arrayBuffer())
  );
  const grpcStatus = status ?? res.headers.get("grpc-status");
  assert.ok(
    res.ok && (!grpcStatus || grpcStatus === "0"),
    `${method}: gRPC ${grpcStatus} ${message ?? res.headers.get("grpc-message")}`
  );
  return core.pbDecode(payload, schema);
}

// Stable historical fixture: Altitude Sickness 3 (completed May 2026).
const PARRY_TOURNEY_SLUG = "as3";
const PARRY_EVENT_SLUG = "melee-singles";

describe("parry.gg API contract", () => {
  let event;
  before(async () => {
    const res = await parryCall(
      "EventService/GetEvent",
      [[2, [[2, [[1, PARRY_TOURNEY_SLUG], [2, PARRY_EVENT_SLUG]]]]]],
      core.PARRY_EVENT_RESPONSE
    );
    event = core.parryEventInfo(res.event);
  });

  it("event lookup by slug resolves the event and its phase sizes", () => {
    assert.ok(event, "event found");
    assert.equal(event.entrantCount, 235, "entrant count");
    assert.deepEqual(
      event.phases.map((p) => [p.numSeeds, p.numBrackets]),
      [[235, 8], [32, 1], [8, 1]],
      "pools -> top 32 -> top 8"
    );
  });

  it("completed matches decode into renderable sets", async () => {
    const { matches } = await parryCall(
      "MatchService/GetMatches",
      [[1, [[7, [[1, event.id]]], [3, core.PARRY_MATCH_STATE_COMPLETED]]]],
      core.PARRY_MATCHES_RESPONSE
    );
    assert.ok(matches.length > 400, "full event of completed matches");
    const [gf, lf] = core.parryRecentSets(matches, event, 5);
    const info = { entrantsCount: 235, bracketSize: 256, maxPhaseOrder: 3 };
    assert.equal(core.formatRound(gf, info), "GF", "latest set is GF");
    assert.equal(core.formatRound(lf, info), "LF", "then losers final");
    assert.deepEqual(
      gf.slots.map((s) => [s.entrant.name, s.standing.stats.score.value]),
      [["Joshman", 3], ["Jmook", 1]],
      "GF names and scores"
    );
    assert.ok(gf.slots.every((s) => s.seed.seedNum > 0), "seed numbers");
  });
});

if (!TOKEN) {
  console.log("start.gg contract tests skipped: no STARTGG_TOKEN and no local config");
}
