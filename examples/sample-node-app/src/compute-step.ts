// Bug: computeStep should return 1 but returns 2 (off-by-one).
// Frame chain: main() -> tick() -> computeStep(). Drives the L3
// node-stepping e2e test: bp on tick()'s call to computeStep(),
// then step_into / step_over / step_out across the chain.

function computeStep(): number {
  const step = 2;
  return step;
}

function tick(counter: number): number {
  const step = computeStep();
  const next = counter + step;
  process.stdout.write(`tick: ${counter} -> ${next}\n`);
  return next;
}

function main(): void {
  let counter = 0;
  for (let i = 0; i < 3; i++) {
    counter = tick(counter);
  }
}

main();

export {};
