import {
  animateEntry,
  animateExit,
  animateReflow,
  createActivityLine,
  createAgentTile,
  createDialogueLine,
  flashTile,
  setTileEnergy,
  updateAgentTile,
} from './components.js';
import {
  deriveAgentView,
  displayName,
  latestCollision,
  negotiationFor,
  speakerForFrame,
  symbolName,
} from './model.js';
import { SpeechQueue } from './speech.js';

const MAX_ACTIVITY = 180;
const MAX_DIALOGUE = 80;
document.body.dataset.platform = window.agentigram.platform || 'unknown';
const elements = Object.fromEntries(
  [
    'roomName',
    'roomId',
    'mode',
    'link',
    'counts',
    'meetingClock',
    'agentStage',
    'emptyRoom',
    'liveCaption',
    'captionSpeaker',
    'captionText',
    'collisionBanner',
    'collisionTier',
    'collisionHeadline',
    'collisionSummary',
    'reviewCollision',
    'inspector',
    'closeInspector',
    'conversationTab',
    'activityTab',
    'conversationPanel',
    'activityPanel',
    'dialogue',
    'feed',
    'emptyConversation',
    'collisionPanel',
    'negotiationAgents',
    'negotiationTier',
    'negotiationDetail',
    'contractDiff',
    'contractSymbol',
    'contractBefore',
    'contractAfter',
    'contractConstraint',
    'acceptCollision',
    'escalateCollision',
    'actionNote',
    'voiceMode',
    'voiceModeLabel',
    'voiceIconUse',
    'volume',
    'captionsToggle',
    'layoutToggle',
    'presentToggle',
    'detailsToggle',
    'toasts',
    'confirmDialog',
    'confirmTitle',
    'confirmText',
    'confirmAction',
  ].map((id) => [id, document.getElementById(id)]),
);

const room = {
  state: null,
  tiles: new Map(),
  seen: new Set(),
  speechStates: new Map(),
  frames: [],
  dialogueFrames: [],
  speechFloor: null,
  captions: true,
  focusLayout: false,
  startedAt: Date.now(),
  currentCollision: null,
};

const speech = new SpeechQueue({
  onState: updateSpeechState,
  onBoundary: ({ speaker, energy }) => setTileEnergy(room.tiles.get(speaker), energy),
  onError: (error) => showToast(error.message, 'error'),
});

elements.volume.value = String(speech.volume);
renderVoiceMode();
bindControls();
startClock();

const unsubscribeFrames = window.agentigram.subscribeToFrames((frame) => {
  if (!frame || typeof frame !== 'object') return;
  if (frame.t === 'state') applyState(frame.state);
  if (frame.t === 'event') applyEvent(frame);
});

const unsubscribeStatus = window.agentigram.subscribeToEvents((state) => applyState(state));

window.agentigram
  .getStatus()
  .then((state) => applyState(state))
  .catch((error) => showToast(error.message || 'Could not reach the local daemon', 'error'));

window.addEventListener('beforeunload', () => {
  unsubscribeFrames?.();
  unsubscribeStatus?.();
  speech.close();
});

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  room.state = state;
  if (room.speechFloor === null && Number.isFinite(state.lastSeq)) room.speechFloor = state.lastSeq;
  speech.setLocalSession(state.sessionId);
  speech.setVoiceAll(state.mode === 'authority');
  renderHeader(state);
  renderAgents();
  renderCollision(state);
}

