const elements = {
  connection: document.querySelector('#connection'),
  room: document.querySelector('#room'),
  headline: document.querySelector('#headline'),
  summary: document.querySelector('#summary'),
  agents: document.querySelector('#agents'),
  issue: document.querySelector('#issue'),
  issueTitle: document.querySelector('#issue-title'),
  issueDetail: document.querySelector('#issue-detail'),
  inviteRow: document.querySelector('#invite-row'),
  invite: document.querySelector('#invite'),
  copy: document.querySelector('#copy'),
  sequence: document.querySelector('#sequence'),
  dashboard: document.querySelector('#dashboard'),
};

function render(status) {
  const connected = status.transport === 'connected';
  elements.connection.textContent = connected
    ? 'Connected'
    : status.transport === 'read-only'
      ? 'Authority offline'
      : 'Disconnected';
  elements.connection.parentElement.classList.toggle('offline', !connected);
  elements.room.textContent = status.roomId
    ? `${status.roomId} · ${status.mode === 'authority' ? 'Authority laptop' : 'Peer laptop'}`
    : 'Local room';

  const agents = Array.isArray(status.agents) ? status.agents : [];
  const collisions = Array.isArray(status.collisions) ? status.collisions : [];
  elements.headline.textContent = collisions.length
    ? `${collisions.length} coordination issue${collisions.length === 1 ? '' : 's'}`
    : agents.length
      ? 'Agents are working together'
      : 'Waiting for an agent session';
  elements.summary.textContent = status.error
    ? status.error
    : `${agents.length} agent${agents.length === 1 ? '' : 's'} visible · ${status.leases?.length ?? 0} active lease${status.leases?.length === 1 ? '' : 's'}`;

  elements.agents.replaceChildren(
    ...agents.map((agent) => {
      const node = document.createElement('span');
      node.className = 'agent';
      node.textContent = `${agent.role || agent.sessionId} · ${agent.host}`;
      return node;
    }),
  );

  const issue = collisions[0];
  elements.issue.hidden = !issue;
  if (issue) {
    elements.issueTitle.textContent = issue.tier.replaceAll('_', ' ').toLowerCase();
    elements.issueDetail.textContent = issue.detail;
  }

  elements.inviteRow.hidden = !status.invite;
  elements.invite.textContent = status.invite || '';
  elements.sequence.textContent = status.lastSeq ? `Event ${status.lastSeq}` : 'No events yet';
}

elements.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(elements.invite.textContent);
  elements.copy.textContent = 'Copied';
  setTimeout(() => {
    elements.copy.textContent = 'Copy invite';
  }, 1200);
});
elements.dashboard.addEventListener('click', () => window.agentigram.openDashboard());

window.agentigram.getStatus().then(render);
window.agentigram.subscribeToEvents(render);
