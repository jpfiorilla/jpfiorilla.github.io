// Unit tests for the recent-sets overlay's pure logic (recent-sets-core.js).
// Runner: node --test (Node 18+). Case tables come from real start.gg data
// verified during development: NYCMelee's Stock Exchange #59 (multi-phase
// bracket) and the Ryobeat/Aklo head-to-head walk.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../recent-sets-core.js");

describe("extractSlugFromUrl", () => {
  it("parses a direct event link", () => {
    assert.equal(
      core.extractSlugFromUrl(
        "https://www.start.gg/tournament/nycmelee-s-stock-exchange-59/event/melee-singles"
      ),
      "tournament/nycmelee-s-stock-exchange-59/event/melee-singles"
    );
  });
  it("rejects a tournament page without an event", () => {
    assert.equal(
      core.extractSlugFromUrl("https://www.start.gg/tournament/foo/details"),
      null
    );
  });
});

describe("extractPlayerTag", () => {
  it("strips sponsor prefixes", () => {
    assert.equal(core.extractPlayerTag("SHED | Epoodle"), "Epoodle");
    assert.equal(core.extractPlayerTag("GP|FULLYA | Manolo"), "Manolo");
  });
  it("handles missing names", () => {
    assert.equal(core.extractPlayerTag(null), "TBD");
  });
});

describe("formatRound (stock-exchange-59: 54-seed bracket -> 16-seed finals)", () => {
  const info = { entrantsCount: 54, bracketSize: 64, maxPhaseOrder: 2 };
  const mk = (round, txt, seeds, order, bt) => ({
    round,
    fullRoundText: txt,
    phaseGroup: {
      bracketType: bt || "DOUBLE_ELIMINATION",
      phase: { numSeeds: seeds, phaseOrder: order },
    },
  });
  const cases = [
    // qualifier phase: names are phase-local lies, labels come from math
    [mk(2, "Winners Round 2", 54, 1), "W.T32"],
    [mk(3, "Winners Quarter-Final", 54, 1), "W.T16"],
    [mk(-3, "Losers Round 1", 54, 1), "L.T64"],
    [mk(-4, "Losers Round 2", 54, 1), "L.T48"],
    [mk(-5, "Losers Round 3", 54, 1), "L.T32"],
    [mk(-6, "Losers Round 4", 54, 1), "L.T24"],
    // final phase: names are event-true
    [mk(1, "Winners Quarter-Final", 16, 2), "WQF"],
    [mk(4, "Grand Final", 16, 2), "GF"],
    [mk(-3, "Losers Round 1", 16, 2), "L.T16"],
    [mk(-4, "Losers Round 2", 16, 2), "L.T12"],
    [mk(-5, "Losers Round 3", 16, 2), "L.T8"],
    [mk(-6, "Losers Quarter-Final", 16, 2), "LQF"],
    [mk(-8, "Losers Final", 16, 2), "LF"],
    // round robin
    [mk(3, "Round 3", 8, 1, "ROUND_ROBIN"), "RR"],
    // single-phase fallback with no phase info
    [
      { round: -12, fullRoundText: "Losers Round 10", phaseGroup: null },
      "L.T3",
    ],
  ];
  for (const [set, want] of cases) {
    it(`${set.fullRoundText} (round ${set.round}) -> ${want}`, () => {
      assert.equal(core.formatRound(set, info), want);
    });
  }
});

describe("selectStreamSet", () => {
  it("queue 0th wins even when the station has the NEXT set pre-assigned", () => {
    const picked = core.selectStreamSet({
      queues: [
        {
          stream: { streamName: "nycmelee" },
          sets: [
            { id: "CURRENT", event: { id: 1 } },
            { id: "NEXT", event: { id: 1 } },
          ],
        },
      ],
      onStreamNodes: [
        { id: "NEXT", state: 6, stream: { streamName: "nycmelee" } },
      ],
      eventId: 1,
      wantedStream: "",
    });
    assert.equal(picked.id, "CURRENT");
  });
  it("skips a queue whose 0th set belongs to another event", () => {
    const picked = core.selectStreamSet({
      queues: [
        {
          stream: { streamName: "nycmelee" },
          sets: [
            { id: "OTHER", event: { id: 99 } },
            { id: "OURS", event: { id: 1 } },
          ],
        },
      ],
      onStreamNodes: [
        { id: "STATION", state: 2, stream: { streamName: "nycmelee" } },
      ],
      eventId: 1,
      wantedStream: "",
    });
    assert.equal(picked.id, "STATION");
  });
  it("station fallback prefers in-progress over pre-assigned", () => {
    const picked = core.selectStreamSet({
      queues: [],
      onStreamNodes: [
        { id: "NEXT", state: 1, stream: { streamName: "nycmelee" } },
        { id: "CURRENT", state: 2, stream: { streamName: "nycmelee" } },
      ],
      eventId: 1,
      wantedStream: "",
    });
    assert.equal(picked.id, "CURRENT");
  });
  it("wantedStream filters both signals", () => {
    const picked = core.selectStreamSet({
      queues: [
        {
          stream: { streamName: "other" },
          sets: [{ id: "X", event: { id: 1 } }],
        },
      ],
      onStreamNodes: [
        { id: "S2", state: 2, stream: { streamName: "nycmelee" } },
      ],
      eventId: 1,
      wantedStream: "nycmelee",
    });
    assert.equal(picked.id, "S2");
  });
  it("returns null when nothing is on stream", () => {
    assert.equal(
      core.selectStreamSet({
        queues: [],
        onStreamNodes: [],
        eventId: 1,
        wantedStream: "",
      }),
      null
    );
  });
});