function applyEvent(frame) {
  if (frame.seq != null && room.seen.has(frame.seq)) return;
  if (frame.seq != null) room.seen.add(frame.seq);
  room.frames.push(frame);
  if (room.frames.length > MAX_ACTIVITY) room.frames.splice(0, room.frames.length - MAX_ACTIVITY);

  const activityNode = createActivityLine(frame);
  elements.feed.append(activityNode);
  trimChildren(elements.feed, MAX_ACTIVITY);
  elements.feed.parentElement.scrollTop = elements.feed.parentElement.scrollHeight;

  if (frame.speech) {
    room.dialogueFrames.push(frame);
    if (room.dialogueFrames.length > MAX_DIALOGUE) {
      room.dialogueFrames.splice(0, room.dialogueFrames.length - MAX_DIALOGUE);
    }
    const line = createDialogueLine(frame);
    elements.dialogue.append(line);
    trimChildren(elements.dialogue, MAX_DIALOGUE);
    elements.emptyConversation.hidden = true;
    elements.dialogue.parentElement.scrollTop = elements.dialogue.parentElement.scrollHeight;

    if (room.speechFloor !== null && frame.seq > room.speechFloor) {
      speech.enqueue({
        seq: frame.seq,
        speaker: speakerForFrame(frame),
        text: frame.speech.text,
        priority: frame.speech.priority,
      });
    }
  }

  const tile = room.tiles.get(frame.speech ? speakerForFrame(frame) : frame.sessionId);
  if (tile) flashTile(tile);
}

function renderHeader(state) {
  const connected = state.transport === 'connected';
  const connectionText = connected ? 'Connected' : state.transport || 'Offline';
  elements.roomId.textContent = state.roomId || 'Agent room';
  elements.roomName.textContent = state.sessionId
    ? `${displayName(state.sessionId)} workspace`
    : 'Agent room';
  elements.mode.textContent = state.mode || '';
  elements.mode.hidden = !state.mode;
  elements.link.className = `connection-pill ${connected ? 'connected' : 'offline'}`;
  elements.link.lastElementChild.textContent = titleCase(connectionText);

  const summary = state.summary;
  const agentCount = (state.agents ?? []).length;
  const active = summary?.activeSessions ?? agentCount;
  const collisions = summary?.openCollisions ?? (state.collisions ?? []).length;
  const leases = summary?.activeLeases ?? (state.leases ?? []).length;
  elements.counts.textContent = `${active} active / ${agentCount} joined / ${collisions} collision${collisions === 1 ? '' : 's'} / ${leases} lease${leases === 1 ? '' : 's'}`;
}

function renderAgents() {
  const state = room.state;
  if (!state) return;
  const agents = state.agents ?? [];
  const activeIds = new Set(agents.map((agent) => agent.sessionId));
  const previousRects = new Map(
    [...room.tiles.entries()].map(([id, tile]) => [id, tile.getBoundingClientRect()]),
  );

  for (const [id, tile] of room.tiles) {
    if (activeIds.has(id) || tile.dataset.leaving === 'true') continue;
    tile.dataset.leaving = 'true';
    animateExit(tile, () => {
      tile.remove();
      room.tiles.delete(id);
    });
  }

  for (const agent of agents) {
    const id = agent.sessionId;
    const speechState = room.speechStates.get(id)?.state ?? 'idle';
    const view = deriveAgentView(state, agent, speechState, speech.isMuted(id));
    let tile = room.tiles.get(id);
    if (!tile) {
      tile = createAgentTile(view, toggleAgentVoice);
      room.tiles.set(id, tile);
      elements.agentStage.append(tile);
      animateEntry(tile);
    } else {
      tile.dataset.leaving = 'false';
      updateAgentTile(tile, view);
      elements.agentStage.append(tile);
    }
  }

  elements.emptyRoom.hidden = agents.length > 0;
  elements.agentStage.dataset.count = String(Math.min(agents.length, 4));
  elements.agentStage.classList.toggle('focus-layout', room.focusLayout);
  requestAnimationFrame(() => animateReflow([...room.tiles.values()], previousRects));
}

