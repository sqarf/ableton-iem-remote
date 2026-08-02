"use strict";

const CONFIG_URL = "/api/config";
const MEMBER_STORAGE_KEY = "ableton-iem-remote.member";
const WRITE_DELAY_MS = 60;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 12_000;

const elements = {
  announcement: document.querySelector("#announcement"),
  bridgeAlert: document.querySelector("#bridge-alert"),
  bridgeAlertMessage: document.querySelector("#bridge-alert-message"),
  changeMember: document.querySelector("#change-member"),
  configRetry: document.querySelector("#config-retry"),
  connectionLabel: document.querySelector("#connection-label"),
  connectionStatus: document.querySelector("#connection-status"),
  errorBanner: document.querySelector("#error-banner"),
  errorDismiss: document.querySelector("#error-dismiss"),
  errorMessage: document.querySelector("#error-message"),
  faderBank: document.querySelector("#fader-bank"),
  memberList: document.querySelector("#member-list"),
  memberLoadState: document.querySelector("#member-load-state"),
  memberScreen: document.querySelector("#member-screen"),
  memberTitle: document.querySelector("#member-title"),
  mixName: document.querySelector("#mix-name"),
  mixerScreen: document.querySelector("#mixer-screen"),
  mixerTitle: document.querySelector("#mixer-title"),
  resetMix: document.querySelector("#reset-mix"),
  sourceCount: document.querySelector("#source-count")
};

const app = {
  config: null,
  selectedMember: null,
  levels: new Map(),
  renderedLevels: new Map(),
  sourceRevisions: new Map(),
  draggingSources: new Set(),
  writes: new Map(),
  eventSource: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  streamState: "loading",
  bridge: { connected: false, message: "" },
  session: 0,
  resetInProgress: false,
  hasAuthoritativeSnapshot: false
};

elements.errorDismiss.addEventListener("click", clearError);
elements.configRetry.addEventListener("click", loadConfig);
elements.changeMember.addEventListener("click", showMemberSelection);
elements.resetMix.addEventListener("click", resetMix);

window.addEventListener("online", () => {
  if (app.selectedMember && !app.eventSource) {
    scheduleReconnect(0);
  } else {
    updateConnectionStatus();
  }
});

window.addEventListener("offline", () => {
  // `navigator.onLine` can be false on an internet-free hotspot even while the
  // local Ableton laptop remains reachable. Let EventSource prove connectivity.
  updateConnectionStatus();
});

window.addEventListener("pointerup", finishAllPointerInteractions);
window.addEventListener("pointercancel", finishAllPointerInteractions);
window.addEventListener("pagehide", closeEventStream);
window.addEventListener("pageshow", () => {
  if (app.selectedMember && !app.eventSource) {
    scheduleReconnect(0);
  }
});

loadConfig();

async function loadConfig() {
  app.streamState = "loading";
  elements.configRetry.hidden = true;
  elements.memberLoadState.hidden = false;
  elements.memberLoadState.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Loading band members…</span>';
  clearError();
  updateConnectionStatus();

  try {
    const payload = await requestJsonWithTimeout(CONFIG_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    }, "Could not load the band configuration.", "Timed out while loading the band configuration.");
    app.config = normalizeConfig(payload);
    app.bridge = normalizeBridge(app.config.bridge);
    app.streamState = "idle";
    renderMembers();

    const rememberedId = readRememberedMemberId();
    const rememberedMember = app.config.members.find((member) => member.id === rememberedId);
    if (rememberedMember) {
      selectMember(rememberedMember);
    } else {
      showMemberSelection({ forget: false, focus: false });
    }
  } catch (error) {
    app.streamState = "offline";
    elements.memberLoadState.textContent = "Band members could not be loaded.";
    elements.configRetry.hidden = false;
    showError(error.message);
    updateConnectionStatus();
  }
}

