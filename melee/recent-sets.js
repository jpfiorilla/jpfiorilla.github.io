const API_URL = "https://api.start.gg/gql/alpha";
let pollingInterval;
let activeSlug = null;
let setsOffset = 0; // debug: how far past the most recent set to scroll
let currentView = "recent"; // "recent" | "history"
const debugState = { fetchCount: 0, lastFetch: "—", lastResult: "—" };

const params = new URLSearchParams(window.location.search);

// ?reset=1 clears saved config and shows the form — the escape hatch
// for a bad saved token, since OBS storage is hard to clear by hand.
if (params.has("reset")) {
  localStorage.removeItem("startggToken");
  localStorage.removeItem("startggEventUrl");
  // Also drop cached player set histories.
  Object.keys(localStorage)
    .filter((k) => k.startsWith("h2hSets:"))
    .forEach((k) => localStorage.removeItem(k));
}

let authToken =
  params.get("token") ||
  params.get("t") ||
  window.STARTGG_TOKEN ||
  localStorage.getItem("startggToken") ||
  "";

if (authToken) document.getElementById("tokenInput").value = authToken;

let eventUrl =
  params.get("url") ||
  params.get("u") ||
  window.STARTGG_URL ||
  localStorage.getItem("startggEventUrl") ||
  "";

if (eventUrl) document.getElementById("urlInput").value = eventUrl;

// Optional starting view: ?view=history (default is recent results).
// Match history for the featured set still has to load after startup, so
// the view shows its placeholder until the background prefetch lands.
if (params.get("view") === "history") currentView = "history";

document
  .getElementById("configPanel")
  .addEventListener("submit", startOverlay);

async function fetchData(slug) {
  const query = `
    query EventSetsAndEntrants($slug: String!, $tourneySlug: String!) {
      tournament(slug: $tourneySlug) {
        streamQueue {
          stream { streamName }
          sets { id event { id } }
        }
      }
      event(slug: $slug) {
        id
        numEntrants
        phases { phaseOrder }
        onStream: sets(
          page: 1
          perPage: 24
          filters: { state: [1, 2, 6] }
        ) {
          nodes {
            id
            state
            stream { streamName }
          }
        }
        sets(perPage: ${Math.min(setsOffset + 5, 50)}, page: 1, sortType: RECENT) {
          nodes {
            id
            round
            fullRoundText
            phaseGroup {
              bracketType
              phase { numSeeds phaseOrder }
            }
            slots {
              entrant { id name }
              seed { seedNum }
              standing { stats { score { value } } }
            }
          }
        }
      }
    }
  `;
  debugState.fetchCount++;
  debugState.lastFetch = new Date().toLocaleTimeString();
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + authToken,
      },
      body: JSON.stringify({
        query,
        // "tournament/<t>/event/<e>" → tournament slug "<t>"
        variables: { slug, tourneySlug: slug.split("/")[1] },
      }),
    });
    const json = await res.json();

    if (!json.data || json.errors || json.success === false) {
      const message =
        json.message || json.errors?.[0]?.message || "Unexpected response";
      console.error("Error fetching data: ", message, json);
      debugState.lastResult = `error: ${message}`;
      return { error: true, message: `Start.gg error: ${message}` };
    }

    // A parseable but nonexistent event comes back as data.event: null
    // with no errors — don't let that pass verification.
    if (!json.data.event) {
      debugState.lastResult = "error: event not found";
      return {
        error: true,
        message: "Start.gg error: event not found — double-check the URL.",
      };
    }

    const sets = json.data.event.sets?.nodes || [];
    debugState.lastResult = `ok (${sets.length} sets)`;

    // The set currently on stream. NYC Melee's TO assigns sets to the
    // stream STATION, which populates set.stream on active sets (verified
    // against stock-exchange-62: every streamed set had stream.streamName
    // while tournament.streamQueue stayed null). Primary signal: an active
    // (state 1 created / 2 started / 6 called — never 3 completed) set
    // with a stream. Secondary: the documented stream queue, for TOs who
    // use it. ?stream=name narrows both on multi-stream tournaments.
    const wantedStream = (params.get("stream") || "").toLowerCase();
    const matchesWanted = (name) =>
      !wantedStream || (name || "").toLowerCase() === wantedStream;

    const active = (json.data.event.onStream?.nodes || []).filter(
      (s) => s?.stream && matchesWanted(s.stream.streamName)
    );
    // in progress beats called beats created
    const stateRank = { 2: 0, 6: 1, 1: 2 };
    active.sort((a, b) => (stateRank[a.state] ?? 3) - (stateRank[b.state] ?? 3));
    let streamSet = active[0] || null;

    if (!streamSet) {
      const eventId = json.data.event.id;
      const queues = json.data.tournament?.streamQueue || [];
      const queue =
        queues.find((q) => matchesWanted(q?.stream?.streamName)) || queues[0];
      streamSet =
        (queue?.sets || []).find((s) => s?.event?.id === eventId) || null;
    }

    return {
      sets,
      streamSetId: streamSet ? String(streamSet.id) : null,
      numEntrants: json.data.event.numEntrants || 0,
      maxPhaseOrder: Math.max(
        0,
        ...(json.data.event.phases || []).map((p) => p?.phaseOrder || 0)
      ),
    };
  } catch (err) {
    console.error("Network error fetching data: ", err);
    debugState.lastResult = `network error: ${err.message}`;
    return {
      error: true,
      network: true,
      message: "Network error contacting Start.gg.",
    };
  }
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