function renderCollision(state) {
  const collision = latestCollision(state);
  room.currentCollision = collision ?? null;
  const hasCollision = Boolean(collision);
  elements.collisionBanner.hidden = !hasCollision;
  elements.collisionPanel.hidden = !hasCollision;
  document.body.classList.toggle('has-collision', hasCollision);
  if (!collision) return;

  const affected = [collision.writerSession, ...(collision.affectedSessions ?? [])];
  const people = affected.map(displayName).join(' and ');
  const symbols = (collision.symbols ?? []).map(symbolName).join(', ');
  const tier = titleCase(String(collision.tier || 'collision').replaceAll('_', ' '));
  const negotiation = negotiationFor(state, collision.collisionId);
  const contract = negotiation?.contract;

  elements.collisionTier.textContent = tier;
  elements.collisionHeadline.textContent = `${people} need alignment`;
  elements.collisionSummary.textContent = symbols || collision.detail || 'Shared code is changing';
  elements.negotiationAgents.textContent = people;
  elements.negotiationTier.textContent = tier;
  elements.negotiationDetail.textContent =
    collision.detail || 'The agents are resolving overlapping work.';
  elements.contractDiff.hidden = !contract;
  if (contract) {
    elements.contractSymbol.textContent = contract.symbol || symbols;
    elements.contractBefore.textContent = contract.before || 'current contract';
    elements.contractAfter.textContent = contract.after || 'proposed contract';
    elements.contractConstraint.textContent = contract.constraint || contract.migration || '';
    elements.contractConstraint.hidden = !elements.contractConstraint.textContent;
  }

  const authority = state.mode === 'authority';
  elements.acceptCollision.disabled = !authority;
  elements.escalateCollision.disabled = !authority;
  elements.actionNote.textContent = authority
    ? negotiation?.state
      ? `Negotiation is ${String(negotiation.state).toLowerCase()}.`
      : 'The room authority can make a human decision.'
    : 'Human decisions are available on the authority laptop.';
  renderAgents();
}

function updateSpeechState(event) {
  const { speaker, state } = event;
  if (!speaker) return;
  if (state === 'idle' || state === 'muted') room.speechStates.delete(speaker);
  else room.speechStates.set(speaker, event);

  for (const line of elements.dialogue.querySelectorAll('.dialogue-line.speaking')) {
    line.classList.remove('speaking');
  }
  if (state === 'speaking') {
    const line = elements.dialogue.querySelector(`[data-seq="${event.seq}"]`);
    line?.classList.add('speaking');
    if (room.captions) {
      elements.captionSpeaker.textContent = displayName(speaker);
      elements.captionText.textContent = event.text || '';
      elements.liveCaption.hidden = false;
    }
  } else if (!speech.current) {
    elements.liveCaption.hidden = true;
  }
  renderAgents();
}

function toggleAgentVoice(sessionId) {
  const muted = speech.toggleMute(sessionId);
  renderAgents();
  showToast(`${displayName(sessionId)} voice ${muted ? 'muted' : 'enabled'}.`);
}

function bindControls() {
  elements.voiceMode.addEventListener('click', () => {
    const mode = speech.cycleMode();
    renderVoiceMode();
    showToast(
      mode === 'off'
        ? 'Voice is off.'
        : mode === 'lively'
          ? 'Lively voice mode enabled.'
          : 'Normal voice mode enabled.',
    );
  });
  elements.volume.addEventListener('input', (event) => speech.setVolume(event.target.value));
  elements.captionsToggle.addEventListener('click', () => {
    room.captions = !room.captions;
    elements.captionsToggle.classList.toggle('active', room.captions);
    elements.captionsToggle.setAttribute('aria-pressed', String(room.captions));
    if (!room.captions) elements.liveCaption.hidden = true;
    else if (speech.current) updateSpeechState({ ...speech.current, state: 'speaking' });
  });
  elements.layoutToggle.addEventListener('click', () => {
    room.focusLayout = !room.focusLayout;
    elements.layoutToggle.classList.toggle('active', room.focusLayout);
    renderAgents();
  });
  elements.presentToggle.addEventListener('click', togglePresentation);
  elements.detailsToggle.addEventListener('click', () => elements.inspector.classList.add('open'));
  elements.closeInspector.addEventListener('click', () =>
    elements.inspector.classList.remove('open'),
  );
  elements.reviewCollision.addEventListener('click', () => {
    elements.inspector.classList.add('open');
    elements.collisionPanel.scrollIntoView({ behavior: 'smooth', block: 'end' });
  });
  elements.conversationTab.addEventListener('click', () => selectInspectorTab('conversation'));
  elements.activityTab.addEventListener('click', () => selectInspectorTab('activity'));
  elements.acceptCollision.addEventListener('click', () => runCollisionAction('accept'));
  elements.escalateCollision.addEventListener('click', () => runCollisionAction('escalate'));
}

