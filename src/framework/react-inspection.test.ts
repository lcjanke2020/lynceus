import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactInspectionCoordinator } from "./react-inspection.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ReactInspectionCoordinator", () => {
  it("registers before dispatch and serves a cached full value for no-change", async () => {
    const coordinator = new ReactInspectionCoordinator();
    const first = await coordinator.request(
      {
        rendererId: 1,
        componentId: 2,
        path: null,
        forceFullData: true,
        timeoutMs: 100,
      },
      async (requestId) => {
        expect(
          coordinator.handle({
            id: 2,
            responseID: requestId,
            type: "full-data",
            value: { id: 2, props: { data: {}, cleaned: [], unserializable: [] } },
          }),
        ).toBe(true);
      },
    );
    expect(first.kind).toBe("full-data");

    const second = await coordinator.request(
      {
        rendererId: 1,
        componentId: 2,
        path: null,
        forceFullData: false,
        timeoutMs: 100,
      },
      async (requestId) => {
        coordinator.handle({ id: 2, responseID: requestId, type: "no-change" });
      },
    );
    expect(second).toEqual(first.kind === "full-data" ? { ...first, kind: "no-change" } : first);
  });

  it("correlates concurrent replies by request id even when they arrive out of order", async () => {
    const coordinator = new ReactInspectionCoordinator();
    const requestIds: number[] = [];
    const request = (componentId: number) =>
      coordinator.request(
        {
          rendererId: 1,
          componentId,
          path: null,
          forceFullData: true,
          timeoutMs: 100,
        },
        async (requestId) => {
          requestIds.push(requestId);
        },
      );
    const first = request(2);
    const second = request(3);
    await Promise.resolve();

    coordinator.handle({
      id: 3,
      responseID: requestIds[1],
      type: "full-data",
      value: { id: 3 },
    });
    coordinator.handle({
      id: 2,
      responseID: requestIds[0],
      type: "full-data",
      value: { id: 2 },
    });
    await expect(first).resolves.toMatchObject({ value: { id: 2 } });
    await expect(second).resolves.toMatchObject({ value: { id: 3 } });
  });

  it("rejects malformed correlated replies and cancels pending work on reset", async () => {
    const coordinator = new ReactInspectionCoordinator();
    let malformedRequestId = 0;
    const malformed = coordinator.request(
      {
        rendererId: 1,
        componentId: 2,
        path: null,
        forceFullData: true,
        timeoutMs: 100,
      },
      async (requestId) => {
        malformedRequestId = requestId;
      },
    );
    await Promise.resolve();
    const malformedExpectation = expect(malformed).rejects.toMatchObject({
      code: "react_protocol_error",
    });
    coordinator.handle({
      id: 999,
      responseID: malformedRequestId,
      type: "full-data",
      value: {},
    });
    await malformedExpectation;

    let hydrationRequestId = 0;
    const wrongPath = coordinator.request(
      {
        rendererId: 1,
        componentId: 2,
        path: ["props", "settings"],
        forceFullData: false,
        timeoutMs: 100,
      },
      async (requestId) => {
        hydrationRequestId = requestId;
      },
    );
    await Promise.resolve();
    const wrongPathExpectation = expect(wrongPath).rejects.toMatchObject({
      code: "react_protocol_error",
    });
    coordinator.handle({
      id: 2,
      responseID: hydrationRequestId,
      type: "hydrated-path",
      path: ["props", "other"],
      value: { data: {}, cleaned: [], unserializable: [] },
    });
    await wrongPathExpectation;

    const pending = coordinator.request(
      {
        rendererId: 1,
        componentId: 3,
        path: null,
        forceFullData: true,
        timeoutMs: 100,
      },
      async () => {},
    );
    const pendingExpectation = expect(pending).rejects.toMatchObject({
      code: "react_inspection_cancelled",
      message: "document changed",
    });
    coordinator.reset("document changed");
    await pendingExpectation;
  });

  it("times out an unanswered request with a structured error", async () => {
    vi.useFakeTimers();
    const coordinator = new ReactInspectionCoordinator();
    const pending = coordinator.request(
      {
        rendererId: 1,
        componentId: 2,
        path: null,
        forceFullData: true,
        timeoutMs: 100,
      },
      async () => {},
    );
    const pendingExpectation = expect(pending).rejects.toMatchObject({
      code: "react_inspection_timeout",
    });
    await vi.advanceTimersByTimeAsync(100);
    await pendingExpectation;
  });
});
