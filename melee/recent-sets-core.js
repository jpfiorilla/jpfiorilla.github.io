// Pure / dependency-injected logic for the recent-sets overlay, extracted
// so it can be unit-tested in Node. The page loads this BEFORE
// recent-sets.js (classic script -> window.RSCore); tests require() it.
(function (root) {
  const MELEE_VIDEOGAME_ID = 1;

  // start.gg's 1000-object cap counts RETURNED objects, so cost varies by
  // page content: doubles-heavy pages carry extra participants and burst
  // the cap at larger page sizes (85/page died at 1056 on Ryobeat's
  // history). 60/page stays under the cap even for all-doubles pages, and
  // a stubborn page is split in half on a complexity error.
  const H2H_PAGE_SIZE = 60;
  const H2H_MAX_PAGES = 60; // 3600 sets — beyond any realistic rivalry
  const H2H_BATCH = 4; // concurrent page requests per round
  const H2H_CACHE_VERSION = 1;

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

  function formatRound(set, tournamentInfo) {
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

  function extractSlugFromUrl(url) {
    const match = url.match(
      /start\.gg\/tournament\/([^\/]+)\/event\/([^\/]+)/
    );
    return match ? `tournament/${match[1]}/event/${match[2]}` : null;
  }

  // The set currently on stream. PRIMARY: the stream queue's 0th set —
  // queue order is [current, next, next…], so later entries are future
  // sets, never alternatives; only sets[0] may be used (and only if it
  // belongs to this event). The queue is live during broadcasts and
  // cleared afterwards. FALLBACK: an active (state 1 created / 2 started
  // / 6 called — never 3 completed) set assigned to the stream station,
  // preferring in-progress; the TO pre-assigning the NEXT set to the
  // station is why the station alone can be ambiguous. wantedStream
  // narrows both signals on multi-stream tournaments.
  function selectStreamSet({ queues, onStreamNodes, eventId, wantedStream }) {
    const wanted = (wantedStream || "").toLowerCase();
    const matches = (name) => !wanted || (name || "").toLowerCase() === wanted;

    const qs = queues || [];
    const queue =
      qs.find((q) => matches(q?.stream?.streamName)) ||
      (!wanted ? qs[0] : null);
    const queueHead = queue?.sets?.[0];
    if (queueHead && queueHead.event?.id === eventId) return queueHead;

    const active = (onStreamNodes || []).filter(
      (s) => s?.stream && matches(s.stream.streamName)
    );
    // in progress beats called beats created
    const stateRank = { 2: 0, 6: 1, 1: 2 };
    active.sort(
      (a, b) => (stateRank[a.state] ?? 3) - (stateRank[b.state] ?? 3)
    );
    return active[0] || null;
  }

  // The main 5-second poll. setsPerPage grows with the debug scroll.
  const pollQuery = (setsPerPage) => `
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
        sets(perPage: ${setsPerPage}, page: 1, sortType: RECENT) {
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

  const walkQuery = (perPage) => `
    query PairWalk($pid: ID!, $page: Int!) {
      player(id: $pid) {
        sets(page: $page, perPage: ${perPage}) {
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

  // One walk page of H2H_PAGE_SIZE sets. On a complexity error the same
  // window is refetched as two half-size pages (page N at size S covers
  // pages 2N-1 and 2N at size S/2).
  async function fetchWalkPage(gql, playerId, page) {
    try {
      const data = await gql(walkQuery(H2H_PAGE_SIZE), {
        pid: playerId,
        page,
      });
      return data.player?.sets?.nodes || [];
    } catch (err) {
      if (!/complexity/i.test(err.message)) throw err;
      const half = H2H_PAGE_SIZE / 2;
      const [a, b] = await Promise.all([
        gql(walkQuery(half), { pid: playerId, page: page * 2 - 1 }),
        gql(walkQuery(half), { pid: playerId, page: page * 2 }),
      ]);
      return (a.player?.sets?.nodes || []).concat(
        b.player?.sets?.nodes || []
      );
    }
  }

  // Turns one page of walk results into cache tuples. Keeps every
  // completed singles Melee set (any opponent — the cache serves all
  // future pairs involving this player); skips DQs and doubles.
  function collectWalkPage(nodes, cachedIds, fresh) {
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

  // Full walk of one player's set history, incremental against the cached
  // history. deps: { gql, loadHistory(playerId), saveHistory(playerId, h) }.
  // Returns { complete, sets } (tuples, newest first). `knownTotal` skips
  // the totals lookup when already known.
  async function walkPlayerSets(deps, playerId, knownTotal) {
    const { gql, loadHistory, saveHistory } = deps;
    const cached = loadHistory(playerId) || {
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
          await fetchWalkPage(gql, playerId, page),
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
          batch.map((page) => fetchWalkPage(gql, playerId, page))
        );
        responses.forEach((nodes) =>
          collectWalkPage(nodes, cachedIds, fresh)
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
    saveHistory(playerId, history);
    return history;
  }

  // Filters one player's walked history down to sets against a specific
  // opponent, newest first, plus the win record.
  function pairDataForOpponent(historySets, opponentId) {
    const pairSets = historySets
      .filter((s) => s[3] === opponentId || s[4] === opponentId)
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
  async function fetchSetDetails(gql, setIds) {
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

  const api = {
    MELEE_VIDEOGAME_ID,
    H2H_PAGE_SIZE,
    H2H_MAX_PAGES,
    H2H_BATCH,
    H2H_CACHE_VERSION,
    LOSERS_TOP,
    escapeHtml,
    extractPlayerTag,
    pow2Ceil,
    formatRound,
    setSignature,
    extractSlugFromUrl,
    selectStreamSet,
    pollQuery,
    walkQuery,
    fetchWalkPage,
    collectWalkPage,
    walkPlayerSets,
    pairDataForOpponent,
    fetchSetDetails,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.RSCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
