// start.gg data access for the recent-sets overlay.
// Load order: recent-sets-core.js -> THIS -> recent-sets-views.js -> recent-sets.js
const {
  pollQuery,
  selectStreamSet,
  walkPlayerSets: coreWalkPlayerSets,
  pairDataForOpponent,
  fetchSetDetails: coreFetchSetDetails,
  H2H_CACHE_VERSION,
} = window.RSCore;

const API_URL = "https://api.start.gg/gql/alpha";
let pollingInterval;
let activeSlug = null;
let setsOffset = 0; // debug: how far past the most recent set to scroll
const debugState = { fetchCount: 0, lastFetch: "—", lastResult: "—" };

const params = new URLSearchParams(window.location.search);


async function fetchData(slug) {
  const query = pollQuery(Math.min(setsOffset + 5, 50));
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

    // Which set is on stream (queue 0th, then station; see core).
    const streamSet = selectStreamSet({
      queues: json.data.tournament?.streamQueue || [],
      onStreamNodes: json.data.event.onStream?.nodes || [],
      eventId: json.data.event.id,
      wantedStream: params.get("stream") || "",
    });

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
// start.gg's 1000-object cap counts RETURNED objects, so cost varies by
// page content: doubles-heavy pages carry extra participants and burst the
// cap at larger page sizes (85/page died at 1056 on Ryobeat's history).
// 60/page stays under the cap even for all-doubles pages, and a stubborn

const H2H_CACHE_PREFIX = "h2hSets:";

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

// Full walk of one player's set history (core logic, real deps).
const walkPlayerSets = (playerId, knownTotal) =>
  coreWalkPlayerSets(
    { gql, loadHistory: loadPlayerHistory, saveHistory: savePlayerHistory },
    playerId,
    knownTotal
  );

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
  const otherId = walkId === p1.playerId ? p2.playerId : p1.playerId;
  return pairDataForOpponent(history.sets, otherId);
}

// Display details for specific sets (core query, real gql).
const fetchSetDetails = (setIds) => coreFetchSetDetails(gql, setIds);

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