function normalizeConfig(payload) {
  const config = payload && typeof payload === "object" && payload.config ? payload.config : payload;
  if (!config || !Array.isArray(config.members) || !Array.isArray(config.sources)) {
    throw new Error("The server returned an invalid public configuration.");
  }

  const minimum = Number(config.levels?.minimum);
  const maximum = Number(config.levels?.maximum);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) {
    throw new Error("The configured level range is invalid.");
  }

  const mixesById = new Map(
    (Array.isArray(config.mixes) ? config.mixes : [])
      .filter((mix) => mix && typeof mix.id === "string")
      .map((mix) => [mix.id, mix])
  );

  const members = config.members.map((member) => {
    if (!member || typeof member.id !== "string" || typeof member.name !== "string" || typeof member.mixId !== "string") {
      throw new Error("A band member in the public configuration is invalid.");
    }
    return {
      id: member.id,
      name: member.name,
      mixId: member.mixId,
      mixName: member.mixName || mixesById.get(member.mixId)?.name || "Personal mix"
    };
  });

  const sources = config.sources.map((source) => {
    if (!source || typeof source.id !== "string" || typeof source.name !== "string") {
      throw new Error("A source in the public configuration is invalid.");
    }
    return { id: source.id, name: source.name };
  });

  return {
    ...config,
    members,
    sources,
    levels: { minimum, maximum },
    bridge: normalizeBridge(config.bridge)
  };
}

function renderMembers() {
  const rememberedId = readRememberedMemberId();
  elements.memberList.replaceChildren();

  for (const member of app.config.members) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "member-button";
    if (member.id === rememberedId) {
      button.classList.add("is-remembered");
    }
    button.setAttribute("aria-label", `Open ${member.name}'s ${member.mixName}`);
    button.addEventListener("click", () => selectMember(member));

    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = initialsFor(member.name);

    const copy = document.createElement("span");
    copy.className = "member-button-copy";

    const name = document.createElement("span");
    name.className = "member-button-name";
    name.textContent = member.name;

    const mix = document.createElement("span");
    mix.className = "member-button-mix";
    mix.textContent = member.mixName;

    const arrow = document.createElement("span");
    arrow.className = "member-button-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";

    copy.append(name, mix);
    button.append(avatar, copy, arrow);
    elements.memberList.append(button);
  }

  elements.memberLoadState.hidden = app.config.members.length > 0;
  if (app.config.members.length === 0) {
    elements.memberLoadState.textContent = "No band members are configured.";
  }
}

