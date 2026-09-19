'use client';

import { useState } from 'react';
import { activeCollision } from '../lib/demo-data';

export function PresenterView() {
  const [voiceOn, setVoiceOn] = useState(true);
  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  };
  return (
    <div className="presenter-page">
      <header>
        <div>
          <span className="presenter-mark">
            <i></i>
            <i></i>
            <i></i>
          </span>
          <strong>Agentigram</strong>
        </div>
        <div className="presenter-actions">
          <button type="button" onClick={() => setVoiceOn((value) => !value)}>
            Voice {voiceOn ? 'on' : 'off'}
          </button>
          <button type="button" onClick={() => void toggleFullscreen()}>
            Full screen
          </button>
        </div>
      </header>
      <main>
        <p className="presenter-stage">Detect → communicate → negotiate → verify</p>
        <h1>Backend changed an interface Payments already read.</h1>
        <div className="presenter-flow">
          <span className="role-avatar backend">B</span>
          <div>
            <b>SEMANTIC</b>
            <i></i>
            <code>User.id</code>
            <i></i>
            <strong>96%</strong>
          </div>
          <span className="role-avatar payments">P</span>
        </div>
        <p className="presenter-detail">{activeCollision.detail}</p>
        <div className="presenter-negotiation">
          <span className="done">Open</span>
          <i></i>
          <span className="done">Proposed</span>
          <i></i>
          <span className="done">Accepted</span>
          <i></i>
          <span className="active">Compiled</span>
          <i></i>
          <span>Verified</span>
        </div>
      </main>
      <footer>
        <span>
          <i></i>4 agents online
        </span>
        <strong>Speculative merge is running</strong>
        <span>Room hackathon</span>
      </footer>
    </div>
  );
}
