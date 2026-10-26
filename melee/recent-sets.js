// Bootstrap for the recent-sets overlay: config resolution, the start
// form, and startup. Load order: core -> api -> views -> THIS.
const { extractSlugFromUrl, isParryUrl, extractParrySlugs } = window.RSCore;


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

let startingUp = false;
async function startOverlay(e) {
  if (e) e.preventDefault();
  if (startingUp) return;

  clearConfigError();

  // Always prefer what's currently typed in the form, so a corrected
  // token or URL isn't ignored in favor of a stale cached value.
  const typedToken = document.getElementById("tokenInput").value.trim();
  if (typedToken) authToken = typedToken;

  const typedUrl = document.getElementById("urlInput").value.trim();
  if (typedUrl) eventUrl = typedUrl;
  if (!eventUrl) {
    showConfigError("Please enter a Start.gg or parry.gg event URL.");
    return;
  }

  if (isParryUrl(eventUrl)) {
    // parry.gg reads are public — no token needed.
    const parrySlugs = extractParrySlugs(eventUrl);
    if (!parrySlugs) {
      eventUrl = "";
      showConfigError(
        "Couldn't read that URL — paste an event link like " +
          "https://parry.gg/<tournament>/<event>"
      );
      return;
    }
    // A different event than last time needs its id resolved again.
    if (
      activeParrySlugs?.tournamentSlug !== parrySlugs.tournamentSlug ||
      activeParrySlugs?.eventSlug !== parrySlugs.eventSlug
    ) {
      parryEvent = null;
    }
    activeProvider = "parry";
    activeParrySlugs = parrySlugs;
    activeSlug = `parry.gg/${parrySlugs.tournamentSlug}/${parrySlugs.eventSlug}`;
  } else {
    if (!authToken) {
      showConfigError("Please enter your Start.gg API token.");
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
    activeProvider = "startgg";
    activeSlug = slug;
  }

  const startButton = document.querySelector(
    "#configPanel button[type='submit']"
  );
  startingUp = true;
  startButton.disabled = true;
  startButton.textContent = "Connecting…";

  const result = await fetchActiveEvent();

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

  // Config verified against the API — only now persist it, so a bad
  // token or URL is never saved.
  if (authToken) localStorage.setItem("startggToken", authToken);
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
      const result = await fetchActiveEvent();
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
if (
  eventUrl &&
  (authToken || isParryUrl(eventUrl)) &&
  !params.has("reset")
) {
  document.getElementById("configPanel").classList.add("hidden");
  startOverlay();
}

