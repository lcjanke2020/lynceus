// Bug: uncaught TypeError reading .foo on a null reference,
// thrown inside main() -> processItem() on the second iteration.
// Drives the L3 node-exceptions e2e test: set_pause_on_exceptions
// must be installed at the entry pause, BEFORE the first resume,
// because once main() releases the throw lands and the process exits.

function processItem(item: { foo: string } | null): string {
  return item!.foo;
}

function main(): void {
  const items: Array<{ foo: string } | null> = [{ foo: "ok" }, null];
  for (const item of items) {
    processItem(item);
  }
}

main();

export {};
