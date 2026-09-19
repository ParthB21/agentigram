import { CollisionView } from '../../../../components/CollisionView';

export default async function CollisionsPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  return <CollisionView teamId={teamId} />;
}
