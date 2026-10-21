// Bootstrap for the recent-sets overlay: config resolution, the start
// form, and startup. Load order: core -> api -> views -> THIS.
const { extractSlugFromUrl, extractShortSlug } = window.RSCore;

// Saved config keys. The event URL carries a saved-at time so a concrete
// event link can expire (see savedEventUrl).
const SAVED_TOKEN = "startggToken";
const SAVED_URL = "startggEventUrl";
const SAVED_URL_AT = "startggEventUrlSavedAt";
const SAVED_EVENT_MAX_AGE_MS = 20 * 60 * 60 * 1000;

function clearSavedConfig() {
  localStorage.removeItem(SAVED_TOKEN);
  localStorage.removeItem(SAVED_URL);
  localStorage.removeItem(SAVED_URL_AT);
}

// ?clear=1 is the failsafe: on every load it wipes the saved token and
// event URL and never saves new ones, so the overlay runs only on what
// this load is given (URL params or the form). Safe to leave in an OBS
// source URL permanently; cached match histories are kept.
const neverSave = params.has("clear");
if (neverSave) clearSavedConfig();

// ?reset=1 wipes everything (including cached match histories) and shows
// the form instead of auto-starting.
if (params.has("reset")) {
  clearSavedConfig();
  Object.keys(localStorage)
    .filter((k) => k.startsWith("h2hSets:"))
    .forEach((k) => localStorage.removeItem(k));
}

let authToken =
  params.get("token") ||
  params.get("t") ||
  window.STARTGG_TOKEN ||
  localStorage.getItem(SAVED_TOKEN) ||
  "";

if (authToken) document.getElementById("tokenInput").value = authToken;

// The saved event URL to resume with, if any. A short link (start.gg/nyse)
// follows the series and never goes stale. A concrete event link only
// resumes within 20 hours of being saved: a weekly's old event stays
// valid on start.gg forever, so resuming it next week silently showed
// last week's results with no way back to the form inside OBS.
const savedEventUrl = (() => {
  const url = localStorage.getItem(SAVED_URL);
  if (!url) return "";
  if (extractShortSlug(url)) return url;
  const savedAt = Number(localStorage.getItem(SAVED_URL_AT)) || 0;
  return Date.now() - savedAt < SAVED_EVENT_MAX_AGE_MS ? url : "";
})();

let eventUrl =
  params.get("url") ||
  params.get("u") ||
  window.STARTGG_URL ||
  savedEventUrl ||
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

  const shortSlug = extractShortSlug(eventUrl);
  if (!shortSlug && !extractSlugFromUrl(eventUrl)) {
    eventUrl = "";
    showConfigError(
      "Couldn't read that URL — paste an event link like " +
        "https://www.start.gg/tournament/.../event/... or a tournament " +
        "short link like https://start.gg/nyse"
    );
    return;
  }

  const startButton = document.querySelector(
    "#configPanel button[type='submit']"
  );
  startingUp = true;
  startButton.disabled = true;
  startButton.textContent = "Connecting…";

  // A short link is resolved to the series' current event on every start.
  const resolved = await (async () => {
    if (!shortSlug) return { slug: extractSlugFromUrl(eventUrl) };
    try {
      const slug = await resolveShortSlug(shortSlug);
      return slug
        ? { slug }
        : {
            error: true,
            message: `Start.gg error: no tournament found at start.gg/${shortSlug}.`,
          };
    } catch (err) {
      const network = err instanceof TypeError; // fetch failed outright
      return {
        error: true,
        network,
        message: network
          ? "Network error contacting Start.gg."
          : `Start.gg error: ${err.message}`,
      };
    }
  })();
  const slug = resolved.slug;
  if (slug) activeSlug = slug;

  const result = resolved.error ? resolved : await fetchData(slug);

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
  // token or URL is never saved. ?clear=1 never saves.
  if (!neverSave) {
    localStorage.setItem(SAVED_TOKEN, authToken);
    localStorage.setItem(SAVED_URL, eventUrl);
    localStorage.setItem(SAVED_URL_AT, String(Date.now()));
  }

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