function initialsFor(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

async function selectMember(member) {
  if (!app.config || !member) return;

  clearError();
  closeEventStream();
  cancelQueuedWrites();
  app.session += 1;
  const session = app.session;
  app.selectedMember = member;
  app.levels.clear();
  app.renderedLevels.clear();
  app.sourceRevisions.clear();
  app.draggingSources.clear();
  app.hasAuthoritativeSnapshot = false;
  rememberMember(member.id);

  elements.memberScreen.hidden = true;
  elements.mixerScreen.hidden = false;
  elements.mixerTitle.textContent = member.name;
  elements.mixName.textContent = member.mixName;
  elements.sourceCount.textContent = `${app.config.sources.length} ${app.config.sources.length === 1 ? "source" : "sources"}`;
  elements.faderBank.setAttribute("aria-busy", "true");
  elements.resetMix.disabled = true;
  renderFaders();
  app.streamState = "connecting";
  updateConnectionStatus();
  updateBridgeAlert();
  elements.mixerTitle.focus({ preventScroll: true });

  connectEventStream(session);

  try {
    await refreshMixState(session);
  } catch (error) {
    if (session !== app.session) return;
    showError(error.message);
  }
}

function showMemberSelection(options = {}) {
  const { forget = true, focus = true } = options;
  app.session += 1;
  closeEventStream();
  cancelQueuedWrites();
  app.selectedMember = null;
  app.draggingSources.clear();
  if (forget) {
    forgetRememberedMember();
    if (app.config) renderMembers();
  }
  elements.mixerScreen.hidden = true;
  elements.memberScreen.hidden = false;
  app.streamState = app.config ? "idle" : "loading";
  updateConnectionStatus();
  updateBridgeAlert();
  if (focus) {
    elements.memberTitle.focus({ preventScroll: true });
  }
}

function renderFaders() {
  const { minimum, maximum } = app.config.levels;
  const step = Math.max((maximum - minimum) / 1000, 0.0001);
  elements.faderBank.replaceChildren();

  for (const source of app.config.sources) {
    const id = `fader-${safeDomId(source.id)}`;
    const initialValue = app.levels.get(source.id) ?? minimum;

    const card = document.createElement("article");
    card.className = "fader-card";
    card.dataset.sourceId = source.id;

    const output = document.createElement("output");
    output.className = "fader-value";
    output.setAttribute("for", id);
    output.dataset.sourceId = source.id;
    output.textContent = "—";

    const control = document.createElement("div");
    control.className = "fader-control";

    const input = document.createElement("input");
    input.id = id;
    input.className = "fader";
    input.type = "range";
    input.min = String(minimum);
    input.max = String(maximum);
    input.step = String(step);
    input.value = String(initialValue);
    input.disabled = true;
    input.dataset.sourceId = source.id;
    input.setAttribute("orient", "vertical");
    input.setAttribute("aria-orientation", "vertical");
    input.setAttribute("aria-label", `${source.name} level for ${app.selectedMember.name}`);
    input.setAttribute("aria-valuetext", "Loading current level");
    input.addEventListener("pointerdown", () => beginInteraction(source.id));
    input.addEventListener("input", onFaderInput);
    input.addEventListener("change", () => finishInteraction(source.id));
    input.addEventListener("blur", () => finishInteraction(source.id));

    const label = document.createElement("label");
    label.className = "fader-label";
    label.htmlFor = id;
    label.textContent = source.name;
    label.title = source.name;

    control.append(input);
    card.append(output, control, label);
    elements.faderBank.append(card);
    app.renderedLevels.set(source.id, initialValue);
  }
}

function beginInteraction(sourceId) {
  app.draggingSources.add(sourceId);
}

function onFaderInput(event) {
  const input = event.currentTarget;
  const sourceId = input.dataset.sourceId;
  const value = clampToConfiguredRange(Number(input.value));
  if (!sourceId || !Number.isFinite(value)) return;

  app.draggingSources.add(sourceId);
  renderLevel(sourceId, value);
  queueLevelWrite(sourceId, value);
}

function finishAllPointerInteractions() {
  for (const sourceId of [...app.draggingSources]) {
    finishInteraction(sourceId);
  }
}

function finishInteraction(sourceId) {
  if (!app.draggingSources.has(sourceId)) return;
  app.draggingSources.delete(sourceId);
  reconcileSource(sourceId);
}

function queueLevelWrite(sourceId, value) {
  let entry = app.writes.get(sourceId);
  if (!entry) {
    entry = {
      sourceId,
      latest: null,
      timer: null,
      inFlight: false,
      idleResolvers: []
    };
    app.writes.set(sourceId, entry);
  }

  entry.latest = value;
  if (!entry.inFlight && !entry.timer) {
    entry.timer = window.setTimeout(() => sendLatestLevel(entry), WRITE_DELAY_MS);
  }
}

async function sendLatestLevel(entry) {
  if (entry.timer) {
    window.clearTimeout(entry.timer);
    entry.timer = null;
  }

  if (entry.inFlight || entry.latest === null || !app.selectedMember) {
    resolveIdleIfNeeded(entry);
    return;
  }

  const member = app.selectedMember;
  const session = app.session;
  const value = entry.latest;
  entry.latest = null;
  entry.inFlight = true;
  setFaderError(entry.sourceId, false);

  try {
    const payload = await requestJsonWithTimeout(levelUrl(member, entry.sourceId), {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ value })
    }, `Could not update ${sourceName(entry.sourceId)}.`, `Timed out while updating ${sourceName(entry.sourceId)}.`);
    if (session === app.session) {
      consumeAuthoritativePayload(payload, "level");
    }
  } catch (error) {
    if (session === app.session) {
      setFaderError(entry.sourceId, true);
      showError(error.message);
    }
  } finally {
    entry.inFlight = false;
    if (session !== app.session) {
      entry.latest = null;
    } else if (entry.latest !== null) {
      entry.timer = window.setTimeout(() => sendLatestLevel(entry), WRITE_DELAY_MS);
    } else {
      reconcileSource(entry.sourceId);
    }
    resolveIdleIfNeeded(entry);
  }
}