function extractPlayerTag(entrantName) {
  if (!entrantName) return "TBD";

  // Split by | and take the last part (the tag)
  const parts = entrantName.split("|");
  return parts[parts.length - 1].trim();
}

function pow2Ceil(n) {
  return n >= 2 ? 1 << Math.ceil(Math.log2(n)) : 0;
}

// "Top N" values for losers rounds counting back from Losers Final:
// LF=3, LSF=4, then 6, 8, 12, 16, 24, 32, 48, 64, 96, 128 …
const LOSERS_TOP = [
  3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512,
];

function formatRound(set) {
  if (!set) return "VS";
  if (set.phaseGroup?.bracketType === "ROUND_ROBIN") return "RR";

  const txt = (set.fullRoundText || "").toLowerCase();
  if (txt.includes("grand final")) return "GF";

  // Named rounds are only event-true in the FINAL phase — a qualifier
  // phase reuses names like "Winners Quarter-Final" for its own last
  // rounds, where the event-true label is a Top-N number.
  const phase = set.phaseGroup?.phase;
  const isFinalPhase =
    phase?.phaseOrder == null ||
    phase.phaseOrder === tournamentInfo.maxPhaseOrder;

  if (isFinalPhase) {
    if (txt.includes("losers final")) return "LF";
    if (txt.includes("winners final")) return "WF";
    if (txt.includes("winners semi")) return "WSF";
    if (txt.includes("losers semi")) return "LSF";
    if (txt.includes("winners quarter")) return "WQF";
    if (txt.includes("losers quarter")) return "LQF";
  }

  // Everything else: treat the event as one double-elim bracket and
  // label rounds by players remaining, supermajor.gg-style. start.gg
  // numbers losers rounds so |round| = 2*log2(bracketSize) at Losers
  // Final, which makes one formula correct for qualifier and final
  // phases alike.
  const P = pow2Ceil(phase?.numSeeds) || tournamentInfo.bracketSize;
  const r = set.round;
  if (typeof r === "number" && P >= 4) {
    if (r > 0) {
      const top = P / Math.pow(2, r - 1);
      if (top >= 2) return `W.T${top}`;
    } else if (r < 0) {
      const dist = 2 * Math.log2(P) - Math.abs(r);
      if (LOSERS_TOP[dist]) return `L.T${LOSERS_TOP[dist]}`;
    }
  }

  return "VS";
}

// A short string capturing everything we render for a set, so a poll
// that changed nothing can skip re-rendering entirely.
function setSignature(set) {
  const scores = set.slots.map(
    (s) => s?.standing?.stats?.score?.value ?? "-"
  );
  return `${set.id}:${scores.join("-")}`;
}

function buildSetHtml(set) {
  // Show the better-seeded player (seed 1 is best) on the left.
  let [p1, p2] = set.slots;
  const p1Seed = p1?.seed?.seedNum;
  const p2Seed = p2?.seed?.seedNum;
  if (p1Seed != null && p2Seed != null && p2Seed < p1Seed) {
    [p1, p2] = [p2, p1];
  }
  let p1Score = parseInt(p1?.standing?.stats?.score?.value ?? "-");
  let p2Score = parseInt(p2?.standing?.stats?.score?.value ?? "-");

  // Handle DQ logic
  if (p1Score === -1) {
    p1Score = "DQ";
    p2Score = "W";
  } else if (p2Score === -1) {
    p2Score = "DQ";
    p1Score = "W";
  }

  const p1ScoreClass = `score${
    p1Score === "W" || p1Score > p2Score ? " winner" : ""
  }`;
  const p2ScoreClass = `score${
    p2Score === "W" || p2Score > p1Score ? " winner" : ""
  }`;

  // Unreported scores (in-progress or unstarted sets) parse to NaN —
  // show a dash instead.
  const displayScore = (s) => (Number.isNaN(s) ? "–" : s);

  return `
      <div class="${p1ScoreClass}">${displayScore(p1Score)}</div>
      <div class="player-name left">
        <span>${escapeHtml(extractPlayerTag(p1?.entrant?.name))}</span>
      </div>
      <div class="vs mono">${formatRound(set)}</div>
      <div class="player-name right">
        <span>${escapeHtml(extractPlayerTag(p2?.entrant?.name))}</span>
      </div>
      <div class="${p2ScoreClass}">${displayScore(p2Score)}</div>
      <div class="set-background"></div>
    `;
}

let hasRenderedOnce = false;
let lastSignature = "";
function renderSets(sets) {
  const top = sets.slice(setsOffset, setsOffset + 4);
  const signature = top.map(setSignature).join("|");
  if (signature === lastSignature) return; // nothing changed since last poll
  lastSignature = signature;

  if (top.length > 0) {
    document.getElementById("waitingMessage").style.display = "none";
  }

  const container = document.getElementById("setsContainer");
  const newIds = top.map((s) => String(s.id));
  const existingIds = new Set(
    Array.from(container.querySelectorAll(".set")).map(
      (el) => el.dataset.id
    )
  );

  // Remove cards for sets no longer in the recent list.
  container.querySelectorAll(".set").forEach((el) => {
    if (!newIds.includes(el.dataset.id)) el.remove();
  });

  // Add or update a card for each current set.
  top.forEach((set) => {
    const id = String(set.id);
    const sig = setSignature(set);
    let div = container.querySelector(`.set[data-id="${id}"]`);

    if (!div) {
      div = document.createElement("div");
      div.className = "set";
      div.dataset.id = id;
      div.innerHTML = buildSetHtml(set);
      // Slide genuinely-new sets in, but don't animate the first paint.
      if (hasRenderedOnce && !existingIds.has(id)) {
        div.classList.add("new");
        setTimeout(() => div.classList.remove("new"), 600);
      }
      container.appendChild(div);
    } else if (div.dataset.sig !== sig) {
      // Score (or other content) changed — update in place.
      div.innerHTML = buildSetHtml(set);
    }
    div.dataset.sig = sig;
  });

  // Keep DOM order matching the most-recent-first order from the API.
  newIds.forEach((id) => {
    const el = container.querySelector(`.set[data-id="${id}"]`);
    if (el) container.appendChild(el);
  });

  hasRenderedOnce = true;
}

