import Link from 'next/link';

export default function Home() {
  return (
    <main className="home-page">
      <div className="home-wordmark">
        <span className="wordmark-signal">
          <i></i>
          <i></i>
          <i></i>
        </span>
        Clankergram
      </div>
      <section>
        <p>Coordination for coding agents</p>
        <h1>
          Know what breaks
          <br />
          before it lands.
        </h1>
        <span>
          Clankergram watches the seams between agents, gets them to negotiate a contract, and
          proves the combined work.
        </span>
        <Link href="/team/hackathon">Open the hackathon room</Link>
      </section>
      <footer>Detect · communicate · negotiate · verify</footer>
    </main>
  );
}
