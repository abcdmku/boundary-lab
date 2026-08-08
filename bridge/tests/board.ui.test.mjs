import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildBoard, buildDesigns } from "../ui/src/lib/board.js";

describe("dashboard state projections", () => {
  test("mesh work does not consume or fill a GPU solve slot", () => {
    const mesh = {
      id: "mesh",
      kind: "mesh",
      name: "mesh",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      target: { type: "local" },
    };
    const solve = {
      id: "solve",
      kind: "solve",
      name: "solve",
      status: "running",
      createdAt: "2026-01-01T00:00:01.000Z",
      parentJobId: mesh.id,
      params: { meshJobId: mesh.id },
      target: { type: "local" },
    };
    const board = buildBoard({
      jobs: [mesh, solve],
      targets: [{ id: "local", type: "local", label: "Local GPU", concurrency: 2, available: true }],
      queue: {
        lanes: [
          { key: "local:mesh", kind: "mesh", targetId: "local", active: [mesh.id], queued: [] },
          { key: "local:solve", kind: "solve", targetId: "local", active: [solve.id], queued: [] },
        ],
      },
    });

    assert.equal(board.columns[0].running.length, 2);
    assert.equal(board.columns[0].slotsUsed, 1);
    assert.equal(board.totals.running, 2);
    assert.equal(board.totals.solvesRunning, 1);
    assert.equal(board.totals.meshesRunning, 1);
  });

  test("archived projects and their jobs remain in the dashboard ledger", () => {
    const designs = buildDesigns({
      projects: [
        {
          id: "p_archived",
          name: "Archived horn",
          archived: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      jobs: [
        {
          id: "mesh",
          kind: "mesh",
          name: "mesh",
          status: "done",
          createdAt: "2026-01-01T00:00:00.000Z",
          projectId: "p_archived",
          params: {},
        },
      ],
    });

    assert.equal(designs.projects.length, 0);
    assert.equal(designs.archived.length, 1);
    assert.equal(designs.archived[0].meshes[0].mesh.id, "mesh");
  });
});
