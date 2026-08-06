"""Matplotlib 3D preview rendering for triangle surface meshes."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import meshio  # noqa: E402
import numpy as np  # noqa: E402
from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: E402

WALL_COLOR = "#b8c4cf"
DRIVEN_COLOR = "#e8590c"
EDGE_COLOR = "#5f6b76"


def render_mesh_preview(
    msh_path: Path,
    out_png: Path,
    *,
    driven_tags: tuple[int, ...] = (),
    width_px: int = 900,
) -> Path:
    mesh = meshio.read(msh_path)
    cells = mesh.cells_dict
    triangles = np.asarray(cells.get("triangle", cells.get("triangle3")))
    if triangles is None or len(triangles) == 0:
        raise ValueError(f"No triangles in {msh_path}")
    points = np.asarray(mesh.points, dtype=float)

    tags = None
    tri_key = "triangle" if "triangle" in cells else "triangle3"
    for key, block in mesh.cell_data_dict.items():
        if "gmsh:physical" in key and tri_key in block:
            tags = np.asarray(block[tri_key])
            break

    driven_mask = np.zeros(len(triangles), dtype=bool)
    if tags is not None and driven_tags:
        driven_mask = np.isin(tags, np.asarray(driven_tags))

    dpi = 100
    fig = plt.figure(figsize=(width_px / dpi, width_px * 0.85 / dpi), dpi=dpi)
    ax = fig.add_subplot(111, projection="3d")
    ax.computed_zorder = False  # honor explicit zorder so driven surfaces stay visible
    ax.set_facecolor("white")
    fig.patch.set_facecolor("white")

    walls = Poly3DCollection(
        points[triangles[~driven_mask]],
        facecolors=WALL_COLOR,
        edgecolors=EDGE_COLOR,
        linewidths=0.15,
        zorder=1,
    )
    ax.add_collection3d(walls)
    if driven_mask.any():
        # Separate collection with a higher zorder: mplot3d's average-depth sort buries
        # small interior driven surfaces (e.g. a throat disc) under large wall triangles.
        driven = Poly3DCollection(
            points[triangles[driven_mask]],
            facecolors=DRIVEN_COLOR,
            edgecolors=EDGE_COLOR,
            linewidths=0.15,
            zorder=2,
        )
        ax.add_collection3d(driven)

    mins, maxs = points.min(axis=0), points.max(axis=0)
    spans = maxs - mins
    ax.set_xlim(mins[0], maxs[0])
    ax.set_ylim(mins[1], maxs[1])
    ax.set_zlim(mins[2], maxs[2])
    ax.set_box_aspect(tuple(np.maximum(spans, 1e-6)))
    ax.view_init(elev=38, azim=-58)
    ax.set_axis_off()

    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, bbox_inches="tight", pad_inches=0.05, facecolor="white")
    plt.close(fig)
    return out_png