function extractSlugFromUrl(url) {
  const match = url.match(
    /start\.gg\/tournament\/([^\/]+)\/event\/([^\/]+)/
  );
  return match ? `tournament/${match[1]}/event/${match[2]}` : null;
}

let tournamentInfo = { entrantsCount: 0 };

function buildTournamentInfo(numEntrants, maxPhaseOrder) {
  tournamentInfo = {
    entrantsCount: numEntrants,
    bracketSize: pow2Ceil(numEntrants),
    maxPhaseOrder,
  };
}

function showConfigError(msg) {
  const el = document.getElementById("configError");
  el.textContent = msg;
  el.style.display = "block";
}

function clearConfigError() {
  const el = document.getElementById("configError");
  el.textContent = "";
  el.style.display = "none";
}

function setOverlayVisible(visible) {
  const display = visible ? "block" : "none";
  document.querySelector(".header").style.display = display;
  document.querySelector(".footer").style.display = display;
  if (visible) {
    setView(currentView); // shows the right container for the view
  } else {
    document.getElementById("setsContainer").style.display = "none";
    document.getElementById("matchHistoryContainer").style.display =
      "none";
  }
}

// Which set Match History is about: the set assigned to the stream via
// the tournament's stream queue, or — for events without one — the most
// recently completed set.
let h2hTargetSetId = null;
let h2hTargetSource = "—";
let lastTargetSetId = null;

function applyFetchResult(result) {
  latestSets = result.sets;
  buildTournamentInfo(result.numEntrants, result.maxPhaseOrder);
  renderSets(result.sets);

  h2hTargetSetId =
    result.streamSetId ||
    (latestSets[0] ? String(latestSets[0].id) : null);
  h2hTargetSource = result.streamSetId
    ? "on stream"
    : "latest completed set";

  if (h2hTargetSetId !== lastTargetSetId) {
    // A new set just went on stream — its match history isn't loaded
    // yet, so never linger on the history view. The first fetch after
    // startup isn't a set change (it must not override ?view=history).
    const isFirstFetch = lastTargetSetId === null;
    lastTargetSetId = h2hTargetSetId;
    if (!isFirstFetch && currentView === "history") setViewAnimated("recent");
  }
  prefetchMatchHistory();
  renderDebugPanel();
}

// --- Match history (head-to-head) data --------------------------
// start.gg has no dedicated H2H API; see fetchAllPairSets for the
// full-history walk that computes the true all-time record.

const MELEE_VIDEOGAME_ID = 1;
let latestSets = [];

async function gql(query, variables) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + authToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!json.data || json.errors) {
    throw new Error(
      json.errors?.[0]?.message || json.message || "start.gg error"
    );
  }
  return json.data;
}

// The (player.id, user.id) pair for each slot of a set — the main
// polling query stays lean, so these are fetched on demand.
async function fetchSetPlayers(setId) {
  const data = await gql(
    `query SetPlayers($id: ID!) {
      set(id: $id) {
        slots {
          seed { seedNum }
          entrant {
            name
            participants { player { id } }
          }
        }
      }
    }`,
    { id: setId }
  );
  return (data.set?.slots || []).map((slot) => {
    const part = slot?.entrant?.participants?.[0];
    return {
      name: extractPlayerTag(slot?.entrant?.name),
      playerId: part?.player?.id ?? null,
      seedNum: slot?.seed?.seedNum ?? null,
    };
  });
}

// Full head-to-head record. start.gg has no working opponent filter
// (SetFilters.playerIds is ignored on Player.sets and OR-semantics on
// Event.sets), and event-list sampling misses old sets — so the
// reliable approach is to walk the ENTIRE set history of one player
// (slim fields, batched pages) and keep the sets where the other
// player fills the opposite slot. Validated against supermajor.gg.
const H2H_PAGE_SIZE = 85; // ~940 objects/request; the cap is 1000
const H2H_MAX_PAGES = 60; // 5100 sets — beyond any realistic rivalry
const H2H_BATCH = 4; // concurrent page requests per round

// Walked histories are expensive, so each player's completed sets are
// persisted in localStorage as [setId, dateSec, winnerPid, pidA, pidB]
// tuples. player.sets pages newest-first, so a later walk stops as
// soon as it reaches a set the (complete) cache already contains —
// one week's new sets cost ~one request.
const H2H_CACHE_PREFIX = "h2hSets:";
const H2H_CACHE_VERSION = 1;

