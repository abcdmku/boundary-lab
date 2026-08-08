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


def clipped_circle_quadrant_patches(
    radius: float,
    clip_x: float,
    segments: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Feature-preserving chord and arc patches of a clipped circle quadrant.

    The returned polylines share the analytic chord/circle intersection exactly.
    Their segment allocation follows each patch's arclength and always totals
    ``segments``.  At either limiting shape the absent patch is one point: an
    unclipped circle has a collapsed chord at ``(radius, 0)``, while a ridge has
    a collapsed arc at ``(0, radius)``.

    Keeping the patches separate lets :func:`loft_chain` change their point
    counts between axial stations without letting the sharp intersection jump
    from one mesh rail to another.
    """
    if radius <= 0.0:
        raise ValueError("radius must be positive")
    if segments < 2:
        raise ValueError("segments must be >= 2")
    w = min(float(clip_x), float(radius))
    endpoint_tol = 1e-10 * max(1.0, float(radius))
    if w <= endpoint_tol:
        chord = np.column_stack((np.zeros(segments + 1), np.linspace(0.0, radius, segments + 1)))
        arc = np.array([[0.0, radius]])
    elif w >= radius - endpoint_tol:
        chord = np.array([[radius, 0.0]])
        ang = np.linspace(0.0, np.pi / 2.0, segments + 1)
        arc = np.column_stack((radius * np.cos(ang), radius * np.sin(ang)))
        arc[0] = (radius, 0.0)
        arc[-1] = (0.0, radius)
    else:
        y_c = float(np.sqrt(radius * radius - w * w))
        phi_c = float(np.arctan2(y_c, w))
        chord_len = y_c
        arc_len = radius * (np.pi / 2.0 - phi_c)
        chord_segments = int(np.floor(segments * chord_len / (chord_len + arc_len) + 0.5))
        chord_segments = min(max(chord_segments, 1), segments - 1)
        arc_segments = segments - chord_segments
        chord = np.column_stack(
            (np.full(chord_segments + 1, w), np.linspace(0.0, y_c, chord_segments + 1))
        )
        ang = np.linspace(phi_c, np.pi / 2.0, arc_segments + 1)
        arc = np.column_stack((radius * np.cos(ang), radius * np.sin(ang)))
        corner = np.array([w, y_c])
        chord[0] = (w, 0.0)
        chord[-1] = corner
        arc[0] = corner
        arc[-1] = (0.0, radius)
    return chord, arc


def clipped_circle_quadrant(radius: float, clip_x: float, count: int) -> np.ndarray:
    """Feature-preserving quadrant outline of a circle clipped to ``x <= clip_x``.

    The points remain close to arclength-uniform, but unlike a generic polyline
    resample the sharp chord/circle intersection is always an actual vertex.
    """
    if count < 3:
        raise ValueError("count must be >= 3")
    chord, arc = clipped_circle_quadrant_patches(radius, clip_x, count - 1)
    return np.vstack((chord[:-1], arc))


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
    """Triangulate a chain of ordered 3D polylines into strips.

    Equal-length station pairs retain the original structured quad split.  If
    point counts differ, an arclength zipper advances along whichever polyline
    has the next boundary point; this supports a feature patch growing from or
    collapsing to one point without a jagged, index-changing feature rail.

    Triangles with two bitwise-identical corners are dropped, so legacy repeated
    collapsed stations still yield a clean triangle fan.

    Winding: with flip=False the triangle normals follow d_outline x d_station
    (right-hand rule); flip=True reverses them.

    Returns (points (V, 3), triangles (T, 3) int indices, strip_index (T,)).
    """
    if len(stations) < 2:
        raise ValueError("loft_chain needs at least two stations")
    normalized: list[np.ndarray] = []
    for st in stations:
        if st.ndim != 2 or st.shape[1] != 3 or st.shape[0] < 1:
            raise ValueError("all stations must be non-empty (n, 3) arrays")
        if len(st) == 1:
            normalized.append(np.array([0.0]))
            continue
        lengths = np.linalg.norm(np.diff(st, axis=0), axis=1)
        cumulative = np.concatenate(([0.0], np.cumsum(lengths)))
        if cumulative[-1] <= 0.0:
            normalized.append(np.linspace(0.0, 1.0, len(st)))
        else:
            normalized.append(cumulative / cumulative[-1])

    points = np.vstack(stations)
    station_lengths = {len(st) for st in stations}
    if len(station_lengths) == 1:
        n = len(stations[0])
        grid = np.arange(len(stations) * n).reshape(len(stations), n)
        a = grid[:-1, :-1].ravel()
        b = grid[:-1, 1:].ravel()
        c = grid[1:, 1:].ravel()
        d = grid[1:, :-1].ravel()
        triangles = np.vstack((np.column_stack((a, b, c)), np.column_stack((a, c, d))))
        strip = np.repeat(np.arange(len(stations) - 1), n - 1)
        strips = np.concatenate((strip, strip))
    else:
        offsets = np.cumsum([0, *(len(st) for st in stations[:-1])])
        triangles_list: list[tuple[int, int, int]] = []
        strips_list: list[int] = []

        for strip_index, (lower, upper) in enumerate(zip(stations[:-1], stations[1:])):
            lower_s = normalized[strip_index]
            upper_s = normalized[strip_index + 1]
            lower_offset = int(offsets[strip_index])
            upper_offset = int(offsets[strip_index + 1])
            i = j = 0
            while i < len(lower) - 1 or j < len(upper) - 1:
                next_lower = lower_s[i + 1] if i < len(lower) - 1 else np.inf
                next_upper = upper_s[j + 1] if j < len(upper) - 1 else np.inf
                if abs(next_lower - next_upper) <= 1e-12:
                    triangles_list.append(
                        (lower_offset + i, lower_offset + i + 1, upper_offset + j + 1)
                    )
                    triangles_list.append(
                        (lower_offset + i, upper_offset + j + 1, upper_offset + j)
                    )
                    strips_list.extend((strip_index, strip_index))
                    i += 1
                    j += 1
                elif next_lower < next_upper:
                    triangles_list.append((lower_offset + i, lower_offset + i + 1, upper_offset + j))
                    strips_list.append(strip_index)
                    i += 1
                else:
                    triangles_list.append((lower_offset + i, upper_offset + j + 1, upper_offset + j))
                    strips_list.append(strip_index)
                    j += 1

        triangles = np.asarray(triangles_list, dtype=np.int64).reshape(-1, 3)
        strips = np.asarray(strips_list, dtype=np.int64)
    if flip:
        triangles = triangles[:, [0, 2, 1]]
    if not len(triangles):
        return points, triangles, strips
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
