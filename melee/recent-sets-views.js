// Rendering, view rotation, and debug UI for the recent-sets overlay.
// Load order: recent-sets-core.js -> recent-sets-api.js -> THIS -> recent-sets.js
const { escapeHtml, extractPlayerTag, pow2Ceil, formatRound, setSignature } =
  window.RSCore;

let currentView = "recent"; // "recent" | "history"


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
      <div class="vs mono">${formatRound(set, tournamentInfo)}</div>
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

// --- Match history (head-to-head) view state ---------------------
let latestSets = [];

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


async function refreshNow() {
  if (!activeSlug) return;
  const result = await fetchData(activeSlug);
  if (!result.error) applyFetchResult(result);
  renderDebugPanel();
}

// Debug view swap: "recent" is the normal on-stream view; "history"
// is a stub to develop the match-history view against. The goal is to

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