function loadPlayerHistory(playerId) {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(H2H_CACHE_PREFIX + playerId)
    );
    return parsed?.v === H2H_CACHE_VERSION ? parsed : null;
  } catch (err) {
    return null;
  }
}

function savePlayerHistory(playerId, history) {
  const write = () =>
    localStorage.setItem(
      H2H_CACHE_PREFIX + playerId,
      JSON.stringify(history)
    );
  try {
    write();
  } catch (err) {
    // Quota exceeded — evict least-recently-updated histories. The
    // cache is only an optimization, so give up quietly if that fails.
    try {
      const entries = Object.keys(localStorage)
        .filter((k) => k.startsWith(H2H_CACHE_PREFIX))
        .map((k) => {
          try {
            return { k, at: JSON.parse(localStorage.getItem(k)).updatedAt || 0 };
          } catch (e) {
            return { k, at: 0 };
          }
        })
        .sort((a, b) => a.at - b.at);
      for (const e of entries) {
        localStorage.removeItem(e.k);
        try {
          write();
          return;
        } catch (e) {}
      }
    } catch (e) {}
  }
}

const H2H_WALK_QUERY = `
  query PairWalk($pid: ID!, $page: Int!) {
    player(id: $pid) {
      sets(page: $page, perPage: ${H2H_PAGE_SIZE}) {
        nodes {
          id
          winnerId
          displayScore
          completedAt
          event { videogame { id } }
          slots { entrant { id participants { player { id } } } }
        }
      }
    }
  }`;

// Turns one page of walk results into cache tuples. Keeps every
// completed singles Melee set (any opponent — the cache serves all
// future pairs involving this player); skips DQs and doubles.
function collectWalkPage(data, cachedIds, fresh) {
  const nodes = data.player?.sets?.nodes || [];
  let hitKnown = false;
  for (const s of nodes) {
    if (cachedIds.has(String(s.id))) {
      hitKnown = true;
      continue;
    }
    if (!s.winnerId || !s.completedAt) continue; // unfinished
    if (s.event?.videogame?.id !== MELEE_VIDEOGAME_ID) continue;
    const slots = s.slots || [];
    // Singles only — doubles slots have two participants.
    if (
      slots.some((sl) => (sl?.entrant?.participants || []).length !== 1)
    )
      continue;
    const ids = slots.map(
      (sl) => sl?.entrant?.participants?.[0]?.player?.id
    );
    if (ids.length !== 2 || ids[0] == null || ids[1] == null) continue;
    if (ids[0] === ids[1]) continue;
    if ((s.displayScore || "").includes("DQ")) continue;
    const winnerSlot = slots.find((sl) => sl?.entrant?.id === s.winnerId);
    const winnerPid = winnerSlot?.entrant?.participants?.[0]?.player?.id;
    if (winnerPid == null) continue;
    fresh.push([String(s.id), s.completedAt, winnerPid, ids[0], ids[1]]);
  }
  return { pageSize: nodes.length, hitKnown };
}

// Full walk of one player's set history, incremental against the
// localStorage cache. Returns { complete, sets } (tuples, newest
// first). `knownTotal` skips the totals lookup when already known.
async function walkPlayerSets(playerId, knownTotal) {
  const cached = loadPlayerHistory(playerId) || {
    complete: false,
    sets: [],
  };
  const cachedIds = new Set(cached.sets.map((s) => s[0]));
  const fresh = [];
  let complete;

  if (cached.complete && cachedIds.size > 0) {
    // Warm: page forward only until we reach already-cached sets.
    let reachedEnd = false;
    let hitKnown = false;
    for (let page = 1; page <= H2H_MAX_PAGES && !hitKnown; page++) {
      const res = collectWalkPage(
        await gql(H2H_WALK_QUERY, { pid: playerId, page }),
        cachedIds,
        fresh
      );
      hitKnown = res.hitKnown;
      if (res.pageSize < H2H_PAGE_SIZE) {
        reachedEnd = true;
        break;
      }
    }
    complete = hitKnown || reachedEnd;
  } else {
    // Cold: total pages known up front, fetched in batches.
    const total =
      knownTotal ??
      (
        await gql(
          `query Total($p: ID!) {
            player(id: $p) { sets(page: 1, perPage: 1) { pageInfo { total } } }
          }`,
          { p: playerId }
        )
      ).player?.sets?.pageInfo?.total ??
      0;
    const pages = Math.ceil(total / H2H_PAGE_SIZE);
    complete = pages <= H2H_MAX_PAGES;
    const capped = Math.min(pages, H2H_MAX_PAGES);
    for (let start = 1; start <= capped; start += H2H_BATCH) {
      const batch = [];
      for (let p = start; p < start + H2H_BATCH && p <= capped; p++)
        batch.push(p);
      const responses = await Promise.all(
        batch.map((page) =>
          gql(H2H_WALK_QUERY, { pid: playerId, page })
        )
      );
      responses.forEach((data) =>
        collectWalkPage(data, cachedIds, fresh)
      );
    }
  }

  const freshIds = new Set(fresh.map((s) => s[0]));
  const merged = fresh.concat(
    cached.sets.filter((s) => !freshIds.has(s[0]))
  );
  merged.sort((a, b) => b[1] - a[1]);
  const history = {
    v: H2H_CACHE_VERSION,
    complete,
    updatedAt: Date.now(),
    sets: merged,
  };
  savePlayerHistory(playerId, history);
  return history;
}

