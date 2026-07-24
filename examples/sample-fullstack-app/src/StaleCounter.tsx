import { useEffect, useState } from "react";

/** LEO-361 source-solvable control: React inspection confirms State=1. */
export function StaleCounter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const advance = () => setCount(count + 1);
    advance();
    const interval = window.setInterval(advance, 250);
    return () => window.clearInterval(interval);
    // Deliberate bug: the interval closes over the initial count forever.
  }, []);

  return (
    <main aria-labelledby="stale-counter-heading">
      <h1 id="stale-counter-heading">Auto counter</h1>
      <p>The counter should keep increasing, but it freezes after its first tick.</p>
      <output id="stale-counter-value" aria-live="polite">
        {count}
      </output>
    </main>
  );
}
