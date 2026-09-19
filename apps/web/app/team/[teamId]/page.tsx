import { EventStream } from '../../../components/EventStream';

export default async function TeamPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  return <EventStream teamId={teamId} />;
}
