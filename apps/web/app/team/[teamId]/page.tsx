import { RoomView } from '../../../components/RoomView';

export default async function TeamPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  return <RoomView teamId={teamId} />;
}