describe("collectWalkPage", () => {
  const singles = (id, winnerPid, pidA, pidB, extra = {}) => ({
    id,
    winnerId: 10,
    displayScore: "A 3 - B 1",
    completedAt: 1700000000,
    event: { videogame: { id: 1 } },
    slots: [
      { entrant: { id: 10, participants: [{ player: { id: pidA } }] } },
      { entrant: { id: 20, participants: [{ player: { id: pidB } }] } },
    ],
    ...extra,
  });
  it("keeps a completed singles melee set as a tuple", () => {
    const fresh = [];
    core.collectWalkPage([singles("s1", 1, 1, 2)], new Set(), fresh);
    assert.deepEqual(fresh, [["s1", 1700000000, 1, 1, 2]]);
  });
  it("drops doubles, DQs, other games, and unfinished sets", () => {
    const fresh = [];
    const doubles = singles("d1", 1, 1, 2);
    doubles.slots[0].entrant.participants.push({ player: { id: 99 } });
    core.collectWalkPage(
      [
        doubles,
        singles("dq", 1, 1, 2, { displayScore: "A DQ - B" }),
        singles("ult", 1, 1, 2, { event: { videogame: { id: 1386 } } }),
        singles("wip", 1, 1, 2, { completedAt: null }),
      ],
      new Set(),
      fresh
    );
    assert.deepEqual(fresh, []);
  });
  it("reports when it reaches an already-cached set", () => {
    const res = core.collectWalkPage(
      [singles("known", 1, 1, 2)],
      new Set(["known"]),
      []
    );
    assert.equal(res.hitKnown, true);
  });
});

describe("fetchWalkPage complexity fallback", () => {
  it("splits a page into two half-size pages on a complexity error", async () => {
    const calls = [];
    const gql = async (query, vars) => {
      calls.push(vars);
      if (calls.length === 1)
        throw new Error("Your query complexity is too high (actual: 1056)");
      return { player: { sets: { nodes: [{ id: "n" + vars.page }] } } };
    };
    const nodes = await core.fetchWalkPage(gql, 4748, 8);
    assert.deepEqual(calls, [
      { pid: 4748, page: 8 },
      { pid: 4748, page: 15 },
      { pid: 4748, page: 16 },
    ]);
    assert.deepEqual(
      nodes.map((n) => n.id),
      ["n15", "n16"]
    );
  });
  it("rethrows non-complexity errors", async () => {
    const gql = async () => {
      throw new Error("Rate limit exceeded");
    };
    await assert.rejects(core.fetchWalkPage(gql, 1, 1), /Rate limit/);
  });
});

