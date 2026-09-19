import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: 16 }}>
      <h1>Clankergram</h1>
      <p>
        Open a room, e.g. <Link href="/team/hackathon">/team/hackathon</Link>.
      </p>
    </main>
  );
}