function selectInspectorTab(tab) {
  const activity = tab === 'activity';
  elements.conversationTab.setAttribute('aria-selected', String(!activity));
  elements.activityTab.setAttribute('aria-selected', String(activity));
  elements.conversationPanel.hidden = activity;
  elements.activityPanel.hidden = !activity;
  elements.conversationTab.parentElement.classList.toggle('activity-selected', activity);
}

async function togglePresentation() {
  const next = !document.body.classList.contains('presenting');
  document.body.classList.toggle('presenting', next);
  elements.presentToggle.classList.toggle('active', next);
  try {
    if (next && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!next && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    showToast('Presentation layout enabled. Full screen was unavailable.');
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    document.body.classList.remove('presenting');
    elements.presentToggle.classList.remove('active');
  }
});

async function runCollisionAction(kind) {
  const collision = room.currentCollision;
  if (!collision) return;
  const accepting = kind === 'accept';
  const confirmed = await askConfirmation(
    accepting ? 'Accept this resolution?' : 'Escalate to a human decision?',
    accepting
      ? 'This records a human acceptance for the active collision and allows the contract workflow to continue.'
      : 'This pauses automatic negotiation and marks the collision as requiring human review.',
    accepting ? 'Accept resolution' : 'Escalate',
  );
  if (!confirmed) return;

  elements.acceptCollision.disabled = true;
  elements.escalateCollision.disabled = true;
  const action = accepting
    ? { type: 'accept_escalation', collisionId: collision.collisionId }
    : {
        type: 'escalate',
        collisionId: collision.collisionId,
        reason: 'Human review requested from the Agentigram desktop room.',
      };
  try {
    const result = await window.agentigram.submitHumanAction(action);
    if (!result?.ok) throw new Error(result?.error || 'The daemon rejected the action');
    showToast(accepting ? 'Resolution accepted.' : 'Collision escalated for human review.');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
    elements.acceptCollision.disabled = room.state?.mode !== 'authority';
    elements.escalateCollision.disabled = room.state?.mode !== 'authority';
  }
}

function askConfirmation(title, text, actionLabel) {
  elements.confirmTitle.textContent = title;
  elements.confirmText.textContent = text;
  elements.confirmAction.textContent = actionLabel;
  elements.confirmDialog.returnValue = '';
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener(
      'close',
      () => resolve(elements.confirmDialog.returnValue === 'confirm'),
      { once: true },
    );
  });
}

function renderVoiceMode() {
  const mode = speech.mode;
  elements.voiceMode.classList.toggle('voice-off', mode === 'off');
  elements.voiceMode.classList.toggle('active', mode !== 'off');
  elements.voiceIconUse.setAttribute('href', mode === 'off' ? '#icon-volume-off' : '#icon-volume');
  elements.voiceModeLabel.textContent =
    mode === 'off' ? 'Voice off' : mode === 'lively' ? 'Lively' : 'Voice on';
}

function showToast(message, kind = 'normal') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  elements.toasts.append(toast);
  window.setTimeout(() => {
    toast.classList.add('leaving');
    window.setTimeout(() => toast.remove(), 220);
  }, 3200);
}

function startClock() {
  const update = () => {
    const elapsed = Math.max(0, Date.now() - room.startedAt);
    const minutes = Math.floor(elapsed / 60_000);
    const seconds = Math.floor((elapsed % 60_000) / 1000);
    elements.meetingClock.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };
  update();
  window.setInterval(update, 1000);
}

function trimChildren(parent, maximum) {
  while (parent.childElementCount > maximum) parent.firstElementChild?.remove();
}

function titleCase(value) {
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