// All completed singles Melee sets between the two players, newest
// first, as {setId, date, winnerPlayerId} — plus the win record.
// Every call re-checks page 1 (cheap when warm), so a rematch that
// just finished is always included.
async function fetchAllPairSets(p1, p2) {
  // Prefer a player whose complete history is already cached — the
  // incremental walk is ~1 request regardless of how many sets they
  // have. Otherwise walk whoever has fewer total sets.
  const c1 = loadPlayerHistory(p1.playerId);
  const c2 = loadPlayerHistory(p2.playerId);
  let walkId;
  let knownTotal;
  if (c1?.complete && !c2?.complete) walkId = p1.playerId;
  else if (c2?.complete && !c1?.complete) walkId = p2.playerId;
  else if (c1?.complete && c2?.complete) {
    walkId =
      c1.sets.length <= c2.sets.length ? p1.playerId : p2.playerId;
  } else {
    const totals = await gql(
      `query Totals($a: ID!, $b: ID!) {
        a: player(id: $a) { sets(page: 1, perPage: 1) { pageInfo { total } } }
        b: player(id: $b) { sets(page: 1, perPage: 1) { pageInfo { total } } }
      }`,
      { a: p1.playerId, b: p2.playerId }
    );
    const totalA = totals.a?.sets?.pageInfo?.total ?? 0;
    const totalB = totals.b?.sets?.pageInfo?.total ?? 0;
    walkId = totalA <= totalB ? p1.playerId : p2.playerId;
    knownTotal = Math.min(totalA, totalB);
  }

  const history = await walkPlayerSets(walkId, knownTotal);
  const otherId =
    walkId === p1.playerId ? p2.playerId : p1.playerId;
  const pairSets = history.sets
    .filter((s) => s[3] === otherId || s[4] === otherId)
    .map((s) => ({
      setId: s[0],
      date: s[1] * 1000,
      winnerPlayerId: s[2],
    }));
  const record = {};
  pairSets.forEach((s) => {
    record[s.winnerPlayerId] = (record[s.winnerPlayerId] || 0) + 1;
  });
  return { pairSets, record };
}

// Display details (round, tournament name/logo, scores) for specific
// sets, fetched in one aliased request.
async function fetchSetDetails(setIds) {
  if (!setIds.length) return [];
  const varDefs = setIds.map((_, i) => `$i${i}: ID!`).join(", ");
  const body = setIds
    .map(
      (_, i) => `s${i}: set(id: $i${i}) {
        id
        completedAt
        winnerId
        fullRoundText
        event {
          startAt
          tournament { name images(type: "profile") { url } }
        }
        slots {
          entrant { id name participants { player { id } } }
          standing { stats { score { value } } }
        }
      }`
    )
    .join("\n");
  const data = await gql(
    `query SetDetails(${varDefs}) { ${body} }`,
    Object.fromEntries(setIds.map((id, i) => [`i${i}`, id]))
  );
  return setIds
    .map((_, i) => data[`s${i}`])
    .filter(Boolean)
    .map((s) => ({
      setId: String(s.id),
      date: (s.completedAt || s.event?.startAt) * 1000,
      tournament: s.event?.tournament?.name || "",
      logoUrl: s.event?.tournament?.images?.[0]?.url || null,
      round: s.fullRoundText,
      players: (s.slots || []).map((sl) => ({
        name: extractPlayerTag(sl?.entrant?.name),
        playerId: sl?.entrant?.participants?.[0]?.player?.id ?? null,
        score: parseInt(sl?.standing?.stats?.score?.value ?? "-"),
        won: s.winnerId === sl?.entrant?.id,
      })),
    }));
}

// The record counts every completed set (including the featured one,
// matching supermajor.gg); the rendered rows are the last `limit`
// meetings BEFORE the featured set.
async function fetchHeadToHead(p1, p2, limit = 4, excludeSetId) {
  if (!p1?.playerId || !p2?.playerId) return { sets: [], record: {} };
  const { pairSets, record } = await fetchAllPairSets(p1, p2);
  const rowIds = pairSets
    .filter((s) => s.setId !== String(excludeSetId))
    .slice(0, limit)
    .map((s) => s.setId);
  const sets = await fetchSetDetails(rowIds);
  return { sets, record };
}

// Match history state. Loaded in the BACKGROUND whenever the target set
// (see h2hTargetSetId) changes — the history view only ever renders
// already-loaded data, so a "loading…" state can never appear on stream.
// The auto-phase timer gates on matchHistoryReady().
let h2h = {
  setId: null,
  loading: false,
  ready: false,
  hasData: false,
  sets: [],
  record: { left: 0, right: 0 },
  leftPlayerId: null,
  leftName: "",
  rightName: "",
  message: "",
};

function matchHistoryReady() {
  return (
    h2h.ready &&
    h2h.hasData &&
    h2hTargetSetId !== null &&
    h2h.setId === h2hTargetSetId
  );
}