function reconcileSource(sourceId) {
  if (app.draggingSources.has(sourceId) || hasUnsettledWrite(sourceId)) return;
  if (app.levels.has(sourceId)) {
    renderLevel(sourceId, app.levels.get(sourceId));
  }
}

function hasUnsettledWrite(sourceId) {
  const entry = app.writes.get(sourceId);
  return Boolean(entry && (entry.inFlight || entry.timer || entry.latest !== null));
}

function renderLevel(sourceId, value) {
  const input = findFader(sourceId);
  const output = findFaderOutput(sourceId);
  if (!input || !output) return;
  const safeValue = clampToConfiguredRange(value);
  input.value = String(safeValue);
  input.setAttribute("aria-valuetext", formatLevel(safeValue));
  output.value = formatLevel(safeValue);
  output.textContent = formatLevel(safeValue);
  app.renderedLevels.set(sourceId, safeValue);
}

async function refreshMixState(session = app.session) {
  if (!app.selectedMember) return false;
  const member = app.selectedMember;
  const payload = await requestJsonWithTimeout(stateUrl(member), {
    headers: { Accept: "application/json" },
    cache: "no-store"
  }, `Could not load ${member.name}'s current mix.`, `Timed out while loading ${member.name}'s current mix.`);
  if (session !== app.session) return false;
  consumeAuthoritativePayload(payload, "snapshot");
  return true;
}

async function resetMix() {
  if (!app.selectedMember || app.resetInProgress) return;
  const member = app.selectedMember;
  const confirmed = window.confirm(`Reset ${member.name}'s entire mix to its configured starting levels?`);
  if (!confirmed) return;

  app.resetInProgress = true;
  elements.resetMix.disabled = true;
  setFadersDisabled(true);
  clearError();

  try {
    await flushPendingWrites();
    const payload = await requestJsonWithTimeout(resetUrl(member), {
      method: "POST",
      headers: { Accept: "application/json" }
    }, `Could not reset ${member.name}'s mix.`, `Timed out while resetting ${member.name}'s mix.`);
    const applied = consumeAuthoritativePayload(payload, "snapshot");
    if (!applied) {
      await refreshMixState();
    }
    announce(`${member.name}'s mix was reset.`);
  } catch (error) {
    showError(error.message);
  } finally {
    app.resetInProgress = false;
    elements.resetMix.disabled = !app.hasAuthoritativeSnapshot;
    setFadersDisabled(!app.hasAuthoritativeSnapshot);
  }
}

function flushPendingWrites() {
  const waits = [];
  for (const entry of app.writes.values()) {
    if (entry.timer) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
      sendLatestLevel(entry);
    }
    if (entry.inFlight || entry.timer || entry.latest !== null) {
      waits.push(new Promise((resolve) => entry.idleResolvers.push(resolve)));
    }
  }
  return Promise.all(waits);
}

function resolveIdleIfNeeded(entry) {
  if (entry.inFlight || entry.timer || entry.latest !== null) return;
  for (const resolve of entry.idleResolvers.splice(0)) {
    resolve();
  }
}

