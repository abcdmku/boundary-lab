"""Analytic quadrant section outlines and loft helpers for the slot_cd_horn generator.

Pure numpy (no gmsh/meshio/blab imports) so every outline family is separately
unit-testable.

Conventions (mm):
- The horn fires along +z with the throat plane at z=0; x is the slot narrow
  axis, y the slot long axis.
- All outlines are +x/+y quadrant polylines with a fixed point count, ordered
  from the +x axis (first point has y == 0.0 exactly) to the +y axis (last
  point has x == 0.0 exactly). Lofted quadrant meshes therefore mirror across
  x and y with the seam nodes fusing bitwise-exactly, which is what the blab
  mesh cleaner's exact-tolerance vertex merge (MERGE_TOL = 1e-9 mm) relies on.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np


def resample_polyline(points: np.ndarray, count: int) -> np.ndarray:
    """Resample a 2D polyline to `count` arclength-uniform points, keeping the endpoints exact."""
    pts = np.asarray(points, dtype=float)
    if pts.ndim != 2 or pts.shape[0] < 2 or pts.shape[1] != 2:
        raise ValueError("resample_polyline expects an (m>=2, 2) polyline")
    if count < 2:
        raise ValueError("count must be >= 2")
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate(([0.0], np.cumsum(seg)))
    total = s[-1]
    if total <= 0.0:
        return np.repeat(pts[:1], count, axis=0)
    si = np.linspace(0.0, total, count)
    out = np.column_stack((np.interp(si, s, pts[:, 0]), np.interp(si, s, pts[:, 1])))
    out[0] = pts[0]
    out[-1] = pts[-1]
    return out


def clipped_circle_quadrant(radius: float, clip_x: float, count: int) -> np.ndarray:
    """Quadrant outline of a circle of `radius` clipped to x <= clip_x, arclength-uniform.

    clip_x >= radius: plain quarter arc from (radius, 0) to (0, radius).
    0 < clip_x < radius: vertical chord at x = clip_x from (clip_x, 0) up to the
    circle, then the arc to (0, radius).
    clip_x <= 0: degenerate ridge segment on the x=0 plane from (0, 0) to (0, radius).
    """
    if radius <= 0.0:
        raise ValueError("radius must be positive")
    if count < 2:
        raise ValueError("count must be >= 2")
    w = min(float(clip_x), float(radius))
    if w <= 0.0:
        out = np.column_stack((np.zeros(count), np.linspace(0.0, radius, count)))
    elif w >= radius:
        ang = np.linspace(0.0, np.pi / 2.0, count)
        out = np.column_stack((radius * np.cos(ang), radius * np.sin(ang)))
        out[0] = (radius, 0.0)
    else:
        y_c = float(np.sqrt(radius * radius - w * w))
        phi_c = float(np.arctan2(y_c, w))
        arc_len = radius * (np.pi / 2.0 - phi_c)
        total = y_c + arc_len
        s = np.linspace(0.0, total, count)
        on_chord = s <= y_c
        phi = phi_c + np.where(on_chord, 0.0, s - y_c) / radius
        x = np.where(on_chord, w, radius * np.cos(phi))
        y = np.where(on_chord, s, radius * np.sin(phi))
        out = np.column_stack((x, y))
        out[0] = (w, 0.0)
    out[0, 1] = 0.0
    out[-1] = (0.0, radius)
    return out


def superellipse_quadrant(
    half_width: float,
    half_height: float,
    exponent: float,
    count: int,
    oversample: int = 32,
) -> np.ndarray:
    """Arclength-uniform quadrant of |x/a|^n + |y/b|^n = 1 from (a, 0) to (0, b)."""
    if half_width <= 0.0 or half_height <= 0.0:
        raise ValueError("half_width and half_height must be positive")
    if exponent < 1.0:
        raise ValueError("exponent must be >= 1")
    dense_n = max(count * oversample, 256)
    theta = np.linspace(0.0, np.pi / 2.0, dense_n)
    e = 2.0 / float(exponent)
    dense = np.column_stack((half_width * np.cos(theta) ** e, half_height * np.sin(theta) ** e))
    dense[0] = (half_width, 0.0)
    dense[-1] = (0.0, half_height)
    out = resample_polyline(dense, count)
    out[0] = (half_width, 0.0)
    out[-1] = (0.0, half_height)
    return out


def outline_normals(outline: np.ndarray) -> np.ndarray:
    """Outward in-plane unit normals of a quadrant outline.

    The endpoints are pinned to (1, 0) and (0, 1): by mirror symmetry the true
    outline normal on a symmetry plane lies exactly in that plane, and pinning
    keeps offset/roundover stations bitwise on x=0 / y=0.
    """
    pts = np.asarray(outline, dtype=float)
    tangent = np.gradient(pts, axis=0)
    normals = np.column_stack((tangent[:, 1], -tangent[:, 0]))
    norms = np.linalg.norm(normals, axis=1)
    norms[norms == 0.0] = 1.0
    normals /= norms[:, None]
    normals[0] = (1.0, 0.0)
    normals[-1] = (0.0, 1.0)
    return normals


def offset_outline(outline: np.ndarray, distance: float) -> np.ndarray:
    """Offset a convex quadrant outline outward (in-plane) by `distance`."""
    return np.asarray(outline, dtype=float) + float(distance) * outline_normals(outline)


def blend_outlines(start: np.ndarray, end: np.ndarray, fraction: float) -> np.ndarray:
    """Pointwise linear blend between two same-length outlines (0 -> start, 1 -> end)."""
    f = float(fraction)
    return (1.0 - f) * np.asarray(start, dtype=float) + f * np.asarray(end, dtype=float)


def pinch_scale(u: float, pinch: float, pinch_pos: float) -> float:
    """Waist scale factor for the flare at normalized depth u in [0, 1].

    Returns exactly 1.0 at u <= 0 and u >= 1 (so the slot and mouth outlines are
    bitwise-preserved) and 1 - pinch at u == pinch_pos, with a smooth bump between.
    """
    if pinch <= 0.0 or u <= 0.0 or u >= 1.0:
        return 1.0
    p = float(pinch_pos)
    if u <= p:
        m = 0.5 * u / p
    else:
        m = 0.5 + 0.5 * (u - p) / (1.0 - p)
    return 1.0 - float(pinch) * float(np.sin(np.pi * m)) ** 2


def cosine_stations(start: float, end: float, segments: int) -> np.ndarray:
    """`segments`+1 stations from start to end, cosine-clustered at both ends, exact endpoints."""
    if segments < 1:
        raise ValueError("segments must be >= 1")
    t = 0.5 * (1.0 - np.cos(np.linspace(0.0, np.pi, segments + 1)))
    z = start + (end - start) * t
    z[0] = start
    z[-1] = end
    return z


def as_station(outline: np.ndarray, z: float) -> np.ndarray:
    """Lift a 2D outline into 3D at height z."""
    pts = np.asarray(outline, dtype=float)
    return np.column_stack((pts, np.full(len(pts), float(z))))


def loft_chain(stations: Sequence[np.ndarray], flip: bool = False) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Triangulate a chain of equal-length 3D outlines into quad strips.

    Each consecutive station pair becomes a strip of quads split into two
    triangles. Triangles with two bitwise-identical corner coordinates (from
    collapsed stations or repeated points) are dropped, so a fully collapsed
    station yields a clean triangle fan.

    Winding: with flip=False the triangle normals follow d_outline x d_station
    (right-hand rule); flip=True reverses them.

    Returns (points (V, 3), triangles (T, 3) int indices, strip_index (T,)).
    """
    if len(stations) < 2:
        raise ValueError("loft_chain needs at least two stations")
    n = stations[0].shape[0]
    for st in stations:
        if st.shape != (n, 3):
            raise ValueError("all stations must be (n, 3) arrays of equal length")
    points = np.vstack(stations)
    n_st = len(stations)
    grid = np.arange(n_st * n).reshape(n_st, n)
    a = grid[:-1, :-1].ravel()
    b = grid[:-1, 1:].ravel()
    c = grid[1:, 1:].ravel()
    d = grid[1:, :-1].ravel()
    tri1 = np.column_stack((a, b, c))
    tri2 = np.column_stack((a, c, d))
    strip = np.repeat(np.arange(n_st - 1), n - 1)
    triangles = np.vstack((tri1, tri2))
    strips = np.concatenate((strip, strip))
    if flip:
        triangles = triangles[:, [0, 2, 1]]
    corners = points[triangles]
    degenerate = (
        np.all(corners[:, 0] == corners[:, 1], axis=1)
        | np.all(corners[:, 1] == corners[:, 2], axis=1)
        | np.all(corners[:, 0] == corners[:, 2], axis=1)
    )
    keep = ~degenerate
    return points, triangles[keep], strips[keep]


def mirror_quadrant(points: np.ndarray, triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Mirror a +x/+y quadrant mesh across x=0 then y=0 and fuse exact-duplicate vertices.

    Numpy-only reference implementation of the production path (blab
    clean_mesh_file with mirror_axes=("x", "y")) used by the unit tests for
    watertightness checks. Winding is flipped on mirrored copies to keep
    normals consistent.
    """
    pts = np.asarray(points, dtype=float) + 0.0  # normalize -0.0 -> +0.0
    tris = np.asarray(triangles, dtype=np.int64)
    for axis in (0, 1):
        mirrored = pts.copy()
        mirrored[:, axis] *= -1.0
        mirrored += 0.0
        tris = np.vstack((tris, tris[:, [0, 2, 1]] + len(pts)))
        pts = np.vstack((pts, mirrored))
    unique, inverse = np.unique(pts, axis=0, return_inverse=True)
    return unique, inverse[tris]