function prefetchMatchHistory() {
  if (!h2hTargetSetId) return;
  const id = h2hTargetSetId;
  // Already loaded or in flight for this set; a failed attempt
  // (neither flag set) retries on the next poll.
  if (h2h.setId === id && (h2h.ready || h2h.loading)) return;
  h2h = {
    setId: id,
    loading: true,
    ready: false,
    hasData: false,
    sets: [],
    record: { left: 0, right: 0 },
    leftPlayerId: null,
    leftName: "",
    rightName: "",
    message: "",
  };

  (async () => {
    try {
      const players = await fetchSetPlayers(id);
      const [s1, s2] = players;
      let sets = [];
      let record = { left: 0, right: 0 };
      let message = "";
      let leftPlayerId = null;
      let leftName = "";
      let rightName = "";
      if (!s1?.playerId || !s2?.playerId) {
        message =
          "Can't look up history — couldn't identify both players on start.gg.";
      } else {
        const h = await fetchHeadToHead(s1, s2, 4, id);
        sets = h.sets;
        // Keep the same player on the same side in every row, matching
        // the main view's convention: better seed (lower number) left.
        leftPlayerId =
          s1.seedNum != null &&
          s2.seedNum != null &&
          s2.seedNum < s1.seedNum
            ? s2.playerId
            : s1.playerId;
        const [leftP, rightP] =
          leftPlayerId === s1.playerId ? [s1, s2] : [s2, s1];
        record = {
          left: h.record[leftP.playerId] || 0,
          right: h.record[rightP.playerId] || 0,
        };
        leftName = leftP.name;
        rightName = rightP.name;
        if (!sets.length) {
          message = `No prior sets found between ${s1.name} and ${s2.name}.`;
        }
      }
      if (h2h.setId !== id) return; // target set moved on — discard
      h2h = {
        setId: id,
        loading: false,
        ready: true,
        hasData: sets.length > 0,
        sets,
        record,
        leftPlayerId,
        leftName,
        rightName,
        message,
      };
    } catch (err) {
      console.error("Match history error: ", err);
      if (h2h.setId === id) h2h.loading = false; // retry next poll
    }
    if (currentView === "history") renderMatchHistory();
    renderDebugPanel();
  })();
}

