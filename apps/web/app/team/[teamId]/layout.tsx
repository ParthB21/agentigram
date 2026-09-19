import type { ReactNode } from 'react';
import { DashboardShell } from '../../../components/DashboardShell';

const deployedTeamId = 'hackathon';

export function generateStaticParams() {
  return [{ teamId: deployedTeamId }];
}

export default async function TeamLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <DashboardShell teamId={teamId}>{children}</DashboardShell>;
}