function connectEventStream(session = app.session) {
  if (!app.selectedMember || session !== app.session) return;
  closeEventStream({ keepReconnectTimer: true });

  const member = app.selectedMember;
  const url = new URL("/api/events", window.location.origin);
  url.searchParams.set("memberId", member.id);
  url.searchParams.set("mixId", member.mixId);

  app.streamState = app.reconnectAttempt > 0 ? "reconnecting" : "connecting";
  updateConnectionStatus();

  const eventSource = new EventSource(url);
  app.eventSource = eventSource;

  eventSource.addEventListener("open", () => {
    if (session !== app.session || eventSource !== app.eventSource) return;
    app.streamState = "open";
    app.reconnectAttempt = 0;
    updateConnectionStatus();
  });

  for (const eventName of ["snapshot", "state", "level", "bridge", "status"]) {
    eventSource.addEventListener(eventName, (event) => handleServerEvent(event, eventName, session));
  }
  eventSource.addEventListener("message", (event) => handleServerEvent(event, "message", session));

  eventSource.addEventListener("error", () => {
    if (session !== app.session || eventSource !== app.eventSource) return;
    eventSource.close();
    app.eventSource = null;
    app.streamState = "reconnecting";
    updateConnectionStatus();
    scheduleReconnect();
  });
}

function handleServerEvent(event, eventName, session) {
  if (session !== app.session) return;
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return;
  }
  consumeAuthoritativePayload(payload, eventName);
}

function consumeAuthoritativePayload(rawPayload, eventName = "message") {
  if (!rawPayload || typeof rawPayload !== "object") return false;
  const envelope = rawPayload;
  const nested = objectValue(envelope.payload) || objectValue(envelope.data) || null;
  const payload = nested ? { ...envelope, ...nested } : envelope;
  const inferredType = String(payload.type || payload.event || eventName || "message").toLowerCase();
  let applied = false;

  if (!payloadMatchesSelectedMix(payload)) return false;

  const bridge = objectValue(payload.bridge);
  if (bridge || inferredType.includes("bridge") || inferredType === "status") {
    const bridgePayload = bridge || payload;
    if (typeof bridgePayload.connected === "boolean" || typeof bridgePayload.state === "string") {
      app.bridge = normalizeBridge(bridgePayload);
      if (!app.bridge.connected) markAuthoritativeSnapshotUnavailable();
      updateConnectionStatus();
      updateBridgeAlert();
      applied = true;
    }
  }

  const levels = objectValue(payload.levels) || objectValue(payload.state)?.levels;
  if (levels && typeof levels === "object") {
    for (const [sourceId, rawValue] of Object.entries(levels)) {
      const value = extractNumericValue(rawValue);
      if (Number.isFinite(value)) {
        applyAuthoritativeLevel(sourceId, value, payload.revision);
        applied = true;
      }
    }
    const completeSnapshot = app.config.sources.every(({ id }) => (
      Object.hasOwn(levels, id) && Number.isFinite(extractNumericValue(levels[id]))
    ));
    if (completeSnapshot) markAuthoritativeSnapshotReady();
  }

  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  for (const change of changes) {
    applied = applyLevelUpdate(change, payload.revision) || applied;
  }

  const level = objectValue(payload.level);
  if (level) {
    applied = applyLevelUpdate(level, payload.revision) || applied;
  }

  applied = applyLevelUpdate(payload, payload.revision) || applied;
  return applied;
}

function applyLevelUpdate(update, fallbackRevision) {
  if (!update || typeof update !== "object") return false;
  const sourceId = update.sourceId || update.source?.id;
  const value = extractNumericValue(update.value ?? update.levelValue ?? update.normalizedValue);
  if (typeof sourceId !== "string" || !Number.isFinite(value)) return false;
  applyAuthoritativeLevel(sourceId, value, update.revision ?? fallbackRevision);
  return true;
}

