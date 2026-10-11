const ACTIVE_WORDS = [
  'reading',
  'editing',
  'looking',
  'running',
  'planning',
  'claiming',
  'proposing',
  'countering',
  'accepting',
  'messaging',
  'starting',
  'wrapping',
];

export function displayName(value) {
  const source = String(value || 'agent').trim();
  return source
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function initials(value) {
  const parts = displayName(value).split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts.at(-1)[0]}`.toUpperCase();
}

export function symbolName(key) {
  const value = String(key || '');
  const hash = value.indexOf('#');
  if (hash < 0) return value;
  const rest = value.slice(hash + 1);
  const colon = rest.lastIndexOf(':');
  return colon < 0 ? rest : rest.slice(0, colon);
}

export function speakerForFrame(frame) {
  return frame?.speech?.speaker || frame?.sessionId || 'agentigram';
}

export function latestCollision(state) {
  return [...(state?.collisions ?? [])]
    .filter((collision) => collision.status !== 'resolved')
    .sort((left, right) => (right.openedSeq ?? 0) - (left.openedSeq ?? 0))[0];
}

export function negotiationFor(state, collisionId) {
  return (state?.negotiations ?? []).find((negotiation) => negotiation.collisionId === collisionId);
}

export function deriveAgentView(state, agent, speechState = 'idle', muted = false) {
  const id = agent.sessionId;
  const presence = state?.presence?.[id] ?? 'live';
  const activity = state?.activity?.[id];
  const leases = (state?.leases ?? []).filter((lease) => lease.sessionId === id);
  const collision = (state?.collisions ?? []).find(
    (candidate) =>
      candidate.status !== 'resolved' &&
      (candidate.writerSession === id || candidate.affectedSessions?.includes(id)),
  );
  const offline = presence !== 'live' || agent.status === 'ended';
  const task = offline ? 'Offline' : activity?.what || 'Ready and listening';
  const lowerTask = task.toLowerCase();
  const blocked = lowerTask.includes('blocked') || lowerTask.includes('denied');
  const working = !offline && ACTIVE_WORDS.some((word) => lowerTask.startsWith(word));

  let label = offline ? 'Offline' : working ? 'Working' : 'Ready';
  if (collision) label = 'In negotiation';
  if (blocked) label = 'Blocked';
  if (speechState === 'queued') label = 'Waiting to speak';
  if (speechState === 'synthesizing') label = 'Preparing voice';
  if (speechState === 'speaking') label = 'Speaking';

  return {
    id,
    name: displayName(id),
    initials: initials(id),
    brand: agentBrand(agent),
    host: agentRuntime(agent),
    task,
    intent: activity && agent.intent?.task !== activity.what ? agent.intent?.task : undefined,
    leases,
    collision,
    offline,
    blocked,
    working,
    speechState,
    muted,
    label,
  };
}

export function agentBrand(agent) {
  const host = String(agent?.host ?? '').toLowerCase();
  if (host.startsWith('claude')) return 'claude';
  if (host.startsWith('codex')) return 'codex';
  if (host.startsWith('gemini')) return 'gemini';
  return null;
}

function agentRuntime(agent) {
  return [agent.host, agent.model]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && value.toLowerCase() !== 'unknown')
    .join(' / ');
}

export function frameCategory(eventType) {
  if (eventType === 'COLLISION' || eventType === 'ESCALATE') return 'collision';
  if (String(eventType).startsWith('LEASE_')) return 'lease';
  return 'normal';
}

export function clockTime(value = Date.now()) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}
