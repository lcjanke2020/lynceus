// Minimal module worker for the L3 worker e2e spec. Listens for a message,
// replies with a derived value. Source maps emit normally for module workers
// under Vite, so source-mapped breakpoints land here just like in main.ts.

interface ComputeMsg {
  kind: "compute";
  count: number;
}
interface InitMsg {
  kind: "init";
}
type Msg = ComputeMsg | InitMsg;

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.kind === "init") {
    self.postMessage("ready");
    return;
  }
  if (msg.kind === "compute") {
    const tripled = triple(msg.count);
    self.postMessage(`tripled=${tripled}`);
  }
};

function triple(n: number): number {
  return n * 3;
}
