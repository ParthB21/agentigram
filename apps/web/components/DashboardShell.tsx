'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const views = [
  { path: '', label: 'Room', glyph: '⌘' },
  { path: '/timeline', label: 'Timeline', glyph: '≋' },
  { path: '/collisions', label: 'Collisions', glyph: '⌁' },
  { path: '/contracts', label: 'Contracts', glyph: '✓' },
  { path: '/models', label: 'Models', glyph: '◫' },
  { path: '/league', label: 'League', glyph: '◇' },
  { path: '/present', label: 'Present', glyph: '▶' },
];

export function DashboardShell({ teamId, children }: { teamId: string; children: ReactNode }) {
  const pathname = usePathname();
  const base = `/team/${encodeURIComponent(teamId)}`;
  return (
    <div className={pathname.endsWith('/present') ? 'app-shell presenting' : 'app-shell'}>
      <aside className="rail">
        <Link className="wordmark" href={base} aria-label="Agentigram room">
          <span className="wordmark-signal">
            <i></i>
            <i></i>
            <i></i>
          </span>
          <span>Agentigram</span>
        </Link>
        <nav aria-label="Room views">
          {views.map((view) => {
            const href = `${base}${view.path}`;
            const active = pathname === href;
            return (
              <Link
                className={active ? 'nav-link active' : 'nav-link'}
                href={href}
                key={view.label}
              >
                <span aria-hidden="true">{view.glyph}</span>
                {view.label}
              </Link>
            );
          })}
        </nav>
        <div className="rail-status">
          <i></i>
          <span>
            <strong>Local room</strong>
            <small>{teamId}</small>
          </span>
        </div>
      </aside>
      <main className="main-canvas">{children}</main>
    </div>
  );
}