describe("walkPlayerSets incremental cache", () => {
  const tuple = (id, date) => [id, date, 1, 1, 2];
  const node = (id, date) => ({
    id,
    winnerId: 10,
    displayScore: "A 3 - B 0",
    completedAt: date,
    event: { videogame: { id: 1 } },
    slots: [
      { entrant: { id: 10, participants: [{ player: { id: 1 } }] } },
      { entrant: { id: 20, participants: [{ player: { id: 2 } }] } },
    ],
  });
  it("warm walk stops at the first cached set and merges", async () => {
    const gqlCalls = [];
    let saved = null;
    const deps = {
      gql: async (q, vars) => {
        gqlCalls.push(vars.page);
        return {
          player: { sets: { nodes: [node("new1", 200), node("old1", 100)] } },
        };
      },
      loadHistory: () => ({ complete: true, sets: [tuple("old1", 100)] }),
      saveHistory: (id, h) => (saved = h),
    };
    const history = await core.walkPlayerSets(deps, 1);
    assert.deepEqual(gqlCalls, [1]); // stopped after one page
    assert.equal(history.complete, true);
    assert.deepEqual(
      history.sets.map((s) => s[0]),
      ["new1", "old1"]
    );
    assert.ok(saved);
  });
  it("cold walk marks capped histories incomplete", async () => {
    const deps = {
      gql: async () => ({ player: { sets: { nodes: [] } } }),
      loadHistory: () => null,
      saveHistory: () => {},
    };
    const capped = await core.walkPlayerSets(
      deps,
      1,
      core.H2H_PAGE_SIZE * core.H2H_MAX_PAGES + 1
    );
    assert.equal(capped.complete, false);
    const small = await core.walkPlayerSets(deps, 1, 10);
    assert.equal(small.complete, true);
  });
});

describe("pairDataForOpponent", () => {
  it("filters to the opponent and counts the record", () => {
    const history = [
      ["s3", 300, 7, 7, 8], // vs opponent 8, won by 7
      ["s2", 200, 9, 7, 9], // vs someone else
      ["s1", 100, 8, 8, 7], // vs opponent 8, won by 8
    ];
    const { pairSets, record } = core.pairDataForOpponent(history, 8);
    assert.deepEqual(
      pairSets.map((s) => s.setId),
      ["s3", "s1"]
    );
    assert.deepEqual(record, { 7: 1, 8: 1 });
  });
});

describe("setSignature", () => {
  it("captures id and scores", () => {
    assert.equal(
      core.setSignature({
        id: 5,
        slots: [
          { standing: { stats: { score: { value: 3 } } } },
          { standing: { stats: { score: { value: null } } } },
        ],
      }),
      "5:3--"
    );
  });
});

describe("escapeHtml", () => {
  it("escapes markup in player tags", () => {
    assert.equal(
      core.escapeHtml('<b>&"x"</b>'),
      "&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;"
    );
  });
});

// ---- parry.gg ----------------------------------------------------------
// Round-label cases come from parry.gg's Altitude Sickness 3 Melee Singles:
// 235 entrants -> 8 pools -> Top 32 -> Top 8.

describe("parry.gg URL parsing", () => {
  it("detects parry.gg links", () => {
    assert.equal(core.isParryUrl("https://parry.gg/as3/melee-singles"), true);
    assert.equal(
      core.isParryUrl("https://www.start.gg/tournament/foo/event/bar"),
      false
    );
  });
  it("takes tournament and event from event, phase, and bracket links", () => {
    const want = { tournamentSlug: "as3", eventSlug: "melee-singles" };
    assert.deepEqual(
      core.extractParrySlugs("https://parry.gg/as3/melee-singles"),
      want
    );
    assert.deepEqual(
      core.extractParrySlugs("https://parry.gg/as3/melee-singles/top-8/bracket?x=1"),
      want
    );
  });
  it("rejects a tournament page without an event", () => {
    assert.equal(core.extractParrySlugs("https://parry.gg/as3"), null);
  });
});

describe("protobuf / gRPC-web codec", () => {
  it("round-trips nested messages, strings, varints, and doubles", () => {
    // pbEncode only writes varints/strings/messages; decode a hand-built
    // double alongside them.
    const msg = core.pbEncode([
      [1, "abc"],
      [2, [[1, 300], [2, "é"]]],
      [2, [[1, 1778362527]]],
    ]);
    const dbl = new Uint8Array(9);
    dbl[0] = (3 << 3) | 1;
    new DataView(dbl.buffer).setFloat64(1, 2.5, true);
    const bytes = new Uint8Array([...msg, ...dbl, 0x20, 0x07]); // + unknown field 4
    const out = core.pbDecode(bytes, {
      1: ["name", "string"],
      2: ["items", { 1: ["n", "varint"], 2: ["s", "string"] }, true],
      3: ["score", "double"],
    });
    assert.deepEqual(out, {
      name: "abc",
      items: [{ n: 300, s: "é" }, { n: 1778362527 }],
      score: 2.5,
    });
  });
  it("frames a request and parses data + trailer frames", () => {
    const payload = core.pbEncode([[1, "x"]]);
    const framed = core.grpcWebFrame(payload);
    assert.deepEqual([...framed.subarray(0, 5)], [0, 0, 0, 0, payload.length]);
    const trailer = new TextEncoder().encode(
      "grpc-status:3\r\ngrpc-message:bad%20slug\r\n"
    );
    const body = new Uint8Array([
      ...framed,
      0x80, 0, 0, 0, trailer.length,
      ...trailer,
    ]);
    const res = core.parseGrpcWebResponse(body);
    assert.deepEqual([...res.payload], [...payload]);
    assert.equal(res.status, "3");
    assert.equal(res.message, "bad%20slug");
  });
});

