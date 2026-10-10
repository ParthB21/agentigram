import { agentBrand, clockTime, frameCategory, initials, speakerForFrame } from './model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

export function createAgentTile(view, onToggleVoice) {
  const tile = element('article', 'agent-tile');
  tile.dataset.sessionId = view.id;

  const top = element('div', 'agent-top');
  const status = element('span', 'agent-state');
  status.append(document.createElement('i'), element('span', '', view.label));
  const voice = element('button', 'agent-voice');
  voice.type = 'button';
  voice.append(icon('volume'));
  voice.addEventListener('click', () => onToggleVoice(view.id));
  top.append(status, voice);

  const avatarWrap = element('div', 'agent-avatar-wrap');
  const avatar = element('span', 'agent-avatar');
  const wave = element('span', 'speech-wave');
  for (let index = 0; index < 5; index += 1) wave.append(document.createElement('i'));
  avatarWrap.append(avatar, wave);

  const name = element('strong', 'agent-name', view.name);
  const model = element('span', 'agent-model', view.host);
  const task = element('div', 'agent-task');
  task.append(element('i', 'task-pulse'), element('span', '', view.task));
  const lease = element('span', 'lease-badge');
  lease.append(icon('lock'), element('span'));

  tile.append(top, avatarWrap, name, model, task, lease);
  tile._agentRefs = {
    avatar,
    status,
    statusText: status.lastElementChild,
    voice,
    voiceUse: voice.querySelector('use'),
    name,
    model,
    task,
    taskText: task.lastElementChild,
    lease,
    leaseText: lease.lastElementChild,
    wave,
  };
  updateAgentTile(tile, view);
  return tile;
}

export function updateAgentTile(tile, view) {
  const refs = tile._agentRefs;
  updateAvatar(refs.avatar, view.brand, view.initials);
  tile.classList.toggle('is-working', view.working && view.speechState === 'idle');
  tile.classList.toggle('is-speaking', view.speechState === 'speaking');
  tile.classList.toggle(
    'is-synthesizing',
    view.speechState === 'synthesizing' || view.speechState === 'queued',
  );
  tile.classList.toggle('is-blocked', view.blocked);
  tile.classList.toggle('is-offline', view.offline);
  tile.classList.toggle('has-collision', Boolean(view.collision));
  tile.setAttribute(
    'aria-label',
    `${view.name}, ${view.label}. ${view.task}${view.muted ? '. Voice muted' : ''}`,
  );

  refs.statusText.textContent = view.label;
  refs.name.textContent = view.name;
  refs.model.textContent = view.host;
  refs.model.hidden = !view.host;
  refs.taskText.textContent = view.task;
  refs.task.title = view.intent || view.task;
  refs.voice.setAttribute('aria-label', `${view.muted ? 'Enable' : 'Mute'} ${view.name}'s voice`);
  refs.voice.setAttribute('aria-pressed', String(view.muted));
  refs.voice.title = `${view.muted ? 'Enable' : 'Mute'} ${view.name}'s voice`;
  refs.voiceUse.setAttribute('href', view.muted ? '#icon-volume-off' : '#icon-volume');
  refs.voice.classList.toggle('muted', view.muted);

  const leaseCount = view.leases.length;
  refs.lease.hidden = leaseCount === 0;
  refs.leaseText.textContent = `${leaseCount} lease${leaseCount === 1 ? '' : 's'}`;
}

export function setTileEnergy(tile, energy) {
  const bars = tile?._agentRefs?.wave?.children;
  if (!bars) return;
  for (let index = 0; index < bars.length; index += 1) {
    const variation = 0.55 + ((index * 7 + Math.round(energy * 10)) % 6) / 10;
    bars[index].style.height = `${Math.round(4 + energy * variation * 10)}px`;
  }
}

export function createDialogueLine(frame, agent) {
  const speaker = speakerForFrame(frame);
  const item = element('li', 'dialogue-line');
  item.dataset.seq = String(frame.seq ?? '');
  item.dataset.speaker = speaker;

  const avatar = element('span', 'dialogue-avatar');
  updateAvatar(avatar, agentBrand(agent), initials(speaker));
  const body = element('div', 'dialogue-body');
  const meta = element('div', 'dialogue-meta');
  meta.append(element('strong', '', titleCase(speaker)), element('time', '', clockTime()));
  body.append(meta, element('div', 'dialogue-bubble', frame.speech?.text || frame.text || ''));
  item.append(avatar, body);
  return item;
}

export function createActivityLine(frame) {
  const category = frameCategory(frame.eventType);
  const item = element('li', `activity-line ${category}`);
  item.dataset.seq = String(frame.seq ?? '');
  const body = element('div', 'activity-copy');
  body.append(
    element('span', 'activity-kind', String(frame.eventType || 'EVENT').replaceAll('_', ' ')),
    element('span', 'activity-text', frame.text || ''),
  );
  item.append(
    element('span', 'activity-dot'),
    body,
    element('span', 'activity-seq', frame.seq != null ? `#${frame.seq}` : ''),
  );
  return item;
}

export function flashTile(tile) {
  if (!tile || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  tile.animate(
    [
      { backgroundColor: 'rgba(255, 255, 255, 0.12)' },
      { backgroundColor: 'rgba(255, 255, 255, 0)' },
    ],
    { duration: 900, easing: 'cubic-bezier(.16,1,.3,1)' },
  );
}

export function animateEntry(node) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  node.animate(
    [
      { opacity: 0, transform: 'translateY(16px) scale(.94)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ],
    { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
  );
}

export function animateExit(node, onFinish) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return onFinish();
  const animation = node.animate(
    [
      { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' },
      { opacity: 0, transform: 'scale(.92)', filter: 'blur(6px)' },
    ],
    { duration: 240, easing: 'ease-in', fill: 'forwards' },
  );
  animation.finished.then(onFinish, onFinish);
}

export function animateReflow(nodes, previousRects) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const node of nodes) {
    const previous = previousRects.get(node.dataset.sessionId);
    if (!previous) continue;
    const next = node.getBoundingClientRect();
    const deltaX = previous.left - next.left;
    const deltaY = previous.top - next.top;
    const scaleX = next.width ? previous.width / next.width : 1;
    const scaleY = next.height ? previous.height / next.height : 1;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1 && Math.abs(scaleX - 1) < 0.01) continue;
    node.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})` },
        { transform: 'translate(0, 0) scale(1)' },
      ],
      { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
  }
}

function element(tag, className = '', value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function updateAvatar(avatar, brand, fallback) {
  if (!brand) {
    avatar.textContent = fallback;
    delete avatar.dataset.brand;
    return;
  }
  if (avatar.dataset.brand === brand) return;
  const image = document.createElement('img');
  image.src = `assets/${brand}.svg`;
  image.alt = `${displayBrand(brand)} logo`;
  avatar.replaceChildren(image);
  avatar.dataset.brand = brand;
}

function displayBrand(brand) {
  return brand === 'claude' ? 'Claude' : brand === 'codex' ? 'Codex' : 'Gemini';
}

function titleCase(value) {
  return String(value)
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