function applyAuthoritativeLevel(sourceId, value, revision) {
  if (!app.config.sources.some((source) => source.id === sourceId)) return;
  const numericRevision = Number(revision);
  const priorRevision = app.sourceRevisions.get(sourceId);
  if (Number.isFinite(numericRevision) && Number.isFinite(priorRevision) && numericRevision < priorRevision) {
    return;
  }

  const safeValue = clampToConfiguredRange(value);
  app.levels.set(sourceId, safeValue);
  if (Number.isFinite(numericRevision)) {
    app.sourceRevisions.set(sourceId, numericRevision);
  }
  setFaderError(sourceId, false);
  reconcileSource(sourceId);
}

function payloadMatchesSelectedMix(payload) {
  if (!app.selectedMember) return false;
  const memberId = payload.memberId || payload.member?.id;
  const mixId = payload.mixId || payload.mix?.id;
  if (memberId && memberId !== app.selectedMember.id) return false;
  if (mixId && mixId !== app.selectedMember.mixId) return false;
  return true;
}

function scheduleReconnect(delay) {
  if (!app.selectedMember) return;
  if (app.reconnectTimer) window.clearTimeout(app.reconnectTimer);
  const session = app.session;
  const reconnectDelay = delay ?? Math.min(1000 * (2 ** app.reconnectAttempt), MAX_RECONNECT_DELAY_MS);
  app.reconnectAttempt += 1;
  app.reconnectTimer = window.setTimeout(() => {
    app.reconnectTimer = null;
    connectEventStream(session);
  }, reconnectDelay);
}

function closeEventStream(options = {}) {
  if (app.eventSource) {
    app.eventSource.close();
    app.eventSource = null;
  }
  if (!options.keepReconnectTimer && app.reconnectTimer) {
    window.clearTimeout(app.reconnectTimer);
    app.reconnectTimer = null;
  }
}

function updateConnectionStatus() {
  const status = elements.connectionStatus;
  status.classList.remove("is-connected", "is-connecting", "is-disconnected", "is-bridge-down");

  if (app.streamState === "offline") {
    status.classList.add("is-disconnected");
    elements.connectionLabel.textContent = "Disconnected";
    return;
  }

  if (!app.selectedMember && app.streamState === "idle") {
    if (app.bridge.connected) {
      status.classList.add("is-connected");
      elements.connectionLabel.textContent = "Bridge ready";
    } else {
      status.classList.add("is-bridge-down");
      elements.connectionLabel.textContent = "Bridge unavailable";
    }
    return;
  }

  if (app.streamState === "open") {
    if (app.bridge.connected) {
      status.classList.add("is-connected");
      elements.connectionLabel.textContent = "Connected";
    } else {
      status.classList.add("is-bridge-down");
      elements.connectionLabel.textContent = "Bridge unavailable";
    }
    return;
  }

  status.classList.add("is-connecting");
  elements.connectionLabel.textContent = app.streamState === "reconnecting" ? "Reconnecting…" : "Connecting…";
}

function updateBridgeAlert() {
  const show = Boolean(app.selectedMember && !app.bridge.connected);
  elements.bridgeAlert.hidden = !show;
  if (show) {
    elements.bridgeAlertMessage.textContent = app.bridge.message || "Controls will reconnect automatically when the bridge returns.";
  }
}

function normalizeBridge(bridge) {
  const value = bridge && typeof bridge === "object" ? bridge : {};
  const state = typeof value.state === "string" ? value.state.toLowerCase() : "";
  return {
    connected: typeof value.connected === "boolean" ? value.connected : ["connected", "ready", "online"].includes(state),
    message: typeof value.message === "string" ? value.message : ""
  };
}

async function requestJsonWithTimeout(url, options, fallbackMessage, timeoutMessage) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return await readResponse(response, fallbackMessage, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timeoutMessage || "The local server did not respond in time.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function readResponse(response, fallbackMessage, signal) {
  const contentType = response.headers.get("content-type") || "";
  let payload = null;
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (response.ok) {
        throw new Error(`${fallbackMessage} The server returned invalid JSON.`, { cause: error });
      }
      payload = null;
    }
  } else {
    const text = await response.text();
    payload = text ? { message: text } : null;
  }

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload) || `${fallbackMessage} (${response.status})`);
  }
  return payload || {};
}

function extractErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error.message === "string") return payload.error.message;
  return "";
}

function showError(message) {
  elements.errorMessage.textContent = message || "The request could not be completed.";
  elements.errorBanner.hidden = false;
}

function clearError() {
  elements.errorBanner.hidden = true;
  elements.errorMessage.textContent = "";
}

function announce(message) {
  elements.announcement.textContent = "";
  window.setTimeout(() => {
    elements.announcement.textContent = message;
  }, 20);
}

function setFaderError(sourceId, hasError) {
  const card = elements.faderBank.querySelector(`[data-source-id="${cssEscape(sourceId)}"].fader-card`);
  if (card) card.classList.toggle("has-error", hasError);
}

function setFadersDisabled(disabled) {
  for (const input of elements.faderBank.querySelectorAll(".fader")) {
    input.disabled = disabled;
  }
}

function markAuthoritativeSnapshotReady() {
  const usable = app.bridge.connected;
  app.hasAuthoritativeSnapshot = usable;
  clearError();
  elements.faderBank.setAttribute("aria-busy", usable ? "false" : "true");
  elements.resetMix.disabled = !usable || app.resetInProgress;
  setFadersDisabled(!usable || app.resetInProgress);
}

function markAuthoritativeSnapshotUnavailable() {
  app.hasAuthoritativeSnapshot = false;
  app.sourceRevisions.clear();
  app.draggingSources.clear();
  cancelQueuedWrites();
  elements.faderBank.setAttribute("aria-busy", "true");
  elements.resetMix.disabled = true;
  setFadersDisabled(true);
}

function findFader(sourceId) {
  return elements.faderBank.querySelector(`input[data-source-id="${cssEscape(sourceId)}"]`);
}

function findFaderOutput(sourceId) {
  return elements.faderBank.querySelector(`output[data-source-id="${cssEscape(sourceId)}"]`);
}

function clampToConfiguredRange(value) {
  if (!Number.isFinite(value)) return NaN;
  return Math.min(app.config.levels.maximum, Math.max(app.config.levels.minimum, value));
}

function formatLevel(value) {
  const percent = value * 100;
  const rounded = Math.abs(percent) < 10 && !Number.isInteger(percent)
    ? percent.toFixed(1)
    : Math.round(percent).toString();
  return `${rounded}%`;
}

function extractNumericValue(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    return Number(value.value ?? value.normalizedValue);
  }
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

function sourceName(sourceId) {
  return app.config.sources.find((source) => source.id === sourceId)?.name || "source level";
}

function stateUrl(member) {
  return `/api/members/${encodeURIComponent(member.id)}/mixes/${encodeURIComponent(member.mixId)}/state`;
}

function levelUrl(member, sourceId) {
  return `/api/members/${encodeURIComponent(member.id)}/mixes/${encodeURIComponent(member.mixId)}/sources/${encodeURIComponent(sourceId)}`;
}

function resetUrl(member) {
  return `/api/members/${encodeURIComponent(member.id)}/mixes/${encodeURIComponent(member.mixId)}/reset`;
}

function safeDomId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `-${character.codePointAt(0).toString(16)}-`);
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function rememberMember(memberId) {
  try {
    window.localStorage.setItem(MEMBER_STORAGE_KEY, memberId);
  } catch {
    // The app remains usable when storage is disabled or full.
  }
}

function readRememberedMemberId() {
  try {
    return window.localStorage.getItem(MEMBER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function forgetRememberedMember() {
  try {
    window.localStorage.removeItem(MEMBER_STORAGE_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}

function cancelQueuedWrites() {
  for (const entry of app.writes.values()) {
    if (entry.timer) window.clearTimeout(entry.timer);
    entry.timer = null;
    entry.latest = null;
    resolveIdleIfNeeded(entry);
  }
  app.writes.clear();
}