describe("parry.gg -> start.gg set conversion", () => {
  const event = {
    id: "ev",
    slug: "melee-singles",
    entrantCount: 235,
    phases: [
      { id: "pools", bracketType: 2, numBrackets: 8, numEntrants: 235 },
      { id: "t32", bracketType: 2, numBrackets: 1, numEntrants: 32 },
      { id: "t8", bracketType: 2, numBrackets: 1, numEntrants: 8 },
    ],
  };
  const info = core.parryEventInfo(event);
  const tInfo = { entrantsCount: 235, bracketSize: 256, maxPhaseOrder: 3 };

  const ctx = (phaseId, match, label, slots) => ({
    match: { id: "m", ...match, slots: slots || [] },
    round: { label },
    hierarchy: { paths: [{ id: phaseId, type: 2 }, { id: "ev", type: 1 }] },
    seeds: [],
  });

  it("resolves the event and orders its phases", () => {
    assert.equal(info.id, "ev");
    assert.deepEqual(
      info.phases.map((p) => [p.phaseOrder, p.numSeeds, p.numBrackets]),
      [[1, 235, 8], [2, 32, 1], [3, 8, 1]]
    );
    assert.equal(core.parryEventInfo(undefined), null);
  });

  const cases = [
    ["pools", { round: 1, winnersSide: 1 }, "Winners Round 1", "W.T256"],
    ["pools", { round: 1, losersPlacement: 25 }, "Losers Round 1", "L.T256"],
    ["t32", { round: 1, winnersSide: 1 }, "Winners Round 1", "W.T32"],
    ["t32", { round: 1, losersPlacement: 25 }, "Losers Round 1", "L.T32"],
    ["t32", { round: 4, losersPlacement: 9 }, "Losers Round 4", "L.T12"],
    ["t8", { round: 1, losersPlacement: 7 }, "Losers Round 1", "L.T8"],
    ["t8", { round: 4, losersPlacement: 3 }, "Losers Final", "LF"],
    ["t8", { round: 3, winnersSide: 1, grandFinals: 1 }, "Grand Final", "GF"],
  ];
  for (const [phase, match, label, want] of cases) {
    it(`${phase} ${label} -> ${want}`, () => {
      const set = core.parryMatchToSet(ctx(phase, match, label), info);
      assert.equal(core.formatRound(set, tInfo), want);
    });
  }

  it("maps names, seeds, scores, and DQs onto start.gg slots", () => {
    const c = ctx("t8", { round: 1, losersPlacement: 7 }, "Losers Round 1", [
      { slot: 1, seedId: "b", state: 3 }, // DQ
      { seedId: "a", score: 2, state: 2 },
    ]);
    c.seeds = [
      { id: "a", seed: 4, eventEntrant: { id: "ea", name: "Team Name" } },
      {
        id: "b",
        seed: 9,
        eventEntrant: {
          id: "eb",
          entrant: { users: [{ gamerTag: "Zamu" }, { gamerTag: "Jmook" }] },
        },
      },
    ];
    const set = core.parryMatchToSet(c, info);
    assert.deepEqual(
      set.slots.map((s) => [
        s.entrant.id,
        s.entrant.name,
        s.seed.seedNum,
        s.standing.stats.score.value,
      ]),
      [
        ["ea", "Team Name", 4, 2],
        ["eb", "Zamu / Jmook", 9, -1],
      ]
    );
  });

  it("drops byes and returns the most recently finished first", () => {
    const m = (id, seconds, slots) => ({
      match: { id, endedAt: { seconds }, slots },
      hierarchy: { paths: [] },
      seeds: [],
    });
    const two = [{ seedId: "a" }, { slot: 1, seedId: "b" }];
    const sets = core.parryRecentSets(
      [
        m("old", 100, two),
        m("bye", 300, [{ seedId: "a" }, { slot: 1, seedId: "b", state: 4 }]),
        m("new", 200, two),
        m("empty", 400, [{ seedId: "a" }, { slot: 1 }]),
      ],
      info,
      5
    );
    assert.deepEqual(sets.map((s) => s.id), ["new", "old"]);
  });
});