function buildHistoryRowHtml(s) {
  const a =
    s.players.find((p) => p.playerId === h2h.leftPlayerId) ||
    s.players[0];
  const b = s.players.find((p) => p !== a);
  if (!a || !b) return "";
  const d = new Date(s.date);
  const when = `${d.getMonth() + 1}/${d.getDate()}/${String(
    d.getFullYear()
  ).slice(-2)}`;
  return `
      <div class="score${a.won ? " winner" : ""}">${a.score}</div>
      <div class="player-name left">
        <span>${escapeHtml(a.name)}</span>
      </div>
      <div class="vs mono history-center">
        ${
          s.logoUrl
            ? `<img src="${escapeHtml(s.logoUrl)}" alt="${escapeHtml(
                s.tournament
              )}" title="${escapeHtml(s.tournament)}" />`
            : ""
        }
        <div class="history-date">${when}</div>
      </div>
      <div class="player-name right">
        <span>${escapeHtml(b.name)}</span>
      </div>
      <div class="score${b.won ? " winner" : ""}">${b.score}</div>
      <div class="set-background"></div>
    `;
}

// Renders ONLY already-loaded data — never triggers a fetch.
function renderMatchHistory() {
  const container = document.getElementById("matchHistoryContainer");
  if (!h2h.ready) {
    container.textContent = "Match history not loaded yet.";
    return;
  }
  if (!h2h.hasData) {
    container.textContent = h2h.message;
    return;
  }
  // The overall record renders as a full-size set-style card (the hero);
  // the individual meetings below it are compact.
  const rec = h2h.record || { left: 0, right: 0 };
  container.innerHTML =
    `<div class="set">
      <div class="score${rec.left > rec.right ? " winner" : ""}">${
      rec.left
    }</div>
      <div class="player-name left">
        <span>${escapeHtml(h2h.leftName)}</span>
      </div>
      <div class="vs mono">VS</div>
      <div class="player-name right">
        <span>${escapeHtml(h2h.rightName)}</span>
      </div>
      <div class="score${rec.right > rec.left ? " winner" : ""}">${
      rec.right
    }</div>
      <div class="set-background"></div>
    </div>` +
    h2h.sets
      .map((s) => `<div class="set compact">${buildHistoryRowHtml(s)}</div>`)
      .join("");
}

// Immediate refetch outside the polling cadence (debug scroll).
async function refreshNow() {
  if (!activeSlug) return;
  const result = await fetchData(activeSlug);
  if (!result.error) applyFetchResult(result);
  renderDebugPanel();
}

// Debug view swap: "recent" is the normal on-stream view; "history"
// is a stub to develop the match-history view against. The goal is to
// eventually auto-phase between the two every few seconds.
function setView(view) {
  currentView = view;
  const recent = view === "recent";
  document.querySelector(".header").textContent = recent
    ? "Recent Results"
    : "Match History";
  document.getElementById("setsContainer").style.display = recent
    ? "grid"
    : "none";
  document.getElementById("matchHistoryContainer").style.display = recent
    ? "none"
    : "grid";
  if (!recent) renderMatchHistory();
  document.getElementById("waitingMessage").style.display =
    recent && !document.querySelector("#setsContainer .set")
      ? "block"
      : "none";
  scheduleAutoPhase(); // every swap restarts the dwell countdown
  renderDebugPanel();
}

// Fade-out → swap → fade-in. Use this (not setView) for all swaps
// after startup, including the future auto-phase timer.
const VIEW_FADE_MS = 450;
let viewTransitioning = false;
function setViewAnimated(view) {
  if (view === currentView) return;
  if (viewTransitioning) {
    setView(view); // mid-transition override (e.g. new set went live)
    return;
  }
  viewTransitioning = true;
  const els = [
    document.querySelector(".header"),
    document.getElementById("setsContainer"),
    document.getElementById("matchHistoryContainer"),
    document.getElementById("waitingMessage"),
  ];
  els.forEach((el) => (el.style.opacity = "0"));
  setTimeout(() => {
    setView(view);
    void els[0].offsetHeight; // flush so the fade-in transitions
    els.forEach((el) => (el.style.opacity = "1"));
    setTimeout(() => (viewTransitioning = false), VIEW_FADE_MS);
  }, VIEW_FADE_MS);
}

// --- Auto-phase: rotate Recent Results ↔ Match History ----------
// Swaps to Match History only when its data is loaded and non-empty
// (matchHistoryReady) — otherwise it holds on Recent Results and
// reports why. Any view change (auto, manual, or the new-set swap
// back) restarts the dwell countdown via setView.
const AUTO_PHASE_RECENT_MS = 12000;
const AUTO_PHASE_HISTORY_MS = 8000;

const autoPhase = {
  playing: true,
  ticker: null,
  nextSwapAt: null,
  remainingMs: null, // frozen countdown while paused
  status: "idle",
};

function autoPhaseDwell(view) {
  return view === "recent"
    ? AUTO_PHASE_RECENT_MS
    : AUTO_PHASE_HISTORY_MS;
}

function scheduleAutoPhase() {
  autoPhase.nextSwapAt = Date.now() + autoPhaseDwell(currentView);
}

function startAutoPhase() {
  if (autoPhase.ticker) clearInterval(autoPhase.ticker);
  scheduleAutoPhase();
  autoPhase.ticker = setInterval(autoPhaseTick, 250);
}

function stopAutoPhase() {
  if (autoPhase.ticker) clearInterval(autoPhase.ticker);
  autoPhase.ticker = null;
  autoPhase.status = "idle";
}

function autoPhaseTick() {
  if (!autoPhase.playing) {
    autoPhase.status = "paused";
    if (debugOpen) renderDebugPanel();
    return;
  }
  if (viewTransitioning) return;

  const now = Date.now();
  if (now < autoPhase.nextSwapAt) {
    autoPhase.status = `swap in ${(
      (autoPhase.nextSwapAt - now) / 1000
    ).toFixed(1)}s`;
  } else if (currentView === "recent") {
    if (matchHistoryReady()) {
      autoPhase.status = "swapping";
      setViewAnimated("history");
    } else if (!h2hTargetSetId) {
      autoPhase.status = "holding — no target set yet";
    } else if (h2h.loading) {
      autoPhase.status = "holding — fetching match history";
    } else if (h2h.ready && !h2h.hasData) {
      autoPhase.status = "holding — no history for this matchup";
    } else {
      autoPhase.status = "holding — match history unavailable";
    }
    // Held at the deadline: swaps the moment the data is ready.
  } else {
    autoPhase.status = "swapping";
    setViewAnimated("recent");
  }
  if (debugOpen) renderDebugPanel();
}

function setAutoPhasePlaying(playing) {
  autoPhase.playing = playing;
  if (playing) {
    autoPhase.nextSwapAt =
      Date.now() + (autoPhase.remainingMs ?? autoPhaseDwell(currentView));
    autoPhase.remainingMs = null;
  } else {
    autoPhase.remainingMs = Math.max(
      0,
      (autoPhase.nextSwapAt ?? Date.now()) - Date.now()
    );
  }
  document.getElementById("autoPhaseBtn").textContent = playing
    ? "⏸ Auto"
    : "▶ Auto";
  renderDebugPanel();
}

document
  .getElementById("autoPhaseBtn")
  .addEventListener("click", () =>
    setAutoPhasePlaying(!autoPhase.playing)
  );

// Debug mode: toggled by the (OBS-hidden) button, or forced on with
// ?debug=1 — the explicit param works even inside OBS so the overlay
// can be diagnosed from the Interact window.
let debugOpen = params.has("debug");

function renderDebugPanel() {
  if (!debugOpen) return;
  document.getElementById("debugInfo").textContent = [
    `obs detected: ${!!window.obsstudio}`,
    `event: ${activeSlug || "—"}`,
    `view: ${currentView}`,
    `auto-phase: ${
      !autoPhase.ticker
        ? "idle"
        : autoPhase.playing
        ? autoPhase.status
        : "paused"
    }`,
    `scroll offset: ${setsOffset}`,
    `polling: ${pollingInterval ? "every 5s" : "off"}`,
    `h2h: ${
      h2h.loading
        ? "loading"
        : h2h.ready
        ? h2h.hasData
          ? "ready"
          : "ready (no history)"
        : "—"
    }`,
    `h2h target: ${h2hTargetSetId ?? "—"} (${h2hTargetSource})`,
    `fetches: ${debugState.fetchCount}`,
    `last fetch: ${debugState.lastFetch}`,
    `last result: ${debugState.lastResult}`,
    `entrants: ${tournamentInfo.entrantsCount} (bracket size ${
      tournamentInfo.bracketSize ?? "?"
    })`,
    `sets rendered: ${
      document.querySelectorAll("#setsContainer .set").length
    }`,
    `saved config: ${
      localStorage.getItem("startggToken") ? "token ✓" : "token ✗"
    }, ${localStorage.getItem("startggEventUrl") ? "url ✓" : "url ✗"}`,
  ].join("\n");
}

document.getElementById("swapViewBtn").addEventListener("click", () => {
  setViewAnimated(currentView === "recent" ? "history" : "recent");
});

// Scroll a full screen (4 sets) at a time.
document
  .getElementById("scrollDownBtn")
  .addEventListener("click", () => {
    setsOffset = Math.min(setsOffset + 4, 40);
    renderDebugPanel();
    refreshNow();
  });

document.getElementById("scrollUpBtn").addEventListener("click", () => {
  setsOffset = Math.max(setsOffset - 4, 0);
  renderDebugPanel();
  refreshNow();
});

function setDebugOpen(open) {
  debugOpen = open;
  document.getElementById("debugPanel").style.display = open
    ? "block"
    : "none";
  renderDebugPanel();
}

document
  .getElementById("debugBtn")
  .addEventListener("click", () => setDebugOpen(!debugOpen));

if (debugOpen) setDebugOpen(true);

// The copy-link / change-setup helpers are for the setup browser only.
// OBS injects window.obsstudio into browser sources, so inside OBS
// these stay hidden and never appear on stream.
function showStreamControls() {
  if (window.obsstudio) return;
  document.getElementById("streamControls").style.display = "flex";
}

document
  .getElementById("copyObsLinkBtn")
  .addEventListener("click", async () => {
    const btn = document.getElementById("copyObsLinkBtn");
    const link = `${location.origin}${
      location.pathname
    }?t=${encodeURIComponent(authToken)}&u=${encodeURIComponent(
      eventUrl
    )}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch (err) {
      prompt("Copy this link into an OBS browser source:", link);
      return;
    }
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy OBS link"), 2000);
  });

