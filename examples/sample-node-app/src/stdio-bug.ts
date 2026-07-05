// Bug: accumulator adds an extra +1 per value (total += v + 1) instead
// of total += v, so the printed total comes out too high (15 → 20 on
// [1,2,3,4,5]). The wrong total is printed via process.stdout.write
// (RAW stdio, NOT console.log) so get_node_output captures it but
// get_console_logs does NOT — channel-separation contract for
// node-output.e2e.test.ts and the output-buffer uniqueness signal for the
// L4 node-stdio-bug scenario.

function accumulate(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total += v + 1;
  }
  return total;
}

function main(): void {
  const values = [1, 2, 3, 4, 5];
  const total = accumulate(values);
  process.stdout.write(`total: ${total}\n`);
}

main();

export {};
