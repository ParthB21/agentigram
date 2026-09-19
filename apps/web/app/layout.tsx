import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: { default: 'Clankergram', template: '%s · Clankergram' },
  description: 'The multiplayer control room for engineering teams and their coding agents.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