document
  .getElementById("changeSetupBtn")
  .addEventListener("click", () => {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = null;
    stopAutoPhase();
    setOverlayVisible(false);
    document.getElementById("startggErrorMessage").textContent = "";
    document.getElementById("waitingMessage").style.display = "none";
    document.getElementById("streamControls").style.display = "none";
    document.getElementById("tokenInput").value = authToken;
    document.getElementById("urlInput").value = eventUrl;
    document.getElementById("configPanel").classList.remove("hidden");
  });

let startingUp = false;
async function startOverlay(e) {
  if (e) e.preventDefault();
  if (startingUp) return;

  clearConfigError();

  // Always prefer what's currently typed in the form, so a corrected
  // token or URL isn't ignored in favor of a stale cached value.
  const typedToken = document.getElementById("tokenInput").value.trim();
  if (typedToken) authToken = typedToken;
  if (!authToken) {
    showConfigError("Please enter your Start.gg API token.");
    return;
  }

  const typedUrl = document.getElementById("urlInput").value.trim();
  if (typedUrl) eventUrl = typedUrl;
  if (!eventUrl) {
    showConfigError("Please enter a Start.gg event URL.");
    return;
  }

  const slug = extractSlugFromUrl(eventUrl);
  if (!slug) {
    eventUrl = "";
    showConfigError(
      "Couldn't read that URL — paste a direct event link like " +
        "https://www.start.gg/tournament/.../event/..."
    );
    return;
  }
  activeSlug = slug;

  const startButton = document.querySelector(
    "#configPanel button[type='submit']"
  );
  startingUp = true;
  startButton.disabled = true;
  startButton.textContent = "Connecting…";

  const result = await fetchData(slug);

  startingUp = false;
  startButton.disabled = false;
  startButton.textContent = "Start";

  if (result.error) {
    // A transient network failure during an unattended auto-start
    // (e.g. OBS launching before the network is up) should self-heal,
    // not surface a form nobody is there to click.
    const interactive = !!e;
    if (result.network && !interactive) {
      document.getElementById("startggErrorMessage").textContent =
        result.message + " Retrying…";
      setTimeout(startOverlay, 5000);
      return;
    }
    // Bring the form back so a bad token or URL can be corrected —
    // especially important inside OBS, where storage is hard to clear.
    document.getElementById("startggErrorMessage").textContent = "";
    showConfigError(result.message);
    document.getElementById("configPanel").classList.remove("hidden");
    return;
  }

  // Config verified against start.gg — only now persist it, so a bad
  // token or URL is never saved.
  localStorage.setItem("startggToken", authToken);
  localStorage.setItem("startggEventUrl", eventUrl);

  document.getElementById("configPanel").classList.add("hidden");
  document.getElementById("startggErrorMessage").textContent = "";

  setOverlayVisible(true);
  applyFetchResult(result);
  document.getElementById("waitingMessage").style.display =
    currentView === "recent" &&
    !document.querySelector("#setsContainer .set")
      ? "block"
      : "none";

  showStreamControls();
  startAutoPhase();

  if (window.ENABLE_POLLING !== false) {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(async () => {
      const result = await fetchData(slug);
      if (result.error) {
        // Existing results stay up. Only surface poll errors while
        // nothing is rendered yet, so hiccups never print over a
        // live stream.
        if (!document.querySelector("#setsContainer .set")) {
          document.getElementById("startggErrorMessage").textContent =
            result.message + " Retrying…";
        }
        renderDebugPanel();
        return;
      }
      document.getElementById("startggErrorMessage").textContent = "";
      applyFetchResult(result);
    }, 5000);
  }
}

// Auto-start when fully configured (query params, config file, or a
// previously verified setup saved in localStorage). Runs last so all
// state above is initialized before startOverlay executes.
if (authToken && eventUrl && !params.has("reset")) {
  document.getElementById("configPanel").classList.add("hidden");
  startOverlay();
}
