import { TimelineView } from '../../../../components/TimelineView';

export default async function TimelinePage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  return <TimelineView teamId={teamId} />;
}
