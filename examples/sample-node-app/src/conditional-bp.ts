// Bug: processIteration() takes the wrong branch when i === 3,
// returning i*10 instead of i. Drives the L3 node-conditional-bp
// e2e test: a conditional breakpoint with condition "i === 3" must
// fire only on the matching iteration, not on the four other
// iterations of the loop.

function processIteration(i: number): number {
  if (i === 3) {
    return i * 10;
  }
  return i;
}

function main(): void {
  for (let i = 0; i < 5; i++) {
    const v = processIteration(i);
    process.stdout.write(`i=${i} v=${v}\n`);
  }
}

main();

export {};
